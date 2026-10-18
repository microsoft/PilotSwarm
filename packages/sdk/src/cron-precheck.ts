/**
 * Cron prechecks: application code that decides, before a scheduled `cron`
 * wake-up reaches the model, whether the wake-up has any work to do.
 *
 * A recurring agent that only polls ("is there a job? no, sleep") pays for a
 * full model turn on every empty cycle. Named prechecks come from worker code
 * (`PilotSwarmWorker.registerCronPrechecks`) or from an agent package, whose
 * `tools/worker-module.js` exports `createCronPrechecks()` beside its tools.
 * A schedule opts in by name: the agent definition binds a cron reason to a
 * precheck (`cronPrechecks` frontmatter), the agent calls
 * `cron(seconds, reason, precheck="<name>")`, or the session was created with
 * a default `cronPrecheck`. When that schedule fires, the precheck runs in an
 * activity and answers `run` or `skip`. The model never sees a skipped cycle:
 * the orchestration records the decision and re-arms the same schedule.
 *
 * A schedule without a precheck behaves exactly as before.
 *
 * Fail open: an unregistered name, a thrown or timed-out handler, or an
 * invalid answer all run the normal model turn. A registration with
 * `shadow: true` records its decisions but never skips.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SerializableSessionConfig } from "./types.js";

export type CronPrecheckMcpCaller = (
    server: string,
    tool: string,
    args?: Record<string, unknown>,
) => Promise<CallToolResult>;

export const CRON_PRECHECK_DEFAULT_TIMEOUT_MS = 10_000;
export const CRON_PRECHECK_MAX_TIMEOUT_MS = 60_000;
export const CRON_PRECHECK_NAME_MAX_CHARS = 100;
const CRON_PRECHECK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CRON_PRECHECK_DETAIL_MAX_CHARS = 500;

/** Wake-up facts and activity-scoped services; never serialized into history. */
export interface CronPrecheckContext {
    sessionId: string;
    /** The cron schedule's reason, exactly as the agent set it. */
    reason: string;
    intervalSeconds: number;
    /** Cycles this precheck skipped in a row since the schedule's last model turn. */
    consecutiveSkips: number;
    /** Aborted when the handler exceeds its timeout. */
    signal: AbortSignal;
    /** Call an authorized MCP tool without a model. Connections close after each call. */
    callMcpTool: CronPrecheckMcpCaller;
}

export interface CronPrecheckAnswer {
    /** `skip` asks PilotSwarm not to run the model for this cycle. */
    action: "run" | "skip";
    /** Short operator-facing explanation recorded on the event. */
    detail?: string;
}

export interface CronPrecheckRegistration {
    /** The name a schedule or session refers to. Letters, digits, `.`, `_`, `:`, `-`. */
    name: string;
    /**
     * Record decisions without skipping, to compare them with the turns that
     * ran before relying on the precheck. Default false.
     */
    shadow?: boolean;
    /** Handler timeout. Defaults to 10s; capped at 60s. A timeout runs the model turn. */
    timeoutMs?: number;
    /**
     * Force a model turn after this many consecutive skips, so an agent that
     * renews a lease or heartbeat in its turn still runs periodically.
     * Omitted: no limit.
     */
    maxConsecutiveSkips?: number;
    check: (context: CronPrecheckContext) => CronPrecheckAnswer | Promise<CronPrecheckAnswer>;
}

/** Activity input; the orchestration sends only serializable schedule facts. */
export interface CronPrecheckInput {
    sessionId: string;
    precheck: string;
    /** Set when the precheck comes from the agent package the session is bound to. */
    packageId?: string;
    reason: string;
    intervalSeconds: number;
    consecutiveSkips?: number;
    /** Only agent identity metadata, not prompts, model state or credentials. */
    agent?: Pick<SerializableSessionConfig, "boundAgentName" | "boundAgentPackageId" | "boundAgentSource" | "agentIdentity" | "toolNames">;
}

export type CronPrecheckOutcome =
    | "run"
    | "skip"
    | "unregistered"
    | "max_skips"
    | "error"
    | "timeout"
    | "invalid";

/** Activity result. The orchestration skips the model turn only when `skip` is true. */
export interface CronPrecheckResult {
    skip: boolean;
    outcome: CronPrecheckOutcome;
    precheck: string;
    shadow?: boolean;
}

/** A precheck name, trimmed, or null when it is not a valid name. */
export function normalizeCronPrecheckName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const name = value.trim();
    return name && name.length <= CRON_PRECHECK_NAME_MAX_CHARS && CRON_PRECHECK_NAME_PATTERN.test(name) ? name : null;
}

