// A test run's answers and virtual clock from the TUI's workflow view (design 05 test_respond, test_advance; mocks M18
// and M19; R08, R19, R20, R26; INACTIVE: only where the portal's answer form and clock let a person act, from the shown
// test run's own read model): a opens an answer form bound to exactly that run and one held call that waits
// for the parent (↑↓ another, each from its own template), with the run's notices, the effect's actual state, what it
// reached, the schema the answer must match and its outcomes; Tab changes the kind (success, error, cancel); Enter
// sends one test_respond as the portal sends it. + opens the run's virtual clock; Enter sends one test_advance, and the
// status line names what came due. What was typed is checked first; the server decides the rest (a contract's
// refusal names its fields, another answer to an answered effect is refused while the same answer is the same answer)
// and the form keeps what was typed; an answer that never came is sent again as itself. Neither form is offered for a
// live run, an ended run, a viewer the portal refuses, an agent state's subtree, a host without the operations or
// without person commands, and neither sends for a run the view no longer shows.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-test-answers.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowTestAnswerModal,
    selectWorkflowTestClockModal, selectWorkflowViewModal,
} from "../src/index.js";
import { WORKFLOW_V2_TEST_NOTICE_TEXT, WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT } from "../src/workflow-v2-commands.js";
import { SUBTREE_REASON as SUBTREE, readModel, row } from "./workflow-v2-fixtures.mjs";

/** Every command a 1.9.0 host takes from people (human-commands.ts), in its order. */
const ALL = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "stop",
    "test", "test_respond", "test_advance"];
const states = [
    { id: "review", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["accepted", "rejected"],
        next: { accepted: "notify", rejected: "failed", timed_out: "failed" } },
    { id: "notify", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["sent"], next: { sent: "done", failure: "failed", timed_out: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const TEST_RUN = "test-run-0001";
const AGENT = "nx-review-1/agent";
const NOTIFY = "nx-notify-2/call-1";
const FETCHED = "nx-review-1/call-1";
const SCHEMA = { type: "object", required: ["outcome"] };

/** An held call as read_workflow shows it (tools.ts interceptionViewOf). */
const interception = (interceptionId, { operation = "tool.call", tool = null, node, stateId, response = null, schema = null, args = "{}" } = {}) => ({
    interceptionId, operation, tool, nodeExecutionId: node, stateId, state: response ? "responded" : "awaiting_parent", arguments: args,
    argumentsSha256: "h", responseSchema: schema, virtualAt: "2026-11-02T00:00:00.000Z", response });
const answeredBy = (disposition, value) => ({ kind: "success", disposition, value, sha256: "v", respondedAt: "2026-11-02T20:00:00.000Z" });
/** The test run's effects: review's agent and notify's tool call wait for the parent; a fixture answered review's first call. */
const effects = ({ agent = null } = {}) => [
    interception(FETCHED, { tool: "read_build", node: "nx-review-1", stateId: "review", response: answeredBy("fixture", "{\"state\":\"green\"}") }),
    interception(AGENT, { operation: "agent", node: "nx-review-1", stateId: "review", schema: SCHEMA, args: "{\"input\":null}", response: agent }),
    interception(NOTIFY, { tool: "notify_build", node: "nx-notify-2", stateId: "notify", args: "{\"channel\":\"ops\"}" }),
];

/**
 * The workflow wf showing its test run (`mode` test) in `status`, with `interceptions`, its agents mocked or real, the
 * nodes it ran, and what the workflow takes from people (`commands` false: nothing; `viewer` the portal's decision).
 */
function workflow({ status = "running", mode = "test", agentMode = "mocked", interceptions = effects(), runId = TEST_RUN, operations = ALL,
    restriction = null, viewer = null, commands = true, review = "pending", elapsed = 3600 } = {}) {
    const test = { notice: WORKFLOW_V2_TEST_NOTICE_TEXT, agentMode, ...(agentMode === "real" ? { agentNotice: WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT } : {}),
        scenario: null, testedRevision: 1, stale: false, virtualClock: { now: "2026-11-02T01:00:00.000Z", elapsedSeconds: elapsed }, interceptions,
        coverage: { unanswered: interceptions.filter(item => !item.response).map(item => item.interceptionId) } };
    const base = readModel({
        graph: { revision: 1, initial: "review", states },
        definition: { state: "draft", currentRevision: 1, publishedRevision: null, publishedDefinitionHash: null },
        nodeExecutions: [row("review", 1, review === "pending" ? "pending" : "completed",
            review === "pending" ? {} : { outcome: review, resultKind: "business", winner: "controller" }), row("notify", 2, "pending")],
        run: { runId, mode, status, ...(mode === "test" ? { test } : {}) },
        runs: [{ runId, mode, status, revision: 1, outcome: null }],
    });
    if (!commands) return base;
    return { ...base, personCommands: { operations, restriction, run: null, ...(viewer ? { viewer } : {}) } };
}

const answered = (outcome = "accepted", { replayed = false } = {}) => (command, serve) => {
    serve(workflow({ interceptions: effects({ agent: answeredBy("parent", JSON.stringify(command.response.value ?? null)) }), review: outcome }));
    return { workflowId: "wf", operation: "test_respond", replayed, runId: TEST_RUN, interceptionId: command.interception_id,
        interception: { operation: "agent", state: "responded" }, node: { nodeExecutionId: "nx-review-1", stateId: "review", state: "completed", outcome } };
};
const advanced = (decided = []) => command => ({ workflowSessionId: "wf", runId: TEST_RUN, operation: "test_advance", seconds: command.seconds,
    from: "2026-11-02T01:00:00.000Z", virtualNow: "2026-11-02T01:01:00.000Z", decided, replayed: false });
const refused = (status, code, message, details, served) => async (command, serve) => {
    if (served) serve(served);
    throw Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
};
const lost = holder => () => new Promise((_, reject) => { holder.lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); });

/** The workflow session wf showing `initial`'s test run; updateWorkflow answers with the next of `answers`. */
function harness(initial, answers = []) {
    let current = initial;
    const calls = [];
    const serve = next => { current = next; };
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return current; },
        updateWorkflow: async (sessionId, command) => {
            calls.push(["updateWorkflow", sessionId, command]);
            const answer = answers.shift();
            assert.ok(answer, `an answer for ${JSON.stringify(command)}`);
            return answer(command, serve);
        },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    const shown = initial?.run?.runId ?? null;
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: shown, readModel: initial, readModelRunId: shown } });
    return { controller, store, calls, serve, sent: () => calls.filter(call => call[0] === "updateWorkflow").map(call => call[2]) };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const answerForm = store => selectWorkflowTestAnswerModal(store.getState(), 110, 40);
