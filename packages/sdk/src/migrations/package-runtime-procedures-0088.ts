/** Thin table-access procedures. Callers retain the barrier-first transaction. */
export function packageRuntimeProceduresMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    const procedures: Array<[string, string, string, boolean?]> = [
        ["eligible", "TEXT,TEXT,TEXT", `SELECT r.*,v.manifest,p.enabled,p.active_version_id,
            (SELECT epoch FROM ${s}.agent_registry_state WHERE id=1) AS registry_epoch
            FROM ${s}.agent_package_reviews r JOIN ${s}.agent_packages p USING(package_id)
            JOIN ${s}.agent_package_versions v ON v.version_id=r.version_id
            WHERE r.package_id=$1 AND r.version_id=$2 AND r.sha256=$3 AND v.sha256=$3
            AND p.enabled AND ${s}.cms_package_executable_eligible($1,$2,$3)`],
        ["has_pin", "TEXT,TEXT,TEXT", `SELECT 1 FROM ${s}.session_agent_package_bindings b
            JOIN ${s}.sessions ss USING(session_id)
            WHERE b.package_id=$1 AND b.version_id=$2 AND b.sha256=$3 AND ss.deleted_at IS NULL
            UNION ALL SELECT 1 FROM ${s}.session_executable_package_grants g JOIN ${s}.sessions ss USING(session_id)
            WHERE g.package_id=$1 AND g.version_id=$2 AND g.sha256=$3 AND g.active AND ss.deleted_at IS NULL LIMIT 1`],
        ["register", "TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT,DOUBLE PRECISION,TEXT,TEXT",
            `INSERT INTO ${s}.package_runtime_registrations
            (registration_id,worker_id,generation,package_id,version_id,sha256,review_revision,registry_epoch,state,lease_until,node_version,host_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',clock_timestamp()+$9*interval '1 millisecond',$10,$11) RETURNING *`, true],
        ["live", "TEXT,TEXT,TEXT,TEXT,TEXT,TEXT", `SELECT * FROM ${s}.package_runtime_registrations
            WHERE registration_id=$1 AND generation=$2 AND worker_id=$3 AND package_id=$4
            AND version_id=$5 AND sha256=$6 AND state='active' AND lease_until>clock_timestamp() FOR UPDATE`],
        ["owner", "TEXT", `SELECT ss.package_capability_epoch,root.package_owner_epoch,ss.creation_config,u.provider,u.subject
            FROM ${s}.sessions ss JOIN ${s}.sessions root ON root.session_id=COALESCE(ss.root_session_id,ss.session_id)
            AND root.deleted_at IS NULL JOIN ${s}.session_owners so ON so.session_id=root.session_id
            JOIN ${s}.users u USING(user_id) WHERE ss.session_id=$1 AND ss.deleted_at IS NULL`],
        ["binding", "TEXT", `SELECT * FROM ${s}.session_agent_package_bindings WHERE session_id=$1`],
        ["grant", "TEXT,TEXT,TEXT,TEXT", `SELECT * FROM ${s}.session_executable_package_grants
            WHERE session_id=$1 AND package_id=$2 AND version_id=$3 AND sha256=$4 AND active`],
        ["capabilities", "TEXT", `SELECT state,revision FROM ${s}.session_capabilities WHERE session_id=$1`],
        ["access", "TEXT,TEXT,TEXT", `SELECT 1 FROM ${s}.agent_packages WHERE package_id=$1 AND enabled
            AND (scope='shared' OR (owner_provider=$2 AND owner_subject=$3))`],
        ["audit", "TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT", `INSERT INTO ${s}.package_runtime_audit
            (registration_id,generation,session_id,operation,target,event,owner_provider,owner_subject)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, true],
        ["heartbeat", "TEXT,TEXT,DOUBLE PRECISION", `UPDATE ${s}.package_runtime_registrations
            SET lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE registration_id=$1 AND generation=$2 RETURNING *`, true],
        ["request_fence", "TEXT,TEXT", `UPDATE ${s}.package_runtime_registrations SET state='fence_requested',requested_at=clock_timestamp()
            WHERE registration_id=$1 AND generation=$2 AND state='active' RETURNING *`, true],
        ["registration", "TEXT,TEXT", `SELECT state,host_key FROM ${s}.package_runtime_registrations WHERE registration_id=$1 AND generation=$2`],
        ["processes", "TEXT,TEXT", `SELECT * FROM ${s}.package_runtime_processes WHERE registration_id=$1 AND generation=$2`],
        ["ack_fence", "TEXT,TEXT", `UPDATE ${s}.package_runtime_registrations SET state='fenced',fenced_at=clock_timestamp()
            WHERE registration_id=$1 AND generation=$2 AND state='fence_requested' RETURNING *`, true],
        ["eligibility", "TEXT,TEXT,TEXT", `SELECT ${s}.cms_package_executable_eligible($1,$2,$3) AS allowed,
            EXISTS(SELECT 1 FROM ${s}.agent_packages WHERE package_id=$1 AND enabled) AS enabled`],
        ["outstanding", "TEXT,TEXT,TEXT", `SELECT count(*)::INTEGER AS n FROM ${s}.package_runtime_registrations
            WHERE package_id=$1 AND version_id=$2 AND sha256=$3 AND state<>'fenced'`],
        ["legacy_count", "", `SELECT count(*)::INTEGER AS n FROM ${s}.package_runtime_legacy_workers WHERE state<>'fenced'`],
        ["note_process", "TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT", `INSERT INTO ${s}.package_runtime_processes
            (registration_id,generation,host_key,pid,start_token,role) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`, true],
        ["recoverable", "TEXT", `SELECT *,lease_until<=clock_timestamp() AS expired FROM ${s}.package_runtime_registrations
            WHERE host_key=$1 AND state<>'fenced'`],
        ["local_processes", "TEXT,TEXT,TEXT", `SELECT * FROM ${s}.package_runtime_processes
            WHERE registration_id=$1 AND generation=$2 AND host_key=$3`],
        ["unselect", "TEXT", `UPDATE ${s}.session_executable_package_grants SET active=FALSE WHERE session_id=$1 AND active RETURNING *`, true],
        ["grant_audit", "TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT", `INSERT INTO ${s}.session_executable_package_grant_audit
            (session_id,package_id,version_id,sha256,capability_revision,event,owner_provider,owner_subject)
            VALUES($1,$2,$3,$4,$5,$8,$6,$7) RETURNING *`, true],
        ["package", "TEXT", `SELECT * FROM ${s}.agent_packages WHERE package_id=$1`],
        ["inspection", "TEXT", `SELECT inspection FROM ${s}.agent_package_reviews WHERE version_id=$1`],
        ["version", "TEXT,TEXT", `SELECT v.*,r.inspection FROM ${s}.agent_package_versions v
            JOIN ${s}.agent_package_reviews r USING(version_id) WHERE v.package_id=$1 AND v.sha256=$2`],
        ["select_grant", "TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,JSONB,JSONB,JSONB", `INSERT INTO ${s}.session_executable_package_grants
            (session_id,package_id,version_id,sha256,owner_provider,owner_subject,source_ref,capability_revision,tools,mcp_servers,callbacks)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT(session_id,package_id,version_id,sha256) DO UPDATE SET active=TRUE,
            owner_provider=EXCLUDED.owner_provider,owner_subject=EXCLUDED.owner_subject,
            source_ref=EXCLUDED.source_ref,capability_revision=EXCLUDED.capability_revision,
            tools=EXCLUDED.tools,mcp_servers=EXCLUDED.mcp_servers,callbacks=EXCLUDED.callbacks RETURNING *`, true],
        ["reviews", "", `SELECT r.*,p.name,p.scope,p.owner_provider,p.owner_subject,p.active_version_id,p.activation_revision,v.semver,v.created_by
            FROM ${s}.agent_package_reviews r JOIN ${s}.agent_package_versions v USING(version_id)
            JOIN ${s}.agent_packages p ON p.package_id=r.package_id ORDER BY v.created_at DESC,r.version_id`],
        ["runtime_supported", "", `SELECT to_regclass('${s.replace(/'/g, "''")}.package_runtime_legacy_workers') IS NOT NULL AS supported`],
        ["activation_audit", "TEXT", `SELECT a.* FROM ${s}.agent_package_activation_audit a WHERE package_id=$1 ORDER BY audit_id`],
        ["review_audit", "TEXT", `SELECT a.* FROM ${s}.agent_package_review_audit a WHERE version_id=$1 ORDER BY audit_id`],
        ["capabilities_cas", "TEXT,BIGINT,BIGINT,JSONB", `INSERT INTO ${s}.session_capabilities(session_id,revision,state)
            SELECT $1,$3,$4 WHERE $2=0 ON CONFLICT(session_id) DO UPDATE SET revision=$3,state=$4
            WHERE ${s}.session_capabilities.revision=$2 RETURNING *`, true],
        ["capabilities_update", "TEXT,BIGINT,BIGINT,JSONB", `UPDATE ${s}.session_capabilities SET revision=$3,state=$4
            WHERE session_id=$1 AND revision=$2 RETURNING *`, true],
    ];
    return procedures.map(([name, args, query, modifying]) => {
        const json = ["review_audit", "activation_audit"].includes(name)
            ? `to_jsonb(result) || jsonb_build_object('audit_id',result.audit_id::TEXT)` : "to_jsonb(result)";
        const body = modifying ? `WITH result AS (${query}) SELECT ${json} FROM result`
            : `SELECT ${json} FROM (${query}) result`;
        return `CREATE OR REPLACE FUNCTION ${s}.cms_pkg_${name}(${args}) RETURNS SETOF JSONB
LANGUAGE sql VOLATILE AS $procedure$ ${body}; $procedure$;`;
    }).join("\n");
}
