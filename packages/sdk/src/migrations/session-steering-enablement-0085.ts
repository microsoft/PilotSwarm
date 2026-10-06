/**
 * Migration 0085: steering enablement gate and durable runtime counters
 * (docs/proposals/session-steering.md D-23, NFR-13, ST-M04; §11, NFR-6).
 *
 * - `cms_steer_incapable_workers()`: live, non-draining workers whose
 *   registration record does not advertise `info.capabilities["sessions.steering"] = true`.
 *   Live = heartbeat younger than max(90 s, 3 × the worker's reported heartbeat interval),
 *   the same rule the management client uses for live workers.
 * - `cms_feature_mutate_gated(...)`: the same arguments as `cms_feature_mutate` (0077).
 *   Enabling `sessions.steering` (cluster or user, not an unset) is refused with
 *   `FEATURE_CONFLICT` while any such worker exists, in the same statement snapshot as the
 *   write. Every other key and every disable passes straight through.
 * - `cms_steer_add_counters(session, counts)`: adds bounded, content-free runtime counters
 *   (pump work, write failures, lease loss, quiescence, Stop fast-path failures) to
 *   `session_steering_counters`, read back by `cms_steer_stats`.
 */
export function sessionSteeringEnablementMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_steer_incapable_workers()
RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(w.worker_node_id ORDER BY w.worker_node_id), '[]'::JSONB)
      FROM ${s}.workers w
     WHERE w.phase <> 'draining'
       AND w.updated_at > now() - make_interval(secs => GREATEST(90,
               3 * COALESCE(CASE WHEN (w.state->'system-agents'->>'heartbeatMs') ~ '^[0-9]{1,12}$'
                                 THEN (w.state->'system-agents'->>'heartbeatMs')::BIGINT END, 0) / 1000.0))
       AND COALESCE(w.info->'capabilities'->>'sessions.steering', 'false') <> 'true';
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_feature_mutate_gated(
    p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_scope TEXT, p_user BIGINT,
    p_key TEXT, p_enabled BOOLEAN, p_override BOOLEAN, p_unset BOOLEAN, p_expected BIGINT, p_request TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_incapable JSONB;
BEGIN
    IF p_key = 'sessions.steering' AND NOT COALESCE(p_unset, false) AND p_enabled IS TRUE THEN
        v_incapable := ${s}.cms_steer_incapable_workers();
        IF jsonb_array_length(v_incapable) > 0 THEN
            RAISE EXCEPTION 'FEATURE_CONFLICT: sessions.steering cannot be enabled while % live worker(s) do not run a steering-capable build',
                jsonb_array_length(v_incapable);
        END IF;
    END IF;
    RETURN ${s}.cms_feature_mutate(p_provider, p_subject, p_admin, p_scope, p_user,
        p_key, p_enabled, p_override, p_unset, p_expected, p_request);
END $$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_add_counters(p_session_id TEXT, p_counts JSONB)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE k TEXT; v JSONB;
BEGIN
    IF jsonb_typeof(p_counts) <> 'object' THEN RETURN; END IF;
    FOR k, v IN SELECT key, value FROM jsonb_each(p_counts) LOOP
        CONTINUE WHEN k !~ '^[a-z][a-z0-9_:]{0,63}$' OR jsonb_typeof(v) <> 'number';
        CONTINUE WHEN (v #>> '{}') !~ '^[0-9]{1,9}$' OR (v #>> '{}')::BIGINT = 0;
        INSERT INTO ${s}.session_steering_counters (session_id, name, value, updated_at)
        SELECT p_session_id, k, (v #>> '{}')::BIGINT, now()
         WHERE EXISTS (SELECT 1 FROM ${s}.sessions WHERE session_id = p_session_id)
        ON CONFLICT (session_id, name) DO UPDATE
           SET value = ${s}.session_steering_counters.value + EXCLUDED.value, updated_at = now();
    END LOOP;
END $$;
`;
}
