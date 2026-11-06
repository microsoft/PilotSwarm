// An agent node's Log shows its chat (owner feedback 2026-11-06, finding 8): one group per visit, newest first
// ("Visit 2 · 17:42:01"), each with its Prompt, Agent and Workflow rows in time order, told apart by label (and, in the
// portal, the colour of the row's edge). A chat that continues across visits is cut at each visit's prompt. Tool calls are
// one line each, to expand; long text folds with Show more. The base instructions are not recorded, and the Log says so.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-agent-log.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    WORKFLOW_AGENT_LOG_FOLD, WORKFLOW_AGENT_LOG_NOTE, WORKFLOW_BASE_INSTRUCTIONS_CHANGED, WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY, workflowAgentLogChats,
    workflowAgentNodeLog, workflowBaseInstructions, workflowBaseInstructionsMatch, workflowBaseInstructionsReadable, workflowLogFold, workflowPromptVisit,
} from "../src/workflow-agent-log.js";
import { sha256Hex } from "../src/sha256.js";
import { createHash } from "node:crypto";
import { WorkflowV2AgentLog } from "../../react/src/workflow-v2-panels.js";

process.env.TZ = "UTC";
const NOW = Date.parse("2026-11-06T17:50:00.000Z");
const at = clock => `2026-11-06T${clock}.000Z`;
const CHAT = "chat-continued";
const prompt = (seq, nx, clock, content) => ({ sessionId: CHAT, seq, eventType: "user.message", createdAt: at(clock),
    data: { content, clientMessageIds: [`workflow:wf-1:run-1:agent:${nx}`], sender: { kind: "agent", display: "workflow node invocation" } } });
const chatEvent = (seq, eventType, clock, data) => ({ sessionId: CHAT, seq, eventType, createdAt: at(clock), data });
const wfEvent = (seq, eventType, clock, data) => ({ sessionId: "wf-1", seq, eventType, createdAt: at(clock), data: { runId: "run-1", stateId: "talk", ...data } });

const node = {
    id: "talk", kind: "agent", type: "agent", runs: 2, outcomes: ["again", "finish"], next: { again: "pause", finish: "done" },
    executions: [
        { id: "nx-1", ordinal: 1, status: "completed", outcome: "again", resultKind: "business", enteredAt: at("17:40:01"), endedAt: at("17:40:09"),
            agent: { childSessionId: CHAT } },
        { id: "nx-2", ordinal: 2, status: "pending", enteredAt: at("17:42:01"), deadline: at("17:43:01"), agent: { childSessionId: CHAT } },
    ],
};
node.current = node.executions[1];
const LONG = `${"MVCC keeps old row versions. ".repeat(40)}End.`;
const chat = [
    chatEvent(1, "session.turn_started", "17:40:01", {}),
    prompt(2, "nx-1", "17:40:02", "[SYSTEM: WORKFLOW NODE INVOCATION.]\n{\"input\":{}}\n[SYSTEM: The task of this state:]\nTell one fact."),
    chatEvent(3, "tool.execution_start", "17:40:03", { toolCallId: "t1", toolName: "read_facts", arguments: { key_pattern: "facts/%" } }),
    chatEvent(4, "tool.execution_complete", "17:40:04", { toolCallId: "t1", toolName: "read_facts", result: { count: 0 } }),
    chatEvent(5, "assistant.message", "17:40:05", { content: "PostgreSQL uses MVCC." }),
    chatEvent(6, "tool.execution_start", "17:40:06", { toolCallId: "t2", toolName: "complete_workflow_node",
        arguments: { outcome: "again", output: { fact: "MVCC" }, operation_id: "op-1", node_execution_id: "nx-1" } }),
    chatEvent(7, "tool.execution_complete", "17:40:07", { toolCallId: "t2", toolName: "complete_workflow_node", result: "{\"ok\":true}" }),
    prompt(8, "nx-2", "17:42:02", "[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2.]\n{\"cycle\":2}\n[SYSTEM: The task of this state:]\nTell one fact."),
    chatEvent(9, "system.message", "17:42:03", { content: "Workspace note." }),
    chatEvent(10, "assistant.message", "17:42:04", { content: LONG }),
];
const events = [
    wfEvent(20, "workflow.state_started", "17:40:01", { nodeExecutionId: "nx-1", step: 1 }),
    wfEvent(21, "workflow.agent_spawned", "17:40:02", { nodeExecutionId: "nx-1", childSessionId: CHAT, chat: "continue", cycle: 1 }),
    wfEvent(22, "workflow.state_completed", "17:40:08", { nodeExecutionId: "nx-1", step: 1, outcome: "again" }),
    wfEvent(23, "workflow.agent_cycle_ended", "17:40:09", { nodeExecutionId: "nx-1", childSessionId: CHAT, turnStopped: true }),
    wfEvent(24, "workflow.state_started", "17:42:01", { nodeExecutionId: "nx-2", step: 2 }),
    wfEvent(25, "workflow.state_started", "17:42:01", { runId: "run-other", nodeExecutionId: "nx-2", step: 2 }),
];

