/**
 * Session steering, end to end with the real Copilot CLI and the scripted
 * model: PostgreSQL, Duroxide, a real worker, the CMS ledger and the pump.
 * docs/proposals/session-steering.md §4.3, §7.4–§7.6; FR-5, FR-6, FR-9, FR-13, FR-15.
 *
 * The scripted model holds the turn inside a blocking tool until the test has
 * accepted a steer and seen it handed off, so every cell is deterministic.
 *
 * Run: npx vitest run test/local/session-steering-runtime-r2.test.js
 */
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { defineTool, createManagementClient } from "../helpers/local-workers.js";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { decodeSteeringTarget, steeringContentHash } from "../../src/steering.ts";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);
const ALICE = { kind: "user", provider: "test", subject: "alice", display: "Alice" };
const BOB = { kind: "user", provider: "test", subject: "bob", display: "Bob" };

/** The worker re-checks the author's write access before hand-off (NFR-10): make Alice the owner. */
async function ownSession(env, sessionId) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: env.store });
    await c.connect();
    try {
        await c.query(`SELECT "${env.cmsSchema}".cms_set_session_owner($1, $2, $3, $4, $5)`, [sessionId, "test", "alice", null, "Alice"]);
    } finally {
        await c.end();
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(100);
    }
}

function holdTool() {
    let release;
    const tracker = { started: false, gate: new Promise((r) => { release = r; }) };
    tracker.release = () => release();
    tracker.tool = defineTool("steer_hold", {
        description: "Blocks until the test releases it.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            tracker.started = true;
            await Promise.race([tracker.gate, sleep(120_000)]);
            return "held";
        },
    });
    return tracker;
}

/** Turn: call steer_hold once; then answer, naming any steering text the model saw. */
function respond(body) {
    const messages = body?.messages ?? [];
    const steers = messages.filter((m) => m.role === "user" && messageText(m).includes("[STEERING from"));
    const held = messages.some((m) => m.role === "tool");
    if (!held) return { tools: [{ name: "steer_hold", args: {} }] };
    if (steers.length > 0) return { content: `steered:${steers.map((m) => messageText(m).split("\n").slice(1).join(" ")).join("|")}` };
    return { content: "unsteered" };
}

async function acceptSteer(catalog, sessionId, text, key = `k-${Math.random()}`, actor = ALICE) {
    const state = await waitFor(async () => {
        const s = await catalog.steerState(sessionId);
        return s.steerable ? s : null;
    }, 60_000, "an open steering window");
    const t = decodeSteeringTarget(state.expectedTarget);
    return catalog.steerAccept({
        sessionId, requestId: `steer_${key}`, idempotencyKey: key, actor,
        content: text, contentHash: steeringContentHash(text),
        epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation,
    });
}

