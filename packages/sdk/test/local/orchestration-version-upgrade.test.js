import { beforeEach, describe, expect, it, vi } from "vitest";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

function createCtx(values, queue = [], turns = [], calls = []) {
    const queuedEvents = [...queue];
    return {
        traceInfo: () => {},
        setCustomStatus: () => {},
        getValue: (key) => (values.has(key) ? values.get(key) : null),
        setValue: (key, value) => values.set(key, value),
        clearValue: (key) => values.delete(key),
        utcNow: () => ({ effect: "utcNow" }),
        dequeueEvent: () => ({ effect: "dequeueEvent" }),
        scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
        newGuid: () => ({ effect: "newGuid" }),
        hasQueuedEvents: () => queuedEvents.length > 0,
        resolveEffect(effect) {
            if (!effect) return undefined;
            switch (effect.effect) {
                case "session.runTurn":
                    turns.push(effect.args);
                    return { type: "completed", content: "ok" };
                case "utcNow":
                    return 1_713_083_589_000;
                case "dequeueEvent":
                    if (queuedEvents.length === 0) {
                        throw new Error("Queue underflow while resolving dequeueEvent");
                    }
                    return queuedEvents.shift();
                case "recordSessionEvent":
                case "checkpoint":
                case "hydrate":
                case "dehydrate":
                case "destroy":
                    return undefined;
                case "race": {
                    // Newer handlers race the message queue against a short
                    // poll timer: a queued message wins, otherwise the poll fires.
                    const sides = [effect.left, effect.right];
                    // A turn the handler runs (1.0.79 carries "Continue on <model>.") completes.
                    const turnIx = sides.findIndex((side) => side?.effect === "session.runTurn");
                    if (turnIx >= 0) {
                        turns.push(sides[turnIx].args);
                        return { index: turnIx, value: { type: "completed", content: "ok" } };
                    }
                    const dequeueIx = sides.findIndex((side) => side?.effect === "dequeueEvent");
                    if (dequeueIx >= 0 && queuedEvents.length > 0) return { index: dequeueIx, value: queuedEvents.shift() };
                    const timerIx = sides.findIndex((side) => side?.effect === "scheduleTimer" && side.ms <= 1000);
                    if (timerIx >= 0) return { index: timerIx };
                    throw new Error(`Unexpected race in version upgrade test harness: ${JSON.stringify(sides)}`);
                }
                default:
                    // Newer handlers call more manager and session methods
                    // (see the proxies in beforeEach); none of them matter here.
                    if (/^(manager|session)\./.test(String(effect.effect))) {
                        calls.push(String(effect.effect));
                        return undefined;
                    }
                    throw new Error(`Unexpected effect: ${JSON.stringify(effect)}`);
            }
        },
    };
}

async function loadHandler(version) {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    if (version === DURABLE_SESSION_LATEST_VERSION) {
        const mod = await import("../../src/orchestration.ts");
        const fileVersion = version.replace(/\./g, "_");
        return mod[`durableSessionOrchestration_${fileVersion}`];
    }
    const fileVersion = version.replace(/\./g, "_");
    // Frozen versions are a single file (older) or a folder (1.0.79 and later).
    const mod = await import(`../../src/orchestration_${fileVersion}.ts`)
        .catch(() => import(`../../src/orchestration_${fileVersion}/index.ts`));
    return mod[`durableSessionOrchestration_${fileVersion}`];
}

function driveUntilStop(gen, ctx) {
    let input;
    for (let step = 0; step < 100; step += 1) {
        const next = gen.next(input);
        if (next.done) return { done: true, value: next.value };
        if (next.value?.effect === "continueAsNew") return { done: false, effect: next.value };
        if (next.value?.effect === "dequeueEvent" && !ctx.hasQueuedEvents()) {
            return { done: false, effect: next.value };
        }
        input = ctx.resolveEffect(next.value);
    }
    throw new Error("Exceeded step limit before stop condition");
}

