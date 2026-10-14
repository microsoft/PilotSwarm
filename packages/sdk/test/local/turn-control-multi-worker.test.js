/**
 * Session turn control, phase A5: a stale worker comes back (design 3.9,
 * 7.5; Spec US-5 #7; research O2-O4).
 *
 * Worker A runs a turn and is frozen (SIGSTOP), so it stops renewing its
 * activity lock; duroxide gives the same runTurn work item to worker B,
 * which finishes the turn. Then A goes on (SIGCONT):
 *
 *   M1  A was frozen during its model run: its lock renewal fails, the
 *       cancellation reaches the activity, and PilotSwarm aborts the turn
 *       within the 2 s poll (O2-O4, observed live). B's result stands.
 *   M2  A was parked just before its end-of-turn write (a P23 hold) and then
 *       frozen: B finishes and ends the turn first. A's late attempt finds
 *       the controls closed and the turn saved; it writes nothing new (it
 *       skips its turn end by P15, or the idempotent turn end repeats B's).
 *
 * Both cases check that the steer has exactly one outcome, `delivered`, and
 * that the store holds one commit for the turn.
 */
import { randomUUID } from "node:crypto";
import { describe, it, beforeAll, afterEach } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { killStoreDir } from "../helpers/kill-harness.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import {
    TURN_CONTROL_ORCHESTRATION, deferred, until, outcomesOf, awaitOutcome, copiesIn, forkedDeployment,
} from "../helpers/turn-control-harness.mjs";

// The frozen worker's session lock must expire before worker B gets the
// work item (~30-40 s; not exposed to Node).
const TIMEOUT = 420_000;
const REPLY_TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => { await preflightChecks(); });

const cleanups = [];
afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
        try { await fn(); } catch {}
    }
});

const requestsFor = (d, prompt) => d.model.sessionRequests().filter((r) => JSON.stringify(r.body.messages).includes(prompt));

async function oneCommit(env, sessionId) {
    const store = new FilesystemSessionStore(killStoreDir(env), env.sessionStateDir);
    const probe = await store.probeSnapshot(sessionId);
    assertEqual(probe?.version, 1, "the store holds exactly one commit of the turn");
}

describe.skipIf(!TURN_CONTROL_ORCHESTRATION)("turn control: a stale worker comes back (design 3.9)", () => {
    it("M1: frozen during its model run, worker A is cancelled within the poll after it resumes; B's result stands", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await forkedDeployment(env, cleanups);
        const prompt = "M1 summarize the plan";
        const steer = "M1-STEER mention the risks";
        const step0 = deferred();
        const never = deferred();
        cleanups.push(async () => never.resolve());
        let firstCalls = 0;
        d.model.setResponder(async (_body, position, record) => {
            if (!position.lastUserText.includes(prompt) && !position.firstUserText.includes(prompt)) return { content: "ok" };
            if (position.step === 0 && ++firstCalls === 1) {
                step0.resolve();
                await never.promise;                       // worker A's model call never answers
            }
            return { content: JSON.stringify(record.body.messages).includes(steer) ? `answer:${prompt}` : `answer-without-steer:${prompt}` };
        });
        // A observation probe: the cancel poll prints a fault-injection hit line.
        const a = await d.fork("m1-a", { faultInject: "turn.control.cancel-observed:log" });
        const { sessionId, session } = await d.session();
        await session.send(prompt);
        await step0.promise;
        d.pause(a);
        cleanups.push(async () => { try { d.resume(a); } catch {} });
        d.alive.delete("kill-m1-a");
        const added = await d.steer(sessionId, steer);
        await d.fork("m1-b");
        assertEqual(await session.wait(REPLY_TIMEOUT), `answer:${prompt}`, "worker B finished the turn with the steer");
        assertEqual(await awaitOutcome(d.catalog, sessionId, added.seq, "m1"), "delivered");

        const resumedAt = Date.now();
        d.resume(a);
        try {
            await until(() => a.logs.some((l) => l.includes("[fault-injection] hit point=turn.control.cancel-observed")),
                "m1: the cancellation reached worker A's activity", 60_000);
        } finally {
            console.log(`  M1 worker A log tail:\n${a.logs.slice(-25).join("\n")}`);
        }
        const cancelMs = Date.now() - resumedAt;
        console.log(`  M1: worker A saw the cancellation ${cancelMs} ms after it resumed`);
        assertEqual((await outcomesOf(d.catalog, sessionId, added.seq)).length, 1, "one outcome for the steer");
        await oneCommit(env, sessionId);
        const bRequests = requestsFor(d, prompt).slice(1);
        for (const r of bRequests) assert(copiesIn(r, steer) <= 1, "the steer is in worker B's conversation at most once");
    });

    it("M2: parked before its save and frozen, worker A resumes after B saved; its late attempt writes nothing new", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await forkedDeployment(env, cleanups);
        const prompt = "M2 summarize the plan";
        const steer = "M2-STEER mention the risks";
        const step0 = deferred();
        const go = deferred();
        d.model.setResponder(async (body, position, record) => {
            if (!position.lastUserText.includes(prompt) && !position.firstUserText.includes(prompt)) return { content: "ok" };
            const seen = JSON.stringify(record.body.messages).includes(steer);
            if (position.step === 0 && !seen) {
                step0.resolve();
                await go.promise;
            }
            if (!seen && position.step < 60) return { tools: [{ name: "bash", args: { command: "true", description: "work" } }] };
            return { content: seen ? `answer:${prompt}` : `answer-without-steer:${prompt}` };
        });
        const sessionId = randomUUID();
        const a = await d.fork("m2-a", { faultInject: `turn.control.before-writeback:hold@${sessionId},turn.control.after-end:log,turn.control.activity-end:log` });
        const { session } = await d.session({}, sessionId);
        await session.send(prompt);
        await step0.promise;
        const added = await d.steer(sessionId, steer);
        go.resolve();
        await until(() => a.logs.some((l) => l.includes("hold point=turn.control.before-writeback")), "m2: worker A is parked before its save", REPLY_TIMEOUT);
        d.pause(a);
        cleanups.push(async () => { try { d.resume(a); } catch {} });
        d.alive.delete("kill-m2-a");
        await d.fork("m2-b");
        assertEqual(await session.wait(REPLY_TIMEOUT), `answer:${prompt}`, "worker B finished the turn with the steer");
        assertEqual(await awaitOutcome(d.catalog, sessionId, added.seq, "m2"), "delivered", "worker B's turn end");
        await oneCommit(env, sessionId);

        d.resume(a);
        d.release("turn.control.before-writeback", sessionId);
        try {
            await until(() => a.logs.some((l) => l.includes("hit point=turn.control.activity-end")), "m2: worker A's attempt finished", 90_000);
        } finally {
            console.log(`  M2 worker A log tail:\n${a.logs.slice(-25).join("\n")}`);
        }
        // With B's turn end done, A's end-of-turn write finds no open controls,
        // so A skips its own turn end (plan P15); when it does run it, it
        // writes nothing new (idempotent). Either way the record is B's.
        console.log(`  M2: worker A ${a.logs.some((l) => l.includes("hit point=turn.control.after-end")) ? "ran" : "skipped"} its turn end`);
        const outcomes = await outcomesOf(d.catalog, sessionId, added.seq);
        assertEqual(outcomes.length, 1, "worker A's turn end wrote nothing new");
        assertEqual(outcomes[0].data.outcome, "delivered");
        await oneCommit(env, sessionId);
    });
});
