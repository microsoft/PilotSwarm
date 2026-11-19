import { CopilotClient, CopilotRequestHandler, RuntimeConnection } from "@github/copilot-sdk";
import type { CopilotClientOptions, CopilotRequestContext } from "@github/copilot-sdk";
import { createParser } from "eventsource-parser";
import { normalizeToolCatalog, type ToolCatalogCapability } from "./model-providers.js";

type JsonObject = Record<string, any>;
type ToolGroup = { body: JsonObject; name: string; toolNames: Set<string> };
export type ToolCatalogPolicyResolver = (request: Request, context: CopilotRequestContext, model: string) => ToolCatalogCapability | undefined;
const SCHEMA_DOCUMENT_KEYS = new Set(["$ref", "$id", "$schema", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"]);

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSchemaDocumentScope(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasSchemaDocumentScope);
    if (!isObject(value)) return false;
    return Object.entries(value).some(([key, child]) => SCHEMA_DOCUMENT_KEYS.has(key) || hasSchemaDocumentScope(child));
}

function groupOverflowTools(body: JsonObject, policy?: ToolCatalogCapability): ToolGroup | undefined {
    if (!policy || typeof body.model !== "string" || !body.model
        || !Array.isArray(body.tools) || body.tools.length <= policy.maxDeclarations) return;
    const maxDeclarations = policy.maxDeclarations;
    const choice = body.tool_choice;
    const forcedName = isObject(choice) && choice.type === "function" && isObject(choice.function)
        && typeof choice.function.name === "string" && Object.keys(choice.function).length === 1
        && Object.keys(choice).every(key => key === "type" || key === "function") ? choice.function.name : undefined;
    if (choice != null && !["auto", "none", "required"].includes(choice) && forcedName === undefined) {
        throw new Error(`The ${maxDeclarations}-tool limit cannot be adapted with a restricted or unsupported tool choice. Select a compatible model or reduce the configured tool catalog.`);
    }
    const candidates = body.tools.filter((tool: unknown) => isObject(tool)
        && tool.type === "function" && isObject(tool.function)
        && typeof tool.function.name === "string" && tool.function.name !== forcedName
        && (tool.function.strict === undefined || tool.function.strict === false)
        && isObject(tool.function.parameters) && tool.function.parameters.type === "object"
        && !hasSchemaDocumentScope(tool.function.parameters)
        && Object.keys(tool).every(key => key === "type" || key === "function")
        && Object.keys(tool.function).every(key => ["name", "description", "parameters", "strict"].includes(key)));
    const required = body.tools.length - maxDeclarations + 1;
    if (candidates.length < required) {
        throw new Error(`The ${maxDeclarations}-tool limit cannot be met without changing strict or unsupported tool schemas. Select a compatible model or reduce the configured tool catalog.`);
    }
    const grouped = candidates.slice(-required);
    const groupedSet = new Set(grouped);
    const toolNames = new Set<string>(grouped.map((tool: JsonObject) => tool.function.name));
    const existingNames = new Set(body.tools.map((tool: JsonObject) => tool?.function?.name ?? tool?.custom?.name));
    let name = "pilotswarm_tool_dispatch";
    let suffix = 0;
    while (existingNames.has(name)) name = `pilotswarm_tool_dispatch_${++suffix}`;
    const dispatcher = {
        type: "function",
        function: {
            name,
            description: "Invoke one of the tools described by this schema. Provide a call object with its tool_name and original arguments. Each alternative describes one available tool.",
            parameters: {
                type: "object",
                properties: {
                    // Completions requires an object root; keep the paired selection union nested.
                    call: {
                        anyOf: grouped.map((tool: JsonObject) => ({
                            type: "object",
                            ...(typeof tool.function.description === "string" ? { description: tool.function.description } : {}),
                            properties: {
                                tool_name: { type: "string", enum: [tool.function.name] },
                                arguments: tool.function.parameters,
                            },
                            required: ["tool_name", "arguments"],
                            additionalProperties: false,
                        })),
                    },
                },
                required: ["call"],
                additionalProperties: false,
            },
        },
    };
    const messages = Array.isArray(body.messages) ? body.messages.map((message: JsonObject) => {
        if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
        return { ...message, tool_calls: message.tool_calls.map((call: JsonObject) => {
            if (!toolNames.has(call.function?.name) || typeof call.function.arguments !== "string") return call;
            let args;
            try { args = JSON.parse(call.function.arguments); } catch { return call; }
            if (!isObject(args)) return call;
            return { ...call, function: { ...call.function, name, arguments: JSON.stringify({ call: { tool_name: call.function.name, arguments: args } }) } };
        }) };
    }) : body.messages;
    return { name, toolNames, body: { ...body, tools: [...body.tools.filter((tool: JsonObject) => !groupedSet.has(tool)), dispatcher], ...(messages ? { messages } : {}) } };
}

function restoreToolCall(call: JsonObject, group: ToolGroup): JsonObject {
    if (call.function?.name !== group.name) return call;
    let args;
    try { args = JSON.parse(call.function.arguments); } catch {
        throw new Error("Tool dispatcher returned invalid JSON; refusing this tool call.");
    }
    const invocation = isObject(args) ? args.call : undefined;
    if (!isObject(args) || Object.keys(args).some(key => key !== "call") || !isObject(invocation)
        || typeof invocation.tool_name !== "string" || !group.toolNames.has(invocation.tool_name)
        || !isObject(invocation.arguments) || Object.keys(invocation).some(key => key !== "tool_name" && key !== "arguments")) {
        throw new Error("Tool dispatcher returned an invalid tool or arguments; refusing this tool call.");
    }
    return { ...call, function: { ...call.function, name: invocation.tool_name, arguments: JSON.stringify(invocation.arguments) } };
}

async function restoreGroupedResponse(response: Response, group: ToolGroup): Promise<Response> {
    if (!response.ok || !response.body) return response;
    const contentType = response.headers.get("content-type") ?? "";
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (contentType.includes("application/json")) {
        const body = await response.json() as JsonObject;
        if (isObject(body) && Array.isArray(body.choices)) {
            body.choices = body.choices.map((choice: JsonObject) => Array.isArray(choice.message?.tool_calls)
                ? { ...choice, message: { ...choice.message, tool_calls: choice.message.tool_calls.map((call: JsonObject) => restoreToolCall(call, group)) } }
                : choice);
        }
        return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
    }
    if (!contentType.includes("text/event-stream")) return response;
    const pending = new Map<number, Map<number, JsonObject>>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let parser: ReturnType<typeof createParser>;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
            parser = createParser({ onEvent(event) {
                const emit = (data: string) => controller.enqueue(encoder.encode(
                    `${event.event ? `event: ${event.event}\n` : ""}${event.id !== undefined ? `id: ${event.id}\n` : ""}data: ${data}\n\n`,
                ));
                if (event.data === "[DONE]") {
                    if (pending.size) throw new Error("Provider ended the stream before completing its tool calls.");
                    emit(event.data);
                    return;
                }
                let chunk: JsonObject;
                try { chunk = JSON.parse(event.data); } catch { emit(event.data); return; }
                if (!isObject(chunk) || !Array.isArray(chunk.choices)) { emit(event.data); return; }
                const choices = chunk.choices.map((choice: JsonObject) => {
                    if (!isObject(choice)) return choice;
                    const delta = isObject(choice.delta) ? { ...choice.delta } : {};
                    if (Array.isArray(delta.tool_calls)) {
                        let calls = pending.get(choice.index);
                        if (!calls) { calls = new Map(); pending.set(choice.index, calls); }
                        for (const part of delta.tool_calls) {
                            if (!isObject(part) || !Number.isInteger(part.index) || part.index < 0) throw new Error("Provider returned an invalid streamed tool-call index.");
                            const previous = calls.get(part.index) ?? { index: part.index, function: { name: "", arguments: "" } };
                            calls.set(part.index, { ...previous, ...part, function: {
                                ...previous.function, ...part.function,
                                name: previous.function.name + (part.function?.name ?? ""),
                                arguments: previous.function.arguments + (part.function?.arguments ?? ""),
                            } });
                        }
                        delete delta.tool_calls;
                    }
                    if (choice.finish_reason != null && pending.has(choice.index)) {
                        const calls = [...pending.get(choice.index)!.values()]
                            .sort((left, right) => left.index - right.index)
                            .map(call => restoreToolCall(call, group));
                        const { usage, ...envelope } = chunk;
                        emit(JSON.stringify({ ...envelope, choices: [{ index: choice.index, delta: { tool_calls: calls }, finish_reason: null }] }));
                        pending.delete(choice.index);
                    }
                    return { ...choice, delta };
                });
                emit(JSON.stringify({ ...chunk, choices }));
            } });
        },
        transform(bytes) { parser.feed(decoder.decode(bytes, { stream: true })); },
        flush() {
            parser.feed(decoder.decode());
            parser.reset({ consume: true });
            if (pending.size) throw new Error("Provider closed the stream before completing its tool calls.");
        },
    });
    return new Response(response.body.pipeThrough(stream), { status: response.status, statusText: response.statusText, headers });
}

