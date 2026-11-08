/**
 * Migration 0101 — workflow v2 agent states (IR 8; INACTIVE: only
 * controller 1.9.0 runs them, and only tests start runs there).
 *
 * - workflow_agent_invocations: one row per agent state's node execution,
 *   written once by the transaction that admits it pending: its child agent
 *   session's id (stable for the node execution, so a repeated spawn finds
 *   the same session), the workflow's controlling parent agent, the task
 *   (an inline prompt, or the named agent definition), the business outcomes
 *   and the output schema of its pinned definition, and its outer deadline
 *   (the node's). The spawn records when the child was created and how many
 *   attempts began; the end records what the workflow asked of the child
 *   once its state was decided (done after a typed completion, cancel
 *   otherwise), once, and when that command was handed to the child's
 *   session queue (or found unneeded: the child's session had ended or did
 *   not exist), with the status it was seen in. Nothing else changes.
 * - workflow_agent_completions: every complete_workflow_node operation of an
 *   agent state's child, once per operation id, with its result's identity
 *   and what it got: decided (it completed the state), same (a repeat of
 *   the deciding result under another id), invalid (field errors; the
 *   state stays pending until its correction budget is spent), expired (at
 *   or after the deadline: only the controller's elapse decides then, and
 *   every later operation is expired too), closed (the state was decided by
 *   something else) or conflict (another result after the state was
 *   decided). A decided operation keeps its receipt. Never changed.
 *
 * Additive: two new tables; no existing row changes.
 */
export function workflowV2AgentStatesMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0101_workflow_v2_agent_states

CREATE TABLE IF NOT EXISTS ${s}.workflow_agent_invocations (
    node_execution_id      TEXT PRIMARY KEY REFERENCES ${s}.workflow_node_executions (node_execution_id),
    run_id                 TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    workflow_session_id    TEXT NOT NULL,
    child_session_id       TEXT NOT NULL UNIQUE,
    controlling_session_id TEXT,
    task                   TEXT NOT NULL,
    outcomes               TEXT NOT NULL,
    output_schema          TEXT,
    deadline_at            TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL,
    spawn_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (spawn_attempts >= 0),
    spawned_at             TIMESTAMPTZ,
    end_requested          TEXT CHECK (end_requested IN ('done', 'cancel')),
    end_requested_at       TIMESTAMPTZ,
    end_sent_at            TIMESTAMPTZ,
    end_child_status       TEXT,
    CONSTRAINT workflow_agent_invocations_end CHECK ((end_requested IS NULL) = (end_requested_at IS NULL)),
    CONSTRAINT workflow_agent_invocations_end_sent CHECK (
        (end_sent_at IS NULL) = (end_child_status IS NULL) AND (end_sent_at IS NULL OR end_requested IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS workflow_agent_invocations_by_run ON ${s}.workflow_agent_invocations (run_id);

CREATE TABLE IF NOT EXISTS ${s}.workflow_agent_completions (
    node_execution_id TEXT NOT NULL REFERENCES ${s}.workflow_agent_invocations (node_execution_id),
    operation_id      TEXT NOT NULL,
    result_sha256     TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('decided', 'same', 'invalid', 'expired', 'closed', 'conflict')),
    problems          TEXT,
    receipt           TEXT,
    created_at        TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (node_execution_id, operation_id),
    CONSTRAINT workflow_agent_completions_receipt CHECK ((outcome = 'decided') = (receipt IS NOT NULL))
);
`;
}
