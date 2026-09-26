import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

function createCtx(values, queue = [], turns = []) {
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
                    if (/^(manager|session)\./.test(String(effect.effect))) return undefined;
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
    for (const sourceVersion of ["1.0.40", "1.0.41", "1.0.42", "1.0.79"]) {
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

            const sourceGen = sourceHandler(sourceCtx, {
                sessionId: `upgrade-${sourceVersion}`,
                config: { model: "github-copilot:gpt-5.4" },
                sourceOrchestrationVersion: sourceVersion,
                iteration: 0,
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

            // Test C4: a session from before workspaces carries none into 1.0.80.
            expect("workspace" in sourceResult.effect.input.config).toBe(false);
            expect(sourceResult.effect.input.iteration).toBe(0);

            const latestTurns = [];
            const latestCtx = createCtx(values, [
                JSON.stringify({
                    type: "cmd",
                    cmd: "get_info",
                    id: `get-info-${sourceVersion}`,
                }),
            ], latestTurns);

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
            if (sourceVersion === "1.0.79") {
                // 1.0.79 asks for one turn on the new model; 1.0.80 runs it
                // with no workspace fields on the wire.
                expect(latestTurns).toHaveLength(1);
                expect(latestTurns[0][0]).toMatch(/^Continue on github-copilot:gpt-5\.4-mini\./);
                const turnMeta = latestTurns[0][3] ?? {};
                expect("workspaceRevision" in turnMeta || "workspaceNotice" in turnMeta).toBe(false);
            }
        });
    }
});
