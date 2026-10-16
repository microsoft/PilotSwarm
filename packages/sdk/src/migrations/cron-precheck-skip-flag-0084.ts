/**
 * Frozen catalog publication of `sessions.cron_precheck_skip`: Off for the
 * cluster and operator-controlled, so a registered cron precheck runs in
 * shadow mode until an operator turns enforcement on.
 */
export function cronPrecheckSkipFlagMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
INSERT INTO ${s}.feature_flags (feature_key, display_name, description, default_enabled, default_allow_user_override, required_capability)
VALUES ('sessions.cron_precheck_skip', 'Skip idle cron turns',
        'Let a worker-registered cron precheck skip a scheduled cron wake-up that has no work, so the model is not called for that cycle. Without it, prechecks run in shadow mode only and every wake-up reaches the model. Operator-controlled.',
        false, false, NULL)
ON CONFLICT (feature_key) DO NOTHING;
INSERT INTO ${s}.feature_flag_settings (feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
SELECT feature_key, 'cluster', NULL, false, false, revision, 'migration:0084'
FROM ${s}.feature_flags WHERE feature_key = 'sessions.cron_precheck_skip'
ON CONFLICT (feature_key) WHERE scope = 'cluster' DO NOTHING;
`;
}
