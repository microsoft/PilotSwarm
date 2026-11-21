/**
 * Migration 0102: the Cluster Decision Default counts as provider routing.
 *
 * 0098 added decision_default_provider, but cms_provider_delete and cms_provider_clear_routing_dependencies still checked
 * only the chat and system defaults. A provider that was the Cluster Decision Default could be deleted, which left every
 * Decision save and Start refused, and a new provider with the same name made the old setting active again with its own
 * endpoint and key. Now a delete is refused while the provider is the Cluster Decision Default (PROVIDER_IN_USE), and
 * clearing a provider's routing also clears that default and reports it as `decisionDefault`.
 */
export function decisionDefaultProviderRoutingMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_provider_delete(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BIGINT AS $$
DECLARE
    v_row ${s}.provider_instances;
    v_waiting BIGINT;
BEGIN
    v_row := ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    IF EXISTS (
        SELECT 1 FROM ${s}.provider_cluster_settings cs
         WHERE cs.singleton
           AND (cs.default_provider = p_name OR cs.system_default_provider = p_name
                OR cs.decision_default_provider = p_name)
    ) OR EXISTS (
        SELECT 1 FROM ${s}.users u WHERE u.default_provider = p_name
    ) OR EXISTS (
        SELECT 1 FROM ${s}.system_agent_model_overrides o WHERE o.provider_name = p_name
    ) THEN
        RAISE EXCEPTION 'PROVIDER_IN_USE: "%" is selected by a default or system-agent override; clear that routing first', p_name;
    END IF;
    SELECT count(*) INTO v_waiting
      FROM ${s}.sessions ss
      CROSS JOIN LATERAL ${s}.cms_provider_split_ref(ss.model) sp
     WHERE ss.deleted_at IS NULL
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND sp.provider_name = p_name;
    DELETE FROM ${s}.provider_instances pi WHERE pi.name = p_name;
    RETURN v_waiting;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_clear_routing_dependencies(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS JSONB AS $$
DECLARE
    v_row ${s}.provider_instances;
    v_cluster INTEGER := 0;
    v_system INTEGER := 0;
    v_decision INTEGER := 0;
    v_users INTEGER := 0;
    v_overrides INTEGER := 0;
BEGIN
    v_row := ${s}.cms_provider_assert_manage(p_name, p_actor, p_is_admin);
    IF v_row.class = 'shared' AND NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can clear shared-provider routing';
    END IF;

    UPDATE ${s}.provider_cluster_settings cs
       SET default_provider = NULL, default_model = NULL,
           default_reasoning = NULL, default_context = NULL,
           updated_at = now()
     WHERE cs.singleton AND cs.default_provider = p_name;
    GET DIAGNOSTICS v_cluster = ROW_COUNT;

    UPDATE ${s}.provider_cluster_settings cs
       SET system_default_provider = NULL, system_default_model = NULL,
           system_default_reasoning = NULL, system_default_context = NULL,
           system_default_updated_by = p_actor,
           system_default_updated_at = now(), updated_at = now()
     WHERE cs.singleton AND cs.system_default_provider = p_name;
    GET DIAGNOSTICS v_system = ROW_COUNT;

    UPDATE ${s}.provider_cluster_settings cs
       SET decision_default_provider = NULL, decision_default_model = NULL,
           decision_default_reasoning = NULL, decision_default_context = NULL,
           updated_at = now()
     WHERE cs.singleton AND cs.decision_default_provider = p_name;
    GET DIAGNOSTICS v_decision = ROW_COUNT;

    UPDATE ${s}.users u
       SET default_provider = NULL, default_model = NULL,
           default_reasoning = NULL, default_context = NULL
     WHERE u.default_provider = p_name
       AND (v_row.class = 'shared' OR u.user_id = p_actor);
    GET DIAGNOSTICS v_users = ROW_COUNT;

    DELETE FROM ${s}.system_agent_model_overrides o WHERE o.provider_name = p_name;
    GET DIAGNOSTICS v_overrides = ROW_COUNT;

    RETURN jsonb_build_object(
        'clusterDefault', v_cluster,
        'systemDefault', v_system,
        'decisionDefault', v_decision,
        'userDefaults', v_users,
        'systemOverrides', v_overrides);
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}
