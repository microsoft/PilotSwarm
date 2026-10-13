import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount, waitForSessionState } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { withClient, defineTool } from "../helpers/local-workers.js";
import { patchSessionStartInput, pinSessionStartVersion } from "../helpers/pinned-start.mjs";
import { CARRIED_STEERS_WAKE_PROMPT } from "../../src/turn-control-contract.ts";
import { stopTurnQueueName } from "../../src/types.ts";

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
                const session = await client.createSession({ sessionId });
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
                    const session = await client.createSession({ sessionId });
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
                const session = await client.createSession({ sessionId });
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
});