export function validateCronPrecheckRegistration(registration: CronPrecheckRegistration): CronPrecheckRegistration {
    if (!registration || typeof registration !== "object") throw new TypeError("Cron precheck registration must be an object");
    const name = normalizeCronPrecheckName(registration.name);
    if (!name) {
        throw new TypeError(`Cron precheck name must be 1-${CRON_PRECHECK_NAME_MAX_CHARS} characters of letters, digits, '.', '_', ':' or '-'`);
    }
    if (typeof registration.check !== "function") throw new TypeError(`Cron precheck "${name}" requires a check function`);
    if (registration.shadow !== undefined && typeof registration.shadow !== "boolean") {
        throw new TypeError(`Cron precheck "${name}" shadow must be a boolean`);
    }
    if (registration.timeoutMs !== undefined
        && (!Number.isInteger(registration.timeoutMs) || registration.timeoutMs < 1 || registration.timeoutMs > CRON_PRECHECK_MAX_TIMEOUT_MS)) {
        throw new TypeError(`Cron precheck "${name}" timeoutMs must be an integer from 1 to ${CRON_PRECHECK_MAX_TIMEOUT_MS}`);
    }
    if (registration.maxConsecutiveSkips !== undefined
        && (!Number.isInteger(registration.maxConsecutiveSkips) || registration.maxConsecutiveSkips < 1)) {
        throw new TypeError(`Cron precheck "${name}" maxConsecutiveSkips must be a positive integer`);
    }
    return { ...registration, name };
}

/**
 * Agent-definition binding: a cron schedule the agent arms whose reason
 * matches gets this precheck. Exactly one of `reason` (exact match) or
 * `reasonPrefix` is set.
 */
export interface CronPrecheckBinding {
    reason?: string;
    reasonPrefix?: string;
    precheck: string;
}

export const CRON_PRECHECK_MAX_BINDINGS = 20;

export function validateCronPrecheckBindings(value: unknown): CronPrecheckBinding[] {
    if (!Array.isArray(value)) throw new Error("cronPrechecks must be a list");
    if (value.length > CRON_PRECHECK_MAX_BINDINGS) throw new Error(`cronPrechecks allows at most ${CRON_PRECHECK_MAX_BINDINGS} entries`);
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object") throw new Error(`cronPrechecks entry ${index + 1} must be a mapping`);
        const unknown = Object.keys(entry).filter((key) => !["reason", "reasonPrefix", "precheck"].includes(key));
        if (unknown.length > 0) throw new Error(`cronPrechecks entry ${index + 1} has unknown field ${unknown[0]}`);
        const precheck = normalizeCronPrecheckName((entry as any).precheck);
        if (!precheck) throw new Error(`cronPrechecks entry ${index + 1} needs a valid precheck name`);
        const reason = typeof (entry as any).reason === "string" ? (entry as any).reason.trim() : "";
        const reasonPrefix = typeof (entry as any).reasonPrefix === "string" ? (entry as any).reasonPrefix.trim() : "";
        if (Boolean(reason) === Boolean(reasonPrefix)) {
            throw new Error(`cronPrechecks entry ${index + 1} needs exactly one of reason or reasonPrefix`);
        }
        return reason ? { reason, precheck } : { reasonPrefix, precheck };
    });
}

/** What the cron tool may attach: worker-registered names, plus the bound agent package's prechecks and bindings. */
export interface CronPrecheckSources {
    staticNames: string[];
    packageId?: string;
    packageNames?: string[];
    bindings?: CronPrecheckBinding[];
}

export type CronPrecheckChoice =
    | { ok: true; precheck?: string; packageId?: string }
    | { ok: false; error: string };

/**
 * Choose a cron schedule's precheck. An explicit name must be available; an
 * agent binding matching the reason comes next, then the session default.
 * A worker-registered name wins over a same-named package precheck, like
 * tools. A binding or default whose name is not available is kept, so the
 * fire records it as unregistered and runs the model turn.
 */
export function chooseCronPrecheck(params: {
    explicit?: unknown;
    reason: string;
    sessionDefault?: unknown;
    sources?: CronPrecheckSources | null;
}): CronPrecheckChoice {
    const sources = params.sources ?? { staticNames: [] };
    const lookup = (name: string): { precheck: string; packageId?: string } | null => {
        if (sources.staticNames.includes(name)) return { precheck: name };
        if (sources.packageId && sources.packageNames?.includes(name)) return { precheck: name, packageId: sources.packageId };
        return null;
    };
    if (params.explicit !== undefined && params.explicit !== null && String(params.explicit).trim() !== "") {
        const named = normalizeCronPrecheckName(params.explicit);
        const found = named ? lookup(named) : null;
        if (found) return { ok: true, ...found };
        const available = [...new Set([...sources.staticNames, ...(sources.packageNames ?? [])])];
        return {
            ok: false,
            error: available.length > 0
                ? `Error: unknown cron precheck "${String(params.explicit)}". Available prechecks: ${available.join(", ")}.`
                : `Error: unknown cron precheck "${String(params.explicit)}". No cron prechecks are available to this session; omit precheck.`,
        };
    }
    const binding = (sources.bindings ?? []).find((entry) => entry.reason !== undefined
        ? params.reason === entry.reason
        : params.reason.startsWith(entry.reasonPrefix ?? "\u0000"));
    if (binding) {
        return { ok: true, ...(lookup(binding.precheck)
            ?? { precheck: binding.precheck, ...(sources.packageId ? { packageId: sources.packageId } : {}) }) };
    }
    const defaulted = normalizeCronPrecheckName(params.sessionDefault);
    if (defaulted) return { ok: true, ...(lookup(defaulted) ?? { precheck: defaulted }) };
    return { ok: true };
}

