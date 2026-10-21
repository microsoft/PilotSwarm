/**
 * Review diff for an executable package candidate: a digest-bound,
 * deterministic comparison against a baseline version, with every changed
 * path classified by review risk. It is a review aid only. It never imports
 * package code, and it is not an approval or a security proof.
 */
import { createHash } from "node:crypto";
import { DIFF_MAX_FILES, diffPackageTrees, entriesToMap, type FilePatch, type PackageEntry } from "./agent-package-diff.js";
import type { ExecutablePackageIdentity, PackageReviewDecision } from "./agent-package-authorization.js";

export type ReviewChangeGroup = "executable" | "dependency" | "capability" | "precheck-policy" | "declarative";

/** Highest review risk first. */
export const REVIEW_CHANGE_GROUPS: readonly ReviewChangeGroup[] = [
    "executable", "dependency", "capability", "precheck-policy", "declarative",
];

export interface ReviewFileChange extends FilePatch {
    group: ReviewChangeGroup;
    /** Set when the content is shown only as hashes: binary, oversized or unparseable. */
    flagged?: string;
    oldSha256?: string;
    newSha256?: string;
    /** Changed top-level manifest keys, MCP servers or agent frontmatter keys. */
    changedKeys?: string[];
    /** Added and removed lines in the unified patch (absent when no textual patch exists). */
    additions?: number;
    deletions?: number;
    /** Summary mode: a patch exists but was left out; fetch it per file. */
    patchOmitted?: boolean;
}

export interface AgentPackageReviewVersionRef extends ExecutablePackageIdentity {
    semver: string;
    decision?: PackageReviewDecision;
    active?: boolean;
}

export type ReviewBaselineSource = "explicit" | "approved" | "active" | "none";

export interface AgentPackageReviewDiff {
    candidate: AgentPackageReviewVersionRef & { revision: number; name: string; scope: string; publisher: string | null };
    baseline: AgentPackageReviewVersionRef | null;
    baselineSource: ReviewBaselineSource;
    identical: boolean;
    summary: Record<ReviewChangeGroup, number> & { flagged: number; total: number };
    changes: ReviewFileChange[];
    truncated?: { omitted: number };
    inspectionReasons: string[];
    advisory: string;
}

export const REVIEW_DIFF_ADVISORY =
    "Classification and diff are review aids only. They are not an approval or a security proof; approval binds the exact candidate digest.";

/** One file of a review, loaded on demand for the same exact candidate and baseline. */
export interface AgentPackageReviewFileDiff {
    candidate: { packageId: string; versionId: string; sha256: string };
    baseline: { versionId: string; sha256: string } | null;
    baselineSource: ReviewBaselineSource;
    change: ReviewFileChange;
    advisory: string;
}

const DEPENDENCY_PATH = /(?:^|\/)(?:node_modules\/|package\.json$|package-lock\.json$|npm-shrinkwrap\.json$|yarn\.lock$|pnpm-lock\.yaml$)/i;
const EXECUTABLE_PATH = /\.(?:js|mjs|cjs|ts|mts|cts|sh|ps1|py|wasm|node)$/i;
const EXECUTABLE_DIR = /(?:^|\/)(?:tools|mcp-servers)\//i;
const DECLARATIVE_FILE = /\.(?:md|txt|json|ya?ml|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf)$/i;
const CAPABILITY_KEY = /^(?:tools|callbacks?|mcpServers|mcp-servers|mcpConfig|workerModules?|handlers?|commands?|scripts|grants?|capabilities|permissions|skills)$/i;
const PRECHECK_KEY = /^(?:cronPrechecks?|cron-prechecks?)$/i;

function rank(group: ReviewChangeGroup): number {
    return REVIEW_CHANGE_GROUPS.indexOf(group);
}

function higher(a: ReviewChangeGroup, b: ReviewChangeGroup): ReviewChangeGroup {
    return rank(a) <= rank(b) ? a : b;
}

function parseJson(buf: Buffer | undefined): { ok: true; value: any } | { ok: false } {
    if (!buf) return { ok: true, value: {} };
    try { return { ok: true, value: JSON.parse(buf.toString("utf8")) }; } catch { return { ok: false }; }
}

function changedObjectKeys(left: any, right: any): string[] {
    const a = left && typeof left === "object" && !Array.isArray(left) ? left : {};
    const b = right && typeof right === "object" && !Array.isArray(right) ? right : {};
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
        .sort();
}

