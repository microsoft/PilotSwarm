import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { WorkflowStore, nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

export const REQUEST_ACTOR = { kind: "system", name: "workflow-v2-request-regressions" };
export const REQUEST_TIMEOUT = 120_000;

const REQUESTS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: request-regressions, version: "1.0.0" }
initial: ask
schemas:
  Question: { type: object, required: [q], properties: { q: { type: string } }, additionalProperties: false }
  Answer: { type: object, required: [approved], properties: { approved: { type: boolean } }, additionalProperties: false }
contracts:
  Approval@1:
    schema: { $ref: "#/schemas/Question" }
    response: { schema: { $ref: "#/schemas/Answer" } }
states:
  ask:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Approval@1
    input: { q: "ship?" }
    timeoutSeconds: 3600
    transition: { next: { responded: done, declined: blocked, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  blocked: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

/** A private real-client pool facade, as in workflow-v2-messaging.test.js. Hooks never replace store methods. */
export async function openWorkflowStore(env, { initialize = true } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    try {
        if (initialize) await catalog.initialize();
    } catch (error) {
        await catalog.close();
        throw error;
    }
    const pool = new pg.Pool({ connectionString: env.store, max: 4, connectionTimeoutMillis: 10_000,
        statement_timeout: 15_000, lock_timeout: 10_000 });
    const control = { hook: null };
    const wrapped = {
        async connect() {
            const client = await pool.connect();
            const query = (text, params) => client.query(text, params);
            return {
                query(text, params) {
                    const sql = typeof text === "string" ? text : text.text;
                    return control.hook ? control.hook({ sql, params, query, client }) : query(text, params);
                },
                release: (...args) => client.release(...args),
            };
        },
        query: (text, params) => pool.query(text, params),
    };
    const q = async (text, params = []) => (await pool.query(text.replaceAll("SCHEMA.", `"${env.cmsSchema}".`), params)).rows;
    return {
        catalog, pool, control, q, schema: env.cmsSchema, store: new WorkflowStore(wrapped, env.cmsSchema),
        async stop() {
            control.hook = null;
            try { await catalog.close(); } finally { await pool.end(); }
        },
    };
}

export async function requestFixture(env) {
    const h = await openWorkflowStore(env);
    try {
        const { q } = h;
        const owner = { provider: "test", subject: `request-owner-${randomUUID()}` };
        const parent = randomUUID();
        await h.catalog.createSession(parent, { owner });
        const compiled = compileWorkflowV2(REQUESTS, { enableRequests: true });
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        const workflow = async () => {
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
                creationConfig: { workflowV2: { requestSha256: "request-regressions" } } })).toEqual({ created: true });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: REQUESTS, compiled,
                actor: REQUEST_ACTOR, operationId: "create", requestSha256: "request-regressions", publish: true,
                title: "Workflow: request regressions",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null },
            });
            return { workflowSessionId, runId };
        };
        const refusal = code => ({ result: { outcome: code, resultKind: "runtime_error",
            valueText: canonicalJson({ code, message: code }), winner: "controller" } });
        const entry = (run, { ordinal = 1, timeoutSeconds = 3600 } = {}) => ({
            runId: run.runId, nodeExecutionId: nodeExecutionIdFor(run.runId, "root", "ask", ordinal),
            scopeId: "root", nodeId: "ask", ordinal, nodeType: "messaging", predecessorId: null, arrivalRoute: null,
            inputText: canonicalJson({ q: "ship?" }), kvRevision: 1, waitSeconds: null, immediate: null,
            request: { recipient: parent, contract: "Approval@1", payloadText: canonicalJson({ q: "ship?" }), correlationText: "{}",
                refused: { unavailable: refusal("unavailable"), forbidden: refusal("forbidden") },
                timeoutSeconds, responseSchema: compiled.ir.contracts["Approval@1"].response.schema,
                workflowRecipient: refusal("unsupported_contract") },
        });
        return Object.assign(h, {
            parent, workflow, entry,
            async admit(run, options) {
                const input = entry(run, options);
                const admitted = await h.store.enterNode(input);
                expect(admitted).toMatchObject({ admitted: true, inserted: true, node: { state: "pending" } });
                return input.nodeExecutionId;
            },
            respond: (exchangeId, operationId, call) => h.store.respondToRequest({ exchangeId, actorSessionId: parent, operationId, call }),
            async binding(exchangeId, operationId) {
                return (await q(`SELECT outcome, status, count, result_sha256 FROM SCHEMA.workflow_request_operations
                    WHERE exchange_id = $1 AND operation_id = $2`, [exchangeId, operationId]))[0] ?? null;
            },
            async counts(exchangeId) {
                return (await q(`SELECT
                    (SELECT count(*)::int FROM SCHEMA.workflow_node_executions WHERE node_execution_id = $1 AND winner = 'response') AS decisions,
                    (SELECT count(*)::int FROM SCHEMA.workflow_request_responses WHERE exchange_id = $1) AS responses,
                    (SELECT count(*)::int FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1) AS wakes,
                    count(*)::int AS operations,
                    count(*) FILTER (WHERE outcome = 'decided')::int AS decided,
                    count(*) FILTER (WHERE outcome = 'same')::int AS same,
                    count(*) FILTER (WHERE outcome = 'conflict')::int AS conflict
                    FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1`, [exchangeId]))[0];
            },
            async snapshot(run, exchangeId) {
                const [rows, events] = await Promise.all([
                    q(`SELECT row_to_json(node)::text AS node, row_to_json(session)::text AS session,
                        (SELECT row_to_json(req)::text FROM SCHEMA.workflow_requests req WHERE exchange_id = $1) AS request,
                        (SELECT row_to_json(resp)::text FROM SCHEMA.workflow_request_responses resp WHERE exchange_id = $1) AS response,
                        (SELECT row_to_json(wake)::text FROM SCHEMA.workflow_response_wakes wake WHERE exchange_id = $1) AS wake,
                        (SELECT row_to_json(outbox)::text FROM SCHEMA.workflow_outbox outbox WHERE exchange_id = $1) AS outbox,
                        COALESCE((SELECT json_agg(op ORDER BY operation_id)::text FROM SCHEMA.workflow_request_operations op
                            WHERE exchange_id = $1), '[]') AS operations
                        FROM SCHEMA.workflow_node_executions node JOIN SCHEMA.sessions session ON session.session_id = $2
                        WHERE node.node_execution_id = $1`, [exchangeId, run.workflowSessionId]),
                    h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000),
                ]);
                return { ...rows[0], events };
            },
        });
    } catch (error) {
        await h.stop();
        throw error;
    }
}

