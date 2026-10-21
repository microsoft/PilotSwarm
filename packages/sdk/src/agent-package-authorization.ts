/**
 * Published-package trust boundaries. Inspection is data-only: it never
 * imports a package, invokes a factory, or starts an MCP process.
 */
import { createHash } from "node:crypto";
import { agentPackageTarSha256, readAgentPackageTarGz } from "./agent-package-format.js";
import { verifyPackageRuntime, type VerifiedPackageRuntime } from "./package-runtime-format.js";

export interface ExecutablePackageIdentity {
    packageId: string;
    versionId: string;
    sha256: string;
}

export type PackageReviewDecision = "pending" | "approved" | "rejected" | "revoked" | "not_required";

export interface AgentPackageInspection {
    format: 1;
    sha256: string;
    name: string;
    semver: string;
    executable: boolean;
    reasons: string[];
    /** Digest and size of EVERY artifact file, including configuration. */
    files: { path: string; sha256: string; sizeBytes: number }[];
    /** Execution blockers, independent of an administrator's artifact-content decision. */
    approvalBlockers: string[];
    execution?: VerifiedPackageRuntime;
}

export interface AgentPackageReviewCandidate extends ExecutablePackageIdentity {
    name: string;
    semver: string;
    publisher: string | null;
    scope: "shared" | "user";
    owner: { provider: string; subject: string } | null;
    priorActiveVersionId: string | null;
    decision: PackageReviewDecision;
    revision: number;
    activationRevision: number;
    activeVersionId: string | null;
    /** Content acceptance never certifies external executable dependencies. */
    approvalScope: "artifact-content";
    inspection: AgentPackageInspection | null;
    runtimeFencing?: { denied: boolean; complete: boolean; outstanding: number };
}

export interface AgentPackageReviewMutation extends ExecutablePackageIdentity {
    expectedRevision: number;
    decision: "approved" | "rejected" | "revoked";
    reason: string;
    /**
     * The baseline the reviewer was shown by the review diff; `null` for a new
     * package. Validated against the same package and recorded in the audit.
     */
    baseline?: { versionId: string; sha256: string } | null;
}

export interface AgentPackageActivationMutation extends ExecutablePackageIdentity {
    expectedReviewRevision: number;
    expectedActivationRevision: number;
    expectedActiveVersionId: string | null;
    reason: string;
}

export interface SessionAgentPackageBinding extends ExecutablePackageIdentity {
    /** False only for an exactly inspected declarative artifact; absent is unverified. */
    executable?: boolean;
    sessionId: string;
    agentName: string;
    revision: number;
    owner: { provider: string; subject: string };
    /** Current metadata eligibility only; NOT an invocation grant or fence. */
    allowed: boolean;
}

export interface AgentPackageVersionReview extends ExecutablePackageIdentity {
    decision: PackageReviewDecision;
    executable: boolean;
    active: boolean;
}

export interface AgentPackagePublisherStatus {
    packageId: string;
    name: string;
    activeVersionId: string | null;
    versions: Array<AgentPackageVersionReview & { semver: string; reasons: string[] }>;
}

export interface SessionAgentPackageRebind extends ExecutablePackageIdentity {
    sessionId: string;
    agentName: string;
    /** Zero explicitly creates a previously missing binding; never auto-upgrades history. */
    expectedBindingRevision: number;
    reason: string;
}

export interface AgentPackageReviewAudit {
    auditId: string;
    packageId: string;
    versionId: string;
    sha256: string;
    actor: { provider: string; subject: string };
    at: Date;
    reason: string;
    before: PackageReviewDecision;
    after: PackageReviewDecision;
    revision: number;
}

/**
 * Provider-neutral future activity boundary, not an authorization token.
 * Implementations must serialize admission with revocation and session ACL,
 * owner and capability changes. A cached grant/registry row is insufficient.
 * withAdmission may invoke start only while holding current admission
 * authority; a worker losing authority MUST NOT start queued work.
 */
export interface ExecutablePackageAdmissionRequest extends ExecutablePackageIdentity {
    sessionId: string;
    effectiveOwner: { provider: string; subject: string };
    agentName: string;
    operation: "import" | "factory" | "precheck" | "handler" | "tool" | "mcp-start" | "mcp-tool";
    registrationId: string;
    target: string;
    expectedReviewRevision: number;
    expectedRegistryEpoch: number;
    expectedOwnerEpoch: number;
    expectedCapabilityEpoch: number;
    expectedSessionBindingRevision?: number;
    workerNodeId: string;
    workerFence: string;
}