/** Only OpenAI-compatible BYOK clients need the CLI 1.0.83 workaround. */
export function needsByokRequestCompatibility(provider: unknown): boolean {
    if (!provider || typeof provider !== "object") return false;
    const { type, wireApi } = provider as { type?: string; wireApi?: string };
    return (!type || type === "openai" || type === "azure") && (!wireApi || wireApi === "completions");
}

/**
 * CLI 1.0.83 leaks CAPI's `snippy: { enabled: false }` into BYOK chat
 * completions for GPT-5.6 models. Azure rejects the request before inference.
 * Keep this shim at the model HTTP boundary, not in prompts or model aliases.
 *
 * Attach ONLY to a dedicated OpenAI/Azure BYOK client: requestHandler forwards
 * all model traffic through Node, including WebSockets. Never attach it to a
 * GitHub Copilot client (native transport/auth and CAPI parameters must remain
 * intact), or an Anthropic/WIF client. The one handler those clients may carry
 * is ClaudeKeepWarmHeartbeat below: only for a Claude model, only when
 * PILOTSWARM_CLAUDE_KEEPWARM is exactly 1, and in its own pool slot. Replaying
 * the session's latest Claude request as a max_tokens 0 ping needs the request
 * as sent, which only a request handler sees; every request and response
 * passes through unchanged. Remove once the provider compatibility
 * tests pass without it. An explicit toolCatalog capability may group catalogs
 * above its declared limit through a typed dispatch function; restore calls
 * before the runtime's permission/tool hooks. Deployment names never enable it.
 */
