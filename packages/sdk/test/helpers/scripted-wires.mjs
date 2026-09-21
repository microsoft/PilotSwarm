import { createServer } from "node:http";

/**
 * Scripted endpoints for the provider wire shapes CLI 1.0.85 actually speaks.
 *
 * The reset boundary is driven entirely through the runtime's own RPC and never
 * synthesizes provider traffic, so it should be wire-independent. "Should" is
 * not evidence, so each shape gets a real endpoint and the same assertions.
 *
 * Each wire exposes:
 *   - `type`      the PilotSwarm provider type to configure
 *   - `basePath`  suffix appended to the loopback origin
 *   - `messages`  normalized [{role, content}] read out of a captured body
 *   - `tools`     tool names offered in a captured body
 *   - `reply`     serialize a scripted answer onto the response
 */

/** OpenAI chat-completions, and Azure, which is the same body on another path. */
function completionsWire(type) {
    return {
        type,
        basePath: "/v1",
        streams: false,
        messages: body => (body.messages ?? []).map(message => ({
            role: message.role,
            content: typeof message.content === "string" ? message.content
                : (message.content ?? []).map(part => part.text ?? "").join(""),
            toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
        })),
        tools: body => (body.tools ?? []).map(entry => entry.function?.name ?? entry.name),
        reply(res, body, answer, index) {
            const id = `wire-${index}`;
            const calls = answer.tool
                ? [{ id: `${id}-0`, type: "function",
                    function: { name: answer.tool, arguments: JSON.stringify(answer.args ?? {}) } }]
                : undefined;
            const message = { role: "assistant", content: answer.content ?? null, ...(calls ? { tool_calls: calls } : {}) };
            const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
            const payload = { id, object: "chat.completion", model: body.model, usage,
                choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }] };
            if (!body.stream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(payload));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            const delta = calls ? { ...message, tool_calls: calls.map((call, i) => ({ index: i, ...call })) } : message;
            for (const [part, finish] of [[delta, null], [{}, calls ? "tool_calls" : "stop"]]) {
                res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model,
                    choices: [{ index: 0, delta: part, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`);
            }
            res.end("data: [DONE]\n\n");
        },
    };
}

/** Anthropic messages: a different body shape, which CLI 1.0.85 streams as SSE. */
const anthropicWire = {
    type: "anthropic",
    basePath: "",
    streams: true,
    messages: body => {
        const rows = [];
        // Anthropic carries the system instruction beside the transcript.
        if (body.system) {
            rows.push({ role: "system", toolCalls: 0,
                content: typeof body.system === "string" ? body.system
                    : (body.system ?? []).map(part => part.text ?? "").join("") });
        }
        for (const message of body.messages ?? []) {
            const parts = typeof message.content === "string"
                ? [{ type: "text", text: message.content }] : (message.content ?? []);
            rows.push({
                role: message.role,
                content: parts.map(part => part.text ?? part.content ?? "").filter(text => typeof text === "string").join(""),
                toolCalls: parts.filter(part => part.type === "tool_use").length,
            });
        }
        return rows;
    },
    tools: body => (body.tools ?? []).map(entry => entry.name),
    reply(res, body, answer, index) {
        const id = `msg-wire-${index}`;
        const block = answer.tool
            ? { type: "tool_use", id: `${id}-0`, name: answer.tool, input: answer.args ?? {} }
            : { type: "text", text: answer.content ?? "" };
        const stop = answer.tool ? "tool_use" : "end_turn";
        const usage = { input_tokens: 20, output_tokens: 5 };
        if (!body.stream) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model,
                content: [block], stop_reason: stop, usage }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("message_start", { message: { id, type: "message", role: "assistant", model: body.model,
            content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
        send("content_block_start", { index: 0, content_block: answer.tool
            ? { type: "tool_use", id: block.id, name: block.name, input: {} } : { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: answer.tool
            ? { type: "input_json_delta", partial_json: JSON.stringify(answer.args ?? {}) } : { type: "text_delta", text: block.text } });
        send("content_block_stop", { index: 0 });
        send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
        send("message_stop", {});
        res.end();
    },
};

export const WIRES = {
    openai: completionsWire("openai"),
    azure: completionsWire("azure"),
    anthropic: anthropicWire,
};

/** Stand up one scripted endpoint speaking `wire`, answering through `respond`. */
export async function createScriptedWire(wire, respond) {
    const requests = [], paths = [];
    const server = createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            requests.push(body);
            paths.push(req.url);
            const answer = await respond(wire.messages(body), wire.tools(body), body);
            if (res.destroyed) return;
            // A scripted transport failure (429, 401, 5xx) is not an answer the
            // wire can serialize: it is returned verbatim so the runtime sees a
            // real provider error with real headers.
            if (answer?.status) {
                res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
                res.end(JSON.stringify(answer.body ?? { error: { message: "scripted provider failure" } }));
                return;
            }
            wire.reply(res, body, answer, requests.length);
        } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(String(error)); } }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
        baseUrl: `${origin}${wire.basePath}`, requests, paths,
        streamed: () => requests.filter(body => body.stream === true).length,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    };
}
