import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import {
    requestFixture, REQUEST_ACTOR, REQUEST_TIMEOUT, checkpoint, reachedDuring, holdSession, observeBlocked, requestClock, requestLockSnapshot,
} from "../helpers/workflow-v2-request-fixture.js";
import { canonicalJson, jsonSha256 } from "../../src/workflow/v2/json.ts";
import { WORKFLOW_V2_MAX_REQUEST_OPERATIONS } from "../../src/workflow/v2/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const YES = { response: { approved: true } };
const NO = { response: { approved: false } };
const DECLINE = { decline: { reason: "not now" } };

async function concurrentCalls(h, run, exchangeId, calls) {
    const holder = await holdSession(h, run.workflowSessionId);
    const atLock = checkpoint();
    const pids = [];
    const locks = [];
    const directControls = [];
    let work;
    let settled;
    h.control.hook = ({ sql, params, query, client }) => {
        const mode = sql.includes("FOR NO KEY UPDATE") ? "NO KEY UPDATE" : sql.includes("FOR SHARE") ? "SHARE" : null;
        const lock = mode && sql.includes(".sessions") ? { pid: client.processID, sessionId: params[0], mode, returned: false } : null;
        if (lock) locks.push(lock);
        const result = query(sql, params);
        if (sql.includes(".sessions") && sql.includes("FOR NO KEY UPDATE") && params?.[0] === run.workflowSessionId) {
            pids.push(client.processID);
            if (pids.length === calls.length) atLock.enter();
        }
        return lock ? result.then(rows => { lock.returned = true; return rows; }) : result;
    };
    try {
        work = calls.map(({ operationId, call }) => h.respond(exchangeId, operationId, call));
        settled = Promise.allSettled(work);
        await reachedDuring(atLock, settled, "both session-lock queries");
        expect(new Set(pids).size).toBe(calls.length);
        for (const pid of pids) {
            await observeBlocked(h, pid, holder.pid);
            directControls.push(pid);
        }
        await holder.release();
        return await settled;
    } catch (error) {
        const sample = await requestLockSnapshot(h, [holder.pid, ...pids]);
        const knownDirect = sample.activity?.find(item => pids.includes(item.pid) && item.blockers.includes(holder.pid));
        if (knownDirect && !directControls.includes(knownDirect.pid)) {
            await observeBlocked(h, knownDirect.pid, holder.pid);
            directControls.push(knownDirect.pid);
        }
        console.info("workflow request lock diagnostic", JSON.stringify({
            holderPid: holder.pid, responsePids: pids, directControls,
            canonicalOrder: [run.workflowSessionId, h.parent].sort(),
            requesterSessionId: run.workflowSessionId, actorSessionId: h.parent, dispatchedLocks: locks,
            pool: { max: 4, total: h.pool.totalCount, idle: h.pool.idleCount, waiting: h.pool.waitingCount },
            ...sample,
        }));
        throw error;
    } finally {
        h.control.hook = null;
        await holder.release();
        if (settled) await settled;
    }
}

async function expectWinner(h, run, exchangeId, result, call, counts) {
    expect(result).toMatchObject({ kind: "accepted", replayed: false });
    const kind = Object.hasOwn(call, "response") ? "response" : "decline";
    const value = call[kind];
    const status = kind === "response" ? "responded" : "declined";
    expect(result.receipt).toMatchObject({ exchangeId, workflowSessionId: run.workflowSessionId, runId: run.runId,
        stateId: "ask", responderSessionId: h.parent, kind, resultSha256: jsonSha256({ kind, value }) });
    expect(await h.counts(exchangeId)).toEqual(counts);
    expect(await h.store.readRequest(exchangeId)).toMatchObject({ status, operations: counts.operations,
        response: { value, receipt: result.receipt, operationId: result.receipt.operationId, actorSessionId: h.parent },
        wake: { state: "pending", attempts: 0, settledAt: null } });
    expect(await h.store.listRequests(run.runId)).toEqual([await h.store.readRequest(exchangeId)]);
    const [row] = await h.q(`SELECT node.state, node.outcome, node.winner, node.output,
        node.completed_at = resp.decided_at AS same_completion,
        resp.decided_at = op.first_at AND op.first_at = op.last_at AS same_binding_time,
        wake.created_at = resp.decided_at AND wake.next_attempt_at = resp.decided_at AS same_wake_time,
        resp.decided_at < req.deadline_at AS in_time
        FROM SCHEMA.workflow_node_executions node
        JOIN SCHEMA.workflow_requests req ON req.exchange_id = node.node_execution_id
        JOIN SCHEMA.workflow_request_responses resp ON resp.exchange_id = req.exchange_id
        JOIN SCHEMA.workflow_request_operations op ON op.exchange_id = resp.exchange_id AND op.operation_id = resp.operation_id
        JOIN SCHEMA.workflow_response_wakes wake ON wake.exchange_id = resp.exchange_id WHERE req.exchange_id = $1`, [exchangeId]);
    expect(row).toEqual({ state: "completed", outcome: status, winner: "response", output: canonicalJson(value),
        same_completion: true, same_binding_time: true, same_wake_time: true, in_time: true });
    const completed = (await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
        .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId);
    expect(completed).toHaveLength(1);
    expect(completed[0].data).toMatchObject({ runId: run.runId, nodeExecutionId: exchangeId, operationId: result.receipt.operationId,
        responderSessionId: h.parent, outcome: status });
}

