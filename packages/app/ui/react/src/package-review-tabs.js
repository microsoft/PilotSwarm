import React from "react";
import { MyNotifications } from "./my-notifications.js";

const GROUP_LABELS = {
    executable: "Executable code",
    dependency: "Dependencies and runtime config",
    capability: "Capabilities (tools, MCP servers, grants)",
    "precheck-policy": "Cron precheck policy",
    declarative: "Declarative (prompts, docs, metadata)",
};
const GROUP_ORDER = ["executable", "dependency", "capability", "precheck-policy", "declarative"];

function sameReviewVersion(left, right) {
    if (!left || !right) return left == null && right == null;
    return left.versionId === right.versionId && left.sha256 === right.sha256;
}

export const PACKAGE_REVIEWER_AGENT = "package-reviewer";

/** The reviewer's opening prompt: the exact candidate and baseline the administrator is looking at. */
export function packageReviewerPrompt(diff) {
    const c = diff.candidate;
    const b = diff.baseline;
    return [
        `Review package candidate ${c.name}@${c.semver}.`,
        `package_id: ${c.packageId}`,
        `version_id: ${c.versionId}`,
        `sha256: ${c.sha256}`,
        b ? `baseline (${diff.baselineSource}): version_id ${b.versionId}, sha256 ${b.sha256}`
            : "baseline: none (new package)",
        "Read the diff and the changed files, then submit your advisory report for exactly this candidate and baseline.",
    ].join("\n");
}

/** The package-reviewer's advisory report, or why there is none. Never an approval control. */
export function PackageReviewReportSection({ reportView, reportError = null, busy = false, onAskReviewer, onRefreshReport }) {
    const h = React.createElement;
    const report = reportView?.report ?? null;
    return h("section", { "aria-label": "Advisory review report", className: "ps-review-report" },
        h("h5", null, "Advisory review (package-reviewer) · not an approval"),
        h("p", null, reportView?.advisory
            || "Advisory only. The report does not approve or reject; decide from the diff above."),
        reportError ? h("p", { role: "alert" }, `Report unavailable: ${reportError}. The diff and decision controls still work.`) : null,
        report ? h("div", null,
            h("p", null, `Report ${report.reportId} · ${report.createdAt ? String(report.createdAt) : ""} · by ${report.author ? `${report.author.provider}:${report.author.subject}` : "unknown"}${report.sessionId ? ` · session ${report.sessionId}` : ""}`),
            h("h6", null, "Facts"),
            h("ul", null, (report.content?.facts || []).map((fact, i) => h("li", { key: `f${i}` }, fact))),
            h("h6", null, "Analysis"),
            h("p", null, report.content?.analysis || ""),
            h("h6", null, "Review guide"),
            h("ol", null, (report.content?.guide || []).map((step, i) => h("li", { key: `g${i}` },
                h("strong", null, step.step), ` ${step.detail}`,
                step.paths?.length ? h("code", null, ` ${step.paths.join(", ")}`) : null))),
            h("h6", null, "Open risks"),
            h("ul", null, (report.content?.risks || []).map((risk, i) => h("li", { key: `r${i}` }, risk))))
            : reportError ? null
                : h("p", { role: "status" }, "No advisory report for this exact candidate and baseline."),
        h("div", null,
            h("button", { type: "button", disabled: busy || !onAskReviewer, onClick: () => onAskReviewer?.(),
                title: "Opens a package-reviewer session for this exact candidate and baseline" }, "Ask package-reviewer"),
            h("button", { type: "button", disabled: busy || !onRefreshReport, onClick: () => onRefreshReport?.() }, "Refresh report")));
}

