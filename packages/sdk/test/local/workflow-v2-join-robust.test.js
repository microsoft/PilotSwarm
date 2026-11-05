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
 * Part 2:
 * - JK-11: the time limit decides while the run is paused: its active script is cut, nothing routes or starts until the
 *   resume, a late success loses, a repeated resume replays its receipt; a pause between the decision and its route.
 * - JK-18: a completion and a cancellation of the same branch work: whichever the store takes first stands; a retry with
 *   another cause relabels nothing; other runs stay untouched; a cut branch admits no new step; the report keeps every
 *   finished result, each branch once.
 * - JK-19: a parallel state's later visit is its own: an earlier visit's late end, timer, join and cleanup change nothing
 *   of it; each visit has its own deadline, items and winners; a second parallel state is isolated.
 * - JK-20: a real continue-as-new while a join of the first k waits keeps its deadline, its first winner and its
 *   branches; the time limit crossing in the new execution still decides once.
 * - JK-27: every wake lost: the backstop still joins, in commit order; duplicate and stray queue notices change nothing.
 * - JK-28: a cancel, a graceful stop and the run's own deadline against the join and the time limit: each end keeps its
 *   own kind, nothing routes after the run ended, and the parallel state is never called timed_out by them.
 * - JK-32: malformed internal envelopes to the join, branch end and time limit activities are refused with no change;
 *   claims in them never become successes; valid calls still work.
 * - J1b-T4: a winner whose terminal fails after the time limit gives way to the next success committed in time.
 * - J1cd-T5: a branch's last state is found through its chain when its terminal's id sorts first and the times are equal.
 * Part 5, the compiler and stored IR (no database):
 * - JK-01: every shape of `join` that is not all, all_required or { first: k } with k a safe integer from 1 to 64 is
 *   refused at its own path, never read as another; the accepted ones compile to their exact IR.
 * - JK-02: every bad time limit is refused (null is not "absent"); with one, a timed_out route is required even with a
 *   catchAll; without one it is refused; a timed_out route into a branch body is an unknown target; valid IR round-trips.
 * - JK-03: literal lists of 0, 1, 2 and 64 items against k = n, n + 1 and every branch; equal items stay separate; more
 *   than 64 items are refused; stored IR with a malformed join, time limit, concurrency or body is refused.
 * - JK-22: the stored IR version boundary: IR 9 read as at most IR 8 is refused (also with its header set to 8); an unknown
 *   later version is refused; a valid IR 8 reads back as IR 8. (A stand-in for an older worker: the current reader with
 *   maxIrVersion 8, not the 8d568890 build itself.)
 * Part 4 (J1b-T5):
 * - JK-14: a binding with fewer items than k blocks at once with every branch not started and nothing run, failFast or
 *   not; an empty join of every branch joins []; k = n joins in commit order with the wrapper, a join of every branch in
 *   item order without it.
 * - JK-24: the parallel state's outputSchema checks the joined output in its actual shape (the wrapper for the first k,
 *   the outputs for every branch); an invalid joined output is invalid_output and takes the failure route once, no other
 *   winner chosen; a report is never checked against it.
 * - JK-25: finished results stay exact in a report (Unicode, null); a report over the payload limit keeps every branch's
 *   index, end and cause and says truncated; a joined output over it is invalid_output, routed once.
 * - JK-26: only a succeeded terminal counts: a blocked terminal after a successful script, and a terminal that fails its
 *   output check, are failures; failFast at exactly n - k such failures still joins with the two true successes.
 *
 * Every timing or fault case first proves its stored precondition and that its hook was reached (O7); a missed window
 * fails as VOID, never as a pass. Branch scripts run as real script processes. No model runs.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";
import {
    commitOrder, elapsedResult, endOf, eventsOf, executionsOf, gate, joinBaseOf, joinDoc, joinRuntimeOn, pause, persisted, startJoin, until, within, yamlOf,
    branchRowsOf, JOIN_ACTOR, WORK,
} from "../helpers/workflow-v2-join-harness.js";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_AGENT_IR_VERSION, WORKFLOW_V2_JOIN_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_PARALLEL_MAX_ITEMS,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { controlWorkflowV2Run } from "../../src/workflow/v2/service.ts";
import {
    BRANCH_ROUTE, branchScopeId, registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_REQUEST_ACTIVITIES, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION,
    workflowEffectInstanceId, workflowLiveControllerInstanceId,
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

            // (C) Both at the deadline: the success's commit and the time limit run at once (the controller's elapse too). The
            // time limit contender is the registered elapse activity, as a delivery runs it (with the decision's events).
            // Either legal order may win; SQL's clock says which one did, and the decision must follow it.
            const both = await startJoin(base, doc());
            const bothFan = await ready(both);
            await until(async () => Date.now() >= bothFan.deadlineAt.getTime() - 15 || null, "the third run's deadline to come near", 10_000);
            const [success, elapse] = await Promise.all([
                base.store.completeNode(both.at(0, "hold"), elapsedResult()),
                workers[0].handlers[R.elapse]({}, { runId: both.runId, nodeExecutionIds: [both.fan] }).catch(error => ({ error })),
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

// ─── Part 2 ──────────────────────────────────────────────────

/** A join of the first 1 over a looping root: the parallel state runs twice (its second items from `count`), then `other`. */
const COUNT = "const round = context.input[0].output.round;\n"
    + "await setResult(round === 1 ? \"again\" : \"next\", { items: [{ seconds: 600, round: 2 }, { seconds: 600, round: 2 }, { seconds: 600, round: 2 }] });\n";
const branchBody = prefix => ({
    initial: `${prefix}work`,
    states: {
        [`${prefix}work`]: { type: "script", source: WORK, transition: { next: { ok: `${prefix}done`, bad: `${prefix}refused`, hold: `${prefix}hold` } } },
        [`${prefix}hold`]: { type: "wait", seconds: "${input.seconds}", transition: { next: { elapsed: `${prefix}done` } } },
        [`${prefix}done`]: { type: "terminal", outcome: "succeeded", output: "${input}" },
        [`${prefix}refused`]: { type: "terminal", outcome: "blocked", output: "${input}" },
    },
});
const loopDoc = () => ({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "join-visits", version: "1.0.0" },
    initialInput: { items: [{ seconds: 600, round: 1 }, { seconds: 600, round: 1 }] },
    initial: "fan",
    states: {
        fan: { type: "parallel", forEach: "${input.items}", concurrency: 3, join: { first: 1 }, timeoutSeconds: 120, body: branchBody(""),
            transition: { next: { joined: "count", blocked: "stuck", timed_out: "late", failure: "failed" } } },
        count: { type: "script", source: COUNT, transition: { next: { again: "fan", next: "other" } } },
        other: { type: "parallel", forEach: "${input.items}", concurrency: 2, join: { first: 1 }, body: branchBody("o"),
            transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } } },
        finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
        stuck: { type: "terminal", outcome: "blocked", output: "${input}" },
        late: { type: "terminal", outcome: "blocked", output: "${input}" },
        failed: { type: "terminal", outcome: "failed" },
    },
});
const deadlineText = async (base, id) => (await base.q(`SELECT deadline_at::text AS at FROM SCHEMA.workflow_node_executions WHERE node_execution_id = $1`, [id]))[0]?.at ?? null;
const rootIdsOf = async (base, runId) => (await base.store.listNodeExecutions(runId)).filter(node => node.scopeId === "root").map(node => node.nodeId);
const failedHold = { outcome: "execution_failed", resultKind: "runtime_error", valueText: canonicalJson({ code: "execution_failed", message: "no" }), winner: "controller" };

