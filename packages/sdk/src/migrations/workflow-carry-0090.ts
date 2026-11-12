/** Immutable canonical JSON, kept as TEXT to preserve NUL and lone-surrogate strings. */
export function workflowCarryMigration(schema: string): string {
    const quoted = `"${schema.replace(/"/g, '""')}"`;
    return `
SET LOCAL lock_timeout = '5s';
ALTER TABLE ${quoted}.workflow_node_executions
    ADD COLUMN IF NOT EXISTS carry_snapshot TEXT;
`;
}
