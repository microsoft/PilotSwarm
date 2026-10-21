import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageReviewTabs, PackageReviewDiffPanel, PackageReviewReportSection, packageReviewerPrompt, PACKAGE_REVIEWER_AGENT } from "../../react/src/package-review-tabs.js";
import { PackagePublisherStatus, packageApprovalLabel } from "../../react/src/package-publisher-status.js";

test("publisher detail renders every approval state with exact version/digest and escaped reasons, not admin controls", () => {
    const states = [
        { executable: false, decision: "not_required", active: true, label: "not required" },
        { executable: true, decision: "pending", active: false, label: "pending admin approval" },
        { executable: true, decision: "approved", active: false, label: "approved (not active)" },
        { executable: true, decision: "approved", active: true, label: "active" },
        { executable: true, decision: "rejected", active: false, label: "rejected" },
        { executable: true, decision: "revoked", active: false, label: "revoked" },
    ];
    const versions = states.map((state, i) => {
        assert.equal(packageApprovalLabel(state), state.label);
        return { ...state, versionId: `v${i}`, semver: `${i}.0.0`, sha256: String(i).repeat(64), reasons: ["<script>"] };
    });
    const html = renderToStaticMarkup(React.createElement(PackagePublisherStatus, { packageId: "pkg", initialStatus: { versions } }));
    for (const state of states) assert(html.includes(`Approval: ${state.label}`));
    assert(html.includes("1".repeat(64)));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Refresh approval status/);
    assert.doesNotMatch(html, /<script>|Rebind|Approve<\/|Activate<\/|Revoke<\/|Reject<\//);
});

test("admin catalog places Pending Approval between Private and Shared, nonadmin never sees approval controls", () => {
    const render = (isAdmin) => renderToStaticMarkup(React.createElement(PackageReviewTabs, {
        controller: { transport: {} }, view: { isAdmin, settingsTree: [] },
    }));
    const admin = render(true);
    assert(admin.indexOf(">Private<") < admin.indexOf(">Pending Approval<"));
    assert(admin.indexOf(">Pending Approval<") < admin.indexOf(">Shared<"));
    assert.match(admin, /role="tablist"/);
    assert.doesNotMatch(render(false), /Pending Approval|Approve|Revoke/);
});