/** A real contending lock probe times out after the fixture's two-second deadline; there is no wall-clock sleep. */
async function expireWhileLocked(h, run, exchangeId) {
    const probe = await h.pool.connect();
    try {
        await probe.query("BEGIN");
        await probe.query("SET LOCAL lock_timeout = '2500ms'");
        await expect(probe.query(`SELECT session_id FROM "${h.schema}".sessions WHERE session_id = $1 FOR UPDATE`,
            [run.workflowSessionId])).rejects.toMatchObject({ code: "55P03" });
    } finally {
        try { await probe.query("ROLLBACK"); } finally { probe.release(); }
    }
    const [clock] = await h.q(`WITH reading AS (SELECT clock_timestamp() AS at)
        SELECT at::text AS at, at > req.deadline_at AS past FROM reading
        CROSS JOIN SCHEMA.workflow_requests req WHERE req.exchange_id = $1`, [exchangeId]);
    expect(clock.past).toBe(true);
    return clock.at;
}

describe("workflow v2 requests: real-store races, deadlines and rollback", () => {
    it.each([
        { label: "two different responses", left: YES, right: NO, identical: false },
        { label: "a response and a decline", left: YES, right: DECLINE, identical: false },
        { label: "identical values on different operations", left: YES, right: YES, identical: true },
    ])("serializes $label to one decision and one wake", { timeout: REQUEST_TIMEOUT }, async ({ left, right, identical }) => {
        const h = await requestFixture(getEnv());
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            const calls = [{ operationId: "left", call: left }, { operationId: "right", call: right }];
            const settled = await concurrentCalls(h, run, exchangeId, calls);
            expect(settled.every(item => item.status === "fulfilled")).toBe(true);
            const results = settled.map(item => item.value);
            const winners = results.map((result, index) => ({ result, index })).filter(item => item.result.kind === "accepted" && !item.result.replayed);
            expect(winners).toHaveLength(1);
            const { result: winner, index } = winners[0];
            const other = 1 - index;
            if (identical) {
                expect(results[other]).toEqual({ kind: "accepted", replayed: true, status: winner.status, receipt: winner.receipt });
            } else {
                expect(results[other]).toEqual({ kind: "refused", replayed: false, code: "RESPONSE_CONFLICT",
                    status: winner.status, currentStatus: winner.status });
            }
            await expectWinner(h, run, exchangeId, winner, calls[index].call, {
                decisions: 1, responses: 1, wakes: 1, operations: 2, decided: 1, same: identical ? 1 : 0, conflict: identical ? 0 : 1,
            });
            for (let operation = 0; operation < calls.length; operation += 1) {
                const replay = await h.respond(exchangeId, calls[operation].operationId, calls[operation].call);
                expect(replay).toEqual({ ...results[operation], replayed: true });
                expect(await h.binding(exchangeId, calls[operation].operationId)).toMatchObject({ count: 2 });
            }
            expect((await h.counts(exchangeId))).toMatchObject({ decisions: 1, responses: 1, wakes: 1, operations: 2 });
            const completed = (await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
                .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId);
            expect(completed).toHaveLength(1);
        } finally { await h.stop(); }
    });

    it("serializes concurrent repeats of the same operation without a duplicate binding", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            const settled = await concurrentCalls(h, run, exchangeId, [{ operationId: "same", call: YES }, { operationId: "same", call: YES }]);
            expect(settled.every(item => item.status === "fulfilled")).toBe(true);
            const results = settled.map(item => item.value);
            expect(results.every(result => result.kind === "accepted")).toBe(true);
            expect(results.filter(result => !result.replayed)).toHaveLength(1);
            expect(results.filter(result => result.replayed)).toHaveLength(1);
            expect(results[0].receipt).toEqual(results[1].receipt);
            expect(await h.binding(exchangeId, "same")).toMatchObject({ outcome: "decided", status: "responded", count: 2 });
            expect(await h.counts(exchangeId)).toEqual({ decisions: 1, responses: 1, wakes: 1, operations: 1, decided: 1, same: 0, conflict: 0 });
            expect(await h.respond(exchangeId, "same", YES)).toEqual({ kind: "accepted", replayed: true, status: "responded", receipt: results[0].receipt });
            expect(await h.binding(exchangeId, "same")).toMatchObject({ count: 3 });
            const completed = (await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
                .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId);
            expect(completed).toHaveLength(1);
        } finally { await h.stop(); }
    });

    it("lets only one new alias occupy binding 50 and still replays known bindings", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            const winner = await h.respond(exchangeId, "op-0", YES);
            for (let index = 1; index < WORKFLOW_V2_MAX_REQUEST_OPERATIONS - 1; index += 1) {
                expect(await h.respond(exchangeId, `op-${index}`, YES)).toMatchObject({ kind: "accepted", replayed: true, receipt: winner.receipt });
            }
            expect((await h.counts(exchangeId)).operations).toBe(49);
            const before = await h.snapshot(run, exchangeId);
            const calls = [{ operationId: "cap-left", call: YES }, { operationId: "cap-right", call: YES }];
            const settled = await concurrentCalls(h, run, exchangeId, calls);
            expect(settled.filter(item => item.status === "fulfilled")).toHaveLength(1);
            expect(settled.filter(item => item.status === "rejected")).toHaveLength(1);
            const filled = settled.findIndex(item => item.status === "fulfilled");
            expect(settled[filled].value).toEqual({ kind: "accepted", replayed: true, status: "responded", receipt: winner.receipt });
            expect(settled[1 - filled].reason).toMatchObject({ code: "OPERATION_LIMIT", details: { limit: 50 } });
            expect(await h.binding(exchangeId, calls[filled].operationId)).toMatchObject({ outcome: "same", count: 1 });
            expect(await h.binding(exchangeId, calls[1 - filled].operationId)).toBeNull();
            expect(await h.counts(exchangeId)).toEqual({ decisions: 1, responses: 1, wakes: 1, operations: 50, decided: 1, same: 49, conflict: 0 });
            for (const operationId of ["op-0", "op-48", calls[filled].operationId]) {
                expect(await h.respond(exchangeId, operationId, YES)).toEqual({ kind: "accepted", replayed: true, status: "responded", receipt: winner.receipt });
                expect(await h.binding(exchangeId, operationId)).toMatchObject({ count: 2 });
            }
            expect((await h.store.readRequest(exchangeId)).response.receipt).toEqual(winner.receipt);
            const after = await h.snapshot(run, exchangeId);
            expect({ node: after.node, response: after.response, wake: after.wake, session: after.session, events: after.events })
                .toEqual({ node: before.node, response: before.response, wake: before.wake, session: before.session, events: before.events });
        } finally { await h.stop(); }
    });

    it.each([-1, 0, 1])("compares an injected deciding reading at deadline %i microseconds exactly", { timeout: REQUEST_TIMEOUT }, async offsetUs => {
        const h = await requestFixture(getEnv());
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            let readings = 0;
            let at;
            h.control.hook = requestClock(h, exchangeId, offsetUs, row => { readings += 1; at = row.at; });
            const result = await h.respond(exchangeId, "boundary", YES);
            expect(readings).toBe(1);
            const [row] = await h.q(`SELECT $2::timestamptz - req.deadline_at = $3::integer * interval '1 microsecond' AS exact_offset,
                op.first_at = $2::timestamptz AND op.last_at = $2::timestamptz AS exact_binding_time
                FROM SCHEMA.workflow_requests req JOIN SCHEMA.workflow_request_operations op USING (exchange_id)
                WHERE req.exchange_id = $1`, [exchangeId, at, offsetUs]);
            expect(row).toEqual({ exact_offset: true, exact_binding_time: true });
            if (offsetUs < 0) {
                await expectWinner(h, run, exchangeId, result, YES, {
                    decisions: 1, responses: 1, wakes: 1, operations: 1, decided: 1, same: 0, conflict: 0,
                });
            } else {
                expect(result).toEqual({ kind: "refused", replayed: false, code: "REQUEST_EXPIRED", status: "pending", currentStatus: "pending" });
                expect(await h.store.readRequest(exchangeId)).toMatchObject({ status: "pending", response: null, wake: null, operations: 1 });
                expect(await h.store.readNodeExecution(exchangeId)).toMatchObject({ state: "pending", output: null, winner: null });
                expect(await h.binding(exchangeId, "boundary")).toMatchObject({ outcome: "expired", count: 1 });
                expect(await h.counts(exchangeId)).toEqual({ decisions: 0, responses: 0, wakes: 0, operations: 1, decided: 0, same: 0, conflict: 0 });
                expect((await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
                    .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId)).toHaveLength(0);
            }
            expect(await h.respond(exchangeId, "boundary", YES)).toEqual({ ...result, replayed: true });
            expect(readings).toBe(1);
            expect(await h.binding(exchangeId, "boundary")).toMatchObject({ count: 2 });
        } finally { await h.stop(); }
    });

    it("expires after a real session-lock wait crosses its deadline, not from the transaction's early start", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        let holder;
        let settled;
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run, { timeoutSeconds: 2 });
            holder = await holdSession(h, run.workflowSessionId);
            const atLock = checkpoint();
            let lockReturned = false;
            let readings = 0;
            h.control.hook = async context => {
                if (context.sql.includes(".sessions") && context.sql.includes("FOR NO KEY UPDATE") && context.params?.[0] === run.workflowSessionId) {
                    const before = await context.query(`SELECT clock_timestamp() < deadline_at AS early
                        FROM "${h.schema}".workflow_requests WHERE exchange_id = $1`, [exchangeId]);
                    expect(before.rows[0].early).toBe(true);
                    const locked = context.query(context.sql, context.params);
                    atLock.enter(context.client.processID);
                    const result = await locked;
                    lockReturned = true;
                    return result;
                }
                if (context.sql.includes("WITH reading AS (SELECT clock_timestamp() AS at)")) {
                    expect(lockReturned).toBe(true);
                    readings += 1;
                }
                return context.query(context.sql, context.params);
            };
            const response = h.respond(exchangeId, "waited", YES);
            settled = Promise.allSettled([response]);
            const pid = await reachedDuring(atLock, settled, "the response's session-lock query");
            await observeBlocked(h, pid, holder.pid);
            expect(readings).toBe(0);
            const releasedAfter = await expireWhileLocked(h, run, exchangeId);
            expect(readings).toBe(0);
            await holder.release();
            expect(await response).toMatchObject({ kind: "refused", code: "REQUEST_EXPIRED", replayed: false });
            expect(readings).toBe(1);
            expect(await h.store.readRequest(exchangeId)).toMatchObject({ status: "pending", response: null, wake: null, operations: 1 });
            expect(await h.binding(exchangeId, "waited")).toMatchObject({ outcome: "expired", count: 1 });
            const [time] = await h.q(`SELECT op.first_at >= req.deadline_at AS late, op.first_at >= $2::timestamptz AS after_release_reading,
                op.first_at = op.last_at AS one_binding_reading FROM SCHEMA.workflow_request_operations op
                JOIN SCHEMA.workflow_requests req USING (exchange_id) WHERE exchange_id = $1`, [exchangeId, releasedAfter]);
            expect(time).toEqual({ late: true, after_release_reading: true, one_binding_reading: true });
            h.control.hook = null;
            const control = await h.admit(run, { ordinal: 2 });
            expect(await h.respond(control, "in-time", YES)).toMatchObject({ kind: "accepted", replayed: false });
        } finally {
            h.control.hook = null;
            if (holder) await holder.release();
            if (settled) await settled;
            await h.stop();
        }
    });

    it("keeps a before-deadline decision held before COMMIT when the commit is after the deadline", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        const atCommit = checkpoint();
        let settled;
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run, { timeoutSeconds: 2 });
            const before = await h.snapshot(run, exchangeId);
            let at;
            let readings = 0;
            // Fault injection holds only the actual COMMIT; admission and the deciding clock use real PostgreSQL time.
            h.control.hook = async context => {
                if (context.sql === "COMMIT") { atCommit.enter(); await atCommit.released; }
                const result = await context.query(context.sql, context.params);
                if (context.sql.includes("WITH reading AS (SELECT clock_timestamp() AS at)")) {
                    readings += 1;
                    at = result.rows[0].at;
                }
                return result;
            };
            const response = h.respond(exchangeId, "held", YES);
            settled = Promise.allSettled([response]);
            await reachedDuring(atCommit, settled, "the real response's COMMIT");
            expect(await h.snapshot(run, exchangeId)).toEqual(before);
            expect(readings).toBe(1);
            const [clock] = await h.q("SELECT $2::timestamptz < deadline_at AS early FROM SCHEMA.workflow_requests WHERE exchange_id = $1", [exchangeId, at]);
            expect(clock.early).toBe(true);
            await expireWhileLocked(h, run, exchangeId);
            atCommit.release();
            const winner = await response;
            h.control.hook = null;
            await expectWinner(h, run, exchangeId, winner, YES, {
                decisions: 1, responses: 1, wakes: 1, operations: 1, decided: 1, same: 0, conflict: 0,
            });
            expect(await h.respond(exchangeId, "held", YES)).toEqual({ kind: "accepted", replayed: true, status: "responded", receipt: winner.receipt });
            expect(await h.respond(exchangeId, "late-alias", YES)).toEqual({ kind: "accepted", replayed: true, status: "responded", receipt: winner.receipt });
            expect(await h.counts(exchangeId)).toEqual({ decisions: 1, responses: 1, wakes: 1, operations: 2, decided: 1, same: 1, conflict: 0 });
        } finally {
            atCommit.release();
            h.control.hook = null;
            if (settled) await settled;
            await h.stop();
        }
    });

    it.each(["wake insert", "event projection"])("rolls back every response effect on a real PostgreSQL failure at %s", { timeout: REQUEST_TIMEOUT }, async fault => {
        const h = await requestFixture(getEnv());
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            await h.q("UPDATE SCHEMA.sessions SET last_active_at = '2000-01-01T00:00:00Z' WHERE session_id = $1", [run.workflowSessionId]);
            const before = await h.snapshot(run, exchangeId);
            let injected = 0;
            h.control.hook = async ({ sql, params, query }) => {
                if ((fault === "wake insert" && sql.includes("INSERT INTO") && sql.includes(".workflow_response_wakes"))
                    || (fault === "event projection" && sql.includes(".cms_record_events") && params?.[0] === run.workflowSessionId)) {
                    injected += 1;
                    // In the event case, fail after the actual projection wrote its events, so those writes must also roll back.
                    if (fault === "event projection") await query(sql, params);
                    return query("SELECT 1 / 0");
                }
                return query(sql, params);
            };
            try {
                await expect(h.respond(exchangeId, "rollback", YES)).rejects.toMatchObject({ code: "22012" });
                expect(injected).toBe(1);
            } finally { h.control.hook = null; }
            expect(await h.snapshot(run, exchangeId)).toEqual(before);
            expect(await h.counts(exchangeId)).toEqual({ decisions: 0, responses: 0, wakes: 0, operations: 0, decided: 0, same: 0, conflict: 0 });
            const control = await h.respond(exchangeId, "rollback", YES);
            await expectWinner(h, run, exchangeId, control, YES, {
                decisions: 1, responses: 1, wakes: 1, operations: 1, decided: 1, same: 0, conflict: 0,
            });
            expect((await h.snapshot(run, exchangeId)).session).not.toBe(before.session);
        } finally { await h.stop(); }
    });

    it.each(["response", "finish"])("preserves the first decision when %s reaches COMMIT before the other transaction", { timeout: REQUEST_TIMEOUT }, async first => {
        const h = await requestFixture(getEnv());
        const atCommit = checkpoint();
        const atLock = checkpoint();
        let settled;
        let firstPid;
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            const finish = () => h.store.finishRun({ runId: run.runId, status: "cancelled", terminalNodeId: null, terminalOutcome: null,
                outputText: null, errorText: canonicalJson({ code: "cancelled", message: "race control" }),
                endPending: { winner: "cancel", message: "race control" } });
            h.control.hook = async context => {
                if (firstPid === undefined && ((first === "response" && context.sql.includes("INSERT INTO") && context.sql.includes(".workflow_request_responses"))
                    || (first === "finish" && context.sql.includes("UPDATE") && context.sql.includes(".workflow_runs") && context.params?.[0] === run.runId))) {
                    firstPid = context.client.processID;
                }
                if (context.sql === "COMMIT" && context.client.processID === firstPid) { atCommit.enter(); await atCommit.released; }
                const query = context.query(context.sql, context.params);
                if (firstPid !== undefined && context.client.processID !== firstPid && context.sql.includes(".sessions")
                    && context.sql.includes("FOR NO KEY UPDATE") && context.params?.[0] === run.workflowSessionId) {
                    atLock.enter(context.client.processID);
                }
                return query;
            };
            const firstWork = first === "response" ? h.respond(exchangeId, "ordered", YES) : finish();
            const firstSettled = Promise.allSettled([firstWork]);
            settled = firstSettled;
            await reachedDuring(atCommit, firstSettled, "the first transaction's COMMIT");
            const secondWork = first === "response" ? finish() : h.respond(exchangeId, "ordered", YES);
            settled = Promise.allSettled([firstWork, secondWork]);
            const secondPid = await reachedDuring(atLock, Promise.allSettled([secondWork]), "the second transaction's session lock");
            await observeBlocked(h, secondPid, firstPid);
            atCommit.release();
            const results = await Promise.all([firstWork, secondWork]);
            h.control.hook = null;
            const response = results[first === "response" ? 0 : 1];
            expect(results[first === "finish" ? 0 : 1]).toMatchObject({ ended: true, run: { status: "cancelled" } });
            if (first === "response") {
                await expectWinner(h, run, exchangeId, response, YES, {
                    decisions: 1, responses: 1, wakes: 1, operations: 1, decided: 1, same: 0, conflict: 0,
                });
                expect(await h.respond(exchangeId, "ordered", YES)).toEqual({ kind: "accepted", replayed: true, status: "responded", receipt: response.receipt });
            } else {
                expect(response).toEqual({ kind: "refused", replayed: false, code: "REQUEST_CLOSED", status: "cancelled", currentStatus: "cancelled" });
                expect(await h.binding(exchangeId, "ordered")).toMatchObject({ outcome: "closed", status: "cancelled", count: 1 });
                expect(await h.counts(exchangeId)).toEqual({ decisions: 0, responses: 0, wakes: 0, operations: 1, decided: 0, same: 0, conflict: 0 });
                expect(await h.store.readNodeExecution(exchangeId)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "cancel" });
                expect((await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
                    .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId)).toHaveLength(0);
            }
        } finally {
            atCommit.release();
            h.control.hook = null;
            if (settled) await settled;
            await h.stop();
        }
    });

    it("refuses new entry while paused but accepts an already admitted response", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            await h.store.setRunPaused({ ...run, pause: true, operationId: "pause", requestSha256: "pause",
                actor: REQUEST_ACTOR, reason: null });
            const blocked = h.entry(run, { ordinal: 2 });
            expect(await h.store.enterNode(blocked)).toMatchObject({ admitted: false, reason: "inactive", run: { status: "paused" } });
            expect(await h.store.readRequest(blocked.nodeExecutionId)).toBeNull();
            expect(await h.store.readOutboxMessage(blocked.nodeExecutionId)).toBeNull();
            const result = await h.respond(exchangeId, "paused", YES);
            await expectWinner(h, run, exchangeId, result, YES, {
                decisions: 1, responses: 1, wakes: 1, operations: 1, decided: 1, same: 0, conflict: 0,
            });
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "paused", pausedFrom: "admitted" });
        } finally { await h.stop(); }
    });
});
