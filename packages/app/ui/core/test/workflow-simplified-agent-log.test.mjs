// An agent node's Log shows its session (owner feedback 2026-11-06, finding 8): one group per visit, newest first
// ("Visit 2 · 17:42:01"), each with its Prompt, Agent and Workflow rows in time order, told apart by label (and, in the
// portal, the colour of the row's edge). A session that continues across visits is cut at each visit's prompt. Tool calls are
// one line each, to expand; long text folds with Show more. The base instructions are not recorded, and the Log says so.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-agent-log.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    WORKFLOW_AGENT_LOG_FOLD, WORKFLOW_AGENT_LOG_NOTE, WORKFLOW_BASE_INSTRUCTIONS_CHANGED, WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY, workflowAgentLogSessions, workflowAgentLogOlder,
    workflowAgentNodeLog, workflowBaseInstructions, workflowBaseInstructionsMatch, workflowBaseInstructionsReadable, workflowLogFold, workflowPromptVisit,
} from "../src/workflow-agent-log.js";
import { sha256Hex } from "../src/sha256.js";
import { createHash } from "node:crypto";
import { WorkflowAgentLog } from "../../react/src/workflow-panels.js";

process.env.TZ = "UTC";
const NOW = Date.parse("2026-11-06T17:50:00.000Z");
const at = clock => `2026-11-06T${clock}.000Z`;
const AGENT_SESSION = "agent-continued";
const prompt = (seq, nx, clock, content) => ({ sessionId: AGENT_SESSION, seq, eventType: "user.message", createdAt: at(clock),
    data: { content, clientMessageIds: [`workflow:wf-1:run-1:agent:${nx}`], sender: { kind: "agent", display: "workflow node invocation" } } });
const chatEvent = (seq, eventType, clock, data) => ({ sessionId: AGENT_SESSION, seq, eventType, createdAt: at(clock), data });
const wfEvent = (seq, eventType, clock, data) => ({ sessionId: "wf-1", seq, eventType, createdAt: at(clock), data: { runId: "run-1", stateId: "talk", ...data } });

const node = {
    id: "talk", kind: "agent", type: "agent", runs: 2, outcomes: ["again", "finish"], next: { again: "pause", finish: "done" },
    executions: [
        { id: "nx-1", ordinal: 1, status: "completed", outcome: "again", resultKind: "business", enteredAt: at("17:40:01"), endedAt: at("17:40:09"),
            agent: { childSessionId: AGENT_SESSION, spawned: true } },
        { id: "nx-2", ordinal: 2, status: "pending", enteredAt: at("17:42:01"), deadline: at("17:43:01"), agent: { childSessionId: AGENT_SESSION, spawned: true } },
    ],
};
node.current = node.executions[1];
const LONG = `${"MVCC keeps old row versions. ".repeat(40)}End.`;
const agentSession = [
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
    wfEvent(21, "workflow.agent_spawned", "17:40:02", { nodeExecutionId: "nx-1", childSessionId: AGENT_SESSION, session: "continue", cycle: 1 }),
    wfEvent(22, "workflow.state_completed", "17:40:08", { nodeExecutionId: "nx-1", step: 1, outcome: "again" }),
    wfEvent(23, "workflow.agent_cycle_ended", "17:40:09", { nodeExecutionId: "nx-1", childSessionId: AGENT_SESSION, turnStopped: true }),
    wfEvent(24, "workflow.state_started", "17:42:01", { nodeExecutionId: "nx-2", step: 2 }),
    wfEvent(25, "workflow.state_started", "17:42:01", { runId: "run-other", nodeExecutionId: "nx-2", step: 2 }),
];

test("a prompt names its visit by its client message id; the sessions read are the shown visits' (a continued session once)", () => {
    assert.equal(workflowPromptVisit(agentSession[1]), "nx-1");
    assert.equal(workflowPromptVisit(agentSession[4]), null);
    assert.deepEqual(workflowAgentLogSessions(node), [AGENT_SESSION]);
    assert.deepEqual(workflowLogFold("short"), { text: "short" });
    const folded = workflowLogFold(LONG);
    assert.equal(folded.more, LONG);
    assert.ok(folded.text.length <= WORKFLOW_AGENT_LOG_FOLD + 1 && folded.text.endsWith("…"));
});