export class ByokRequestCompatibility extends CopilotRequestHandler {
    private readonly toolCatalog?: ToolCatalogCapability | ToolCatalogPolicyResolver;

    constructor(toolCatalog?: ToolCatalogCapability | ToolCatalogPolicyResolver) {
        super();
        this.toolCatalog = typeof toolCatalog === "function" ? toolCatalog : normalizeToolCatalog(toolCatalog);
    }

    protected override async sendRequest(
        request: Request,
        context: CopilotRequestContext,
    ): Promise<Response> {
        let group: ToolGroup | undefined;
        if (request.method === "POST" && /\/chat\/completions\/?$/.test(new URL(request.url).pathname)
            && request.headers.get("content-type")?.includes("application/json")) {
            // Invalid/non-object JSON remains the upstream's responsibility.
            const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
            if (isObject(body)) {
                const hasSnippy = Object.prototype.hasOwnProperty.call(body, "snippy");
                if (hasSnippy) delete body.snippy;
                const policy = typeof this.toolCatalog === "function"
                    ? (typeof body.model === "string" ? normalizeToolCatalog(this.toolCatalog(request, context, body.model)) : undefined)
                    : this.toolCatalog;
                group = groupOverflowTools(body, policy);
                if (hasSnippy || group) {
                    const headers = new Headers(request.headers);
                    headers.delete("content-length");
                    request = new Request(request, { headers, body: JSON.stringify(group?.body ?? body) });
                }
            }
        }
        const response = await super.sendRequest(request, context);
        return group ? restoreGroupedResponse(response, group) : response;
    }
}