const clockForm = store => selectWorkflowTestClockModal(store.getState(), 110, 40);
const texts = lines => lines.map(line => line.text);
/** Lines as one text: a wrapped sentence reads whole. */
const joined = lines => lines.map(line => (typeof line === "string" ? line : line.text).trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;
const modalOf = store => store.getState().ui.modal;
const without = (command, key) => Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));
function clear(h, edit) {
    edit({ type: "edge", edge: "end" });
    for (let i = 0; i < 500; i++) {
        const modal = modalOf(h.store);
        if (!String(modal.value ?? modal.seconds ?? "").length) return;
        edit({ type: "backspace" });
    }
}
const typeAnswer = (h, text) => h.controller.editWorkflowTestAnswerField({ type: "insert", text });
const typeSeconds = (h, text) => h.controller.editWorkflowTestClockField({ type: "insert", text });

async function opened(initial, answers = []) {
    const h = harness(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    return h;
}

async function answering(initial, answers = []) {
    const h = await opened(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_ANSWER);
    assert.equal(modalOf(h.store).type, "workflowTestAnswer");
    return h;
}

test("the view says what a and + do for the shown test run; a binds the form to the run and a waiting call, from its template; Enter sends it", async () => {
    const h = await opened(workflow(), [answered("accepted")]);
    const lines = details(h.store);
    assert.ok(lines.includes("Test run test-r…0001 — a answers one of its 2 waiting calls · + advances its virtual clock"), lines.join("\n"));
    assert.ok(joined(lines).includes("a answers one that waits; the parent agent or a prepared answer may answer first, and the first answer stands."), lines.join("\n"));
    const view = modalOf(h.store);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_ANSWER);
    const form = modalOf(h.store);
    assert.deepEqual([form.type, form.runId, form.interceptionId, form.kind, form.value], ["workflowTestAnswer", TEST_RUN, AGENT, "success",
        "{\"outcome\":\"accepted\",\"output\":null}"]);
    assert.deepEqual(form.returnModal, view);
    assert.equal(statusOf(h.store), "Answer — Enter send · ctrl-p to the parent agent · Tab success/error/cancel · ↑↓ another waiting call · Esc back");
    const shown = answerForm(h.store);
    assert.equal(shown.title, "Answer · test run test-r…0001 · agent in 'review'");
    assert.ok(joined(shown.lines).startsWith(WORKFLOW_V2_TEST_NOTICE_TEXT));
    for (const line of ["Agent steps are mocked: the parent answers for each agent step.", "Call: agent in step 'review'", `Call id: ${AGENT}`,
        "Waits for an answer (reached at virtual time 2026-11-02T00:00:00.000Z).", "What it reached: {\"input\":null}",
        "The answer must match: {\"type\":\"object\",\"required\":[\"outcome\"]}", "Its step's outcomes: accepted, rejected",
        "Answer: [success] · error · cancel (Tab changes it)", "1 of 2 calls wait for an answer · ↑↓ another"]) {
        assert.ok(texts(shown.lines).includes(line), line);
    }
    assert.deepEqual([shown.valueShown, shown.kind, shown.value], [true, "success", "{\"outcome\":\"accepted\",\"output\":null}"]);
    assert.equal(shown.hint, "Enter send · ctrl-p to the parent agent · Tab success/error/cancel · ↑↓ another waiting call · Esc back");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-test_respond-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "test_respond", run_id: TEST_RUN, interception_id: AGENT,
        response: { kind: "success", value: { outcome: "accepted", output: null } } });
    assert.equal(statusOf(h.store), "Answered call nx-rev…gent of test run test-r…0001. Step 'review' ended 'accepted'.");
    assert.deepEqual(modalOf(h.store), view, "accepted: back to the view");
    await settle();
    assert.ok(details(h.store).includes("Test run test-r…0001 — a answers its waiting call · + advances its virtual clock"));
});

