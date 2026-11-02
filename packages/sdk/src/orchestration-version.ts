/**
 * Shared durable-session orchestration version constants.
 *
 * The latest version is the canonical target for new starts and every
 * continue-as-new handoff. Frozen orchestration files keep their own
 * CURRENT_ORCHESTRATION_VERSION for replay/tracing, but must not hard-code
 * the latest target themselves.
 *
 * The compatibility floor documents the oldest orchestration input wire
 * format that the latest handler must continue to normalize while that
 * version remains registered in the repo.
 *
 * @internal
 */
export const DURABLE_SESSION_LATEST_VERSION = "1.0.83";
export const DURABLE_SESSION_COMPATIBILITY_FLOOR_VERSION = "1.0.47";

/**
 * Session workspaces: the first orchestration version that applies the
 * results of set_session_workspace and the spawn `workspace` parameter.
 */
export const WORKSPACE_ORCHESTRATION_MIN_VERSION = "1.0.80";

/**
 * Compute providers: the first orchestration version that knows a session
 * can run its agent somewhere other than the worker.
 *
 * The routing tag that keeps a remote session's turns away from workers
 * that cannot drive one is chosen inside the orchestration, so a worker
 * running an older version of the orchestration itself would not choose
 * it — and would then run the turn as its own child process, beside the
 * CMS and the model keys. An old worker does not register this version at
 * all, so during a rolling deploy, or after a rollback, it cannot run any
 * step of a compute session: those sessions wait for a worker that can.
 *
 * The routing tag and the worker's own refusal to start a local runtime
 * for a session recorded as remote both stay, as the two layers behind
 * this one.
 */
export const COMPUTE_ORCHESTRATION_MIN_VERSION = "1.0.83";

/**
 * Whether an orchestration version is at least `minimum`. Unreadable or
 * absent counts as older: a gate opened by not knowing is not a gate.
 */
export function orchestrationVersionAtLeast(version: unknown, minimum: string): boolean {
    const parts = (text: unknown) => {
        const match = typeof text === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim()) : null;
        return match ? match.slice(1).map(Number) : null;
    };
    const have = parts(version);
    const need = parts(minimum);
    if (!have || !need) return false;
    for (let i = 0; i < 3; i += 1) {
        if (have[i] !== need[i]) return have[i] > need[i];
    }
    return true;
}

/**
 * Compute providers: whether the orchestration that is running knows a
 * session can run its agent elsewhere. Only the versions that do may
 * choose the compute routing tag; an older one would schedule the turn
 * without it, and a worker that cannot drive a remote runtime would then
 * take it.
 */
export function orchestrationSupportsCompute(version: unknown): boolean {
    return orchestrationVersionAtLeast(version, COMPUTE_ORCHESTRATION_MIN_VERSION);
}
