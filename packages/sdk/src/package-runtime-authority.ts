import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AgentPackageInspection, ExecutablePackageIdentity, ExecutablePackageAdmissionRequest,
    ExecutablePackageAdmissionAuthority } from "./agent-package-authorization.js";

export interface PackageRegistration extends ExecutablePackageIdentity {
    registrationId: string;
    workerNodeId: string;
    workerFence: string;
    reviewRevision: number;
    registryEpoch: number;
    inspection?: AgentPackageInspection;
}
export interface PackageInvocationContext {
    sessionId: string;
    agentName: string;
    effectiveOwner: { provider: string; subject: string };
    ownerEpoch: number;
    capabilityEpoch: number;
}
export interface PackageRuntimeAuthority extends ExecutablePackageAdmissionAuthority {
    register(identity: ExecutablePackageIdentity, workerId: string): Promise<PackageRegistration>;
    context(sessionId: string): Promise<PackageInvocationContext>;
    withLoadAdmission<T>(registration: PackageRegistration, operation: "import" | "factory", start: (signal: AbortSignal) => Promise<T>): Promise<T>;
    heartbeat(registration: PackageRegistration): Promise<boolean>;
    requestFence(registration: PackageRegistration): Promise<void>;
    acknowledgeFence(registration: PackageRegistration, exitObserved: true): Promise<void>;
    fencingStatus(identity: ExecutablePackageIdentity): Promise<{ denied: boolean; complete: boolean; outstanding: number }>;
}

const denied = (reason: string): never => { throw Object.assign(new Error(`AGENT_PACKAGE_EXECUTABLE_DENIED: ${reason}`),
    { code: "AGENT_PACKAGE_EXECUTABLE_DENIED" }); };

