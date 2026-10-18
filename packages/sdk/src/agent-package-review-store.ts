import type { Pool } from "pg";
import { inspectAgentPackageArtifact } from "./agent-package-authorization.js";
import type {
    AgentPackageReviewAudit,
    AgentPackageReviewCandidate,
    AgentPackageReviewMutation,
    AgentPackageActivationMutation,
    SessionAgentPackageBinding,
    SessionAgentPackageRebind,
} from "./agent-package-authorization.js";

/** Server-resolved identity only. A request body must never supply this value. */
export interface AgentPackageReviewActor {
    principal: { provider: string; subject: string } | null;
    isAdmin: boolean;
}

export interface AgentPackageReviewCatalog {
    list(actor: AgentPackageReviewActor): Promise<AgentPackageReviewCandidate[]>;
    decide(actor: AgentPackageReviewActor, input: AgentPackageReviewMutation): Promise<void>;
    audit(actor: AgentPackageReviewActor, versionId: string): Promise<AgentPackageReviewAudit[]>;
    activate(actor: AgentPackageReviewActor, input: AgentPackageActivationMutation): Promise<void>;
    activationAudit(actor: AgentPackageReviewActor, packageId: string): Promise<Record<string, unknown>[]>;
    getSessionBinding(sessionId: string): Promise<SessionAgentPackageBinding | null>;
    bindNewSession(sessionId: string, packageId: string, agentName: string): Promise<void>;
    /** Trusted installer boundary; accepts canonical bytes, never caller-supplied inspection claims. */
    inspectArtifact(identity: { packageId: string; versionId: string; sha256: string }, expectedRevision: number, artifact: Buffer): Promise<void>;
    rebind(actor: AgentPackageReviewActor, input: SessionAgentPackageRebind): Promise<void>;
}

export class AgentPackageReviewError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

export class PgAgentPackageReviewStore implements AgentPackageReviewCatalog {
    private readonly schema: string;
    constructor(private readonly pool: Pool, schema: string) {
        this.schema = `"${schema.replace(/"/g, '""')}"`;
    }

    private requireAdmin(actor: AgentPackageReviewActor): void {
        if (actor?.isAdmin !== true || !actor.principal?.provider || !actor.principal?.subject) {
            throw new AgentPackageReviewError("FORBIDDEN", "Authenticated administrator required");
        }
    }

    async list(actor: AgentPackageReviewActor): Promise<AgentPackageReviewCandidate[]> {
        this.requireAdmin(actor);
        const query = {
            text: `SELECT r.*, p.name, p.scope, p.owner_provider, p.owner_subject,
                p.active_version_id, p.activation_revision, v.semver, v.created_by
                FROM ${this.schema}.agent_package_reviews r
                JOIN ${this.schema}.agent_package_versions v USING(version_id)
                JOIN ${this.schema}.agent_packages p ON p.package_id = r.package_id
                ORDER BY v.created_at DESC, r.version_id`,
            query_timeout: 6_000,
        };
        const { rows } = await this.pool.query(query);
        return rows.map((r: any) => ({
            packageId: r.package_id, versionId: r.version_id, sha256: r.sha256,
            name: r.name, semver: r.semver, scope: r.scope, publisher: r.created_by ?? null,
            owner: r.owner_provider && r.owner_subject ? { provider: r.owner_provider, subject: r.owner_subject } : null,
            priorActiveVersionId: r.prior_active_version_id ?? null,
            decision: r.decision, revision: Number(r.revision), inspection: r.inspection ?? null,
            activationRevision: Number(r.activation_revision), activeVersionId: r.active_version_id ?? null,
            approvalScope: "artifact-content",
        }));
    }