test("Tab changes the kind and what was typed is checked first; ↑↓ bind the form to another waiting call from its own template; cancel sends no value", async () => {
    const h = await answering(workflow({ agentMode: "real" }), [answered("cancelled")]);
    const errorOf = () => modalOf(h.store).error;
    let shown = answerForm(h.store);
    assert.ok(joined(shown.lines).includes(WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT), "a real-agent test says so");
    assert.ok(!texts(shown.lines).includes("Agent steps are mocked: the parent answers for each agent step."));

    h.controller.cycleWorkflowTestAnswerKind();
    shown = answerForm(h.store);
    assert.equal(shown.kind, "error");
    assert.ok(texts(shown.lines).includes("Answer: success · [error] · cancel (Tab changes it)"));
    assert.ok(joined(shown.lines).includes('An error answer is { "code", "message", "details"? } with a message of 1 to 4,000 characters.'));
    assert.equal(shown.value, "{\"outcome\":\"accepted\",\"output\":null}", "what was typed stays");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    assert.equal(errorOf(), 'An error answer is { "code", "message", "details"? } with a message of 1 to 4,000 characters.');
    h.controller.cycleWorkflowTestAnswerKind();
    h.controller.cycleWorkflowTestAnswerKind();
    assert.equal(modalOf(h.store).kind, "success", "Tab goes round the three kinds");
    clear(h, action => h.controller.editWorkflowTestAnswerField(action));
    typeAnswer(h, "{outcome");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    assert.match(errorOf(), /^The answer must be JSON: /);
    assert.deepEqual(h.sent(), []);

    h.controller.pickWorkflowTestInterception(1);
    shown = answerForm(h.store);
    assert.deepEqual([modalOf(h.store).interceptionId, shown.value, shown.kind], [NOTIFY, "null", "success"], "another effect starts from its template");
    assert.equal(shown.title, "Answer · test run test-r…0001 · tool.call in 'notify'");
    assert.ok(texts(shown.lines).includes("Call: tool.call · notify_build in step 'notify'"));
    assert.ok(texts(shown.lines).includes("2 of 2 calls wait for an answer · ↑↓ another"));
    h.controller.pickWorkflowTestInterception(1);
    assert.equal(statusOf(h.store), "No more calls that wait in this direction");
    h.controller.pickWorkflowTestInterception(-1);
    assert.deepEqual([modalOf(h.store).interceptionId, modalOf(h.store).value], [AGENT, "{\"outcome\":\"accepted\",\"output\":null}"]);

    h.controller.cycleWorkflowTestAnswerKind();
    h.controller.cycleWorkflowTestAnswerKind();
    shown = answerForm(h.store);
    assert.deepEqual([shown.kind, shown.valueShown], ["cancel", false]);
    assert.ok(texts(shown.lines).includes("The call ends as cancelled; a cancel has no value."));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    assert.deepEqual(without(h.sent()[0], "operation_id"), { operation: "test_respond", run_id: TEST_RUN, interception_id: AGENT, response: { kind: "cancel" } });
    assert.equal(statusOf(h.store), "Answered call nx-rev…gent of test run test-r…0001. Step 'review' ended 'cancelled'.");
    await settle();
});

