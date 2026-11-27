/**
 * Reusable Workflow resource-leak census helper.
 *
 * Inspects every session reachable from `rootSessionIds` (via `sessions.parent_session_id`,
 * `sessions.root_session_id`, `workflow_definitions.parent_session_id`, and
 * `workflow_agent_invocations.child_session_id`) across 8 resource categories inside a single
 * REPEATABLE READ READ ONLY database snapshot, plus live Duroxide orchestration status reads:
 *
 *   1. orchestrations_live             — Duroxide orchestrations not in a terminal/NotFound status
 *   2. runs_active                     — workflow_runs in ACTIVE_RUN_STATUSES
 *   3. child_workflows_active          — child Workflow sessions with an active run
 *   4. agent_sessions_live             — workflow agent sessions (incl. continued) not ended
 *   5. claim_shells                    — workflow sessions with no workflow_runs row and deleted_at IS NULL
 *                                        older than graceMs (intentionally broader than
 *                                        listBareChildWorkflowClaims's no-definition check so it also
 *                                        catches crashed spawns between createDefinition and startLive,
 *                                        or unstarted drafts left behind)
 *   6. open_work_on_terminal_runs      — open requests, open approvals, undelivered outbox rows, pending
 *                                        node executions, and awaiting_parent test interceptions on terminal runs
 *   7. inbox_pending_on_terminal_runs  — unconsumed, unexpired workflow_inbox rows on terminal runs
 *   8. sessions_not_swept              — sessions in the tree with deleted_at IS NULL (checked after owner end + Sweeper)
 *
 * Also returns `orchestrationStatuses` (instanceId -> status) for every Duroxide instance checked so
 * callers can prove non-vacuity (e.g. asserting `wfx-`/`wfr-`/`wfa-`/`wft-` existed and are Completed).
 */

import { ACTIVE_RUN_STATUSES, SWEEPER_ENDED_SESSION_STATES } from "../../src/workflow/store.ts";
import {
    workflowAgentInstanceId,
    workflowEffectInstanceId,
    workflowRequestInstanceId,
    workflowSendInstanceId,
} from "../../src/workflow/controller/runtime.ts";
import {
    WORKFLOW_AGENT_SESSION_END_RETRIES_MAX,
    workflowAgentSessionEndInstanceId,
    workflowNotifyInstanceId,
} from "../../src/workflow/runtime.ts";

export const LEAK_CENSUS_CATEGORIES = Object.freeze([
    "orchestrations_live",
    "runs_active",
    "child_workflows_active",
    "agent_sessions_live",
    "claim_shells",
    "open_work_on_terminal_runs",
    "inbox_pending_on_terminal_runs",
    "sessions_not_swept",
]);

const TERMINAL_ORCH_STATUSES = new Set(["Completed", "Failed", "Terminated", "NotFound"]);
const ENDED_AGENT_CMS_STATES = new Set([...SWEEPER_ENDED_SESSION_STATES, "error"]);
const STATUS_CONCURRENCY = 16;

function quoteIdent(ident) {
    if (typeof ident !== "string" || ident.length === 0) {
        throw new Error(`Invalid SQL identifier: ${String(ident)}`);
    }
    return `"${ident.replace(/"/g, "\"\"")}"`;
}

function normalizeIds(input) {
    const raw = Array.isArray(input) ? input : (input ? [input] : []);
    return [...new Set(raw.filter(id => typeof id === "string" && id.length > 0))].sort();
}

