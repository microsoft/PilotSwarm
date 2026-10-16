/**
 * Convert a queued message to a steer, with real workers, PostgreSQL,
 * duroxide and the Copilot CLI; the model is scripted (design doc section
 * "Convert a queued message").
 *
 * A turn T blocks in a test tool, so a turn is running; a message X is sent
 * meanwhile, so it is durably queued behind T. Steer now is the steer that
 * names X (`replacesClientMessageId`), added as the management client adds
 * it. Every assertion is on the durable record: X's text runs exactly once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForSessionState } from "../helpers/cms-helpers.js";
import { withScriptedModel, setClusterFeature } from "../helpers/scripted-workers.js";
import { defineTool } from "../helpers/local-workers.js";
import { armFaultHold } from "../../src/fault-injection.ts";
import { TURN_CONTROL_ORCHESTRATION, until, deferred } from "../helpers/turn-control-harness.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 300_000;
const WAIT = 120_000;
const actor = { kind: "user", provider: "dev", subject: "alice" };

const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-tc-convert-"));
const savedReleaseDir = process.env.PILOTSWARM_FAULT_RELEASE_DIR;
beforeAll(() => { process.env.PILOTSWARM_FAULT_RELEASE_DIR = releaseDir; });
afterAll(() => {
    if (savedReleaseDir === undefined) delete process.env.PILOTSWARM_FAULT_RELEASE_DIR;
    else process.env.PILOTSWARM_FAULT_RELEASE_DIR = savedReleaseDir;
    fs.rmSync(releaseDir, { recursive: true, force: true });
});
const release = (point, sessionId) => fs.writeFileSync(path.join(releaseDir, `${point}.${sessionId}`), "");
const waitForHold = (point, sessionId) => until(() => fs.existsSync(path.join(releaseDir, `${point}.${sessionId}.held`)), `the ${point} hold`, WAIT);

/** A tool that blocks each call until the test releases it. */
function blockingTool() {
    let started = deferred();
    let released = deferred();
    return {
        get started() { return started.promise; },
        release() { released.resolve(); },
        rearm() { started = deferred(); released = deferred(); },
        tool: defineTool("tc_cv_block", {
            description: "Wait for the test to release this step.",
            parameters: { type: "object", properties: {} },
            handler: async () => { started.resolve(); await released.promise; return "released"; },
        }),
    };
}

/** A prompt with BLOCK calls the blocking tool first; anything else (a steer, X) is answered at once. */
function responder(_body, position) {
    if (position.step === 0 && position.lastUserText.includes("BLOCK")) return { tools: [{ name: "tc_cv_block", args: {} }] };
    return { content: `done: ${position.lastUserText.slice(0, 40)}` };
}

const all = (catalog, sessionId) => catalog.getSessionEvents(sessionId, 0, 1000);
const ofType = async (catalog, sessionId, type) => (await all(catalog, sessionId)).filter((e) => e.eventType === type);
const promptsWith = async (catalog, sessionId, id) => (await ofType(catalog, sessionId, "user.message"))
    .filter((e) => e.data?.clientMessageIds?.includes(id));
const outcomeOf = async (catalog, sessionId, seq) => (await ofType(catalog, sessionId, "session.control_outcome"))
    .find((e) => Number(e.data?.seq) === Number(seq))?.data.outcome;
const convert = (catalog, sessionId, text, x, requestId = randomUUID()) =>
    catalog.turnControlAdd(sessionId, "steer", text, requestId, actor, true, x);

async function withConvert(fn) {
    const env = getEnv();
    await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
    const block = blockingTool();
    await withScriptedModel(env, { tools: [block.tool], respond: responder }, async ({ client, model, qualifiedModel }) => {
        const catalog = await createCatalog(env);
        try {
            await fn({ client, model, catalog, block, newSession: () => client.createSession({ model: qualifiedModel, tools: [block.tool] }) });
        } finally {
            block.release();
            await catalog.close?.();
        }
    });
}

