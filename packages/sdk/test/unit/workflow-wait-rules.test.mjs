/**
 * The wait rules the agent's wait, cron and cron_at tools and the workflow
 * wait state share: the limits per surface, and when a wait ends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    AGENT_CRON_MIN_INTERVAL_SECONDS,
    WORKFLOW_WAIT_MAX_SECONDS,
    WORKFLOW_WAIT_MIN_SECONDS,
    agentCronIntervalAllowed,
    waitDeadlineMs,
    waitUntil,
    workflowMinWaitSeconds,
    workflowWaitSecondsAllowed,
} from "../../dist/wait-rules.js";
import * as compiler from "../../dist/workflow/compiler.js";
import { workflowWaitUntil } from "../../dist/workflow/executor.js";
import { computeCronAtNextFire } from "../../dist/cron-at.js";

test("the limits per surface: cron at least 15 s; a workflow wait from 60 s to 7 days", () => {
    assert.equal(AGENT_CRON_MIN_INTERVAL_SECONDS, 15);
    assert.equal(WORKFLOW_WAIT_MIN_SECONDS, 60);
    assert.equal(WORKFLOW_WAIT_MAX_SECONDS, 604_800);
    for (const seconds of [15, 60, 3_600]) assert.equal(agentCronIntervalAllowed(seconds), true, String(seconds));
    for (const seconds of [14, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(agentCronIntervalAllowed(seconds), false, String(seconds));
    for (const seconds of [60, 600, 604_800]) assert.equal(workflowWaitSecondsAllowed(seconds), true, String(seconds));
    for (const seconds of [59, 604_801, 60.5, "60", null]) assert.equal(workflowWaitSecondsAllowed(seconds), false, String(seconds));
    assert.equal(workflowWaitSecondsAllowed(1, 1), true);
});

test("the compiler uses the shared limits", () => {
    assert.equal(compiler.WORKFLOW_WAIT_MIN_SECONDS, WORKFLOW_WAIT_MIN_SECONDS);
    assert.equal(compiler.WORKFLOW_WAIT_MAX_SECONDS, WORKFLOW_WAIT_MAX_SECONDS);
    assert.equal(compiler.workflowMinWaitSeconds, workflowMinWaitSeconds);
});

test("the development override lowers the workflow minimum, within the maximum", () => {
    assert.equal(workflowMinWaitSeconds({}), 60);
    assert.equal(workflowMinWaitSeconds({ PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS: "1" }), 1);
    assert.equal(workflowMinWaitSeconds({ PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS: " " }), 60);
    assert.equal(workflowMinWaitSeconds({ PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS: "0" }), 60);
    assert.equal(workflowMinWaitSeconds({ PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS: "1.5" }), 60);
    assert.equal(workflowMinWaitSeconds({ PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS: "9999999" }), 604_800);
});

test("a seconds wait ends that many seconds after it starts, like the agent wait", () => {
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    assert.equal(waitDeadlineMs(start, 600), start + 600_000);
    assert.deepEqual(waitUntil({ seconds: 600 }, start), { until: start + 600_000 });
    assert.deepEqual(workflowWaitUntil({ id: "s", type: "wait", seconds: 90, next: { elapsed: "x" } }, start), { until: start + 90_000 });
});

test("a clock wait ends at the next cron_at fire time after it starts, with its occurrence", () => {
    const at = { minute: 0, hour: 2, tz: "America/Los_Angeles" };
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    const expected = computeCronAtNextFire(at, start);
    assert.deepEqual(waitUntil({ at }, start), { until: expected.nextFireAtMs, occurrenceKey: expected.occurrenceKey, localTime: expected.localTime });
    assert.ok(expected.nextFireAtMs > start);
    // The last occurrence is passed on, so a DST fall-back hour does not fire twice.
    const seen = [];
    waitUntil({ at }, start, "key-1", (schedule, after, last) => { seen.push([schedule, after, last]); return { nextFireAtMs: after + 1, occurrenceKey: "key-2", localTime: "t", skippedOccurrences: 0 }; });
    assert.deepEqual(seen, [[at, start, "key-1"]]);
});
