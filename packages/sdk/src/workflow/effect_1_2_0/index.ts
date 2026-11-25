import type { OrchestrationContext, ScheduledTask } from "duroxide";

/** Identity of the separate Spawn effect registered at 1.2.0. */
export const WORKFLOW_EFFECT_1_2_0_NAME = "workflow-effect";
export const WORKFLOW_EFFECT_1_2_0_VERSION = "1.2.0";

const WORKFLOW_REQUEST_CAPABILITY = "pilotswarm.workflow-request.v1";
const WORKFLOW_ACTIVITIES = {
    spawnChild: "workflow.spawnChild",
    recordEffectResult: "workflow.recordEffectResult",
    wake: "workflow.wake",
} as const;
const WORKFLOW_STORE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
const ACTIVITY_ERROR_PREFIX = /^Activity \x27[^\x27]+\x27 JS execution failed: [A-Za-z]+, (?:[A-Za-z]*Error: )?/;

class WorkflowControllerProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowControllerProtocolError";
    }
}

function expect(condition: boolean, message: string): asserts condition {
    if (!condition) throw new WorkflowControllerProtocolError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
    expect(isRecord(value), `${what} is not an object`);
    return value;
}

function text(value: unknown, what: string): string {
    expect(typeof value === "string", `${what} is not a string`);
    return value;
}

interface EffectInput {
    runId: string;
    nodeExecutionId: string;
    controllerInstanceId: string;
}

function parseEffectInput(value: unknown): EffectInput {
    const input = record(value, "effect input");
    return {
        runId: text(input.runId, "runId"), nodeExecutionId: text(input.nodeExecutionId, "nodeExecutionId"),
        controllerInstanceId: text(input.controllerInstanceId, "controllerInstanceId"),
    };
}

interface SpawnEffectInput extends EffectInput {
    nodeType: "spawn";
}

function parseSpawnEffectInput(value: unknown): SpawnEffectInput {
    const parsed = parseEffectInput(value);
    const input = record(value, "spawn effect input");
    expect(input.nodeType === "spawn", "spawn effect nodeType is invalid");
    return { ...parsed, nodeType: "spawn" };
}

function taggedActivity(ctx: OrchestrationContext, name: string, input: unknown): ScheduledTask {
    const task = ctx.scheduleActivityTyped(name, input) as ScheduledTask & { withTag?: (tag: string) => ScheduledTask };
    if (typeof task.withTag !== "function") throw new Error("Workflow requests require Duroxide activity tag routing support.");
    return task.withTag(WORKFLOW_REQUEST_CAPABILITY);
}

function* storeTagged(ctx: OrchestrationContext, name: string, input: unknown): Generator<ScheduledTask, unknown, unknown> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return yield taggedActivity(ctx, name, input);
        } catch (error) {
            if (attempt >= WORKFLOW_STORE_RETRY_DELAYS_MS.length) throw error;
            yield ctx.scheduleTimer(WORKFLOW_STORE_RETRY_DELAYS_MS[attempt]);
        }
    }
}

function workflowErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(ACTIVITY_ERROR_PREFIX, "");
}