test("neither form is offered for a live run, a run that ended, a viewer the portal refuses, a subtree, a host without the operations or without person commands", async () => {
    const both = async (initial, answerWhy, clockWhy = answerWhy) => {
        const h = await opened(initial);
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_ANSWER);
        assert.equal(modalOf(h.store).type, "workflowView");
        assert.equal(statusOf(h.store), `No test answer can be given here. ${answerWhy}`);
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_CLOCK);
        if (clockWhy === null) {
            assert.equal(modalOf(h.store).type, "workflowTestClock", "the clock still advances");
            await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
        } else {
            assert.equal(modalOf(h.store).type, "workflowView");
            assert.equal(statusOf(h.store), `The virtual clock cannot be advanced here. ${clockWhy}`);
        }
        assert.deepEqual(h.sent(), []);
        return h;
    };
    await both(workflow({ mode: "live", runId: "run-live" }), "The shown run is not a test run; ←→ chooses a test run.");
    const ended = await both(workflow({ status: "completed" }), "Test run test-r…0001 has ended (completed); its calls stay unanswered.");
    assert.ok(details(ended.store).includes("  Test run test-r…0001 has ended (completed); its calls stay unanswered."));
    await both(workflow({ viewer: { allowed: false, reason: "You may read this workflow but not command it." } }), "You may read this workflow but not command it.");
    await both(workflow({ operations: ["pause", "stop", "cancel"], restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" } }),
        `${SUBTREE} Its controlling agent is session parent-1.`);
    await both(workflow({ operations: ALL.slice(0, 10) }), "This workflow takes no test answers or clock advances from people.");
    await both(workflow({ commands: false }), "This deployment takes no workflow commands from people.");
    const quiet = await both(workflow({ interceptions: effects({ agent: answeredBy("parent", "null") }).slice(0, 2) }),
        "No call of this test run waits for an answer.", null);
    assert.ok(details(quiet.store).some(line => line.startsWith("Test run test-r…0001 — no call waits for an answer · + advances its virtual clock")));
});

test("the server decides the rest and the form keeps what was typed: a contract's refusal names its fields; another answer to an answered effect is refused and read again", async () => {
    const otherAnswer = workflow({ interceptions: effects({ agent: answeredBy("fixture", "{\"outcome\":\"rejected\",\"output\":null}") }) });
    const h = await answering(workflow(), [
        refused(422, "TEST_RESPONSE_INVALID", "The output does not match ReviewResult.", { problems: [{ path: "/verdict", message: "must be string" }] }),
        refused(409, "TEST_RESPONSE_CONFLICT", "Interception nx-review-1/agent was already answered with another response.", null, otherAnswer),
        answered("rejected", { replayed: true }),
    ]);
    clear(h, action => h.controller.editWorkflowTestAnswerField(action));
    typeAnswer(h, "{\"outcome\":\"accepted\",\"output\":{\"verdict\":5}}");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    const invalid = "The test answer was refused for run test-r…0001: The output does not match ReviewResult. /verdict: must be string.";
    assert.equal(statusOf(h.store), invalid);
    assert.equal(modalOf(h.store).type, "workflowTestAnswer");
    assert.equal(modalOf(h.store).value, "{\"outcome\":\"accepted\",\"output\":{\"verdict\":5}}");
    assert.ok(joined(answerForm(h.store).lines).includes(`! ${invalid}`));

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    const conflict = "The test answer was refused for run test-r…0001: Interception nx-review-1/agent was already answered with another response.";
    assert.equal(statusOf(h.store), conflict);
    await settle();
    const shown = answerForm(h.store);
    assert.ok(joined(shown.lines).includes("Answered: success · prepared answer: {\"outcome\":\"rejected\",\"output\":null}. Another answer is refused; "
        + "the same answer again is the same answer."), joined(shown.lines));
    assert.ok(texts(shown.lines).includes("1 call waits for an answer · ↑↓ another"), "the form stays bound to its effect");
    assert.equal(modalOf(h.store).interceptionId, AGENT);

    // The same answer again is the same answer: the server accepts it as the one it has.
    clear(h, action => h.controller.editWorkflowTestAnswerField(action));
    typeAnswer(h, "{\"outcome\":\"rejected\",\"output\":null}");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    const [, second, third] = h.sent();
    assert.notEqual(third.operation_id, second.operation_id, "a different answer is a different command");
    assert.equal(statusOf(h.store), "Answered call nx-rev…gent of test run test-r…0001. Step 'review' ended 'rejected'. It had already been accepted.");
    assert.equal(modalOf(h.store).type, "workflowView");
    await settle();
});