// Drive until the handler parks: a continue-as-new, a blocking dequeue with an
// empty queue, or a race whose only exit is a long timer (an armed schedule).
function driveUntilParked(gen, ctx) {
    let input;
    for (let step = 0; step < 400; step += 1) {
        const next = gen.next(input);
        if (next.done) return { done: true, value: next.value };
        const effect = next.value;
        if (effect?.effect === "continueAsNew") return { done: false, effect };
        if (effect?.effect === "dequeueEvent" && !ctx.hasQueuedEvents()) return { done: false, effect };
        if (effect?.effect === "race" && !ctx.hasQueuedEvents()) {
            const sides = [effect.left, effect.right];
            const long = sides.find((side) => side?.effect === "scheduleTimer" && side.ms > 1000);
            if (long && !sides.some((side) => side?.effect === "session.runTurn")) {
                return { done: false, effect, parkedOnTimerMs: long.ms };
            }
        }
        input = ctx.resolveEffect(effect);
    }
    throw new Error("Exceeded step limit before the handler parked");
}

function inheritedFifo(values) {
    // A 1.0.81 session stuck as in issue 192: two cron fires queued ahead of two prompts.
    const cronFire = {
        kind: "timer",
        timer: { type: "cron", deadlineMs: 1_713_083_000_000, originalDurationMs: 3_600_000, reason: "hourly" },
        firedAtMs: 1_713_083_000_000,
    };
    values.set("fifo.0", JSON.stringify([
        cronFire,
        cronFire,
        { kind: "prompt", prompt: "P1", bootstrap: false },
        { kind: "prompt", prompt: "P2", bootstrap: false, clientMessageIds: ["p2"] },
    ]));
}

function readFifo(values) {
    const items = [];
    for (let i = 0; i < 20; i += 1) {
        const raw = values.get(`fifo.${i}`);
        if (raw) items.push(...JSON.parse(raw));
    }
    return items;
}