// The released 1.2.0 error projection was part of the durable schedule. Keep its redaction and clipping here, rather
// than importing mutable JSON, redaction or command helpers whose later releases must not change old histories.
const SECRET_NAME = "[A-Za-z0-9_]{0,40}(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|"
    + "client[_-]?secret|authorization|signature|credentials?|cookie)[A-Za-z0-9_-]{0,40}|sig|key|pass";
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@\x27"<>]+@/gi;
const URL_USERINFO_CUT = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@\x27"<>…:]*:[^\s/@\x27"<>…]*…/gi;
const AUTHORIZATION = /\b([A-Za-z0-9_-]{0,40}authorization[A-Za-z0-9_-]{0,40})(\s*[=:]\s*)("(?:[^"\\\r\n]|\\.)*"|\x27[^\x27\r\n]*\x27|[^\r\n]*)/gi;
const BEARER = /\b(Bearer)\s+(?:[^\s"\x27<>\\]{8,}|[^\s"\x27<>\\…]{1,7}(?=…))/gi;
const BASIC = /\b(Basic)\s+(?:[A-Za-z0-9+/=_-]{8,}|[A-Za-z0-9+/=_-]{1,7}(?=…))/gi;
const JSON_FIELD = new RegExp(`"(${SECRET_NAME})"(\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
const ESCAPED_JSON_FIELD = new RegExp(`\\\\"(${SECRET_NAME})\\\\"(\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\"`, "gi");
const JSON_FIELD_CUT = new RegExp(`"(${SECRET_NAME})"(\\s*:\\s*)"(?:[^"\\\\]|\\\\[\\s\\S])*\\\\?$`, "i");
const ESCAPED_JSON_FIELD_CUT = new RegExp(`\\\\"(${SECRET_NAME})\\\\"(\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\?$`, "i");
const KEY_VALUE = new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)(?!["\x27]?(?:[A-Za-z][A-Za-z0-9._-]{0,30}\\s+)?<hidden>)(?:"[^"]*"|\x27[^\x27]*\x27|[^\\s,;&\x27"<>)\\]}]+)`, "gi");

function hideAuthorization(match: string, name: string, separator: string, value: string): string {
    const quote = value.length >= 2 && (value[0] === "\"" || value[0] === "\x27") && value.endsWith(value[0]) ? value[0] : "";
    const inner = quote ? value.slice(1, -1) : value;
    if (inner.trim() === "") return match;
    const scheme = /^([A-Za-z][A-Za-z0-9._-]{0,30})\s+\S/.exec(inner);
    return `${name}${separator}${quote}${scheme ? `${scheme[1]} ` : ""}<hidden>${quote}`;
}

function redactWorkflowSecrets(text: string): string {
    if (typeof text !== "string" || text === "") return text;
    return text
        .replace(URL_USERINFO, "$1<hidden>@")
        .replace(URL_USERINFO_CUT, "$1<hidden>…")
        .replace(AUTHORIZATION, hideAuthorization)
        .replace(BEARER, "$1 <hidden>")
        .replace(BASIC, "$1 <hidden>")
        .replace(ESCAPED_JSON_FIELD, "\\\"$1\\\"$2\\\"<hidden>\\\"")
        .replace(JSON_FIELD, "\"$1\"$2\"<hidden>\"")
        .replace(ESCAPED_JSON_FIELD_CUT, (match, name: string, separator: string) => `\\"${name}\\"${separator}\\"<hidden>${match.endsWith("…") ? "…" : ""}`)
        .replace(JSON_FIELD_CUT, (match, name: string, separator: string) => `"${name}"${separator}"<hidden>${match.endsWith("…") ? "…" : ""}`)
        .replace(KEY_VALUE, (match, name: string, separator: string) => (/<hidden>["\x27]?$/.test(match) ? match : `${name}${separator}<hidden>`));
}

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function jsonbSafeText(text: string, maxChars?: number): string {
    let out = text.replace(/\u0000/g, "\uFFFD").replace(LONE_SURROGATES, "\uFFFD");
    if (maxChars !== undefined && out.length > maxChars) {
        let cut = maxChars;
        const last = out.charCodeAt(cut - 1);
        if (last >= 0xD800 && last <= 0xDBFF) cut -= 1;
        out = `${out.slice(0, cut)}…`;
    }
    return out;
}

function runtimeError(code: string, message: string): { outcome: string; resultKind: "runtime_error"; valueText: string; winner: "effect" } {
    return {
        outcome: code, resultKind: "runtime_error",
        valueText: JSON.stringify({ code, message: jsonbSafeText(redactWorkflowSecrets(message), 4_000) })!, winner: "effect",
    };
}

/**
 * The 1.2.0 Spawn effect starts a child Workflow once via workflow.spawnChild, then
 * records the handle/error and wakes the parent controller with the same retry policy.
 */
export function* workflowEffect_1_2_0(ctx: OrchestrationContext, rawInput: unknown): Generator<ScheduledTask, null, unknown> {
    const input = parseSpawnEffectInput(rawInput);
    let result: unknown;
    try {
        result = yield* storeTagged(ctx, WORKFLOW_ACTIVITIES.spawnChild, input);
    } catch (error) {
        result = { kind: "result", result: runtimeError("execution_failed", workflowErrorMessage(error)) };
    }
    yield* storeTagged(ctx, WORKFLOW_ACTIVITIES.recordEffectResult, { ...input, outcome: result });
    yield* storeTagged(ctx, WORKFLOW_ACTIVITIES.wake, input);
    return null;
}