test("a prompt names its visit by its client message id; the chats read are the shown visits' (a continued chat once)", () => {
    assert.equal(workflowPromptVisit(chat[1]), "nx-1");
    assert.equal(workflowPromptVisit(chat[4]), null);
    assert.deepEqual(workflowAgentLogChats(node), [CHAT]);
    assert.deepEqual(workflowLogFold("short"), { text: "short" });
    const folded = workflowLogFold(LONG);
    assert.equal(folded.more, LONG);
    assert.ok(folded.text.length <= WORKFLOW_AGENT_LOG_FOLD + 1 && folded.text.endsWith("…"));
});

test("one group per visit, newest first; each visit's chat rows and Workflow rows in time order, told apart", () => {
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, chat]]), runId: "run-1", now: NOW });
    assert.equal(log.note, WORKFLOW_AGENT_LOG_NOTE);
    assert.equal(log.loading, false);
    assert.deepEqual(log.groups.map(group => [group.header, group.status]), [
        ["Visit 2 · 17:42:01 UTC", "Agent working since 17:42:01 UTC · time limit 17:43:01 UTC"],
        ["Visit 1 · 17:40:01 UTC", "Done 17:40:09 UTC · again"],
    ]);
    const [second, first] = log.groups;
    assert.deepEqual(first.rows.map(row => [row.kind, row.label, row.text.split("\n")[0]]), [
        ["workflow", "Workflow", "Node talk started"],
        ["prompt", "Prompt", "[SYSTEM: WORKFLOW NODE INVOCATION.]"],
        ["workflow", "Workflow", "Agent chat for node talk created (session chat-con)"],
        ["agent", "Tool", "read_facts — facts/%"],
        ["agent", "Agent", "PostgreSQL uses MVCC."],
        ["result", "Typed result", "again · {\"fact\":\"MVCC\"}"],
        ["workflow", "Workflow", "Node talk ended: again"],
        ["workflow", "Workflow", "Node talk visit ended; its agent chat stays open for the next visit (its running turn was stopped)"],
    ]);
    const tool = first.rows.find(row => row.label === "Tool");
    assert.match(tool.detail, /^Arguments\n\{\n {2}"key_pattern": "facts\/%"\n\}\n\nResult\n\{\n {2}"count": 0\n\}$/);
    assert.deepEqual(first.rows.map(row => row.time), first.rows.map(row => row.time).slice().sort());
    // The second visit gets only its own part of the one chat (cut at its prompt), and only its own run's lines.
    assert.deepEqual(second.rows.map(row => [row.kind, row.label]), [
        ["workflow", "Workflow"], ["prompt", "Prompt"], ["prompt", "Note to the agent"], ["agent", "Agent"],
    ]);
    const answer = second.rows.find(row => row.label === "Agent");
    assert.equal(answer.more, LONG, "a long answer folds");
    // Not read yet: the visit says so, and nothing is guessed.
    const unread = workflowAgentNodeLog({ node, events, chats: new Map(), runId: "run-1", now: NOW });
    assert.equal(unread.loading, true);
    assert.ok(unread.groups.every(group => group.loading && group.rows.every(row => row.kind === "workflow")));
    // Older visits beyond the limit: "Show older visits".
    assert.equal(workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, chat]]), runId: "run-1", limit: 1, now: NOW }).more, true);
});

