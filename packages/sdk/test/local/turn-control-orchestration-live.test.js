import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount, waitForSessionState } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { withClient, defineTool } from "../helpers/local-workers.js";
import { patchSessionStartInput, pinSessionStartVersion } from "../helpers/pinned-start.mjs";
import { CARRIED_STEERS_WAKE_PROMPT } from "../../src/turn-control-contract.ts";
import { stopTurnQueueName } from "../../src/types.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { handleTurnResult } from "../../src/orchestration/turn.ts";
import { createInitialState, deriveOptions } from "../../src/orchestration/state.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};

function blockingTool() {
    const started = deferred();
    const released = deferred();
    return {
        started,
        released,
        tool: defineTool("tc_b_block", {
            description: "Wait for the test to release this step.",
            parameters: { type: "object", properties: {} },
            handler: async () => { started.resolve(); await released.promise; return "released"; },
        }),
    };
}

function captureLateSteer(worker, sessionId, text) {
    const catalog = worker._catalog;
    const original = catalog.completeTurnWriteback;
    let seq;
    catalog.completeTurnWriteback = async function (input) {
        if (input.sessionId === sessionId && seq === undefined) {
            const added = await catalog.turnControlAdd(sessionId, "steer", text, randomUUID(), null);
            expect(added.refused).toBeUndefined();
            seq = added.seq;
        }
        return original.call(this, input);
    };
    return { get seq() { return seq; }, restore() { catalog.completeTurnWriteback = original; } };
}

async function closings(catalog, sessionId) {
    return (await catalog.getSessionEvents(sessionId, 0, 500, ["session.carried_steers_closed"])).map(e => e.data);
}

async function carriedFixture(catalog) {
    const sessionId = randomUUID();
    await catalog.createSession(sessionId, { model: "fixture" });
    await catalog.turnStart(sessionId, 0);
    const accepted = await catalog.turnControlAdd(sessionId, "steer", "B2 carried protocol guidance", randomUUID(), null);
    const ended = await catalog.turnEnd(sessionId, 0, 0, "other", []);
    expect(ended.late).toEqual([{ seq: accepted.seq, text: "B2 carried protocol guidance" }]);
    return { sessionId, carried: ended.late };
}

function realControlMethods(catalog) {
    return {
        turnStart: catalog.turnStart.bind(catalog),
        turnEnd: catalog.turnEnd.bind(catalog),
        recordEvents: catalog.recordEvents.bind(catalog),
        completeTurnWriteback: async () => false,
    };
}

