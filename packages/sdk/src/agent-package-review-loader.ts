/**
 * Loads an exact pending review candidate and its baseline for the review
 * diff, the package-reviewer tools and the advisory report. Shared so every
 * surface verifies the same digests against the same records. Data only: it
 * never imports or executes package content.
 */
import type { AgentPackageSelector, AgentPrincipal, SessionCatalog } from "./cms.js";
import type { ArtifactStore } from "./session-store.js";
import type { AgentPackageReviewCandidate } from "./agent-package-authorization.js";
import { fetchAgentPackageTarGz } from "./agent-package-service.js";
import { readAgentPackageTarGz, type ExtractedTarEntry } from "./agent-package-format.js";
import {
    buildAgentPackageReviewDiff,
    selectReviewBaseline,
    type AgentPackageReviewDiff,
    type AgentPackageReviewVersionRef,
    type ReviewBaselineSource,
} from "./agent-package-review-diff.js";

export interface AgentPackageReviewTargetInput {
    packageId: string;
    versionId: string;
    sha256: string;
    baselineVersionId?: string | null;
    /** False: list changes with line counts but no patch text. */
    patches?: boolean;
}

export interface AgentPackageReviewTarget {
    candidate: AgentPackageReviewCandidate;
    candidateRef: AgentPackageReviewVersionRef;
    baseline: AgentPackageReviewVersionRef | null;
    baselineSource: ReviewBaselineSource;
}

function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

/** Authenticated administrator with an exact candidate digest; every caller checks the same way. */
export function requireReviewAdmin(owner: AgentPrincipal | null, isAdmin: boolean): AgentPrincipal {
    if (isAdmin !== true || !owner?.provider || !owner.subject) fail("FORBIDDEN", "Authenticated administrator required");
    return owner;
}

export function requireExactReviewInput(input: AgentPackageReviewTargetInput): void {
    if (!input || typeof input.packageId !== "string" || typeof input.versionId !== "string"
        || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) {
        fail("INVALID_REQUEST", "Exact candidate package/version/digest required");
    }
    if (input.baselineVersionId != null && typeof input.baselineVersionId !== "string") {
        fail("INVALID_REQUEST", "baselineVersionId must be a version ID or null");
    }
}

/** The exact pending candidate and the baseline the review policy selects for it. */
export async function resolveAgentPackageReviewTarget(
    catalog: SessionCatalog | null | undefined, owner: AgentPrincipal | null, isAdmin: boolean, input: AgentPackageReviewTargetInput,
): Promise<AgentPackageReviewTarget> {
    const principal = requireReviewAdmin(owner, isAdmin);
    requireExactReviewInput(input);
    if (!catalog?.packageReviews) fail("UNAVAILABLE", "Package review catalog unavailable");
    const actor = { principal, isAdmin: true };
    const candidate = (await catalog.packageReviews.list(actor)).find((row) =>
        row.packageId === input.packageId && row.versionId === input.versionId && row.sha256 === input.sha256);
    if (!candidate) fail("CONFLICT", "Candidate not found for this exact package/version/digest; refresh the review list");
    const status = await catalog.packageReviews.publisherStatus(actor, candidate.packageId);
    const refs: AgentPackageReviewVersionRef[] = status.versions.map((version) => ({
        packageId: version.packageId, versionId: version.versionId, sha256: version.sha256,
        semver: version.semver, decision: version.decision, active: version.active,
    }));
    const { baseline, source } = selectReviewBaseline(refs, candidate.versionId, input.baselineVersionId ?? null);
    const candidateRef = refs.find((ref) => ref.versionId === candidate.versionId) ?? {
        packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
        semver: candidate.semver, decision: candidate.decision, active: false,
    };
    return { candidate, candidateRef, baseline, baselineSource: source };
}

function packageSelector(candidate: AgentPackageReviewCandidate): AgentPackageSelector {
    const owner = candidate.owner?.provider && candidate.owner.subject
        ? { provider: candidate.owner.provider, subject: candidate.owner.subject } : null;
    return { scope: candidate.scope, ...(owner ? { owner } : {}) };
}

/** Both sides' artifact entries, each verified against its recorded digest. */
export async function loadAgentPackageReviewEntries(
    catalog: SessionCatalog, artifactStore: ArtifactStore | null | undefined,
    owner: AgentPrincipal, target: AgentPackageReviewTarget,
): Promise<{ candidateEntries: ExtractedTarEntry[]; baselineEntries: ExtractedTarEntry[] }> {
    if (!artifactStore) fail("UNAVAILABLE", "agent-package artifact operations require an artifact store");
    const detail = await catalog.getAgentPackage(target.candidate.name, owner, true, packageSelector(target.candidate));
    const read = async (ref: { versionId: string; sha256: string }) => {
        const version = detail?.versions.find((item) => item.versionId === ref.versionId);
        if (!version || version.sha256 !== ref.sha256) {
            fail("CONFLICT", `Version ${ref.versionId} digest does not match the review record`);
        }
        return readAgentPackageTarGz(await fetchAgentPackageTarGz(artifactStore, version.artifactFilename, version.sha256));
    };
    const candidateEntries = await read(target.candidate);
    const baselineEntries = target.baseline ? await read(target.baseline) : [];
    return { candidateEntries, baselineEntries };
}

export function buildReviewDiffForTarget(
    target: AgentPackageReviewTarget,
    entries: { candidateEntries: ExtractedTarEntry[]; baselineEntries: ExtractedTarEntry[] },
    opts: { includePatches?: boolean } = {},
): AgentPackageReviewDiff {
    const { candidate } = target;
    return buildAgentPackageReviewDiff({
        candidate: {
            packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
            semver: candidate.semver, decision: candidate.decision, active: target.candidateRef.active === true,
            revision: candidate.revision, name: candidate.name, scope: candidate.scope, publisher: candidate.publisher,
        },
        baseline: target.baseline,
        baselineSource: target.baselineSource,
        candidateEntries: entries.candidateEntries,
        baselineEntries: entries.baselineEntries,
        inspectionReasons: candidate.inspection?.reasons ?? ["Legacy artifact: no verified inspection"],
        includePatches: opts.includePatches !== false,
    });
}

/** Load and diff in one step: the review diff API and the reviewer's diff tool. */
export async function loadAgentPackageReviewDiff(
    catalog: SessionCatalog | null | undefined, artifactStore: ArtifactStore | null | undefined,
    owner: AgentPrincipal | null, isAdmin: boolean, input: AgentPackageReviewTargetInput,
): Promise<AgentPackageReviewDiff> {
    const target = await resolveAgentPackageReviewTarget(catalog, owner, isAdmin, input);
    return buildReviewDiffForTarget(target, await loadAgentPackageReviewEntries(catalog!, artifactStore, owner!, target),
        { includePatches: input.patches !== false });
}