test("the portal draws each row with its label, folds long text and expands a tool call; the note says what is not recorded", () => {
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, chat]]), runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log, nodeId: "talk", onMore: () => {} }));
    assert.ok(html.includes("Prompt rows are what the agent was given, its base instructions first; Agent rows are what it did."));
    assert.ok(html.includes("Visit 2 · 17:42:01 UTC") && html.includes("Visit 1 · 17:40:01 UTC"));
    assert.ok(html.indexOf("Visit 2") < html.indexOf("Visit 1"), "newest visit first");
    for (const kind of ["prompt", "agent", "result", "workflow"]) assert.ok(html.includes(`data-kind="${kind}"`), kind);
    assert.match(html, /<details><summary>read_facts — facts\/%<\/summary><pre>Arguments/);
    assert.ok(html.includes("Show more"));
    assert.ok(!html.includes(LONG), "the long answer is folded");
    const failed = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, {
        log: workflowAgentNodeLog({ node, events, chats: new Map(), runId: "run-1", now: NOW }), failed: new Set([CHAT]) }));
    assert.ok(failed.includes("Its agent chat could not be read."));
});

// The base instructions (finding 8, "show the base prompts"): the runtime records a summary of the SDK's echo of the
// composed system prompt; for a workflow agent chat it also keeps the whole text once per distinct sha256 on the
// Workflow and names it in the summary event (baseInstructions). The Log shows a folded "Base instructions" Prompt row
// before the visit's prompt; opened, it reads the kept text. The same text again in a visit is one row.
const SUMMARY = "[SYSTEM: Copilot SDK rebuilt the full system prompt for model input. Full content omitted from CMS (48210 chars). "
    + "Snippet: You are the GitHub Copilot CLI, a terminal assistant built by GitHub. You are an interactive...]";
const SHA = "0123456789abcdef".repeat(4);
const KEPT = { sessionId: "wf-1", artifact: "base-instructions-0123456789abcdef.md", sha256: SHA, chars: 48210 };
const base = (seq, clock, kept = KEPT) => chatEvent(seq, "system.message", clock, { content: SUMMARY, ...(kept ? { baseInstructions: kept } : {}) });

test("the base instructions: the recorded summary is a Base instructions row before the visit's prompt, naming where the whole text is", () => {
    assert.deepEqual(workflowBaseInstructions({ content: SUMMARY, baseInstructions: KEPT }), { chars: 48210,
        snippet: "You are the GitHub Copilot CLI, a terminal assistant built by GitHub. You are an interactive...",
        ref: { sessionId: "wf-1", artifact: "base-instructions-0123456789abcdef.md", sha256: SHA } });
    assert.equal(workflowBaseInstructions({ content: SUMMARY }).ref, null, "an older chat kept only the summary");
    assert.equal(workflowBaseInstructions({ content: SUMMARY, baseInstructions: { ...KEPT, artifact: "../secret.md" } }).ref, null);
    assert.equal(workflowBaseInstructions({ content: "Workspace note." }), null);
    // The echo comes after the visit's prompt is recorded; the Log shows it first, once per visit.
    const withBase = [...chat.slice(0, 2), base(2.1, "17:40:02"), base(2.2, "17:40:05"), ...chat.slice(2)];
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, withBase]]), runId: "run-1", now: NOW });
    const first = log.groups[1].rows.filter(row => row.kind === "prompt");
    assert.deepEqual(first.map(row => row.label), ["Base instructions", "Prompt"]);
    assert.equal(first[0].text, "48,210 characters: You are the GitHub Copilot CLI, a terminal assistant built by GitHub. You are an interactive...");
    assert.deepEqual(first[0].instructions, { sessionId: "wf-1", artifact: "base-instructions-0123456789abcdef.md", sha256: SHA });
});

test("the portal's Base instructions row reads the kept text when opened, and says plainly when only the summary was kept", () => {
    const withBase = [...chat.slice(0, 2), base(2.1, "17:40:02"), ...chat.slice(2), base(9.5, "17:42:02", null)];
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, withBase]]), runId: "run-1", now: NOW });
    const asked = [];
    const render = read => renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log, nodeId: "talk", readInstructions: read,
        onInstructions: ref => asked.push(ref) }));
    const closed = render(() => null);
    assert.match(closed, /<details class="ps-wf-alog-base"><summary>48,210 characters: You are the GitHub Copilot CLI/);
    assert.ok(closed.includes("Open to read the whole text."));
    assert.ok(closed.includes("Only this summary was kept for this chat; its whole text was not."), "the second visit's echo kept no text");
    const loading = render(() => ({ loading: true, text: null, error: null }));
    assert.ok(loading.includes("Reading the base instructions…"));
    const whole = "You are the GitHub Copilot CLI, a terminal assistant built by GitHub.\n\nThe whole composed text.";
    const read = render(ref => (ref.artifact === KEPT.artifact ? { loading: false, text: whole, error: null } : null));
    assert.ok(read.includes(`data-base-instructions="${KEPT.artifact}"`) && read.includes("The whole composed text."));
    const failed = render(() => ({ loading: false, text: null, error: "Forbidden" }));
    assert.ok(failed.includes("The base instructions could not be read: Forbidden"));
});

