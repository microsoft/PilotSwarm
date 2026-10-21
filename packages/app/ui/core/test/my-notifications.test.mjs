import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageReviewTabs } from "../../react/src/package-review-tabs.js";
import { describeNotification, MyNotifications } from "../../react/src/my-notifications.js";

const review = (decision, extra = {}) => ({ id: "1", kind: "package_review", occurrences: 1, readAt: null,
    payload: { packageId: "pkg", packageName: "kit", semver: "1.2.0", decision, reason: "looks fine", ...extra } });

test("review notices show the live approved-not-active state, decision and reason", () => {
    assert.equal(describeNotification(review("approved", { approvedNotActive: true })), "Review: kit@1.2.0 approved, not active — looks fine");
    assert.equal(describeNotification(review("approved", { approvedNotActive: false })), "Review: kit@1.2.0 approved — looks fine");
    assert.equal(describeNotification(review("revoked")), "Review: kit@1.2.0 revoked — looks fine");
});

test("broken and recovered precheck notices show only owner-visible facts", () => {
    const broken = { id: "2", kind: "cron_precheck_broken", occurrences: 3, payload: {
        precheck: "queue", outcome: "timeout", summary: "The precheck did not answer within its timeout.",
        packageName: "kit", semver: "1.2.0", sessionId: "s1" } };
    assert.equal(describeNotification(broken),
        "Precheck queue broken (timeout) · kit@1.2.0 · session s1 · 3 times — The precheck did not answer within its timeout.");
    const packageOwnerCopy = { ...broken, occurrences: 1, payload: { ...broken.payload, sessionId: undefined } };
    assert.doesNotMatch(describeNotification(packageOwnerCopy), /session/);
    assert.equal(describeNotification({ id: "3", kind: "cron_precheck_recovered", payload: {
        precheck: "trusted", previousOutcome: "error", brokenOccurrences: 4, sessionId: "s1" } }),
    "Precheck trusted recovered · session s1 after 4 broken run(s)");
});

test("every user gets a Notifications tab; the panel starts loading and renders text inertly", () => {
    for (const isAdmin of [true, false]) {
        const html = renderToStaticMarkup(React.createElement(PackageReviewTabs, {
            controller: { transport: {} }, view: { isAdmin, settingsTree: [] },
        }));
        assert.match(html, />Notifications</, `isAdmin=${isAdmin}`);
    }
    const html = renderToStaticMarkup(React.createElement(MyNotifications, { transport: { listMyNotifications: async () => [] } }));
    assert.match(html, /Loading notifications/);
    assert.match(html, /Mark all read/);
    assert.match(describeNotification(review("rejected", { reason: "<script>" })), /<script>/, "plain text; React escapes on render");
});
