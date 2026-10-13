/**
 * Named fault points for crash-timing tests (session lifecycle protocol §4.4).
 *
 * A fault point is a no-op unless `PILOTSWARM_FAULT_INJECT` names it. The env
 * var is a comma-separated list of `<point>[:<action>[:<afterHits>]]` entries:
 *
 *   PILOTSWARM_FAULT_INJECT="turn.commit.after-cas"          → exit(137) on 1st hit
 *   PILOTSWARM_FAULT_INJECT="turn.commit.before-cas:throw"   → throw on 1st hit
 *   PILOTSWARM_FAULT_INJECT="turn.commit.after-cas:exit:2"   → exit(137) on 2nd hit
 *
 * `log` only prints the hit line and continues (an observation probe for
 * timing tests, for example whether an activity cancellation reached JS).
 *
 * `exit` (the default action) simulates a hard worker crash — the process
 * dies exactly at the protocol boundary, duroxide's activity retry takes it
 * from there. `throw` simulates a transient failure surfaced to the caller.
 * `afterHits` (1-based, default 1) fires the fault on the Nth time the point
 * is reached in this process — letting a scenario run N−1 healthy turns
 * before the crash.
 *
 * Points are deterministic code locations, never timers. In production the
 * env var is unset and every call is a cheap string check.
 *
 * Session-scoped holds (turn control tests): `faultPointAsync(name, { sessionId })`
 * also honours `<point>:hold@<sessionId>[:<afterHits>]` entries and holds armed
 * with `armFaultHold(point, sessionId)`. A held point waits until the file
 * `$PILOTSWARM_FAULT_RELEASE_DIR/<point>.<sessionId>` exists (it first writes
 * `<point>.<sessionId>.held`, so a test knows the hold was reached), polling every
 * 50 ms, and throws after 120 s (`PILOTSWARM_FAULT_HOLD_MAX_MS` overrides). Only the named session blocks; hit counts
 * are kept per (point, session), so concurrent tests do not interfere.
 *
 * @internal
 */
const hitCounts = new Map<string, number>();

export function faultPoint(name: string): void {
    const spec = process.env.PILOTSWARM_FAULT_INJECT;
    if (!spec) return;
    for (const entry of spec.split(",")) {
        const [point, action = "exit", afterHitsRaw] = entry.trim().split(":");
        if (point !== name) continue;
        // Session-scoped holds belong to faultPointAsync.
        if (action.startsWith("hold@")) continue;
        const hits = (hitCounts.get(name) ?? 0) + 1;
        hitCounts.set(name, hits);
        const fireAt = Number.parseInt(afterHitsRaw ?? "1", 10) || 1;
        if (hits < fireAt) return;
        // eslint-disable-next-line no-console
        console.error(`[fault-injection] hit point=${name} action=${action} hit=${hits}/${fireAt}`);
        if (action === "log") return;
        if (action === "throw") {
            throw new Error(`fault-injection: ${name}`);
        }
        process.exit(137);
    }
}

const DEFAULT_HOLD_BOUND_MS = 120_000;
const HOLD_POLL_MS = 50;
const holdHitCounts = new Map<string, number>();
const armedHolds = new Map<string, number>();

function holdKey(point: string, sessionId: string): string {
    return `${point}\u0000${sessionId}`;
}

/** Test-only: hold `point` for `sessionId` on its `afterHits`-th hit (default 1). */
export function armFaultHold(point: string, sessionId: string, afterHits = 1): void {
    armedHolds.set(holdKey(point, sessionId), afterHits);
}

/** Test-only: forget armed holds and hold hit counts. */
export function resetFaultHolds(): void {
    armedHolds.clear();
    holdHitCounts.clear();
}

function holdFireAt(point: string, sessionId: string): number | undefined {
    const armed = armedHolds.get(holdKey(point, sessionId));
    if (armed !== undefined) return armed;
    const spec = process.env.PILOTSWARM_FAULT_INJECT;
    if (!spec) return undefined;
    for (const entry of spec.split(",")) {
        const [entryPoint, action, afterHitsRaw] = entry.trim().split(":");
        if (entryPoint !== point || !action?.startsWith("hold@")) continue;
        if (action.slice("hold@".length) !== sessionId) continue;
        return Number.parseInt(afterHitsRaw ?? "1", 10) || 1;
    }
    return undefined;
}

/**
 * Async fault point. Runs every `faultPoint` action for `name`, then, when a
 * hold is armed for `opts.sessionId`, waits for its release file.
 */
export async function faultPointAsync(name: string, opts: { sessionId?: string } = {}): Promise<void> {
    faultPoint(name);
    const sessionId = opts.sessionId;
    if (!sessionId) return;
    if (armedHolds.size === 0 && !process.env.PILOTSWARM_FAULT_INJECT) return;
    const fireAt = holdFireAt(name, sessionId);
    if (fireAt === undefined) return;
    const key = holdKey(name, sessionId);
    const hits = (holdHitCounts.get(key) ?? 0) + 1;
    holdHitCounts.set(key, hits);
    if (hits !== fireAt) return;
    const dir = process.env.PILOTSWARM_FAULT_RELEASE_DIR;
    if (!dir) throw new Error(`fault-injection: hold ${name} for ${sessionId} needs PILOTSWARM_FAULT_RELEASE_DIR`);
    const { existsSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const releaseFile = join(dir, `${name}.${sessionId}`);
    // Tests wait for this marker before acting, so they know the hold was reached.
    writeFileSync(`${releaseFile}.held`, "");
    // eslint-disable-next-line no-console
    console.error(`[fault-injection] hold point=${name} session=${sessionId} hit=${hits}`);
    const bound = Number.parseInt(process.env.PILOTSWARM_FAULT_HOLD_MAX_MS ?? "", 10) || DEFAULT_HOLD_BOUND_MS;
    const deadline = Date.now() + bound;
    while (!existsSync(releaseFile)) {
        if (Date.now() >= deadline) throw new Error(`fault-injection: hold ${name} for ${sessionId} was not released within ${bound} ms`);
        await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
    }
}
