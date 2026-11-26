import { CopilotClient, CopilotRequestHandler, RuntimeConnection } from "@github/copilot-sdk";
import type { CopilotClientOptions, CopilotRequestContext } from "@github/copilot-sdk";
import { createParser } from "eventsource-parser";
import { normalizeToolCatalog, type ToolCatalogCapability } from "./model-providers.js";

type JsonObject = Record<string, any>;
type ToolGroup = { body: JsonObject; name: string; toolNames: Set<string> };
export type ToolCatalogPolicyResolver = (request: Request, context: CopilotRequestContext, model: string) => ToolCatalogCapability | undefined;

/** One-shot inference helpers answer from the prompt alone and must not receive runtime tools. */
export function textOnlyCopilotSessionOptions(): { availableTools: string[] } {
    return { availableTools: [] };
}

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

/** Only OpenAI-compatible Chat Completions clients support typed catalog overflow. */
export function needsByokRequestCompatibility(provider: unknown): boolean {
    if (!provider || typeof provider !== "object") return false;
    const { type, wireApi } = provider as { type?: string; wireApi?: string };
    return (!type || type === "openai" || type === "azure") && (!wireApi || wireApi === "completions");
}

/** Only native GitHub Copilot (no provider) and Anthropic providers are asked on the Anthropic Messages wire, the one request keep-warm can capture and replay. */
export function supportsClaudeKeepWarm(provider: unknown): boolean {
    if (!provider || typeof provider !== "object") return true;
    return (provider as { type?: string }).type === "anthropic";
}

/**
 * Adapts OpenAI/Azure Chat Completions requests for catalog entries with an
 * explicit typed-dispatch overflow policy. Restore grouped calls before the
 * runtime's permission and tool hooks. Native providers and providers without
 * an opt-in receive no request handler.
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
                const policy = typeof this.toolCatalog === "function"
                    ? (typeof body.model === "string" ? normalizeToolCatalog(this.toolCatalog(request, context, body.model)) : undefined)
                    : this.toolCatalog;
                group = groupOverflowTools(body, policy);
                if (group) {
                    const headers = new Headers(request.headers);
                    headers.delete("content-length");
                    request = new Request(request, { headers, body: JSON.stringify(group.body) });
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
        ...(toolCatalog && needsByokRequestCompatibility(provider)
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
/** A timer set for the 290 s maximum interval fires a few ms late; this much slack keeps that interval usable. */
const CLAUDE_KEEPWARM_TIMER_SLACK_MS = 1_000;
/** The only model call a ping can replay: the Anthropic Messages API. */
const MODEL_CALL_PATH = /\/v1\/messages\/?$/;
/** The interaction types of the main conversation; others (background, sampling, sub-agent, compaction) are not kept. */
const CAPTURED_INTERACTION_TYPES = new Set(["conversation-user", "conversation-agent"]);

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
    /** When the replayed request was captured (ms since the epoch); with sessionId and ping it names the ping. */
    capturedAt: number;
    /** The reply's HTTP status; absent when the ping threw, timed out or could not read its token (no reply). */
    status?: number;
    /** The reply's token counts; absent unless the reply was a readable 2xx, so a recorder tells unknown from zero. */
    usage?: ClaudeKeepWarmUsage;
    /** `copilot_usage.total_nano_aiu` of the ping's reply; undefined when the reply carries none, and a reported 0 stays 0. */
    totalNanoAiu?: number;
    /** The send's own duration in milliseconds; absent when there was no reply. */
    latencyMs?: number;
    /** The session's model reference ("provider:model") when the replayed request was made, when identity gave one. */
    modelRef?: string;
    /** The provider row's immutable id read when the replayed request was made, when identity gave one. */
    providerInstanceId?: string;
}

export interface ClaudeKeepWarmPolicy { intervalMs: number; maxPings: number; }

/** What the manager knows about the session's provider when a request is captured. */
export interface ClaudeKeepWarmIdentity { modelRef?: string; providerInstanceId?: string; }

export interface ClaudeKeepWarmBeforePing {
    sessionId: string;
    model: string;
    modelRef?: string;
    providerInstanceId?: string;
    capturedAt: number;
    /** The 1-based number the ping about to be sent will have. */
    ping: number;
}

