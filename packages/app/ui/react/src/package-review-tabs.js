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
const STATUS_MARK = { added: "A", removed: "D", modified: "M" };

function patchLineClass(line) {
    if (line.startsWith("@@")) return "is-hunk";
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return "is-meta";
    if (line.startsWith("+")) return "is-add";
    if (line.startsWith("-")) return "is-del";
    return "";
}

/** One file's patch, line-coloured; hashes only when the content is not shown. */
function ReviewFilePatch({ change, state, onRetry }) {
    const h = React.createElement;
    const counts = Number.isInteger(change.additions)
        ? h("span", { className: "ps-review-diff__counts" },
            h("span", { className: "is-add" }, `+${change.additions}`), " ",
            h("span", { className: "is-del" }, `−${change.deletions}`))
        : null;
    const patch = state?.change?.diff ?? change.diff ?? null;
    let body;
    if (state?.loading) body = h("p", { role: "status" }, "Loading this file's changes…");
    else if (state?.error) {
        body = h("div", { role: "alert" }, `Could not load this file: ${state.error} `,
            h("button", { type: "button", onClick: () => onRetry?.() }, "Retry"));
    }
    else if (patch != null) {
        body = h("pre", { className: "ps-review-diff__patch" },
            patch.split("\n").map((line, index) => h("span", { key: index, className: patchLineClass(line) }, line || " ")));
    } else if (change.patchOmitted) body = h("p", { role: "status" }, "Select the file to load its changes.");
    else body = h("pre", null, `old ${change.oldSha256 || "-"}\nnew ${change.newSha256 || "-"}`);
    return h("article", { "aria-label": `Changes in ${change.path}`, className: "ps-review-diff__file" },
        h("header", null,
            h("h5", null, `${change.status} ${change.path}`), counts),
        change.flagged ? h("p", { className: "ps-review-diff__flag" }, `⚠ ${change.flagged}`) : null,
        change.changedKeys?.length ? h("p", null, `Changed keys: ${change.changedKeys.join(", ")}`) : null,
        body);
}

/**
 * Risk-classified review diff, laid out like a code review: a files-changed
 * list grouped by risk, and the selected file's patch. With a summary diff
 * (patches left out) each file's patch is loaded through `loadFile` when it is
 * selected. Decisions carry the exact digests shown.
 */
