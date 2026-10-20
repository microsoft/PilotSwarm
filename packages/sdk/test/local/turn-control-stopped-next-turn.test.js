/**
 * The turn after a stopped turn continues quietly (session turn control,
 * design 5.1, "Stopped turn before the first commit").
 *
 * A stopped turn's snapshot is discarded on purpose. When the stopped turn
 * was the session's first (nothing was ever committed), the next turn starts
 * a fresh conversation: no session.lossy_handoff, no "worker restart" notice
 * to the model or in the transcript, and no title taken from that notice.
 * After a stopped later turn the next turn resumes the last committed turn.
 *
 * Real worker, PostgreSQL, Duroxide and Copilot CLI with the scripted model,
 * so every case is deterministic.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount, waitForSessionState } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { createManagementClient, defineTool } from "../helpers/local-workers.js";
import { pinSessionStartVersion } from "../helpers/pinned-start.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const WAIT = 120_000;
const RESTART_TEXT = /worker restart lost the live Copilot session/;

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

/** A tool that holds the turn until the test releases it. */
function blockingTool() {
    const started = deferred();
    const released = deferred();
    return {
        started: started.promise,
        release() { released.resolve(); },
        tool: defineTool("tc_s_block", {
            description: "Wait for the test to release this step.",
            parameters: { type: "object", properties: {} },
            handler: async () => { started.resolve(); await released.promise; return "released"; },
        }),
    };
}

/** The parent turns that open with "STN-ACT" call `plan.parent`; STN-BLOCK blocks; others answer. */
function responder(plan) {
    return (_body, position) => {
        if (position.lastUserText.includes("STN-ACT") && position.step === 0) return { tools: plan.parent };
        if (position.lastUserText.includes("STN-BLOCK") && position.step === 0) return { tools: [{ name: "tc_s_block", args: {} }] };
        return { content: `answered ${position.lastUserText.match(/STN-[A-Z]+/)?.[0] ?? "?"}` };
    };
}

/** The model requests of the turn opened by `prompt` (session requests only). */
function turnRequests(model, prompt) {
    return model.requests.filter((r) => r.session && r.position.lastUserText.includes(prompt));
}

/** The session ran `prompt` quietly after its stopped turn. */
async function expectQuietNextTurn(catalog, model, sessionId, prompt) {
    const events = await catalog.getSessionEvents(sessionId);
    expect(events.filter((e) => e.eventType === "session.lossy_handoff")).toEqual([]);
    expect(events.filter((e) => e.eventType === "system.message" && RESTART_TEXT.test(String(e.data?.content ?? "")))).toEqual([]);
    expect(events.filter((e) => e.eventType === "session.title_changed" && /^\[SYSTEM:/.test(String(e.data?.title ?? "")))).toEqual([]);
    const requests = turnRequests(model, prompt);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
        const users = request.body.messages.filter((m) => m.role === "user").map(messageText);
        expect(users.some((text) => RESTART_TEXT.test(text))).toBe(false);
    }
    const row = await catalog.getSession(sessionId);
    expect(String(row?.title ?? "")).not.toMatch(/^\[SYSTEM:/);
    return requests;
}

async function withSession(env, { pin } = {}, fn) {
    const plan = { parent: [] };
    const block = blockingTool();
    await withScriptedModel(env, { tools: [block.tool], respond: responder(plan) }, async ({ client, model, qualifiedModel }) => {
        const catalog = await createCatalog(env);
        const mgmt = await createManagementClient(env);
        const sessionId = randomUUID();
        const pinned = pin ? pinSessionStartVersion(client, pin, { sessionId }) : null;
        try {
            const session = await client.createSession({ sessionId, model: qualifiedModel, tools: [block.tool] });
            await fn({ client, model, qualifiedModel, catalog, mgmt, session, block, plan });
        } finally {
            block.release();
            pinned?.restore();
            await mgmt.stop?.();
            await catalog.close();
        }
    });
}

describe("turn control: the turn after a stopped turn continues quietly", () => {
    for (const pin of [null, "1.0.80"]) {
        const label = pin ? `${pin} (earlier Stop path)` : "turn control";
        it(`a stopped first turn, ${label}: the next turn starts fresh without a lossy handoff`, { timeout: TIMEOUT }, async () => {
            await withSession(getEnv(), { pin }, async ({ model, catalog, mgmt, session, block }) => {
                await session.send("STN-BLOCK first turn", { requiredTool: "tc_s_block" });
                await block.started;
                const stop = await mgmt.stopSessionTurn(session.sessionId, { reason: "stop the first turn" });
                expect(["stopped", "stop_forced"]).toContain(stop.outcome);
                await waitForEventCount(catalog, session.sessionId, "session.turn_stopped", 1);
                await waitForSessionState(catalog, session.sessionId, "idle", WAIT);
                block.release();

                const answer = await session.sendAndWait("STN-NEXT after the stopped first turn", WAIT);
                expect(answer).toContain("answered STN-NEXT");
                const [request] = await expectQuietNextTurn(catalog, model, session.sessionId, "STN-NEXT after the stopped first turn");
                // A fresh conversation: the discarded first turn is not in it.
                expect(request.body.messages.some((m) => m.role === "user" && messageText(m).includes("STN-BLOCK"))).toBe(false);
            });
        });
    }

    it("a stopped later turn: the next turn resumes the last committed turn without a lossy handoff", { timeout: TIMEOUT }, async () => {
        await withSession(getEnv(), {}, async ({ model, catalog, mgmt, session, block }) => {
            expect(await session.sendAndWait("STN-HELLO committed first turn", WAIT)).toContain("answered STN-HELLO");
            await session.send("STN-BLOCK second turn", { requiredTool: "tc_s_block" });
            await block.started;
            expect((await mgmt.stopSessionTurn(session.sessionId, { reason: "stop the second turn" })).outcome).toBe("stopped");
            await waitForSessionState(catalog, session.sessionId, "idle", WAIT);
            block.release();

            expect(await session.sendAndWait("STN-NEXT after the stopped second turn", WAIT)).toContain("answered STN-NEXT");
            const [request] = await expectQuietNextTurn(catalog, model, session.sessionId, "STN-NEXT after the stopped second turn");
            expect(request.body.messages.some((m) => m.role === "user" && messageText(m).includes("STN-HELLO"))).toBe(true);
        });
    });

    it("a parent's stop_agent_turn of its child's first turn: the child's next turn starts fresh without a lossy handoff", { timeout: TIMEOUT }, async () => {
        await withSession(getEnv(), {}, async ({ client, model, qualifiedModel, catalog, session: parent, block, plan }) => {
            expect(await parent.sendAndWait("STN-PARENT start", WAIT)).toContain("answered STN-PARENT");
            const child = await client.createSession({ parentSessionId: parent.sessionId, model: qualifiedModel, tools: [block.tool] });
            await child.send("STN-BLOCK child first turn", { requiredTool: "tc_s_block" });
            await block.started;
            plan.parent = [{ name: "stop_agent_turn", args: { agent_id: child.sessionId } }];
            await parent.sendAndWait("STN-ACT stop the child", WAIT);
            const [stop] = await waitForEventCount(catalog, child.sessionId, "user.stop", 1);
            expect(stop.data.actor).toMatchObject({ kind: "agent", sessionId: parent.sessionId });
            await waitForSessionState(catalog, child.sessionId, "idle", WAIT);
            block.release();

            expect(await child.sendAndWait("STN-NEXT child after its stopped first turn", WAIT)).toContain("answered STN-NEXT");
            await expectQuietNextTurn(catalog, model, child.sessionId, "STN-NEXT child after its stopped first turn");
        });
    });
});