describe("orchestration version upgrades", () => {
    beforeEach(() => {
        // Any other method answers with an effect named after it.
        const answerAny = (target, prefix) => new Proxy(target, {
            get: (object, prop) => (prop in object ? object[prop] : (...args) => ({ effect: `${prefix}.${String(prop)}`, args })),
        });
        mockSession = answerAny({
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            hydrate: vi.fn(() => ({ effect: "hydrate" })),
            dehydrate: vi.fn(() => ({ effect: "dehydrate" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        }, "session");
        mockManager = answerAny({
            recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
        }, "manager");
    });

    // 1.0.79 is the version frozen when session workspaces opened 1.0.80
    // (test C4): its sessions carry no config.workspace into 1.0.80.
    for (const sourceVersion of ["1.0.40", "1.0.41", "1.0.42", "1.0.79", "1.0.80", "1.0.81", "1.0.82"]) {
        it(`upgrades ${sourceVersion} snapshots into the latest orchestration`, async () => {
            const values = new Map();
            const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
            const { commandResponseKey } = await import("../../src/types.ts");
            const sourceHandler = await loadHandler(sourceVersion);
            const latestHandler = await loadHandler(DURABLE_SESSION_LATEST_VERSION);

            const sourceCtx = createCtx(values, [
                JSON.stringify({
                    type: "cmd",
                    cmd: "set_model",
                    id: `set-model-${sourceVersion}`,
                    args: { model: "github-copilot:gpt-5.4-mini" },
                }),
            ]);

            // 1.0.79 starts mid-life, so the turn index must survive into 1.0.80 (T4).
            const startIteration = sourceVersion === "1.0.79" ? 5 : 0;
            const sourceGen = sourceHandler(sourceCtx, {
                sessionId: `upgrade-${sourceVersion}`,
                config: { model: "github-copilot:gpt-5.4" },
                sourceOrchestrationVersion: sourceVersion,
                iteration: startIteration,
                isSystem: true,
                blobEnabled: false,
            });

            const sourceResult = driveUntilStop(sourceGen, sourceCtx);
            expect(sourceResult.done).toBe(false);
            expect(sourceResult.effect).toMatchObject({
                effect: "continueAsNew",
                version: DURABLE_SESSION_LATEST_VERSION,
            });
            expect(sourceResult.effect.input.sourceOrchestrationVersion).toBe(sourceVersion);
            expect(sourceResult.effect.input.config.model).toBe("github-copilot:gpt-5.4-mini");

            expect(sourceResult.effect.input.iteration).toBe(startIteration);

            const latestTurns = [];
            const latestCalls = [];
            const latestCtx = createCtx(values, [
                JSON.stringify({
                    type: "cmd",
                    cmd: "get_info",
                    id: `get-info-${sourceVersion}`,
                }),
            ], latestTurns, latestCalls);

            const latestGen = latestHandler(latestCtx, sourceResult.effect.input);
            const latestResult = driveUntilStop(latestGen, latestCtx);

            expect(mockManager.recordSessionEvent).toHaveBeenCalledWith(
                `upgrade-${sourceVersion}`,
                [{ eventType: "session.command_received", data: { cmd: "get_info", id: `get-info-${sourceVersion}` } }],
            );
            const response = JSON.parse(values.get(commandResponseKey(`get-info-${sourceVersion}`)));
            expect(response).toMatchObject({
                cmd: "get_info",
                id: `get-info-${sourceVersion}`,
                result: {
                    sessionId: `upgrade-${sourceVersion}`,
                    model: "github-copilot:gpt-5.4-mini",
                },
            });
            expect(latestResult.done).toBe(false);
            // Test C4: a session from before workspaces makes no workspace call in 1.0.80.
            expect(latestCalls.filter((call) => /workspace/i.test(call))).toEqual([]);
            if (sourceVersion === "1.0.79") {
                // 1.0.79 asks for one turn on the new model; 1.0.80 runs it
                // at the carried turn index, with no workspace fields on the wire.
                expect(latestTurns).toHaveLength(1);
                expect(latestTurns[0][0]).toMatch(/^Continue on github-copilot:gpt-5\.4-mini\./);
                expect(latestTurns[0][2]).toBe(5);
                const turnMeta = latestTurns[0][3] ?? {};
                expect("workspaceRevision" in turnMeta || "workspaceNotice" in turnMeta).toBe(false);
            }
        });
    }

    const inheritedInput = (sessionId) => ({
        sessionId,
        config: { model: "github-copilot:gpt-5.4" },
        sourceOrchestrationVersion: "1.0.81",
        iteration: 3,
        isSystem: true,
        blobEnabled: false,
        cronSchedule: { intervalSeconds: 3600, reason: "hourly" },
    });

    it("issue 192 positive control: on 1.0.81 an inherited [timer, timer, P1, P2] FIFO runs P1 alone and leaves P2 behind the hourly cron", async () => {
        const values = new Map();
        inheritedFifo(values);
        const turns = [];
        const ctx = createCtx(values, [], turns);
        const handler = await loadHandler("1.0.81");
        const result = driveUntilParked(handler(ctx, inheritedInput("fifo-1.0.81")), ctx);
        // Defect B: the timer item at the head stops the merge, so P1 runs alone.
        expect(turns).toHaveLength(1);
        expect(turns[0][0]).toMatch(/P1/);
        expect(turns[0][0]).not.toMatch(/P2/);
        // Defect A: the turn armed the hourly cron, and P2 waits behind it.
        expect(result.parkedOnTimerMs).toBe(3_600_000);
        expect(readFifo(values).filter((item) => item.kind === "prompt").map((item) => item.prompt)).toEqual(["P2"]);
    });

    it("R9: 1.0.82 drains an inherited 1.0.81 FIFO [timer, timer, P1, P2] in two turns, then waits on the cron", async () => {
        const values = new Map();
        inheritedFifo(values);
        const turns = [];
        const ctx = createCtx(values, [], turns);
        // 1.0.82 is frozen since 1.0.83 opened; its sessions still drain this way until their continue-as-new.
        const handler = await loadHandler("1.0.82");
        const result = driveUntilParked(handler(ctx, inheritedInput("fifo-1.0.82")), ctx);
        expect(turns).toHaveLength(2);
        expect(turns[0][0]).toMatch(/P1[\s\S]*P2/);
        expect(turns[1][0]).toMatch(/Scheduled cron wake-up/);
        expect(readFifo(values)).toEqual([]);
        expect(result.parkedOnTimerMs).toBe(3_600_000);
    });
    // A frozen 1.0.82 session continues as new into the latest handler, which accepts everything it carries.
    // Its queued prompts (KV FIFO), its pending child
    // digest, its rehydration notice and a set_model all arrive: the new model's turn says the notice once, the queued
    // prompts run once, in order, and the child's update is delivered once.
    it(`a 1.0.82 session with queued prompts, a pending child digest, a rehydration notice and a set_model continues as new into ${DURABLE_SESSION_LATEST_VERSION} and keeps them all`, async () => {
        const values = new Map();
        values.set("fifo.0", JSON.stringify([
            { kind: "prompt", prompt: "QUEUED-P1", bootstrap: false, clientMessageIds: ["p1"] },
            { kind: "prompt", prompt: "QUEUED-P2", bootstrap: false, clientMessageIds: ["p2"] },
        ]));
        const sourceCtx = createCtx(values, [
            JSON.stringify({ type: "cmd", cmd: "set_model", id: "set-model-82", args: { model: "github-copilot:gpt-5.4-mini" } }),
        ]);
        const source = driveUntilStop((await loadHandler("1.0.82"))(sourceCtx, {
            sessionId: "upgrade-82-carried",
            config: { model: "github-copilot:gpt-5.4" },
            sourceOrchestrationVersion: "1.0.82",
            iteration: 4,
            isSystem: true,
            blobEnabled: true,
            needsHydration: true,
            rehydrationMessage: "REHYDRATION-NOTICE: the last hand-off lost the live session.",
            pendingChildDigest: {
                startedAtMs: 1_713_083_000_000,
                updates: [{ sessionId: "child-a", updateType: "completed", content: "CHILD-RESULT", observedAtMs: 1_713_083_000_000 }],
            },
        }), sourceCtx);
        expect(source.effect).toMatchObject({ effect: "continueAsNew", version: DURABLE_SESSION_LATEST_VERSION });
        const carried = source.effect.input;
        expect(carried.config.model).toBe("github-copilot:gpt-5.4-mini");
        expect(carried.rehydrationMessage).toMatch(/^REHYDRATION-NOTICE/);
        expect(carried.pendingChildDigest.updates.map((update) => update.content)).toEqual(["CHILD-RESULT"]);
        expect(readFifo(values).map((item) => item.prompt)).toEqual(["QUEUED-P1", "QUEUED-P2"]);

        const turns = [];
        const latestCtx = createCtx(values, [], turns);
        let guid = 0;
        const resolve = latestCtx.resolveEffect.bind(latestCtx);
        latestCtx.resolveEffect = (effect) => (effect?.effect === "newGuid" ? `guid-${++guid}` : resolve(effect));
        const parked = driveUntilParked((await loadHandler(DURABLE_SESSION_LATEST_VERSION))(latestCtx, carried), latestCtx);
        expect(parked.done).toBe(false);
        const prompts = turns.map((turn) => String(turn[0]));
        const count = (text) => prompts.filter((prompt) => prompt.includes(text)).length;
        expect(prompts[0]).toMatch(/^Continue on github-copilot:gpt-5\.4-mini\./);
        expect(prompts[0]).toContain("Runtime model for this turn is github-copilot:gpt-5.4-mini.");
        expect(count("REHYDRATION-NOTICE")).toBe(1);
        expect(prompts[0]).toContain("REHYDRATION-NOTICE");
        expect(count("QUEUED-P1")).toBe(1);
        expect(count("QUEUED-P2")).toBe(1);
        expect(prompts.find((prompt) => prompt.includes("QUEUED-P1"))).toMatch(/QUEUED-P1[\s\S]*QUEUED-P2/);
        expect(count("CHILD-RESULT")).toBe(1);
        expect(readFifo(values).filter((item) => item.kind === "prompt")).toEqual([]);
        // The turn index carries on from the 1.0.82 session's.
        expect(turns[0][2]).toBe(4);
    });
    // Formal audit R2: a 1.0.82 turn that threw continues as new with its retry as its prompt and its thrown attempt's key
    // (1.0.81's contract), stamped with its own literal source version "1.0.82". The latest handler converts it into an owed retry
    // (state.ts ownedRetryOfInput): the retry runs once, with the thrown attempt's key and its count, never twice.
    it(`a 1.0.82 turn that threw continues into ${DURABLE_SESSION_LATEST_VERSION} and its retry runs once, with the thrown attempt's key`, async () => {
        const values = new Map();
        let guid = 0;
        let thrown = 0;
        const sourceTurns = [];
        const sourceGen = (await loadHandler("1.0.82"))(createCtx(values, []), {
            sessionId: "upgrade-82-thrown",
            config: { model: "github-copilot:gpt-5.4" },
            sourceOrchestrationVersion: "1.0.82",
            iteration: 2,
            isSystem: true,
            blobEnabled: true,
            prompt: "THROWN-PROMPT",
            clientMessageIds: ["thrown-1"],
        });
        // Drive 1.0.82 by hand: its first turn throws (a lost worker), its retry timer fires, and it continues as new.
        let input;
        let failure;
        let can = null;
        for (let step = 0; step < 300 && can === null; step += 1) {
            const next = failure ? sourceGen.throw(failure) : sourceGen.next(input);
            failure = undefined;
            input = undefined;
            if (next.done) throw new Error(`1.0.82 ended: ${JSON.stringify(next.value)}`);
            const effect = next.value;
            const turn = effect?.effect === "session.runTurn" ? effect
                : effect?.effect === "race" ? [effect.left, effect.right].find(side => side?.effect === "session.runTurn") : null;
            if (turn) {
                sourceTurns.push(turn.args);
                thrown += 1;
                failure = new Error("worker lost the session");
                continue;
            }
            switch (effect?.effect) {
                case "continueAsNew": can = effect; break;
                case "newGuid": input = `guid-${++guid}`; break;
                case "scheduleTimer": input = undefined; break;
                case "utcNow": input = 1_713_083_589_000 + step; break;
                case "race": input = { index: [effect.left, effect.right].findIndex(side => side?.effect === "scheduleTimer") }; break;
                case "dequeueEvent": throw new Error("1.0.82 blocked before its retry");
                default: input = undefined;
            }
        }
        expect(thrown).toBe(1);
        expect(can).toMatchObject({ effect: "continueAsNew", version: DURABLE_SESSION_LATEST_VERSION });
        const carried = can.input;
        expect(carried.sourceOrchestrationVersion).toBe("1.0.82");
        expect(carried.prompt).toContain("THROWN-PROMPT");
        expect(carried.retryCount).toBe(1);
        expect(typeof carried.thrownTurnKey).toBe("string");
        const thrownKey = carried.thrownTurnKey;
        expect(sourceTurns[0][3]?.snapshot?.turnKey ?? thrownKey).toBe(thrownKey);

        const turns = [];
        const latestCtx = createCtx(values, [], turns);
        const resolve = latestCtx.resolveEffect.bind(latestCtx);
        latestCtx.resolveEffect = (effect) => (effect?.effect === "newGuid" ? `guid-${++guid}` : resolve(effect));
        const parked = driveUntilParked((await loadHandler(DURABLE_SESSION_LATEST_VERSION))(latestCtx, carried), latestCtx);
        expect(parked.done).toBe(false);
        const retries = turns.filter(turn => String(turn[0]).includes("THROWN-PROMPT"));
        expect(retries).toHaveLength(1);
        expect(retries[0][3]?.retryCount).toBe(1);
        expect(retries[0][3]?.snapshot?.turnKey).toBe(thrownKey);
    });
});