/** Top-level frontmatter blocks keyed by name, each with its continuation lines. */
function frontmatterBlocks(buf: Buffer | undefined): Map<string, string> {
    const blocks = new Map<string, string>();
    if (!buf) return blocks;
    const text = buf.toString("utf8").replace(/\r\n/g, "\n");
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
    if (!match) return blocks;
    let key: string | null = null;
    for (const line of match[1].split("\n")) {
        const top = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
        if (top) {
            key = top[1];
            blocks.set(key, line);
        } else if (key) {
            blocks.set(key, `${blocks.get(key)}\n${line}`);
        }
    }
    return blocks;
}

function groupForKeys(keys: string[], fallback: ReviewChangeGroup): ReviewChangeGroup {
    let group = fallback;
    for (const key of keys) {
        if (CAPABILITY_KEY.test(key)) group = higher(group, "capability");
        else if (PRECHECK_KEY.test(key)) group = higher(group, "precheck-policy");
    }
    return group;
}

/**
 * Classify one changed path by the highest review risk it carries. Parsing is
 * data-only; nothing is imported or executed.
 */
export function classifyReviewChange(
    path: string,
    oldBuf: Buffer | undefined,
    newBuf: Buffer | undefined,
): Pick<ReviewFileChange, "group" | "changedKeys" | "flagged"> {
    const lower = path.toLowerCase();
    if (DEPENDENCY_PATH.test(lower)) return { group: "dependency" };
    if (lower === ".mcp.json" || lower.endsWith("/.mcp.json")) {
        const left = parseJson(oldBuf);
        const right = parseJson(newBuf);
        if (!left.ok || !right.ok) return { group: "dependency", flagged: "unparseable MCP configuration" };
        const servers = (value: any) => value?.mcpServers ?? value?.servers ?? value ?? {};
        const before = servers(left.value);
        const after = servers(right.value);
        const changedKeys = changedObjectKeys(before, after);
        // A changed command/args/env of an existing server is runtime config;
        // adding or removing a server changes capabilities.
        const runtimeChange = changedKeys.some((key) => Object.hasOwn(before ?? {}, key) && Object.hasOwn(after ?? {}, key));
        return { group: runtimeChange ? "dependency" : "capability", changedKeys };
    }
    if (EXECUTABLE_PATH.test(lower) || EXECUTABLE_DIR.test(lower) && !DECLARATIVE_FILE.test(lower)) {
        return { group: "executable" };
    }
    if (lower === "plugin.json") {
        const left = parseJson(oldBuf);
        const right = parseJson(newBuf);
        if (!left.ok || !right.ok) return { group: "capability", flagged: "unparseable manifest" };
        const changedKeys = changedObjectKeys(left.value, right.value);
        return { group: groupForKeys(changedKeys, "declarative"), changedKeys };
    }
    if (/\.md$/i.test(lower) && /(?:^|\/)agents\//i.test(lower)) {
        const before = frontmatterBlocks(oldBuf);
        const after = frontmatterBlocks(newBuf);
        const changedKeys = [...new Set([...before.keys(), ...after.keys()])]
            .filter((key) => before.get(key) !== after.get(key)).sort();
        return { group: groupForKeys(changedKeys, "declarative"), ...(changedKeys.length ? { changedKeys } : {}) };
    }
    if (!DECLARATIVE_FILE.test(lower) && !/(?:^|\/)(?:LICENSE(?:\.[a-z0-9-]+)?|NOTICE|COPYING|README|CHANGELOG|\.gitignore|\.gitattributes|\.editorconfig|\.npmignore)$/i.test(path)) {
        return { group: "executable", flagged: "unrecognized file type" };
    }
    return { group: "declarative" };
}

function sha(buf: Buffer | undefined): string | undefined {
    return buf ? createHash("sha256").update(buf).digest("hex") : undefined;
}

/** Added/removed line counts of a unified patch, skipping the ---/+++ file headers. */
function lineCounts(patch: string | null): { additions: number; deletions: number } | null {
    if (patch === null) return null;
    let additions = 0, deletions = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
    }
    return { additions, deletions };
}

function describeChange(patch: FilePatch, oldBuf: Buffer | undefined, newBuf: Buffer | undefined): ReviewFileChange {
    const classified = classifyReviewChange(patch.path, oldBuf, newBuf);
    const flagged = classified.flagged ?? (patch.diff === null ? patch.note ?? "content not shown" : undefined);
    return {
        ...patch,
        ...classified,
        ...(flagged ? { flagged } : {}),
        ...(oldBuf ? { oldSha256: sha(oldBuf) } : {}),
        ...(newBuf ? { newSha256: sha(newBuf) } : {}),
        ...(lineCounts(patch.diff) ?? {}),
    };
}

/**
 * One changed file's classified patch, for loading a large review file by
 * file. Throws NOT_FOUND when the path is unchanged or in neither artifact.
 */