/** Shared by durable sessions and the short-lived title/distillation clients. */
export function createCopilotClient(
    options: CopilotClientOptions,
    provider?: unknown,
    toolCatalog?: ToolCatalogCapability | ToolCatalogPolicyResolver,
    heartbeat?: ClaudeKeepWarmHeartbeat,
): CopilotClient {
    if (toolCatalog && !needsByokRequestCompatibility(provider)) {
        throw new Error("toolCatalog requires an OpenAI-compatible Chat Completions provider.");
    }
    return new CopilotClient({
        ...options,
        // Do not let ambient COPILOT_SDK_DEFAULT_CONNECTION opt a multi-tenant
        // worker into the experimental process-global in-process transport.
        // Stdio uses the pinned SDK runtime and honors COPILOT_CLI_PATH.
        connection: RuntimeConnection.forStdio(),
        ...(needsByokRequestCompatibility(provider)
            ? { requestHandler: new ByokRequestCompatibility(toolCatalog) }
            : heartbeat ? { requestHandler: heartbeat } : {}),
    });
}

// A separate pool slot keeps the shim off native GHCP/Anthropic clients.
// NUL cannot occur in a GitHub token; this namespace cannot collide with one.
export const BYOK_CLIENT_PREFIX = "byok-openai\0";

// Opt-in slot for the Claude keep-warm heartbeat: one client (and one handler) per pool key, so the handler's timers
// and captured requests belong to exactly the sessions that opted in. Same NUL namespace as the BYOK slot.
export const HEARTBEAT_CLIENT_PREFIX = "claude-keepwarm\0";

export const CLAUDE_KEEPWARM_ENV = "PILOTSWARM_CLAUDE_KEEPWARM";

/** The heartbeat is off unless the variable is exactly `1`. */
export function isClaudeKeepWarmEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return env[CLAUDE_KEEPWARM_ENV] === "1";
}

/** A Claude model name as the wire carries it, or as a session names it with a `provider:` prefix. */
export function isClaudeModelName(name: unknown): boolean {
    return typeof name === "string" && /^(?:[^:/\s]+:)?claude-/.test(name);
}

export const CLAUDE_KEEPWARM_INTERVAL_MS = 240_000;
export const CLAUDE_KEEPWARM_MAX_PINGS = 7;
export const CLAUDE_KEEPWARM_PING_TIMEOUT_MS = 60_000;
const CLAUDE_KEEPWARM_MAX_CACHE_WRITE_RATIO = 0.01;
/** The prompt cache's lifetime, counted from the start of the request that read or wrote it. */
const CLAUDE_KEEPWARM_CACHE_LIFETIME_MS = 300_000;
/** Time left for a ping to reach the cache before it expires; the 290 s intervalSeconds maximum keeps the same margin. */
const CLAUDE_KEEPWARM_CACHE_MARGIN_MS = 10_000;
const MODEL_CALL_PATH = /\/(?:messages|chat\/completions)\/?$/;