test("an answer is sent once at a time, and one that never came is sent again as itself", async () => {
    const holder = {};
    const h = await answering(workflow(), [lost(holder), answered("accepted")]);
    const sending = h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    await settle();
    assert.ok(texts(answerForm(h.store).lines).includes("Sending…"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    assert.equal(statusOf(h.store), "The answer is being sent; wait for its reply.");
    assert.equal(h.sent().length, 1);
    holder.lose();
    await sending;
    const lostText = "The test answer for run test-r…0001 may not have reached the workflow: upstream unavailable. Retry sends the same command again.";
    assert.equal(statusOf(h.store), lostText);
    assert.equal(modalOf(h.store).error, null, "the form's own earlier message gives way to the notice");
    const shown = answerForm(h.store);
    assert.ok(joined(shown.lines).includes(`! ${lostText}`));
    assert.ok(joined(shown.lines).includes("Enter sends the same answer again; the server records it once."));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    const [first, again] = h.sent();
    assert.deepEqual(again, first, "the same command, with the same operation id");
    assert.equal(modalOf(h.store).type, "workflowView");
    await settle();
});

test("+ opens the run's virtual clock; Enter advances it by the seconds given and names what came due; the seconds are checked first; a lost reply is sent again as itself", async () => {
    const holder = {};
    const h = await opened(workflow(), [advanced([{ nodeExecutionId: "nx-review-1", stateId: "review", outcome: "timed_out" }]), lost(holder), advanced()]);
    const view = modalOf(h.store);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_CLOCK);
    const form = modalOf(h.store);
    assert.deepEqual([form.type, form.runId, form.seconds], ["workflowTestClock", TEST_RUN, "60"]);
    assert.equal(statusOf(h.store), "Virtual clock — Enter advance by the seconds given · Esc back");
    let shown = clockForm(h.store);
    assert.equal(shown.title, "Virtual clock · test run test-r…0001");
    assert.ok(texts(shown.lines).includes("Virtual clock: 1 h after the test began"));
    assert.ok(joined(shown.lines).includes("An advance by whole seconds (1 to 30 days) decides what came due: a wait or a receive's wait elapses, a "
        + "held request or agent times out; a result that won first stands. Script clocks are real."));
    assert.ok(texts(shown.lines).includes("2 calls wait for an answer."));
    assert.deepEqual([shown.fieldShown, shown.seconds, shown.hint], [true, "60", "Enter advance · Esc back"]);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_CLOCK_ADVANCE);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-test_advance-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "test_advance", run_id: TEST_RUN, seconds: 60 });
    assert.equal(statusOf(h.store), "Advanced the virtual clock of test run test-r…0001 by 60 seconds: 1 deadline came due. Script clocks are real. "
        + "Came due: 'review' timed_out.");
    assert.deepEqual(modalOf(h.store), view, "accepted: back to the view");
    await settle();

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_CLOCK);
    clear(h, action => h.controller.editWorkflowTestClockField(action));
    typeSeconds(h, "1.5");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_CLOCK_ADVANCE);
    assert.equal(modalOf(h.store).error, "Advance by a whole number of seconds from 1 to 2592000.");
    assert.equal(h.sent().length, 1);

    clear(h, action => h.controller.editWorkflowTestClockField(action));
    typeSeconds(h, "300");
    const sending = h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_CLOCK_ADVANCE);
    await settle();
    assert.ok(texts(clockForm(h.store).lines).includes("Advancing…"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_CLOCK_ADVANCE);
    assert.equal(statusOf(h.store), "The advance is being sent; wait for its reply.");
    holder.lose();
    await sending;
    const lostText = "The clock advance for run test-r…0001 may not have reached the workflow: upstream unavailable. Retry sends the same command again.";
    assert.equal(statusOf(h.store), lostText);
    shown = clockForm(h.store);
    assert.ok(joined(shown.lines).includes(`! ${lostText}`));
    assert.ok(joined(shown.lines).includes("Enter sends the same advance again; the server applies it once."));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_CLOCK_ADVANCE);
    const [, second, third] = h.sent();
    assert.deepEqual(third, second, "the same advance, with the same operation id");
    assert.equal(statusOf(h.store), "Advanced the virtual clock of test run test-r…0001 by 300 seconds: 0 deadlines came due. Script clocks are real.");
    await settle();
});