test("one group per visit, newest first; each visit's session rows and Workflow rows in time order, told apart", () => {
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, agentSession]]), runId: "run-1", now: NOW });
    assert.equal(log.note, WORKFLOW_AGENT_LOG_NOTE);
    assert.equal(log.loading, false);
    assert.deepEqual(log.groups.map(group => [group.header, group.status]), [
        ["Visit 2 · 17:42:01", "● running"],
        ["Visit 1 · 17:40:01", "✓ again · 8 s"],
    ]);
    const [second, first] = log.groups;
    assert.deepEqual(first.rows.map(row => [row.kind, row.label, row.text.split("\n")[0]]), [
        ["workflow", "Workflow", "● talk started"],
        ["prompt", "Prompt", "[SYSTEM: WORKFLOW NODE INVOCATION.]"],
        ["workflow", "Workflow", "Agent session started"],
        ["agent", "Tool", "read_facts — facts/%"],
        ["agent", "Agent", "PostgreSQL uses MVCC."],
        ["result", "Result", "again · {\"fact\":\"MVCC\"}"],
        ["workflow", "Workflow", "✓ talk · again"],
        ["workflow", "Workflow", "talk · visit ended · agent session kept for the next visit · turn stopped"],
    ]);
    const tool = first.rows.find(row => row.label === "Tool");
    assert.match(tool.detail, /^Arguments\n\{\n {2}"key_pattern": "facts\/%"\n\}\n\nResult\n\{\n {2}"count": 0\n\}$/);
    assert.deepEqual(first.rows.map(row => row.time), first.rows.map(row => row.time).slice().sort());
    // The second visit gets only its own part of the one session (cut at its prompt), and only its own run's lines.
    assert.deepEqual(second.rows.map(row => [row.kind, row.label]), [
        ["workflow", "Workflow"], ["prompt", "Prompt"], ["prompt", "Note to the agent"], ["agent", "Agent"],
    ]);
    const answer = second.rows.find(row => row.label === "Agent");
    assert.equal(answer.more, LONG, "a long answer folds");
    // Not read yet: the visit says so, and nothing is guessed.
    const unread = workflowAgentNodeLog({ node, events, agentSessions: new Map(), runId: "run-1", now: NOW });
    assert.equal(unread.loading, true);
    assert.ok(unread.groups.every(group => group.loading && group.rows.every(row => row.kind === "workflow")));
    // Older visits beyond the limit: "Show older visits".
    assert.equal(workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, agentSession]]), runId: "run-1", limit: 1, now: NOW }).more, true);
});

test("the portal draws each row with its label, folds long text and expands a tool call; the note says what is not recorded", () => {
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, agentSession]]), runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", onMore: () => {} }));
    assert.ok(html.includes("Prompt: what the agent got · Agent: what it did"));
    assert.ok(html.includes("Visit 2 · 17:42:01") && html.includes("Visit 1 · 17:40:01"));
    assert.ok(html.indexOf("Visit 2") < html.indexOf("Visit 1"), "newest visit first");
    for (const kind of ["prompt", "agent", "result", "workflow"]) assert.ok(html.includes(`data-kind="${kind}"`), kind);
    assert.match(html, /<details open=""><summary>read_facts — facts\/%<\/summary><pre>Arguments/);
    assert.ok(html.includes("Show more"));
    assert.ok(!html.includes(LONG), "the long answer is folded");
    const failed = renderToStaticMarkup(React.createElement(WorkflowAgentLog, {
        log: workflowAgentNodeLog({ node, events, agentSessions: new Map(), runId: "run-1", now: NOW }), failed: new Set([AGENT_SESSION]) }));
    assert.ok(failed.includes("Could not read the agent session."));
});

