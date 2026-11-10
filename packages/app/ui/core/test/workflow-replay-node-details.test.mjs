/**
 * Review S2UI-F5: replaying a visit that ran in a branch shows that visit in Node details: its branch in the picker, its
 * Now and its result, and Open the agent chat opens its own chat, never another branch's that was running at that moment.
 * The mounted case (the replay bar choosing the visit) is the browser spec "S2UI-F5".
 *
 * Run: node --test ui/core/test/workflow-replay-node-details.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectWorkflow, workflowReplayBranchIndex, workflowReplayFrames } from "../src/workflow-view.js";
import { RunNodePanel } from "../../react/src/workflow-tab.js";
import { done, readModel } from "./workflow-fixtures.mjs";

process.env.TZ = "UTC";
const T = minutes => new Date(Date.parse("2026-11-07T15:00:00.000Z") + minutes * 60_000).toISOString();
const states = [
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "work", states: ["work", "end"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "work", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], next: { ok: "end" }, parallel: "fan" },
    { id: "end", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const at = index => ({ scopeId: `nx-fan-1#${index}`, branch: { parallelNodeExecutionId: "nx-fan-1", index } });
// Branch 1's work runs 15:01-15:06 in chat-a; branch 2's work runs 15:02-15:05 in chat-b: both run at 15:02.
const model = readModel({
    graph: { revision: 1, initial: "fan", states },
    run: { status: "completed", outcome: "succeeded", terminalState: "done" },
    nodeExecutions: [
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 2, enteredAt: T(0), endedAt: T(10) }),
        done("work", 1, "ok", { nodeExecutionId: "nx-work-b0", enteredAt: T(1), endedAt: T(6), outputPreview: '{"who":"a"}',
            agent: { childSessionId: "chat-a", spawned: true }, ...at(0) }),
        done("work", 1, "ok", { nodeExecutionId: "nx-work-b1", enteredAt: T(2), endedAt: T(5), outputPreview: '{"who":"b"}',
            agent: { childSessionId: "chat-b", spawned: true }, ...at(1) }),
        done("end", 1, "succeeded", { nodeExecutionId: "nx-end-b1", enteredAt: T(5), endedAt: T(5), ...at(1) }),
        done("end", 1, "succeeded", { nodeExecutionId: "nx-end-b0", enteredAt: T(6), endedAt: T(6), ...at(0) }),
        done("done", 1, "succeeded", { nodeExecutionId: "nx-done-1", enteredAt: T(10), endedAt: T(10) }),
    ],
});
const controller = { dispatch() {}, loadSession: async () => {}, selectWorkflowExecution() {}, loadWorkflowExecutionValue: async () => {} };
const render = (projection, replayFrame) => {
    const selected = projection.nodes.find(node => node.id === "work");
    return renderToStaticMarkup(React.createElement(RunNodePanel, { controller, selected, replayFrame,
        child: { sessionId: "wf-1", view: {}, projection, nodes: projection.nodes } }));
};

test("a replayed branch visit's details are that visit's: its branch, and its own agent chat", () => {
    const live = projectWorkflow({ readModel: model });
    const frames = workflowReplayFrames(live.allExecutions);
    const frame = frames.find(item => item.nodeExecutionId === "nx-work-b1");
    assert.equal(frame.branchIndex, 1);
    const replayed = projectWorkflow({ readModel: model, asOf: frame.atMs });
    const work = replayed.nodes.find(node => node.id === "work");
    // Both branches run at 15:02; the step's default branch is the first one running (branch 1).
    assert.deepEqual(work.branches.choices.map(choice => [choice.index, choice.execution.status]), [[0, "pending"], [1, "pending"]]);
    assert.equal(work.branches.defaultIndex, 0);
    assert.equal(workflowReplayBranchIndex(work, frame), 1);
    // Another step, or no replay, has no replayed branch.
    assert.equal(workflowReplayBranchIndex(replayed.nodes.find(node => node.id === "fan"), frame), null);
    assert.equal(workflowReplayBranchIndex(work, null), null);
    // A visit no longer listed by id falls back to its branch number when listed.
    assert.equal(workflowReplayBranchIndex(work, { ...frame, nodeExecutionId: "nx-gone" }), 1);
    assert.equal(workflowReplayBranchIndex(work, { ...frame, nodeExecutionId: "nx-gone", branchIndex: 7 }), null);

    const html = render(replayed, frame);
    assert.match(html, /data-action="open-agent-chat"[^>]*data-session="chat-b"/, html);
    assert.ok(!html.includes('data-session="chat-a"'), "never the other branch's chat");
    assert.match(html, /<option[^>]*value="1"[^>]*selected=""/, "the picker shows branch 2");
    // Without the replay, the same moment's details would show the default branch's chat.
    assert.match(render(replayed, null), /data-session="chat-a"/);
    // Replaying branch 1's visit shows branch 1.
    const first = frames.find(item => item.nodeExecutionId === "nx-work-b0");
    assert.match(render(projectWorkflow({ readModel: model, asOf: first.atMs }), first), /data-session="chat-a"/);
});
