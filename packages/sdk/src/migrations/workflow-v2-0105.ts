/**
 * Migration 0105 — workflow v2 real-agent test runs' agent pins (design 05
 * agentMode real: "pin package/contract identities just as a live run
 * would"; R18, R19; INACTIVE: only controller 1.9.0 runs test runs).
 *
 * - workflow_runs.test_agent_pins: what a real-agent test run's named agent
 *   states were pinned to when the test was admitted (canonical JSON, the
 *   shape of a publication's pins: per state, its agent, package, version,
 *   package id and, when the host knows it, the exact package revision).
 *   A test of the published revision takes the publication's pins; a test
 *   of a draft is pinned as its publication would be. Null for every other
 *   run, and for a real-agent test run without a named agent state or of a
 *   host that does not resolve agents (its children are then bound when
 *   they are created).
 *
 * Additive: one nullable column, allowed only on a real-agent test run; no
 * existing row changes.
 */
export function workflowV2TestAgentPinsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0105_workflow_v2_test_agent_pins

ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS test_agent_pins TEXT;
ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_test_agent_pins;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_test_agent_pins CHECK (
    test_agent_pins IS NULL OR (mode = 'test' AND test_agent_mode = 'real')
);
`;
}
