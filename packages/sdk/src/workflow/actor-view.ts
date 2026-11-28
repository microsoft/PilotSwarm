import { canonicalJson, isJsonObject, jsonbSafeText, type JsonObject, type JsonValue } from "./json.js";

/** Project attribution only. Never use this view to decide authority. */
export function workflowActorView(actor: unknown, callerSessionId: string | null = null, displayName?: string | null): JsonObject | null {
    if (!isJsonObject(actor)) return null;
    if ((actor.kind === "agent" || actor.by === "another session" || actor.by === "this session") && typeof actor.sessionId === "string") {
        return actor.sessionId === callerSessionId ? { by: "this session" } : { by: "another session", sessionId: actor.sessionId };
    }
    if ((actor.kind === "system" || actor.by === "system") && typeof actor.name === "string") {
        return { by: "system", name: actor.name };
    }
    if (actor.by === "a person" || (typeof actor.provider === "string" && typeof actor.subject === "string")) {
        const name = displayName ?? actor.displayName ?? actor.name;
        return { by: "a person", ...(typeof name === "string" && name.trim() ? { name: jsonbSafeText(name.trim(), 200) } : {}) };
    }
    return null;
}

export function workflowTerminalErrorView(error: JsonValue): JsonValue {
    if (!isJsonObject(error) || error.code !== "stopped" || !isJsonObject(error.details) || !Object.hasOwn(error.details, "actor")) return error;
    return { ...error, details: { ...error.details, actor: workflowActorView(error.details.actor) } };
}

export function workflowInputSenderView(senderId: string): JsonObject | null {
    if (senderId.startsWith("person:user:")) return workflowActorView({ by: "a person" });
    const system = "person:system:";
    return senderId.startsWith(system)
        ? workflowActorView({ kind: "system", name: new URLSearchParams(`name=${senderId.slice(system.length)}`).get("name") })
        : null;
}

export function workflowInputEventView(data: JsonObject): JsonObject {
    const id = data.senderSessionId;
    const sender = typeof id === "string" ? workflowInputSenderView(id) : null;
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

/** Historical events predate write-side masking. Only touch the engine's attribution fields. */
export function workflowEventActorView(eventType: string, data: unknown): unknown {
    if (!eventType.startsWith("workflow.") || !isJsonObject(data)) return data;
    if (eventType === "workflow.input_accepted" || (eventType === "workflow.state_completed" && typeof data.messageId === "string")) {
        return workflowInputEventView(data);
    }
    const key = eventType === "workflow.state_supplied" ? "by" : eventType === "workflow.state_completed" && data.approval === true
        ? "decidedBy" : "actor";
    if (!Object.hasOwn(data, key)) return data;
    return { ...data, [key]: workflowActorView(data[key]) };
}
