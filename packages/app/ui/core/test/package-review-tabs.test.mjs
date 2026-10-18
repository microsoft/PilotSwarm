import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageReviewTabs } from "../../react/src/package-review-tabs.js";

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
