/**
 * Session turn control, phase A5: workspace leases (plan A5, owner guard on
 * workspace leases; design 3.x, 5.1).
 *
 * Turn control must not change the lease mechanism: a workspace is attached
 * in the runTurn gates and released by releaseAffinity and on worker
 * eviction or shutdown. These cases run on the reference repo-workspaces
 * deployment (`repo-workspaces.test.js`): a real git clone, the repo service
 * and its lease table, whose entries carry `workerNodeId` and `turnIndex`.
 * Worker loss is a real process death (the kill harness), so each worker is a
 * separate process with its own disk and the shared snapshot store; the model
 * is the scripted endpoint in this process.
 *
 *   W1  worker 1 lost mid-turn: the turn runs again on worker 2, the lease
 *       entry moves to worker 2 with the same turnIndex, the transcript has
 *       each item once.
 *   W2  as W1 with a Stop accepted while worker 1 is dead: turn start on
 *       worker 2 sees it, no model run, the turn ends stopped, the lease is
 *       on worker 2.
 *   W3  as W1 with a steer accepted while worker 1 is dead: delivered once on
 *       worker 2.
 *   W4  a stopped turn on a workspace session (during the run, and at start):
 *       idle, then the hold window releases the workspace and no entry stays.
 *   W5  graceful drain with a pending Stop: the Stop is applied before the
 *       drain ends, the release reason is shutdown, the next turn attaches on
 *       the other worker.
 *   W6  a late release from the old worker does not remove worker 2's entry.
 *
 * W2-W5 need the turn-control orchestration (1.0.81 or later, workstream B);
 * before it is registered they are skipped.
 */
import { describe, it, beforeAll, afterEach } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    TURN_CONTROL_ORCHESTRATION, deferred, firstLine, until, eventsWith, awaitOutcome, copiesIn, forkedDeployment,
} from "../helpers/turn-control-harness.mjs";

// Each worker loss pays duroxide's session-lock reclaim (~30-40 s) before
// the turn is dispatched again.
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

const deployment = (env) => forkedDeployment(env, cleanups, { workspaces: true });

/**
 * A turn whose first model step starts a long tool call in the clone. The
 * first attempt never finishes it: `onLongCall` resolves when the model has
 * handed the call out. A later attempt of the same turn runs a short call
 * and answers `done:<pwd>`.
 */
function longCallOnce(prompt) {
    const onLongCall = deferred();
    let firstSteps = 0;
    const respond = (_body, position) => {
        if (!position.lastUserText.includes(prompt)) return { content: "ok" };
        if (position.step === 0) {
            firstSteps += 1;
            if (firstSteps === 1) {
                onLongCall.resolve();
                return { tools: [{ name: "bash", args: { command: "sleep 600", description: "a long tool call" } }] };
            }
            return { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] };
        }
        return { content: `done:${firstLine(position.toolResults)}` };
    };
    return { respond, onLongCall: onLongCall.promise, attempts: () => firstSteps };
}

/**
 * Worker 1 runs the turn into a long tool call in the clone and dies; worker
 * 2 starts. `whileDead` runs between the two (for example, accept a Stop).
 * Returns the lease entry worker 1 held.
 */
async function loseWorkerMidTurn(d, { name, sessionId, session, checkout, prompt, longCall, whileDead }) {
    const one = await d.fork(`${name}-1`);
    await session.send(prompt);
    await longCall.onLongCall;
    const before = await until(() => d.entry(checkout, sessionId), `${name}: worker 1 attached the clone`);
    assertEqual(before.workerNodeId, `kill-${name}-1`, `${name}: worker 1 holds the entry`);
    await d.kill(one);
    if (whileDead) await whileDead();
    const two = await d.fork(`${name}-2`);
    return { before, one, two };
}

