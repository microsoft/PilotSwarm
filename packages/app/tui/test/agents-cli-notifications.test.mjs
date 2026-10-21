/**
 * `pilotswarm agents notifications` line format: owner-visible facts only,
 * unread marker, live approved-not-active state.
 *
 * Run: node --test tui/test/agents-cli-notifications.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatNotificationLine } from "../src/agents-cli.js";

test("review, broken and recovered notifications format as one line each", () => {
    assert.equal(formatNotificationLine({ id: "7", kind: "package_review", readAt: null, occurrences: 1,
        payload: { packageName: "kit", semver: "1.0.0", decision: "approved", approvedNotActive: true, reason: "ok" } }),
    "* 7 review kit@1.0.0 approved (approved, not active): ok");
    assert.equal(formatNotificationLine({ id: "8", kind: "cron_precheck_broken", readAt: "2025-01-01", occurrences: 2,
        payload: { precheck: "queue", outcome: "error", sessionId: "s1", packageName: "kit", semver: "1.0.0", summary: "threw" } }),
    "  8 precheck queue error session s1 (kit@1.0.0) x2: threw");
    assert.equal(formatNotificationLine({ id: "9", kind: "cron_precheck_broken", readAt: null, occurrences: 1,
        payload: { precheck: "queue", outcome: "timeout", packageId: "pkg", summary: "slow" } }),
    "* 9 precheck queue timeout (pkg) x1: slow", "the package owner's copy has no session");
    assert.equal(formatNotificationLine({ id: "10", kind: "cron_precheck_recovered", readAt: null, occurrences: 1,
        payload: { precheck: "trusted", sessionId: "s1", brokenOccurrences: 3 } }),
    "* 10 precheck trusted recovered session s1 after 3 broken run(s)");
});
