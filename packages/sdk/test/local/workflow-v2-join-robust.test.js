/**
 * J3, part 1: robust tests of joins of the first k and the parallel time limit (test design join-k-of-n: JK-04, JK-05,
 * JK-06, JK-09, JK-10, JK-12 and JK-13, with the shared oracle O1 to O8 and hooks HG-1, HG-3 and HG-10; the review
 * gaps J1-T1, J1-T2, J1b-T1 to T3 that these cases close). Against the real store on PostgreSQL and controller 1.9.0
 * on a native duroxide runtime (test-only registration; workflow-v2-join-harness.js).
 *
 * - JK-04: the first k are the store's commit order, not the order results are delivered or branches admitted; a
 *   restart keeps the decision's bytes; equal outputs stay separate. In the store: equal SQL commit times tie by branch
 *   index, and unequal times less than a millisecond apart keep their order.
 * - JK-05: one branch's success counts once however often its end, its wakes and its collection repeat; a collection
 *   that lists one result twice fails the run visibly and never joins.
 * - JK-06: an acknowledgement lost after the join, a branch end or the time limit was stored: the redelivered activity
 *   finds the stored decision; one decision, one route, no queued branch started, no second terminal.
 * - JK-09: the time limit against the last success: success first (joined, the timer later finds it decided), time limit
 *   first (timed_out, a later success loses), and both at the deadline at once (one legal decision, by SQL's clock).
 * - JK-10: a contender that waits on the session lock across the deadline decides by the clock read after the lock: the
 *   time limit then decides; a success committed before the deadline still makes the join due; a success whose commit
 *   waited past the deadline is late. A later retry keeps the decision and the deadline.
 * - JK-12: no queued branch is admitted after the join decided; a branch admitted before it is cancelled for the join,
 *   never called not started; never more than `concurrency` branches at work.
 * - JK-13: exactly n - k failures still allow the join; one more blocks it (failFast cancels the rest; without failFast
 *   the rest run to their end); every finished result stays in the report.
 *
 * Every timing or fault case first proves its stored precondition and that its hook was reached (O7); a missed window
 * fails as VOID, never as a pass. Branch scripts run as real script processes. No model runs.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";
import {
    commitOrder, elapsedResult, endOf, eventsOf, gate, joinBaseOf, joinDoc, joinRuntimeOn, pause, persisted, startJoin, until, within, yamlOf,
    branchRowsOf, JOIN_ACTOR,
} from "../helpers/workflow-v2-join-harness.js";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import {
    BRANCH_ROUTE, branchScopeId, WORKFLOW_V2_REQUEST_ACTIVITIES, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const R = WORKFLOW_V2_REQUEST_ACTIVITIES;
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const PARALLEL = { enableRequests: true, enableAgents: true, enableParallel: true };
const WAITS = n => Array.from({ length: n }, () => ({ seconds: 600 }));
const joinedValue = value => ({ outcome: "joined", resultKind: "business", valueText: canonicalJson(value), winner: "controller" });
/** The events of the parallel state's decision (state_completed or state_failed for its node execution). */
const decisionsOf = (events, fan) => events.filter(event => event.data?.nodeExecutionId === fan
    && (event.eventType === "workflow.state_completed" || event.eventType === "workflow.state_failed"));
/** A row's decision as it is stored (O2): outcome, output or error, and when. */
const decisionOf = row => ({ outcome: row.outcome, value: canonicalJson(row.output ?? row.error ?? null), completedAt: row.completedAt?.toISOString() ?? null });

// ─── The store, without a controller (JK-04 ties, JK-10) ─────

/** A published workflow of `doc` with an admitted live run (no controller), as the join tests' storedRun. */
async function storedRun(h, doc) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const yaml = yamlOf(doc);
    const compiled = compileWorkflowV2(yaml, PARALLEL);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflowV2: { requestSha256: "join-robust" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: JOIN_ACTOR,
        operationId: "create", requestSha256: "join-robust", publish: true, title: "Workflow: join robust",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
    });
    const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
    const run = { workflowSessionId, runId, fan };
    const at = (index, nodeId) => nodeExecutionIdFor(runId, branchScopeId(fan, index), nodeId, 1);
    const enter = (index, nodeId, nodeType, predecessorId, arrivalRoute, waitSeconds = null) => h.store.enterNode({
        runId, nodeExecutionId: at(index, nodeId), scopeId: branchScopeId(fan, index), nodeId, ordinal: 1, nodeType, predecessorId,
        arrivalRoute, inputText: canonicalJson({ index }), kvRevision: 1, waitSeconds, immediate: null,
    });
    const result = (outcome, value) => ({ outcome, resultKind: "business", valueText: canonicalJson(value), winner: "controller" });
    return {
        ...run, at,
        /** The parallel state, entered with `items` and its time limit (`seconds`, null for none). */
        enterFan: (items, seconds) => h.store.enterNode({
            runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1, nodeType: "parallel", predecessorId: null, arrivalRoute: null,
            inputText: canonicalJson(items), kvRevision: 1, waitSeconds: seconds, immediate: null,
        }),
        hold: index => enter(index, "hold", "wait", fan, BRANCH_ROUTE, 600),
        succeed: index => h.store.completeNode(at(index, "hold"), result("elapsed", { index })),
        confirm: async index => {
            expect(await enter(index, "done", "terminal", at(index, "hold"), "elapsed"), `the terminal of branch ${index}`).toMatchObject({ admitted: true });
            return h.store.completeNode(at(index, "done"), result("succeeded", { index }));
        },
        join: (notStarted = []) => h.store.decideParallelJoin({ nodeExecutionId: fan, notStarted, joined: joinedValue }),
    };
}