export interface ClaudeKeepWarmOptions {
    /** Interval and cap for a session, asked once per captured request; no answer or a bad one: the defaults. */
    policy?: (sessionId: string, model: string) => ClaudeKeepWarmPolicy | undefined;
    /** Called for every ping that was sent (or tried), with no status when it got no reply; a throw or a rejection stops replay for the session (`usage-write-failed`) before the next ping. */
    onPingUsage?: (ping: ClaudeKeepWarmPing) => void | Promise<void>;
    /** Settles a ledger claim for a ping whose admission succeeded but which was dropped before the send. */
    onPingAborted?: (ping: ClaudeKeepWarmPing) => void | Promise<void>;
    /** Replay for a session ended. Carries a reason word and a count, never request data. */
    onStop?: (event: { sessionId: string; reason: string; pings: number }) => void;
    /**
     * Asked before each ping with the captured request's identity and the number the ping will have; the ping is sent
     * only when it answers true. A string stops replay for the session with that reason; false, an error or a rejection
     * stops it with the reason `provider-paused`, until the session's next model call.
     */
    beforePing?: (event: ClaudeKeepWarmBeforePing) => boolean | string | Promise<boolean | string>;
    /** The session's model reference and provider instance for a captured request, asked once per captured request. */
    identity?: (sessionId: string, model: string) => ClaudeKeepWarmIdentity | undefined;
    /**
     * A reader of a fresh bearer token for a session whose provider holds no key (workload identity), asked once per
     * captured request; no answer, or a throw, means the ping keeps the captured request's authorization header. The
     * reader itself is called once for each ping, right before the send, never at capture time.
     */
    bearerToken?: (sessionId: string, model: string) => (() => Promise<string>) | undefined;
}

interface KeepWarmCapture {
    method: string;
    url: string;
    headers: Headers;
    body: string;
    model: string;
    context: CopilotRequestContext;
    /** When the request was captured (ms since the epoch); unlike the state's startedAt it does not move with a ping. */
    capturedAt: number;
}