export function PackageReviewDiffPanel({ diff, busy = false, onDecide, onClose, loadFile, initialPath = null }) {
    const h = React.createElement;
    const c = diff.candidate;
    const s = diff.summary;
    const decision = c.decision;
    const changes = diff.changes || [];
    const ordered = GROUP_ORDER.flatMap((group) => changes.filter((change) => change.group === group));
    const [selectedPath, setSelectedPath] = React.useState(
        initialPath && changes.some((change) => change.path === initialPath) ? initialPath : ordered[0]?.path ?? null);
    const [files, setFiles] = React.useState({});
    const [retry, setRetry] = React.useState(0);
    const requested = React.useRef(new Set());
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const selected = ordered.find((change) => change.path === selectedPath) ?? null;
    React.useEffect(() => {
        if (!selected?.patchOmitted || typeof loadFile !== "function") return;
        const path = selected.path;
        // Each file is requested once per opened diff; a failure can be retried.
        if (requested.current.has(path)) return;
        requested.current.add(path);
        setFiles((prev) => ({ ...prev, [path]: { loading: true } }));
        Promise.resolve().then(() => loadFile(path)).then(
            (change) => { if (mounted.current) setFiles((prev) => ({ ...prev, [path]: { change } })); },
            (error) => {
                requested.current.delete(path);
                if (mounted.current) setFiles((prev) => ({ ...prev, [path]: { error: error?.message || String(error) } }));
            });
    }, [selected?.path, selected?.patchOmitted, loadFile, retry]);
    const retryFile = () => setRetry((value) => value + 1);
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
        ordered.length ? h("div", { className: "ps-review-diff__body" },
            h("nav", { "aria-label": "Changed files", className: "ps-review-diff__files" },
                GROUP_ORDER.map((group) => {
                    const inGroup = ordered.filter((change) => change.group === group);
                    if (inGroup.length === 0) return null;
                    return h("div", { key: group, className: "ps-review-diff__group" },
                        h("div", { className: "ps-review-diff__group-label" }, `${GROUP_LABELS[group]} (${inGroup.length})`),
                        inGroup.map((change) => h("button", {
                            key: change.path, type: "button",
                            className: `ps-review-diff__file-row${change.path === selectedPath ? " is-selected" : ""}`,
                            "aria-current": change.path === selectedPath ? "true" : undefined,
                            title: change.flagged ? `${change.path} — ${change.flagged}` : change.path,
                            onClick: () => setSelectedPath(change.path),
                        },
                            h("span", { className: `ps-review-diff__status is-${change.status}` }, STATUS_MARK[change.status] ?? "?"),
                            h("span", { className: "ps-review-diff__path" }, change.path),
                            change.flagged ? h("span", { className: "ps-review-diff__flag", "aria-label": "flagged" }, "⚠") : null,
                            Number.isInteger(change.additions)
                                ? h("span", { className: "ps-review-diff__counts" },
                                    h("span", { className: "is-add" }, `+${change.additions}`), " ",
                                    h("span", { className: "is-del" }, `−${change.deletions}`))
                                : null)));
                })),
            selected ? h(ReviewFilePatch, { change: selected, state: files[selected.path], onRetry: retryFile }) : null) : null,
        diff.truncated ? h("p", null, `${diff.truncated.omitted} more changed files are omitted from this view; they are counted above.`) : null,
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
    const generation = React.useRef(0);
    // The diff takes over the page; Back returns to the review it was opened from.
    const pageRef = React.useRef(null);
    const returnTo = React.useRef(null);
    React.useEffect(() => {
        const page = pageRef.current;
        if (!page?.querySelector) return;
        if (diffView) {
            page.scrollIntoView?.({ block: "start" });
            page.querySelector(".ps-review-page__back")?.focus({ preventScroll: true });
            return;
        }
        const versionId = returnTo.current;
        returnTo.current = null;
        if (!versionId) return;
        const origin = [...page.querySelectorAll("[data-review-version]")]
            .find((button) => button.getAttribute("data-review-version") === versionId);
        origin?.scrollIntoView?.({ block: "center" });
        origin?.focus({ preventScroll: true });
    }, [diffView]);
    const effectiveTab = tab === "reviews" && !view.isAdmin ? "private" : tab;
    React.useEffect(() => {
        generation.current++;
        if (!view.isAdmin) {
            setReviews([]);
            setContents(null);
            setDiffView(null);
        }
    }, [view.isAdmin]);
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
            setDiffView(null);
            await refresh();
        } catch (e) { setError(e.message || String(e)); }
        finally { setBusy(false); }
    };
    const openDiff = async (candidate) => {
        const token = generation.current;
        setBusy(true);
        setError(null);
        setContents(null);
        try {
            // Large reviews load file by file: ask for the file list only when
            // this server can serve one file's patch.
            const perFile = typeof controller.transport.getAgentPackageReviewFileDiff === "function";
            const diff = await controller.transport.getAgentPackageReviewDiff({
                packageId: candidate.packageId, versionId: candidate.versionId, sha256: candidate.sha256,
                ...(perFile ? { patches: false } : {}),
            });
            if (generation.current === token) {
                returnTo.current = candidate.versionId;
                setDiffView(diff);
            }
        } catch (e) { if (generation.current === token) setError(e.message || String(e)); }
        finally { if (generation.current === token) setBusy(false); }
    };
    const loadDiffFile = async (path) => {
        const shown = diffView;
        const c = shown.candidate;
        const result = await controller.transport.getAgentPackageReviewFileDiff({
            packageId: c.packageId, versionId: c.versionId, sha256: c.sha256,
            baselineVersionId: shown.baselineSource === "explicit" ? shown.baseline?.versionId ?? null : null,
            path,
        });
        // A file belongs to the exact candidate and baseline on screen, never
        // to whatever the review became since the list was loaded.
        if (result?.candidate?.versionId !== c.versionId || result?.candidate?.sha256 !== c.sha256
            || (result?.baseline?.sha256 ?? null) !== (shown.baseline?.sha256 ?? null)
            || (result?.baseline?.versionId ?? null) !== (shown.baseline?.versionId ?? null)
            || result?.change?.path !== path) {
            throw new Error("the review changed since this diff was opened; close and reopen it");
        }
        return result.change;
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
    const closeDiff = () => setDiffView(null);
    if (diffView && effectiveTab === "reviews" && view.isAdmin) {
        return React.createElement("section", { ref: pageRef, className: "ps-admin-detail ps-package-catalog ps-review-page" },
            React.createElement("div", { className: "ps-review-page__bar" },
                React.createElement("button", { type: "button", className: "ps-review-page__back", onClick: closeDiff },
                    "← Back to Pending Approval"),
                React.createElement("span", null, `Packages / Pending Approval / ${diffView.candidate.name}@${diffView.candidate.semver}`)),
            error ? React.createElement("p", { role: "alert" }, error) : null,
            React.createElement(PackageReviewDiffPanel, {
                key: `${diffView.candidate.versionId}:${diffView.candidate.sha256}:${diffView.baseline?.sha256 ?? "none"}`,
                diff: diffView, busy, onDecide: decideFromDiff, onClose: closeDiff,
                loadFile: typeof controller.transport.getAgentPackageReviewFileDiff === "function" ? loadDiffFile : undefined,
            }));
    }
    return React.createElement("section", { ref: pageRef, className: "ps-admin-detail ps-package-catalog" },
        React.createElement("h3", null, "Packages"),
        React.createElement("div", { role: "tablist", "aria-label": "Package catalogs" },
            tabs.map(({ id, label }) => React.createElement("button", {
                key: id, role: "tab", type: "button", "aria-selected": effectiveTab === id,
                onClick: () => { setContents(null); setDiffView(null); setTab(id); },
            }, label))),
        error ? React.createElement("p", { role: "alert" }, error) : null,
        effectiveTab === "reviews" && view.isAdmin ? React.createElement("div", { role: "tabpanel" },
            React.createElement("p", null,
                "Content approval and activation are separate from session permission. Supported tools, declared callbacks and stdio MCP execute in supervised children with fresh admission. Revocation denies first; completion below requires observed process exits. Previously admitted external effects cannot be undone."),
            React.createElement("button", { type: "button", disabled: busy, onClick: refresh }, "Refresh reviews"),
            reviews.map((r) => React.createElement("article", { key: r.versionId },
                React.createElement("h4", null, `${r.name}@${r.semver} · artifact content: ${r.decision}`),
                React.createElement("button", { type: "button", disabled: busy, onClick: () => openDiff(r),
                    "data-review-version": r.versionId,
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