export function buildAgentPackageReviewFileChange(params: {
    candidateEntries: PackageEntry[];
    baselineEntries: PackageEntry[];
    path: string;
}): ReviewFileChange {
    const oldBuf = entriesToMap(params.baselineEntries).get(params.path);
    const newBuf = entriesToMap(params.candidateEntries).get(params.path);
    const patch = diffPackageTrees(
        oldBuf ? [{ path: params.path, content: oldBuf }] : [],
        newBuf ? [{ path: params.path, content: newBuf }] : [],
    ).patches[0];
    if (!patch) throw Object.assign(new Error(`${params.path} did not change in this review`), { code: "NOT_FOUND" });
    return describeChange(patch, oldBuf, newBuf);
}

/** Baseline policy: an explicit same-package version, else the newest approved, else the active, else none. */
export function selectReviewBaseline(
    versions: readonly AgentPackageReviewVersionRef[],
    candidateVersionId: string,
    explicitVersionId?: string | null,
): { baseline: AgentPackageReviewVersionRef | null; source: ReviewBaselineSource } {
    if (explicitVersionId) {
        const explicit = versions.find((version) => version.versionId === explicitVersionId);
        if (!explicit || explicit.versionId === candidateVersionId) {
            throw Object.assign(new Error("Baseline must be another version of the same package"), { code: "INVALID_REQUEST" });
        }
        return { baseline: explicit, source: "explicit" };
    }
    const others = versions.filter((version) => version.versionId !== candidateVersionId);
    const approved = others.find((version) => version.decision === "approved");
    if (approved) return { baseline: approved, source: "approved" };
    const active = others.find((version) => version.active === true);
    if (active) return { baseline: active, source: "active" };
    return { baseline: null, source: "none" };
}

/** Build the classified diff. `baselineEntries` is empty for a new package. */
export function buildAgentPackageReviewDiff(params: {
    candidate: AgentPackageReviewDiff["candidate"];
    baseline: AgentPackageReviewVersionRef | null;
    baselineSource: ReviewBaselineSource;
    candidateEntries: PackageEntry[];
    baselineEntries: PackageEntry[];
    inspectionReasons?: string[];
    /** False: list every change with its counts but no patch text (load patches per file). */
    includePatches?: boolean;
}): AgentPackageReviewDiff {
    const before = entriesToMap(params.baselineEntries);
    const after = entriesToMap(params.candidateEntries);
    // Classify every changed path before the file cap, so a truncated list
    // never hides executable changes behind declarative ones.
    const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter((path) => !(before.get(path) && after.get(path) && before.get(path)!.equals(after.get(path)!)))
        .map((path) => ({ path, group: classifyReviewChange(path, before.get(path), after.get(path)).group }))
        .sort((left, right) => rank(left.group) - rank(right.group) || left.path.localeCompare(right.path));
    const shown = new Set(changed.slice(0, DIFF_MAX_FILES).map((entry) => entry.path));
    const pick = (map: Map<string, Buffer>) => [...map].filter(([path]) => shown.has(path)).map(([path, content]) => ({ path, content }));
    const diff = diffPackageTrees(pick(before), pick(after));
    const omitted = changed.length - shown.size;
    const includePatches = params.includePatches !== false;
    const changes: ReviewFileChange[] = diff.patches.map((patch) => {
        const change = describeChange(patch, before.get(patch.path), after.get(patch.path));
        return includePatches || change.diff === null ? change : { ...change, diff: null, patchOmitted: true };
    }).sort((left, right) => rank(left.group) - rank(right.group) || left.path.localeCompare(right.path));
    const summary = Object.fromEntries(REVIEW_CHANGE_GROUPS.map((group) => [group, 0])) as AgentPackageReviewDiff["summary"];
    summary.flagged = 0;
    summary.total = changed.length;
    for (const entry of changed) summary[entry.group]++;
    for (const change of changes) if (change.flagged) summary.flagged++;
    return {
        candidate: params.candidate,
        baseline: params.baseline,
        baselineSource: params.baselineSource,
        identical: changed.length === 0,
        summary,
        changes,
        ...(omitted > 0 ? { truncated: { omitted } } : {}),
        inspectionReasons: params.inspectionReasons ?? [],
        advisory: REVIEW_DIFF_ADVISORY,
    };
}

/** Audit suffix recording which baseline the decision was made against. */
export function reviewBaselineAuditNote(baseline: { versionId: string; sha256: string } | null | undefined): string {
    return baseline ? ` [reviewed against baseline ${baseline.versionId} sha256:${baseline.sha256}]` : " [reviewed as new package: no baseline]";
}
