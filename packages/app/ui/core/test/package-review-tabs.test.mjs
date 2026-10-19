import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageReviewTabs } from "../../react/src/package-review-tabs.js";
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