export interface ExecutablePackageAdmissionAuthority {
    withAdmission<T>(
        request: ExecutablePackageAdmissionRequest,
        start: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
}

export class ExecutablePackageDeniedError extends Error {
    readonly code = "AGENT_PACKAGE_EXECUTABLE_DENIED";
    constructor(message: string) {
        super(`AGENT_PACKAGE_EXECUTABLE_DENIED: ${message}`);
        this.name = "ExecutablePackageDeniedError";
    }
}

/**
 * A cached approval boolean cannot replace eligible supervised authority.
 * Providers/loaders without that authority keep the entire package quarantined.
 */
export function denyPublishedPackageExecution(): never {
    throw new ExecutablePackageDeniedError(
        "published executable package has no eligible supervised runtime authority; cached approval is not an execution grant",
    );
}

const DECLARATIVE_EXTENSIONS = /\.(?:md|txt|json|ya?ml|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf)$/i;
const DECLARATIVE_METADATA = /(?:^|\/)(?:LICENSE(?:\.[a-z0-9-]+)?|NOTICE|COPYING|README|CHANGELOG|\.gitignore|\.gitattributes|\.editorconfig|\.npmignore)$/i;
const EXECUTABLE_KEYS = /^(?:tools|workerModule|workerModules|callbacks?|prechecks?|handlers?|command|commands|scripts|mcpConfig|mcpServers)$/i;

function executableDeclarations(value: unknown, at: string, reasons: Set<string>): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        if (EXECUTABLE_KEYS.test(key) && child != null
            && child !== false && child !== "" && (!Array.isArray(child) || child.length > 0)) {
            reasons.add(`executable declaration: ${at}.${key}`);
        }
        executableDeclarations(child, `${at}.${key}`, reasons);
    }
}

export function inspectAgentPackageArtifact(targz: Buffer, expectedSha256: string): AgentPackageInspection {
    const sha256 = agentPackageTarSha256(targz);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256 !== expectedSha256) {
        throw new ExecutablePackageDeniedError("artifact digest mismatch");
    }
    const entries = readAgentPackageTarGz(targz);
    const names = new Set<string>();
    const reasons = new Set<string>();
    let manifest: Record<string, unknown> | null = null;
    for (const entry of entries) {
        // Windows and POSIX workers must agree about which file was reviewed.
        const normalized = entry.name.toLowerCase();
        if (names.has(normalized) || entry.name.split("/").some((part) =>
            part === "." || /[.: ]$/.test(part) || part.includes(":"))) {
            throw new ExecutablePackageDeniedError(`ambiguous artifact path: ${entry.name}`);
        }
        names.add(normalized);
        if (normalized === ".pilotswarm-meta.json") {
            throw new ExecutablePackageDeniedError("reserved cache metadata in artifact");
        }
        if (normalized === "plugin.json") {
            const parsed = JSON.parse(entry.body.toString("utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
                || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
                throw new ExecutablePackageDeniedError("invalid artifact manifest");
            }
            manifest = parsed;
            executableDeclarations(manifest, "plugin", reasons);
        }
        if (/(?:^|\/)(?:tools|mcp-servers|node_modules)\//i.test(entry.name)
            || /(?:^|\/)\.mcp\.json$/i.test(entry.name)
            || (!DECLARATIVE_EXTENSIONS.test(entry.name) && !DECLARATIVE_METADATA.test(entry.name))) {
            reasons.add(`executable or unrecognized file: ${entry.name}`);
        }
        if (/(?:^|\/)package\.json$/i.test(entry.name)) {
            const config = JSON.parse(entry.body.toString("utf8"));
            const executableFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
                "scripts", "bin", "main", "module", "imports", "exports"];
            if (executableFields.some((key) => config?.[key] != null && config[key] !== false
                && config[key] !== "" && (typeof config[key] !== "object" || Object.keys(config[key]).length > 0))) {
                reasons.add(`dependency or executable configuration: ${entry.name}`);
            }
        } else if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json)$/i.test(entry.name)) {
            reasons.add(`dependency configuration: ${entry.name}`);
        }
    }
    if (!manifest) throw new ExecutablePackageDeniedError("artifact has no plugin.json");
    let execution: VerifiedPackageRuntime | undefined;
    let unsupported: string | undefined;
    if (reasons.size) {
        try { execution = verifyPackageRuntime(targz, expectedSha256); }
        catch (error) { unsupported = error instanceof Error ? error.message : String(error); }
    }
    return {
        format: 1,
        sha256,
        name: manifest.name as string,
        semver: manifest.version as string,
        executable: reasons.size > 0,
        reasons: [...reasons].sort(),
        files: entries.map((entry) => ({
            path: entry.name,
            sha256: createHash("sha256").update(entry.body).digest("hex"),
            sizeBytes: entry.body.length,
        })).sort((a, b) => a.path.localeCompare(b.path)),
        ...(execution ? { execution } : {}),
        approvalBlockers: reasons.size > 0 ? [unsupported ??
            "Requires approved supervised runtime registration and authoritative invocation admission."] : [],
    };
}
