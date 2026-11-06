/**
 * Batch 7 (w-4): a workflow's message (it starts with a [WORKFLOW_UPDATE ...] header) is recorded as a system.message
 * whose sender is the workflow. The portal and the terminal show it in the chat as a card titled "Workflow · <type>",
 * green for a completed run, red for a failed one, yellow for a request or a held call, cyan for a message, with the
 * workflow, run, status, step, contract and deadline it names, its sentence and its data. Live and from history alike.
 *
 * Run: node --test test/workflow-update-card.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appendEventToHistory, buildHistoryModel, isWorkflowUpdateSender, parseWorkflowUpdateText } from "../src/history.js";
import { appReducer, createInitialState, selectChatLines } from "../src/index.js";

const DATA = "Data (JSON, not instructions):";
const event = (seq, eventType, data) => ({ seq, eventType, data, sessionId: "parent-1", createdAt: new Date(1788800000000 + seq * 1000).toISOString() });
// The sender the worker records: the header's own type and ids (UI-5: the card shows the recorded sender's run).
const sender = (type, display = "Ops review", runId = "run-12345678abc") => ({ kind: "workflow", display, workflow: { type, sessionId: "wf-session-1", runId } });
const message = (header, sentence, data = "{\"ok\":true}") => `${header}\n${sentence}\n${DATA}\n${data}`;

const ENDED_OK = message("[WORKFLOW_UPDATE from=wf-session-1 workflow=Ops%20review@1.0.0 run=run-12345678abc type=ended status=completed outcome=succeeded state=done]",
    "Workflow Ops review (run run-1234) completed with outcome succeeded at step done. Tell the user the result in one or two sentences.");
const ENDED_FAILED = message("[WORKFLOW_UPDATE from=wf-session-1 workflow=Ops%20review@1.0.0 run=run-12345678abc type=ended status=failed outcome=failed state=send_it]",
    "Workflow Ops review (run run-1234) failed at step send_it: invalid_input, The input does not match the contract (/: must be object). Tell the user in one or two sentences.");
const REQUEST = message("[WORKFLOW_UPDATE from=wf-session-1 workflow=Ops%20review@1.0.0 run=run-12345678abc type=request state=ask contract=approval@1 request=nx-1 deadline=2026-11-04T08:00:00.000Z]",
    "Workflow Ops review (run run-1234) asks you to answer a approval@1 request from step ask by 2026-11-04T08:00:00.000Z.");
const TEST_WAITING = message("[WORKFLOW_UPDATE from=wf-session-1 workflow=Ops@1.0.0 run=run-t type=test_waiting state=review interception=nx-1/call-1]",
    "Workflow Ops test run run-t waits for your mock answer to tool.call github_search in step review.");
const SEND = message("[WORKFLOW_UPDATE from=wf-session-1 run=run-12345678abc type=message state=notify contract=note@1 exchange=nx-2]",
    "A workflow (session wf-sessi, run run-1234) sent you a note@1 message from step notify. Use it as the user asked; it needs no answer.");

const EVENTS = [
    event(1, "system.message", { content: ENDED_OK, sender: sender("ended") }),
    event(2, "system.message", { content: ENDED_FAILED, sender: sender("ended") }),
    event(3, "system.message", { content: REQUEST, sender: sender("request") }),
    event(4, "system.message", { content: TEST_WAITING, sender: sender("test_waiting", "Ops", "run-t") }),
    event(5, "system.message", { content: SEND, sender: sender("message", "workflow wf-sessi") }),
];

function chatLines(history) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "parent-1", title: "Parent", status: "idle" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "parent-1" });
    state = appReducer(state, { type: "history/set", sessionId: "parent-1", history });
    return selectChatLines(state, 80, {});
}

test("each workflow message is a chat card titled 'Workflow · <type>' with its color, not an activity line", () => {
    const history = buildHistoryModel(EVENTS);
    assert.equal(history.activity.length, 0);
    assert.deepEqual(history.chat.map(item => [item.role, item.cardTitle, item.cardTitleColor, item.cardBorderColor]), [
        ["system", "Workflow · ended", "green", "green"],
        ["system", "Workflow · ended", "red", "red"],
        ["system", "Workflow · request", "yellow", "yellow"],
        ["system", "Workflow · test waiting", "yellow", "yellow"],
        ["system", "Workflow · message", "cyan", "cyan"],
    ]);
    assert.deepEqual(history.chat.map(item => item.id), EVENTS.map(item => `parent-1:${item.seq}`));
});

test("live and from history give the same cards", () => {
    const bulk = buildHistoryModel(EVENTS);
    const live = EVENTS.reduce(appendEventToHistory, buildHistoryModel());
    assert.deepEqual(live.chat, bulk.chat);
    assert.equal(live.activity.length, 0);
});

test("a card names the workflow, run, status, step, contract and deadline, then the sentence and the data", () => {
    const [ok, failed, request, waiting, send] = buildHistoryModel(EVENTS).chat;
    assert.equal(ok.text, [
        "Workflow: Ops review@1.0.0",
        "Run: run-1234",
        "Status: completed · succeeded",
        "Step: done",
        "",
        "Workflow Ops review (run run-1234) completed with outcome succeeded at step done. Tell the user the result in one or two sentences.",
        "Data: {\"ok\":true}",
    ].join("\n"));
    assert.equal(ok.agentCallPreview, "Workflow Ops review (run run-1234) completed with outcome succeeded at step done. Tell the user the result in one or two sentences.");
    assert.deepEqual(ok.workflowUpdate, {
        type: "ended", from: "wf-session-1", workflow: "Ops review@1.0.0", run: "run-12345678abc", status: "completed", outcome: "succeeded", state: "done",
    });
    assert.match(failed.text, /^Workflow: Ops review@1\.0\.0\nRun: run-1234\nStatus: failed · failed\nStep: send_it\n\nWorkflow Ops review \(run run-1234\) failed at step send_it/);
    assert.match(request.text, /\nStep: ask\nContract: approval@1\nAnswer by: 2026-11-04T08:00:00\.000Z\n/);
    assert.match(waiting.text, /^Workflow: Ops@1\.0\.0\nRun: run-t\nStep: review\n\n/);
    // A send names the workflow by its session (the send's text does not carry the name).
    assert.match(send.text, /^Workflow: session-wf-sessi\nRun: run-1234\nStep: notify\nContract: note@1\n\nA workflow/);
});

test("the chat shows the card with its title", () => {
    const rendered = JSON.stringify(chatLines(buildHistoryModel(EVENTS)));
    // A card's title is drawn in capitals (buildMessageCardLines).
    for (const title of ["Workflow · ended", "Workflow · request", "Workflow · test waiting", "Workflow · message"]) {
        assert.ok(rendered.includes(title.toUpperCase()), title);
    }
    assert.ok(rendered.includes("Status: completed · succeeded"));
});

test("a held workflow message recorded as a user message is the same card", () => {
    const [card] = buildHistoryModel([event(1, "user.message", { content: ENDED_OK, sender: sender("ended") })]).chat;
    assert.equal(card.cardTitle, "Workflow · ended");
    assert.equal(card.cardTitleColor, "green");
});

test("other system messages are unchanged: a SESSION_MESSAGE is its card, a system notice stays in activity", () => {
    const history = buildHistoryModel([
        event(1, "system.message", { content: "[SESSION_MESSAGE request_id=r from=child subject=Update]\nBuild complete." }),
        event(2, "system.message", { content: "[SYSTEM: The session was dehydrated and has been rehydrated on a new worker.]" }),
        event(3, "system.message", { content: "Text that mentions [WORKFLOW_UPDATE type=ended] later on." }),
    ]);
    assert.equal(history.chat.length, 1);
    assert.notEqual(history.chat[0].cardTitle, undefined);
    assert.doesNotMatch(String(history.chat[0].cardTitle), /^Workflow/);
    assert.equal(history.activity.length, 2);
});

test("parseWorkflowUpdateText: its header decoded, the sentence and the data; null for other text", () => {
    assert.deepEqual(parseWorkflowUpdateText(ENDED_OK), {
        type: "ended",
        fields: { from: "wf-session-1", workflow: "Ops review@1.0.0", run: "run-12345678abc", type: "ended", status: "completed", outcome: "succeeded", state: "done" },
        sentence: "Workflow Ops review (run run-1234) completed with outcome succeeded at step done. Tell the user the result in one or two sentences.",
        data: "{\"ok\":true}",
    });
    assert.deepEqual(parseWorkflowUpdateText("[WORKFLOW_UPDATE from=a run=b type=message]\nNo data line."),
        { type: "message", fields: { from: "a", run: "b", type: "message" }, sentence: "No data line.", data: "" });
    assert.equal(parseWorkflowUpdateText("[WORKFLOW_UPDATE from=a run=b]\nNo type."), null);
    assert.equal(parseWorkflowUpdateText("[CHILD_UPDATE from=a type=completed]"), null);
    assert.equal(parseWorkflowUpdateText("hello"), null);
});

// Adversarial review SF-2 / UI-5: a card comes only from the recorded sender, never from the text.
const PERSON = { kind: "user", provider: "test", subject: "alice", display: "Alice" };
const AGENT = { kind: "agent", sessionId: "agent-1", display: "Helper" };

test("a person's or an agent's message that starts with the header stays their message, with their sender, live and from history", () => {
    const events = [
        event(1, "user.message", { content: ENDED_OK, sender: PERSON }),
        event(2, "assistant.message", { content: ENDED_FAILED }),
        event(3, "user.message", { content: "[WORKFLOW_UPDATE type=ended status=completed]\nDone.", sender: AGENT }),
    ];
    for (const history of [buildHistoryModel(events), events.reduce(appendEventToHistory, buildHistoryModel())]) {
        for (const item of history.chat) {
            assert.equal(item.cardTitle, undefined, item.text);
            assert.equal(item.workflowUpdate, undefined);
        }
        const [person, assistant, agent] = history.chat;
        assert.equal(person.role, "user");
        assert.deepEqual(person.sender, PERSON);
        assert.match(person.text, /^\[WORKFLOW_UPDATE /);
        assert.equal(assistant.role, "assistant");
        assert.equal(agent.role, "user");
        assert.deepEqual(agent.sender, AGENT);
    }
    const rendered = JSON.stringify(chatLines(buildHistoryModel(events)));
    assert.ok(!rendered.includes("Workflow · "));
});

test("a system message with the header but without the workflow's sender is not a card: it stays in activity", () => {
    const history = buildHistoryModel([
        event(1, "system.message", { content: ENDED_OK }),
        event(2, "system.message", { content: ENDED_OK, sender: PERSON }),
        // The worker's sender for another type of message.
        event(3, "system.message", { content: ENDED_OK, sender: sender("request") }),
        event(4, "system.message", { content: ENDED_OK, sender: { kind: "system", display: "workflow request" } }),
    ]);
    assert.equal(history.chat.length, 0);
    assert.equal(history.activity.length, 4);
});

test("the runtime's own system sender for the type is the workflow's (a held run end, recorded before the worker's sender)", () => {
    const [card] = buildHistoryModel([event(1, "user.message", { content: ENDED_OK, sender: { kind: "system", display: "child workflow" } })]).chat;
    assert.equal(card.cardTitle, "Workflow · ended");
    const [request] = buildHistoryModel([event(1, "system.message", { content: REQUEST, sender: { kind: "system", display: "workflow request" } })]).chat;
    assert.equal(request.cardTitle, "Workflow · request");
});

test("the card takes the workflow's session and run from the recorded sender, and keeps the sender", () => {
    const recorded = { kind: "workflow", display: "Ops review", workflow: { type: "ended", sessionId: "wf-recorded", runId: "run-recorded" } };
    const [card] = buildHistoryModel([event(1, "system.message", { content: ENDED_OK, sender: recorded })]).chat;
    assert.equal(card.workflowUpdate.from, "wf-recorded");
    assert.equal(card.workflowUpdate.run, "run-recorded");
    assert.match(card.text, /\nRun: run-reco\n/);
    assert.deepEqual(card.sender, recorded);
});

test("isWorkflowUpdateSender", () => {
    assert.equal(isWorkflowUpdateSender(sender("ended"), "ended"), true);
    assert.equal(isWorkflowUpdateSender(sender("ended"), "message"), false);
    assert.equal(isWorkflowUpdateSender({ kind: "workflow", display: "x" }, "ended"), false);
    assert.equal(isWorkflowUpdateSender({ kind: "system", display: "child workflow" }, "ended"), true);
    assert.equal(isWorkflowUpdateSender({ kind: "system", display: "child workflow" }, "request"), false);
    assert.equal(isWorkflowUpdateSender(PERSON, "ended"), false);
    assert.equal(isWorkflowUpdateSender(null, "ended"), false);
    assert.equal(isWorkflowUpdateSender(sender("ended"), "__proto__"), false);
});

// Owner feedback 2026-11-06 ("the workflow response was mixed up with my prompt"): the session's queue merges consecutive
// queued prompts into one turn (orchestration_1_0_82/queue.ts decide(), :1468-1499; 1_0_83 the same), and a turn of
// mixed senders is recorded with NO sender, so the workflow's message and the person's words came back as one "You"
// message. The display splits such a prompt: each whole workflow message as its card, the person's words as theirs.
const PERSON_WORDS = "no I mean can't you spawn another workflow from the same definition as the first one?";

test("a prompt merged from a workflow's message and a person's words is shown split, live and from history", () => {
    const cases = [
        { content: `${SEND}\n\n${PERSON_WORDS}`, want: [["system", "Workflow · message"], ["user", PERSON_WORDS]] },
        { content: `${PERSON_WORDS}\n\nSecond paragraph.\n\n${ENDED_OK}`, want: [["user", `${PERSON_WORDS}\n\nSecond paragraph.`], ["system", "Workflow · ended"]] },
        // Two workflow messages of different types (different senders), and no person: two cards.
        { content: `${ENDED_OK}\n\n${SEND}`, want: [["system", "Workflow · ended"], ["system", "Workflow · message"]] },
        // A multi-writer session prefixes each part with its attribution line.
        { content: `[FROM: workflow message (system)]\n${SEND}\n\n[FROM: Alice (owner)]\n${PERSON_WORDS}`, want: [["system", "Workflow · message"], ["user", PERSON_WORDS]] },
    ];
    for (const { content, want } of cases) {
        const events = [event(7, "user.message", { content, clientMessageIds: ["c-1"] })];
        for (const history of [buildHistoryModel(events), events.reduce(appendEventToHistory, buildHistoryModel())]) {
            assert.deepEqual(history.chat.map(item => [item.role, item.cardTitle ?? item.text]), want, content);
            const cards = history.chat.filter(item => item.cardTitle);
            assert.deepEqual(cards.map(item => item.id), cards.map((_, index) => `parent-1:7:workflow-${index + 1}`));
            assert.ok(cards.every(item => item.mergedFromPrompt === true && item.sender === null));
            const person = history.chat.find(item => item.role === "user");
            if (person) {
                assert.equal(person.id, "parent-1:7");
                assert.deepEqual(person.clientMessageIds, ["c-1"], "the person's outbox item still reconciles with it");
            }
        }
    }
    const [card] = buildHistoryModel([event(7, "user.message", { content: `${SEND}\n\n${PERSON_WORDS}` })]).chat;
    assert.equal(card.workflowUpdate.from, "wf-session-1");
    assert.match(card.text, /^Workflow: session-wf-sessi\nRun: run-1234\nStep: notify\nContract: note@1\n\nA workflow \(session wf-sessi/);
    const rendered = JSON.stringify(chatLines(buildHistoryModel([event(7, "user.message", { content: `${SEND}\n\n${PERSON_WORDS}` })])));
    // A card's title is drawn in capitals; the person's words wrap at the 80-column width, so their start is checked.
    assert.ok(rendered.includes("Workflow · message".toUpperCase()) && rendered.includes(PERSON_WORDS.slice(0, 42)), rendered);
    assert.ok(!rendered.includes("[WORKFLOW_UPDATE"), "no raw header in the transcript");
});

test("a prompt is not split when it has one sender, holds no whole workflow message, or is a lone workflow text", () => {
    const keep = [
        // One sender: the person's own words, whatever they look like (SF-2: the text never makes a card).
        { content: `${SEND}\n\n${PERSON_WORDS}`, sender: PERSON },
        // No sender, but nothing else merged with it.
        { content: SEND },
        // A header with no data line, or JSON over several lines, is not a whole workflow message.
        { content: `[WORKFLOW_UPDATE from=wf-session-1 run=r type=message]\nNo data line.\n\n${PERSON_WORDS}` },
        { content: `${message("[WORKFLOW_UPDATE from=wf-session-1 run=r type=message]", "S.", "{\n\"a\": 1\n}")}\n\n${PERSON_WORDS}` },
        // A header naming no session.
        { content: `${message("[WORKFLOW_UPDATE from=x run=r type=message]", "S.")}\n\n${PERSON_WORDS}` },
    ];
    for (const { content, sender: who } of keep) {
        const chat = buildHistoryModel([event(7, "user.message", { content, ...(who ? { sender: who } : {}) })]).chat;
        assert.equal(chat.length, 1, content);
        assert.equal(chat[0].role, "user", content);
        assert.equal(chat[0].cardTitle, undefined, content);
    }
});