describe("B2 live orchestration turn controls after A4", () => {
    it("CMS Stop ends a real model turn idle with its cron kept and no duplicate system message", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const block = blockingTool();
        await withClient(env, { tools: [block.tool] }, async client => {
            const catalog = await createCatalog(env);
            const sessionId = randomUUID();
            const patch = patchSessionStartInput(client, input => ({
                ...input, cronSchedule: { intervalSeconds: 3600, reason: "keep this schedule" },
            }), { sessionId });
            try {
                const session = await client.createSession({ sessionId, tools: [block.tool] });
                await session.send("Call tc_b_block now, then report success.", { requiredTool: "tc_b_block" });
                await block.started.promise;
                const stop = await catalog.turnControlAdd(sessionId, "stop", "B2 live Stop", randomUUID(), null);
                expect(stop.refused).toBeUndefined();
                await waitForEventCount(catalog, sessionId, "session.turn_stopped", 1);
                const row = await waitForSessionState(catalog, sessionId, "idle");
                expect(row.activeTurnIndex).toBeNull();
                const events = await catalog.getSessionEvents(sessionId);
                expect(events.filter(e => e.eventType === "user.stop")).toHaveLength(1);
                expect(events.filter(e => e.eventType === "session.control_outcome" && e.data.seq === stop.seq))
                    .toEqual([expect.objectContaining({ data: expect.objectContaining({ outcome: "stopped" }) })]);
                expect(events.filter(e => e.eventType === "system.message" && e.data.content === "Turn stopped by user.")).toEqual([]);
                const info = await client._getDuroxideClient().getStatus(`session-${sessionId}`);
                expect(JSON.stringify(info.customStatus)).toContain("keep this schedule");
            } finally {
                block.released.resolve();
                patch.restore();
                await catalog.close();
            }
        });
    });

    it("a late steer runs once on the real CLI and an unrelated later Stop never closes it again", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const block = blockingTool();
        await withScriptedModel(env, {
            tools: [block.tool],
            respond: (_body, position) => position.lastUserText.includes("unrelated stop") && position.step === 0
                ? { tools: [{ name: "tc_b_block", args: {} }] }
                : { content: position.lastUserText.includes("B2 carried ran") ? "guidance used" : "first complete" },
        }, async ({ client, worker, model }) => {
            const catalog = await createCatalog(env);
            const sessionId = randomUUID();
            const capture = captureLateSteer(worker, sessionId, "B2 carried ran");
            try {
                const session = await client.createSession({ sessionId, tools: [block.tool] });
                await session.send("B2 first turn");
                await waitForEventCount(catalog, sessionId, "session.carried_steers_closed", 1);
                expect(await closings(catalog, sessionId)).toEqual([
                    expect.objectContaining({ seqs: [capture.seq], reason: "ran", turnIndex: 1 }),
                ]);
                const requests = model.sessionRequests("B2 first turn");
                expect(requests.filter(r => r.position.lastUserText.includes("B2 carried ran"))).toHaveLength(1);
                expect(requests.some(r => JSON.stringify(r.body).includes(CARRIED_STEERS_WAKE_PROMPT))).toBe(false);
                expect((await catalog.getSessionEvents(sessionId)).filter(e => e.eventType === "user.steer")).toHaveLength(1);
                await session.send("unrelated stop", { requiredTool: "tc_b_block" });
                await block.started.promise;
                await catalog.turnControlAdd(sessionId, "stop", "later unrelated", randomUUID(), null);
                await waitForEventCount(catalog, sessionId, "session.turn_stopped", 1);
                expect(await closings(catalog, sessionId)).toHaveLength(1);
            } finally {
                block.released.resolve();
                capture.restore();
                await catalog.close();
            }
        });
    });

    for (const atStart of [true, false]) {
        it(`a carried consuming turn stopped ${atStart ? "at start" : "mid-turn"} closes once and never reruns guidance`, { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            const block = blockingTool();
            await withScriptedModel(env, {
                tools: [block.tool],
                respond: (_body, position) => position.lastUserText.includes("B2 carried stop") && position.step === 0
                    ? { tools: [{ name: "tc_b_block", args: {} }] }
                    : { content: "first complete" },
            }, async ({ client, worker, model }) => {
                const catalog = await createCatalog(env);
                const sessionId = randomUUID();
                const capture = captureLateSteer(worker, sessionId, "B2 carried stop");
                const start = worker._catalog.turnStart;
                worker._catalog.turnStart = async function (id, turn) {
                    const opened = await start.call(this, id, turn);
                    if (atStart && id === sessionId && turn === 1) {
                        await this.turnControlAdd(id, "stop", "stop consuming start", randomUUID(), null);
                        return start.call(this, id, turn);
                    }
                    return opened;
                };
                try {
                    const session = await client.createSession({ sessionId, tools: [block.tool] });
                    await session.send("B2 first before stop");
                    if (!atStart) {
                        await block.started.promise;
                        await catalog.turnControlAdd(sessionId, "stop", "stop consuming model", randomUUID(), null);
                    }
                    await waitForEventCount(catalog, sessionId, "session.turn_stopped", 1);
                    await waitForSessionState(catalog, sessionId, "idle");
                    expect(await closings(catalog, sessionId)).toEqual([
                        expect.objectContaining({ seqs: [capture.seq], reason: "stopped", turnIndex: 1 }),
                    ]);
                    const requests = model.sessionRequests("B2 first before stop");
                    expect(requests.filter(r => r.position.lastUserText.includes("B2 carried stop"))).toHaveLength(atStart ? 0 : 1);
                    expect(requests.some(r => JSON.stringify(r.body).includes(CARRIED_STEERS_WAKE_PROMPT))).toBe(false);
                    const status = await client._getDuroxideClient().getInstanceInfo(`session-${sessionId}`);
                    const history = await client._getDuroxideClient().readExecutionHistory(`session-${sessionId}`, status.currentExecutionId);
                    const ended = history.filter(e => e.kind === "ActivityCompleted" && String(e.data).includes("carriedSteersConsumed"));
                    expect(ended.length).toBeGreaterThan(0);
                } finally {
                    block.released.resolve();
                    worker._catalog.turnStart = start;
                    capture.restore();
                    await catalog.close();
                }
            });
        });
    }

    it("a frozen 1.0.80 session still stops through its orchestration event", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const block = blockingTool();
        await withScriptedModel(env, {
            tools: [block.tool],
            respond: () => ({ tools: [{ name: "tc_b_block", args: {} }] }),
        }, async ({ client }) => {
            const catalog = await createCatalog(env);
            const sessionId = randomUUID();
            const pin = pinSessionStartVersion(client, "1.0.80", { sessionId });
            try {
                const session = await client.createSession({ sessionId, tools: [block.tool] });
                await session.send("B2 legacy Stop", { requiredTool: "tc_b_block" });
                await block.started.promise;
                const row = await catalog.getSession(sessionId);
                await client._getDuroxideClient().enqueueEvent(`session-${sessionId}`, stopTurnQueueName(row.activeTurnIndex),
                    JSON.stringify({ reason: "legacy Stop", id: randomUUID() }));
                await waitForEventCount(catalog, sessionId, "session.turn_stopped", 1);
                await waitForSessionState(catalog, sessionId, "idle");
                const events = await catalog.getSessionEvents(sessionId);
                expect(events.filter(e => e.eventType === "system.message" && e.data.content === "Turn stopped by user.")).toHaveLength(1);
            } finally {
                block.released.resolve();
                pin.restore();
                await catalog.close();
            }
        });
    });

    it("carry survives a pre-model error, budget wait, and thrown attempt before closing ran at a later index", { timeout: TIMEOUT }, async () => {
        const catalog = await createCatalog(getEnv());
        try {
            const { sessionId, carried } = await carriedFixture(catalog);
            let admission = "error";
            let throws = false;
            const prompts = [];
            const h = makeRunTurnHarness({
                catalogExtras: {
                    ...realControlMethods(catalog),
                    providers: {
                        checkTurn: async () => {
                            if (admission === "error") throw new Error("provider admission unavailable");
                            if (admission === "wait") return {
                                verdict: "paused", providerName: "fixture", modelQualified: null, exempt: false,
                                pause: { kind: "limit", provider: "fixture" }, rules: [],
                            };
                            return { verdict: "clear", providerName: "fixture", modelQualified: null, exempt: false, rules: [] };
                        },
                    },
                },
                turn: async () => {
                    if (throws) throw new Error("model transport failed");
                    return { type: "completed", content: "used" };
                },
            });
            const input = { carriedSteers: carried, prompt: CARRIED_STEERS_WAKE_PROMPT };
            const failedAdmission = await h.runTurn(sessionId, { ...input, turnIndex: 1 }, "runTurnV4");
            expect(failedAdmission.type).toBe("error");
            expect(failedAdmission.carriedSteersConsumed).toBeUndefined();
            expect(await closings(catalog, sessionId)).toEqual([]);
            admission = "wait";
            const wait = await h.runTurn(sessionId, { ...input, turnIndex: 2 }, "runTurnV4");
            expect(wait).toMatchObject({ type: "wait", budget: true });
            expect(wait.carriedSteersConsumed).toBeUndefined();
            admission = "allow";
            throws = true;
            await expect(h.runTurn(sessionId, { ...input, turnIndex: 3 }, "runTurnV4")).rejects.toThrow("model transport failed");
            expect(await closings(catalog, sessionId)).toEqual([]);
            throws = false;
            const completed = await h.runTurn(sessionId, { ...input, turnIndex: 7 }, "runTurnV4");
            expect(completed.carriedSteersConsumed).toBe(true);
            prompts.push(...h.session.runTurn.mock.calls.map(call => call[0]));
            expect(prompts).toEqual(["B2 carried protocol guidance", "B2 carried protocol guidance"]);
            expect(prompts.some(prompt => prompt.includes(CARRIED_STEERS_WAKE_PROMPT))).toBe(false);
            expect(await closings(catalog, sessionId)).toEqual([
                { seqs: [carried[0].seq], turnIndex: 7, reason: "ran" },
            ]);
        } finally {
            await catalog.close();
        }
    });

    it("a returned retryable carried-only error is folded again and closes only after the consuming retry", { timeout: TIMEOUT }, async () => {
        const catalog = await createCatalog(getEnv());
        try {
            const { sessionId, carried } = await carriedFixture(catalog);
            let error = true;
            const h = makeRunTurnHarness({
                catalogExtras: realControlMethods(catalog),
                turn: async () => error
                    ? { type: "error", message: "retry this turn" }
                    : { type: "completed", content: "used" },
            });

            it("a carried-only returned-error retry keeps the wake marker out of every real CLI request", { timeout: TIMEOUT }, async () => {
                const env = getEnv();
                await withScriptedModel(env, {
                    respond: () => ({ content: "done" }),
                }, async ({ client, worker, model }) => {
                    const catalog = await createCatalog(env);
                    const sessionId = randomUUID();
                    const capture = captureLateSteer(worker, sessionId, "B2 retry carried guidance");
                    const manager = worker.sessionManager;
                    const original = manager.getOrCreate;
                    const wrapped = new Map();
                    let failed = false;
                    manager.getOrCreate = async function (id, ...args) {
                        const session = await original.call(this, id, ...args);
                        if (id === sessionId && !wrapped.has(session)) {
                            const run = session.runTurn;
                            wrapped.set(session, run);
                            session.runTurn = async function (prompt, opts) {
                                const result = await run.call(this, prompt, opts);
                                if (!failed && prompt.includes("B2 retry carried guidance")) {
                                    failed = true;
                                    return { type: "error", message: "B2 injected returned error" };
                                }
                                return result;
                            };
                        }
                        return session;
                    };
                    try {
                        const session = await client.createSession({ sessionId });
                        await session.send("B2 first before carried retry");
                        await waitForEventCount(catalog, sessionId, "session.carried_steers_closed", 1, 90_000);
                        expect(failed).toBe(true);
                        expect(await closings(catalog, sessionId)).toEqual([
                            expect.objectContaining({ seqs: [capture.seq], reason: "ran", turnIndex: 2 }),
                        ]);
                        const requests = model.sessionRequests("B2 first before carried retry");
                        expect(requests.filter(r => r.position.lastUserText.includes("B2 retry carried guidance")).length).toBeGreaterThanOrEqual(2);
                        expect(requests.some(r => JSON.stringify(r.body).includes(CARRIED_STEERS_WAKE_PROMPT))).toBe(false);
                        const events = await catalog.getSessionEvents(sessionId);
                        expect(events.filter(e => e.eventType === "user.steer")).toHaveLength(1);
                        expect(events.filter(e => e.eventType === "user.message" && String(e.data.content).includes("B2 retry carried guidance"))).toEqual([]);
                    } finally {
                        for (const [session, run] of wrapped) session.runTurn = run;
                        manager.getOrCreate = original;
                        capture.restore();
                        await catalog.close();
                    }
                });
            });
            const first = await h.runTurn(sessionId, { turnIndex: 1, prompt: CARRIED_STEERS_WAKE_PROMPT, carriedSteers: carried }, "runTurnV4");
            expect(first.type).toBe("error");
            expect(first.carriedSteersConsumed).toBeUndefined();
            expect(await closings(catalog, sessionId)).toEqual([]);
            error = false;
            const retry = await h.runTurn(sessionId, { turnIndex: 2, retryCount: 1, bootstrap: true, prompt: CARRIED_STEERS_WAKE_PROMPT, carriedSteers: carried }, "runTurnV4");
            expect(retry.carriedSteersConsumed).toBe(true);
            expect(h.session.runTurn.mock.calls.map(call => call[0])).toEqual([
                "B2 carried protocol guidance", "B2 carried protocol guidance",
            ]);
            expect(await closings(catalog, sessionId)).toEqual([{ seqs: [carried[0].seq], turnIndex: 2, reason: "ran" }]);
        } finally {
            await catalog.close();
        }
    });

    it("the orchestration give-up write closes carried guidance once as gave_up in real PostgreSQL", { timeout: TIMEOUT }, async () => {
        const catalog = await createCatalog(getEnv());
        try {
            const { sessionId, carried } = await carriedFixture(catalog);
            const input = { sessionId, config: {}, iteration: 6, carriedSteers: carried, isSystem: true, blobEnabled: false };
            const options = deriveOptions(input);
            const state = createInitialState(input, options);
            const kv = new Map();
            const runtime = {
                input, state, options,
                ctx: {
                    traceInfo() {}, setCustomStatus() {},
                    getValue: key => kv.get(key),
                    setValue: (key, value) => kv.set(key, value),
                    utcNow: () => Date.now(),
                },
                manager: {
                    updateCmsState: (id, status, lastError, waitReason, opts) =>
                        catalog.updateSession(id, { state: status, lastError, waitReason, ...opts }),
                },
            };
            const gen = handleTurnResult(runtime, { type: "error", message: "non-retryable failure", retryable: false }, CARRIED_STEERS_WAKE_PROMPT);
            let value;
            for (let step = 0; step < 20; step++) {
                const next = gen.next(value);
                if (next.done) break;
                value = await next.value;
            }
            expect(state.carriedSteers).toEqual([]);
            expect(await closings(catalog, sessionId)).toEqual([{ seqs: [carried[0].seq], turnIndex: 0, reason: "gave_up" }]);
            await catalog.updateSession(sessionId, { state: "error", closeControls: true });
            expect(await closings(catalog, sessionId)).toHaveLength(1);
        } finally {
            await catalog.close();
        }
    });
});
