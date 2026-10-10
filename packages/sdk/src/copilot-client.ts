import { CopilotClient, CopilotRequestHandler, RuntimeConnection } from "@github/copilot-sdk";
import type { CopilotClientOptions, CopilotRequestContext } from "@github/copilot-sdk";
import { createParser } from "eventsource-parser";

type JsonObject = Record<string, any>;
type ToolGroup = { body: JsonObject; name: string; toolNames: Set<string> };
const MODEL_ROUTER_MAX_TOOLS = 128;
const SCHEMA_DOCUMENT_KEYS = new Set(["$ref", "$id", "$schema", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"]);

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSchemaDocumentScope(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasSchemaDocumentScope);
    if (!isObject(value)) return false;
    return Object.entries(value).some(([key, child]) => SCHEMA_DOCUMENT_KEYS.has(key) || hasSchemaDocumentScope(child));
}

function groupOverflowTools(body: JsonObject): ToolGroup | undefined {
    if (body.model !== "model-router" || !Array.isArray(body.tools) || body.tools.length <= MODEL_ROUTER_MAX_TOOLS) return;
    const choice = body.tool_choice;
    const forcedName = isObject(choice) && choice.type === "function" && isObject(choice.function)
        && typeof choice.function.name === "string" && Object.keys(choice.function).length === 1
        && Object.keys(choice).every(key => key === "type" || key === "function") ? choice.function.name : undefined;
    if (choice != null && !["auto", "none", "required"].includes(choice) && forcedName === undefined) {
        throw new Error("The 128-tool limit cannot be adapted with a restricted or unsupported tool choice. Select a compatible model or reduce the configured tool catalog.");
    }
    const candidates = body.tools.filter((tool: unknown) => isObject(tool)
        && tool.type === "function" && isObject(tool.function)
        && typeof tool.function.name === "string" && tool.function.name !== forcedName
        && (tool.function.strict === undefined || tool.function.strict === false)
        && isObject(tool.function.parameters) && tool.function.parameters.type === "object"
        && !hasSchemaDocumentScope(tool.function.parameters)
        && Object.keys(tool).every(key => key === "type" || key === "function")
        && Object.keys(tool.function).every(key => ["name", "description", "parameters", "strict"].includes(key)));
    const required = body.tools.length - MODEL_ROUTER_MAX_TOOLS + 1;
    if (candidates.length < required) {
        throw new Error("The 128-tool limit cannot be met without changing strict or unsupported tool schemas. Select a compatible model or reduce the configured tool catalog.");
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
            description: "Invoke one of the tools described by this schema. Select its tool_name and supply its original arguments. Each alternative describes one available tool.",
            parameters: {
                type: "object",
                properties: {
                    tool_name: { type: "string", enum: [...toolNames] },
                    arguments: { type: "object" },
                },
                required: ["tool_name", "arguments"],
                additionalProperties: false,
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
    };
    const messages = Array.isArray(body.messages) ? body.messages.map((message: JsonObject) => {
        if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
        return { ...message, tool_calls: message.tool_calls.map((call: JsonObject) => {
            if (!toolNames.has(call.function?.name) || typeof call.function.arguments !== "string") return call;
            let args;
            try { args = JSON.parse(call.function.arguments); } catch { return call; }
            if (!isObject(args)) return call;
            return { ...call, function: { ...call.function, name, arguments: JSON.stringify({ tool_name: call.function.name, arguments: args }) } };
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
    if (!isObject(args) || typeof args.tool_name !== "string" || !group.toolNames.has(args.tool_name)
        || !isObject(args.arguments) || Object.keys(args).some(key => key !== "tool_name" && key !== "arguments")) {
        throw new Error("Tool dispatcher returned an invalid tool or arguments; refusing this tool call.");
    }
    return { ...call, function: { ...call.function, name: args.tool_name, arguments: JSON.stringify(args.arguments) } };
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
 * intact), or an Anthropic/WIF client. Remove once the provider compatibility
 * tests pass without it. Only requests for the exact model-router deployment
 * group oversized catalogs through a typed dispatch function; restore calls
 * before the runtime's permission/tool hooks. Other models keep their catalogs.
 */
export class ByokRequestCompatibility extends CopilotRequestHandler {
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
                group = groupOverflowTools(body);
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
export function createCopilotClient(options: CopilotClientOptions, provider?: unknown): CopilotClient {
    return new CopilotClient({
        ...options,
        // Do not let ambient COPILOT_SDK_DEFAULT_CONNECTION opt a multi-tenant
        // worker into the experimental process-global in-process transport.
        // Stdio uses the pinned SDK runtime and honors COPILOT_CLI_PATH.
        connection: RuntimeConnection.forStdio(),
        ...(needsByokRequestCompatibility(provider) ? { requestHandler: new ByokRequestCompatibility() } : {}),
    });
}

// A separate pool slot keeps the shim off native GHCP/Anthropic clients.
// NUL cannot occur in a GitHub token; this namespace cannot collide with one.
export const BYOK_CLIENT_PREFIX = "byok-openai\0";