export interface ClaudeKeepWarmUsage {
    /** Prompt tokens including cacheRead and cacheWrite (the session-proxy.ts convention). */
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface ClaudeKeepWarmPing {
    sessionId: string;
    model: string;
    /** 1-based number of this ping within the idle gap. */
    ping: number;
    status: number;
    usage: ClaudeKeepWarmUsage;
    /** `copilot_usage.total_nano_aiu` of the ping's reply, 0 when absent. */
    totalNanoAiu: number;
    /** The session's model reference ("provider:model") when the replayed request was made, when modelRef gave one. */
    modelRef?: string;
}

export interface ClaudeKeepWarmPolicy { intervalMs: number; maxPings: number; }

export interface ClaudeKeepWarmOptions {
    /** Interval and cap for a session, asked once per captured request; no answer or a bad one: the defaults. */
    policy?: (sessionId: string, model: string) => ClaudeKeepWarmPolicy | undefined;
    onPingUsage?: (ping: ClaudeKeepWarmPing) => void | Promise<void>;
    /** Replay for a session ended. Carries a reason word and a count, never request data. */
    onStop?: (event: { sessionId: string; reason: string; pings: number }) => void;
    /**
     * Asked before each ping, with the captured request's model reference when modelRef gave one; the ping is sent
     * only when it answers true. False, an error or a rejection stops replay for the session with the reason
     * `provider-paused` until the session's next model call.
     */
    beforePing?: (event: { sessionId: string; model: string; modelRef?: string }) => boolean | Promise<boolean>;
    /** The session's model reference ("provider:model") for a captured request, asked once per captured request. */
    modelRef?: (sessionId: string, model: string) => string | undefined;
}

interface KeepWarmCapture {
    method: string;
    url: string;
    headers: Headers;
    body: string;
    model: string;
    context: CopilotRequestContext;
}

interface KeepWarmState {
    capture: KeepWarmCapture;
    pings: number;
    intervalMs: number;
    maxPings: number;
    modelRef?: string;
    timer?: ReturnType<typeof setTimeout>;
    /** Date.now() just before the latest request (the model call, then each ping) was sent. */
    startedAt: number;
}

function usageCount(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function findCopilotUsage(value: unknown, depth = 0): JsonObject | undefined {
    if (value === null || typeof value !== "object" || depth > 5) return undefined;
    if (!Array.isArray(value)) {
        const direct = (value as JsonObject).copilot_usage ?? (value as JsonObject).copilotUsage;
        if (isObject(direct)) return direct;
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === "input" || key === "arguments") continue;
        const found = findCopilotUsage(child, depth + 1);
        if (found) return found;
    }
    return undefined;
}

function parsePingReply(text: string): { usage?: ClaudeKeepWarmUsage; totalNanoAiu: number } {
    let reply: unknown;
    try { reply = JSON.parse(text); } catch { return { totalNanoAiu: 0 }; }
    if (!isObject(reply)) return { totalNanoAiu: 0 };
    const nano = usageCount(findCopilotUsage(reply)?.total_nano_aiu);
    const totalNanoAiu = nano === undefined ? 0 : Math.round(nano);
    const raw = reply.usage;
    if (!isObject(raw)) return { totalNanoAiu };
    const input = usageCount(raw.input_tokens);
    const output = usageCount(raw.output_tokens);
    const cacheRead = usageCount(raw.cache_read_input_tokens);
    const cacheWrite = usageCount(raw.cache_creation_input_tokens);
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return { totalNanoAiu };
    // The reply's input_tokens leaves out the cached prefix (the Anthropic form); store the inclusive count.
    return { usage: { input: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite }, totalNanoAiu };
}

function stopReasonForStatus(status: number): string {
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    if (status === 429) return "rate-limited";
    return "http-error";
}

/** The captured request again, with the reply cut to nothing: only `max_tokens` and `stream` change. */
function buildPingRequest(capture: KeepWarmCapture): Request {
    const body = JSON.parse(capture.body) as JsonObject;
    body.max_tokens = 0;
    body.stream = false;
    const headers = new Headers(capture.headers);
    // The length belongs to the captured body; the fetch computes the new one.
    headers.delete("content-length");
    return new Request(capture.url, { method: capture.method, headers, body: JSON.stringify(body) });
}

/**
 * Keeps a Claude conversation's prompt cache warm while the session is idle.
 *
 * Every request passes through to the SDK's own send unchanged and its response is returned with a pass-through
 * stream (never buffered). For a Claude model call over HTTP the handler keeps, in memory only, the latest request
 * of each session. When that response's body ends it arms a timer that fires the interval after the request
 * started, because the prompt cache's lifetime runs from the start of the request that reads or writes it (a reply
 * that ends 290 s or more after its request started, too late for a ping to reach the cache before it expires,
 * arms nothing: replay stops as cache-expired). Each time the
 * timer fires the handler sends the kept request again with `max_tokens` 0 and `stream` false, reads the reply
 * itself (the CLI never sees it), reports the ping's usage and arms again, counted from the ping's start. Replay
 * for a session stops after a new request replaces the capture and the gap
 * has gone through its cap of pings (7, or the model's keepWarm maxPings), on any non-2xx reply (401, 403 and 429
 * among them, with no retry), on a reply whose
 * usage cannot be read, when the ping's cache write exceeds 1% of its cache read, or when the owner drops the
 * session (compaction, a model change, close, eviction) or stops the handler, and before a ping when beforePing does
 * not answer true. Captured headers and bodies are never
 * logged or written.
 *
 * The session manager attaches it only to its durable-session client for a Claude model name, when
 * PILOTSWARM_CLAUDE_KEEPWARM is exactly 1 and needsByokRequestCompatibility(provider) is false: the GitHub
 * Copilot client and an Anthropic provider client can carry it. It never goes on a client for which
 * needsByokRequestCompatibility(provider) is true (OpenAI or Azure Chat Completions BYOK), which keeps ByokRequestCompatibility.
 */
export class ClaudeKeepWarmHeartbeat extends CopilotRequestHandler {
    private readonly states = new Map<string, KeepWarmState>();
    private readonly options: ClaudeKeepWarmOptions;
    private closed = false;

