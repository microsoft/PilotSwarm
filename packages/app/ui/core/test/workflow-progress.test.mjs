import test from "node:test";
import assert from "node:assert/strict";
import { appendEventToHistory, buildHistoryModel } from "../src/index.js";

function fixture() {
    let seq = 0;
    const event = (eventType, data, sessionId = "workflow") => ({
        seq: ++seq, sessionId, eventType, data,
        createdAt: new Date(Date.UTC(2026, 9, 31, 12, 0, seq)),
    });
    const definition = event("workflow.started", { name: "query-watch", initial: "poll", states: [
        { id: "poll", type: "script", runtime: "node", next: { unchanged: "poll", changed: "end", failed: "end" } },
        { id: "end", type: "terminal", outcome: "succeeded" },
    ] });
    const start = step => event("workflow.state_started", { stateId: "poll", step, runtime: "node" });
    const complete = (step, overrides = {}) => event("workflow.state_completed", {
        stateId: "poll", step, outcome: "unchanged", durationMs: 120, exitCode: 0,
        resultSource: "reported", outputPreview: '{"unchanged":true}', toolCalls: [{ name: "query", ok: true }],
        ...overrides,
    });
    return { event, definition, start, complete };
}
const progress = history => history.chat.filter(item => item.workflowProgress);

test("unchanged polls update one row and keep durable history", () => {
    const f = fixture();
    const rows = [f.definition];
    for (let step = 1; step <= 28; step++) rows.push(f.start(step), f.complete(step));
    const history = buildHistoryModel(rows);
    assert.equal(history.chat.length, 2);
    assert.equal(progress(history).length, 1);
    assert.equal(progress(history)[0].workflowProgress.count, 28);
    assert.match(progress(history)[0].workflowNotice.title, /Waiting for changes/);
    assert.match(progress(history)[0].workflowNotice.summary, /28 checks.*unchanged.*last checked.*UTC/);
    assert.equal(history.events.length, rows.length);
    assert.match(progress(history)[0].text, /\| 28 \| unchanged \| 120 ms \| 1 \|/);
});

test("live append matches full replay and leaves the previous history immutable", () => {
    const f = fixture();
    const rows = [f.definition, f.start(1), f.complete(1)];
    let history = buildHistoryModel(rows);
    const first = structuredClone(history);
    const id = progress(history)[0].id;
    const nextStart = f.start(2);
    const checking = appendEventToHistory(history, nextStart);
    assert.deepEqual(history, first);
    assert.equal(progress(checking)[0].workflowProgress.count, 1);
    assert.match(progress(checking)[0].workflowNotice.title, /Checking/);
    const nextEnd = f.complete(2);
    history = appendEventToHistory(checking, nextEnd);
    assert.equal(progress(history)[0].id, id);
    assert.deepEqual(history.chat, buildHistoryModel([...rows, nextStart, nextEnd]).chat);
});

test("a meaningful outcome remains separate and ends the polling summary", () => {
    const f = fixture();
    const history = buildHistoryModel([f.definition, f.start(1), f.complete(1), f.start(2),
        f.complete(2, { outcome: "changed", outputPreview: '{"pr":34}' }),
        f.event("workflow.completed", { stateId: "end", steps: 2, outcome: "succeeded" })]);
    assert.equal(progress(history).length, 1);
    assert.equal(progress(history)[0].workflowProgress.count, 1);
    assert.match(progress(history)[0].workflowNotice.title, /Polling ended/);
    assert.ok(history.chat.some(item => item.workflowNotice?.summary.includes("poll → changed")));
    assert.equal(history.chat.at(-1).workflowEvent, "workflow.completed");
});

for (const [label, overrides] of [
    ["tool error", { toolCalls: [{ name: "query", ok: false }] }],
    ["process error", { exitCode: 1, resultSource: "exit" }],
    ["stderr", { stderrTail: "read was incomplete" }],
]) {
    test(`${label} is never swallowed by unchanged-poll aggregation`, () => {
        const f = fixture();
        const history = buildHistoryModel([f.definition, f.start(1), f.complete(1), f.start(2), f.complete(2, overrides)]);
        assert.equal(progress(history)[0].workflowProgress.count, 1);
        assert.equal(history.chat.at(-1).workflowProgress, undefined);
        assert.equal(history.chat.at(-1).workflowEvent, "workflow.state_completed");
    });
}