test("a form whose run the view no longer shows sends nothing; Esc goes back to the view", async () => {
    const h = await answering(workflow());
    const view = modalOf(h.store).returnModal;
    // The view now holds another test run's model.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: workflow({ runId: "test-run-0002" }), readModelRunId: TEST_RUN } });
    assert.ok(joined(answerForm(h.store).lines).includes("The workflow view no longer shows test run test-r…0001, so this form sends nothing. Esc goes back."));
    assert.equal(answerForm(h.store).valueShown, false);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_SEND);
    assert.equal(modalOf(h.store).error, "The workflow view no longer shows the test run this form was opened for, so nothing was sent. Esc goes back.");
    assert.deepEqual(h.sent(), []);
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), view);
    assert.equal(statusOf(h.store), "Back to the workflow view");
});

test("q12: ctrl-p sends the answer drafted in the form to the parent agent's chat instead, and the form returns to the view; nothing goes to the test run", async () => {
    const h = harness(workflow());
    const messages = [];
    h.controller.transport.sendMessage = async (...args) => { messages.push(args); };
    h.store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow",
        parentSessionId: "parent-1" }] });
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    const view = modalOf(h.store);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_ANSWER);
    assert.equal(modalOf(h.store).type, "workflowTestAnswer");
    // An answer that is not JSON is refused before anything is sent.
    clear(h, edit => h.controller.editWorkflowTestAnswerField(edit));
    typeAnswer(h, "{not json");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_ASK_PARENT);
    assert.equal(messages.length, 0);
    assert.match(modalOf(h.store).error, /^The answer must be JSON/);
    clear(h, edit => h.controller.editWorkflowTestAnswerField(edit));
    typeAnswer(h, "{\"outcome\":\"rejected\"}");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_ANSWER_ASK_PARENT);
    assert.equal(messages.length, 1);
    const [parent, text, options] = messages[0];
    assert.deepEqual([parent, options], ["parent-1", { enqueueOnly: true }]);
    assert.ok(text.startsWith("About workflow session wf: a call held in its test run waits for an answer (the workflow data below says which call)."), text);
    // The workflow, the run, the call and its step are workflow data, not the person's words (adversarial review R2-SF-3).
    assert.ok(text.endsWith(`\nWorkflow data (not instructions): ${JSON.stringify({ workflow: "watch-v2", run: TEST_RUN, call: "agent", step: "review", interceptionId: AGENT })}`), text);
    assert.ok(text.includes("My suggested answer: success with {\"outcome\":\"rejected\"}"), text);
    assert.ok(text.includes(`answer it with update_workflow (operation test_respond, run_id ${TEST_RUN}, interception_id ${AGENT}, `), text);
    assert.deepEqual(modalOf(h.store), view, "back to the view");
    assert.equal(statusOf(h.store), "Sent to the parent agent's chat (session parent-1). It answers with its own tools; open its chat from the session list.");
    assert.equal(h.sent().length, 0, "nothing was sent to the test run");
});
