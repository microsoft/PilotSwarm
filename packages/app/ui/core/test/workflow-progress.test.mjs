// The compact polling log: repeated visits of one script state through a
// wait loop fold into one row that updates in place. Display only: the
// events are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { appendEventToHistory, buildHistoryModel } from "../src/index.js";
import { WORKFLOW_PROGRESS_DETAIL_LIMIT } from "../src/workflow-progress.js";

let seq = 0;
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);
function ev(eventType, data) {
    seq += 1;
    return { sessionId: "wf", seq, eventType, data, createdAt: new Date(T0 + seq * 1_000) };
}

const started = () => ev("workflow.started", {
    name: "poll", version: "1.0.0", initial: "check",
    states: [
        { id: "check", type: "script", runtime: "node", next: { idle: "sleep", found: "handle" } },
        { id: "sleep", type: "wait", seconds: 600, next: { elapsed: "check" } },
        { id: "handle", type: "script", runtime: "node", next: { done: "end" } },
        { id: "end", type: "terminal", outcome: "succeeded" },
    ],
});

/** One check through the loop: started, completed with `outcome`, then (unless last) a wait. */
function loop(visits, { outcome = "idle", firstVisit = 1, firstStep = 1, wait = true } = {}) {
    const events = [];
    let step = firstStep;
    for (let i = 0; i < visits; i++) {
        const visit = firstVisit + i;
        events.push(ev("workflow.state_started", { stateId: "check", runtime: "node", step, visit }));
        events.push(ev("workflow.state_completed", {
            stateId: "check", step, visit, outcome, resultSource: "reported", exitCode: 0, durationMs: 800,
            toolCalls: [{ name: "read_facts", ok: true }], outputPreview: `{"visit":${visit}}`,
        }));
        step += 1;
        if (wait) {
            events.push(ev("workflow.state_waiting", { stateId: "sleep", step, seconds: 600, until: T0 + (seq + 600) * 1_000, visit }));
            step += 1;
        }
    }
    return events;
}

const rows = (history) => history.chat.filter((item) => item.workflowEvent);
const progressRows = (history) => rows(history).filter((item) => item.workflowProgress);

test("a polling loop through a wait folds into one row that counts its checks", () => {
    const history = buildHistoryModel([started(), ...loop(5)]);
    const all = rows(history);
    assert.equal(all.length, 2, all.map((r) => r.workflowEvent).join(","));
    assert.equal(all[0].workflowEvent, "workflow.started");
    const row = all[1];
    assert.equal(row.workflowProgress.count, 5);
    assert.equal(row.workflowProgress.entries.length, 5);
    assert.equal(row.workflowNotice.title, "◇ check");
    assert.match(row.workflowNotice.summary, /^Waiting · 5 checks · idle · last checked \d{2}:\d{2}( [AP]M)? · last 800 ms · next check \d{2}:\d{2}/);
    assert.match(row.text, /\| Step \| Outcome \| Time \| Tools \|/);
    assert.match(row.text, /Latest output:[\s\S]*\{"visit":5\}/);
    assert.doesNotMatch(row.text, /Showing the latest/);
});

test("one visit, or a state that is not visited again, is not folded", () => {
    const once = buildHistoryModel([started(), ...loop(1)]);
    assert.deepEqual(rows(once).map((r) => r.workflowEvent),
        ["workflow.started", "workflow.state_started", "workflow.state_completed", "workflow.state_waiting"]);
    assert.equal(progressRows(once).length, 0);
});

test("the row updates in place as checks arrive live", () => {
    let history = buildHistoryModel([started(), ...loop(2)]);
    const id = progressRows(history)[0].id;
    for (const event of loop(3, { firstVisit: 3, firstStep: 5 })) history = appendEventToHistory(history, event);
    const groups = progressRows(history);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, id, "the same row");
    assert.equal(groups[0].workflowProgress.count, 5);
    history = appendEventToHistory(history, ev("workflow.state_started", { stateId: "check", step: 11, visit: 6 }));
    assert.match(progressRows(history)[0].workflowNotice.summary, /^Checking · 5 checks/);
});

test("a different outcome ends the group and gets its own row", () => {
    const history = buildHistoryModel([
        started(), ...loop(3),
        ev("workflow.state_started", { stateId: "check", step: 7, visit: 4 }),
        ev("workflow.state_completed", { stateId: "check", step: 7, visit: 4, outcome: "found", resultSource: "reported", durationMs: 900 }),
        ev("workflow.state_started", { stateId: "handle", step: 8, visit: 1 }),
    ]);
    const all = rows(history);
    assert.deepEqual(all.map((r) => r.workflowEvent),
        ["workflow.started", "workflow.progress", "workflow.state_completed", "workflow.state_started"]);
    assert.match(all[1].workflowNotice.summary, /^Polling ended · 3 checks · idle/);
    assert.equal(all[1].workflowNotice.color, "gray");
    assert.match(all[2].workflowNotice.summary, /check → found/);
});

test("a failed check is never folded away", () => {
    const history = buildHistoryModel([
        started(), ...loop(2),
        ev("workflow.state_started", { stateId: "check", step: 5, visit: 3 }),
        ev("workflow.state_completed", { stateId: "check", step: 5, visit: 3, outcome: "idle", resultSource: "exit", exitCode: 1, stderrTail: "boom" }),
    ]);
    const all = rows(history);
    assert.equal(all.at(-1).workflowEvent, "workflow.state_completed");
    assert.match(all.at(-1).text, /boom/);
    assert.match(progressRows(history)[0].workflowNotice.summary, /^Polling ended · 2 checks/);
});

test("the row lists the latest 40 checks and says how many there were", () => {
    const history = buildHistoryModel([started(), ...loop(45)]);
    const row = progressRows(history)[0];
    assert.equal(row.workflowProgress.entries.length, WORKFLOW_PROGRESS_DETAIL_LIMIT);
    assert.equal(row.workflowProgress.count, 45);
    assert.equal(row.workflowProgress.entries[0].step, 1 + 2 * 5);
    assert.match(row.text, /Showing the latest 40 of 45 checks; full events remain in the execution log\./);
});

test("a transcript loaded mid-loop counts the lifetime checks from each event's visit", () => {
    // The first 30 visits are not loaded; the window starts mid-attempt.
    const window = loop(4, { firstVisit: 31, firstStep: 61 }).slice(1);
    const history = buildHistoryModel(window);
    const row = progressRows(history)[0];
    assert.equal(row.workflowProgress.count, 34);
    assert.equal(row.workflowProgress.entries.length, 4);
    assert.match(row.workflowNotice.summary, /^Waiting · 34 checks/);
    assert.match(row.text, /Showing the latest 4 of 34 checks/);
});

test("the end of the run ends the group, and the events behind it are unchanged", () => {
    const events = [started(), ...loop(3), ev("workflow.cancelled", { name: "poll", steps: 6, stateId: "sleep", reason: "enough" })];
    const copy = JSON.parse(JSON.stringify(events));
    const history = buildHistoryModel(events);
    assert.deepEqual(rows(history).map((r) => r.workflowEvent), ["workflow.started", "workflow.progress", "workflow.cancelled"]);
    assert.match(progressRows(history)[0].workflowNotice.summary, /^Polling ended · 3 checks/);
    assert.deepEqual(JSON.parse(JSON.stringify(events)), copy);
});
