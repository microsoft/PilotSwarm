/**
 * Review S2UI-F7: the replay and the Log stay linked for a long run. The Log lists its newest lines, or, while a replayed
 * visit's line is older than those, the lines around it (marked, and a click on a visit's line still moves the replay);
 * a visit whose line is not loaded reads older events and says so in plain words meanwhile, and when none are left.
 * The mounted case (older events read page by page) is the browser spec "S2UI-F7".
 *
 * Run: node --test ui/core/test/workflow-replay-log.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WORKFLOW_LOG_LIMIT, workflowLogWindow, workflowActivity } from "../src/workflow-view.js";
import { WorkflowLog } from "../../react/src/workflow-tab.js";

process.env.TZ = "UTC";
const T0 = Date.parse("2026-11-07T15:00:00.000Z");
// 150 visits of poll, each a start and an end: 300 lines, newest first.
const events = [];
for (let n = 1; n <= 150; n += 1) {
    const id = `nx-poll-${n}`;
    events.push({ seq: events.length + 1, eventType: "workflow.state_started", createdAt: new Date(T0 + n * 60_000).toISOString(),
        data: { runId: "run-1", nodeExecutionId: id, stateId: "poll", ordinal: n, step: n, type: "script" } });
    events.push({ seq: events.length + 1, eventType: "workflow.state_completed", createdAt: new Date(T0 + n * 60_000 + 30_000).toISOString(),
        data: { runId: "run-1", nodeExecutionId: id, stateId: "poll", step: n, outcome: "unchanged", resultKind: "business" } });
}
const runs = [{ runId: "run-1", mode: "live", status: "completed" }];
const visits = new Set(events.filter(event => event.eventType === "workflow.state_started").map(event => event.data.nodeExecutionId));

test("the Log's lines: the newest, or the lines around a replayed visit older than those", () => {
    const rows = workflowActivity(events, { limit: Infinity });
    assert.equal(rows.length, 300);
    assert.equal(WORKFLOW_LOG_LIMIT, 200);
    const now = workflowLogWindow(rows, null);
    assert.deepEqual([now.rows.length, now.found, now.around, now.rows[0].seq], [200, false, false, 300]);
    // A recent visit is among the newest lines.
    const recent = workflowLogWindow(rows, "nx-poll-140");
    assert.deepEqual([recent.found, recent.around, recent.rows[0].seq], [true, false, 300]);
    // The first visit is older than the newest 200: the 200 lines around it (here the oldest 200), its line among them.
    const first = workflowLogWindow(rows, "nx-poll-1");
    assert.deepEqual([first.rows.length, first.found, first.around], [200, true, true]);
    assert.ok(first.rows.some(row => row.eventType === "workflow.state_started" && row.nodeExecutionId === "nx-poll-1"));
    // The window is centred on the line, within the loaded lines: 100 newer lines above it where there are; here the
    // oldest 200 (its line 121st), and with a shorter limit, centred.
    const middle = workflowLogWindow(rows, "nx-poll-40");
    const at = middle.rows.findIndex(row => row.eventType === "workflow.state_started" && row.nodeExecutionId === "nx-poll-40");
    assert.deepEqual([middle.around, at, middle.rows.at(-1).seq], [true, 121, 1]);
    const centred = workflowLogWindow(rows, "nx-poll-40", 20);
    assert.deepEqual([centred.around, centred.rows.findIndex(row => row.nodeExecutionId === "nx-poll-40" && row.eventType === "workflow.state_started")], [true, 10]);
    // A visit with no loaded line: the newest lines, not found.
    assert.deepEqual([workflowLogWindow(rows, "nx-gone").found, workflowLogWindow(rows, "nx-gone").rows[0].seq], [false, 300]);
    assert.deepEqual(workflowLogWindow(null, "x"), { rows: [], found: false, around: false });
});

test("the Log marks a replayed visit older than its newest lines, says it lists the lines around it, and says when a line is not loaded", () => {
    const render = replay => renderToStaticMarkup(React.createElement(WorkflowLog, { events, runId: "run-1", runs, replay }));
    const replay = current => ({ visits, current, onVisit() {}, older: { more: false, load: null } });
    const first = render(replay("nx-poll-1"));
    assert.match(first, /<li[^>]*aria-current="step"[^>]*>.*?data-visit="nx-poll-1"/, "the first visit's line is listed and marked");
    // Owner 2026-11-09 (the timeline): the right end is Live.
    assert.match(first, /data-log="around"[^>]*>Around the visit shown\. Live shows the newest\./);
    assert.equal((first.match(/<li/g) || []).length, 200);
    // Live: the newest lines, nothing marked, no note.
    const now = render(replay(null));
    assert.ok(!now.includes('aria-current="step"') && !now.includes("data-log="), now.slice(0, 300));
    // A visit whose line is not loaded, with no older events to read: plain words, the newest lines.
    const gone = render(replay("nx-poll-0"));
    assert.match(gone, /data-log="missing"[^>]*>This visit&#x27;s line is not loaded\./);
    assert.ok(!gone.includes('aria-current="step"'));
});
