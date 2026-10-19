import { randomUUID } from "node:crypto";
import { runtimeHostKey, runtimeProcessToken, terminateRecordedProcess } from "./package-runtime-process.js";
import { parseCapabilityRef } from "./capability-catalog.js";
import { packageRuntimeQuery } from "./package-runtime-query.js";
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
    context(sessionId: string, identity?: ExecutablePackageIdentity): Promise<PackageInvocationContext>;
    brokerConfiguration(): Promise<{ schema: string; connection: Record<string, unknown> }>;
    noteProcess(registration: PackageRegistration, pid: number, role: string): Promise<void>;
    recoverLocal(): Promise<void>;
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
    constructor(private readonly pool: Pool, private readonly schemaName: string, readonly leaseMs = 1500) {
        const schema = schemaName;
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
        const { rows } = await packageRuntimeQuery(client, this.s, "eligible", [id.packageId, id.versionId, id.sha256]);
        if (!rows[0]) denied("exact approved executable identity is unavailable");
        return rows[0];
    }
    async register(id: ExecutablePackageIdentity, workerNodeId: string): Promise<PackageRegistration> {
        const hostKey = await runtimeHostKey();
        return this.tx(async client => {
            const row = await this.eligible(client, id);
            if (row.active_version_id !== id.versionId) {
                const existing = await packageRuntimeQuery(client, this.s, "has_pin",
                [id.packageId, id.versionId, id.sha256]);
                if (!existing.rowCount) denied("executable version is not explicitly active or pinned");
            }
            const registrationId = randomUUID(), workerFence = randomUUID();
            await packageRuntimeQuery(client, this.s, "register",
            [registrationId, workerNodeId, workerFence, id.packageId, id.versionId, id.sha256,
                row.revision, row.registry_epoch, this.leaseMs, process.version, hostKey]);
            return { packageId: id.packageId, versionId: id.versionId, sha256: id.sha256, registrationId, workerNodeId, workerFence,
                reviewRevision: Number(row.revision), registryEpoch: Number(row.registry_epoch), inspection: row.inspection };
        });
    }
    private async live(client: PoolClient, reg: PackageRegistration): Promise<any> {
        const row = await this.eligible(client, reg);
        const result = await packageRuntimeQuery(client, this.s, "live",
        [reg.registrationId, reg.workerFence, reg.workerNodeId, reg.packageId, reg.versionId, reg.sha256]);
        if (!result.rows[0] || Number(row.revision) !== reg.reviewRevision
            || Number(row.registry_epoch) !== reg.registryEpoch) denied("stale registration, approval, registry epoch or worker fence");
        return row;
    }
    private async current(client: PoolClient, sessionId: string, identity?: ExecutablePackageIdentity): Promise<PackageInvocationContext & { binding: any }> {
        // The admission barrier orders committed metadata changes. Row SHARE
        // locks invert that order against writers entering BEFORE triggers.
        const { rows } = await packageRuntimeQuery(client, this.s, "owner", [sessionId]);
        const owner = rows[0];
        if (!owner) denied("current effective owner denied");
        const storedPin = (await packageRuntimeQuery(client, this.s, "binding", [sessionId])).rows[0];
        const eligibility = storedPin
            ? (await client.query(`SELECT ${this.s}.cms_get_session_agent_package_binding($1) AS binding`, [sessionId])).rows[0]?.binding
            : null;
        const declarativeRoot = (!storedPin || eligibility?.executable === false)
            && (owner.creation_config?.boundAgentPackageId
                ? (await packageRuntimeQuery(client, this.s, "declarative_root", [sessionId])).rows[0] === true
                : eligibility?.executable === false);
        const pinned = declarativeRoot ? undefined : storedPin;
        if (owner.creation_config?.boundAgentPackageId && !declarativeRoot
            && (!pinned || eligibility?.executable === false)) denied("named executable session requires explicit durable agent pin");
        if (pinned && (owner.creation_config?.boundAgentName && owner.creation_config.boundAgentName !== pinned.agent_name
            || owner.creation_config?.boundAgentPackageId && owner.creation_config.boundAgentPackageId !== pinned.package_id)) {
            denied("current agent configuration conflicts with immutable named-agent pin");
        }
        if (pinned && !eligibility?.allowed) denied("current bound-agent eligibility denied");
        let binding = pinned;
        if (identity && pinned?.package_id !== identity.packageId) {
            binding = (await packageRuntimeQuery(client, this.s, "grant",
            [sessionId, identity.packageId, identity.versionId, identity.sha256])).rows[0];
            if (!binding) denied("exact executable selection pin required");
            const state = (await packageRuntimeQuery(client, this.s, "capabilities", [sessionId])).rows[0];
            const selected = state?.state?.selections?.find((s: any) => s.sourceId === identity.packageId);
            if (!selected || selected.sourceRef !== binding.source_ref || Number(state.revision) !== Number(binding.capability_revision)) {
                denied("current executable capability selection changed");
            }
            binding = { ...binding, agent_name: pinned?.agent_name ?? owner.creation_config?.boundAgentName ?? "pilotswarm",
                agent_package_id: pinned?.package_id ?? null, selected: true };
        } else {
            if (!pinned) denied("current bound-agent eligibility denied");
        }
        if (!binding || binding.owner_provider !== owner.provider || binding.owner_subject !== owner.subject) denied("current owner or pin denied");
        const access = await packageRuntimeQuery(client, this.s, "access", [binding.package_id, owner.provider, owner.subject]);
        if (!access.rowCount) denied("current package visibility/enablement denied");
        return { sessionId, agentName: binding.agent_name, effectiveOwner: { provider: owner.provider, subject: owner.subject },
            ownerEpoch: Number(owner.package_owner_epoch), capabilityEpoch: Number(owner.package_capability_epoch), binding };
    }
    async context(sessionId: string, identity?: ExecutablePackageIdentity): Promise<PackageInvocationContext> {
        return this.tx(async client => {
            const { binding: _binding, ...context } = await this.current(client, sessionId, identity);
            return context;
        });
    }
    private async audit(client: PoolClient, reg: PackageRegistration, operation: string, target: string,
        event: string, context?: PackageInvocationContext): Promise<void> {
        await packageRuntimeQuery(client, this.s, "audit",
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
                const now = await this.current(client, request.sessionId, reg), b = now.binding;
                if (request.expectedSessionBindingRevision !== undefined
                    && (b.selected || !Number.isSafeInteger(request.expectedSessionBindingRevision)
                        || Number(b.revision) !== request.expectedSessionBindingRevision)) denied("stale immutable session binding revision");
                if (b.package_id !== reg.packageId || b.version_id !== reg.versionId || b.sha256 !== reg.sha256
                    || now.agentName !== request.agentName || now.ownerEpoch !== request.expectedOwnerEpoch
                    || now.capabilityEpoch !== request.expectedCapabilityEpoch
                    || now.effectiveOwner.provider !== request.effectiveOwner.provider
                    || now.effectiveOwner.subject !== request.effectiveOwner.subject) denied("stale session content/owner/capability epoch");
                const agent = (row.manifest.agents ?? []).find((a: any) =>
                    a.name === now.agentName || a.name === now.agentName.split(":").at(-1));
                const callback = row.inspection.execution.callbacks?.[target];
                const callbackAgentAllowed = callback?.agents?.includes(now.agentName.split(":").at(-1))
                    && (!b.selected || b.agent_package_id === null || b.agent_package_id === reg.packageId);
                const permission = b.selected ? operation === "handler" ? callbackAgentAllowed ? b.callbacks : [] : operation.startsWith("mcp-") ? b.mcp_servers : b.tools
                    : operation === "handler" ? callbackAgentAllowed ? [target] : []
                    : operation.startsWith("mcp-") ? agent?.mcpServers : agent?.tools;
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
        if (!["tool", "handler", "mcp-start", "mcp-tool"].includes(request.operation)) denied("unsupported supervised operation");
        const reg = { ...request, reviewRevision: request.expectedReviewRevision, registryEpoch: request.expectedRegistryEpoch };
        return this.admitted(reg, request.operation, request.target, start, request);
    }
    async heartbeat(reg: PackageRegistration): Promise<boolean> {
        try {
            return await this.tx(async client => {
                await this.live(client, reg);
                await packageRuntimeQuery(client, this.s, "heartbeat",
                [reg.registrationId, reg.workerFence, this.leaseMs]);
                return true;
            });
        } catch { return false; }
    }
    async requestFence(reg: PackageRegistration): Promise<void> {
        await this.tx(async client => {
            await packageRuntimeQuery(client, this.s, "request_fence", [reg.registrationId, reg.workerFence]);
        });
    }
    async acknowledgeFence(reg: PackageRegistration, exitObserved: true): Promise<void> {
        if (exitObserved !== true) denied("process exit evidence required");
        const host = await runtimeHostKey();
        const row = (await packageRuntimeQuery(this.pool, this.s, "registration", [reg.registrationId, reg.workerFence])).rows[0];
        if (row?.state === "fenced") return;
        if (row?.state !== "fence_requested" || row.host_key !== host) denied("local denied generation required for observed-exit acknowledgement");
        const processes = (await packageRuntimeQuery(this.pool, this.s, "processes", [reg.registrationId, reg.workerFence])).rows;
        for (const recorded of processes) {
            if (recorded.host_key !== host) denied("unreachable process host cannot be acknowledged");
            if (recorded.role === "broker" && recorded.pid === process.pid) continue;
            if (await runtimeProcessToken(recorded.pid) === recorded.start_token) denied("recorded package process has not exited");
        }
        await this.tx(async client => {
            const result = await packageRuntimeQuery(client, this.s, "ack_fence", [reg.registrationId, reg.workerFence]);
            if (result.rowCount) await this.audit(client, reg, "fence", "supervised-processes", "exit-observed");
        });
    }
    async fencingStatus(id: ExecutablePackageIdentity): Promise<{ denied: boolean; complete: boolean; outstanding: number }> {
        return this.tx(async client => {
            const eligible = await packageRuntimeQuery(client, this.s, "eligibility",
            [id.packageId, id.versionId, id.sha256]);
            const counts = await packageRuntimeQuery(client, this.s, "outstanding", [id.packageId, id.versionId, id.sha256]);
            const legacy = (await packageRuntimeQuery(client, this.s, "legacy_count")).rows[0].n;
            const denied = !eligible.rows[0].allowed || !eligible.rows[0].enabled, outstanding = counts.rows[0].n + legacy;
            return { denied, outstanding, complete: denied && outstanding === 0 };
        });
    }
    async brokerConfiguration(): Promise<{ schema: string; connection: Record<string, unknown> }> {
        const client = await this.pool.connect();
        try {
            const p = (client as any).connectionParameters;
            return { schema: this.schemaName, connection: { host: p.host, port: p.port, database: p.database,
                user: p.user, password: p.password, ssl: p.ssl, max: 1, connectionTimeoutMillis: 2000 } };
        } finally { client.release(); }
    }
    async noteProcess(reg: PackageRegistration, pid: number, role: string): Promise<void> {
        const hostKey = await runtimeHostKey(), token = await runtimeProcessToken(pid);
        if (!token) denied("process identity unavailable before executable start");
        await this.tx(async client => {
            await this.live(client, reg);
            await packageRuntimeQuery(client, this.s, "note_process",
            [reg.registrationId, reg.workerFence, hostKey, pid, token, role]);
        });
    }
    async recoverLocal(): Promise<void> {
        const host = await runtimeHostKey();
        const registrations = (await packageRuntimeQuery(this.pool, this.s, "recoverable", [host])).rows;
        for (const row of registrations) {
            const processes = (await packageRuntimeQuery(this.pool, this.s, "local_processes", [row.registration_id, row.generation, host])).rows;
            const broker = processes.find(p => p.role === "broker");
            if (row.state === "active" && !row.expired && (!broker || await runtimeProcessToken(broker.pid) === broker.start_token)) continue;
            const reg = { packageId: row.package_id, versionId: row.version_id, sha256: row.sha256,
                registrationId: row.registration_id, workerFence: row.generation, workerNodeId: row.worker_id,
                reviewRevision: Number(row.review_revision), registryEpoch: Number(row.registry_epoch) };
            await this.requestFence(reg);
            // Freeze the creator before reading the final process inventory.
            // Otherwise a preparation committed between the first snapshot and
            // the fence could be omitted from recovery.
            if (broker) await terminateRecordedProcess(broker.pid, broker.start_token);
            const finalProcesses = (await packageRuntimeQuery(this.pool, this.s, "local_processes", [row.registration_id, row.generation, host])).rows;
            for (const process of finalProcesses) if (process.role !== "broker") await terminateRecordedProcess(process.pid, process.start_token);
            await this.acknowledgeFence(reg, true);
        }
    }
    async syncSelectionGrants(client: PoolClient, sessionId: string, state: any): Promise<void> {
        const owner = (await packageRuntimeQuery(client, this.s, "owner", [sessionId])).rows[0];
        const old = (await packageRuntimeQuery(client, this.s, "unselect", [sessionId])).rows;
        for (const grant of old) await packageRuntimeQuery(client, this.s, "grant_audit",
        [sessionId, grant.package_id, grant.version_id, grant.sha256, state.revision, grant.owner_provider, grant.owner_subject, "unselected"]);
        for (const selection of state.selections ?? []) {
            const pkg = (await packageRuntimeQuery(client, this.s, "package", [selection.sourceId])).rows[0];
            if (!pkg) continue;
            if (!selection.sourceRef) {
                const active = (await packageRuntimeQuery(client, this.s, "inspection", [pkg.active_version_id])).rows[0];
                if (active?.inspection?.executable === false) continue;
                denied("executable selection requires exact immutable source reference");
            }
            const ref = parseCapabilityRef(selection.sourceRef);
            if (ref.k !== "source" || ref.s !== pkg.package_id || !owner || !pkg.enabled
                || pkg.scope !== "shared" && (pkg.owner_provider !== owner.provider || pkg.owner_subject !== owner.subject)) denied("selection owner/visibility/ref denied");
            const version = (await packageRuntimeQuery(client, this.s, "version", [pkg.package_id, ref.r])).rows[0];
            if (!version) denied("exact selection version missing");
            if (!version.inspection?.executable) continue;
            if (pkg.active_version_id !== version.version_id && !old.some(g =>
                g.package_id === pkg.package_id && g.version_id === version.version_id && g.sha256 === version.sha256
                && g.owner_provider === owner.provider && g.owner_subject === owner.subject)) {
                denied("new executable selection requires explicitly active version");
            }
            await this.eligible(client, { packageId: pkg.package_id, versionId: version.version_id, sha256: version.sha256 });
            const previous = old.find(g => g.package_id === pkg.package_id);
            if (previous && (previous.version_id !== version.version_id || previous.sha256 !== version.sha256)
                && previous.source_ref === selection.sourceRef) denied("implicit executable version substitution");
            await packageRuntimeQuery(client, this.s, "select_grant",
            [sessionId, pkg.package_id, version.version_id, version.sha256, owner.provider, owner.subject,
                selection.sourceRef, state.revision, JSON.stringify(selection.tools ?? []),
                JSON.stringify(selection.mcpServers ?? []), JSON.stringify(selection.callbacks ?? [])]);
            await packageRuntimeQuery(client, this.s, "grant_audit",
            [sessionId, pkg.package_id, version.version_id, version.sha256, state.revision, owner.provider, owner.subject, "selected"]);
        }
    }
}
