/** A separate, initially unset Decision default; ordinary defaults keep their existing contract. */
export function clusterDecisionDefaultMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
ALTER TABLE ${s}.provider_cluster_settings
    ADD COLUMN IF NOT EXISTS decision_default_provider TEXT,
    ADD COLUMN IF NOT EXISTS decision_default_model TEXT,
    ADD COLUMN IF NOT EXISTS decision_default_reasoning TEXT,
    ADD COLUMN IF NOT EXISTS decision_default_context TEXT;

CREATE OR REPLACE FUNCTION ${s}.cms_provider_set_cluster_decision_default(
    p_provider TEXT, p_model TEXT, p_reasoning TEXT, p_context TEXT, p_is_admin BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE
    v_name TEXT := NULLIF(BTRIM(COALESCE(p_provider, '')), '');
    v_model TEXT := NULLIF(BTRIM(COALESCE(p_model, '')), '');
    v_row ${s}.provider_instances;
BEGIN
    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'PROVIDER_FORBIDDEN: only an administrator can set the Cluster Decision Default';
    END IF;
    IF (v_name IS NULL) <> (v_model IS NULL) THEN
        RAISE EXCEPTION 'PROVIDER_INVALID: the Cluster Decision Default needs both a provider and model, or neither to clear it';
    END IF;
    IF v_name IS NOT NULL THEN
        SELECT * INTO v_row FROM ${s}.provider_instances pi WHERE pi.name = v_name FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'PROVIDER_NOT_FOUND: there is no provider named "%"', v_name;
        END IF;
        IF v_row.class <> 'shared' THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: the Cluster Decision Default must be a shared provider';
        END IF;
        IF LEFT(v_model, LENGTH(v_name) + 1) <> v_name || ':' OR LENGTH(v_model) <= LENGTH(v_name) + 1 THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: the Decision model must belong to "%": write it as "%:<model>"', v_name, v_name;
        END IF;
        IF v_row.secret_ref IS NULL OR v_row.secret_ref = '{}'::jsonb THEN
            RAISE EXCEPTION 'PROVIDER_INVALID: the Decision provider must have a credential';
        END IF;
    END IF;
    UPDATE ${s}.provider_cluster_settings
       SET decision_default_provider = v_name,
           decision_default_model = v_model,
           decision_default_reasoning = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_reasoning, '')), '') END,
           decision_default_context = CASE WHEN v_name IS NULL THEN NULL ELSE NULLIF(BTRIM(COALESCE(p_context, '')), '') END
     WHERE singleton;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}