describe.skipIf(!TURN_CONTROL_ORCHESTRATION)("convert a queued message to a steer (real CLI, scripted model)", () => {
    it("while the turn runs: delivered, X is dropped as converted_to_steer and never runs", { timeout: TIMEOUT }, async () => {
        await withConvert(async ({ model, catalog, block, newSession }) => {
            const session = await newSession();
            const sid = session.sessionId;
            await session.send("T1 BLOCK");
            await block.started;
            await session.send("X1 queued text", { clientMessageIds: ["cv-x1"] });
            const added = await convert(catalog, sid, "X1 queued text", "cv-x1");
            expect(added).toEqual({ seq: expect.any(Number), turn: expect.any(Number) });
            block.release();
            await until(async () => (await outcomeOf(catalog, sid, added.seq)) === "delivered", "the steer was delivered", WAIT);
            await until(async () => (await ofType(catalog, sid, "pending_messages.cancelled"))
                .some((e) => e.data.clientMessageIds.includes("cv-x1") && e.data.reason === "converted_to_steer"), "X was dropped", WAIT);
            // A later message runs after X's queue position: X, had it not been dropped, would have run first.
            block.rearm();
            await session.send("Z1 after", { clientMessageIds: ["cv-z1"] });
            await until(async () => (await promptsWith(catalog, sid, "cv-z1")).length === 1, "Z ran", WAIT);
            await waitForSessionState(catalog, sid, "idle", WAIT);
            expect(await promptsWith(catalog, sid, "cv-x1")).toEqual([]);
            // Two turns ran (T and Z); the model read X's text once, as the steer.
            expect(await ofType(catalog, sid, "session.turn_completed")).toHaveLength(2);
            expect(model.requests.some((r) => r.session && r.position.lastUserText === "X1 queued text")).toBe(true);
        });
    });

    it("after the turn ended (turn end done, result not handled): no_turn, X stays queued and runs once", { timeout: TIMEOUT }, async () => {
        await withConvert(async ({ catalog, block, newSession }) => {
            const session = await newSession();
            const sid = session.sessionId;
            armFaultHold("turn.control.after-end", sid);
            await session.send("T2 BLOCK");
            await block.started;
            await session.send("X2 queued text", { clientMessageIds: ["cv-x2"] });
            // An ordinary steer, so the turn has a control and turn end runs.
            await catalog.turnControlAdd(sid, "steer", "probe", randomUUID(), actor);
            block.release();
            await waitForHold("turn.control.after-end", sid);
            expect(await convert(catalog, sid, "X2 queued text", "cv-x2")).toEqual({ refused: "no_turn" });
            release("turn.control.after-end", sid);
            await until(async () => (await promptsWith(catalog, sid, "cv-x2")).length === 1, "X ran", WAIT);
            await waitForSessionState(catalog, sid, "idle", WAIT);
            expect(await promptsWith(catalog, sid, "cv-x2")).toHaveLength(1);
            expect((await ofType(catalog, sid, "user.steer")).filter((e) => e.data.replacesClientMessageId === "cv-x2")).toEqual([]);
        });
    });

    it("converted, then stopped before the model read it: not delivered, X runs next, once", { timeout: TIMEOUT }, async () => {
        await withConvert(async ({ catalog, block, newSession }) => {
            const session = await newSession();
            const sid = session.sessionId;
            await session.send("T3 BLOCK");
            await block.started;
            await session.send("X3 queued text", { clientMessageIds: ["cv-x3"] });
            const added = await convert(catalog, sid, "X3 queued text", "cv-x3");
            await catalog.turnControlAdd(sid, "stop", "Stopped by user", randomUUID(), actor);
            await until(async () => (await outcomeOf(catalog, sid, added.seq)) === "not_delivered", "the steer was not delivered", WAIT);
            block.release();
            await until(async () => (await promptsWith(catalog, sid, "cv-x3")).length === 1, "X ran", WAIT);
            await waitForSessionState(catalog, sid, "idle", WAIT);
            expect(await promptsWith(catalog, sid, "cv-x3")).toHaveLength(1);
            expect((await ofType(catalog, sid, "pending_messages.cancelled")).filter((e) => e.data.clientMessageIds.includes("cv-x3"))).toEqual([]);
        });
    });

    it("converted after the send gate closed: not delivered, never carried; X runs once", { timeout: TIMEOUT }, async () => {
        await withConvert(async ({ catalog, newSession }) => {
            const session = await newSession();
            const sid = session.sessionId;
            armFaultHold("turn.control.before-writeback", sid);
            await session.send("T4 quick");
            await waitForHold("turn.control.before-writeback", sid);
            await session.send("X4 queued text", { clientMessageIds: ["cv-x4"] });
            const added = await convert(catalog, sid, "X4 queued text", "cv-x4");
            expect(added.seq).toEqual(expect.any(Number));
            release("turn.control.before-writeback", sid);
            await until(async () => (await outcomeOf(catalog, sid, added.seq)) === "not_delivered", "the steer was not delivered", WAIT);
            await until(async () => (await promptsWith(catalog, sid, "cv-x4")).length === 1, "X ran", WAIT);
            await waitForSessionState(catalog, sid, "idle", WAIT);
            expect(await promptsWith(catalog, sid, "cv-x4")).toHaveLength(1);
            expect(await ofType(catalog, sid, "session.carried_steers_closed")).toEqual([]);
        });
    });

    it("the message already running: already_received, nothing recorded, it runs once", { timeout: TIMEOUT }, async () => {
        await withConvert(async ({ catalog, block, newSession }) => {
            const session = await newSession();
            const sid = session.sessionId;
            await session.send("X5 BLOCK running", { clientMessageIds: ["cv-x5"] });
            await block.started;
            expect(await convert(catalog, sid, "X5 BLOCK running", "cv-x5")).toEqual({ refused: "already_received" });
            block.release();
            await waitForSessionState(catalog, sid, "idle", WAIT);
            expect(await promptsWith(catalog, sid, "cv-x5")).toHaveLength(1);
            expect(await ofType(catalog, sid, "user.steer")).toEqual([]);
        });
    });

    it("double fault (decision (a)): the save holds the steer, turn end never succeeds, give-up: one not_delivered, X runs once", { timeout: TIMEOUT }, async () => {
        const saved = process.env.PILOTSWARM_FAULT_INJECT;
        process.env.PILOTSWARM_FAULT_INJECT = "turn.control.before-end:throw";
        try {
            await withConvert(async ({ catalog, block, newSession }) => {
                const session = await newSession();
                const sid = session.sessionId;
                await session.send("T6 BLOCK");
                await block.started;
                await session.send("X6 queued text", { clientMessageIds: ["cv-x6"] });
                const added = await convert(catalog, sid, "X6 queued text", "cv-x6");
                block.release();
                await until(async () => (await ofType(catalog, sid, "session.steer_confirmed")).some((e) => e.data.seq === added.seq), "the model read the steer", WAIT);
                await until(async () => (await outcomeOf(catalog, sid, added.seq)) === "not_delivered", "the give-up closed the steer", 200_000);
                await until(async () => (await promptsWith(catalog, sid, "cv-x6")).length === 1, "X ran", WAIT);
                await waitForSessionState(catalog, sid, ["idle", "error"], WAIT);
                expect((await ofType(catalog, sid, "session.control_outcome")).filter((e) => e.data.seq === added.seq)
                    .map((e) => e.data.outcome)).toEqual(["not_delivered"]);
                expect(await promptsWith(catalog, sid, "cv-x6")).toHaveLength(1);
            });
        } finally {
            if (saved === undefined) delete process.env.PILOTSWARM_FAULT_INJECT; else process.env.PILOTSWARM_FAULT_INJECT = saved;
        }
    });
});