// Review SF-3: only the Workflow's owner (or an admin; session:manage, the decision the portal's Workflow read reports as
// personCommands.viewer) reads the whole base instructions. A reader it is shared with sees the summary row; opened, it
// says who can read the whole text, and nothing is read. The server refuses the file to that reader whatever the page does.
test("a reader who is not the Workflow's owner sees the summary row only; opening it reads nothing", () => {
    assert.equal(workflowBaseInstructionsReadable({ personCommands: { viewer: { allowed: true, reason: null } } }), true);
    assert.equal(workflowBaseInstructionsReadable({ personCommands: { viewer: { allowed: false, reason: "Only the session owner (Alice) can do this." } } }), false);
    assert.equal(workflowBaseInstructionsReadable({ personCommands: {} }), true, "no viewer decision (the terminal UI): the server decides");
    assert.equal(workflowBaseInstructionsReadable(null), true);
    const withBase = [...chat.slice(0, 2), base(2.1, "17:40:02"), ...chat.slice(2)];
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, withBase]]), runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log, nodeId: "talk", readInstructions: () => ({ ownerOnly: true }),
        onInstructions: null }));
    assert.match(html, /<details class="ps-wf-alog-base"><summary>48,210 characters: You are the GitHub Copilot CLI/);
    assert.ok(html.includes(WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY.replace("'", "&#x27;")) && html.includes("data-owner-only"));
    assert.equal(WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY, "Only this Workflow's owner can read the whole text.");
    assert.ok(!html.includes("Open to read the whole text.") && !html.includes("data-base-instructions="));
});

// Review SF-4: the text read from the file is shown only when its sha256 is the one the runtime recorded in the event
// (the whole digest); otherwise the row says the instructions changed since they were recorded, and shows nothing of them.
test("the page's SHA-256 is the standard one, for any text", () => {
    const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
    for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1_000), "Füße — 日本語 — 🙂\n".repeat(300)]) {
        assert.equal(sha256Hex(text), digest(text), `length ${text.length}`);
    }
});

test("a Base instructions row names its file only with a whole digest that names it; its text is shown only when it has that digest", () => {
    assert.equal(workflowBaseInstructions({ content: SUMMARY, baseInstructions: { ...KEPT, sha256: undefined } }).ref, null, "no whole digest");
    assert.equal(workflowBaseInstructions({ content: SUMMARY, baseInstructions: { ...KEPT, sha256: SHA.slice(0, 16) } }).ref, null);
    assert.equal(workflowBaseInstructions({ content: SUMMARY, baseInstructions: { ...KEPT, artifact: "base-instructions-fedcba9876543210.md" } }).ref, null,
        "a file the digest does not name");
    const whole = "You are the GitHub Copilot CLI, a terminal assistant built by GitHub.\n\nThe whole composed text.";
    const sha = sha256Hex(whole);
    const ref = { sessionId: "wf-1", artifact: `base-instructions-${sha.slice(0, 16)}.md`, sha256: sha };
    assert.equal(workflowBaseInstructionsMatch(ref, whole), true);
    assert.equal(workflowBaseInstructionsMatch(ref, `${whole} Changed.`), false);
    assert.equal(workflowBaseInstructionsMatch({ ...ref, sha256: null }, whole), false);
    assert.equal(workflowBaseInstructionsMatch(ref, null), false);
    const log = workflowAgentNodeLog({ node, events, chats: new Map([[CHAT, [...chat.slice(0, 2), base(2.1, "17:40:02"), ...chat.slice(2)]]]),
        runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log, nodeId: "talk", readInstructions: () => ({ changed: true }),
        onInstructions: () => {} }));
    assert.ok(html.includes("data-changed") && html.includes("These base instructions changed since they were recorded, so they are not shown."));
    assert.equal(WORKFLOW_BASE_INSTRUCTIONS_CHANGED, "These base instructions changed since they were recorded, so they are not shown.");
    assert.ok(!html.includes("data-base-instructions="));
});
