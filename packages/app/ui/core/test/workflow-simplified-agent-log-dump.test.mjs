// r4 C04, confirmed on live data: the executor's dump of a chat: continue agent node on wfsimp (portal 5482bae3, worker
// fd0fcda8; artifact agent-log-live-dump-20261106.tgz, sha256 db5eec92…). The fixture is that dump's 98 agent chat events
// and 16 Workflow events as the API returned them; heavy model.* data and the SDK echo's 55,151-character text are left
// out (the test rebuilds an echo of that length). What it shows:
// - each visit's prompt is a system.message with its client message id and sender (no user.message at all);
// - each turn's SDK echo of its system prompt is recorded whole, as a system.message { content, interactionId, role:
//   "system" } with no sender (session-proxy did not summarize it), so the Log showed it as "Note to the agent";
// - session.turn_stopped carries the visit's client message id too, and is not a prompt.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-agent-log-dump.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workflowAgentNodeLog, workflowBaseInstructions, workflowPromptVisit, WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY } from "../src/workflow-agent-log.js";
import { WorkflowV2AgentLog } from "../../react/src/workflow-v2-panels.js";

process.env.TZ = "UTC";
const dump = JSON.parse(readFileSync(new URL("./fixtures/agent-log-live-dump-20261106.json", import.meta.url), "utf8"));
const IDENTITY = "You are GitHub Copilot, an AI coding agent built by GitHub. You are an interactive tool that helps users with ";
const ECHO = `${IDENTITY}${"software engineering tasks. ".repeat(4000)}`.slice(0, 55151);
const chat = dump.chatEvents.map(event => event.data?.content === "<<SDK_ECHO 55151>>" ? { ...event, data: { ...event.data, content: ECHO } } : event);
const bySeq = new Map(chat.map(event => [event.seq, event]));
const CHAT = chat[0].sessionId;
const [first, second] = dump.factExecutions.slice().sort((a, b) => a.ordinal - b.ordinal);
const node = {
    id: "fact", kind: "agent", type: "agent", chat: "continue", runs: 2,
    executions: dump.factExecutions.map(item => ({ id: item.nodeExecutionId, ordinal: item.ordinal, status: item.state, outcome: item.outcome,
        resultKind: item.resultKind, enteredAt: item.enteredAt, endedAt: item.endedAt, deadline: item.deadline, agent: item.agent })),
};
node.current = node.executions.find(item => item.ordinal === 2);
const NOW = Date.parse("2026-11-06T17:10:00.000Z");
const log = (readable = true, coverage = new Map([[CHAT, { hasOlder: false }]])) => workflowAgentNodeLog({ node, events: dump.workflowEvents,
    chats: new Map([[CHAT, chat]]), coverage, runId: dump.runId, now: NOW });
const chatRows = group => group.rows.filter(row => row.key.startsWith("chat:"));

test("the dump's shapes: both prompts are system.message with the visit's id; the echo and turn_stopped are not prompts", () => {
    assert.equal(chat.filter(event => event.eventType === "user.message").length, 0);
    assert.equal(workflowPromptVisit(bySeq.get(16305)), first.nodeExecutionId);
    assert.equal(workflowPromptVisit(bySeq.get(16371)), second.nodeExecutionId);
    for (const seq of [16316, 16380, 16366, 16420]) assert.equal(workflowPromptVisit(bySeq.get(seq)), null, String(seq));
    const echo = workflowBaseInstructions(bySeq.get(16316).data);
    assert.equal(echo.chars, 55151);
    assert.equal(echo.ref, null);
    assert.match(echo.inline.sha256, /^[0-9a-f]{64}$/);
    assert.ok(echo.snippet.startsWith("You are GitHub Copilot, an AI coding agent built by GitHub.") && echo.snippet.endsWith("..."));
    assert.equal(workflowBaseInstructions(bySeq.get(16305).data), null, "a prompt is not base instructions");
    assert.equal(workflowBaseInstructions({ content: "A note from the runtime." }), null, "a note without role and interaction is not either");
});

test("the Log of the dump: each visit has its base instructions (shown once), its Prompt and its typed result; nothing 'Earlier'", () => {
    const shown = log();
    assert.deepEqual(shown.earlier, []);
    const [visit2, visit1] = shown.groups;
    assert.deepEqual(chatRows(visit1).map(row => row.label), ["Base instructions", "Prompt", "Typed result"]);
    assert.deepEqual(chatRows(visit2).map(row => row.label), ["Base instructions", "Prompt", "Typed result"]);
    assert.equal(chatRows(visit1)[0].text.split(":")[0], "55,151 characters");
    assert.equal(chatRows(visit2)[0].text, "The same as visit 1.");
    assert.ok(chatRows(visit1)[1].text.startsWith("[SYSTEM: WORKFLOW NODE INVOCATION. You are an ordinary agent session"));
    assert.ok(chatRows(visit2)[1].text.startsWith("[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2."));
    assert.match(chatRows(visit1)[2].text, /^success · \{"fact":"PostgreSQL uses multiversion concurrency control/);
    assert.ok(!shown.groups.some(group => group.rows.some(row => row.label === "Note to the agent")), "no echo or prompt reads as a note");
    // Its Workflow lines, in the Log's words.
    assert.ok(visit1.rows.some(row => row.kind === "workflow" && /^Agent chat started; time limit 17:04:40/.test(row.text)));
    assert.ok(visit2.rows.some(row => row.kind === "workflow" && /^Visit 2 given to the same agent chat; time limit /.test(row.text)));
    // Without coverage the answer is the same: the window starts at visit 1's prompt.
    assert.deepEqual(log(true, new Map()).earlier, []);
});

test("an echo recorded whole opens to its text for the owner, and to the owner-only line for anyone else; nothing is read", () => {
    const shown = log();
    const reads = [];
    const owner = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log: shown, nodeId: "fact", openBodies: true,
        readInstructions: ref => (ref?.sessionId ? { loading: true } : null), onInstructions: ref => reads.push(ref) }));
    assert.equal((owner.match(/data-base-instructions="inline"/g) || []).length, 1, "shown once");
    assert.ok(owner.includes(IDENTITY.trim()));
    assert.deepEqual(reads, []);
    const share = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log: shown, nodeId: "fact", openBodies: true,
        readInstructions: () => ({ ownerOnly: true }) }));
    assert.ok(!share.includes("data-base-instructions=") && !share.includes("software engineering tasks. software"));
    assert.ok(share.includes(`data-owner-only="">${WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY.replace("'", "&#x27;")}`), share.slice(0, 400));
});