describe("J3 robust joins, part 2: the store (no controller)", () => {
    it("JK-18: completion first stands, cancellation first stands; a retry with another cause relabels nothing; other runs untouched; a cut branch admits no new step; the report keeps each branch once", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            // An unrelated run with work pending: nothing below touches it.
            const other = await storedRun(h, joinDoc({ items: WAITS(2), join: { first: 1 } }));
            await other.enterFan(WAITS(2), null);
            for (const index of [0, 1]) await other.hold(index);
            const otherBefore = await Promise.all([0, 1].map(index => h.store.readNodeExecution(other.at(index, "hold"))));

            // The first 2 of 4: branch 1 succeeded and ended, branch 2 failed, branch 3's work completes before the decision,
            // branch 4 still runs.
            const run = await storedRun(h, joinDoc({ items: WAITS(4), join: { first: 2 } }));
            await run.enterFan(WAITS(4), null);
            for (const index of [0, 1, 2, 3]) await run.hold(index);
            await run.succeed(0);
            await run.confirm(0);
            await h.store.completeNode(run.at(1, "hold"), failedHold);
            expect(await run.succeed(2), "completion first").toMatchObject({ won: true });
            await run.confirm(2);
            const joined = await run.join([]);
            expect(joined).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 0, output: { index: 0 } }, { index: 2, output: { index: 2 } }] } });
            expect(joined.cancelled).toEqual([run.at(3, "hold")]);
            // The completion stands with its output; the failure keeps its error; the cancelled work rejects a later completion.
            expect(await h.store.readNodeExecution(run.at(2, "hold"))).toMatchObject({ outcome: "elapsed", output: { index: 2 } });
            expect(await h.store.readNodeExecution(run.at(1, "hold"))).toMatchObject({ outcome: "execution_failed", resultKind: "runtime_error", error: { code: "execution_failed" } });
            expect(await run.succeed(3), "cancellation first").toMatchObject({ won: false, node: { outcome: "cancelled", winner: "join", error: { code: "cancelled" } } });
            // A retry with another cause and repeated scopes relabels nothing and records nothing new.
            const retry = await h.store.cancelBranchScopes({ runId: run.runId, scopeIds: [3, 3, 2, 1].map(index => branchScopeId(run.fan, index)), reason: "timeout" });
            const ids = retry.cancelled.map(item => item.nodeExecutionId);
            expect(new Set(ids).size, "each node once").toBe(ids.length);
            expect(ids).toEqual([run.at(3, "hold")]);
            expect(retry.cancelled[0].reason, "the first stored cause").toBe("join");
            expect(await h.store.readNodeExecution(run.at(3, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 500);
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled")).toHaveLength(1);
            // A cut branch admits no new step of its own.
            expect(await h.store.enterNode({
                runId: run.runId, nodeExecutionId: nodeExecutionIdFor(run.runId, branchScopeId(run.fan, 3), "hold", 2), scopeId: branchScopeId(run.fan, 3),
                nodeId: "hold", ordinal: 2, nodeType: "wait", predecessorId: run.at(3, "hold"), arrivalRoute: "elapsed",
                inputText: canonicalJson({ index: 3 }), kvRevision: 1, waitSeconds: 600, immediate: null,
            })).toMatchObject({ admitted: false, reason: "cut" });
            // The unrelated run is as it was.
            const otherAfter = await Promise.all([0, 1].map(index => h.store.readNodeExecution(other.at(index, "hold"))));
            expect(otherAfter.map(row => [row.state, row.outcome])).toEqual(otherBefore.map(row => [row.state, row.outcome]));

            // A blocked join's report: each branch once, the finished results kept.
            const blocked = await storedRun(h, joinDoc({ items: WAITS(3), join: { first: 2 } }));
            await blocked.enterFan(WAITS(3), null);
            for (const index of [0, 1, 2]) await blocked.hold(index);
            await blocked.succeed(0);
            await blocked.confirm(0);
            for (const index of [1, 2]) await h.store.completeNode(blocked.at(index, "hold"), failedHold);
            const decided = await blocked.join([]);
            expect(decided).toMatchObject({ result: "won", node: { outcome: "blocked", resultKind: "business" } });
            const report = decided.node.output;
            expect(report).toMatchObject({ joined: false, total: 3, needed: 2, succeeded: 1 });
            expect(report.branches.map(branch => branch.index)).toEqual([0, 1, 2]);
            expect(report.branches[0]).toMatchObject({ ended: "terminal", outcome: "succeeded", output: { index: 0 } });
            for (const index of [1, 2]) expect(report.branches[index]).toMatchObject({ ended: "error", outcome: "execution_failed", error: { code: "execution_failed" } });
        } finally {
            await h.stop();
        }
    });

    it("J1b-T4: a winner whose terminal fails after the time limit gives way to the next success committed in time", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const items = WAITS(3);
            const run = await storedRun(h, joinDoc({ items, join: { first: 1 }, timeoutSeconds: 2 }));
            await run.enterFan(items, 2);
            for (const index of [0, 1, 2]) await run.hold(index);
            await run.succeed(0);
            await run.succeed(1);
            const { deadlineAt } = await h.store.readNodeExecution(run.fan);
            await until(async () => Date.now() > deadlineAt.getTime() + 300 || null, "the time limit to pass", 10_000);
            // The time limit: the join is due with branch 1 (the first success); branch 3's work is cut.
            expect(await h.store.elapseParallelNode(run.fan)).toMatchObject({ result: "join_due", cancelled: [run.at(2, "hold")] });
            // Branch 1's terminal is admitted after the time limit and fails its output check: it is no success any more.
            expect(await h.store.enterNode({
                runId: run.runId, nodeExecutionId: run.at(0, "done"), scopeId: branchScopeId(run.fan, 0), nodeId: "done", ordinal: 1, nodeType: "terminal",
                predecessorId: run.at(0, "hold"), arrivalRoute: "elapsed", inputText: canonicalJson({ index: 0 }), kvRevision: 1, waitSeconds: null, immediate: null,
            })).toMatchObject({ admitted: true });
            await h.store.completeNode(run.at(0, "done"), { outcome: "invalid_output", resultKind: "runtime_error",
                valueText: canonicalJson({ code: "invalid_output", message: "The branch's output does not match its schema." }), winner: "controller" });
            // The next success committed in time takes its place: the join waits for its terminal, then joins with it.
            expect(await run.join([])).toMatchObject({ result: "wait" });
            await run.confirm(1);
            expect(await run.join([])).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 1, output: { index: 1 } }] } });
        } finally {
            await h.stop();
        }
    });

    it("J1cd-T5: a branch's last state is found through its chain when its terminal's id sorts first and the times are equal", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            // Runs until one whose branch 1 terminal id sorts before its wait's id (ids come from the run id: about one in two).
            let run = null;
            for (let attempt = 0; attempt < 40 && run === null; attempt += 1) {
                const candidate = await storedRun(h, joinDoc({ items: WAITS(2), join: { first: 1 } }));
                if (candidate.at(0, "done") < candidate.at(0, "hold")) run = candidate;
            }
            expect(run, "precondition: a run whose terminal id sorts first").not.toBeNull();
            await run.enterFan(WAITS(2), null);
            await run.hold(0);
            await run.hold(1);
            await run.succeed(0);
            await run.confirm(0);
            // The wait and the terminal at the same instant, entered and committed.
            const pair = [run.at(0, "hold"), run.at(0, "done")];
            await h.q(`UPDATE SCHEMA.workflow_node_executions SET entered_at = (SELECT min(entered_at) FROM SCHEMA.workflow_node_executions WHERE node_execution_id = ANY($1::text[])),
                completed_at = (SELECT max(completed_at) FROM SCHEMA.workflow_node_executions WHERE node_execution_id = ANY($1::text[])) WHERE node_execution_id = ANY($1::text[])`, [pair]);
            const same = await h.q(`SELECT entered_at::text AS e, completed_at::text AS c FROM SCHEMA.workflow_node_executions WHERE node_execution_id = ANY($1::text[])`, [pair]);
            expect(new Set(same.map(row => `${row.e}|${row.c}`)).size, "precondition: equal times").toBe(1);
            // The chain says the terminal is the branch's end: the join joins (a mis-sorted end would make it wait).
            expect(await run.join([])).toMatchObject({ result: "won", node: { outcome: "joined", output: [{ index: 0, output: { index: 0 } }] } });
        } finally {
            await h.stop();
        }
    });

    it("JK-32: malformed internal envelopes are refused with no change; claims in them never become successes; valid calls still work", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        try {
            // The registered handlers themselves, called directly with the real store (no runtime runs them).
            const handlers = new Map();
            registerWorkflowV2({ registerActivity: (name, fn) => handlers.set(name, fn), registerOrchestrationVersioned: () => {} }, {
                store: base.store, catalog: base.catalog, enabled: () => true,
                resolveToolBinding: async () => null,
                openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
                authorizeParentNotification: async () => false,
                notifyParent: async () => { throw new Error("These workflows notify no parent."); },
                deleteSession: async sessionId => base.catalog.softDeleteSession(sessionId),
                wakeBackstopMs: 500, workflowRequests: true,
                sessionQueue: { ...sessionQueueTransport(base.client), version: async () => "1.0.83" },
            });
            const ctx = { getClient: () => base.client, traceWarn: () => {}, traceInfo: () => {} };
            const call = (name, input) => handlers.get(name)(ctx, input);
            const firstK = await storedRun(base, joinDoc({ items: WAITS(3), join: { first: 2 } }));
            await firstK.enterFan(WAITS(3), null);
            for (const index of [0, 1, 2]) await firstK.hold(index);
            const another = await storedRun(base, joinDoc({ items: WAITS(2), join: { first: 1 } }));
            await another.enterFan(WAITS(2), null);
            for (const index of [0, 1]) await another.hold(index);
            await another.succeed(0);
            await another.confirm(0);
            const all = await storedRun(base, joinDoc({ items: WAITS(2) }));
            await all.enterFan(WAITS(2), null);
            for (const index of [0, 1]) await all.hold(index);
            await all.succeed(1);
            const snapshot = async () => ({
                rows: (await Promise.all([firstK, another, all].map(run => base.store.listNodeExecutions(run.runId))))
                    .flat().map(row => [row.nodeExecutionId, row.state, row.outcome, row.winner]),
                events: (await Promise.all([firstK, another, all].map(run => base.catalog.getSessionEvents(run.workflowSessionId, 0, 500)))).flat().length,
            });
            const before = await snapshot();
            const results = list => ({ runId: firstK.runId, parallelNodeExecutionId: firstK.fan, results: list });
            // The join: another run's parallel state, a state that is not a parallel state, an index out of range, an index
            // twice, an end kind that does not exist.
            await expect(call(R.join, { runId: firstK.runId, parallelNodeExecutionId: another.fan, results: [] })).rejects.toThrow(/is not a parallel state of run/);
            await expect(call(R.join, { runId: firstK.runId, parallelNodeExecutionId: firstK.at(0, "hold"), results: [] })).rejects.toThrow(/is not a parallel state/);
            await expect(call(R.join, results([{ index: 3, via: "terminal", nodeExecutionId: firstK.at(0, "hold") }]))).rejects.toThrow(/index is invalid/);
            await expect(call(R.join, results([{ index: 0, via: "not_started", nodeExecutionId: null }, { index: 0, via: "not_started", nodeExecutionId: null }])))
                .rejects.toThrow(/index is invalid/);
            await expect(call(R.join, results([{ index: 0, via: "won", nodeExecutionId: null }]))).rejects.toThrow(/is invalid/);
            // Claims of success (a pending state, another run's ended terminal) count for nothing: the store decides by its rows.
            expect(await call(R.join, results([{ index: 0, via: "terminal", nodeExecutionId: firstK.at(0, "hold") },
                { index: 1, via: "terminal", nodeExecutionId: another.at(0, "done") }]))).toEqual({ decided: false });
            // A join of every branch (IR 8): a branch's end that is another run's row, or another branch's, is refused.
            await expect(call(R.join, { runId: all.runId, parallelNodeExecutionId: all.fan, results: [
                { index: 0, via: "terminal", nodeExecutionId: another.at(0, "done") }, { index: 1, via: "terminal", nodeExecutionId: all.at(1, "hold") }] }))
                .rejects.toThrow(/ended without a decided state/);
            await expect(call(R.join, { runId: all.runId, parallelNodeExecutionId: all.fan, results: [
                { index: 0, via: "terminal", nodeExecutionId: all.at(1, "hold") }, { index: 1, via: "terminal", nodeExecutionId: all.at(1, "hold") }] }))
                .rejects.toThrow(/is not a state of branch 0/);
            // A branch end: another run's state, a root state, a state that is not a terminal.
            await expect(call(R.endBranch, { runId: firstK.runId, nodeExecutionId: another.at(0, "done") })).rejects.toThrow(/is not a branch state of run/);
            await expect(call(R.endBranch, { runId: firstK.runId, nodeExecutionId: firstK.fan })).rejects.toThrow(/is not a branch state of run/);
            await expect(call(R.endBranch, { runId: firstK.runId, nodeExecutionId: firstK.at(0, "hold") })).rejects.toThrow(/is not a terminal state/);
            // The time limit: another run's state.
            await expect(call(R.elapse, { runId: firstK.runId, nodeExecutionIds: [another.fan] })).rejects.toThrow(/is not a wait state or a receive state of run/);
            // Nothing changed: no state, no event.
            expect(await snapshot()).toEqual(before);

            // Valid calls work: two successes and their ends, then the join.
            await firstK.succeed(1);
            await firstK.succeed(0);
            for (const index of [1, 0]) {
                expect(await base.store.enterNode({
                    runId: firstK.runId, nodeExecutionId: firstK.at(index, "done"), scopeId: branchScopeId(firstK.fan, index), nodeId: "done", ordinal: 1,
                    nodeType: "terminal", predecessorId: firstK.at(index, "hold"), arrivalRoute: "elapsed", inputText: canonicalJson({ index }), kvRevision: 1,
                    waitSeconds: null, immediate: null,
                })).toMatchObject({ admitted: true });
                expect(await call(R.endBranch, { runId: firstK.runId, nodeExecutionId: firstK.at(index, "done") })).toMatchObject({ succeeded: true, outcome: "succeeded" });
            }
            expect(await call(R.join, results([{ index: 1, via: "terminal", nodeExecutionId: firstK.at(1, "done") },
                { index: 0, via: "terminal", nodeExecutionId: firstK.at(0, "done") }]))).toEqual({ decided: true, cut: "join" });
            expect(await base.store.readNodeExecution(firstK.fan)).toMatchObject({ outcome: "joined", output: [{ index: 1, output: { index: 1 } }, { index: 0, output: { index: 0 } }] });
            expect(await base.store.readNodeExecution(firstK.at(2, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            // The unrelated runs were not cut.
            expect(await base.store.readNodeExecution(another.at(1, "hold"))).toMatchObject({ state: "pending" });
            expect(await base.store.readNodeExecution(all.at(0, "hold"))).toMatchObject({ state: "pending" });
        } finally {
            await base.close();
        }
    });
});