/** Admission/audit ordering, not a sandbox or a bound on previously admitted effects. */
export class PgPackageRuntimeAuthority implements PackageRuntimeAuthority {
    private readonly s: string;
    constructor(private readonly pool: Pool, schema: string, readonly leaseMs = 1500) {
        this.s = `"${schema.replace(/"/g, '""')}"`;
    }
    private async tx<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='1s'");
            await client.query(`SELECT ${this.s}.cms_package_runtime_barrier()`);
            const result = await action(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally { client.release(); }
    }
    private async eligible(client: PoolClient, id: ExecutablePackageIdentity): Promise<any> {
        const { rows } = await client.query(`SELECT r.*,v.manifest,p.enabled,
            (SELECT epoch FROM ${this.s}.agent_registry_state WHERE id=1) AS registry_epoch
            FROM ${this.s}.agent_package_reviews r
            JOIN ${this.s}.agent_packages p USING(package_id)
            JOIN ${this.s}.agent_package_versions v ON v.version_id=r.version_id
            WHERE r.package_id=$1 AND r.version_id=$2 AND r.sha256=$3
            AND v.sha256=$3 AND p.enabled AND ${this.s}.cms_package_executable_eligible($1,$2,$3)
            FOR SHARE OF r,p,v`, [id.packageId, id.versionId, id.sha256]);
        if (!rows[0]) denied("exact approved executable identity is unavailable");
        return rows[0];
    }
    async register(id: ExecutablePackageIdentity, workerNodeId: string): Promise<PackageRegistration> {
        return this.tx(async client => {
            const row = await this.eligible(client, id);
            const registrationId = randomUUID(), workerFence = randomUUID();
            await client.query(`INSERT INTO ${this.s}.package_runtime_registrations
                (registration_id,worker_id,generation,package_id,version_id,sha256,review_revision,registry_epoch,state,lease_until,node_version)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',clock_timestamp()+$9*interval '1 millisecond',$10)`,
            [registrationId, workerNodeId, workerFence, id.packageId, id.versionId, id.sha256,
                row.revision, row.registry_epoch, this.leaseMs, process.version]);
            return { ...id, registrationId, workerNodeId, workerFence,
                reviewRevision: Number(row.revision), registryEpoch: Number(row.registry_epoch), inspection: row.inspection };
        });
    }
    private async live(client: PoolClient, reg: PackageRegistration): Promise<any> {
        const row = await this.eligible(client, reg);
        const result = await client.query(`SELECT * FROM ${this.s}.package_runtime_registrations
            WHERE registration_id=$1 AND generation=$2 AND worker_id=$3 AND package_id=$4
              AND version_id=$5 AND sha256=$6 AND state='active' AND lease_until>clock_timestamp() FOR UPDATE`,
        [reg.registrationId, reg.workerFence, reg.workerNodeId, reg.packageId, reg.versionId, reg.sha256]);
        if (!result.rows[0] || Number(row.revision) !== reg.reviewRevision
            || Number(row.registry_epoch) !== reg.registryEpoch) denied("stale registration, approval, registry epoch or worker fence");
        return row;
    }
    private async current(client: PoolClient, sessionId: string): Promise<PackageInvocationContext & { binding: any }> {
        const { rows } = await client.query(`SELECT b.*,ss.package_capability_epoch,root.package_owner_epoch,
            u.provider,u.subject FROM ${this.s}.session_agent_package_bindings b
            JOIN ${this.s}.sessions ss ON ss.session_id=b.session_id AND ss.deleted_at IS NULL
            JOIN ${this.s}.sessions root ON root.session_id=COALESCE(ss.root_session_id,ss.session_id) AND root.deleted_at IS NULL
            JOIN ${this.s}.session_owners so ON so.session_id=root.session_id
            JOIN ${this.s}.users u USING(user_id)
            WHERE b.session_id=$1 FOR SHARE OF b,ss,root,so,u`, [sessionId]);
        const b = rows[0];
        if (!b || b.owner_provider !== b.provider || b.owner_subject !== b.subject) denied("current effective owner or exact binding denied");
        const allowed = await client.query(`SELECT ${this.s}.cms_get_session_agent_package_binding($1) AS binding`, [sessionId]);
        if (!allowed.rows[0]?.binding?.allowed) denied("current enabled/visibility/agent/review check denied");
        return { sessionId, agentName: b.agent_name, effectiveOwner: { provider: b.provider, subject: b.subject },
            ownerEpoch: Number(b.package_owner_epoch), capabilityEpoch: Number(b.package_capability_epoch), binding: b };
    }
    async context(sessionId: string): Promise<PackageInvocationContext> {
        return this.tx(async client => {
            const { binding: _binding, ...context } = await this.current(client, sessionId);
            return context;
        });
    }
    private async audit(client: PoolClient, reg: PackageRegistration, operation: string, target: string,
        event: string, context?: PackageInvocationContext): Promise<void> {
        await client.query(`INSERT INTO ${this.s}.package_runtime_audit
            (registration_id,generation,session_id,operation,target,event,owner_provider,owner_subject)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [reg.registrationId, reg.workerFence, context?.sessionId ?? null, operation, target, event,
            context?.effectiveOwner.provider ?? null, context?.effectiveOwner.subject ?? null]);
    }
    private async admitted<T>(reg: PackageRegistration, operation: string, target: string,
        start: (signal: AbortSignal) => Promise<T>, request?: ExecutablePackageAdmissionRequest): Promise<T> {
        const began = performance.now();
        const dispatchDeadline = Date.now() + 1000;
        let context: PackageInvocationContext | undefined;
        await this.tx(async client => {
            const row = await this.live(client, reg);
            if (request) {
                const now = await this.current(client, request.sessionId), b = now.binding;
                if (b.package_id !== reg.packageId || b.version_id !== reg.versionId || b.sha256 !== reg.sha256
                    || now.agentName !== request.agentName || now.ownerEpoch !== request.expectedOwnerEpoch
                    || now.capabilityEpoch !== request.expectedCapabilityEpoch
                    || now.effectiveOwner.provider !== request.effectiveOwner.provider
                    || now.effectiveOwner.subject !== request.effectiveOwner.subject) denied("stale session content/owner/capability epoch");
                const agent = (row.manifest.agents ?? []).find((a: any) =>
                    a.name === now.agentName || a.name === now.agentName.split(":").at(-1));
                const permission = operation.startsWith("mcp-") ? agent?.mcpServers : agent?.tools;
                if (!Array.isArray(permission) || !permission.includes(target)) denied("operation is not a current bound-agent capability");
                context = now;
            }
            await this.audit(client, reg, operation, target, "admitted", context);
        });
        // A delayed/queued dispatch must obtain a NEW admission, not retain a cached grant.
        if (performance.now() - began > 1000) denied("admission dispatch window elapsed");
        try {
            const signal = AbortSignal.timeout(30_000);
            Object.defineProperty(signal, "packageDispatchDeadline", { value: dispatchDeadline });
            const result = await start(signal);
            await this.tx(client => this.audit(client, reg, operation, target, "completed", context));
            return result;
        } catch (error) {
            await this.tx(client => this.audit(client, reg, operation, target, "failed-or-cancelled", context)).catch(() => {});
            throw error;
        }
    }
    withLoadAdmission<T>(reg: PackageRegistration, operation: "import" | "factory", start: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return this.admitted(reg, operation, "worker-module", start);
    }
    withAdmission<T>(request: ExecutablePackageAdmissionRequest, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (!["tool", "mcp-start", "mcp-tool"].includes(request.operation)) denied("unsupported supervised operation");
        const reg = { ...request, reviewRevision: request.expectedReviewRevision, registryEpoch: request.expectedRegistryEpoch };
        return this.admitted(reg, request.operation, request.target, start, request);
    }
    async heartbeat(reg: PackageRegistration): Promise<boolean> {
        try {
            return await this.tx(async client => {
                await this.live(client, reg);
                await client.query(`UPDATE ${this.s}.package_runtime_registrations
                    SET lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE registration_id=$1 AND generation=$2`,
                [reg.registrationId, reg.workerFence, this.leaseMs]);
                return true;
            });
        } catch { return false; }
    }
    async requestFence(reg: PackageRegistration): Promise<void> {
        await this.tx(async client => {
            await client.query(`UPDATE ${this.s}.package_runtime_registrations SET state='fence_requested',requested_at=clock_timestamp()
                WHERE registration_id=$1 AND generation=$2 AND state='active'`, [reg.registrationId, reg.workerFence]);
        });
    }
    async acknowledgeFence(reg: PackageRegistration, exitObserved: true): Promise<void> {
        if (exitObserved !== true) denied("process exit evidence required");
        await this.tx(async client => {
            await client.query(`UPDATE ${this.s}.package_runtime_registrations SET state='fenced',fenced_at=clock_timestamp()
                WHERE registration_id=$1 AND generation=$2 AND state='fence_requested'`, [reg.registrationId, reg.workerFence]);
            await this.audit(client, reg, "fence", "supervised-processes", "exit-observed");
        });
    }
    async fencingStatus(id: ExecutablePackageIdentity): Promise<{ denied: boolean; complete: boolean; outstanding: number }> {
        return this.tx(async client => {
            const eligible = await client.query(`SELECT ${this.s}.cms_package_executable_eligible($1,$2,$3) AS allowed,
                EXISTS(SELECT 1 FROM ${this.s}.agent_packages WHERE package_id=$1 AND enabled) AS enabled`,
            [id.packageId, id.versionId, id.sha256]);
            const counts = await client.query(`SELECT count(*)::INTEGER AS n FROM ${this.s}.package_runtime_registrations
                WHERE package_id=$1 AND version_id=$2 AND sha256=$3 AND state<>'fenced'`, [id.packageId, id.versionId, id.sha256]);
            const denied = !eligible.rows[0].allowed || !eligible.rows[0].enabled, outstanding = counts.rows[0].n;
            return { denied, outstanding, complete: denied && outstanding === 0 };
        });
    }
}