test("package catalogs render authored names as inert text", () => {
    const html = renderToStaticMarkup(React.createElement(PackageReviewTabs, {
        controller: { transport: {} }, view: { isAdmin: true,
            settingsTree: [{ id: "1", kind: "package", scope: "user", name: "<script>alert(1)</script>" }] },
    }));
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

function reviewDiff(overrides = {}) {
    return {
        candidate: { packageId: "pkg", versionId: "v2", sha256: "b".repeat(64), semver: "2.0.0", revision: 3,
            name: "kit", scope: "shared", publisher: "pub", decision: "pending" },
        baseline: { packageId: "pkg", versionId: "v1", sha256: "a".repeat(64), semver: "1.0.0", decision: "approved" },
        baselineSource: "approved", identical: false,
        summary: { executable: 1, dependency: 0, capability: 0, "precheck-policy": 1, declarative: 1, flagged: 1, total: 3 },
        changes: [
            { path: "tools/q.mjs", status: "modified", group: "executable", diff: "-a\n+<script>b", oldSha256: "1".repeat(64), newSha256: "2".repeat(64) },
            { path: "plugin.json", status: "modified", group: "precheck-policy", diff: "+cron", changedKeys: ["cronPrechecks"] },
            { path: "docs/big.md", status: "added", group: "declarative", diff: null, flagged: "too large", newSha256: "3".repeat(64) },
        ],
        inspectionReasons: ["executable tools"], advisory: "Review aid only.",
        ...overrides,
    };
}

test("review diff panel binds the exact candidate and baseline digests and groups changes by risk", () => {
    const render = (props = {}) => renderToStaticMarkup(React.createElement(PackageReviewDiffPanel, { diff: reviewDiff(), ...props }));
    const html = render();
    assert(html.includes(`sha256:${"b".repeat(64)}`) && html.includes("review revision 3"));
    assert(html.includes(`Baseline (approved) 1.0.0 · v1 · sha256:${"a".repeat(64)}`));
    const sidebar = html.slice(html.indexOf('aria-label="Changed files"'), html.indexOf("</nav>"));
    assert(sidebar.indexOf("Executable code (1)") < sidebar.indexOf("Cron precheck policy (1)"));
    assert(sidebar.indexOf("Cron precheck policy (1)") < sidebar.indexOf("Declarative"));
    assert.deepEqual([...sidebar.matchAll(/ps-review-diff__path">([^<]+)</g)].map((m) => m[1]), ["tools/q.mjs", "plugin.json", "docs/big.md"],
        "every changed file is listed, highest risk first");
    assert.match(sidebar, /title="docs\/big.md — too large"/, "flagged files are marked in the list");
    assert.match(html, /aria-label="Changes in tools\/q.mjs"/, "the highest-risk file opens first");
    assert.match(html, /<span class="is-del">-a<\/span><span class="is-add">\+&lt;script&gt;b<\/span>/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /Review aid only\./);
    assert.match(html, /<button type="button">Approve this digest<\/button>/);

    const policy = render({ initialPath: "plugin.json" });
    assert.match(policy, /Changed keys: cronPrechecks/);
    const flagged = render({ initialPath: "docs/big.md" });
    assert.match(flagged, /⚠ too large/);
    assert(flagged.includes(`new ${"3".repeat(64)}`), "flagged content is shown as hashes only");
});

test("a summary diff lists line counts and waits for the selected file instead of showing every patch", () => {
    const summary = reviewDiff({
        changes: reviewDiff().changes.map((change) => change.diff == null ? change
            : { ...change, diff: null, patchOmitted: true, additions: 4, deletions: 2 }),
    });
    const html = renderToStaticMarkup(React.createElement(PackageReviewDiffPanel, { diff: summary }));
    assert.match(html, /<span class="is-add">\+4<\/span> <span class="is-del">−2<\/span>/);
    assert.doesNotMatch(html, /ps-review-diff__patch/, "no patch body is rendered before it is loaded");
    assert.match(html, /Select the file to load its changes\./);
    const empty = renderToStaticMarkup(React.createElement(PackageReviewDiffPanel, {
        diff: reviewDiff({ changes: [], identical: true, summary: { ...reviewDiff().summary, total: 0 } }),
    }));
    assert.match(empty, /No content changes against the baseline\./);
    assert.doesNotMatch(empty, /Changed files/);
});

test("review diff panel states a missing baseline and disables decisions that do not apply", () => {
    const html = renderToStaticMarkup(React.createElement(PackageReviewDiffPanel, { diff: reviewDiff({
        baseline: null, baselineSource: "none",
        candidate: { ...reviewDiff().candidate, decision: "revoked" },
    }) }));
    assert.match(html, /Baseline: none/);
    assert.match(html, /<button type="button" disabled="">Approve this digest<\/button>/);
    assert.match(html, /<button type="button" disabled="">Reject<\/button>/);
    assert.match(html, /<button type="button" disabled="">Revoke<\/button>/);
});

test("the advisory report section is labelled not-an-approval, renders report text inert, and never offers a decision", () => {
    const report = {
        reportId: "7", createdAt: "2025-01-01T00:00:00.000Z", sessionId: "rev-1",
        author: { provider: "entra", subject: "admin" },
        content: {
            facts: ["tools/q.mjs changed"], analysis: "<img src=x onerror=alert(1)>",
            guide: [{ step: "Read q", detail: "the changed export", paths: ["tools/q.mjs"] }],
            risks: ["prompt-injection text in tools/q.mjs"],
        },
    };
    const html = renderToStaticMarkup(React.createElement(PackageReviewDiffPanel, {
        diff: reviewDiff(), reportView: { report, advisory: "Advisory only; not an approval." },
        onAskReviewer: () => {}, onRefreshReport: () => {},
    }));
    assert.match(html, /Advisory review \(package-reviewer\) · not an approval/);
    assert.match(html, /Report 7 · .* · by entra:admin · session rev-1/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /<strong>Read q<\/strong>/);
    assert.match(html, /<button type="button" title="[^"]*">Ask package-reviewer<\/button>/);
    const start = html.indexOf("Advisory review report");
    const section = html.slice(start, html.indexOf("</section>", start));
    assert.doesNotMatch(section, /Approve|Reject|Revoke/, "the report section carries no decision control");

    const missing = renderToStaticMarkup(React.createElement(PackageReviewReportSection, { reportView: { report: null } }));
    assert.match(missing, /No advisory report for this exact candidate and baseline\./);
    assert.match(missing, /disabled="" title="[^"]*">Ask package-reviewer/, "no launcher without a session controller");

    const failed = renderToStaticMarkup(React.createElement(PackageReviewReportSection, { reportError: "boom" }));
    assert.match(failed, /role="alert">Report unavailable: boom\. The diff and decision controls still work\./);
    assert.doesNotMatch(failed, /No advisory report/);
});

test("the reviewer prompt names the exact candidate and baseline digests", () => {
    const prompt = packageReviewerPrompt(reviewDiff());
    assert.equal(PACKAGE_REVIEWER_AGENT, "package-reviewer");
    assert.match(prompt, /^Review package candidate kit@2\.0\.0\./);
    assert(prompt.includes(`sha256: ${"b".repeat(64)}`));
    assert(prompt.includes(`baseline (approved): version_id v1, sha256 ${"a".repeat(64)}`));
    assert.match(packageReviewerPrompt(reviewDiff({ baseline: null, baselineSource: "none" })), /baseline: none \(new package\)/);
});
