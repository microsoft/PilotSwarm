/**
 * Session turn control, phase A5: the crash matrix (Spec US-5, SC-004;
 * design 7.4; plan P10 fault points).
 *
 * Each case runs a turn on worker 1, a separate process armed to die at one
 * turn-control boundary (`PILOTSWARM_FAULT_INJECT=<point>:exit`). A Stop or a
 * steer is open at that moment, or arrives while worker 1 is dead; worker 2
 * then recovers the turn. Each case checks the outcome of every control
 * (exactly one outcome event), whether the model ran again, and that each
 * steer reaches the surviving conversation once (the model requests are the
 * conversation the model saw).
 *
 *   T3 turn start        turn.control.after-start
 *   T6 writeback         turn.control.after-writeback
 *   T7 save (commit)     turn.control.after-commit
 *   T8 turn end          turn.control.after-end
 *
 * The scripted model makes live steers deterministic without sleeps: while
 * a steer is expected, it keeps answering with a short tool call until a
 * request carries the steer, then it answers.
 *
 * Needs the turn-control orchestration (1.0.81 or later); skipped before it.
 * The stale-worker case (US-5 #7) is in turn-control-multi-worker.test.js.
 * Sessions without a store (US-5 #8, D4) keep today's re-run behaviour and
 * are covered by fault-injection-live.test.js.
 */
import { describe, it, beforeAll, afterEach } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { expectFaultDeath } from "../helpers/kill-harness.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    TURN_CONTROL_ORCHESTRATION, deferred, until, outcomesOf, awaitOutcome, copiesIn, forkedDeployment,
} from "../helpers/turn-control-harness.mjs";

const TIMEOUT = 420_000;
const REPLY_TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);
const MAX_WORK_STEPS = 60;

beforeAll(async () => { await preflightChecks(); });

const cleanups = [];
afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
        try { await fn(); } catch {}
    }
});

/**
 * A responder for one prompt. `step0` resolves when the turn's first model
 * call arrives (the model run started); `hold` (optional) keeps that call
 * open until it resolves. With `expect`, the model keeps working with short
 * tool calls until a request carries that text, then answers.
 */
function scripted(prompt, { expect = null, hold = null } = {}) {
    const step0 = deferred();
    const respond = async (_body, position, record) => {
        if (!position.lastUserText.includes(prompt) && !position.firstUserText.includes(prompt)) return { content: "ok" };
        if (position.step === 0) {
            step0.resolve();
            if (hold) await hold;
        }
        const seen = expect === null || JSON.stringify(record.body.messages).includes(expect);
        if (!seen && position.step < MAX_WORK_STEPS) {
            return { tools: [{ name: "bash", args: { command: "true", description: "work" } }] };
        }
        return { content: seen ? `answer:${prompt}` : `answer-without-steer:${prompt}` };
    };
    return { respond, step0: step0.promise };
}

const requestsFor = (d, prompt) => d.model.sessionRequests().filter((r) => JSON.stringify(r.body.messages).includes(prompt));

async function exactlyOneOutcome(d, sessionId, seq, expected, label) {
    assertEqual(await awaitOutcome(d.catalog, sessionId, seq, label), expected, `${label}: outcome`);
    assertEqual((await outcomesOf(d.catalog, sessionId, seq)).length, 1, `${label}: one outcome event`);
}