// The base instructions (finding 8, "show the base prompts"): the runtime records a summary of the SDK's echo of the
// composed system prompt; for a workflow agent session it also keeps the whole text once per distinct sha256 on the
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
    assert.equal(workflowBaseInstructions({ content: SUMMARY }).ref, null, "an older session kept only the summary");
    assert.equal(workflowBaseInstructions({ content: SUMMARY, baseInstructions: { ...KEPT, artifact: "../secret.md" } }).ref, null);
    assert.equal(workflowBaseInstructions({ content: "Workspace note." }), null);
    // The echo comes after the visit's prompt is recorded; the Log shows it first, once per visit.
    const withBase = [...agentSession.slice(0, 2), base(2.1, "17:40:02"), base(2.2, "17:40:05"), ...agentSession.slice(2)];
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, withBase]]), runId: "run-1", now: NOW });
    const first = log.groups[1].rows.filter(row => row.kind === "prompt");
    assert.deepEqual(first.map(row => row.label), ["Base instructions", "Prompt"]);
    assert.equal(first[0].text, "48,210 characters: You are the GitHub Copilot CLI, a terminal assistant built by GitHub. You are an interactive...");
    assert.deepEqual(first[0].instructions, { sessionId: "wf-1", artifact: "base-instructions-0123456789abcdef.md", sha256: SHA });
});

// Stage 2 review S2SF-F2: the runtime's summary is fixed words and the length only; the row says the length, and an
// earlier summary's snippet is still read.
test("S2SF-F2: a summary with no snippet is a Base instructions row that says its length only", () => {
    const plain = "[SYSTEM: Copilot SDK rebuilt the full system prompt for model input. Full content omitted from CMS (48210 chars).]";
    assert.deepEqual(workflowBaseInstructions({ content: plain, baseInstructions: KEPT }), { chars: 48210, snippet: null,
        ref: { sessionId: "wf-1", artifact: "base-instructions-0123456789abcdef.md", sha256: SHA } });
    const withBase = [...agentSession.slice(0, 2), chatEvent(2.1, "system.message", "17:40:02", { content: plain, baseInstructions: KEPT }), ...agentSession.slice(2)];
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, withBase]]), runId: "run-1", now: NOW });
    const row = log.groups[1].rows.find(item => item.label === "Base instructions");
    assert.equal(row.text, "48,210 characters");
    assert.deepEqual(row.instructions, { sessionId: "wf-1", artifact: "base-instructions-0123456789abcdef.md", sha256: SHA });
    // Without its file named, and the earlier snippet form, as before.
    assert.equal(workflowBaseInstructions({ content: plain }).ref, null);
    assert.equal(workflowBaseInstructions({ content: SUMMARY }).snippet, "You are the GitHub Copilot CLI, a terminal assistant built by GitHub. You are an interactive...");
});

test("the portal's Base instructions row reads the kept text when opened, and says plainly when only the summary was kept", () => {
    const withBase = [...agentSession.slice(0, 2), base(2.1, "17:40:02"), ...agentSession.slice(2), base(9.5, "17:42:02", null)];
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, withBase]]), runId: "run-1", now: NOW });
    const asked = [];
    const render = read => renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", readInstructions: read,
        onInstructions: ref => asked.push(ref) }));
    const closed = render(() => null);
    assert.match(closed, /<details class="ps-wf-alog-base" open=""><summary>48,210 characters: You are the GitHub Copilot CLI/);
    assert.ok(closed.includes("Open to read the whole text."));
    assert.ok(closed.includes("Only this summary was kept."), "the second visit's echo kept no text");
    const loading = render(() => ({ loading: true, text: null, error: null }));
    assert.ok(loading.includes("Reading…"));
    const whole = "You are the GitHub Copilot CLI, a terminal assistant built by GitHub.\n\nThe whole composed text.";
    const read = render(ref => (ref.artifact === KEPT.artifact ? { loading: false, text: whole, error: null } : null));
    assert.ok(read.includes(`data-base-instructions="${KEPT.artifact}"`) && read.includes("The whole composed text."));
    const failed = render(() => ({ loading: false, text: null, error: "Forbidden" }));
    assert.ok(failed.includes("Could not read them: Forbidden"));
});

