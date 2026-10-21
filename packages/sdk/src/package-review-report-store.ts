import type { Pool } from "pg";
import type { AgentPackageReviewActor } from "./agent-package-review-store.js";
import type { ReviewBaselineSource } from "./agent-package-review-diff.js";

/**
 * Advisory review reports written by the package-reviewer agent (migration
 * 0091). A report explains a candidate; it is never an approval. The content
 * shape is closed, so no verdict, decision or approval field can be stored,
 * and the database refuses those keys as well.
 */
export const PACKAGE_REVIEW_REPORT_ADVISORY =
    "Advisory only. Written by the package-reviewer agent from untrusted package content; it is not an approval or a security proof. The administrator decides from the diff.";

export const PACKAGE_REVIEW_REPORT_LIMITS = Object.freeze({
    items: 50,
    itemChars: 2_000,
    analysisChars: 20_000,
    guideSteps: 30,
    guidePaths: 20,
    pathChars: 512,
});

export interface PackageReviewGuideStep {
    step: string;
    detail: string;
    paths?: string[];
}

/** Facts first, then analysis and a step-by-step guide, then open risks. No verdict. */
export interface PackageReviewReportContent {
    facts: string[];
    analysis: string;
    guide: PackageReviewGuideStep[];
    risks: string[];
}

export interface PackageReviewReportRef {
    versionId: string;
    sha256: string;
}

export interface PackageReviewReport {
    reportId: string;
    packageId: string;
    versionId: string;
    sha256: string;
    baseline: PackageReviewReportRef | null;
    sessionId: string | null;
    author: { provider: string; subject: string };
    createdAt: Date;
    content: PackageReviewReportContent;
}

export interface AgentPackageReviewReportView {
    candidate: { packageId: string; versionId: string; sha256: string };
    baseline: PackageReviewReportRef | null;
    baselineSource: ReviewBaselineSource;
    /** Null when no report matches the exact candidate and the current baseline. */
    report: PackageReviewReport | null;
    advisory: string;
}

export interface PackageReviewReportTarget {
    packageId: string;
    versionId: string;
    sha256: string;
    baseline: PackageReviewReportRef | null;
}

export interface PackageReviewReportCatalog {
    put(actor: AgentPackageReviewActor, input: PackageReviewReportTarget & {
        sessionId: string | null;
        content: PackageReviewReportContent;
    }): Promise<{ reportId: string }>;
    get(actor: AgentPackageReviewActor, input: PackageReviewReportTarget): Promise<PackageReviewReport | null>;
}

export class PackageReviewReportError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

const SHA256 = /^[a-f0-9]{64}$/;

function invalid(message: string): never {
    throw new PackageReviewReportError("INVALID_REQUEST", message);
}

function text(value: unknown, field: string, max: number, required = true): string {
    if (typeof value !== "string") invalid(`${field} must be a string`);
    const trimmed = value.trim();
    if (required && !trimmed) invalid(`${field} must not be empty`);
    if (trimmed.length > max) invalid(`${field} exceeds ${max} characters`);
    return trimmed;
}

function list(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) invalid(`${field} must be an array of strings`);
    if (value.length > PACKAGE_REVIEW_REPORT_LIMITS.items) invalid(`${field} allows at most ${PACKAGE_REVIEW_REPORT_LIMITS.items} items`);
    return value.map((item, index) => text(item, `${field}[${index}]`, PACKAGE_REVIEW_REPORT_LIMITS.itemChars));
}

function closed(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
    const extra = Object.keys(value).filter((key) => !keys.includes(key));
    if (extra.length) invalid(`${field} has unsupported fields: ${extra.join(", ")}. Reports carry no verdict.`);
    return value as Record<string, unknown>;
}