for (const type of ["workflow.state_failed", "workflow.state_cancelled", "workflow.failed", "workflow.cancelled"]) {
    test(`${type} remains visible and stops the running summary`, () => {
        const f = fixture();
        const history = buildHistoryModel([f.definition, f.start(1), f.complete(1), f.start(2),
            f.event(type, { stateId: "poll", step: 2, steps: 2, error: "lost", reason: "stopped" })]);
        assert.equal(history.chat.at(-1).workflowEvent, type);
        assert.equal(progress(history)[0].workflowProgress.pending, false);
        assert.equal(progress(history)[0].workflowProgress.waiting, false);
    });
}

test("no empty summary remains if the first poll changes or fails", () => {
    const f = fixture();
    for (const tail of [f.complete(1, { outcome: "changed" }), f.event("workflow.state_failed", { stateId: "poll", step: 1 })]) {
        const history = buildHistoryModel([f.definition, f.start(1), tail]);
        assert.equal(progress(history).length, 0);
        assert.equal(history.chat.length, 2);
    }
});

test("duplicate or older attempts do not increase the count", () => {
    const f = fixture();
    const first = f.complete(1);
    const second = f.complete(2);
    let history = buildHistoryModel([f.definition, f.start(1), first, f.start(2), second]);
    for (const row of [second, first, f.start(1), f.start(2)]) history = appendEventToHistory(history, row);
    assert.equal(progress(history)[0].workflowProgress.count, 2);
    assert.equal(progress(history).length, 1);
});

test("a gap, different self-loop outcome, or new workflow does not pretend continuity", () => {
    const f = fixture();
    const gap = buildHistoryModel([f.definition, f.start(1), f.complete(1), f.start(4), f.complete(4)]);
    assert.deepEqual(progress(gap).map(item => item.workflowProgress.count), [1, 1]);
    const alternative = { ...f.definition, data: { ...f.definition.data, states: [
        { id: "poll", type: "script", next: { unchanged: "poll", retry: "poll" } },
    ] } };
    const changed = buildHistoryModel([alternative, f.start(1), f.complete(1), f.start(2), f.complete(2, { outcome: "retry" })]);
    assert.deepEqual(progress(changed).map(item => item.workflowProgress.outcome), ["unchanged", "retry"]);
    const restarted = buildHistoryModel([f.definition, f.start(1), f.complete(1), { ...f.definition, seq: 100 }, f.start(1), f.complete(1)]);
    assert.deepEqual(progress(restarted).map(item => item.workflowProgress.count), [1, 1]);
});

test("paged history without its definition labels counts as loaded, not lifetime totals", () => {
    const f = fixture();
    const history = buildHistoryModel([f.start(42), f.complete(42), f.start(43), f.complete(43)]);
    assert.equal(progress(history)[0].workflowProgress.count, 2);
    assert.match(progress(history)[0].workflowNotice.summary, /2 checks loaded/);
});

test("a long live loop bounds detail rows while keeping the increasing count", () => {
    const f = fixture();
    let history = buildHistoryModel([f.definition]);
    for (let step = 1; step <= 500; step++) {
        history = appendEventToHistory(history, f.start(step));
        history = appendEventToHistory(history, f.complete(step));
    }
    const row = progress(history)[0];
    assert.equal(history.chat.length, 2);
    assert.equal(row.workflowProgress.count, 500);
    assert.equal(row.workflowProgress.entries.length, 40);
    assert.match(row.text, /latest 40 of 500/);
    assert.ok(history.events.length <= 300);
});

test("ordinary workflow states and agent messages keep their existing transcript", () => {
    const f = fixture();
    const noLoop = { ...f.definition, data: { ...f.definition.data, states: [{ id: "poll", next: { unchanged: "end" } }] } };
    const history = buildHistoryModel([noLoop, f.start(1), f.complete(1)]);
    assert.equal(progress(history).length, 0);
    assert.deepEqual(history.chat.map(item => item.workflowEvent), [
        "workflow.started", "workflow.state_started", "workflow.state_completed",
    ]);
    const user = f.event("user.message", { content: "unchanged polling text is just a message" }, "agent");
    assert.ok(buildHistoryModel([user]).chat.every(item => !item.workflowProgress));
});

test("explicit change and failure outcomes stay visible even when routed back to the same state", () => {
    const f = fixture();
    for (const outcome of ["changed", "failed", "timeout"]) {
        const definition = { ...f.definition, data: { ...f.definition.data, states: [
            { id: "poll", next: { unchanged: "poll", [outcome]: "poll" } },
        ] } };
        const history = buildHistoryModel([definition, f.start(1), f.complete(1), f.start(2), f.complete(2, { outcome })]);
        assert.equal(progress(history)[0].workflowProgress.count, 1);
        assert.equal(history.chat.at(-1).workflowProgress, undefined);
        assert.match(history.chat.at(-1).workflowNotice.summary, new RegExp(outcome));
    }
});