/** Pure render of a risk-classified review diff; decisions carry the exact digests shown. */
export function PackageReviewDiffPanel({ diff, busy = false, onDecide, onClose, reportView = null, reportError = null, onAskReviewer, onRefreshReport }) {
    const h = React.createElement;
    const c = diff.candidate;
    const s = diff.summary;
    const decision = c.decision;
    return h("section", { "aria-label": "Package review diff", className: "ps-review-diff" },
        h("h4", null, `Review diff · ${c.name}@${c.semver}`),
        h("p", null, `Candidate ${c.versionId} · sha256:${c.sha256} · review revision ${c.revision} · ${c.scope} · publisher ${c.publisher || "unknown"}`),
        h("p", null, diff.baseline
            ? `Baseline (${diff.baselineSource}) ${diff.baseline.semver} · ${diff.baseline.versionId} · sha256:${diff.baseline.sha256}`
            : "Baseline: none — new package, every file is listed as added"),
        h("p", { role: "status" }, diff.identical ? "No content changes against the baseline."
            : `${s.total} changed · executable ${s.executable} · dependency ${s.dependency} · capability ${s.capability} · precheck policy ${s["precheck-policy"]} · declarative ${s.declarative} · flagged ${s.flagged}`),
        h("p", null, diff.advisory),
        h("pre", null, (diff.inspectionReasons || []).join("\n")),
        GROUP_ORDER.map((group) => {
            const changes = diff.changes.filter((change) => change.group === group);
            if (changes.length === 0) return null;
            return h("details", { key: group, open: group !== "declarative" },
                h("summary", null, `${GROUP_LABELS[group]} (${changes.length})`),
                changes.map((change) => h("article", { key: change.path },
                    h("h5", null, `${change.status} ${change.path}${change.flagged ? ` ⚠ ${change.flagged}` : ""}`),
                    change.changedKeys?.length ? h("p", null, `Changed keys: ${change.changedKeys.join(", ")}`) : null,
                    change.diff != null
                        ? h("pre", null, change.diff)
                        : h("pre", null, `old ${change.oldSha256 || "-"}\nnew ${change.newSha256 || "-"}`))));
        }),
        diff.truncated ? h("p", null, `${diff.truncated.omitted} more changed files are omitted from this view; they are counted above.`) : null,
        h(PackageReviewReportSection, { reportView, reportError, busy, onAskReviewer, onRefreshReport }),
        h("div", null,
            h("button", { type: "button", disabled: busy || !["pending", "not_required"].includes(decision),
                onClick: () => onDecide?.("approved") }, "Approve this digest"),
            h("button", { type: "button", disabled: busy || decision !== "pending",
                onClick: () => onDecide?.("rejected") }, "Reject"),
            h("button", { type: "button", disabled: busy || decision === "revoked",
                onClick: () => onDecide?.("revoked") }, "Revoke"),
            h("button", { type: "button", onClick: () => onClose?.() }, "Close diff")));
}