async function mapConcurrent(items, concurrency, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

async function discoverTreeSessionIds(pool, s, rootSessionIds) {
    const discovered = new Set(rootSessionIds);
    let frontier = [...discovered];
    while (frontier.length > 0) {
        const { rows } = await pool.query(
            `SELECT session_id AS id
               FROM ${s}.sessions
              WHERE parent_session_id = ANY($1::text[])
                 OR root_session_id = ANY($1::text[])
             UNION
             SELECT workflow_session_id AS id
               FROM ${s}.workflow_definitions
              WHERE parent_session_id = ANY($1::text[])
             UNION
             SELECT child_session_id AS id
               FROM ${s}.workflow_agent_invocations
              WHERE workflow_session_id = ANY($1::text[])`,
            [frontier],
        );
        const next = [];
        for (const row of rows) {
            if (typeof row.id === "string" && row.id.length > 0 && !discovered.has(row.id)) {
                discovered.add(row.id);
                next.push(row.id);
            }
        }
        frontier = next;
    }
    return [...discovered].sort();
}

/**
 * Inspect a session tree rooted at `rootSessionIds` for resource leaks.
 *
 * Accepts either `{ store, catalog, duroxideClient, rootSessionIds, graceMs }` or explicit
 * `{ pool, cmsSchema, duroxideClient, rootSessionIds, graceMs }`.
 *
 * `liveOwnerSessionIds` (optional): non-workflow owner session IDs that are intentionally
 * still running before the owner-end + Sweeper phase; only their own `session-<id>`
 * orchestration is excluded from `orchestrations_live`, while all descendants and runs
 * under them are fully inspected.
 */
export async function census({
    store = null,
    catalog = null,
    pool = null,
    cmsSchema = null,
    duroxideClient,
    rootSessionIds,
    graceMs = 0,
    liveOwnerSessionIds = [],
}) {
    const resolvedStore = store ?? (catalog && typeof catalog.workflowStore === "function" ? catalog.workflowStore() : null);
    const resolvedPool = pool ?? resolvedStore?.pool ?? catalog?.pool ?? null;
    const resolvedSchema = cmsSchema ?? resolvedStore?.schema ?? catalog?.schema ?? null;
    if (!resolvedPool) throw new Error("workflow-leak-census: provide store, catalog, or pool");
    if (!resolvedSchema) throw new Error("workflow-leak-census: provide store, catalog, or cmsSchema");
    if (!duroxideClient || typeof duroxideClient.getStatus !== "function") {
        throw new Error("workflow-leak-census: provide duroxideClient with getStatus()");
    }
    const roots = normalizeIds(rootSessionIds);
    if (roots.length === 0) throw new Error("workflow-leak-census: rootSessionIds must be non-empty");
    const liveOwners = new Set(normalizeIds(liveOwnerSessionIds));
    const s = quoteIdent(resolvedSchema);

    // Read the entire session tree and all DB categories inside one REPEATABLE READ READ ONLY snapshot
    // so concurrent transitions cannot produce a torn view across categories.
    const dbClient = await resolvedPool.connect();
    let treeSessionIds;
    let sessionsRes;
    let runsRes;
    let activeRunsRes;
    let childWfActiveRes;
    let claimShellsRes;
    let openWorkRes;
    let inboxPendingRes;
    let unsweptRes;
    let nodeRows = [];
    let outboxRows = [];
    let agentInvRows = [];
    try {
        await dbClient.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        treeSessionIds = await discoverTreeSessionIds(dbClient, s, roots);

        sessionsRes = await dbClient.query(
            `SELECT session_id, session_kind, state, deleted_at
               FROM ${s}.sessions
              WHERE session_id = ANY($1::text[])
              ORDER BY session_id`,
            [treeSessionIds],
        );
        runsRes = await dbClient.query(
            `SELECT run_id, workflow_session_id, status, controller_instance_id
               FROM ${s}.workflow_runs
              WHERE workflow_session_id = ANY($1::text[])
              ORDER BY run_id`,
            [treeSessionIds],
        );
        activeRunsRes = await dbClient.query(
            `SELECT run_id
               FROM ${s}.workflow_runs
              WHERE workflow_session_id = ANY($1::text[])
                AND status = ANY($2::text[])
              ORDER BY run_id`,
            [treeSessionIds, ACTIVE_RUN_STATUSES],
        );
        childWfActiveRes = await dbClient.query(
            `SELECT DISTINCT s.session_id
               FROM ${s}.sessions s
               LEFT JOIN ${s}.workflow_definitions d ON d.workflow_session_id = s.session_id
               JOIN ${s}.sessions p ON p.session_id = COALESCE(s.parent_session_id, d.parent_session_id)
               JOIN ${s}.workflow_runs r ON r.workflow_session_id = s.session_id
              WHERE s.session_id = ANY($1::text[])
                AND s.session_kind = 'workflow'
                AND p.session_kind = 'workflow'
                AND r.status = ANY($2::text[])
              ORDER BY s.session_id`,
            [treeSessionIds, ACTIVE_RUN_STATUSES],
        );
        claimShellsRes = await dbClient.query(
            `SELECT s.session_id
               FROM ${s}.sessions s
              WHERE s.session_id = ANY($1::text[])
                AND s.session_kind = 'workflow'
                AND s.deleted_at IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM ${s}.workflow_runs r
                     WHERE r.workflow_session_id = s.session_id
                )
                AND (
                    ($2::double precision <= 0 AND s.created_at <= now())
                    OR ($2::double precision > 0 AND s.created_at < now() - ($2::double precision * interval '1 millisecond'))
                )
              ORDER BY s.session_id`,
            [treeSessionIds, graceMs],
        );
        openWorkRes = await dbClient.query(
            `SELECT id FROM (
                SELECT 'request:' || req.exchange_id AS id
                  FROM ${s}.workflow_requests req
                  JOIN ${s}.workflow_runs r ON r.run_id = req.run_id
                  JOIN ${s}.workflow_node_executions n ON n.node_execution_id = req.exchange_id
                  LEFT JOIN ${s}.workflow_request_responses resp ON resp.exchange_id = req.exchange_id
                 WHERE r.workflow_session_id = ANY($1::text[])
                   AND NOT (r.status = ANY($2::text[]))
                   AND n.state = 'pending'
                   AND resp.exchange_id IS NULL
                UNION ALL
                SELECT 'approval:' || a.node_execution_id AS id
                  FROM ${s}.workflow_approvals a
                  JOIN ${s}.workflow_runs r ON r.run_id = a.run_id
                  JOIN ${s}.workflow_node_executions n ON n.node_execution_id = a.node_execution_id
                 WHERE r.workflow_session_id = ANY($1::text[])
                   AND NOT (r.status = ANY($2::text[]))
                   AND a.decision IS NULL
                   AND n.state = 'pending'
                UNION ALL
                SELECT 'outbox:' || o.exchange_id AS id
                  FROM ${s}.workflow_outbox o
                  JOIN ${s}.workflow_runs r ON r.run_id = o.run_id
                 WHERE r.workflow_session_id = ANY($1::text[])
                   AND NOT (r.status = ANY($2::text[]))
                   AND o.state = 'pending'
                UNION ALL
                SELECT 'node:' || n.node_execution_id AS id
                  FROM ${s}.workflow_node_executions n
                  JOIN ${s}.workflow_runs r ON r.run_id = n.run_id
                 WHERE r.workflow_session_id = ANY($1::text[])
                   AND NOT (r.status = ANY($2::text[]))
                   AND n.state = 'pending'
                   AND NOT EXISTS (
                       SELECT 1 FROM ${s}.workflow_requests req
                         LEFT JOIN ${s}.workflow_request_responses resp ON resp.exchange_id = req.exchange_id
                        WHERE req.exchange_id = n.node_execution_id
                          AND resp.exchange_id IS NULL
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM ${s}.workflow_approvals a
                        WHERE a.node_execution_id = n.node_execution_id
                          AND a.decision IS NULL
                   )
                UNION ALL
                SELECT 'interception:' || ti.interception_id AS id
                  FROM ${s}.workflow_test_interceptions ti
                  JOIN ${s}.workflow_runs r ON r.run_id = ti.run_id
                 WHERE r.workflow_session_id = ANY($1::text[])
                   AND NOT (r.status = ANY($2::text[]))
                   AND ti.state = 'awaiting_parent'
             ) open_work
             ORDER BY id`,
            [treeSessionIds, ACTIVE_RUN_STATUSES],
        );
        inboxPendingRes = await dbClient.query(
            `SELECT i.message_id
               FROM ${s}.workflow_inbox i
               JOIN ${s}.workflow_runs r ON r.run_id = i.run_id
              WHERE r.workflow_session_id = ANY($1::text[])
                AND NOT (r.status = ANY($2::text[]))
                AND i.consumed_by IS NULL
                AND i.expires_at > now()
              ORDER BY i.message_id`,
            [treeSessionIds, ACTIVE_RUN_STATUSES],
        );
        unsweptRes = await dbClient.query(
            `SELECT s.session_id
               FROM ${s}.sessions s
              WHERE s.session_id = ANY($1::text[])
                AND s.deleted_at IS NULL
              ORDER BY s.session_id`,
            [treeSessionIds],
        );

        const runIds = runsRes.rows.map(row => row.run_id);
        if (runIds.length > 0) {
            nodeRows = (await dbClient.query(
                `SELECT node_execution_id, node_type
                   FROM ${s}.workflow_node_executions
                  WHERE run_id = ANY($1::text[])`,
                [runIds],
            )).rows;
            outboxRows = (await dbClient.query(
                `SELECT node_execution_id, mode
                   FROM ${s}.workflow_outbox
                  WHERE run_id = ANY($1::text[])`,
                [runIds],
            )).rows;
            agentInvRows = (await dbClient.query(
                `SELECT i.child_session_id, i.run_id, i.node_execution_id, i.spawn_attempts,
                        i.end_sent_at, i.end_child_status, i.created_at,
                        r.status AS run_status
                   FROM ${s}.workflow_agent_invocations i
                   JOIN ${s}.workflow_runs r ON r.run_id = i.run_id
                  WHERE i.run_id = ANY($1::text[])
                  ORDER BY i.child_session_id, i.created_at DESC, i.node_execution_id DESC`,
                [runIds],
            )).rows;
        }
        await dbClient.query("COMMIT");
    } catch (error) {
        try { await dbClient.query("ROLLBACK"); } catch {}
        throw error;
    } finally {
        dbClient.release();
    }

    const sessionById = new Map(sessionsRes.rows.map(row => [row.session_id, row]));

    // Build complete set of candidate Duroxide orchestration instance IDs for the tree.
    const candidateInstances = new Set();
    for (const sessionId of treeSessionIds) {
        const row = sessionById.get(sessionId);
        if (liveOwners.has(sessionId) && row?.session_kind !== "workflow") continue;
        candidateInstances.add(`session-${sessionId}`);
    }
    for (const run of runsRes.rows) {
        if (run.controller_instance_id) candidateInstances.add(run.controller_instance_id);
        candidateInstances.add(workflowNotifyInstanceId(run.run_id));
    }
    for (const node of nodeRows) {
        if (node.node_type === "script" || node.node_type === "decision" || node.node_type === "spawn") {
            candidateInstances.add(workflowEffectInstanceId(node.node_execution_id));
        } else if (node.node_type === "agent") {
            candidateInstances.add(workflowAgentInstanceId(node.node_execution_id));
        }
    }
    for (const outbox of outboxRows) {
        if (outbox.mode === "send") candidateInstances.add(workflowSendInstanceId(outbox.node_execution_id));
        else if (outbox.mode === "request") candidateInstances.add(workflowRequestInstanceId(outbox.node_execution_id));
    }

    const agentChildren = new Map();
    for (const inv of agentInvRows) {
        const existing = agentChildren.get(inv.child_session_id);
        if (!existing) {
            agentChildren.set(inv.child_session_id, {
                childSessionId: inv.child_session_id,
                latestEndSentAt: inv.end_sent_at,
                latestEndChildStatus: inv.end_child_status,
                latestRunStatus: inv.run_status,
                anySpawnAttempt: Number(inv.spawn_attempts ?? 0) > 0,
            });
        } else {
            if (Number(inv.spawn_attempts ?? 0) > 0) existing.anySpawnAttempt = true;
        }
        candidateInstances.add(`session-${inv.child_session_id}`);
        candidateInstances.add(workflowAgentSessionEndInstanceId(inv.child_session_id, 1));
    }

    const instanceList = [...candidateInstances].sort();
    const statusByInstance = new Map();
    await mapConcurrent(instanceList, STATUS_CONCURRENCY, async (instanceId) => {
        const st = await duroxideClient.getStatus(instanceId);
        statusByInstance.set(instanceId, st?.status ?? "Unknown");
    });

    // If a continued-session detached retry #1 existed, probe numbered retries (#2..MAX) until NotFound.
    for (const childSessionId of agentChildren.keys()) {
        const firstId = workflowAgentSessionEndInstanceId(childSessionId, 1);
        if (statusByInstance.get(firstId) !== "NotFound") {
            for (let n = 2; n <= WORKFLOW_AGENT_SESSION_END_RETRIES_MAX; n += 1) {
                const retryId = workflowAgentSessionEndInstanceId(childSessionId, n);
                const st = await duroxideClient.getStatus(retryId);
                const status = st?.status ?? "Unknown";
                statusByInstance.set(retryId, status);
                if (status === "NotFound") break;
            }
        }
    }

    const sortedStatuses = [...statusByInstance.entries()].sort(([a], [b]) => a.localeCompare(b));
    const orchestrationStatuses = Object.fromEntries(sortedStatuses);
    const liveOrchestrations = [];
    for (const [instanceId, status] of sortedStatuses) {
        if (!TERMINAL_ORCH_STATUSES.has(status)) {
            liveOrchestrations.push(`${instanceId}:${status}`);
        }
    }

    // Category 4: agent sessions started by workflow visits (including continued sessions) not ended.
    const liveAgentSessions = [];
    for (const [childSessionId, info] of [...agentChildren.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const sessionRow = sessionById.get(childSessionId) ?? null;
        const orchStatus = statusByInstance.get(`session-${childSessionId}`) ?? "NotFound";
        const orchLive = !TERMINAL_ORCH_STATUSES.has(orchStatus);
        const cmsLive = sessionRow !== null
            && sessionRow.deleted_at === null
            && !ENDED_AGENT_CMS_STATES.has(String(sessionRow.state));
        const endOwedOnTerminalRun = !ACTIVE_RUN_STATUSES.includes(info.latestRunStatus)
            && info.anySpawnAttempt
            && (info.latestEndSentAt === null || info.latestEndChildStatus === "AgentSessionContinues");
        if (orchLive || cmsLive || endOwedOnTerminalRun) {
            liveAgentSessions.push(childSessionId);
        }
    }

    const categories = {
        orchestrations_live: { count: liveOrchestrations.length, ids: liveOrchestrations },
        runs_active: { count: activeRunsRes.rows.length, ids: activeRunsRes.rows.map(r => r.run_id) },
        child_workflows_active: { count: childWfActiveRes.rows.length, ids: childWfActiveRes.rows.map(r => r.session_id) },
        agent_sessions_live: { count: liveAgentSessions.length, ids: liveAgentSessions },
        claim_shells: { count: claimShellsRes.rows.length, ids: claimShellsRes.rows.map(r => r.session_id) },
        open_work_on_terminal_runs: { count: openWorkRes.rows.length, ids: openWorkRes.rows.map(r => r.id) },
        inbox_pending_on_terminal_runs: { count: inboxPendingRes.rows.length, ids: inboxPendingRes.rows.map(r => r.message_id) },
        sessions_not_swept: { count: unsweptRes.rows.length, ids: unsweptRes.rows.map(r => r.session_id) },
    };

    const total = Object.values(categories).reduce((sum, entry) => sum + entry.count, 0);
    return { total, treeSessionIds, orchestrationStatuses, categories };
}

/**
 * Assert that a census result has zero leaks in every category not explicitly listed in `allow`.
 * Throws a detailed Error naming every non-zero category and all of its leaked IDs.
 */
export function assertNoLeaks(result, { allow = [] } = {}) {
    if (!result || typeof result !== "object" || !result.categories) {
        throw new Error("assertNoLeaks: expected a census() result object");
    }
    const allowed = new Set(allow);
    for (const name of allowed) {
        if (!Object.hasOwn(result.categories, name)) {
            throw new Error(`assertNoLeaks: unknown category in allow: ${name}`);
        }
    }
    const failures = [];
    for (const name of LEAK_CENSUS_CATEGORIES) {
        if (allowed.has(name)) continue;
        const entry = result.categories[name];
        if (!entry || entry.count > 0) {
            const ids = entry?.ids ?? [];
            failures.push(`  - ${name} (${entry?.count ?? "?"}): [${ids.join(", ")}]`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`Workflow leak census failed:\n${failures.join("\n")}`);
    }
}
