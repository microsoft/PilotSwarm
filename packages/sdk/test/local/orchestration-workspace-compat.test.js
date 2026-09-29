/**
 * Session workspaces, test C2 (docs/proposals/session-workspaces.md, 4.9):
 * for a session without a workspace, the frozen 1.0.79 handler and the
 * 1.0.80 handler yield the same activities, timers and races, segment by
 * segment across continue-as-new.
 *
 * One scripted world drives both: the same input, the same turn results
 * (a wait, a cron, a child spawn, then done), the same queued prompt, and
 * every timer fires, so the run passes through the wait timer, the cron
 * fire, the child spawn and the idle-hold release. The world answers
 * spawnChildSession and computeCronAtNextFire.
 *
 * Run: npx vitest run test/local/orchestration-workspace-compat.test.js
 */
import { describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

async function loadHandler(version) {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    const fileVersion = version.replace(/\./g, "_");
    if (version === DURABLE_SESSION_LATEST_VERSION) {
        return (await import("../../src/orchestration.ts"))[`durableSessionOrchestration_${fileVersion}`];
    }
    return (await import(`../../src/orchestration_${fileVersion}/index.ts`))[`durableSessionOrchestration_${fileVersion}`];
}

/** A deterministic world. `sequence` collects what the handler yields, per segment. */
function makeWorld({ turnResults, queue, maxTimers = 16 }) {
    const script = [...turnResults];
    // Each queued message is deliverable once `afterTurns` turns have run.
    const staged = queue.map((entry) => (typeof entry === "string" ? { afterTurns: 0, msg: entry } : entry));
    let turnsRun = 0;
    const pending = {
        get length() { return staged.filter((e) => e.afterTurns <= turnsRun).length; },
        shift() {
            const ix = staged.findIndex((e) => e.afterTurns <= turnsRun);
            return ix < 0 ? undefined : staged.splice(ix, 1)[0].msg;
        },
    };
    const kv = new Map();
    const segments = [[]];
    const record = (entry) => segments.at(-1).push(entry);
    let now = 1_750_000_000_000;
    let guid = 0;
    let timersFired = 0;
    const effectProxy = (prefix) => new Proxy({}, {
        get: (_t, prop) => (...args) => ({ effect: `${prefix}.${String(prop)}`, args }),
    });
    mockSession = effectProxy("session");
    mockManager = effectProxy("manager");

    const ctx = {
        traceInfo: () => {},
        setCustomStatus: () => {},
        getValue: (k) => (kv.has(k) ? kv.get(k) : null),
        setValue: (k, v) => kv.set(k, v),
        clearValue: (k) => kv.delete(k),
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
        dequeueEvent: (name) => ({ effect: "dequeueEvent", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
    };
    const describe = (side) => (side?.effect === "scheduleTimer" ? `timer(${side.ms})`
        : side?.effect === "dequeueEvent" ? `dequeue(${side.name ?? ""})`
            : side?.effect === "session.runTurn" ? "runTurn" : String(side?.effect));

    const resolve = (effect) => {
        if (!effect || typeof effect !== "object") return undefined;
        switch (effect.effect) {
            case "utcNow": return now;
            case "newGuid": return `00000000-0000-0000-0000-${String(++guid).padStart(12, "0")}`;
            case "dequeueEvent": {
                record(`dequeue(${effect.name ?? ""})`);
                if (pending.length === 0) throw new Error("dequeue underflow");
                return pending.shift();
            }
            case "scheduleTimer": {
                record(`timer(${effect.ms})`);
                now += effect.ms;
                return undefined;
            }
            case "race": {
                const sides = [effect.left, effect.right];
                record(`race[${sides.map(describe).join(" | ")}]`);
                const turnIx = sides.findIndex((s) => s?.effect === "session.runTurn");
                if (turnIx >= 0) {
                    turnsRun += 1;
                    const [prompt, bootstrap, turnIndex, opts] = sides[turnIx].args;
                    record(`runTurn(${JSON.stringify({ prompt, bootstrap: Boolean(bootstrap), turnIndex, opts: opts ?? {} })})`);
                    return { index: turnIx, value: script.shift() ?? { type: "completed", content: "idle" } };
                }
                const dequeueIx = sides.findIndex((s) => s?.effect === "dequeueEvent");
                if (dequeueIx >= 0 && pending.length > 0) return { index: dequeueIx, value: pending.shift() };
                const timerIx = sides.findIndex((s) => s?.effect === "scheduleTimer");
                if (timerIx >= 0 && (sides[timerIx].ms <= 1000 || timersFired < maxTimers)) {
                    if (sides[timerIx].ms > 1000) timersFired += 1;
                    now += sides[timerIx].ms;
                    return { index: timerIx };
                }
                return { effect: "PARKED" };
            }
            default: {
                record(`${effect.effect}(${JSON.stringify(effect.args ?? [])})`);
                switch (effect.effect) {
                    case "manager.spawnChildSession": return "child-session-1";
                    case "manager.computeCronAtNextFire": return now + 60_000;
                    case "manager.getWorkerSessionPolicy": return { policy: null, allowedAgentNames: [] };
                    case "manager.resolveAgentConfig": return null;
                    case "manager.listModels": return [];
                    case "manager.getOrchestrationStats": return { historySizeBytes: 0 };
                    default: return undefined;
                }
            }
        }
    };

    /** Drive one execution until it continues as new, parks, or returns. */
    function driveSegment(gen, maxSteps = 2000) {
        let input;
        for (let i = 0; i < maxSteps; i += 1) {
            const next = gen.next(input);
            if (next.done) return { kind: "return" };
            const effect = next.value;
            if (effect?.effect === "continueAsNew") {
                record("continueAsNew");
                return { kind: "continueAsNew", input: effect.input };
            }
            if (effect?.effect === "dequeueEvent" && pending.length === 0) return { kind: "blocked" };
            input = resolve(effect);
            if (input?.effect === "PARKED") return { kind: "parked" };
        }
        throw new Error("drive exceeded step limit");
    }

    return { ctx, segments, driveSegment, newSegment: () => segments.push([]) };
}

/** Everything a handler yields for one scripted run, segment by segment. */
async function run(version, maxSegments = 8) {
    const handler = await loadHandler(version);
    const world = makeWorld({
        // As ManagedSession reports them: the cron tool's action rides on a
        // completed turn in queuedActions.
        turnResults: [
            { type: "wait", seconds: 120, reason: "wait for the build" },
            { type: "completed", content: "polling", queuedActions: [{ type: "cron", action: "set", intervalSeconds: 600, reason: "poll the build" }] },
            { type: "spawn_agent", task: "check the logs" },
            { type: "completed", content: "child started" },
            { type: "completed", content: "all done", queuedActions: [{ type: "cron", action: "cancel" }] },
        ],
        queue: [
            JSON.stringify({ prompt: "start the build and watch it" }),
            // Once the work is done and idle: a model switch, which continues as new.
            { afterTurns: 5, msg: JSON.stringify({ type: "cmd", cmd: "set_model", id: "switch-1", args: { model: "fixture:model-2" } }) },
        ],
    });
    let input = {
        sessionId: "compat-session",
        config: { model: "fixture:model" },
        iteration: 0,
        isSystem: false,
        blobEnabled: true,
    };
    const outcomes = [];
    const canInputs = [];
    for (let segment = 0; segment < maxSegments; segment += 1) {
        const outcome = world.driveSegment(handler(world.ctx, input));
        outcomes.push(outcome.kind);
        if (outcome.kind !== "continueAsNew") break;
        const { sourceOrchestrationVersion: _source, ...comparable } = outcome.input;
        canInputs.push(comparable);
        input = outcome.input;
        world.newSegment();
    }
    return { segments: world.segments, outcomes, canInputs };
}

describe("sessions without a workspace (C2)", () => {
    it("1.0.79 and 1.0.80 yield the same activities, timers and races, segment by segment", async () => {
        const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
        expect(DURABLE_SESSION_LATEST_VERSION).toBe("1.0.80");
        const frozen = await run("1.0.79");
        const latest = await run("1.0.80");

        // The run covers what C2 names: the wait timer, the cron, the child
        // spawn, the idle release, and at least one continue-as-new.
        const all = latest.segments.flat().join("\n");
        expect(all).toContain("timer(120000)");
        expect(all).toContain("manager.spawnChildSession(");
        expect(all).toMatch(/runTurn\(.*The 120 second wait is now complete/);
        expect(all).toContain("session.cron_started");
        expect(all).toMatch(/runTurn\(.*Scheduled cron wake-up for/);
        // The idle-hold release, the one place 1.0.80 adds a step for a
        // workspace session (T11).
        expect(all).toMatch(/manager\.recordSessionEvent\(.*"session\.affinity_released".*"reason":"idle"/);
        expect(latest.outcomes.filter((k) => k === "continueAsNew").length).toBeGreaterThan(0);
        expect(latest.segments.at(-1).join("\n")).toMatch(/runTurn\(.*Continue on fixture:model-2\./);

        expect(latest.outcomes).toEqual(frozen.outcomes);
        expect(latest.segments.length).toBe(frozen.segments.length);
        latest.segments.forEach((segment, index) => {
            expect(segment, `segment ${index}`).toEqual(frozen.segments[index]);
        });
        expect(latest.canInputs).toEqual(frozen.canInputs);
    });
});