export function PackageReviewTabs({ controller, view }) {
    const [tab, setTab] = React.useState("private");
    const [reviews, setReviews] = React.useState([]);
    const [error, setError] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [contents, setContents] = React.useState(null);
    const [diffView, setDiffView] = React.useState(null);
    const [reportView, setReportView] = React.useState(null);
    const [reportError, setReportError] = React.useState(null);
    const generation = React.useRef(0);
    const reportGeneration = React.useRef(0);
    const clearDiff = React.useCallback(() => {
        generation.current++;
        reportGeneration.current++;
        setDiffView(null);
        setReportView(null);
        setReportError(null);
    }, []);
    const effectiveTab = tab === "reviews" && !view.isAdmin ? "private" : tab;
    React.useEffect(() => {
        clearDiff();
        setBusy(false);
        if (!view.isAdmin) {
            setReviews([]);
            setContents(null);
        }
        return () => { generation.current++; reportGeneration.current++; };
    }, [view.isAdmin, clearDiff]);
    const refresh = React.useCallback(async () => {
        const token = generation.current;
        setBusy(true);
        setError(null);
        try {
            const result = await controller.transport.listAgentPackageReviews();
            if (generation.current === token) setReviews(result);
        } catch (e) { if (generation.current === token) setError(e.message || String(e)); }
        finally { if (generation.current === token) setBusy(false); }
    }, [controller]);
    React.useEffect(() => {
        if (tab === "reviews" && view.isAdmin) void refresh();
    }, [tab, view.isAdmin, refresh]);
    const decide = async (candidate, decision, baseline) => {
        const reason = window.prompt(`Reason to ${decision} ${candidate.name}@${candidate.semver}:`);
        if (!reason?.trim()) return;
        setBusy(true);
        setError(null);
        try {
            await controller.transport.decideAgentPackageReview({
                packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
                expectedRevision: candidate.revision, decision, reason,
                ...(baseline !== undefined ? { baseline } : {}),
            });
            clearDiff();
            await refresh();
        } catch (e) { setError(e.message || String(e)); }
        finally { setBusy(false); }
    };
    // The report is optional: a missing endpoint, store or report never blocks the diff or a decision.
    const loadReport = async (diff, token = generation.current) => {
        const request = ++reportGeneration.current;
        setReportView(null);
        setReportError(null);
        if (typeof controller.transport.getAgentPackageReviewReport !== "function") {
            setReportView(null);
            setReportError("this portal build has no report endpoint");
            return;
        }
        try {
            const c = diff.candidate;
            const result = await controller.transport.getAgentPackageReviewReport({
                packageId: c.packageId, versionId: c.versionId, sha256: c.sha256,
                baselineVersionId: diff.baselineSource === "explicit" ? diff.baseline?.versionId ?? null : null,
            });
            if (generation.current !== token || reportGeneration.current !== request) return;
            // Shown only when it is for the exact candidate and baseline in this diff.
            const same = result?.candidate?.packageId === c.packageId
                && sameReviewVersion(result?.candidate, c) && sameReviewVersion(result?.baseline, diff.baseline)
                && (!result.report || (result.report.packageId === c.packageId
                    && sameReviewVersion(result.report, c) && sameReviewVersion(result.report.baseline, diff.baseline)));
            setReportView(same ? result : { ...result, report: null });
        } catch (e) {
            if (generation.current === token && reportGeneration.current === request) {
                setReportView(null);
                setReportError(e.message || String(e));
            }
        }
    };
    const openDiff = async (candidate) => {
        clearDiff();
        const token = generation.current;
        setBusy(true);
        setError(null);
        setContents(null);
        try {
            const diff = await controller.transport.getAgentPackageReviewDiff({
                packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
            });
            if (generation.current === token) {
                setDiffView(diff);
                void loadReport(diff, token);
            }
        } catch (e) { if (generation.current === token) setError(e.message || String(e)); }
        finally { if (generation.current === token) setBusy(false); }
    };
    const askReviewer = async () => {
        if (!diffView || typeof controller.createSessionForAgent !== "function") return;
        const c = diffView.candidate;
        await controller.createSessionForAgent(PACKAGE_REVIEWER_AGENT, {
            title: `Review ${c.name}@${c.semver}`,
            initialPrompt: packageReviewerPrompt(diffView),
        });
    };
    const decideFromDiff = (decision) => {
        const c = diffView.candidate;
        const baseline = diffView.baseline ? { versionId: diffView.baseline.versionId, sha256: diffView.baseline.sha256 } : null;
        return decide({ packageId: c.packageId, versionId: c.versionId, sha256: c.sha256, revision: c.revision,
            name: c.name, semver: c.semver }, decision, baseline);
    };
    const readFile = async (candidate, filePath) => {
        setBusy(true);
        try {
            const file = await controller.transport.getAgentPackageFile(candidate.name, candidate.semver, filePath, {
                scope: candidate.scope, ...(candidate.owner ? { owner: candidate.owner } : {}),
            });
            setContents(JSON.stringify(file, null, 2));
        } catch (e) { setError(e.message || String(e)); }
        finally { setBusy(false); }
    };
    const showAudit = async (candidate) => {
        try {
            setContents(JSON.stringify({
                contentDecisions: await controller.transport.getAgentPackageReviewAudit(candidate.versionId),
                activations: await controller.transport.getAgentPackageActivationAudit(candidate.packageId),
            }, null, 2));
        } catch (e) { setError(e.message || String(e)); }
    };
    const activate = async (candidate) => {
        const reason = window.prompt(`Reason to activate exact ${candidate.name}@${candidate.semver}? Existing bindings will not move.`);
        if (!reason?.trim()) return;
        setBusy(true);
        try {
            await controller.transport.activateAgentPackageVersion({
                packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
                expectedReviewRevision: candidate.revision, expectedActivationRevision: candidate.activationRevision,
                expectedActiveVersionId: candidate.activeVersionId, reason,
            });
            await refresh();
        } catch (e) { setError(e.message || String(e)); }
        finally { setBusy(false); }
    };
    const rebind = async (candidate) => {
        const sessionId = window.prompt("Session ID to rebind to this exact package version:");
        if (!sessionId?.trim()) return;
        setBusy(true);
        try {
            const current = await controller.transport.getSessionAgentPackageBinding(sessionId.trim());
            const agentName = current?.agentName || window.prompt("Exact bound agent name for this historically unbound session:");
            if (!agentName?.trim()) return;
            const reason = window.prompt(`Rebind ${sessionId} from ${current?.versionId || "unbound (explicit initial binding)"} to ${candidate.versionId}? Give the reason; previous package generations will be fenced.`);
            if (!reason?.trim()) return;
            await controller.transport.rebindSessionAgentPackage({
                sessionId: sessionId.trim(), packageId: candidate.packageId, versionId: candidate.versionId,
                sha256: candidate.sha256, agentName: agentName.trim(),
                expectedBindingRevision: current?.revision ?? 0, reason,
            });
            setContents(JSON.stringify(await controller.transport.getSessionAgentPackageBinding(sessionId.trim()), null, 2));
        } catch (e) { setError(e.message || String(e)); }
        finally { setBusy(false); }
    };
    const tabs = [
        { id: "private", label: "Private" },
        ...(view.isAdmin ? [{ id: "reviews", label: "Pending Approval" }] : []),
        { id: "shared", label: "Shared" },
        { id: "notifications", label: "Notifications" },
    ];
    const packages = (view.settingsTree || []).filter((row) =>
        row.kind === "package" && (effectiveTab === "shared" ? row.scope === "shared" : row.scope !== "shared"));
    return React.createElement("section", { className: "ps-admin-detail" },
        React.createElement("h3", null, "Packages"),
        React.createElement("div", { role: "tablist", "aria-label": "Package catalogs" },
            tabs.map(({ id, label }) => React.createElement("button", {
                key: id, role: "tab", type: "button", "aria-selected": effectiveTab === id,
                onClick: () => { clearDiff(); setContents(null); setBusy(false); setTab(id); },
            }, label))),
        error ? React.createElement("p", { role: "alert" }, error) : null,
        effectiveTab === "reviews" && view.isAdmin ? React.createElement("div", { role: "tabpanel" },
            React.createElement("p", null,
                "Content approval and activation are separate from session permission. Supported tools, declared callbacks and stdio MCP execute in supervised children with fresh admission. Revocation denies first; completion below requires observed process exits. Previously admitted external effects cannot be undone."),
            React.createElement("button", { type: "button", disabled: busy, onClick: refresh }, "Refresh reviews"),
            diffView ? React.createElement(PackageReviewDiffPanel, {
                diff: diffView, busy, onDecide: decideFromDiff, onClose: () => { clearDiff(); setBusy(false); },
                reportView, reportError,
                onAskReviewer: typeof controller.createSessionForAgent === "function" ? askReviewer : undefined,
                onRefreshReport: () => loadReport(diffView),
            }) : null,
            reviews.map((r) => React.createElement("article", { key: r.versionId },
                React.createElement("h4", null, `${r.name}@${r.semver} · artifact content: ${r.decision}`),
                React.createElement("button", { type: "button", disabled: busy, onClick: () => openDiff(r),
                    title: "Risk-grouped diff of this exact digest against the newest approved (else active) version" }, "Review diff"),
                React.createElement("p", null, `Publisher: ${r.publisher || "unknown"} · ${r.scope} · revision ${r.revision}`),
                React.createElement("p", null, `Package: ${r.packageId} · Version: ${r.versionId}`),
                React.createElement("p", null, `SHA-256: ${r.sha256}`),
                React.createElement("p", null, `Prior active: ${r.priorActiveVersionId || "none"}`),
                React.createElement("p", null, `Current active: ${r.activeVersionId || "none"} · activation revision ${r.activationRevision}`),
                React.createElement("p", { role: "status" }, r.runtimeFencing
                    ? `Runtime: ${r.runtimeFencing.denied ? "admission denied" : "admission eligible"} · fencing ${r.runtimeFencing.complete ? "complete" : "not complete"} · outstanding ${r.runtimeFencing.outstanding}`
                    : "Runtime fencing status unavailable; do not infer completion."),
                React.createElement("pre", null, (r.inspection?.reasons || ["Legacy artifact: no verified inspection"]).join("\n")),
                React.createElement("pre", null, (r.inspection?.approvalBlockers || ["Uninspected artifact"]).join("\n")),
                React.createElement("ul", null, (r.inspection?.files || []).map((file) => React.createElement("li", { key: file.path },
                    React.createElement("button", {
                        type: "button", disabled: busy, onClick: () => readFile(r, file.path),
                    }, file.path), ` · ${file.sizeBytes} bytes · ${file.sha256}`))),
                React.createElement("button", { type: "button", disabled: busy || !r.inspection
                    || !["pending", "not_required"].includes(r.decision),
                    onClick: () => decide(r, "approved"),
                    title: "Accepts reviewed artifact bytes only, never unverifiable dependencies or execution" }, "Approve artifact contents"),
                React.createElement("button", { type: "button", disabled: busy || !(r.inspection?.executable === false || r.inspection?.execution?.policy === 1)
                    || !["approved", "not_required"].includes(r.decision) || r.activeVersionId === r.versionId,
                    onClick: () => activate(r) }, "Activate exact version"),
                React.createElement("button", { type: "button", disabled: busy || !(r.inspection?.executable === false || r.inspection?.execution?.policy === 1)
                    || !["approved", "not_required"].includes(r.decision), onClick: () => rebind(r) }, "Rebind session"),
                React.createElement("button", { type: "button", disabled: busy || r.decision !== "pending",
                    onClick: () => decide(r, "rejected") }, "Reject"),
                React.createElement("button", { type: "button", disabled: busy || r.decision === "revoked",
                    onClick: () => decide(r, "revoked") }, "Revoke"),
                React.createElement("button", { type: "button", onClick: () => showAudit(r) }, "Audit"))))
            : effectiveTab === "notifications" ? React.createElement("div", { role: "tabpanel" },
                React.createElement(MyNotifications, { transport: controller.transport }))
            : React.createElement("div", { role: "tabpanel" },
                packages.map((p) => React.createElement("button", {
                    key: p.id, type: "button", onClick: () => controller.selectAdminPackage(p.name, {
                        scope: p.scope, ...(p.owner ? { owner: p.owner } : {}),
                    }),
                }, p.name)),
                packages.length === 0 ? React.createElement("p", null, "No packages in this catalog.") : null),
        contents && effectiveTab === "reviews" && view.isAdmin ? React.createElement("pre", null, contents) : null);
}
