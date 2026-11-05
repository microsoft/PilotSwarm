// Owner decision local-time-20261104: the portal shows every time in the reader's own time zone (the browser's; the
// terminal machine's in the TUI) with the zone's short name, and no fixed "UTC"; stored data and the APIs stay ISO UTC.
// This file fixes its own zone to America/Los_Angeles, so no result depends on the zone of the machine that runs it;
// UTC and Los Angeles are also checked by name.
//
// Run: node --test packages/app/ui/core/test/workflow-local-time.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { formatLocalTime } from "../src/formatting.js";
import { appendEventToHistory, buildHistoryModel } from "../src/index.js";
import { projectWorkflowV2, workflowEventText, workflowV2EventTime, workflowV2JoinLimit } from "../src/workflow-v2-view.js";
import { readModel, row } from "./workflow-v2-fixtures.mjs";

process.env.TZ = "America/Los_Angeles";

/** Standard time in Los Angeles (UTC−8), and daylight time (UTC−7). */
const WINTER = "2026-11-04T20:30:00.000Z";
const SUMMER = "2026-07-01T12:00:05Z";

test("a time in a named zone: its date, its time and the zone's short name; the clock alone; no time is null", () => {
    assert.equal(formatLocalTime(WINTER, { timeZone: "America/Los_Angeles" }), "2026-11-04 12:30:00 PST");
    assert.equal(formatLocalTime(SUMMER, { timeZone: "America/Los_Angeles" }), "2026-07-01 05:00:05 PDT");
    assert.equal(formatLocalTime(WINTER, { timeZone: "UTC" }), "2026-11-04 20:30:00 UTC");
    assert.equal(formatLocalTime(Date.parse(WINTER), { timeZone: "UTC", clock: true }), "20:30:00 UTC");
    assert.equal(formatLocalTime(new Date(WINTER), { timeZone: "America/Los_Angeles", clock: true }), "12:30:00 PST");
    // The date is the zone's own, and midnight is 00, never 24.
    assert.equal(formatLocalTime("2026-11-05T08:00:00Z", { timeZone: "America/Los_Angeles" }), "2026-11-05 00:00:00 PST");
    assert.equal(formatLocalTime("2026-11-05T07:59:59Z", { timeZone: "America/Los_Angeles" }), "2026-11-04 23:59:59 PST");
    for (const value of [null, undefined, "", "not a time", Number.NaN, {}]) assert.equal(formatLocalTime(value), null);
    assert.equal(workflowV2EventTime(WINTER, "UTC"), "2026-11-04 20:30:00 UTC");
    assert.equal(workflowV2EventTime("no time"), null);
});

test("with no zone named, the reader's own (here America/Los_Angeles): event times, deadlines, the join's time limit and the step log", () => {
    assert.equal(workflowV2EventTime(WINTER), "2026-11-04 12:30:00 PST");
    assert.equal(workflowV2EventTime(SUMMER), "2026-07-01 05:00:05 PDT");
    assert.equal(formatLocalTime(WINTER, { clock: true }), "12:30:00 PST");
    assert.deepEqual(workflowV2JoinLimit({ timeoutSeconds: 120 }, { deadline: WINTER }, { running: true }),
        { text: "time limit until 2026-11-04 12:30:00 PST", title: "The time limit is 2 min from the step's start: it passes at 2026-11-04 12:30:00 PST." });
    // A time an event carries as ISO text is shown the same way.
    assert.equal(workflowEventText("workflow.stop_requested", { deadlineAt: WINTER, reason: "release" }).text,
        "Stop asked; started nodes may finish until 2026-11-04 12:30:00 PST: release");
    // A wait's deadline in its step's description.
    const view = projectWorkflowV2({ readModel: readModel({ nodeExecutions: [row("pause", 1, "pending", { deadline: WINTER })] }) });
    assert.deepEqual(view.nodes.find(node => node.id === "pause").description, ["Waiting until 2026-11-04 12:30:00 PST."]);
    // The step log's "last checked" time, on a polling step's row.
    let seq = 0;
    const event = (eventType, data) => ({ seq: ++seq, sessionId: "workflow", eventType, data, createdAt: new Date(Date.parse(WINTER) + seq * 1_000) });
    const rows = [event("workflow.started", { name: "query-watch", initial: "poll", states: [
        { id: "poll", type: "script", runtime: "node", next: { unchanged: "poll", changed: "end" } }, { id: "end", type: "terminal", outcome: "succeeded" },
    ] })];
    for (let step = 1; step <= 2; step += 1) {
        rows.push(event("workflow.state_started", { stateId: "poll", step, runtime: "node" }),
            event("workflow.state_completed", { stateId: "poll", step, outcome: "unchanged", durationMs: 120, exitCode: 0 }));
    }
    const summary = buildHistoryModel(rows).chat.find(item => item.workflowProgress)?.workflowNotice.summary ?? "";
    assert.match(summary, /last checked 12:30:05 PST/);
    assert.ok(!summary.includes("UTC"), summary);
    // Appending live keeps the same words.
    const live = appendEventToHistory(buildHistoryModel(rows.slice(0, -1)), rows.at(-1));
    assert.equal(live.chat.find(item => item.workflowProgress)?.workflowNotice.summary, summary);
});