describe.skipIf(!TURN_CONTROL_ORCHESTRATION)("turn control: crash matrix (US-5)", () => {
    it("crash after T3, then a Stop: the retried turn ends stopped without a model run (US-5 #1)", { timeout: TIMEOUT }, async () => {
        const d = await forkedDeployment(getEnv(), cleanups);
        const prompt = "C1 summarize the plan";
        d.model.setResponder(scripted(prompt).respond);
        const one = await d.fork("c1-1", { faultInject: "turn.control.after-start:exit" });
        const { sessionId, session } = await d.session();
        await session.send(prompt);
        await expectFaultDeath(one, "c1");
        await d.kill(one);
        const stop = await d.stop(sessionId);
        await d.fork("c1-2");
        await exactlyOneOutcome(d, sessionId, stop.seq, "stopped", "c1");
        assertEqual(requestsFor(d, prompt).length, 0, "no model run on either worker");
    });

    it("crash after T3, then a steer: the retried turn folds it into its prompt; it reaches the conversation once (US-5 #1)", { timeout: TIMEOUT }, async () => {
        const d = await forkedDeployment(getEnv(), cleanups);
        const prompt = "C2 summarize the plan";
        const steer = "C2-STEER mention the risks";
        d.model.setResponder(scripted(prompt).respond);
        const one = await d.fork("c2-1", { faultInject: "turn.control.after-start:exit" });
        const { sessionId, session } = await d.session();
        await session.send(prompt);
        await expectFaultDeath(one, "c2");
        await d.kill(one);
        const added = await d.steer(sessionId, steer);
        await d.fork("c2-2");
        await session.wait(REPLY_TIMEOUT);
        await exactlyOneOutcome(d, sessionId, added.seq, "delivered", "c2");
        const requests = requestsFor(d, prompt);
        assert(requests.length > 0, "worker 2 ran the model");
        for (const r of requests) assertEqual(copiesIn(r, steer), 1, "the steer is in the conversation once");
    });

    for (const [point, label, rerun] of [
        ["turn.control.after-writeback", "after T6: the conversation was not saved, the retried turn folds the steer again (US-5 #2)", true],
        ["turn.control.after-commit", "after T7: the saved result is reused without a model run (US-5 #3)", false],
        ["turn.control.after-end", "after T8: nothing new is written (US-5 #4)", false],
    ]) {
        it(`crash ${label}; the live steer ends delivered and reaches the conversation once`, { timeout: TIMEOUT }, async () => {
            const d = await forkedDeployment(getEnv(), cleanups);
            const tag = point.split(".").pop();
            const prompt = `C-${tag} summarize the plan`;
            const steer = `STEER-${tag} mention the risks`;
            const go = deferred();
            const s = scripted(prompt, { expect: steer, hold: go.promise });
            d.model.setResponder(s.respond);
            const one = await d.fork(`${tag}-1`, { faultInject: `${point}:exit` });
            const { sessionId, session } = await d.session();
            await session.send(prompt);
            await s.step0;
            const added = await d.steer(sessionId, steer);
            go.resolve();
            await expectFaultDeath(one, tag);
            await d.kill(one);
            const before = requestsFor(d, prompt).length;
            await d.fork(`${tag}-2`);
            const answer = await session.wait(REPLY_TIMEOUT);
            assertEqual(answer, `answer:${prompt}`, "the answer the turn kept saw the steer");
            await exactlyOneOutcome(d, sessionId, added.seq, "delivered", tag);
            const after = requestsFor(d, prompt);
            if (rerun) {
                assert(after.length > before, "the turn ran again on worker 2");
                for (const r of after.slice(before)) assert(copiesIn(r, steer) <= 1, "the steer is in worker 2's conversation at most once");
                assertEqual(copiesIn(after.at(-1), steer), 1, "worker 2's final conversation has the steer once");
            } else {
                assertEqual(after.length, before, "the model did not run again");
            }
        });
    }

    for (const [point, tag] of [["turn.control.after-commit", "before T8"], ["turn.control.after-end", "after T8"]]) {
        it(`a stopped turn, crash ${tag}: the retried turn ends stopped again (US-5 #5)`, { timeout: TIMEOUT }, async () => {
            const d = await forkedDeployment(getEnv(), cleanups);
            const short = point.split(".").pop();
            const prompt = `C5-${short} run the long job`;
            const never = deferred();
            const s = scripted(prompt, { hold: never.promise });
            d.model.setResponder(s.respond);
            cleanups.push(async () => never.resolve());
            const one = await d.fork(`c5-${short}-1`, { faultInject: `${point}:exit` });
            const { sessionId, session } = await d.session();
            await session.send(prompt);
            await s.step0;
            const stop = await d.stop(sessionId);
            await expectFaultDeath(one, `c5-${short}`);
            await d.kill(one);
            const before = requestsFor(d, prompt).length;
            await d.fork(`c5-${short}-2`);
            await exactlyOneOutcome(d, sessionId, stop.seq, "stopped", `c5-${short}`);
            await until(async () => (await d.catalog.getSession(sessionId))?.state === "idle", "the session is idle", REPLY_TIMEOUT);
            assertEqual(requestsFor(d, prompt).length, before, "the model did not run again");
        });
    }

    it("a thrown error, then a Stop during the retry backoff: the retried turn ends stopped without a model run (US-5 #6)", { timeout: TIMEOUT }, async () => {
        const d = await forkedDeployment(getEnv(), cleanups);
        const prompt = "C6 summarize the plan";
        d.model.setResponder(scripted(prompt).respond);
        const worker = await d.fork("c6-1", { faultInject: "turn.control.before-send:throw" });
        const { sessionId, session } = await d.session();
        await session.send(prompt);
        await until(() => worker.faultFired(), "the turn threw", REPLY_TIMEOUT);
        const stop = await d.stop(sessionId);
        await exactlyOneOutcome(d, sessionId, stop.seq, "stopped", "c6");
        assertEqual(requestsFor(d, prompt).length, 0, "no model run");
    });
});