// Review SF-3: only the Workflow's owner (or an admin; session:manage, the decision the portal's Workflow read reports as
// personCommands.viewer) reads the whole base instructions. A reader it is shared with sees the summary row; opened, it
// says who can read the whole text, and nothing is read. The server refuses the file to that reader whatever the page does.
test("a reader who is not the Workflow's owner sees the summary row only; opening it reads nothing", () => {
    assert.equal(workflowBaseInstructionsReadable({ personCommands: { viewer: { allowed: true, reason: null } } }), true);
    assert.equal(workflowBaseInstructionsReadable({ personCommands: { viewer: { allowed: false, reason: "Only the session owner (Alice) can do this." } } }), false);
    // Review SF-D4: the decision every portal Workflow read carries, whether or not commands are on; none is a no (fail closed).
    assert.equal(workflowBaseInstructionsReadable({ ownerOnlyArtifacts: { readable: true } }), true);
    assert.equal(workflowBaseInstructionsReadable({ ownerOnlyArtifacts: { readable: false }, personCommands: { viewer: { allowed: true } } }), false,
        "the owner-only decision wins over the command decision");
    assert.equal(workflowBaseInstructionsReadable({ personCommands: {} }), false, "no decision: the owner-only summary, no file asked for");
    assert.equal(workflowBaseInstructionsReadable({}), false);
    assert.equal(workflowBaseInstructionsReadable(null), false);
    const withBase = [...agentSession.slice(0, 2), base(2.1, "17:40:02"), ...agentSession.slice(2)];
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, withBase]]), runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", readInstructions: () => ({ ownerOnly: true }),
        onInstructions: null }));
    assert.match(html, /<details class="ps-wf-alog-base" open=""><summary>48,210 characters: You are the GitHub Copilot CLI/);
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
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, [...agentSession.slice(0, 2), base(2.1, "17:40:02"), ...agentSession.slice(2)]]]),
        runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", readInstructions: () => ({ changed: true }),
        onInstructions: () => {} }));
    assert.ok(html.includes("data-changed") && html.includes("These base instructions changed since they were recorded, so they are not shown."));
    assert.equal(WORKFLOW_BASE_INSTRUCTIONS_CHANGED, "These base instructions changed since they were recorded, so they are not shown.");
    assert.ok(!html.includes("data-base-instructions="));
});

// Review UI-10: the Log knows what of each session is loaded. A visit whose session start (its prompt) is on an older page,
// while older session events exist, is not shown as complete: it says so and offers Load older (that session's next older
// page); its loaded answer is kept, never dropped for want of its prompt. Older visits the run's loaded history lacks
// offer Load older visits. A continued session's later visit carries the base instructions an earlier visit had.
test("UI-10: a visit whose session start is on an older page keeps its loaded events, says so and offers Load older", () => {
    // The loaded window starts after visit 1's prompt (seq 2): its tool call and answer, then visit 2's prompt.
    const window = agentSession.slice(2);
    const coverage = new Map([[AGENT_SESSION, { hasOlder: true }]]);
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, window]]), coverage, runId: "run-1", now: NOW });
    const [second, first] = log.groups;
    assert.equal(first.truncated, true);
    assert.ok(first.rows.some(row => row.label === "Agent" && row.text === "PostgreSQL uses MVCC."), "the loaded answer is kept");
    assert.equal(second.truncated, false, "visit 2's prompt is loaded");
    const asked = [];
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", onOlderAgentHistory: id => asked.push(id) }));
    assert.equal((html.match(/data-truncated=""/g) || []).length, 1);
    assert.ok(html.includes("This visit&#x27;s start is not loaded.") && html.includes('data-action="older-agent-history"'), html);
    // The whole session loaded (no older events): nothing is said.
    const whole = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, agentSession]]), coverage: new Map([[AGENT_SESSION, { hasOlder: false }]]), runId: "run-1", now: NOW });
    assert.ok(whole.groups.every(group => !group.truncated));
});

