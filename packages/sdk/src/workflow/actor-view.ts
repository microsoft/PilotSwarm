import { isJsonObject, jsonbSafeText, type JsonObject, type JsonValue } from "./json.js";

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

/** Historical events predate write-side masking. Only touch the engine's attribution fields. */
export function workflowEventActorView(eventType: string, data: unknown): unknown {
    if (!eventType.startsWith("workflow.") || !isJsonObject(data)) return data;
    const key = eventType === "workflow.state_supplied" ? "by" : eventType === "workflow.state_completed" && data.approval === true
        ? "decidedBy" : "actor";
    if (!Object.hasOwn(data, key)) return data;
    return { ...data, [key]: workflowActorView(data[key]) };
}