describe("J3 robust joins, part 2: controller 1.9.0 (test-only)", () => {
    it("JK-11: the time limit decides while paused: the active script is cut, nothing routes or starts until the resume; a late success loses; a repeated resume replays", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const held = { runId: null, gate: gate() };
        const workers = [];
        const command = (run, operation, operationId) => controlWorkflowV2Run(base.host, run.workflowSessionId, { operation, runId: null, reason: null },
            { actor: JOIN_ACTOR, operationId });
        try {
            workers.push(await joinRuntimeOn(base, { wrap: {
                [R.join]: fn => async (ctx, input) => {
                    if (input?.runId === held.runId) { held.gate.arrive(); await held.gate.wait(); }
                    return fn(ctx, input);
                },
            } }));
            // The first 2 of 4, two at a time: branch 1 waits, branch 2's script runs a minute, branches 3 and 4 are queued.
            const run = await startJoin(base, joinDoc({ join: { first: 2 }, concurrency: 2, timeoutSeconds: 8,
                items: [{ seconds: 600 }, { ms: 60_000 }, { seconds: 600 }, { seconds: 600 }] }));
            await persisted(base, [run.at(0, "hold"), run.at(1, "work")], "branch 1's wait and branch 2's script at work");
            const fanBefore = await base.store.readNodeExecution(run.fan);
            const deadline = await deadlineText(base, run.fan);
            expect(Date.now(), "VOID (not a product result): set up after the time limit; run it again").toBeLessThan(fanBefore.deadlineAt.getTime() - 2_000);
            await command(run, "pause", "pause-1");
            // One success while paused, before the time limit.
            expect(await base.store.completeNode(run.at(0, "hold"), elapsedResult())).toMatchObject({ won: true });
            const [inTime] = await commitOrder(base, [run.at(0, "hold")], run.fan);
            expect(inTime.inTime, "precondition: the success is in time").toBe(true);
            // The time limit decides while paused: timed_out (1 of 2), the script is cut and its action stopped.
            const decided = await until(async () => {
                const row = await base.store.readNodeExecution(run.fan);
                return row?.state === "completed" ? row : null;
            }, "the time limit to decide while paused", 40_000);
            expect((await base.store.readRun(run.runId)).status).toBe("paused");
            expect(decided).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            expect(decided.error.details).toMatchObject({ timedOut: true, total: 4, needed: 2, succeeded: 1 });
            expect(decided.error.details.branches[0]).toMatchObject({ index: 0, nodeExecutionId: run.at(0, "hold"), outcome: "elapsed" });
            expect(decided.error.details.branches[0].late).toBeUndefined();
            expect(await base.store.readNodeExecution(run.at(1, "work"))).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            await until(async () => {
                const status = await base.client.getStatus(workflowEffectInstanceId(run.at(1, "work")));
                return status.status !== "Running" ? status : null;
            }, "the cut script's action to stop while paused", 30_000);
            // A late success loses; nothing routes and no queued branch starts while paused; the deadline stays.
            expect(await base.store.completeNode(run.at(1, "work"), { outcome: "ok", resultKind: "business", valueText: "{}", winner: "effect" }))
                .toMatchObject({ won: false });
            await pause(1_500);
            expect(await rootIdsOf(base, run.runId)).toEqual(["fan"]);
            for (const index of [2, 3]) expect(await branchRowsOf(base, run, index)).toEqual([]);
            expect(await deadlineText(base, run.fan)).toBe(deadline);
            // The resume, twice with one operation id: the second is a replay; one route to `late`.
            expect(await command(run, "resume", "resume-1")).toMatchObject({ replayed: false });
            expect(await command(run, "resume", "resume-1")).toMatchObject({ replayed: true });
            expect(await endOf(base, run.runId)).toMatchObject({ status: "completed", terminalNodeId: "late" });
            expect(await rootIdsOf(base, run.runId)).toEqual(["fan", "late"]);
            await expect(command(run, "resume", "resume-2")).rejects.toMatchObject({ code: "RUN_ENDED" });
            expect(decisionsOf(await eventsOf(base, run.workflowSessionId), run.fan)).toHaveLength(1);
            for (const index of [2, 3]) expect(await branchRowsOf(base, run, index)).toEqual([]);

            // A pause between the decision and its route: the join that cuts the branches is held while the run is paused.
            const between = await startJoin(base, joinDoc({ items: WAITS(2), join: { first: 1 }, concurrency: 2, timeoutSeconds: 8 }));
            await persisted(base, [0, 1].map(index => between.at(index, "hold")), "both waits pending");
            held.runId = between.runId;
            await within(held.gate.reached, 40_000, "the join after the time limit to reach the gate");
            expect(await base.store.readNodeExecution(between.fan), "precondition: decided").toMatchObject({ state: "completed", outcome: "timed_out" });
            await command(between, "pause", "pause-1");
            held.runId = null;
            held.gate.open();
            await pause(1_500);
            expect((await base.store.readRun(between.runId)).status).toBe("paused");
            expect(await rootIdsOf(base, between.runId), "no route while paused").toEqual(["fan"]);
            const resumedAt = Date.now();
            await command(between, "resume", "resume-1");
            expect(await endOf(base, between.runId)).toMatchObject({ terminalNodeId: "late" });
            const lateRow = (await base.store.listNodeExecutions(between.runId)).find(node => node.nodeId === "late");
            // The route came after the resume, not in the 1.5 s while paused (a second of slack for the two clocks).
            expect(lateRow.enteredAt.getTime(), "routed after the resume").toBeGreaterThanOrEqual(resumedAt - 1_000);
        } finally {
            held.gate.open();
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-19: a later visit of a parallel state is its own: the earlier visit's late end, timer, join and cleanup change nothing of it; a second parallel state stays apart", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base));
            const run = await startJoin(base, loopDoc());
            const first = run.fan;
            const second = nodeExecutionIdFor(run.runId, "root", "fan", 2);
            const at = (fan, index, nodeId) => nodeExecutionIdFor(run.runId, branchScopeId(fan, index), nodeId, 1);
            await persisted(base, [0, 1].map(index => at(first, index, "hold")), "the first visit's waits pending");
            expect(await base.store.completeNode(at(first, 0, "hold"), elapsedResult({ seconds: 600, round: 1 }))).toMatchObject({ won: true });
            await persisted(base, [0, 1, 2].map(index => at(second, index, "hold")), "the second visit's waits pending");
            const [firstRow, secondRow] = await Promise.all([first, second].map(id => base.store.readNodeExecution(id)));
            expect(firstRow).toMatchObject({ outcome: "joined", output: [{ index: 0, output: { seconds: 600, round: 1 } }] });
            expect(secondRow).toMatchObject({ state: "pending" });
            expect(secondRow.input).toHaveLength(3);
            expect(firstRow.input).toHaveLength(2);
            expect(secondRow.deadlineAt.getTime(), "its own deadline").toBeGreaterThan(firstRow.deadlineAt.getTime());
            const secondDeadline = await deadlineText(base, second);
            const cutBefore = (await eventsOf(base, run.workflowSessionId)).filter(event => event.eventType === "workflow.branches_cancelled").length;
            // The first visit's late branch end, timer, join and cleanup.
            expect(await base.store.completeNode(at(first, 1, "hold"), elapsedResult({ seconds: 600, round: 1 }))).toMatchObject({ won: false });
            expect(await base.store.elapseParallelNode(first)).toMatchObject({ result: "decided", node: { outcome: "joined" } });
            expect(await base.store.decideParallelJoin({ nodeExecutionId: first, notStarted: [], joined: joinedValue })).toMatchObject({ result: "decided" });
            await base.store.cancelBranchScopes({ runId: run.runId, scopeIds: [0, 1].map(index => branchScopeId(first, index)), reason: "timeout" });
            // The second visit is as it was: pending, its waits pending, its deadline, no cut recorded for it.
            expect(await base.store.readNodeExecution(second)).toMatchObject({ state: "pending" });
            for (const index of [0, 1, 2]) expect(await base.store.readNodeExecution(at(second, index, "hold"))).toMatchObject({ state: "pending" });
            expect(await deadlineText(base, second)).toBe(secondDeadline);
            expect((await eventsOf(base, run.workflowSessionId)).filter(event => event.eventType === "workflow.branches_cancelled")).toHaveLength(cutBefore);
            // Its own winner, then the second parallel state.
            expect(await base.store.completeNode(at(second, 2, "hold"), elapsedResult({ seconds: 600, round: 2 }))).toMatchObject({ won: true });
            const otherFan = nodeExecutionIdFor(run.runId, "root", "other", 1);
            await persisted(base, [0, 1].map(index => nodeExecutionIdFor(run.runId, branchScopeId(otherFan, index), "ohold", 1)), "the other parallel state's waits pending");
            expect(await base.store.readNodeExecution(second)).toMatchObject({ outcome: "joined", output: [{ index: 2, output: { seconds: 600, round: 2 } }] });
            expect(await base.store.readNodeExecution(at(first, 0, "hold")), "the first visit's rows unchanged").toMatchObject({ outcome: "elapsed" });
            expect(await base.store.completeNode(nodeExecutionIdFor(run.runId, branchScopeId(otherFan, 1), "ohold", 1), elapsedResult({ round: 3 })))
                .toMatchObject({ won: true });
            expect(await endOf(base, run.runId)).toMatchObject({ terminalNodeId: "finished", terminalOutput: [{ index: 1, output: { round: 3 } }] });
            expect(await rootIdsOf(base, run.runId)).toEqual(["fan", "count", "fan", "count", "other", "finished"]);
            const events = await eventsOf(base, run.workflowSessionId);
            for (const fan of [first, second, otherFan]) expect(decisionsOf(events, fan), fan).toHaveLength(1);
            // Each visit's cut named only its own branches.
            const cuts = events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data.scopeIds);
            expect(cuts).toEqual([[branchScopeId(first, 1)], [0, 1].map(index => branchScopeId(second, index)), [branchScopeId(otherFan, 0)]]);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-20 (HG-4): a real continue-as-new while a join of the first k waits keeps its deadline, its first winner and its branches; a time limit crossed in the new execution decides once", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            // A 100 ms backstop: 50 idle waits (the continue-as-new bound) pass in seconds.
            workers.push(await joinRuntimeOn(base, { wakeBackstopMs: 100 }));
            const run = await startJoin(base, joinDoc({ items: WAITS(3), join: { first: 2 }, concurrency: 3, timeoutSeconds: 120 }));
            await persisted(base, [0, 1, 2].map(index => run.at(index, "hold")), "every wait pending");
            const deadline = await deadlineText(base, run.fan);
            expect(await base.store.completeNode(run.at(2, "hold"), elapsedResult({ seconds: 2 }))).toMatchObject({ won: true });
            await persisted(base, [run.at(2, "done")], "the first winner's end", "completed");
            const executionsBefore = (await executionsOf(base, run.controller)).length;
            await until(async () => (await executionsOf(base, run.controller)).length > executionsBefore || null, "a continue-as-new after the first success", 60_000);
            expect(await base.store.readNodeExecution(run.fan), "precondition: still waiting across it").toMatchObject({ state: "pending" });
            expect(await base.store.completeNode(run.at(0, "hold"), elapsedResult({ seconds: 0 }))).toMatchObject({ won: true });
            expect(await endOf(base, run.runId)).toMatchObject({ terminalNodeId: "finished",
                terminalOutput: [{ index: 2, output: { seconds: 2 } }, { index: 0, output: { seconds: 0 } }] });
            expect(await deadlineText(base, run.fan)).toBe(deadline);
            for (const [index, ids] of [[0, ["work", "hold", "done"]], [1, ["work", "hold"]], [2, ["work", "hold", "done"]]]) {
                expect((await branchRowsOf(base, run, index)).map(node => node.nodeId), `branch ${index + 1}, each state once`).toEqual(ids);
            }
            expect(await base.store.readNodeExecution(run.at(1, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            expect(await rootIdsOf(base, run.runId)).toEqual(["fan", "finished"]);
            expect(decisionsOf(await eventsOf(base, run.workflowSessionId), run.fan)).toHaveLength(1);

            // The time limit crosses in a later execution: decided once, by the deadline set at entry.
            const timed = await startJoin(base, joinDoc({ items: WAITS(3), join: { first: 2 }, concurrency: 3, timeoutSeconds: 20 }));
            await persisted(base, [0, 1, 2].map(index => timed.at(index, "hold")), "every wait pending");
            const timedDeadline = await deadlineText(base, timed.fan);
            const timedFan = await base.store.readNodeExecution(timed.fan);
            expect(await base.store.completeNode(timed.at(2, "hold"), elapsedResult({ seconds: 2 }))).toMatchObject({ won: true });
            const executionsAtStart = (await executionsOf(base, timed.controller)).length;
            await until(async () => (await executionsOf(base, timed.controller)).length > executionsAtStart || null, "a continue-as-new before the deadline", 60_000);
            expect(Date.now(), "VOID: the continue-as-new came after the deadline; run it again").toBeLessThan(timedFan.deadlineAt.getTime());
            const late = await endOf(base, timed.runId);
            expect(late).toMatchObject({ terminalNodeId: "late" });
            const decided = await base.store.readNodeExecution(timed.fan);
            expect(decided).toMatchObject({ outcome: "timed_out" });
            expect(decided.error.details).toMatchObject({ timedOut: true, needed: 2, succeeded: 1 });
            expect(decided.error.details.branches[2]).toMatchObject({ index: 2, ended: "terminal", outcome: "succeeded" });
            expect(decided.completedAt.getTime()).toBeGreaterThanOrEqual(decided.deadlineAt.getTime());
            expect(await deadlineText(base, timed.fan)).toBe(timedDeadline);
            expect(decisionsOf(await eventsOf(base, timed.workflowSessionId), timed.fan)).toHaveLength(1);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-27: every wake lost: the backstop still joins, in commit order; duplicate and stray queue notices change nothing", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        let dropped = 0;
        const drop = () => async () => { dropped += 1; return { woke: false }; };
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base, { wrap: { [R.wake]: drop, "workflow.v2.wake": drop } }));
            const run = await startJoin(base, joinDoc({ items: [{ ms: 200 }, { ms: 900 }, { seconds: 600 }], join: { first: 2 }, concurrency: 3, timeoutSeconds: 120 }));
            await persisted(base, [run.fan], "the parallel state pending");
            const deadline = await deadlineText(base, run.fan);
            // Stray notices on the controller's queue: duplicate wakes, wakes of no state and of another run, and others.
            for (let n = 0; n < 3; n += 1) {
                for (const notice of [{ type: "workflow-wake", runId: run.runId, nodeExecutionId: run.at(0, "work") }, { type: "workflow-wake", runId: run.runId },
                    { type: "workflow-wake", runId: randomUUID(), nodeExecutionId: randomUUID() }, { type: "note", text: "not for the workflow" }]) {
                    await base.client.enqueueEvent(run.controller, "messages", JSON.stringify(notice));
                }
            }
            const ended = await endOf(base, run.runId);
            expect(dropped, "precondition: the scripts' wakes were sent and lost").toBeGreaterThan(0);
            const works = [0, 1].map(index => run.at(index, "work"));
            const order = (await commitOrder(base, works)).map(row => works.indexOf(row.id));
            expect(ended).toMatchObject({ terminalNodeId: "finished" });
            expect(ended.terminalOutput.map(item => item.index), "in commit order").toEqual(order);
            expect(await deadlineText(base, run.fan)).toBe(deadline);
            for (const index of [0, 1, 2]) {
                expect((await branchRowsOf(base, run, index)).filter(node => node.nodeId === "work"), `branch ${index + 1} entered once`).toHaveLength(1);
            }
            expect(await base.store.readNodeExecution(run.at(2, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            expect(decisionsOf(await eventsOf(base, run.workflowSessionId), run.fan)).toHaveLength(1);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-28: a cancel, a graceful stop and the run's own deadline against the join and the time limit keep their own end kind; nothing routes after the run ended", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const held = { runId: null, gate: gate() };
        const workers = [];
        const command = (run, body, operationId) => controlWorkflowV2Run(base.host, run.workflowSessionId, { runId: null, reason: "enough", ...body },
            { actor: JOIN_ACTOR, operationId });
        try {
            workers.push(await joinRuntimeOn(base, { wrap: {
                [R.join]: fn => async (ctx, input) => {
                    if (input?.runId === held.runId) { held.gate.arrive(); await held.gate.wait(); }
                    return fn(ctx, input);
                },
            } }));
            // A cancel while the join is asked: whichever comes first, the end is a cancel or the join's route, never a timeout.
            const cancelled = await startJoin(base, joinDoc({ items: WAITS(2), join: { first: 1 }, concurrency: 2, timeoutSeconds: 120 }));
            await persisted(base, [0, 1].map(index => cancelled.at(index, "hold")), "both waits pending");
            held.runId = cancelled.runId;
            expect(await base.store.completeNode(cancelled.at(0, "hold"), elapsedResult())).toMatchObject({ won: true });
            await within(held.gate.reached, 30_000, "the join to reach the gate");
            expect(await command(cancelled, { operation: "cancel" }, "cancel-1")).toMatchObject({ replayed: false });
            expect(await command(cancelled, { operation: "cancel" }, "cancel-1"), "a repeat replays").toMatchObject({ replayed: true });
            held.runId = null;
            held.gate.open();
            const cancelledEnd = await endOf(base, cancelled.runId);
            const cancelledFan = await base.store.readNodeExecution(cancelled.fan);
            expect(cancelledFan.outcome).not.toBe("timed_out");
            if (cancelledEnd.status === "cancelled") {
                expect(await rootIdsOf(base, cancelled.runId), "nothing routed after the cancel").toEqual(["fan"]);
                expect(["joined", "cancelled"]).toContain(cancelledFan.outcome);
            } else {
                expect(cancelledEnd).toMatchObject({ status: "completed", terminalNodeId: "finished" });
            }
            expect(await base.store.readNodeExecution(cancelled.at(1, "hold")), "the other branch's work is ended").toMatchObject({ state: "completed" });

            // A graceful stop: the run is stopped, the parallel state ended by the stop, not by a timeout; its deadline stays.
            const stopped = await startJoin(base, joinDoc({ items: WAITS(2), join: { first: 1 }, concurrency: 2, timeoutSeconds: 120 }));
            await persisted(base, [0, 1].map(index => stopped.at(index, "hold")), "both waits pending");
            const stopDeadline = await deadlineText(base, stopped.fan);
            expect(await command(stopped, { operation: "stop", graceSeconds: 1 }, "stop-1")).toMatchObject({ replayed: false });
            expect(await command(stopped, { operation: "stop", graceSeconds: 1 }, "stop-1")).toMatchObject({ replayed: true });
            expect(await endOf(base, stopped.runId)).toMatchObject({ status: "stopped" });
            const stoppedFan = await base.store.readNodeExecution(stopped.fan);
            expect(stoppedFan.state).toBe("completed");
            expect(stoppedFan.outcome).not.toBe("timed_out");
            expect(await deadlineText(base, stopped.fan)).toBe(stopDeadline);
            expect(await rootIdsOf(base, stopped.runId)).toEqual(["fan"]);

            // The run's own deadline before the parallel time limit: the run fails timed_out; the parallel state is cancelled by
            // the run's deadline, not timed out by its own.
            const expiring = await startJoin(base, { ...joinDoc({ items: WAITS(2), join: { first: 1 }, concurrency: 2, timeoutSeconds: 120 }),
                limits: { timeoutSeconds: 6 } });
            await persisted(base, [0, 1].map(index => expiring.at(index, "hold")), "both waits pending");
            const expired = await endOf(base, expiring.runId);
            expect(expired).toMatchObject({ status: "failed", terminalError: { code: "timed_out" } });
            expect(await base.store.readNodeExecution(expiring.fan)).toMatchObject({ outcome: "cancelled", winner: "deadline" });
            expect(await rootIdsOf(base, expiring.runId)).toEqual(["fan"]);
        } finally {
            held.gate.open();
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });
});

// ─── Part 4: schemas, reports and payload sizes ─────────────

/** A value of about `bytes` bytes with a marker, null and Unicode in it. */
const bulky = (marker, bytes) => ({ marker, nothing: null, unicode: "üñï €𝄞 日本語", text: "x".repeat(bytes) });
/** Admit branch `index`'s terminal of `run` (storedRun) and decide it succeeded with `value` as its output. */
const confirmWith = async (h, run, index, value) => {
    expect(await h.store.enterNode({
        runId: run.runId, nodeExecutionId: run.at(index, "done"), scopeId: branchScopeId(run.fan, index), nodeId: "done", ordinal: 1, nodeType: "terminal",
        predecessorId: run.at(index, "hold"), arrivalRoute: "elapsed", inputText: canonicalJson(value), kvRevision: 1, waitSeconds: null, immediate: null,
    })).toMatchObject({ admitted: true });
    return h.store.completeNode(run.at(index, "done"), { outcome: "succeeded", resultKind: "business", valueText: canonicalJson(value), winner: "controller" });
};
/** A doc with the parallel state's outputSchema set. */
const withSchema = (doc, schema) => { doc.states.fan.outputSchema = schema; return doc; };

describe("J3 robust joins, part 4: reports and payload sizes in the store", () => {
    it("JK-25 (J1b-T5): finished results stay exact in a report; over the payload limit a report keeps every branch's index, end and cause and says truncated", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            /** A join of the first k of n: branches 1 to n - 1 succeed with `bytes`-sized outputs, the last fails; blocked. */
            const blockedWith = async (n, bytes) => {
                const run = await storedRun(h, joinDoc({ items: WAITS(n), join: { first: n } }));
                await run.enterFan(WAITS(n), null);
                for (let index = 0; index < n; index += 1) await run.hold(index);
                const values = [];
                for (let index = 0; index < n - 1; index += 1) {
                    await run.succeed(index);
                    values.push(bulky(`jk25-${n}-${index}`, bytes));
                    await confirmWith(h, run, index, values[index]);
                }
                await h.store.completeNode(run.at(n - 1, "hold"), failedHold);
                const decided = await run.join([]);
                expect(decided).toMatchObject({ result: "won", node: { outcome: "blocked", resultKind: "business" } });
                return { run, values, report: decided.node.output };
            };
            // Under the limit (two outputs of about 100 KB): every finished result exactly as stored.
            const under = await blockedWith(3, 100_000);
            expect(under.report).toMatchObject({ joined: false, timedOut: false, total: 3, needed: 3, succeeded: 2 });
            expect(under.report.truncated).toBeUndefined();
            expect(under.report.branches.map(branch => [branch.index, branch.ended, branch.outcome])).toEqual([
                [0, "terminal", "succeeded"], [1, "terminal", "succeeded"], [2, "error", "execution_failed"]]);
            for (const index of [0, 1]) expect(under.report.branches[index].output).toEqual(under.values[index]);
            expect(under.report.branches[2].error).toMatchObject({ code: "execution_failed" });
            // Over it (three of about 100 KB): every branch's index, end, cause and the counts; no output, and truncated.
            const over = await blockedWith(4, 100_000);
            expect(over.report).toMatchObject({ joined: false, timedOut: false, total: 4, needed: 4, succeeded: 3, truncated: true });
            expect(over.report.branches.map(branch => [branch.index, branch.ended, branch.outcome, branch.nodeExecutionId])).toEqual([
                [0, "terminal", "succeeded", over.run.at(0, "done")], [1, "terminal", "succeeded", over.run.at(1, "done")],
                [2, "terminal", "succeeded", over.run.at(2, "done")], [3, "error", "execution_failed", over.run.at(3, "hold")]]);
            for (const branch of over.report.branches) expect(branch.output === undefined && branch.error === undefined, `branch ${branch.index}`).toBe(true);
            // The stored report is whole JSON under the limit.
            const [stored] = await h.q(`SELECT octet_length(output::text) AS bytes FROM SCHEMA.workflow_node_executions WHERE node_execution_id = $1`, [over.run.fan]);
            expect(Number(stored.bytes)).toBeLessThan(256 * 1024);

            // A timed-out report over its limit: truncated too, with each branch's cause.
            const timed = await storedRun(h, joinDoc({ items: WAITS(4), join: { first: 4 }, timeoutSeconds: 3 }));
            await timed.enterFan(WAITS(4), 3);
            for (let index = 0; index < 4; index += 1) await timed.hold(index);
            for (let index = 0; index < 3; index += 1) {
                await timed.succeed(index);
                await confirmWith(h, timed, index, bulky(`jk25-timed-${index}`, 100_000));
            }
            const { deadlineAt } = await h.store.readNodeExecution(timed.fan);
            await until(async () => Date.now() > deadlineAt.getTime() + 300 || null, "the time limit to pass", 10_000);
            const elapsed = await h.store.elapseParallelNode(timed.fan);
            expect(elapsed).toMatchObject({ result: "elapsed", node: { outcome: "timed_out" } });
            const details = elapsed.node.error.details;
            expect(details).toMatchObject({ timedOut: true, total: 4, needed: 4, succeeded: 3, truncated: true });
            expect(details.branches.map(branch => [branch.index, branch.ended, branch.cancelledBy ?? null])).toEqual([
                [0, "terminal", null], [1, "terminal", null], [2, "terminal", null], [3, "cancelled", "timeout"]]);
        } finally {
            await h.stop();
        }
    });
});

describe("J3 robust joins, part 4: schemas and success on a native runtime (controller 1.9.0, test-only)", () => {
    it("JK-14: fewer items than k block at once with nothing run; an empty join of every branch joins []; k = n joins in commit order with the wrapper, a join of every branch in item order", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base));
            // A binding of 0, 1 and 2 items for a join of the first 3, with failFast and without: blocked at once.
            for (const failFast of [false, true]) {
                for (const n of [0, 1, 2]) {
                    const run = await startJoin(base, joinDoc({ items: WAITS(n), join: { first: 3 }, failFast }));
                    const ended = await endOf(base, run.runId);
                    expect(ended, `n ${n}, failFast ${failFast}`).toMatchObject({ terminalNodeId: "stuck" });
                    expect(ended.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: n, needed: 3, succeeded: 0, failFast });
                    expect(ended.terminalOutput.branches).toEqual(Array.from({ length: n }, (_, index) => ({
                        index, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null })));
                    const rows = await base.store.listNodeExecutions(run.runId);
                    expect(rows.filter(node => node.scopeId !== "root"), "nothing ran").toEqual([]);
                    expect(rows.map(node => node.nodeId)).toEqual(["fan", "stuck"]);
                }
            }
            // An empty join of every branch joins []; its outputSchema still checks it.
            expect(await endOf(base, (await startJoin(base, joinDoc({ items: [] }))).runId)).toMatchObject({ terminalNodeId: "finished", terminalOutput: [] });
            const emptyChecked = await startJoin(base, withSchema(joinDoc({ items: [] }), { type: "array", minItems: 1 }));
            expect(await endOf(base, emptyChecked.runId)).toMatchObject({ terminalNodeId: "failed" });
            expect(await base.store.readNodeExecution(emptyChecked.fan)).toMatchObject({ outcome: "invalid_output", resultKind: "runtime_error" });
            // A join of the first 1 over no items blocks, needing 1 (not a timeout).
            expect((await endOf(base, (await startJoin(base, joinDoc({ items: [], join: { first: 1 }, timeoutSeconds: 60 }))).runId)).terminalOutput)
                .toMatchObject({ joined: false, timedOut: false, total: 0, needed: 1 });

            // k = n against every branch, with the same items and the same commit order (2, 0, 1).
            const orderedRun = async join => {
                const run = await startJoin(base, joinDoc({ items: WAITS(3), ...(join ? { join } : {}), concurrency: 3 }));
                await persisted(base, [0, 1, 2].map(index => run.at(index, "hold")), "every wait pending");
                for (const index of [2, 0, 1]) {
                    expect(await base.store.completeNode(run.at(index, "hold"), elapsedResult({ v: index }))).toMatchObject({ won: true });
                    await pause(20);
                }
                return endOf(base, run.runId);
            };
            expect((await orderedRun({ first: 3 })).terminalOutput, "the first 3: commit order, with the wrapper")
                .toEqual([{ index: 2, output: { v: 2 } }, { index: 0, output: { v: 0 } }, { index: 1, output: { v: 1 } }]);
            expect((await orderedRun(null)).terminalOutput, "every branch: item order, the outputs alone").toEqual([{ v: 0 }, { v: 1 }, { v: 2 }]);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-24 (J1b-T5): outputSchema checks the joined output in its own shape; an invalid one is invalid_output, routed once, no other winner chosen; reports are never checked", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base));
            const winner = { type: "object", required: ["index", "output"], additionalProperties: false, properties: {
                index: { type: "integer" }, output: { type: "object", required: ["v"], additionalProperties: false, properties: { v: { type: "integer" } } } } };
            const firstTwo = { type: "array", minItems: 2, maxItems: 2, items: winner };
            const itemOutputs = { type: "array", items: { type: "object", required: ["v"], additionalProperties: false, properties: { v: { type: "integer" } } } };
            /** A run of `doc` over three waits whose branches succeed in order with `values` (by index). */
            const runWith = async (doc, values) => {
                const run = await startJoin(base, doc);
                await persisted(base, [0, 1, 2].map(index => run.at(index, "hold")), "every wait pending");
                for (const [index, value] of values) {
                    expect(await base.store.completeNode(run.at(index, "hold"), elapsedResult(value))).toMatchObject({ won: true });
                    await pause(20);
                }
                return { run, ended: await endOf(base, run.runId) };
            };
            // Valid: the first 2, in commit order, match the wrapper schema.
            const valid = await runWith(withSchema(joinDoc({ items: WAITS(3), join: { first: 2 }, concurrency: 3 }), firstTwo), [[1, { v: 1 }], [0, { v: 0 }]]);
            expect(valid.ended).toMatchObject({ terminalNodeId: "finished", terminalOutput: [{ index: 1, output: { v: 1 } }, { index: 0, output: { v: 0 } }] });
            // Invalid: a winner's output breaks it: invalid_output, the failure route once; branch 3's later success is no replacement.
            const invalid = await runWith(withSchema(joinDoc({ items: WAITS(3), join: { first: 2 }, concurrency: 3 }), firstTwo), [[0, { v: "x" }], [1, { v: 1 }]]);
            expect(invalid.ended).toMatchObject({ terminalNodeId: "failed" });
            expect(await base.store.readNodeExecution(invalid.run.fan)).toMatchObject({ outcome: "invalid_output", resultKind: "runtime_error" });
            expect(await rootIdsOf(base, invalid.run.runId)).toEqual(["fan", "failed"]);
            expect(await base.store.readNodeExecution(invalid.run.at(2, "hold")), "no other winner chosen").toMatchObject({ outcome: "cancelled", winner: "join" });
            expect(decisionsOf(await eventsOf(base, invalid.run.workflowSessionId), invalid.run.fan)).toHaveLength(1);
            // Every branch: the item outputs in order pass the outputs schema; the first 3 (the wrapper) do not pass it by accident.
            const all = await runWith(withSchema(joinDoc({ items: WAITS(3), concurrency: 3 }), itemOutputs), [[2, { v: 2 }], [0, { v: 0 }], [1, { v: 1 }]]);
            expect(all.ended).toMatchObject({ terminalNodeId: "finished", terminalOutput: [{ v: 0 }, { v: 1 }, { v: 2 }] });
            const wrapped = await runWith(withSchema(joinDoc({ items: WAITS(3), join: { first: 3 }, concurrency: 3 }), itemOutputs), [[2, { v: 2 }], [0, { v: 0 }], [1, { v: 1 }]]);
            expect(wrapped.ended).toMatchObject({ terminalNodeId: "failed" });
            expect(await base.store.readNodeExecution(wrapped.run.fan)).toMatchObject({ outcome: "invalid_output" });
            // A blocked join's report is not checked against outputSchema: it takes the blocked route with its documented shape.
            const blockedRun = await startJoin(base, withSchema(joinDoc({ items: WAITS(2), join: { first: 2 }, concurrency: 2 }), firstTwo));
            await persisted(base, [0, 1].map(index => blockedRun.at(index, "hold")), "both waits pending");
            // Both fail (without failFast the join blocks once every branch has ended).
            for (const index of [0, 1]) await base.store.completeNode(blockedRun.at(index, "hold"), failedHold);
            const blockedEnd = await endOf(base, blockedRun.runId);
            expect(blockedEnd).toMatchObject({ terminalNodeId: "stuck" });
            expect(blockedEnd.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: 2, needed: 2, succeeded: 0, failFast: false });
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-25: a joined output over the payload limit is invalid_output and takes the failure route once", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base));
            const run = await startJoin(base, joinDoc({ items: WAITS(2), join: { first: 2 }, concurrency: 2 }));
            await persisted(base, [0, 1].map(index => run.at(index, "hold")), "both waits pending");
            // Each output fits (about 140 KB); the two together, with the wrapper, do not.
            for (const index of [0, 1]) {
                expect(await base.store.completeNode(run.at(index, "hold"), elapsedResult(bulky(`jk25-joined-${index}`, 140_000)))).toMatchObject({ won: true });
            }
            expect(await endOf(base, run.runId)).toMatchObject({ terminalNodeId: "failed" });
            expect(await base.store.readNodeExecution(run.fan)).toMatchObject({ outcome: "invalid_output", resultKind: "runtime_error" });
            // Both branches' results are kept as they were stored.
            for (const index of [0, 1]) expect((await base.store.readNodeExecution(run.at(index, "done"))).output.marker).toBe(`jk25-joined-${index}`);
            expect(await rootIdsOf(base, run.runId)).toEqual(["fan", "failed"]);
            expect(decisionsOf(await eventsOf(base, run.workflowSessionId), run.fan)).toHaveLength(1);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });

    it("JK-26: only a succeeded terminal counts: a blocked end after a successful script and a terminal failing its check are failures; failFast at n - k of them still joins", { timeout: TIMEOUT }, async () => {
        const base = await joinBaseOf(getEnv());
        const workers = [];
        try {
            workers.push(await joinRuntimeOn(base));
            // Branch 1's script succeeds and routes to a blocked end; branch 2's script succeeds, but its terminal fails its
            // outputSchema (no `ok`); branches 3 and 4 succeed. The first 2 of 4 with failFast: 2 failures are n - k.
            const doc = joinDoc({ join: { first: 2 }, failFast: true, concurrency: 4,
                items: [{ fail: true, ms: 100 }, { ms: 300 }, { ms: 900, ok: true }, { ms: 1_500, ok: true }] });
            doc.states.fan.body.states.done.outputSchema = { type: "object", required: ["ok"] };
            const run = await startJoin(base, doc);
            const ended = await endOf(base, run.runId);
            expect(ended).toMatchObject({ status: "completed", terminalNodeId: "finished" });
            const works = [2, 3].map(index => run.at(index, "work"));
            const order = (await commitOrder(base, works)).map(row => works.indexOf(row.id) + 2);
            expect(ended.terminalOutput.map(item => item.index), "the two true successes, in commit order").toEqual(order);
            expect(await base.store.readNodeExecution(run.at(0, "work")), "branch 1's script itself succeeded").toMatchObject({ outcome: "bad", resultKind: "business" });
            expect(await base.store.readNodeExecution(run.at(0, "refused"))).toMatchObject({ outcome: "blocked", resultKind: "business" });
            expect(await base.store.readNodeExecution(run.at(1, "work"))).toMatchObject({ outcome: "ok", resultKind: "business" });
            expect(await base.store.readNodeExecution(run.at(1, "done"))).toMatchObject({ outcome: "invalid_output", resultKind: "runtime_error" });
            expect((await base.store.listNodeExecutions(run.runId)).filter(node => node.winner === "fail_fast"), "failFast cut nothing").toEqual([]);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.close();
        }
    });
});