/** Hold the workflow session's row lock (FOR NO KEY UPDATE, as the store's lockLiveSession) on a connection of its own. */
async function lockSession(h, workflowSessionId) {
    const locker = await h.pool.connect();
    await locker.query("BEGIN");
    await locker.query(`SELECT 1 FROM "${h.schema}".sessions WHERE session_id = $1 FOR NO KEY UPDATE`, [workflowSessionId]);
    return { async release() { try { await locker.query("COMMIT"); } finally { locker.release(); } } };
}

/** Arm the store's pool hook: `reached()` says a store transaction asked for the session row lock (HG-1 for SQL). */
function watchSessionLock(h) {
    const seen = { count: 0 };
    h.control.hook = ({ sql, params, query }) => {
        if (sql.includes(".sessions") && sql.includes("FOR NO KEY UPDATE")) seen.count += 1;
        return query(sql, params);
    };
    return { reached: () => seen.count > 0 || null, stop: () => { h.control.hook = null; } };
}

/** Some statement of this database waits on a lock (pg_stat_activity). */
const waitingOnLock = h => until(async () => (await h.q(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0].n > 0 || null, "a store statement to wait on the session lock", 5_000);

describe("J3 robust joins: the store's commit order and its clock (no controller)", () => {
    it("JK-04 (HG-3, J1b-T3): equal SQL commit times tie by branch index; times less than a millisecond apart keep their order", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const items = WAITS(3);
            // Equal times: branches 2 and 1 committed at the same instant: the lower index wins a join of the first 1.
            const tie = await storedRun(h, joinDoc({ items, join: { first: 1 } }));
            await tie.enterFan(items, null);
            for (const index of [0, 1, 2]) await tie.hold(index);
            await tie.succeed(2);
            await tie.succeed(1);
            const pair = [tie.at(1, "hold"), tie.at(2, "hold")];
            await h.q(`UPDATE SCHEMA.workflow_node_executions SET completed_at = (SELECT max(completed_at) FROM SCHEMA.workflow_node_executions
                WHERE node_execution_id = ANY($1::text[])) WHERE node_execution_id = ANY($1::text[])`, [pair]);
            const equal = await h.q(`SELECT completed_at::text AS at FROM SCHEMA.workflow_node_executions WHERE node_execution_id = ANY($1::text[])`, [pair]);
            expect(new Set(equal.map(row => row.at)).size, "precondition: one SQL commit time").toBe(1);
            // Branch 2's terminal is admitted and decided first; the tie still goes to branch 1 (it waits for its terminal).
            await tie.confirm(2);
            expect(await tie.join([])).toMatchObject({ result: "wait" });
            await tie.confirm(1);
            expect(await tie.join([])).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 1, output: { index: 1 } }] } });

            // Unequal by half a millisecond: branch 2 first, though a JavaScript date of each may read the same millisecond.
            const near = await storedRun(h, joinDoc({ items, join: { first: 1 } }));
            await near.enterFan(items, null);
            for (const index of [0, 1, 2]) await near.hold(index);
            await near.succeed(2);
            await near.succeed(1);
            await h.q(`UPDATE SCHEMA.workflow_node_executions SET completed_at = (SELECT completed_at FROM SCHEMA.workflow_node_executions
                WHERE node_execution_id = $2) + interval '500 microseconds' WHERE node_execution_id = $1`, [near.at(1, "hold"), near.at(2, "hold")]);
            const order = await h.q(`SELECT node_execution_id AS id FROM SCHEMA.workflow_node_executions WHERE node_execution_id = ANY($1::text[])
                ORDER BY completed_at`, [[near.at(1, "hold"), near.at(2, "hold")]]);
            expect(order.map(row => row.id), "precondition: branch 2 committed first, by half a millisecond").toEqual([near.at(2, "hold"), near.at(1, "hold")]);
            await near.confirm(1);
            expect(await near.join([])).toMatchObject({ result: "wait" });
            await near.confirm(2);
            expect(await near.join([])).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 2, output: { index: 2 } }] } });
        } finally {
            await h.stop();
        }
    });

    it("JK-10: a contender waiting on the session lock across the deadline decides by the clock after the lock; a later retry keeps the decision and the deadline", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const items = WAITS(2);
            const deadlineOf = async run => (await h.q(`SELECT deadline_at::text AS at, (extract(epoch FROM deadline_at) * 1000)::bigint AS ms
                FROM SCHEMA.workflow_node_executions WHERE node_execution_id = $1`, [run.fan]))[0];
            const prepared = async () => {
                const run = await storedRun(h, joinDoc({ items, join: { first: 1 }, timeoutSeconds: 2 }));
                await run.enterFan(items, 2);
                await run.hold(0);
                await run.hold(1);
                const deadline = await deadlineOf(run);
                expect(Date.now(), "VOID (not a product result): the case was set up after its deadline; run it again").toBeLessThan(Number(deadline.ms) - 800);
                return { run, deadline };
            };
            /** Start `contender` while the session row is locked, prove it waits, hold it past the deadline, release it. */
            const acrossDeadline = async (run, deadline, contender) => {
                const lock = await lockSession(h, run.workflowSessionId);
                const watch = watchSessionLock(h);
                let pending;
                try {
                    pending = contender();
                    await until(watch.reached, "the contender to ask for the session lock", 5_000);
                    await waitingOnLock(h);
                    expect(Date.now(), "VOID: the contender was not waiting before the deadline").toBeLessThan(Number(deadline.ms));
                    await until(async () => Date.now() > Number(deadline.ms) + 300 || null, "the deadline to pass while the contender waits", 5_000);
                } finally {
                    await lock.release();
                    watch.stop();
                }
                return await pending;
            };

            // (i) No success: the time limit, asked before the deadline, decides after the lock by the clock it reads then.
            const first = await prepared();
            expect(await h.store.elapseParallelNode(first.run.fan), "never before the deadline").toMatchObject({ result: "not_due" });
            expect(await acrossDeadline(first.run, first.deadline, () => h.store.elapseParallelNode(first.run.fan)))
                .toMatchObject({ result: "elapsed", node: { outcome: "timed_out", resultKind: "runtime_error" } });
            const [timed] = await h.q(`SELECT completed_at >= deadline_at AS after FROM SCHEMA.workflow_node_executions WHERE node_execution_id = $1`, [first.run.fan]);
            expect(timed.after).toBe(true);
            // A later retry finds it decided; the deadline never moves.
            expect(await h.store.elapseParallelNode(first.run.fan)).toMatchObject({ result: "decided", node: { outcome: "timed_out" } });
            expect((await deadlineOf(first.run)).at).toBe(first.deadline.at);

            // (ii) The success committed before the deadline; the join, asked before it, runs after it: the join is due (the
            // success counts), the other branch's work is cut at the time limit, and the join joins once its terminal is in.
            const second = await prepared();
            await second.run.succeed(0);
            expect((await commitOrder({ q: h.q }, [second.run.at(0, "hold")], second.run.fan))[0].inTime, "precondition: committed in time").toBe(true);
            expect(await acrossDeadline(second.run, second.deadline, () => second.run.join([]))).toMatchObject({ result: "wait", node: { state: "pending" } });
            expect(await h.store.readNodeExecution(second.run.at(1, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            await second.run.confirm(0);
            expect(await second.run.join([])).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 0, output: { index: 0 } }] } });
            expect(await h.store.elapseParallelNode(second.run.fan)).toMatchObject({ result: "decided", node: { outcome: "joined" } });
            expect((await deadlineOf(second.run)).at).toBe(second.deadline.at);

            // (iii) The success's commit began before the deadline but waited on the lock past it: it is stamped after the lock,
            // so it is late, and the time limit decides timed_out with it kept and marked late.
            const third = await prepared();
            expect(await acrossDeadline(third.run, third.deadline, () => third.run.succeed(0))).toMatchObject({ won: true });
            expect((await commitOrder({ q: h.q }, [third.run.at(0, "hold")], third.run.fan))[0].inTime, "stamped after the lock: late").toBe(false);
            const late = await h.store.elapseParallelNode(third.run.fan);
            expect(late).toMatchObject({ result: "elapsed", node: { outcome: "timed_out" } });
            expect(late.node.error.details).toMatchObject({ timedOut: true, needed: 1, succeeded: 0 });
            expect(late.node.error.details.branches[0]).toMatchObject({ index: 0, nodeExecutionId: third.run.at(0, "hold"), outcome: "elapsed", late: true });
        } finally {
            h.control.hook = null;
            await h.stop();
        }
    });
});

