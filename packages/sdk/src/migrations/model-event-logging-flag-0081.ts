/**
 * Frozen catalog publication of `debug.enable_model_event_logging`: Off for
 * the cluster, and each person may turn it on for their own sessions.
 */
export function modelEventLoggingFlagMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
INSERT INTO ${s}.feature_flags (feature_key, display_name, description, default_enabled, default_allow_user_override, required_capability)
VALUES ('debug.enable_model_event_logging', 'Model event logging',
        'Record the Copilot CLI''s model trace events (model.message, model.messages_snapshot, model.tool_execution, model.model_call_success) in the session event log. They repeat the whole conversation on every turn and are large; turn on only for debugging.',
        false, true, NULL)
ON CONFLICT (feature_key) DO NOTHING;
INSERT INTO ${s}.feature_flag_settings (feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
SELECT feature_key, 'cluster', NULL, false, true, revision, 'migration:0081'
FROM ${s}.feature_flags WHERE feature_key = 'debug.enable_model_event_logging'
ON CONFLICT (feature_key) WHERE scope = 'cluster' DO NOTHING;
`;
}