// ─── Part 5: the compiler and stored IR ─────────────────────

const errorsOf = result => result.diagnostics.filter(item => item.severity === "error");
const LITERAL = [{ seconds: 1 }, { seconds: 2 }, { seconds: 3 }];
/** A join of the first 2 over a literal list of 3, with a 10-second time limit; `change(fan, doc)` edits it first. */
const compiledWith = (change = () => {}) => {
    const doc = joinDoc({ items: LITERAL, join: { first: 2 }, timeoutSeconds: 10 });
    doc.states.fan.forEach = structuredClone(LITERAL);
    change(doc.states.fan, doc);
    return compileWorkflowV2(yamlOf(doc), PARALLEL);
};
const readStored = (ir, maxIrVersion = WORKFLOW_V2_MILESTONE_IR_VERSION) => parseWorkflowIr(JSON.parse(canonicalJson(ir)), { maxIrVersion });

describe("J3 robust joins, part 5: the compiler and stored IR", () => {
    it("JK-01: every join shape but all, all_required and { first: k } (k a safe integer, 1 to 64) is refused at its own path; the accepted ones compile exactly", () => {
        const valid = compiledWith();
        expect(valid.valid, JSON.stringify(valid.diagnostics)).toBe(true);
        expect(valid.ir.irVersion).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
        expect(valid.ir.nodes.fan).toMatchObject({ join: { first: 2 }, timeoutSeconds: 10 });
        for (const join of [null, {}, { first: null }, { first: true }, { first: "2" }, { first: 1.5 }, { first: 0 }, { first: -1 }, { first: 2, extra: 1 },
            { first: "${input.k}" }, { first: 2 ** 53 }, { first: WORKFLOW_V2_PARALLEL_MAX_ITEMS + 1 }, { first: { k: 2 } }, "first", "any", ["all"], 2]) {
            const label = JSON.stringify(join);
            const result = compiledWith(fan => { fan.join = join; });
            expect(result.valid, label).toBe(false);
            const at = errorsOf(result).filter(item => item.path === "states.fan.join" || item.path === "states.fan.join.first");
            expect(at.length, `${label}: an error at the join`).toBeGreaterThan(0);
            expect(at.every(item => item.code === "WORKFLOW_FIELD_INVALID"), label).toBe(true);
        }
        // Omitted, all and all_required: a join of every branch.
        for (const join of [undefined, "all", "all_required"]) {
            const result = compiledWith(fan => { if (join === undefined) delete fan.join; else fan.join = join; });
            expect(result.valid, String(join)).toBe(true);
            expect(result.ir.nodes.fan.join).toBe("all_required");
        }
    });

    it("JK-02: every bad time limit is refused; with one a timed_out route is required even with a catchAll; a timed_out route into a body is unknown; valid IR round-trips", () => {
        for (const timeout of [null, 0, -1, 1.5, true, "10", "soon", 86_401]) {
            const result = compiledWith(fan => { fan.timeoutSeconds = timeout; });
            expect(result.valid, JSON.stringify(timeout)).toBe(false);
            expect(errorsOf(result).map(item => item.path), JSON.stringify(timeout)).toContain("states.fan.timeoutSeconds");
        }
        // A binding, read when the state starts.
        const bound = compiledWith((fan, doc) => { fan.timeoutSeconds = "${input.limit}"; doc.initialInput.limit = 5; });
        expect(bound.valid, JSON.stringify(bound.diagnostics)).toBe(true);
        expect(bound.ir.nodes.fan.timeoutSeconds).toBe("${input.limit}");
        // With a time limit and no timed_out route: refused, also when the workflow has a catchAll.
        const caught = compiledWith((fan, doc) => { delete fan.transition.next.timed_out; doc.catchAll = "failed"; });
        expect(caught.valid).toBe(false);
        expect(errorsOf(caught).map(item => [item.code, item.path])).toContainEqual(["WORKFLOW_ROUTE_MISSING", "states.fan.transition.next"]);
        // Without one, a timed_out route is refused.
        const untimed = compiledWith(fan => { delete fan.timeoutSeconds; });
        expect(untimed.valid).toBe(false);
        expect(errorsOf(untimed).map(item => [item.code, item.path])).toContainEqual(["WORKFLOW_ROUTE_INVALID", "states.fan.transition.next.timed_out"]);
        // A timed_out route into the branch body is no root state.
        const inside = compiledWith(fan => { fan.transition.next.timed_out = "done"; });
        expect(inside.valid).toBe(false);
        expect(errorsOf(inside).map(item => [item.code, item.path])).toContainEqual(["WORKFLOW_TARGET_UNKNOWN", "states.fan.transition.next.timed_out"]);
        // The accepted forms read back as compiled; the route leads to the root's late terminal only.
        for (const result of [compiledWith(), bound]) {
            expect(readStored(result.ir)).toEqual(result.ir);
            expect(result.ir.nodes.fan.next.timed_out).toBe("late");
        }
    });

    it("JK-03: literal lists against k = n, n + 1 and every branch; equal items stay separate; more than 64 refused; malformed stored IR refused", () => {
        for (const n of [0, 1, 2, WORKFLOW_V2_PARALLEL_MAX_ITEMS]) {
            const items = Array.from({ length: n }, (_, index) => ({ seconds: 1 + (index % 3) }));
            const literal = join => compiledWith(fan => { fan.forEach = items; if (join === undefined) delete fan.join; else fan.join = join; });
            if (n > 0) {
                const exact = literal({ first: n });
                expect(exact.valid, `k = n = ${n}`).toBe(true);
                expect(exact.ir.nodes.fan.join).toEqual({ first: n });
            }
            const over = literal({ first: n + 1 });
            expect(over.valid, `k = ${n + 1} over ${n} items`).toBe(false);
            expect(errorsOf(over).map(item => item.path).some(path => path === "states.fan.join.first" || path === "states.fan.join"), `n ${n}`).toBe(true);
            expect(literal(undefined).valid, `every branch of ${n}`).toBe(true);
        }
        // Equal items are separate branches.
        const equal = compiledWith(fan => { fan.forEach = [{ seconds: 1 }, { seconds: 1 }]; });
        expect(equal.valid, JSON.stringify(equal.diagnostics)).toBe(true);
        expect(equal.ir.nodes.fan.forEach).toEqual([{ seconds: 1 }, { seconds: 1 }]);
        // More than 64 items.
        const many = compiledWith(fan => { fan.forEach = Array.from({ length: WORKFLOW_V2_PARALLEL_MAX_ITEMS + 1 }, () => ({ seconds: 1 })); delete fan.join; });
        expect(many.valid).toBe(false);
        expect(errorsOf(many).map(item => item.path)).toContain("states.fan.forEach");

        // Stored IR: a malformed join, time limit, concurrency or body is refused; the valid one reads back.
        const stored = JSON.parse(canonicalJson(compiledWith().ir));
        expect(readStored(stored)).toEqual(compiledWith().ir);
        const withFan = change => ({ ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, ...change } } });
        for (const [label, broken] of [
            ["k negative", withFan({ join: { first: -1 } })],
            ["k missing", withFan({ join: {} })],
            ["k not an integer", withFan({ join: { first: 1.5 } })],
            ["k above 64", withFan({ join: { first: WORKFLOW_V2_PARALLEL_MAX_ITEMS + 1 } })],
            ["k with another field", withFan({ join: { first: 1, of: 3 } })],
            ["k an object", withFan({ join: { first: {} } })],
            ["a join word", withFan({ join: "any" })],
            ["time limit 0", withFan({ timeoutSeconds: 0 })],
            ["time limit over a day", withFan({ timeoutSeconds: 86_401 })],
            ["time limit true", withFan({ timeoutSeconds: true })],
            ["concurrency 0", withFan({ concurrency: 0 })],
            ["a body without its initial state", withFan({ body: { initial: stored.nodes.fan.body.initial, states: stored.nodes.fan.body.states.filter(id => id !== stored.nodes.fan.body.initial) } })],
            ["failFast missing", withFan({ failFast: undefined })],
        ]) {
            expect(() => readStored(JSON.parse(JSON.stringify(broken))), label).toThrow(/stored IR/);
        }
    });

    it("JK-22: IR 9 read as at most IR 8 is refused (also with its header set to 8); an unknown later version is refused; a valid IR 8 reads back as IR 8", () => {
        const ir9 = JSON.parse(canonicalJson(compiledWith().ir));
        expect(ir9.irVersion).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
        expect(() => readStored(ir9, WORKFLOW_V2_AGENT_IR_VERSION)).toThrow(/stored IR version 9 is not supported/);
        // The header set to 8 with the first k and the time limit kept: refused, never read as a join of every branch.
        expect(() => readStored({ ...ir9, irVersion: WORKFLOW_V2_AGENT_IR_VERSION })).toThrow(/stored IR parallel state fan is invalid/);
        const headerOnlyJoin = { ...ir9, irVersion: WORKFLOW_V2_AGENT_IR_VERSION, nodes: { ...ir9.nodes, fan: { ...ir9.nodes.fan, timeoutSeconds: undefined } } };
        expect(() => readStored(JSON.parse(JSON.stringify(headerOnlyJoin)))).toThrow(/stored IR parallel state fan is invalid/);
        // A later version than this worker reads.
        expect(() => readStored({ ...ir9, irVersion: WORKFLOW_V2_MILESTONE_IR_VERSION + 1 })).toThrow(new RegExp(`stored IR version ${WORKFLOW_V2_MILESTONE_IR_VERSION + 1} is not supported`));
        // A valid IR 8 (a join of every branch, no time limit) reads back as IR 8, by both readers.
        const ir8 = compileWorkflowV2(yamlOf(joinDoc({ items: LITERAL })), PARALLEL).ir;
        expect(ir8.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
        for (const max of [WORKFLOW_V2_AGENT_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION]) {
            const read = readStored(ir8, max);
            expect(read).toEqual(ir8);
            expect(read.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
            expect(read.nodes.fan.join).toBe("all_required");
            expect(read.nodes.fan.timeoutSeconds).toBeUndefined();
        }
    });
});