export function checkpoint() {
    let enter;
    let release;
    const reached = new Promise(resolve => { enter = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    return { reached, released, enter, release };
}

/** Fail immediately if an operation finishes without reaching its expected query, rather than hanging on a missed hook. */
export function reachedDuring(gate, work, label) {
    return Promise.race([gate.reached, work.then(() => { throw new Error(`The operation never reached ${label}.`); })]);
}

export async function holdSession(h, sessionId) {
    const client = await h.pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(`SELECT session_id FROM "${h.schema}".sessions WHERE session_id = $1 FOR UPDATE`, [sessionId]);
        expect(rows).toEqual([{ session_id: sessionId }]);
    } catch (error) {
        try { await client.query("ROLLBACK"); } finally { client.release(); }
        throw error;
    }
    let released = false;
    return {
        pid: client.processID,
        async release() {
            if (released) return;
            released = true;
            try { await client.query("ROLLBACK"); } finally { client.release(); }
        },
    };
}

/** A tuple waiter can depend on its sibling. Follow only the fixture's known backends, without cycles. */
export async function requestWaitState(h, pid, holderPid, participants = []) {
    const scoped = [...new Set([pid, holderPid, ...participants])];
    const [row] = await h.q(`WITH RECURSIVE
        blocking AS MATERIALIZED (
            SELECT backend.pid, pg_blocking_pids(backend.pid) AS blockers
            FROM unnest($1::integer[]) backend(pid)
        ),
        paths(pid, path) AS (
            SELECT $2::integer, ARRAY[$2::integer]
            UNION ALL
            SELECT blocker.pid, paths.path || blocker.pid
            FROM paths JOIN blocking ON blocking.pid = paths.pid
            CROSS JOIN LATERAL unnest(blocking.blockers) blocker(pid)
            WHERE blocker.pid = ANY($1::integer[]) AND blocker.pid <> ALL(paths.path)
        )
        SELECT pg_backend_pid() AS observer_pid,
            (SELECT blockers FROM blocking WHERE pid = $2::integer) AS blockers,
            (SELECT path FROM paths WHERE pid = $3::integer AND cardinality(path) > 1
                ORDER BY cardinality(path), path LIMIT 1) AS path,
            EXISTS(SELECT 1 FROM paths WHERE pid = $3::integer AND cardinality(path) > 1) AS blocked,
            (SELECT json_agg(blocking ORDER BY pid) FROM blocking) AS edges`, [scoped, pid, holderPid]);
    return row;
}

/** Bounded real lock observation; both direct row waits and sibling tuple waits must reach the held transaction. */
export async function observeBlocked(h, pid, holderPid, participants = []) {
    let last;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = await requestWaitState(h, pid, holderPid, participants);
        last = row;
        if (row.blocked) return row;
    }
    const error = new Error("The real PostgreSQL transaction did not wait for the held session row.");
    error.blockObservation = { pid, holderPid, attempts: 200, ...last };
    throw error;
}

/** Failure diagnostics read only the fixture's three backends, before its held transaction is released. */
export async function requestLockSnapshot(h, pids) {
    const [sample] = await h.q(`SELECT pg_backend_pid() AS observer_pid,
        (SELECT json_agg(activity ORDER BY pid) FROM (
            SELECT pid, backend_xid::text AS xid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers,
                query
            FROM pg_stat_activity WHERE pid = ANY($1::integer[])
        ) activity) AS activity,
        (SELECT json_agg(locks ORDER BY pid, locktype, mode, granted) FROM (
            SELECT pid, locktype, mode, granted, relation::regclass::text AS relation, page, tuple,
                transactionid::text AS xid, virtualxid, virtualtransaction
            FROM pg_locks WHERE pid = ANY($1::integer[])
                AND (locktype IN ('tuple', 'transactionid', 'virtualxid') OR relation = $2::regclass)
        ) locks) AS locks`, [pids, `"${h.schema}".sessions`]);
    return sample;
}

/** Fault-inject only the deciding reading; formatting and deadline arithmetic still execute on PostgreSQL. */
export function requestClock(h, exchangeId, offsetUs, onReading = () => {}) {
    return async ({ sql, params, query }) => {
        if (!sql.includes("WITH reading AS (SELECT clock_timestamp() AS at)")) return query(sql, params);
        const result = await query(`WITH reading AS (
            SELECT deadline_at + $2::integer * interval '1 microsecond' AS at
            FROM "${h.schema}".workflow_requests WHERE exchange_id = $1)
            SELECT at::text AS at, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_iso FROM reading`,
        [exchangeId, offsetUs]);
        onReading(result.rows[0]);
        return result;
    };
}
