import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageReviewTabs, PackageReviewDiffPanel } from "../../react/src/package-review-tabs.js";
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
    const html = renderToStaticMarkup(React.createElement(PackageReviewDiffPanel, { diff: reviewDiff() }));
    assert(html.includes(`sha256:${"b".repeat(64)}`) && html.includes("review revision 3"));
    assert(html.includes(`Baseline (approved) 1.0.0 · v1 · sha256:${"a".repeat(64)}`));
    assert(html.indexOf("Executable code (1)") < html.indexOf("Cron precheck policy (1)"));
    assert(html.indexOf("Cron precheck policy (1)") < html.indexOf("Declarative"));
    assert.match(html, /Changed keys: cronPrechecks/);
    assert.match(html, /too large/);
    assert(html.includes(`new ${"3".repeat(64)}`), "flagged content is shown as hashes only");
    assert.match(html, /&lt;script&gt;b/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /Review aid only\./);
    assert.match(html, /<button type="button">Approve this digest<\/button>/);
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