// Review UI-D5: a continued session's loaded window with no prompt in it (visit 1's tool call and answer, while visit 2's prompt
// is not recorded yet) is never given to the newest visit: its lines are shown apart until a prompt is loaded.
test("UI-D5: a prompt-free window of a continued session is shown apart, never under the newest visit; a loaded prompt places it", () => {
    const continued = { ...node, session: "continue" };
    const window = agentSession.slice(2, 7); // visit 1's tool call, answer and completion call; no prompt
    const coverage = new Map([[AGENT_SESSION, { hasOlder: true }]]);
    const log = workflowAgentNodeLog({ node: continued, events, agentSessions: new Map([[AGENT_SESSION, window]]), coverage, runId: "run-1", now: NOW });
    const [second, first] = log.groups;
    const sessionRowsOf = group => group.rows.filter(row => row.key.startsWith("session:"));
    assert.deepEqual(sessionRowsOf(second), [], "nothing of visit 1 under visit 2");
    assert.deepEqual(sessionRowsOf(first), [], "nor guessed for visit 1");
    assert.equal(log.earlier.length, 1);
    const [part] = log.earlier;
    assert.equal(part.agentSessionId, AGENT_SESSION);
    assert.equal(part.header, "Earlier in this agent session · run not loaded");
    assert.equal(part.hasOlder, true);
    assert.deepEqual(part.rows.map(row => row.label), ["Tool", "Agent", "Result"]);
    const asked = [];
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", onOlderAgentHistory: id => asked.push(id) }));
    assert.ok(html.includes("data-earlier=\"\"") && html.includes("Earlier in this agent session · run not loaded"), html);
    assert.ok(html.indexOf("Run 1") < html.indexOf("Earlier in this agent session"), "after the visits, oldest last");
    // Load older reaches visit 1's prompt: the lines are visit 1's, in place; nothing is shown apart.
    const placed = workflowAgentNodeLog({ node: continued, events, agentSessions: new Map([[AGENT_SESSION, agentSession.slice(1, 7)]]), coverage, runId: "run-1", now: NOW });
    assert.deepEqual(placed.earlier, []);
    assert.deepEqual(sessionRowsOf(placed.groups[1]).map(row => row.label), ["Prompt", "Tool", "Agent", "Result"]);
    assert.deepEqual(sessionRowsOf(placed.groups[0]), []);
    // A window that starts after visit 1's prompt and holds visit 2's: the lines before it are visit 1's (UI-10), as before.
    const bounded = workflowAgentNodeLog({ node: continued, events, agentSessions: new Map([[AGENT_SESSION, agentSession.slice(2)]]), coverage, runId: "run-1", now: NOW });
    assert.deepEqual(bounded.earlier, []);
    assert.ok(sessionRowsOf(bounded.groups[1]).some(row => row.text === "PostgreSQL uses MVCC."));
    // A session that serves one visit (a new session each visit) needs no prompt to place its lines.
    const fresh = { ...node, executions: [{ ...node.executions[0], agent: { childSessionId: "agent-new" } }], current: null };
    const own = window.map(item => ({ ...item, sessionId: "agent-new" }));
    const single = workflowAgentNodeLog({ node: fresh, events, agentSessions: new Map([["agent-new", own]]), coverage: new Map([["agent-new", { hasOlder: true }]]),
        runId: "run-1", now: NOW });
    assert.deepEqual(single.earlier, []);
    assert.deepEqual(sessionRowsOf(single.groups[0]).map(row => row.label), ["Tool", "Agent", "Result"]);
});

