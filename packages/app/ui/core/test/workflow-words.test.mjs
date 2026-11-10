/**
 * Owner, 2026-11-07T17:47Z (OF-S2-2): "Make the node graphics less verbose … simple numbers / icons … super crisp (and
 * consistent)". The Workflow words: a state as one mark, a visit count as a badge, a node card's one key fact by type,
 * the shortest failure reason, a contract without its version, a short local time; and the cards and edges built with
 * them. The mounted cases are the browser specs "OF-S2-2".
 *
 * Run: node --test ui/core/test/workflow-words.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    WORKFLOW_NODE_STATE_WORDS, WORKFLOW_RUN_STATE_WORDS, WORKFLOW_STATE_MARKS, workflowAskAnswerWords, workflowContractName, workflowDuration, workflowErrorRouteWords,
    workflowFailureDetail, workflowFailureReason, workflowItemsFraction, workflowNodeCardWords, workflowOutcomeWord, workflowRunsText,
    workflowShortTime, workflowStateMark, workflowTime, workflowTimeTitle, workflowVisitBadge,
} from "../src/workflow-words.js";
import { workflowElapsedText } from "../src/workflow-owner.js";
import {
    formatSeconds, projectWorkflowV2,
} from "../src/workflow-v2-view.js";
import { layoutWorkflowGraphTB, WORKFLOW_ERROR_EDGE_LABEL } from "../src/workflow-graph-layout.js";
import { WorkflowEdgeShape, WorkflowStepCard } from "../../react/src/workflow-graph.js";
import { listedState } from "../../react/src/workflow-chat-tab.js";
import { done, readModel, row } from "./workflow-v2-fixtures.mjs";

process.env.TZ = "UTC";

test("a state is one mark: ✓ done, ● running or waiting (also paused), ✕ failed, ⊘ canceled; none when not reached", () => {
    assert.deepEqual(Object.fromEntries(Object.entries(WORKFLOW_STATE_MARKS).map(([key, mark]) => [key, mark.glyph])),
        { done: "✓", running: "●", failed: "✕", cancelled: "⊘" });
    assert.equal(workflowStateMark("done").glyph, "✓");
    assert.equal(workflowStateMark("running").glyph, "●");
    assert.equal(workflowStateMark("idle", "paused").glyph, "●");
    assert.equal(workflowStateMark("idle", "not-reached"), null);
    assert.equal(workflowStateMark("cancelled").word, "canceled");
});

test("a visit count is a badge with its words: ↻ N, N+ when older visits are not loaded; none under 2", () => {
    // Review 19:10Z: the tooltip may use the verb ("Ran 126 times"); a node's execution is a visit.
    assert.deepEqual(workflowVisitBadge(126, false), { text: "↻ 126", title: "Ran 126 times" });
    assert.deepEqual(workflowVisitBadge(126, true), { text: "↻ 126+", title: "Ran 126 times · older visits not loaded" });
    assert.equal(workflowVisitBadge(1, true), null);
    assert.equal(workflowVisitBadge(undefined), null);
});

test("short facts: a contract without its version, the shortest failure reason, k/n ok, a local clock", () => {
    assert.equal(workflowContractName("DadJoke@1"), "DadJoke");
    assert.equal(workflowContractName("Alert"), "Alert");
    assert.equal(workflowFailureReason("timed_out"), "limit");
    assert.equal(workflowFailureReason("execution_failed"), "error");
    assert.equal(workflowFailureReason("invalid_input"), "invalid input");
    assert.equal(workflowItemsFraction(4, 5), "4/5 ok");
    assert.equal(workflowItemsFraction(1, 0), null);
    const now = Date.parse("2026-11-07T08:30:00Z");
    assert.equal(workflowShortTime("2026-11-07T08:31:05Z", now), "08:31:05");
    assert.equal(workflowShortTime("2026-11-06T08:31:05Z", now), "2026-11-06 08:31:05");
    assert.equal(workflowShortTime("nope", now), null);
});

test("a card's key fact by node type; done with none says the outcome taken; failed says the reason", () => {
    const card = input => workflowNodeCardWords({ runs: 1, partial: false, ...input });
    const text = words => [words.mark?.glyph, words.fact].filter(Boolean).join(" ");
    assert.equal(text(card({ kind: "wait", state: "done", phase: "done", seconds: 30, secondsText: "30 s" })), "✓ 30 s");
    const waiting = card({ kind: "wait", state: "running", phase: "waiting", seconds: 30, secondsText: "30 s", deadline: new Date(Date.now() + 60_000).toISOString() });
    assert.match(text(waiting), /^● 30 s · until \d\d:\d\d:\d\d$/);
    assert.match(text(card({ kind: "wait", state: "running", phase: "waiting", clock: "until 09:00", deadline: new Date(Date.now() + 60_000).toISOString() })),
        /^● until \d\d:\d\d:\d\d$/);
    assert.equal(text(card({ kind: "send", state: "done", phase: "done", outcome: "sent", contract: "DadJoke@1" })), "✓ DadJoke");
    assert.equal(text(card({ kind: "receive", state: "idle", phase: "not-reached", contract: "Ack@1" })), "Ack");
    // OF-S2-3a: an agent node's card has its mark alone; a failure keeps its shortest reason.
    assert.equal(text(card({ kind: "agent", state: "done", phase: "done", outcome: "generated" })), "✓");
    assert.equal(text(card({ kind: "agent", state: "done", phase: "done", outcome: "ok", agentName: "code-reviewer" })), "✓");
    assert.equal(text(card({ kind: "agent", state: "running", phase: "waiting" })), "●");
    assert.equal(text(card({ kind: "agent", state: "idle", phase: "paused" })), "●");
    assert.equal(text(card({ kind: "agent", state: "cancelled", phase: "done" })), "⊘");
    assert.equal(text(card({ kind: "agent", state: "failed", phase: "error", outcome: "timed_out" })), "✕ limit");
    assert.equal(text(card({ kind: "agent", state: "failed", phase: "error", outcome: "execution_failed" })), "✕ error");
    assert.equal(card({ kind: "agent", state: "idle", phase: "not-reached", agentName: "code-reviewer" }).row2, false, "not reached: no row 2");
    // In a For each its items still count, as every node's do (W5).
    assert.equal(text(card({ kind: "agent", state: "failed", phase: "error", items: { ok: 2, total: 3 } })), "✕ 2/3 ok");
    assert.equal(text(card({ kind: "script", state: "running", phase: "running" })), "● running");
    assert.equal(text(card({ kind: "script", state: "cancelled", phase: "done" })), "⊘ canceled");
    assert.equal(text(card({ kind: "parallel", state: "failed", phase: "error", items: { ok: 4, total: 5 } })), "✕ 4/5 ok");
    assert.equal(text(card({ kind: "terminal", state: "done", phase: "done", terminalOutcome: "succeeded" })), "✓ succeeded");
    // A node not reached with no key fact has no second row.
    assert.equal(card({ kind: "script", state: "idle", phase: "not-reached" }).row2, false);
    // The badge: under 2 none; partial "+".
    assert.equal(card({ kind: "script", state: "done", phase: "done", runs: 126, partial: true }).badge.text, "↻ 126+");
});

const DAD = { revision: 1, initial: "generate_joke", states: [
    { id: "generate_joke", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 120, outcomes: ["generated"],
        next: { generated: "send_joke", execution_failed: "done", timed_out: "done" } },
    { id: "send_joke", type: "messaging", mode: "send", contract: "DadJoke@1", recipient: "parent", outcomes: ["sent"], next: { sent: "pause" } },
    { id: "pause", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "generate_joke" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
] };

test("the cards: two rows, no type word, no 'Done by its agent', 'in the loaded history' or 'queued at recipient'; the words are the title", () => {
    const rows = [];
    for (let n = 1; n <= 3; n += 1) {
        rows.push(done("generate_joke", n, "generated", { enteredAt: `2026-11-07T08:0${n}:00Z`, endedAt: `2026-11-07T08:0${n}:05Z` }));
        rows.push(done("send_joke", n, "sent", { enteredAt: `2026-11-07T08:0${n}:05Z`, endedAt: `2026-11-07T08:0${n}:06Z` }));
    }
    rows.push(done("pause", 1, "elapsed"), done("pause", 2, "elapsed"), row("pause", 3, "pending", { deadline: "2026-11-07T08:31:05Z" }));
    const projection = projectWorkflowV2({ readModel: readModel({ graph: DAD, nodeExecutions: rows,
        outbox: rows.filter(item => item.stateId === "send_joke").map((item, index) => ({ exchangeId: `ex-${index}`, nodeExecutionId: item.nodeExecutionId,
            state: "delivered", attempts: 1, recipientSessionId: "parent-1", recipientKind: "parent", contract: "DadJoke@1", deliveredAt: item.endedAt })) }) });
    const html = Object.fromEntries(projection.nodes.map(node => [node.id, renderToStaticMarkup(React.createElement(WorkflowStepCard, { node, onSelect() {} }))]));
    // What the card shows (the Start marker over the first node is a mark of its own, not a row).
    const shown = markup => markup.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<span class="ps-workflow-node-start"[^>]*><span>Start<\/span><\/span>/, "").replace(/ (title|aria-label)="[^"]*"/g, "").replace(/<[^>]+>/g, "|").split("|").filter(Boolean);
    // OF-S2-3a: an agent node's card says no fact; its outcome ("generated") is on its edge and in its title.
    assert.deepEqual(shown(html.generate_joke), ["generate_joke", "↻ 3", "✓"]);
    assert.deepEqual(shown(html.send_joke), ["send_joke", "↻ 3", "✓", "DadJoke"]);
    // A clock on the day it is; the date too on another day.
    assert.deepEqual(shown(html.pause).slice(0, 3), ["pause", "↻ 3", "●"]);
    assert.match(shown(html.pause)[3], /^30 s · until (2026-11-07 )?08:31:05$/);
    for (const markup of Object.values(html)) {
        const visible = shown(markup).join(" ");
        for (const gone of ["Done by its agent", "loaded history", "queued at recipient", "Agent", "Send ·", "Wait ·"]) {
            assert.ok(!visible.includes(gone), `${gone}: ${visible}`);
        }
    }
    // The full words stay in the title (the tooltip, and the description screen readers read): the type and the state.
    assert.match(html.send_joke, /title="send_joke · Send · DadJoke@1 · Done · sent, queued at recipient · Ran 3 times"/);
    // OF-S2-7: an agent node's title ends with the model it uses (its chat's, not loaded here).
    assert.match(html.generate_joke, /title="generate_joke · Agent · Done · generated · Ran 3 times · Model: from the chat"/);
    assert.match(html.generate_joke, /aria-label="Inspect generate_joke"/);
    assert.match(html.pause, /class="ps-workflow-node-visits" title="Ran 3 times"/);
});

test("runtime-error routes are one red label, '✕ error', with every outcome in its title and its description", () => {
    const layout = layoutWorkflowGraphTB({ ...DAD, shape: "v2" });
    const error = layout.edges.find(edge => edge.from === "generate_joke" && edge.to === "done");
    assert.equal(error.kind, "error");
    assert.equal(error.labelText, WORKFLOW_ERROR_EDGE_LABEL);
    assert.equal(error.outcome, "execution_failed / timed_out");
    const svg = renderToStaticMarkup(React.createElement("svg", null, React.createElement(WorkflowEdgeShape, { edge: error, markerEnd: "" })));
    // Review 18:45Z: the title and the description name the error routes in the Next words, never their raw outcome ids.
    assert.ok(svg.includes(">✕ error<title>Error routes: ✕ agent failed · ✕ limit</title>"), svg);
    assert.ok(svg.includes('aria-label="generate_joke: ✕ agent failed · ✕ limit → done"'), svg);
    assert.ok(!svg.includes("timed_out") && !svg.includes("execution_failed"), svg);
    // A business route keeps its outcome as written.
    assert.equal(layout.edges.find(edge => edge.from === "generate_joke" && edge.to === "send_joke").labelText, "generated");
    // A route that takes both: its business outcomes, then "✕ error".
    const mixed = layoutWorkflowGraphTB({ shape: "v2", revision: 1, initial: "a", states: [
        { id: "a", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "b", failure: "b" } }, { id: "b", type: "terminal", outcome: "succeeded" }] });
    assert.equal(mixed.edges[0].kind, "mixed");
    assert.equal(mixed.edges[0].labelText, "ok / ✕ error");
});

// OF-S2-2 part 2: the one vocabulary every Workflow screen reads (the inventory's decisions D-W1 to D-W8).
test("states are one word each: a Workflow's (a stop either way is Canceled; Not certain) and a node's (Done apart from Completed)", () => {
    // Review 18:45Z (D-W1 overruled): no visible Stopped; review 19:27Z (D-W13): "Not certain" is in the module.
    assert.deepEqual(Object.values(WORKFLOW_RUN_STATE_WORDS),
        ["Running", "Waiting", "Pausing", "Paused", "Canceling", "Completed", "Failed", "Canceled", "Canceled", "Not certain"]);
    assert.deepEqual(Object.values(WORKFLOW_NODE_STATE_WORDS),
        ["Running", "Waiting", "Sending", "Paused", "Done", "Failed", "Canceled", "Reached", "Not reached"]);
    for (const word of [...Object.values(WORKFLOW_RUN_STATE_WORDS), ...Object.values(WORKFLOW_NODE_STATE_WORDS)]) {
        assert.ok(!/[…(]/.test(word), `no ellipsis or parenthetical: ${word}`);
    }
    assert.equal(workflowOutcomeWord("cancelled"), "canceled");
    assert.equal(workflowOutcomeWord("generated"), "generated");
});

test("one duration form everywhere: 820 ms, 4 s, 2 min 45 s, 1 h 3 min (D-W6)", () => {
    assert.equal(workflowDuration(820), "820 ms");
    assert.equal(workflowDuration(4_000), "4 s");
    assert.equal(workflowDuration(165_000), "2 min 45 s");
    assert.equal(workflowDuration(120_000), "2 min");
    assert.equal(workflowDuration(3_780_000), "1 h 3 min");
    assert.equal(workflowDuration(-1), null);
    assert.equal(workflowDuration(Number.NaN), null);
    // A definition's durations are the same form; review 18:45Z (D-W6's exception): the Workflow's own elapsed time in the
    // run header, the state pill and the lists keeps the clock form.
    assert.equal(workflowElapsedText(165_000), "2:45");
    assert.equal(workflowElapsedText(3_780_000), "1:03:00");
    assert.equal(formatSeconds(90), "1 min 30 s");
    assert.equal(formatSeconds(30), "30 s");
    assert.equal(formatSeconds(5400), "1 h 30 min");
});

test("counts are numbers: runs as N or N+; times local, the clock alone on the same day, the zone only in the title (D-W7)", () => {
    assert.equal(workflowRunsText(126), "126");
    assert.equal(workflowRunsText(126, true), "126+");
    assert.equal(workflowRunsText(undefined), null);
    const now = Date.parse("2026-11-07T08:40:00.000Z");
    assert.equal(workflowTime("2026-11-07T08:25:01.000Z", now), "08:25:01");
    assert.equal(workflowTime("2026-11-06T08:25:01.000Z", now), "2026-11-06 08:25:01");
    assert.equal(workflowTimeTitle("2026-11-07T08:25:01.000Z"), "2026-11-07 08:25:01 UTC");
    assert.equal(workflowTime("not a time"), null);
    assert.equal(workflowTimeTitle("not a time"), null);
});

test("an error route reads with the edges' error mark; a failure's detail names its outcome in words", () => {
    assert.deepEqual(["failure", "timed_out", "needs_input", "execution_failed", "invalid_output", "unavailable", "forbidden", "delivery_failed", "cancelled"]
        .map(workflowErrorRouteWords),
    ["✕ error", "✕ limit", "✕ needs input", "✕ agent failed", "✕ invalid output", "✕ unavailable", "✕ forbidden", "✕ not delivered", "⊘ canceled"]);
    assert.equal(workflowErrorRouteWords("quota_exceeded"), "✕ quota exceeded");
    // The card keeps the shortest reason; a tooltip and Now say the outcome it recorded.
    assert.equal(workflowFailureReason("crashed"), "error");
    assert.equal(workflowFailureDetail("crashed"), "crashed");
    assert.equal(workflowFailureDetail("execution_failed"), "execution failed");
    assert.equal(workflowFailureDetail("timed_out"), "limit");
    assert.equal(workflowFailureDetail(null), "error");
});

test("review 18:45Z: an Ask's answer in its own words: Waiting · answer, then ✓ answered, ✕ declined or ✕ limit", () => {
    assert.equal(workflowAskAnswerWords(null, true), "Waiting · answer");
    assert.deepEqual(["responded", "declined", "timed_out"].map(outcome => workflowAskAnswerWords(outcome)), ["✓ answered", "✕ declined", "✕ limit"]);
    assert.equal(workflowAskAnswerWords("other"), null);
});

test("review 19:10Z: a listed Workflow's stored status always reads in words; a stop either way is Canceled, the tooltip says which", () => {
    const rows = ["admitted", "running", "paused", "completed", "failed", "cancelled", "stopped"].map(status => listedState(status));
    assert.deepEqual(rows.map(row => row.label), ["Running", "Running", "Paused", "Completed", "Failed", "Canceled", "Canceled"]);
    assert.deepEqual([rows[5].title, rows[6].title], ["Canceled at once", "Canceled after started nodes finished"]);
    // A status this portal does not know: "Not certain", the stored value in the tooltip only.
    const unknown = listedState("archived_v9");
    assert.deepEqual([unknown.label, unknown.key], ["Not certain", "not-certain"]);
    assert.match(unknown.title, /archived_v9/);
    assert.equal(listedState(null), null);
});