describe("turn control: workspace leases across worker loss", () => {
    it("W1 + W6: the turn runs again on worker 2, the lease entry moves with the same turnIndex, the transcript has each item once; a late release from worker 1 removes nothing", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await deployment(env);
        const prompt = "W1 run the long check in the clone";
        const longCall = longCallOnce(prompt);
        d.model.setResponder(longCall.respond);
        const { sessionId, session, checkout, clonePath } = await d.sessionInClone();

        const { before } = await loseWorkerMidTurn(d, { name: "w1", sessionId, session, checkout, prompt, longCall });
        const answer = await session.wait(REPLY_TIMEOUT);
        assertEqual(answer, `done:${clonePath}`, "the turn ran again on worker 2, in the clone");
        assertEqual(longCall.attempts(), 2, "the model saw the turn's first step once per attempt");

        const after = d.entry(checkout, sessionId);
        assert(after, "worker 2 holds an entry");
        assertEqual(after.workerNodeId, "kill-w1-2", "the entry moved to worker 2");
        assertEqual(after.turnIndex, before.turnIndex, "the same turn holds it");

        const prompts = await eventsWith(d.catalog, sessionId, "user.message", prompt);
        assertEqual(prompts.length, 1, `the prompt is in the transcript once: ${JSON.stringify(prompts.map((e) => ({ seq: e.seq, worker: e.workerNodeId, data: e.data })))}`);
        assertEqual((await eventsWith(d.catalog, sessionId, "assistant.message", `done:${clonePath}`)).length, 1, "the answer is in the transcript once");

        // W6: the release worker 1 would send, arriving after the move.
        const late = await fetch(new URL("/v1/leases", d.url), {
            method: "DELETE", headers: { "content-type": "application/json" },
            body: JSON.stringify({ checkout, sessionId, workerNodeId: before.workerNodeId, turnIndex: before.turnIndex }),
        }).then((r) => r.json());
        assertEqual(late.deleted, false, `a late release from worker 1 removes nothing: ${JSON.stringify(late)}`);
        assertEqual(d.entry(checkout, sessionId)?.workerNodeId, "kill-w1-2", "worker 2 still holds the entry");
    });

    it.skipIf(!TURN_CONTROL_ORCHESTRATION)("W2: a Stop accepted while worker 1 is dead ends the turn at turn start on worker 2, without a model run; the lease is on worker 2", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await deployment(env);
        const prompt = "W2 run the long check in the clone";
        const longCall = longCallOnce(prompt);
        d.model.setResponder(longCall.respond);
        const { sessionId, session, checkout } = await d.sessionInClone();

        let stopSeq = null;
        const { before } = await loseWorkerMidTurn(d, {
            name: "w2", sessionId, session, checkout, prompt, longCall,
            whileDead: async () => {
                const added = await d.stop(sessionId);
                assert(added.seq, `the Stop was accepted: ${JSON.stringify(added)}`);
                stopSeq = added.seq;
            },
        });
        assertEqual(await awaitOutcome(d.catalog, sessionId, stopSeq, "w2"), "stopped", "turn start on worker 2 applied the Stop");
        assertEqual(longCall.attempts(), 1, "worker 2 made no model call");
        const after = d.entry(checkout, sessionId);
        assertEqual(after?.workerNodeId, "kill-w2-2", "the lease is on worker 2");
        assertEqual(after?.turnIndex, before.turnIndex, "the same turn holds it");
    });

    it.skipIf(!TURN_CONTROL_ORCHESTRATION)("W3: a steer accepted while worker 1 is dead is delivered once on worker 2", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const d = await deployment(env);
        const prompt = "W3 run the long check in the clone";
        const steer = "W3-STEER also list the branch";
        let steerSeq = null;
        const longCall = longCallOnce(prompt);
        d.model.setResponder(longCall.respond);
        const { sessionId, session, checkout } = await d.sessionInClone();

        await loseWorkerMidTurn(d, {
            name: "w3", sessionId, session, checkout, prompt, longCall,
            whileDead: async () => { steerSeq = (await d.steer(sessionId, steer)).seq; },
        });
        await session.wait(REPLY_TIMEOUT);
        const withSteer = d.model.sessionRequests().filter((r) => JSON.stringify(r.body.messages).includes(steer));
        assert(withSteer.length > 0, "worker 2's model run carries the steer");
        for (const r of withSteer) assertEqual(copiesIn(r, steer), 1, "the steer is in the conversation once");
        assertEqual(await awaitOutcome(d.catalog, sessionId, steerSeq, "w3"), "delivered", "the steer ends delivered");
        assertEqual(d.entry(checkout, sessionId)?.workerNodeId, "kill-w3-2", "the lease is on worker 2");
    });
});