// Review UI-D6: a failed older-page read is said, with Retry; at the history window's limit the Log says so plainly and
// offers no Load older that cannot make progress.
test("UI-D6: an older-page read failure shows with Retry; at the 3,000-event limit the Log says so and offers no Load older", () => {
    assert.equal(workflowAgentLogOlder({ hasOlder: false, cap: 3000, error: "x" }), null, "nothing older: nothing said");
    assert.deepEqual(workflowAgentLogOlder({ hasOlder: true }), { action: "load", text: null });
    assert.deepEqual(workflowAgentLogOlder({ hasOlder: true, error: "HTTP 503 Service Unavailable" }),
        { action: "retry", text: "Older lines could not be read: HTTP 503 Service Unavailable" });
    assert.deepEqual(workflowAgentLogOlder({ hasOlder: true, cap: 3000, error: "HTTP 503" }),
        { action: null, text: "Older lines not shown: the Log reads the newest 3,000 events of an agent session." });
    const window = agentSession.slice(2);
    const render = entry => {
        const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, window]]), coverage: new Map([[AGENT_SESSION, entry]]), runId: "run-1", now: NOW });
        return renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", onOlderAgentHistory: () => {} }));
    };
    const failed = render({ hasOlder: true, error: "HTTP 503 Service Unavailable" });
    assert.ok(failed.includes("Older lines could not be read: HTTP 503 Service Unavailable") && failed.includes('data-older="failed"'), failed);
    assert.ok(/data-action="older-agent-history"[^>]*>Retry</.test(failed), failed);
    const capped = render({ hasOlder: true, cap: 3000 });
    assert.ok(capped.includes("Older lines not shown: the Log reads the newest 3,000 events of an agent session."), capped);
    assert.ok(!capped.includes('data-action="older-agent-history"'), "no Load older at the limit");
    const open = render({ hasOlder: true });
    assert.ok(/data-action="older-agent-history"[^>]*>Load older</.test(open) && !open.includes("data-older="), open);
    // The same for lines shown apart (UI-D5).
    const apart = workflowAgentNodeLog({ node: { ...node, session: "continue" }, events, agentSessions: new Map([[AGENT_SESSION, agentSession.slice(2, 7)]]),
        coverage: new Map([[AGENT_SESSION, { hasOlder: true, cap: 3000 }]]), runId: "run-1", now: NOW });
    assert.equal(apart.earlier[0].older.action, null);
});

// Review UI-F3: a visit between two others that never got its prompt (it timed out before its send; its invocation still
// names the session, unspawned) is no evidence: the lines before the next loaded prompt are not given to it.
test("UI-F3: lines before a later prompt are not given to an intervening visit that never got its prompt", () => {
    const three = { ...node, session: "continue", runs: 3, executions: [
        { ...node.executions[0] },
        { id: "nx-2", ordinal: 2, status: "completed", outcome: "timed_out", resultKind: "runtime_error", enteredAt: at("17:42:01"), endedAt: at("17:43:01"),
            agent: { childSessionId: AGENT_SESSION, spawned: false } },
        { id: "nx-3", ordinal: 3, status: "pending", enteredAt: at("17:44:01"), agent: { childSessionId: AGENT_SESSION, spawned: true } },
    ] };
    three.current = three.executions[2];
    const visit3Prompt = prompt(11, "nx-3", "17:44:02", "[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 3.]\n{}");
    const coverage = new Map([[AGENT_SESSION, { hasOlder: true }]]);
    const sessionRowsOf = group => group.rows.filter(row => row.key.startsWith("session:"));
    // Visit 1's tail (tool, answer, completion) then visit 3's prompt; visit 1's prompt is on an older page.
    const tail = workflowAgentNodeLog({ node: three, events, agentSessions: new Map([[AGENT_SESSION, [...agentSession.slice(2, 7), visit3Prompt]]]), coverage, runId: "run-1", now: NOW });
    const [third, second, first] = tail.groups;
    assert.deepEqual(sessionRowsOf(second), [], "nothing for visit 2, which never got its prompt");
    assert.deepEqual(sessionRowsOf(first), [], "nor guessed for visit 1");
    assert.deepEqual(tail.earlier[0].rows.map(row => row.label), ["Tool", "Agent", "Result"]);
    assert.deepEqual(sessionRowsOf(third).map(row => row.label), ["Prompt"]);
    // Visit 1's prompt loaded: the lines are visit 1's, never visit 2's.
    const whole = workflowAgentNodeLog({ node: three, events, agentSessions: new Map([[AGENT_SESSION, [...agentSession.slice(1, 7), visit3Prompt]]]), coverage, runId: "run-1", now: NOW });
    assert.deepEqual(whole.earlier, []);
    assert.deepEqual(sessionRowsOf(whole.groups[2]).map(row => row.label), ["Prompt", "Tool", "Agent", "Result"]);
    assert.deepEqual(sessionRowsOf(whole.groups[1]), []);
    // The visit before the loaded prompt got its own prompt (spawned): the lines are its, as before (UI-10).
    const spawned = { ...three, executions: three.executions.map(item => item.id === "nx-2" ? { ...item, agent: { ...item.agent, spawned: true } } : item) };
    spawned.current = spawned.executions[2];
    const bounded = workflowAgentNodeLog({ node: spawned, events, agentSessions: new Map([[AGENT_SESSION, [...agentSession.slice(2, 7), visit3Prompt]]]), coverage, runId: "run-1", now: NOW });
    assert.deepEqual(bounded.earlier, []);
    assert.deepEqual(sessionRowsOf(bounded.groups[1]).map(row => row.label), ["Tool", "Agent", "Result"]);
});