export interface CronPrecheckEvaluation {
    result: CronPrecheckResult;
    /** Payload of the `session.cron_precheck` event. */
    event: Record<string, unknown>;
}

/**
 * Evaluate the named precheck for one cron wake-up. Never throws: every
 * failure becomes a recorded `run`.
 */
export async function evaluateCronPrecheck(params: {
    registrations: readonly CronPrecheckRegistration[];
    input: CronPrecheckInput;
    now?: () => number;
    callMcpTool?: (signal: AbortSignal, server: string, tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
}): Promise<CronPrecheckEvaluation> {
    const { registrations, input } = params;
    const now = params.now ?? Date.now;
    const name = String(input.precheck ?? "");
    const consecutiveSkips = Number.isInteger(input.consecutiveSkips) && input.consecutiveSkips! > 0 ? input.consecutiveSkips! : 0;
    const registration = registrations.find((entry) => entry.name === name);
    if (!registration) {
        return {
            result: { skip: false, outcome: "unregistered", precheck: name },
            event: { precheck: name, outcome: "unregistered", skipped: false, consecutiveSkips, durationMs: 0 },
        };
    }

    const shadow = registration.shadow === true;
    const base = { precheck: name, shadow, consecutiveSkips };

    if (registration.maxConsecutiveSkips !== undefined && consecutiveSkips >= registration.maxConsecutiveSkips) {
        return {
            result: { skip: false, outcome: "max_skips", precheck: name, shadow },
            event: { ...base, outcome: "max_skips", skipped: false, durationMs: 0 },
        };
    }

    const timeoutMs = registration.timeoutMs ?? CRON_PRECHECK_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: CronPrecheckOutcome;
    let detail: string | undefined;
    let pendingMcpCalls = 0;
    let mcpCallFailed = false;
    try {
        const answer = await Promise.race([
            Promise.resolve().then(() => registration.check({
                sessionId: input.sessionId,
                reason: input.reason,
                intervalSeconds: input.intervalSeconds,
                consecutiveSkips,
                signal: controller.signal,
                callMcpTool: (server, tool, args) => {
                    controller.signal.throwIfAborted();
                    const callMcpTool = params.callMcpTool;
                    if (!callMcpTool) {
                        mcpCallFailed = true;
                        throw new Error("MCP access is unavailable for this cron precheck");
                    }
                    pendingMcpCalls++;
                    const call = Promise.resolve().then(() => {
                        controller.signal.throwIfAborted();
                        return callMcpTool(controller.signal, server, tool, args);
                    });
                    // Observe even an unawaited rejection; the decision below
                    // fails open instead of trusting a swallowed tool failure.
                    void call.then(
                        () => { pendingMcpCalls--; },
                        () => { pendingMcpCalls--; mcpCallFailed = true; },
                    );
                    return call;
                },
            })),
            new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), timeoutMs);
            }),
        ]);
        if (answer === "timeout") {
            controller.abort();
            outcome = "timeout";
        } else if (pendingMcpCalls > 0 || mcpCallFailed) {
            outcome = "error";
            detail = pendingMcpCalls > 0
                ? "Cron precheck returned before its MCP calls completed"
                : "Cron precheck MCP call failed; run the normal cycle";
        } else if (answer && (answer.action === "run" || answer.action === "skip")) {
            outcome = answer.action;
            if (typeof answer.detail === "string" && answer.detail) detail = answer.detail.slice(0, CRON_PRECHECK_DETAIL_MAX_CHARS);
        } else {
            outcome = "invalid";
        }
    } catch (err) {
        outcome = "error";
        detail = String((err as Error)?.message ?? err).slice(0, CRON_PRECHECK_DETAIL_MAX_CHARS);
    } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
    }

    const skipped = outcome === "skip" && !shadow;
    return {
        result: { skip: skipped, outcome, precheck: name, shadow },
        event: {
            ...base,
            outcome,
            skipped,
            durationMs: Math.max(0, now() - startedAt),
            ...(detail ? { detail } : {}),
        },
    };
}