interface KeepWarmState {
    capture: KeepWarmCapture;
    pings: number;
    intervalMs: number;
    maxPings: number;
    modelRef?: string;
    providerInstanceId?: string;
    bearerToken?: () => Promise<string>;
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

function parsePingReply(text: string): { usage?: ClaudeKeepWarmUsage; totalNanoAiu?: number } {
    let reply: unknown;
    try { reply = JSON.parse(text); } catch { return {}; }
    if (!isObject(reply)) return {};
    const nano = usageCount(findCopilotUsage(reply)?.total_nano_aiu);
    const totalNanoAiu = nano === undefined ? undefined : Math.round(nano);
    const raw = reply.usage;
    if (!isObject(raw)) return { totalNanoAiu };
    const input = usageCount(raw.input_tokens);
    const output = usageCount(raw.output_tokens);
    // The API sends null for a cache counter it did not use: that is 0 tokens, not an unreadable reply.
    const cacheCount = (value: unknown): number | undefined => (value === null ? 0 : usageCount(value));
    const cacheRead = cacheCount(raw.cache_read_input_tokens);
    const cacheWrite = cacheCount(raw.cache_creation_input_tokens);
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return { totalNanoAiu };
    // The reply's input_tokens leaves out the cached prefix (the Anthropic form); store the inclusive count.
    return { usage: { input: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite }, totalNanoAiu };
}

function stopReasonForStatus(status: number): string {
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    if (status === 429) return "rate-limited";
    if (status >= 300 && status < 400) return "redirect";
    return "http-error";
}

/**
 * A `max_tokens` 0 ping cannot replay a request whose reply must carry thinking, a structured output or a forced tool
 * call: the API rejects it, or it would not read the same cache prefix. Such a request is passed through, not kept.
 */
function canReplayWithZeroTokens(parsed: JsonObject): boolean {
    const thinking = parsed.thinking;
    if (isObject(thinking) && thinking.type === "enabled") return false;
    const outputConfig = parsed.output_config;
    if (isObject(outputConfig) && outputConfig.format !== undefined && outputConfig.format !== null) return false;
    const toolChoice = parsed.tool_choice;
    if (isObject(toolChoice) && (toolChoice.type === "any" || toolChoice.type === "tool")) return false;
    return true;
}

/**
 * The captured request again, with the reply cut to nothing: only `max_tokens` and `stream` change. A redirect is
 * not followed (the prompt and the credentials never go to another origin): its reply stops replay.
 */
function buildPingRequest(capture: KeepWarmCapture, bearerToken?: string): Request {
    const body = JSON.parse(capture.body) as JsonObject;
    body.max_tokens = 0;
    body.stream = false;
    const headers = new Headers(capture.headers);
    // The length belongs to the captured body; the fetch computes the new one.
    headers.delete("content-length");
    // A workload-identity token is short-lived, so the ping carries a fresh one in place of the captured header.
    if (bearerToken !== undefined) headers.set("authorization", `Bearer ${bearerToken}`);
    return new Request(capture.url, { method: capture.method, headers, body: JSON.stringify(body), redirect: "manual" });
}

/** The ping's token from the session's reader, bounded by the ping's own timeout; an empty or non-string token is an error. */
async function readBearerToken(read: (() => Promise<string>) | undefined, signal: AbortSignal): Promise<string | undefined> {
    if (!read) return undefined;
    const token: unknown = await new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
        read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
    if (typeof token !== "string" || !token.trim()) throw new Error("keep-warm bearer token is empty");
    return token;
}

/**
 * Keeps a Claude conversation's prompt cache warm while the session is idle.
 *
 * Every request passes through to the SDK's own send unchanged, and its response is returned with a pass-through
 * stream (never buffered). The handler keeps, in memory only, the latest main-conversation request of each session:
 * a Claude `/v1/messages` call over HTTP whose interaction type is absent, conversation-user or conversation-agent and
 * that has no parentAgentId. Anything else is passed through and never kept; a conversation-compaction request drops
 * the session's replay. A request that qualifies ends the session's earlier capture as soon as it arrives, and its own
 * capture is published only if no later request, drop or stop came while its body was read. When the response body
 * ends, a timer is armed to fire the interval after the request started, because the prompt cache's lifetime runs from
 * the start of the request that reads or writes it. A response body that errors, or that the caller cancels, clears
 * the capture.
 *
 * Each time the timer fires the handler checks the cache deadline again, sends the kept request with `max_tokens` 0
 * and `stream` false, reads the reply itself (the CLI never sees it), reports the ping's usage and arms again,
 * counted from the ping's start. Replay for a session stops: at the cap of pings, on any non-2xx reply (no retry),
 * on a reply whose usage cannot be read, when the ping's cache read is 0 or its cache write exceeds 1% of its cache
 * read, when the usage report fails, when the owner drops the session (compaction, abort, a model change, close,
 * eviction) or stops the handler (a worker stop or drain), and before a ping when beforePing does not answer true.
 * Captured headers and bodies are never logged or written. A session whose provider holds no key (workload identity)
 * gets a fresh bearer token for each ping from its bearerToken reader, bounded by the ping's timeout, in place of the
 * captured authorization header; an empty token, a throw or a timeout stops replay as error.
 *
 * The session manager attaches it only to its durable-session client for a Claude model name, when
 * PILOTSWARM_CLAUDE_KEEPWARM is exactly 1 and supportsClaudeKeepWarm(provider) is true: the GitHub Copilot client
 * and an Anthropic provider client can carry it. It never goes on a client for an OpenAI or Azure provider.
 */
export class ClaudeKeepWarmHeartbeat extends CopilotRequestHandler {
    private readonly states = new Map<string, KeepWarmState>();
    /** The capture of each session whose request body is being read; a later request, drop or stop replaces or removes it. */
    private readonly pending = new Map<string, object>();
    private readonly options: ClaudeKeepWarmOptions;
    private closed = false;

    constructor(options: ClaudeKeepWarmOptions = {}) {
        super();
        this.options = options;
    }

    /** Whether stopAll was called: a stopped handler captures, pings and reads nothing. */
    get isStopped(): boolean {
        return this.closed;
    }