test("UI-10: older visits not in the run's loaded history offer Load older visits", () => {
    const partial = { ...node, partial: true };
    const log = workflowAgentNodeLog({ node: partial, events, agentSessions: new Map([[AGENT_SESSION, agentSession]]), runId: "run-1", now: NOW });
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk", onOlderVisits: () => {} }));
    assert.ok(html.includes("Older visits not loaded.") && html.includes('data-action="older-executions"'), html);
});

test("UI-10: a continued session's later visit carries the base instructions an earlier visit had, without their text", () => {
    const withBase = [...agentSession.slice(0, 2), chatEvent(2.1, "system.message", "17:40:02", { content: SUMMARY, baseInstructions: KEPT }), ...agentSession.slice(2)];
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, withBase]]), runId: "run-1", now: NOW });
    const [second, first] = log.groups;
    assert.equal(first.rows.filter(row => row.label === "Base instructions").length, 1);
    const carried = second.rows.find(row => row.label === "Base instructions");
    assert.deepEqual({ text: carried.text, from: carried.carriedFrom, ref: carried.instructions }, { text: "Same as visit 1 · same agent session", from: 1, ref: null });
    assert.ok(second.rows.indexOf(carried) < second.rows.findIndex(row => row.label === "Prompt"), "before the visit's prompt");
    const html = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { openBodies: true, log, nodeId: "talk" }));
    assert.ok(html.includes('data-carried-from="1"') && html.includes("Same as visit 1 · same agent session"));
});

// Review UI-D9: every Base instructions row of a visit counts, in order. Visit 1 records body A, then a changed body B;
// visit 2 continues without a new echo; visit 3 echoes A and B again. Visit 2 carries B (the last), each body is shown in
// full once, and a reference names which of visit 1's instructions it means.
test("UI-D9: the carried instructions are the visit's last; each distinct body is shown in full once; references name which body", () => {
    const SHA_B = "fedcba9876543210".repeat(4);
    const KEPT_B = { ...KEPT, artifact: "base-instructions-fedcba9876543210.md", sha256: SHA_B, chars: 50000 };
    const three = { ...node, session: "continue", runs: 3, executions: [...node.executions.map(item => ({ ...item, status: "completed" })),
        { id: "nx-3", ordinal: 3, status: "pending", enteredAt: at("17:44:01"), agent: { childSessionId: AGENT_SESSION } }] };
    three.current = three.executions[2];
    const log3 = [
        ...agentSession.slice(0, 2), base(2.1, "17:40:02"), chatEvent(2.2, "assistant.message", "17:40:02", { content: "Thinking." }),
        base(2.3, "17:40:03", KEPT_B), ...agentSession.slice(2),
        prompt(11, "nx-3", "17:44:02", "[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 3.]\n{}"), base(12, "17:44:03"), base(13, "17:44:04", KEPT_B),
    ];
    const log = workflowAgentNodeLog({ node: three, events, agentSessions: new Map([[AGENT_SESSION, log3]]), runId: "run-1", now: NOW });
    const [third, second, first] = log.groups;
    const bases = group => group.rows.filter(row => row.label === "Base instructions");
    assert.deepEqual(bases(first).map(row => row.instructions?.sha256), [SHA, SHA_B], "visit 1 shows both in full, in order");
    assert.deepEqual(bases(second).map(row => [row.text, row.carriedFrom, row.carriedNumber, row.instructions]),
        [["Same as visit 1 · instructions 2/2 · same agent session", 1, 2, null]], "visit 2 carries B, the last");
    assert.deepEqual(bases(third).map(row => [row.text, row.carriedFrom, row.carriedNumber, row.instructions]), [
        ["Same as visit 1 · instructions 1/2", 1, 1, null],
        ["Same as visit 1 · instructions 2/2", 1, 2, null],
    ], "visit 3 repeats neither in full");
    const full = log.groups.flatMap(bases).filter(row => row.instructions);
    assert.deepEqual(full.map(row => row.instructions.sha256), [SHA, SHA_B], "each distinct body once");
});

