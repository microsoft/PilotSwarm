/**
 * Migration 0103 — workflow v2 publication pins and test scenarios (design
 * 02 publication record, 03 package agents; R18, R28, T011, T018, T070;
 * INACTIVE: only a host that starts runs at controller 1.9.0 compiles agent
 * states and starts test runs).
 *
 * - workflow_definitions.published_agent_pins: what each named agent state
 *   of the published revision was resolved to when it was published (its
 *   agent, package, package version and package id), as canonical JSON,
 *   written once by the publication's transaction; null when the
 *   definition has no named agent state or its host resolves none. A live
 *   run's agent states bind to these pins: a package republished later is
 *   never picked up silently, and a pin that can no longer be resolved
 *   fails the state explicitly.
 * - workflow_runs.test_scenario: the scenario name a test run was started
 *   for, as evidence beside its results; null for a live run and for a
 *   test run without one.
 *
 * Additive: two nullable columns with their checks; no existing row changes.
 */
export function workflowV2PublicationPinsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0103_workflow_v2_publication_pins

ALTER TABLE ${s}.workflow_definitions ADD COLUMN IF NOT EXISTS published_agent_pins TEXT;
ALTER TABLE ${s}.workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_agent_pins;
ALTER TABLE ${s}.workflow_definitions ADD CONSTRAINT workflow_definitions_agent_pins CHECK (
    published_agent_pins IS NULL OR published_revision IS NOT NULL
);
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS test_scenario TEXT;
ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_test_scenario;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_test_scenario CHECK (mode = 'test' OR test_scenario IS NULL);
`;
}