    async decide(actor: AgentPackageReviewActor, input: AgentPackageReviewMutation): Promise<void> {
        this.requireAdmin(actor);
        if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
            || !/^[a-f0-9]{64}$/.test(input.sha256) || !input.reason?.trim()) {
            throw new AgentPackageReviewError("INVALID_REQUEST", "Exact candidate digest, revision and reason required");
        }
        return this.mutate("cms_review_agent_package", [
            input.packageId, input.versionId, input.sha256, input.expectedRevision, input.decision, input.reason,
            actor.principal!.provider, actor.principal!.subject, true,
        ]);
    }

    async activate(actor: AgentPackageReviewActor, input: AgentPackageActivationMutation): Promise<void> {
        this.requireAdmin(actor);
        if (!input || !Number.isSafeInteger(input.expectedReviewRevision) || input.expectedReviewRevision < 1
            || !Number.isSafeInteger(input.expectedActivationRevision) || input.expectedActivationRevision < 1
            || !/^[a-f0-9]{64}$/.test(input.sha256) || !input.reason?.trim()
            || !(input.expectedActiveVersionId === null || typeof input.expectedActiveVersionId === "string")) {
            throw new AgentPackageReviewError("INVALID_REQUEST", "Exact target, review/activation revisions, prior pointer and reason required");
        }
        return this.mutate("cms_activate_agent_package", [
            input.packageId, input.versionId, input.sha256, input.expectedReviewRevision,
            input.expectedActivationRevision, input.expectedActiveVersionId, input.reason,
            actor.principal!.provider, actor.principal!.subject, true,
        ]);
    }

    async activationAudit(actor: AgentPackageReviewActor, packageId: string): Promise<Record<string, unknown>[]> {
        this.requireAdmin(actor);
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.schema}.agent_package_activation_audit WHERE package_id=$1 ORDER BY audit_id`, [packageId]);
        return rows;
    }

    async getSessionBinding(sessionId: string): Promise<SessionAgentPackageBinding | null> {
        const { rows } = await this.pool.query(
            `SELECT ${this.schema}.cms_get_session_agent_package_binding($1) AS binding`, [sessionId]);
        return rows[0]?.binding ?? null;
    }

    async bindNewSession(sessionId: string, packageId: string, agentName: string): Promise<void> {
        return this.mutate("cms_bind_new_session_agent_package", [sessionId, packageId, agentName]);
    }

    async inspectArtifact(
        identity: { packageId: string; versionId: string; sha256: string }, expectedRevision: number, artifact: Buffer,
    ): Promise<void> {
        const inspection = inspectAgentPackageArtifact(artifact, identity.sha256);
        return this.mutate("cms_record_agent_package_inspection", [
            identity.packageId, identity.versionId, identity.sha256, expectedRevision, JSON.stringify(inspection),
        ]);
    }

    async rebind(actor: AgentPackageReviewActor, input: SessionAgentPackageRebind): Promise<void> {
        this.requireAdmin(actor);
        if (!input || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 0
            || !/^[a-f0-9]{64}$/.test(input.sha256) || !input.reason?.trim() || !input.agentName || !input.sessionId) {
            throw new AgentPackageReviewError("INVALID_REQUEST", "Exact session/agent/version/digest, binding revision and reason required");
        }
        return this.mutate("cms_rebind_session_agent_package", [
            input.sessionId, input.packageId, input.versionId, input.sha256, input.agentName,
            input.expectedBindingRevision, input.reason, actor.principal!.provider, actor.principal!.subject, true,
        ]);
    }

    private async mutate(name: string, values: unknown[]): Promise<void> {
        // Statement and lock timeouts bound a decision waiting on publication.
        // This is an administrative transaction, NOT a worker execution lease.
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '5s'");
            await client.query(
                `SELECT ${this.schema}.${name}(${values.map((_, i) => `$${i + 1}`).join(",")})`, values,
            );
            await client.query("COMMIT");
            client.release();
        } catch (error: any) {
            client.release(error instanceof Error ? error : new Error(String(error)));
            const match = /^AGENT_PACKAGE_REVIEW_(FORBIDDEN|CONFLICT|INVALID|BLOCKED|NOT_FOUND):\s*(.*)$/s.exec(error?.message ?? "");
            if (match) throw new AgentPackageReviewError(
                ({ INVALID: "INVALID_REQUEST", BLOCKED: "PRECONDITION_FAILED" } as Record<string, string>)[match[1]] ?? match[1],
                match[2],
            );
            throw error;
        }
    }

    async audit(actor: AgentPackageReviewActor, versionId: string): Promise<AgentPackageReviewAudit[]> {
        this.requireAdmin(actor);
        const query = {
            text: `SELECT * FROM ${this.schema}.agent_package_review_audit WHERE version_id = $1 ORDER BY audit_id`,
            values: [versionId], query_timeout: 6_000,
        };
        const { rows } = await this.pool.query(query);
        return rows.map((r: any) => ({
            auditId: String(r.audit_id), packageId: r.package_id, versionId: r.version_id, sha256: r.sha256,
            actor: { provider: r.actor_provider, subject: r.actor_subject }, at: new Date(r.at),
            reason: r.reason, before: r.before_decision, after: r.after_decision, revision: Number(r.revision),
        }));
    }
}