// ─── Controller 1.9.0 on a native runtime ────────────────────

describe("J3 robust joins: commit order, repeats and lost acknowledgements (controller 1.9.0, test-only)", () => {
    it("JK-04 (J1-T2): the first 2 of 4 are the commit order [3, 1], not the delivery, cursor or id order; equal outputs stay apart; a restart keeps the bytes", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const held = { on: false, gate: gate(), order: null };
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base, { wrap: {
                [R.collect]: fn => async (ctx, input) => {
                    if (held.on) { held.gate.arrive(); await held.gate.wait(); }
                    const answer = await fn(ctx, input);
                    // Results are delivered in branch order (0 and 1 before 3), never in the order the store committed them.
                    if (held.order && Array.isArray(answer?.collected)) answer.collected = [...answer.collected].sort((a, b) => held.order(a) - held.order(b));
                    return answer;
                },
            } }));
            const run = await startJoin(base, joinDoc({ items: WAITS(4), join: { first: 2 }, concurrency: 4 }));
            const holds = [0, 1, 2, 3].map(index => run.at(index, "hold"));
            await persisted(base, holds, "every branch's wait pending");
            held.order = item => holds.indexOf(item.nodeExecutionId);
            held.on = true;
            await within(held.gate.reached, 30_000, "the controller's collection to reach the gate");
            // Committed 3, then 1, then 0, while the collection waits; branch 2 runs on. Every output is the same value.
            for (const index of [3, 1, 0]) {
                expect(await base.store.completeNode(holds[index], elapsedResult())).toMatchObject({ won: true });
                await pause(20);
            }
            const order = await commitOrder(base, holds);
            expect(order.map(row => row.id), "precondition: the store's commit order").toEqual([holds[3], holds[1], holds[0]]);
            expect(order.map(row => row.rank)).toEqual([1, 2, 3]);
            held.on = false;
            held.gate.open();
            const won = [{ index: 3, output: { seconds: 600 } }, { index: 1, output: { seconds: 600 } }];
            expect(await endOf(base, run.runId)).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: won });
            const fanRow = await base.store.readNodeExecution(run.fan);
            expect(fanRow).toMatchObject({ outcome: "joined", resultKind: "business", output: won });
            // Branch 0 succeeded third: its result is kept, and it is no winner. Branch 2 was cut for the join.
            expect(await base.store.readNodeExecution(holds[0])).toMatchObject({ outcome: "elapsed", winner: "controller" });
            const done0 = await base.store.readNodeExecution(run.at(0, "done"));
            if (done0) expect(done0).toMatchObject({ outcome: "succeeded" });
            expect(await base.store.readNodeExecution(holds[2])).toMatchObject({ outcome: "cancelled", winner: "join" });
            // One decision, one route (O1); its bytes stay across a restart and more backstop periods (O2).
            const before = decisionOf(fanRow);
            const events = await eventsOf(base, run.workflowSessionId);
            expect(decisionsOf(events, run.fan)).toHaveLength(1);
            await workers.pop().stop();
            workers.push(await joinRuntimeOn(base));
            await pause(1_500);
            expect(decisionOf(await base.store.readNodeExecution(run.fan))).toEqual(before);
            expect(decisionsOf(await eventsOf(base, run.workflowSessionId), run.fan)).toHaveLength(1);
            expect((await base.store.listNodeExecutions(run.runId)).filter(node => node.scopeId === "root").map(node => node.nodeId)).toEqual(["fan", "finished"]);
        } finally {
            held.gate.open();
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-05 (J1b-T1): a branch's success counts once however often its end, its wakes and its collection repeat; a collection listing a result twice fails the run", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const ends = [];
        const joins = [];
        const twice = { id: null, done: false };
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base, { wrap: {
                // Each delivery of a branch end runs the real handler three times (a redelivered activity).
                [R.endBranch]: fn => async (ctx, input) => {
                    ends.push(input?.nodeExecutionId);
                    await fn(ctx, input);
                    await fn(ctx, input);
                    return fn(ctx, input);
                },
                [R.join]: fn => async (ctx, input) => {
                    const answer = await fn(ctx, input);
                    joins.push({ runId: input?.runId, decided: answer?.decided === true });
                    return answer;
                },
                // Once armed: the collection lists that result twice (a malformed answer).
                [R.collect]: fn => async (ctx, input) => {
                    const answer = await fn(ctx, input);
                    const found = twice.id && !twice.done ? answer?.collected?.find(item => item.nodeExecutionId === twice.id) : null;
                    if (found) {
                        twice.done = true;
                        answer.collected = [...answer.collected, { ...found }];
                    }
                    return answer;
                },
            } }));
            const run = await startJoin(base, joinDoc({ items: WAITS(3), join: { first: 2 }, concurrency: 3 }));
            const holds = [0, 1, 2].map(index => run.at(index, "hold"));
            await persisted(base, holds, "every branch's wait pending");
            expect(await base.store.completeNode(holds[0], elapsedResult())).toMatchObject({ won: true });
            // Duplicate wakes for it.
            for (let n = 0; n < 3; n++) {
                await base.client.enqueueEvent(run.controller, "messages", JSON.stringify({ type: "workflow-wake", runId: run.runId, nodeExecutionId: holds[0] }));
            }
            const done0 = run.at(0, "done");
            const ended0 = await persisted(base, [done0], "branch 1's end", "completed");
            await until(async () => joins.some(item => item.runId === run.runId) || null, "the join to be asked after branch 1's end", 30_000);
            expect(ends, "precondition: branch 1's end was delivered").toContain(done0);
            await pause(1_500);
            // One success of the two the join needs: it waits, whatever was repeated.
            expect(await base.store.readNodeExecution(run.fan)).toMatchObject({ state: "pending" });
            expect(joins.filter(item => item.runId === run.runId).every(item => !item.decided)).toBe(true);
            expect((await branchRowsOf(base, run, 0)).map(node => [node.nodeId, node.ordinal])).toEqual([["work", 1], ["hold", 1], ["done", 1]]);
            expect((await base.store.readNodeExecution(done0)).completedAt.getTime(), "the end is stored once").toBe(ended0[0].completedAt.getTime());
            // A second branch succeeds: the join joins with the two, in commit order.
            expect(await base.store.completeNode(holds[2], elapsedResult({ seconds: 2 }))).toMatchObject({ won: true });
            const output = [{ index: 0, output: { seconds: 600 } }, { index: 2, output: { seconds: 2 } }];
            expect(await endOf(base, run.runId)).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: output });
            const events = await eventsOf(base, run.workflowSessionId);
            expect(decisionsOf(events, run.fan)).toHaveLength(1);
            expect(events.filter(event => event.eventType === "workflow.state_completed" && event.data?.nodeExecutionId === done0)).toHaveLength(1);

            // A collection that lists one result twice is malformed: the run fails, visibly, and never joins on it.
            const malformed = await startJoin(base, joinDoc({ items: WAITS(2), join: { first: 2 }, concurrency: 2 }));
            const malformedHolds = [0, 1].map(index => malformed.at(index, "hold"));
            await persisted(base, malformedHolds, "the second run's waits pending");
            twice.id = malformedHolds[0];
            expect(await base.store.completeNode(malformedHolds[0], elapsedResult())).toMatchObject({ won: true });
            const failed = await endOf(base, malformed.runId);
            expect(twice.done, "precondition: the duplicated collection was delivered").toBe(true);
            expect(failed.status).toBe("failed");
            expect(JSON.stringify(failed.terminalError)).toContain("is not pending");
            expect((await base.store.readNodeExecution(malformed.fan)).outcome).not.toBe("joined");
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-06 (J1-T1): an acknowledgement lost after the join, a branch end or the time limit was stored: the redelivery finds the decision; one route, nothing started again", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const lost = { join: 0, endBranch: 0, elapse: 0 };
        const answers = { join: [], endBranch: [], elapse: [] };
        const runs = {};
        const collectGate = { on: false, gate: gate() };
        const workers = [];
        const loseOnce = (key, when) => fn => async (ctx, input) => {
            const answer = await fn(ctx, input);
            answers[key].push({ runId: input?.runId, answer });
            if (lost[key] === 0 && await when(input, answer)) {
                lost[key] += 1;
                throw new Error(`The acknowledgement of ${key} was lost after it was stored (test).`);
            }
            return answer;
        };
        try {
            workers.push(await joinRuntimeOn(base, { wrap: {
                [R.join]: loseOnce("join", (input, answer) => input?.runId === runs.join?.runId && answer?.decided === true),
                [R.endBranch]: loseOnce("endBranch", input => input?.runId === runs.end?.runId),
                [R.elapse]: loseOnce("elapse", async input => input?.runId === runs.elapse?.runId && Array.isArray(input?.nodeExecutionIds)
                    && input.nodeExecutionIds.includes(runs.elapse.fan) && (await base.store.readNodeExecution(runs.elapse.fan))?.state === "completed"),
                [R.collect]: fn => async (ctx, input) => {
                    if (collectGate.on && input?.runId === runs.join?.runId) { collectGate.gate.arrive(); await collectGate.gate.wait(); }
                    return fn(ctx, input);
                },
            } }));

            // The join: the first 2 of 4, three at a time; two winners, one loser at work and one queued.
            runs.join = await startJoin(base, joinDoc({ items: WAITS(4), join: { first: 2 }, concurrency: 3 }));
            const joinHolds = [0, 1, 2].map(index => runs.join.at(index, "hold"));
            await persisted(base, joinHolds, "three branches' waits pending");
            expect(await branchRowsOf(base, runs.join, 3), "precondition: branch 4 is queued").toEqual([]);
            collectGate.on = true;
            await within(collectGate.gate.reached, 30_000, "the collection to reach the gate");
            for (const index of [0, 1]) expect(await base.store.completeNode(joinHolds[index], elapsedResult({ seconds: index }))).toMatchObject({ won: true });
            collectGate.on = false;
            collectGate.gate.open();
            const joined = [{ index: 0, output: { seconds: 0 } }, { index: 1, output: { seconds: 1 } }];
            expect(await endOf(base, runs.join.runId)).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: joined });
            expect(lost.join, "precondition: an acknowledgement of the join was lost").toBe(1);
            const decidedJoins = answers.join.filter(item => item.runId === runs.join.runId && item.answer?.decided === true);
            expect(decidedJoins.length, "the join was delivered again after the lost acknowledgement").toBeGreaterThanOrEqual(2);
            const joinEvents = await eventsOf(base, runs.join.workflowSessionId);
            expect(decisionsOf(joinEvents, runs.join.fan)).toHaveLength(1);
            expect((await base.store.listNodeExecutions(runs.join.runId)).filter(node => node.nodeId === "finished")).toHaveLength(1);
            expect(await branchRowsOf(base, runs.join, 3), "no queued branch started after the join").toEqual([]);
            expect(await base.store.readNodeExecution(joinHolds[2])).toMatchObject({ outcome: "cancelled", winner: "join" });

            // A branch end: its terminal is decided once, and the join counts it once.
            runs.end = await startJoin(base, joinDoc({ items: WAITS(2), join: { first: 1 }, concurrency: 2 }));
            const endHolds = [0, 1].map(index => runs.end.at(index, "hold"));
            await persisted(base, endHolds, "both waits pending");
            expect(await base.store.completeNode(endHolds[0], elapsedResult())).toMatchObject({ won: true });
            expect(await endOf(base, runs.end.runId)).toMatchObject({ status: "completed", terminalOutput: [{ index: 0, output: { seconds: 600 } }] });
            expect(lost.endBranch, "precondition: an acknowledgement of the branch end was lost").toBe(1);
            expect(answers.endBranch.filter(item => item.runId === runs.end.runId).length).toBeGreaterThanOrEqual(2);
            const endEvents = await eventsOf(base, runs.end.workflowSessionId);
            expect(endEvents.filter(event => event.eventType === "workflow.state_completed" && event.data?.nodeExecutionId === runs.end.at(0, "done"))).toHaveLength(1);
            expect(decisionsOf(endEvents, runs.end.fan)).toHaveLength(1);
            expect(await base.store.readNodeExecution(endHolds[1])).toMatchObject({ outcome: "cancelled", winner: "join" });

            // The time limit: decided once; a join after it never writes joined.
            runs.elapse = await startJoin(base, joinDoc({ items: WAITS(2), join: { first: 1 }, concurrency: 2, timeoutSeconds: 8 }));
            await persisted(base, [0, 1].map(index => runs.elapse.at(index, "hold")), "both waits pending");
            const timedOut = await endOf(base, runs.elapse.runId);
            expect(timedOut).toMatchObject({ status: "completed", terminalNodeId: "late" });
            expect(lost.elapse, "precondition: an acknowledgement of the time limit was lost").toBe(1);
            const fanRow = await base.store.readNodeExecution(runs.elapse.fan);
            expect(fanRow).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            expect(await base.store.decideParallelJoin({ nodeExecutionId: runs.elapse.fan, notStarted: [], joined: joinedValue }))
                .toMatchObject({ result: "decided", node: { outcome: "timed_out" } });
            expect(await base.store.completeNode(runs.elapse.fan, joinedValue([]))).toMatchObject({ won: false });
            expect(decisionOf(await base.store.readNodeExecution(runs.elapse.fan))).toEqual(decisionOf(fanRow));
            expect(decisionsOf(await eventsOf(base, runs.elapse.workflowSessionId), runs.elapse.fan)).toHaveLength(1);
        } finally {
            collectGate.gate.open();
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-09 (J1b-T2): the time limit against the last success: success first, time limit first, and both at the deadline (one legal decision by SQL's clock)", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base));
            // Each case starts its own run when it begins, so its time limit (8 s, room for the scripts to start) is its own.
            const doc = () => joinDoc({ items: WAITS(3), join: { first: 1 }, concurrency: 2, timeoutSeconds: 8 });
            const ready = async run => {
                await persisted(base, [0, 1].map(index => run.at(index, "hold")), "two branches' waits pending");
                const fanRow = await base.store.readNodeExecution(run.fan);
                expect(Date.now(), "VOID (not a product result): set up after the time limit; run it again").toBeLessThan(fanRow.deadlineAt.getTime() - 1_000);
                return fanRow;
            };

            // (A) The success first: joined; the time limit, delivered again and again after the deadline, finds it decided.
            const first = await startJoin(base, doc());
            const firstFan = await ready(first);
            expect(await base.store.completeNode(first.at(0, "hold"), elapsedResult())).toMatchObject({ won: true });
            expect(await endOf(base, first.runId)).toMatchObject({ terminalNodeId: "finished", terminalOutput: [{ index: 0, output: { seconds: 600 } }] });
            await until(async () => Date.now() > firstFan.deadlineAt.getTime() + 300 || null, "the first run's deadline to pass", 10_000);
            const joinedRow = await base.store.readNodeExecution(first.fan);
            for (let n = 0; n < 3; n++) expect(await base.store.elapseParallelNode(first.fan)).toMatchObject({ result: "decided", node: { outcome: "joined" } });
            expect(decisionOf(await base.store.readNodeExecution(first.fan))).toEqual(decisionOf(joinedRow));
            expect(decisionsOf(await eventsOf(base, first.workflowSessionId), first.fan)).toHaveLength(1);

            // (B) The time limit first: timed_out; a success after it loses, and a join after it finds it decided.
            const timer = await startJoin(base, doc());
            await ready(timer);
            const timedRow = await until(async () => {
                const row = await base.store.readNodeExecution(timer.fan);
                return row?.state === "completed" ? row : null;
            }, "the time limit to decide the second run", 40_000);
            expect(timedRow).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            expect(await base.store.completeNode(timer.at(0, "hold"), elapsedResult())).toMatchObject({ won: false, node: { outcome: "cancelled", winner: "join_timeout" } });
            expect(await base.store.decideParallelJoin({ nodeExecutionId: timer.fan, notStarted: [], joined: joinedValue }))
                .toMatchObject({ result: "decided", node: { outcome: "timed_out" } });
            expect(await endOf(base, timer.runId)).toMatchObject({ terminalNodeId: "late" });
            expect(timedRow.error.details).toMatchObject({ timedOut: true, total: 3, needed: 1, succeeded: 0 });
            expect(timedRow.error.details.branches.map(branch => [branch.index, branch.ended])).toEqual([[0, "cancelled"], [1, "cancelled"], [2, "not_started"]]);
            expect(decisionOf(await base.store.readNodeExecution(timer.fan))).toEqual(decisionOf(timedRow));

            // (C) Both at the deadline: the success's commit and the time limit run at once (the controller's elapse too).
            // Either legal order may win; SQL's clock says which one did, and the decision must follow it.
            const both = await startJoin(base, doc());
            const bothFan = await ready(both);
            await until(async () => Date.now() >= bothFan.deadlineAt.getTime() - 15 || null, "the third run's deadline to come near", 10_000);
            const [success, elapse] = await Promise.all([
                base.store.completeNode(both.at(0, "hold"), elapsedResult()),
                base.store.elapseParallelNode(both.fan).catch(error => ({ error })),
            ]);
            expect(elapse.error).toBeUndefined();
            const ended = await endOf(base, both.runId);
            const hold0 = await base.store.readNodeExecution(both.at(0, "hold"));
            const [timing] = await commitOrder(base, [both.at(0, "hold")], both.fan);
            const bothRow = await base.store.readNodeExecution(both.fan);
            if (success.won && hold0.outcome === "elapsed" && timing.inTime === true) {
                // The success was committed by the deadline: it counts, and the join joins with it.
                expect(bothRow).toMatchObject({ outcome: "joined", output: [{ index: 0, output: { seconds: 600 } }] });
                expect(ended).toMatchObject({ terminalNodeId: "finished" });
            } else {
                // The time limit first, or the success after the deadline: timed_out, the success (if stored) marked late.
                expect(bothRow).toMatchObject({ outcome: "timed_out" });
                expect(ended).toMatchObject({ terminalNodeId: "late" });
                if (hold0.outcome === "elapsed") expect(bothRow.error.details.branches[0]).toMatchObject({ index: 0, late: true });
                else expect(hold0).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            }
            expect(decisionsOf(await eventsOf(base, both.workflowSessionId), both.fan)).toHaveLength(1);
            expect(await base.store.elapseParallelNode(both.fan)).toMatchObject({ result: "decided", node: { outcome: bothRow.outcome } });
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-12: no queued branch is admitted after the join decided; a branch admitted before it is cut for the join, never called not started; at most `concurrency` at work", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const held = { runId: null, gate: gate() };
        const workers = [];
        /** The most branches of `run` at work at once, from the stored rows: each branch from its first entry to its last decision. */
        const mostAtWork = async run => {
            const rows = (await base.store.listNodeExecutions(run.runId)).filter(node => node.scopeId !== "root");
            const spans = new Map();
            for (const node of rows) {
                const span = spans.get(node.scopeId) ?? { from: Infinity, to: -Infinity };
                span.from = Math.min(span.from, node.enteredAt.getTime());
                span.to = Math.max(span.to, node.completedAt ? node.completedAt.getTime() : Infinity);
                spans.set(node.scopeId, span);
            }
            const marks = [...spans.values()].flatMap(span => [[span.from, 1], [span.to, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            let now = 0, most = 0;
            for (const [, step] of marks) { now += step; most = Math.max(most, now); }
            return most;
        };
        try {
            workers.push(await joinRuntimeOn(base, { wrap: {
                [R.collect]: fn => async (ctx, input) => {
                    if (input?.runId === held.runId) { held.gate.arrive(); await held.gate.wait(); }
                    return fn(ctx, input);
                },
            } }));
            // The first 2 of 5, two at a time: both successes are collected together, so the join decides in the pass that
            // admits their terminals, and the slot the first one frees starts nothing.
            const together = await startJoin(base, joinDoc({ items: WAITS(5), join: { first: 2 }, concurrency: 2 }));
            await persisted(base, [0, 1].map(index => together.at(index, "hold")), "the first two branches' waits pending");
            held.runId = together.runId;
            await within(held.gate.reached, 30_000, "the collection to reach the gate");
            for (const index of [0, 1]) expect(await base.store.completeNode(together.at(index, "hold"), elapsedResult({ seconds: index }))).toMatchObject({ won: true });
            held.runId = null;
            held.gate.open();
            expect(await endOf(base, together.runId)).toMatchObject({ terminalNodeId: "finished",
                terminalOutput: [{ index: 0, output: { seconds: 0 } }, { index: 1, output: { seconds: 1 } }] });
            for (const index of [2, 3, 4]) expect(await branchRowsOf(base, together, index), `branch ${index + 1} never started`).toEqual([]);
            expect(await mostAtWork(together)).toBeLessThanOrEqual(2);

            // One at a time, the first 1: the queued branches never start.
            const single = await startJoin(base, joinDoc({ items: WAITS(3), join: { first: 1 }, concurrency: 1 }));
            await persisted(base, [single.at(0, "hold")], "the first branch's wait pending");
            expect(await branchRowsOf(base, single, 1), "precondition: one at a time").toEqual([]);
            expect(await base.store.completeNode(single.at(0, "hold"), elapsedResult())).toMatchObject({ won: true });
            expect(await endOf(base, single.runId)).toMatchObject({ terminalNodeId: "finished", terminalOutput: [{ index: 0, output: { seconds: 600 } }] });
            for (const index of [1, 2]) expect(await branchRowsOf(base, single, index)).toEqual([]);

            // The first 2 of 4, two at a time: the first success frees a slot, and branch 3 starts before the join decides.
            // When the second success decides it, branch 3 is cut for the join, and branch 4 never starts.
            const replaced = await startJoin(base, joinDoc({ items: WAITS(4), join: { first: 2 }, concurrency: 2 }));
            await persisted(base, [0, 1].map(index => replaced.at(index, "hold")), "the first two branches' waits pending");
            expect(await base.store.completeNode(replaced.at(0, "hold"), elapsedResult({ seconds: 0 }))).toMatchObject({ won: true });
            await persisted(base, [replaced.at(2, "hold")], "branch 3 started in the slot branch 1 freed (precondition)");
            expect(await base.store.readNodeExecution(replaced.fan)).toMatchObject({ state: "pending" });
            expect(await base.store.completeNode(replaced.at(1, "hold"), elapsedResult({ seconds: 1 }))).toMatchObject({ won: true });
            expect(await endOf(base, replaced.runId)).toMatchObject({ terminalNodeId: "finished",
                terminalOutput: [{ index: 0, output: { seconds: 0 } }, { index: 1, output: { seconds: 1 } }] });
            expect(await base.store.readNodeExecution(replaced.at(2, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            expect(await branchRowsOf(base, replaced, 3)).toEqual([]);
            const cut = (await eventsOf(base, replaced.workflowSessionId)).filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data);
            expect(cut).toEqual([expect.objectContaining({ scopeIds: [replaced.scope(2)], reason: "join" })]);
            expect(await mostAtWork(replaced)).toBeLessThanOrEqual(2);
        } finally {
            held.gate.open();
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-13: exactly n - k failures still allow the join; one more blocks it (failFast cuts the rest; without it they run to their end); finished results stay in the report", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base));
            // The first 3 of 5 with failFast: two failures (n - k) and three successes. failFast cuts nothing; the join joins
            // with the three, in the order the store committed them.
            const tolerated = await startJoin(base, joinDoc({ join: { first: 3 }, failFast: true, concurrency: 5,
                items: [{ fail: true, ms: 100 }, { fail: true, ms: 300 }, { ms: 1_500 }, { ms: 1_800 }, { ms: 2_100 }] }));
            const ended = await endOf(base, tolerated.runId);
            expect(ended).toMatchObject({ status: "completed", terminalNodeId: "finished" });
            const works = [2, 3, 4].map(index => tolerated.at(index, "work"));
            const order = (await commitOrder(base, works)).map(row => works.indexOf(row.id) + 2);
            expect(ended.terminalOutput.map(item => item.index), "the winners in their commit order").toEqual(order);
            expect([...order].sort()).toEqual([2, 3, 4]);
            for (const index of [0, 1]) expect(await base.store.readNodeExecution(tolerated.at(index, "refused"))).toMatchObject({ outcome: "blocked" });
            const tolerantRows = await base.store.listNodeExecutions(tolerated.runId);
            expect(tolerantRows.filter(node => node.winner === "fail_fast"), "failFast cut nothing").toEqual([]);

            // One failure more, with failFast: blocked at the third failure; the branch still at work is cut for it.
            const blocked = await startJoin(base, joinDoc({ join: { first: 3 }, failFast: true, concurrency: 4,
                items: [{ ms: 100 }, { fail: true, ms: 400 }, { fail: true, ms: 600 }, { fail: true, ms: 800 }, { seconds: 600 }] }));
            const blockedRun = await endOf(base, blocked.runId);
            expect(blockedRun).toMatchObject({ terminalNodeId: "stuck" });
            expect(blockedRun.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: 5, needed: 3, succeeded: 1, failFast: true });
            const ends = blockedRun.terminalOutput.branches.map(branch => [branch.index, branch.ended, branch.outcome]);
            expect(ends.slice(0, 4)).toEqual([[0, "terminal", "succeeded"], [1, "terminal", "blocked"], [2, "terminal", "blocked"], [3, "terminal", "blocked"]]);
            const fifth = blockedRun.terminalOutput.branches[4];
            if (fifth.ended === "cancelled") expect(fifth).toMatchObject({ cancelledBy: "failFast" });
            else expect(fifth).toMatchObject({ ended: "not_started" });
            expect(blockedRun.terminalOutput.branches[0]).toMatchObject({ output: expect.objectContaining({ index: 0 }) });

            // Without failFast the rest run to their end, then the join blocks; the late branch's success is in the report.
            const patient = await startJoin(base, joinDoc({ join: { first: 3 }, concurrency: 4,
                items: [{ ms: 100 }, { fail: true, ms: 400 }, { fail: true, ms: 600 }, { fail: true, ms: 800 }, { ms: 2_500 }] }));
            const patientRun = await endOf(base, patient.runId);
            expect(patientRun).toMatchObject({ terminalNodeId: "stuck" });
            expect(patientRun.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: 5, needed: 3, succeeded: 2, failFast: false });
            expect(patientRun.terminalOutput.branches[4]).toMatchObject({ index: 4, ended: "terminal", outcome: "succeeded" });
            expect((await base.store.listNodeExecutions(patient.runId)).filter(node => node.outcome === "cancelled"), "nothing was cut").toEqual([]);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });
});
