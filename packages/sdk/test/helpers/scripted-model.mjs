/**
 * Scripted model endpoint: a local OpenAI chat-completions server whose
 * answers come from the test, not from a model. Full-stack tests point a
 * real worker and the real Copilot CLI at it, so every turn is deterministic,
 * costs no tokens, and every request the CLI sends is captured.
 *
 * Answers are derived from the request alone (which conversation, which turn,
 * which step inside the turn), never from server-side counters. A request the
 * runtime retries, or a turn replayed on another worker, gets the same answer.
 */
import { createServer } from "node:http";

/** Text of an OpenAI message content field (string or content parts). */
export function messageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
    }
    return "";
}

/** The system message text of a chat-completions request. */
export function systemText(body) {
    return (body?.messages ?? []).filter((m) => m?.role === "system").map(messageText).join("\n");
}

/**
 * Where a request sits in its conversation.
 * - turn: how many user messages the conversation has so far (1-based)
 * - step: how many assistant messages follow the last user message (0-based)
 * - lastUserText: the prompt that opened the current turn
 * - toolResults: tool messages since the last assistant message
 */
export function requestPosition(body) {
    const messages = body?.messages ?? [];
    let turn = 0;
    let lastUserIndex = -1;
    messages.forEach((m, i) => {
        if (m?.role === "user") {
            turn += 1;
            lastUserIndex = i;
        }
    });
    const afterUser = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : [];
    const step = afterUser.filter((m) => m?.role === "assistant").length;
    const lastAssistant = afterUser.map((m) => m?.role).lastIndexOf("assistant");
    const toolResults = afterUser.slice(lastAssistant + 1).filter((m) => m?.role === "tool").map(messageText);
    const firstUser = messages.find((m) => m?.role === "user");
    return {
        turn,
        step,
        lastUserText: lastUserIndex >= 0 ? messageText(messages[lastUserIndex]) : "",
        firstUserText: firstUser ? messageText(firstUser) : "",
        toolResults,
    };
}

/** True for requests from a session turn (they declare tools); false for auxiliary calls such as titles. */
export function isSessionRequest(body) {
    return Array.isArray(body?.tools) && body.tools.length > 0;
}

/**
 * Build a responder from a per-turn script.
 *
 *   scriptTurns([
 *     [{ tools: [{ name: "bash", args: { command: "pwd" } }] }, { content: "done" }],  // turn 1
 *     [{ content: "second turn answer" }],                                           // turn 2
 *   ])
 *
 * A step is { tools: [{ name, args }] } or { content } or a function
 * (body, position) => step. Turns or steps past the end of the script answer
 * with `fallback` (default "ok"), which ends the turn. A step
 * { httpStatus, message } answers with that HTTP error instead.
 */
export function scriptTurns(turns, { fallback = "ok" } = {}) {
    return (body, position) => {
        const steps = turns[position.turn - 1];
        const step = steps?.[position.step];
        if (!step) return { content: fallback };
        return typeof step === "function" ? step(body, position) : step;
    };
}

function completionPayload(body, answer, id) {
    const calls = answer.tools?.map((t, i) => ({
        id: `${id}-${i}`,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
    }));
    const message = { role: "assistant", content: answer.content ?? null, ...(calls?.length ? { tool_calls: calls } : {}) };
    return { message, finishReason: calls?.length ? "tool_calls" : "stop" };
}

function writeAnswer(res, body, answer, id) {
    const { message, finishReason } = completionPayload(body, answer, id);
    const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
    if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = message.tool_calls
            ? { ...message, tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
            : message;
        for (const [part, finish] of [[delta, null], [{}, finishReason]]) {
            res.write(`data: ${JSON.stringify({
                id, object: "chat.completion.chunk", model: body.model,
                choices: [{ index: 0, delta: part, finish_reason: finish }],
                ...(finish ? { usage } : {}),
            })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        id, object: "chat.completion", model: body.model,
        choices: [{ index: 0, message, finish_reason: finishReason }], usage,
    }));
}

/**
 * Start the endpoint.
 *
 * @param {object} [opts]
 * @param {(body, position, record) => (object|Promise<object>)} [opts.respond]
 *   Answers session requests. Default: every turn answers "ok".
 * @param {(body) => object} [opts.respondAuxiliary]
 *   Answers requests without tools (titles, summaries). Default: "Fixture title".
 * @returns {Promise<{ baseUrl, requests, sessionRequests, setResponder, close }>}
 */
export async function startScriptedModel(opts = {}) {
    let respond = opts.respond ?? (() => ({ content: "ok" }));
    const respondAuxiliary = opts.respondAuxiliary ?? (() => ({ content: "Fixture title" }));
    const requests = [];

    const server = createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString();
            if (req.method !== "POST" || !raw) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `fixture endpoint: ${req.method} ${req.url} not handled` } }));
                return;
            }
            const body = JSON.parse(raw);
            const index = requests.length + 1;
            const session = isSessionRequest(body);
            const position = requestPosition(body);
            const record = { index, path: req.url, session, position, body, connectionClosed: false };
            res.once("close", () => { record.connectionClosed = true; });
            requests.push(record);
            const answer = session
                ? await respond(body, position, record)
                : await respondAuxiliary(body, record);
            record.answer = answer;
            if (res.destroyed) return;
            if (answer?.httpStatus) {
                res.writeHead(answer.httpStatus, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: answer.message ?? "scripted error", type: "invalid_request_error" } }));
                return;
            }
            writeAnswer(res, body, answer ?? { content: "ok" }, `fixture-${index}`);
        } catch (error) {
            if (!res.destroyed) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: String(error?.stack ?? error) } }));
            }
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        /** Requests that came from session turns, optionally for one conversation (matched on its first prompt). */
        sessionRequests(firstUserText) {
            return requests.filter((r) => r.session && (firstUserText === undefined || r.position.firstUserText.includes(firstUserText)));
        },
        setResponder(fn) {
            respond = fn;
        },
        async close() {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