    constructor(options: ClaudeKeepWarmOptions = {}) {
        super();
        this.options = options;
    }

    protected override async sendRequest(
        request: Request,
        context: CopilotRequestContext,
    ): Promise<Response> {
        const capture = await this.captureRequest(request, context);
        if (!capture) return super.sendRequest(request, context);
        const sessionId = capture.context.sessionId as string;
        const state: KeepWarmState = {
            capture, pings: 0, startedAt: 0, ...this.policyFor(sessionId, capture.model), ...this.modelRefFor(sessionId, capture.model),
        };
        this.replace(sessionId, state);
        let response: Response;
        try {
            state.startedAt = Date.now();
            response = await super.sendRequest(request, context);
        } catch (error) {
            this.forget(sessionId, state);
            throw error;
        }
        if (!response.ok || !response.body || context.signal?.aborted) {
            this.forget(sessionId, state);
            return response;
        }
        const passThrough = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) { controller.enqueue(chunk); },
            flush: () => { if (!context.signal?.aborted) this.arm(sessionId, state); },
        });
        return new Response(response.body.pipeThrough(passThrough), {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
        });
    }

    /** Stop replay for one session, for example on compaction, a model change, close or eviction. */
    dropSession(sessionId: string, reason: string): boolean {
        const state = this.states.get(sessionId);
        return state ? this.stop(sessionId, state, reason) : false;
    }

    /** Stop every session's replay and ignore later requests. */
    stopAll(): void {
        this.closed = true;
        for (const [sessionId, state] of [...this.states]) this.stop(sessionId, state, "shutdown");
    }

    private async captureRequest(request: Request, context: CopilotRequestContext): Promise<KeepWarmCapture | undefined> {
        if (this.closed || !context.sessionId || context.transport !== "http" || request.method !== "POST") return undefined;
        let pathname: string;
        try { pathname = new URL(request.url).pathname; } catch { return undefined; }
        if (!MODEL_CALL_PATH.test(pathname)) return undefined;
        const body = await request.clone().text().catch(() => "");
        if (!body) return undefined;
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { return undefined; }
        if (!isObject(parsed) || typeof parsed.model !== "string" || !parsed.model.startsWith("claude-")) return undefined;
        return {
            method: request.method,
            url: request.url,
            headers: new Headers(request.headers),
            body,
            model: parsed.model,
            context: { ...context },
        };
    }

    private policyFor(sessionId: string, model: string): { intervalMs: number; maxPings: number } {
        let policy: ClaudeKeepWarmPolicy | undefined;
        try { policy = this.options.policy?.(sessionId, model); } catch { policy = undefined; }
        const intervalOk = Number.isSafeInteger(policy?.intervalMs) && (policy?.intervalMs as number) > 0;
        const maxOk = Number.isSafeInteger(policy?.maxPings) && (policy?.maxPings as number) > 0;
        return intervalOk && maxOk
            ? { intervalMs: policy!.intervalMs, maxPings: policy!.maxPings }
            : { intervalMs: CLAUDE_KEEPWARM_INTERVAL_MS, maxPings: CLAUDE_KEEPWARM_MAX_PINGS };
    }

    private modelRefFor(sessionId: string, model: string): { modelRef?: string } {
        let modelRef: string | undefined;
        try { modelRef = this.options.modelRef?.(sessionId, model); } catch { modelRef = undefined; }
        return typeof modelRef === "string" && modelRef.trim() ? { modelRef: modelRef.trim() } : {};
    }

    private replace(sessionId: string, state: KeepWarmState): void {
        const previous = this.states.get(sessionId);
        if (previous?.timer) clearTimeout(previous.timer);
        this.states.set(sessionId, state);
    }

    /** A request that failed or was cancelled leaves nothing to keep warm. */
    private forget(sessionId: string, state: KeepWarmState): void {
        if (this.states.get(sessionId) !== state) return;
        if (state.timer) clearTimeout(state.timer);
        this.states.delete(sessionId);
    }

    private stop(sessionId: string, state: KeepWarmState, reason: string): boolean {
        if (this.states.get(sessionId) !== state) return false;
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
        this.states.delete(sessionId);
        try { this.options.onStop?.({ sessionId, reason, pings: state.pings }); } catch { /* observers never break replay */ }
        return true;
    }

    private arm(sessionId: string, state: KeepWarmState): void {
        if (this.closed || this.states.get(sessionId) !== state) return;
        if (state.timer) clearTimeout(state.timer);
        const sinceStart = Math.max(0, Date.now() - state.startedAt);
        // A ping sent this late may reach the cache after it expired and only write the prompt again (then stop as
        // cache-miss), so replay stops 10 s before the lifetime ends. Date.now() is the wall clock: a clock step moves it.
        if (sinceStart >= CLAUDE_KEEPWARM_CACHE_LIFETIME_MS - CLAUDE_KEEPWARM_CACHE_MARGIN_MS) {
            this.stop(sessionId, state, "cache-expired");
            return;
        }
        const timer = setTimeout(() => {
            state.timer = undefined;
            void this.ping(sessionId, state);
        }, Math.max(0, state.intervalMs - sinceStart));
        timer.unref?.();
        state.timer = timer;
    }

    private async ping(sessionId: string, state: KeepWarmState): Promise<void> {
        if (this.closed || this.states.get(sessionId) !== state) return;
        const { capture } = state;
        if (this.options.beforePing) {
            let allowed = false;
            const event = { sessionId, model: capture.model, ...(state.modelRef ? { modelRef: state.modelRef } : {}) };
            try { allowed = (await this.options.beforePing(event)) === true; } catch { allowed = false; }
            if (this.closed || this.states.get(sessionId) !== state) return;
            if (!allowed) { this.stop(sessionId, state, "provider-paused"); return; }
        }
        const number = ++state.pings;
        let status: number;
        let text: string;
        try {
            state.startedAt = Date.now();
            const response = await super.sendRequest(buildPingRequest(capture), {
                ...capture.context,
                signal: AbortSignal.timeout(CLAUDE_KEEPWARM_PING_TIMEOUT_MS),
            });
            status = response.status;
            text = await response.text();
        } catch {
            this.stop(sessionId, state, "error");
            return;
        }
        const ok = status >= 200 && status < 300;
        const reply: ReturnType<typeof parsePingReply> = ok ? parsePingReply(text) : { totalNanoAiu: 0 };
        const usage = reply.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        // The ping cost tokens whatever became of the session meanwhile, so it is always reported.
        this.report({
            sessionId, model: capture.model, ping: number, status, usage, totalNanoAiu: reply.totalNanoAiu,
            ...(state.modelRef ? { modelRef: state.modelRef } : {}),
        });
        if (this.states.get(sessionId) !== state) return;
        if (!ok) { this.stop(sessionId, state, stopReasonForStatus(status)); return; }
        if (!reply.usage) { this.stop(sessionId, state, "usage-unreadable"); return; }
        if (usage.cacheWrite > usage.cacheRead * CLAUDE_KEEPWARM_MAX_CACHE_WRITE_RATIO) { this.stop(sessionId, state, "cache-miss"); return; }
        if (number >= state.maxPings) { this.stop(sessionId, state, "max-pings"); return; }
        this.arm(sessionId, state);
    }

    private report(ping: ClaudeKeepWarmPing): void {
        const callback = this.options.onPingUsage;
        if (!callback) return;
        try { void Promise.resolve(callback(ping)).catch(() => {}); } catch { /* observers never break replay */ }
    }
}