    protected override async sendRequest(
        request: Request,
        context: CopilotRequestContext,
    ): Promise<Response> {
        if (context.interactionType === "conversation-compaction" && context.sessionId) {
            // The compaction rewrites the history the kept request carries, so the cache no longer matches it.
            this.dropSession(context.sessionId, "compaction");
            return super.sendRequest(request, context);
        }
        if (!this.mayCapture(request, context)) return super.sendRequest(request, context);
        const sessionId = context.sessionId as string;
        // The kept request is stale from here on; the new capture takes its place only if it is still the latest.
        const hadReplay = this.states.get(sessionId);
        const token = this.invalidate(sessionId);
        const capture = await this.readCapture(request, context);
        const current = !this.closed && this.pending.get(sessionId) === token;
        if (this.pending.get(sessionId) === token) this.pending.delete(sessionId);
        if (!capture || !current) {
            // A replay ended because the request that replaced its capture could not be kept; say so, as every other end does.
            if (!capture && current && hadReplay) {
                try { this.options.onStop?.({ sessionId, reason: "uncapturable", pings: hadReplay.pings }); } catch { /* observers never break replay */ }
            }
            return super.sendRequest(request, context);
        }
        const state: KeepWarmState = {
            capture, pings: 0, startedAt: 0, ...this.policyFor(sessionId, capture.model), ...this.identityFor(sessionId, capture.model),
            ...this.bearerTokenFor(sessionId, capture.model),
        };
        this.states.set(sessionId, state);
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
        const source = response.body.getReader();
        // The pull below sees an upstream error only when the caller reads; this sees it at once, so a body that fails
        // before any read leaves no capture behind. A body that ends or is cancelled does not reject, and forget does
        // nothing when the state is no longer this request's.
        source.closed.catch(() => this.forget(sessionId, state));
        // A pass-through stream that reads only when the caller does: it arms the timer when the body ends, and clears the
        // capture when the body fails or the caller cancels it.
        const body = new ReadableStream<Uint8Array>({
            pull: async controller => {
                try {
                    const { done, value } = await source.read();
                    if (!done) { controller.enqueue(value); return; }
                    controller.close();
                    if (context.signal?.aborted) this.forget(sessionId, state);
                    else this.arm(sessionId, state);
                } catch (error) {
                    this.forget(sessionId, state);
                    controller.error(error);
                }
            },
            cancel: async reason => {
                this.forget(sessionId, state);
                await source.cancel(reason);
            },
        }, { highWaterMark: 0 });
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
        });
    }

    /** Stop replay for one session, for example on compaction, a model change, close or eviction. */
    dropSession(sessionId: string, reason: string): boolean {
        this.pending.delete(sessionId);
        const state = this.states.get(sessionId);
        return state ? this.stop(sessionId, state, reason) : false;
    }

    /** Stop every session's replay and ignore later requests. */
    stopAll(): void {
        this.closed = true;
        this.pending.clear();
        for (const [sessionId, state] of [...this.states]) this.stop(sessionId, state, "shutdown");
    }

    /** Whether a request is the main conversation's Claude model call over HTTP, from what is known before its body is read. */
    private mayCapture(request: Request, context: CopilotRequestContext): boolean {
        if (this.closed || !context.sessionId || context.transport !== "http" || request.method !== "POST") return false;
        if (context.parentAgentId) return false;
        if (context.interactionType && !CAPTURED_INTERACTION_TYPES.has(context.interactionType)) return false;
        try { return MODEL_CALL_PATH.test(new URL(request.url).pathname); } catch { return false; }
    }

    /** The session's earlier capture is dropped silently; the returned token marks this request's capture as the latest. */
    private invalidate(sessionId: string): object {
        const previous = this.states.get(sessionId);
        if (previous?.timer) clearTimeout(previous.timer);
        this.states.delete(sessionId);
        const token = {};
        this.pending.set(sessionId, token);
        return token;
    }

    private async readCapture(request: Request, context: CopilotRequestContext): Promise<KeepWarmCapture | undefined> {
        let body: string;
        try { body = await request.clone().text(); } catch { return undefined; }
        if (!body) return undefined;
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { return undefined; }
        if (!isObject(parsed) || typeof parsed.model !== "string" || !parsed.model.startsWith("claude-")) return undefined;
        if (!canReplayWithZeroTokens(parsed)) return undefined;
        return {
            method: request.method,
            url: request.url,
            headers: new Headers(request.headers),
            body,
            model: parsed.model,
            context: { ...context },
            capturedAt: Date.now(),
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

    private identityFor(sessionId: string, model: string): { modelRef?: string; providerInstanceId?: string } {
        let identity: ClaudeKeepWarmIdentity | undefined;
        try { identity = this.options.identity?.(sessionId, model); } catch { identity = undefined; }
        const modelRef = typeof identity?.modelRef === "string" ? identity.modelRef.trim() : "";
        const providerInstanceId = typeof identity?.providerInstanceId === "string" ? identity.providerInstanceId.trim() : "";
        return { ...(modelRef ? { modelRef } : {}), ...(providerInstanceId ? { providerInstanceId } : {}) };
    }

    private bearerTokenFor(sessionId: string, model: string): { bearerToken?: () => Promise<string> } {
        let read: (() => Promise<string>) | undefined;
        try { read = this.options.bearerToken?.(sessionId, model); } catch { read = undefined; }
        return typeof read === "function" ? { bearerToken: read } : {};
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
            // A ping that fails in a way not handled inside it ends the replay, never an unhandled rejection or a gap with no timer.
            void this.ping(sessionId, state).catch(() => { this.stop(sessionId, state, "error"); });
        }, Math.max(0, state.intervalMs - sinceStart));
        timer.unref?.();
        state.timer = timer;
    }

    private async ping(sessionId: string, state: KeepWarmState): Promise<void> {
        if (this.closed || this.states.get(sessionId) !== state) return;
        const { capture } = state;
        let admitted: ClaudeKeepWarmPing | undefined;
        if (this.options.beforePing) {
            let verdict: boolean | string = false;
            const event: ClaudeKeepWarmBeforePing = {
                sessionId, model: capture.model, capturedAt: capture.capturedAt, ping: state.pings + 1,
                ...(state.modelRef ? { modelRef: state.modelRef } : {}),
                ...(state.providerInstanceId ? { providerInstanceId: state.providerInstanceId } : {}),
            };
            try { verdict = await this.options.beforePing(event); } catch { verdict = false; }
            if (verdict === true) admitted = { ...event };
            if (this.closed || this.states.get(sessionId) !== state) {
                if (admitted) await this.abort(admitted);
                return;
            }
            if (verdict !== true) {
                this.stop(sessionId, state, typeof verdict === "string" && verdict.trim() ? verdict.trim() : "provider-paused");
                return;
            }
        }
        // The check at arm time cannot see a slow beforePing or a late timer, so the deadline is checked again here.
        if (Date.now() - state.startedAt > CLAUDE_KEEPWARM_CACHE_LIFETIME_MS - CLAUDE_KEEPWARM_CACHE_MARGIN_MS
            + CLAUDE_KEEPWARM_TIMER_SLACK_MS) {
            this.stop(sessionId, state, "cache-expired");
            if (admitted) await this.abort(admitted);
            return;
        }
        const number = ++state.pings;
        const identity = {
            ...(state.modelRef ? { modelRef: state.modelRef } : {}),
            ...(state.providerInstanceId ? { providerInstanceId: state.providerInstanceId } : {}),
        };
        let status: number;
        let text: string;
        let sentAt = 0;
        let latencyMs = 0;
        // A ping already sent is not cancelled by a stop or a drop: it ends within the 60 s timeout and its reply is still
        // reported, so the cost it made is recorded. A ping that throws or times out is reported once, with no reply.
        try {
            state.startedAt = Date.now();
            const signal = AbortSignal.timeout(CLAUDE_KEEPWARM_PING_TIMEOUT_MS);
            const bearerToken = await readBearerToken(state.bearerToken, signal);
            sentAt = Date.now();
            const response = await super.sendRequest(buildPingRequest(capture, bearerToken), {
                ...capture.context,
                signal,
            });
            status = response.status;
            text = await response.text();
            latencyMs = Math.max(0, Date.now() - sentAt);
        } catch {
            this.stop(sessionId, state, "error");
            await this.report({ sessionId, model: capture.model, ping: number, capturedAt: capture.capturedAt, ...identity });
            return;
        }
        const ok = status >= 200 && status < 300;
        const reply: ReturnType<typeof parsePingReply> = ok ? parsePingReply(text) : {};
        const usage = reply.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        // The ping cost tokens whatever became of the session meanwhile, so it is always reported; the next ping waits for the write.
        const written = await this.report({
            sessionId, model: capture.model, ping: number, capturedAt: capture.capturedAt, status, latencyMs,
            ...(reply.usage ? { usage: reply.usage } : {}),
            ...(reply.totalNanoAiu === undefined ? {} : { totalNanoAiu: reply.totalNanoAiu }),
            ...identity,
        });
        if (this.states.get(sessionId) !== state) return;
        if (!ok) { this.stop(sessionId, state, stopReasonForStatus(status)); return; }
        if (!reply.usage) { this.stop(sessionId, state, "usage-unreadable"); return; }
        // No cache read means the prompt was not read from the cache; a ping that read nothing and wrote nothing proves nothing.
        if (usage.cacheRead === 0 || usage.cacheWrite > usage.cacheRead * CLAUDE_KEEPWARM_MAX_CACHE_WRITE_RATIO) {
            this.stop(sessionId, state, "cache-miss");
            return;
        }
        if (!written) { this.stop(sessionId, state, "usage-write-failed"); return; }
        if (number >= state.maxPings) { this.stop(sessionId, state, "max-pings"); return; }
        this.arm(sessionId, state);
    }

    private async abort(ping: ClaudeKeepWarmPing): Promise<void> {
        try { await this.options.onPingAborted?.(ping); } catch { /* observers never break a stopped replay */ }
    }

    /** Whether the usage callback took the ping; a throw or a rejection is a failed write. */
    private async report(ping: ClaudeKeepWarmPing): Promise<boolean> {
        const callback = this.options.onPingUsage;
        if (!callback) return true;
        try {
            await callback(ping);
            return true;
        } catch {
            return false;
        }
    }
}