/** Validates and normalizes report content. Unknown fields, including any verdict, are refused. */
export function normalizePackageReviewReportContent(value: unknown): PackageReviewReportContent {
    const content = closed(value, "report", ["facts", "analysis", "guide", "risks"]);
    const guide = content.guide;
    if (!Array.isArray(guide)) invalid("guide must be an array of steps");
    if (guide.length > PACKAGE_REVIEW_REPORT_LIMITS.guideSteps) invalid(`guide allows at most ${PACKAGE_REVIEW_REPORT_LIMITS.guideSteps} steps`);
    return {
        facts: list(content.facts, "facts"),
        analysis: text(content.analysis, "analysis", PACKAGE_REVIEW_REPORT_LIMITS.analysisChars),
        guide: guide.map((raw, index) => {
            const step = closed(raw, `guide[${index}]`, ["step", "detail", "paths"]);
            const paths = step.paths === undefined ? undefined : (() => {
                if (!Array.isArray(step.paths) || step.paths.length > PACKAGE_REVIEW_REPORT_LIMITS.guidePaths) {
                    invalid(`guide[${index}].paths must be up to ${PACKAGE_REVIEW_REPORT_LIMITS.guidePaths} paths`);
                }
                return step.paths.map((item, at) => text(item, `guide[${index}].paths[${at}]`, PACKAGE_REVIEW_REPORT_LIMITS.pathChars));
            })();
            return {
                step: text(step.step, `guide[${index}].step`, PACKAGE_REVIEW_REPORT_LIMITS.itemChars),
                detail: text(step.detail, `guide[${index}].detail`, PACKAGE_REVIEW_REPORT_LIMITS.itemChars * 2),
                ...(paths?.length ? { paths } : {}),
            };
        }),
        risks: list(content.risks, "risks"),
    };
}

function requireAdmin(actor: AgentPackageReviewActor): { provider: string; subject: string } {
    if (actor?.isAdmin !== true || !actor.principal?.provider || !actor.principal?.subject) {
        throw new PackageReviewReportError("FORBIDDEN", "Authenticated administrator required");
    }
    return actor.principal;
}

function requireTarget(input: PackageReviewReportTarget): void {
    if (!input || typeof input.packageId !== "string" || !input.packageId || typeof input.versionId !== "string" || !input.versionId
        || typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
        invalid("Exact candidate package/version/digest required");
    }
    if (input.baseline !== null && (!input.baseline || typeof input.baseline.versionId !== "string" || !input.baseline.versionId
        || typeof input.baseline.sha256 !== "string" || !SHA256.test(input.baseline.sha256) || input.baseline.versionId === input.versionId)) {
        invalid("Baseline must be null or another exact version of the same package");
    }
}

function mapError(error: any): never {
    const message = String(error?.message ?? "");
    const match = /^PACKAGE_REVIEW_REPORT_(FORBIDDEN|CONFLICT|INVALID):\s*(.*)$/s.exec(message);
    if (match) {
        throw new PackageReviewReportError(match[1] === "INVALID" ? "INVALID_REQUEST" : match[1], match[2] || message);
    }
    throw error;
}

export class PgPackageReviewReportStore implements PackageReviewReportCatalog {
    private readonly schema: string;
    constructor(private readonly pool: Pool, schema: string) {
        this.schema = `"${schema.replace(/"/g, '""')}"`;
    }

    async put(actor: AgentPackageReviewActor, input: PackageReviewReportTarget & {
        sessionId: string | null; content: PackageReviewReportContent;
    }): Promise<{ reportId: string }> {
        const principal = requireAdmin(actor);
        requireTarget(input);
        const content = normalizePackageReviewReportContent(input.content);
        try {
            const { rows } = await this.pool.query(
                `SELECT ${this.schema}.cms_put_agent_package_review_report($1,$2,$3,$4,$5,$6,$7::JSONB,$8,$9,$10) AS report_id`,
                [input.packageId, input.versionId, input.sha256, input.baseline?.versionId ?? null, input.baseline?.sha256 ?? null,
                    input.sessionId ?? null, JSON.stringify(content), principal.provider, principal.subject, true],
            );
            return { reportId: String(rows[0].report_id) };
        } catch (error) {
            return mapError(error);
        }
    }

    async get(actor: AgentPackageReviewActor, input: PackageReviewReportTarget): Promise<PackageReviewReport | null> {
        requireAdmin(actor);
        requireTarget(input);
        try {
            const { rows } = await this.pool.query(
                `SELECT ${this.schema}.cms_get_agent_package_review_report($1,$2,$3,$4,$5,$6) AS report`,
                [input.packageId, input.versionId, input.sha256, input.baseline?.versionId ?? null, input.baseline?.sha256 ?? null, true],
            );
            const row = rows[0]?.report;
            if (!row) return null;
            return {
                reportId: String(row.reportId),
                packageId: row.packageId,
                versionId: row.versionId,
                sha256: row.sha256,
                baseline: row.baselineVersionId ? { versionId: row.baselineVersionId, sha256: row.baselineSha256 } : null,
                sessionId: row.sessionId ?? null,
                author: { provider: row.authorProvider, subject: row.authorSubject },
                createdAt: new Date(row.createdAt),
                content: row.content,
            };
        } catch (error) {
            return mapError(error);
        }
    }
}