// Review UI-F5: A, then B, then A again in one visit (with a same-digest echo of A, no change) and a next visit with no echo:
// the next visit carries A, the last; A and B are each shown in full once; the echo adds no row.
test("UI-F5: A/B/A carries A; each body is shown in full once; an unchanged echo adds no row", () => {
    const SHA_B = "fedcba9876543210".repeat(4);
    const KEPT_B = { ...KEPT, artifact: "base-instructions-fedcba9876543210.md", sha256: SHA_B, chars: 50000 };
    const continued = { ...node, session: "continue" };
    const log = [
        ...agentSession.slice(0, 2), base(2.1, "17:40:02"), base(2.15, "17:40:02"),                  // A, then an echo of A
        base(2.2, "17:40:02", KEPT_B), base(2.3, "17:40:03"),                               // B, then A again
        ...agentSession.slice(2),
    ];
    const result = workflowAgentNodeLog({ node: continued, events, agentSessions: new Map([[AGENT_SESSION, log]]), runId: "run-1", now: NOW });
    const [second, first] = result.groups;
    const bases = group => group.rows.filter(row => row.label === "Base instructions");
    assert.deepEqual(bases(first).map(row => [row.instructions?.sha256 ?? null, row.carriedFrom ?? null, row.carriedNumber ?? null]),
        [[SHA, null, null], [SHA_B, null, null], [null, 1, 1]], "A in full, B in full, A again as a reference; the echo adds none");
    assert.deepEqual(bases(second).map(row => [row.text, row.carriedNumber]),
        [["Same as visit 1 · instructions 1/2 · same agent session", 1]], "the next visit carries A, the last");
    const full = result.groups.flatMap(bases).filter(row => row.instructions);
    assert.deepEqual(full.map(row => row.instructions.sha256), [SHA, SHA_B]);
});

// Review UI-11: a closed tool call or Base instructions row keeps its body out of the page; the same base instructions
// (by digest) are shown once, at the oldest visit that has them.
test("UI-11: closed bodies are not mounted; the same base instructions show once", () => {
    const withBase = [...agentSession.slice(0, 2), chatEvent(2.1, "system.message", "17:40:02", { content: SUMMARY, baseInstructions: KEPT }), ...agentSession.slice(2)];
    const log = workflowAgentNodeLog({ node, events, agentSessions: new Map([[AGENT_SESSION, withBase]]), runId: "run-1", now: NOW });
    const closed = renderToStaticMarkup(React.createElement(WorkflowAgentLog, { log, nodeId: "talk", readInstructions: () => ({ loading: false,
        text: "The whole composed text.", error: null }) }));
    assert.ok(closed.includes("<summary>read_facts"), closed);
    assert.ok(!closed.includes("Arguments\n") && !closed.includes("<pre>"), "no body of a closed row");
    assert.ok(!closed.includes("The whole composed text."));
    // Two sessions (session: new), the same instructions: the newer visit says which visit shows them.
    const other = "agent-new-2";
    const twoSessions = { ...node, executions: [node.executions[0], { ...node.executions[1], agent: { childSessionId: other } }] };
    const otherSession = [{ ...prompt(1, "nx-2", "17:42:02", "Tell one fact."), sessionId: other },
        { ...chatEvent(2, "system.message", "17:42:03", { content: SUMMARY, baseInstructions: KEPT }), sessionId: other }];
    const shared = workflowAgentNodeLog({ node: twoSessions, events, agentSessions: new Map([[AGENT_SESSION, withBase], [other, otherSession]]), runId: "run-1", now: NOW });
    const [second, first] = shared.groups;
    assert.ok(first.rows.find(row => row.label === "Base instructions").instructions, "the oldest visit shows them");
    const later = second.rows.find(row => row.label === "Base instructions");
    assert.deepEqual({ text: later.text, from: later.carriedFrom, ref: later.instructions }, { text: "Same as visit 1", from: 1, ref: null });
});