describe("session steering runtime (real CLI, scripted model)", () => {
    it("folds a steer into the running turn: delivered to the current turn and included in the saved result", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
        const hold = holdTool();
        await withScriptedModel(env, { respond, tools: [hold.tool] }, async ({ client, model, qualifiedModel }) => {
            const catalog = await createCatalog(env);
            try {
                const session = await client.createSession({ model: qualifiedModel, tools: [hold.tool] });
                await ownSession(env, session.sessionId);
                const answer = session.sendAndWait("start the work", TIMEOUT);
                await waitFor(() => hold.started, 60_000, "the blocking tool");

                // Bob has no write access: accepted by the ledger here (the management client
                // checks authz in production), but the worker must never hand it off.
                const fromBob = await acceptSteer(catalog, session.sessionId, "bob was here", "k-bob", BOB);
                assertEqual(fromBob.outcome, "accepted");
                const accepted = await acceptSteer(catalog, session.sessionId, "focus on the tests");
                assertEqual(accepted.outcome, "accepted", "steer accepted");
                const requestId = accepted.receipt.requestId;
                await waitFor(async () => ["submitted", "delivered"].includes((await catalog.steerGet(session.sessionId, requestId))?.status),
                    30_000, "the hand-off");
                hold.release();

                const content = await answer;
                assertEqual(content, "steered:focus on the tests", "the model's next call carried the steer as a separate user message");

                const receipt = await waitFor(async () => {
                    const r = await catalog.steerGet(session.sessionId, requestId);
                    return r?.status === "closed" ? r : null;
                }, 30_000, "finalize");
                assertEqual(receipt.disposition, "delivered_current_turn");
                assertEqual(receipt.inclusion.state, "included", "published manifest ⇒ included");
                assertEqual(receipt.attempts.items.length, 1, "one hand-off");
                assertEqual(receipt.attempts.items[0].deliveryKind, "steering");
                assertEqual(receipt.recoveryFlags.length, 0);

                const bobReceipt = await catalog.steerGet(session.sessionId, fromBob.receipt.requestId);
                assertEqual(bobReceipt.disposition, "not_delivered_turn_ended", "a revoked/unauthorized author is never handed off");
                assertEqual(bobReceipt.attempts.total, 0);
                assert(!model.requests.some((r) => JSON.stringify(r.body).includes("bob was here")), "Bob's text never reached the model");

                const steered = model.sessionRequests("start the work")
                    .find((r) => (r.body.messages ?? []).some((m) => m.role === "user" && messageText(m).includes("[STEERING from Alice")));
                assert(steered, "a model request carried the framed steer");

                const events = await catalog.getSessionEvents(session.sessionId, undefined, 500);
                const um = events.filter((e) => e.eventType === "user.message" && e.data?.steering);
                assertEqual(um.length, 1, "one user.message projection with data.steering");
                assertEqual(um[0].data.steering.requestId, requestId);
                assertEqual(um[0].data.content, "focus on the tests");
                const windows = events.filter((e) => e.eventType === "session.steering_window_changed").map((e) => e.data.state);
                assertEqual(JSON.stringify(windows), JSON.stringify(["open", "quiesced", "closed"]));

                const after = await catalog.steerState(session.sessionId);
                assertEqual(after.steerable, false, "no window between turns");
                const late = await catalog.steerAccept({
                    sessionId: session.sessionId, requestId: "steer_late", idempotencyKey: "late", actor: ALICE,
                    content: "too late", contentHash: steeringContentHash("too late"),
                    epoch: receipt.target.transcriptEpoch, turnIndex: receipt.target.turnIndex,
                    incarnation: decodeSteeringTarget(receipt.expectedTarget).incarnation,
                });
                assertEqual(late.outcome, "no_active_turn", "between turns: typed refusal, never a queued message");
            } finally {
                hold.release();
                await catalog.close();
            }
        });
    });

    it("Stop after hand-off: future delivery discarded, history kept, Stop latency path unchanged", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
        const hold = holdTool();
        await withScriptedModel(env, { respond, tools: [hold.tool] }, async ({ client, qualifiedModel }) => {
            const catalog = await createCatalog(env);
            const mgmt = await createManagementClient(env);
            try {
                const session = await client.createSession({ model: qualifiedModel, tools: [hold.tool] });
                await ownSession(env, session.sessionId);
                await session.send("start the work");
                await waitFor(() => hold.started, 60_000, "the blocking tool");
                const handed = await acceptSteer(catalog, session.sessionId, "handed off", "k-handed");
                await waitFor(async () => (await catalog.steerGet(session.sessionId, handed.receipt.requestId))?.status === "submitted",
                    30_000, "the hand-off");

                const stop = await mgmt.stopSessionTurn(session.sessionId, { reason: "Stopped by test" });
                assert(stop.outcome === "stopped" || stop.outcome === "stop_forced", `stop outcome ${stop.outcome}`);
                hold.release();

                const r = await waitFor(async () => {
                    const x = await catalog.steerGet(session.sessionId, handed.receipt.requestId);
                    return x?.status === "closed" ? x : null;
                }, 30_000, "Stop closure");
                assertEqual(r.closureReason, "stopped");
                assert(["delivery_unconfirmed", "delivered_before_stop"].includes(r.disposition),
                    `a handed-off steer is never "not delivered" after Stop (got ${r.disposition})`);
                assertEqual(r.eligibility.state, "terminal");

                const state = await catalog.steerState(session.sessionId);
                assertEqual(state.steerable, false);
                await waitFor(async () => (await catalog.getSession(session.sessionId))?.state === "idle", 30_000, "idle after stop");
            } finally {
                hold.release();
                await mgmt.stop?.();
                await catalog.close();
            }
        });
    });

    it("flag off: no window is opened and acceptance is refused", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const hold = holdTool();
        await withScriptedModel(env, { respond, tools: [hold.tool] }, async ({ client, qualifiedModel }) => {
            const catalog = await createCatalog(env);
            try {
                const session = await client.createSession({ model: qualifiedModel, tools: [hold.tool] });
                const answer = session.sendAndWait("start the work", TIMEOUT);
                await waitFor(() => hold.started, 60_000, "the blocking tool");
                await sleep(1_500);
                const state = await catalog.steerState(session.sessionId);
                assertEqual(state.steerable, false, "flag off: no window");
                assertEqual(state.window, null);
                hold.release();
                assertEqual(await answer, "unsteered");
            } finally {
                hold.release();
                await catalog.close();
            }
        });
    });
});
