import { canonicalJson, isJsonObject, jsonbSafeText, parseStoredJson, type JsonObject, type JsonValue } from "./json.js";
import type { WorkflowActor } from "./store.js";

/** Project attribution only. Never use this view to decide authority. */
export function workflowActorView(actor: unknown, callerSessionId: string | null = null, displayName?: string | null): JsonObject | null {
    if (actor == null) return null;
    if (!isJsonObject(actor)) return { by: "a person" };
    if ((actor.kind === "agent" || actor.by === "another session" || actor.by === "this session") && typeof actor.sessionId === "string") {
        return actor.sessionId === callerSessionId ? { by: "this session" } : { by: "another session", sessionId: actor.sessionId };
    }
    if (actor.by === "this session") return { by: "this session" };
    if (actor.kind === "system" || actor.by === "system") {
        return { by: "system", ...(typeof actor.name === "string" && actor.name ? { name: actor.name } : {}) };
    }
    const name = displayName ?? actor.display ?? actor.displayName ?? actor.name;
    return { by: "a person", ...(typeof name === "string" && name.trim() ? { name: jsonbSafeText(name.trim(), 200) } : {}) };
}

/** Project legacy engine-carried attribution without mutating values used by the Workflow. */
export function workflowPublicValueView(value: JsonValue, canonicalText?: string): JsonValue {
    if (value !== null && typeof value === "object" && !hasPrivateValueMarker(canonicalText ?? JSON.stringify(value))) return value;
    return maskPublicValue(value);
}

function hasPrivateValueMarker(text: string): boolean {
    return text.includes('"subject"') || text.includes("person:user:");
}

function maskPublicValue(value: JsonValue): JsonValue {
    if (typeof value === "string" && value.startsWith("person:user:")) return { by: "a person" };
    if (Array.isArray(value)) {
        const view = value.map(maskPublicValue);
        return view.some((item, index) => item !== value[index]) ? view : value;
    }
    if (!isJsonObject(value)) return value;
    if (typeof value.provider === "string" && typeof value.subject === "string") return workflowActorView(value);
    const view = Object.entries(value).map(([key, item]) => [key, maskPublicValue(item)] as const);
    return view.some(([key, item]) => item !== value[key]) ? Object.fromEntries(view) : value;
}

/** Preserve the original stored text when it contains no private attribution. */
export function workflowPublicValueText(text: string | null): string | null {
    if (text === null || !hasPrivateValueMarker(text)) return text;
    return maskPublicValueText(text, parseStoredJson(text));
}

function maskPublicValueText(text: string, value: JsonValue): string {
    const view = maskPublicValue(value);
    return view === value ? text : canonicalJson(view);
}

/** Redact a stored JSON preview even when its last string was cut mid-value. */
export function workflowPublicValuePreview(text: string, maxCodePoints?: number): string {
    if (!hasPrivateValueMarker(text) && !text.includes('"provider"')) return text;
    const view = maskPublicPreview(text);
    return maxCodePoints === undefined || view === text ? view : [...view].slice(0, maxCodePoints).join("");
}

function maskPublicPreview(text: string): string {
    let value: JsonValue;
    try {
        value = JSON.parse(text);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const suffix = text.endsWith("…") ? "…" : "";
        const head = suffix ? text.slice(0, -1) : text;
        return head
            .replace(/"person:user:(?:[^"\\]|\\.)*(?:"|\\?$)/gs, '{"by":"a person"}')
            .replace(/("(?:provider|subject)"\s*:\s*)"(?:[^"\\]|\\.)*(?:"|\\?$)/gs, '$1"[redacted]"')
            + suffix;
    }
    return hasPrivateValueMarker(text) ? maskPublicValueText(text, value) : text;
}

export function workflowTerminalErrorView(error: JsonValue): JsonValue {
    if (!isJsonObject(error) || error.code !== "stopped" || !isJsonObject(error.details) || !Object.hasOwn(error.details, "actor")) return error;
    return { ...error, details: { ...error.details, actor: workflowActorView(error.details.actor) } };
}

export function workflowInputSenderActor(senderId: string): WorkflowActor | null {
    const person = /^person:user:([^:]+):([^:]+)$/.exec(senderId);
    if (person) {
        const decode = (value: string) => new URLSearchParams(`v=${value}`).get("v") ?? "";
        return { kind: "user", provider: decode(person[1]), subject: decode(person[2]) };
    }
    const system = "person:system:";
    return senderId.startsWith(system) ? { kind: "system", name: new URLSearchParams(`name=${senderId.slice(system.length)}`).get("name") ?? "" } : null;
}

export function workflowInputSenderView(senderId: string): JsonObject | null {
    return senderId.startsWith("person:user:") ? { by: "a person" } : workflowActorView(workflowInputSenderActor(senderId));
}

export function workflowInputEventView(data: JsonObject, resolvedSender?: JsonObject | null): JsonObject {
    const id = data.senderSessionId;
    const sender = typeof id === "string" ? (resolvedSender ?? workflowInputSenderView(id)) : null;
    if (!sender || typeof id !== "string") return data;
    const { senderSessionId, ...view } = data;
    if (typeof view.outputPreview === "string" && typeof view.contract === "string") {
        // A list receive wraps the payload with the engine's sender id. Don't rewrite the payload itself.
        const prefix = `{"contract":${canonicalJson(view.contract)},"from":`;
        const raw = canonicalJson(id);
        if (view.outputPreview.startsWith(prefix + raw)) {
            view.outputPreview = jsonbSafeText(prefix + canonicalJson(sender) + view.outputPreview.slice((prefix + raw).length), 1_000);
        } else if (view.outputPreview.startsWith(prefix) && raw.startsWith(view.outputPreview.slice(prefix.length))) {
            delete view.outputPreview; // The stored preview was cut in the middle of the private id.
        }
    }
    return { ...view, sender };
}

/** Mask Workflow event attribution and engine previews at the shared event read boundary. */
export function workflowEventActorView(eventType: string, data: unknown): unknown {
    if (!eventType.startsWith("workflow.") || !isJsonObject(data)) return data;
    const event = eventType === "workflow.input_accepted" || (eventType === "workflow.state_completed" && typeof data.messageId === "string")
        ? workflowInputEventView(data) : data;
    const key = eventType === "workflow.state_supplied" ? "by" : eventType === "workflow.state_completed" && data.approval === true
        ? "decidedBy" : "actor";
    const hasActor = Object.hasOwn(event, key);
    const inputPreview = typeof event.inputPreview === "string" ? workflowPublicValuePreview(event.inputPreview) : event.inputPreview;
    const outputPreview = typeof event.outputPreview === "string" ? workflowPublicValuePreview(event.outputPreview) : event.outputPreview;
    if (!hasActor && inputPreview === event.inputPreview && outputPreview === event.outputPreview) return event;
    return {
        ...event,
        ...(hasActor ? { [key]: workflowActorView(event[key]) } : {}),
        ...(typeof inputPreview === "string" && inputPreview !== event.inputPreview ? { inputPreview: jsonbSafeText(inputPreview, 1_000) } : {}),
        ...(typeof outputPreview === "string" && outputPreview !== event.outputPreview ? { outputPreview: jsonbSafeText(outputPreview, 1_000) } : {}),
    };
}
