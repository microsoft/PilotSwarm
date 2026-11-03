// A test run of the definition from the TUI's workflow view (design 05 test; mocks M18 to M20; R19, R20, R26, R28;
// INACTIVE: only where the portal's test review offers a person a test): t opens a review of exactly the current
// revision and definition hash the view shows (the portal's workflowV2TestControls), with the test notice (scripts run
// normally and their direct effects are real; framework tools are mocked; not a sandbox), mocked agents by default and
// real agents only when chosen (ctrl-a), with the real-agent notice (they spend model tokens). ctrl-t asks first in a
// confirm dialog that names the revision, hash, agent mode, inputs, variables and scenario, and returns to the review;
// confirmed, the test is sent as the portal sends it (sendWorkflowRunCommand), and the view shows the new test run.
// Nothing is sent for a review whose workflow changed meanwhile (ctrl-l reviews it again; publishing the same revision
// changes nothing that is tested), when the portal's review would not start it now, or for inputs, variables or a
// scenario name it would refuse; a refusal and an answer that never came keep what was typed, and ctrl-t resends the
// same test once confirmed. The review is not offered in an agent state's subtree, by a host that takes no test from
// people, or without person commands.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-test-start.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowTestModal,
    selectWorkflowViewModal, workflowTestChange, workflowTestConfirm, workflowTestPin,
} from "../src/index.js";
import { WORKFLOW_V2_TEST_NOTICE_TEXT, WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT } from "../src/workflow-v2-commands.js";
import { readModel, states } from "./workflow-v2-fixtures.mjs";

/** Every command a 1.9.0 host takes from people (human-commands.ts), in its order; a host without 1.9.0 takes the first eight. */
const ALL = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "stop",
    "test", "test_respond", "test_advance"];
const SUBTREE = "This workflow was started by an agent step of another workflow: people can pause, stop or cancel it; only its controlling "
    + "agent changes, resumes or tests it.";
const hashOf = revision => `sha${revision}`.padEnd(64, "0");
const TEST_RUN = "test-run-0001";

/**
 * The workflow wf with its definition `state` at `revision` (valid or with `diagnostics`), the test run `testRun`
 * shown when given, and what it takes from people (`commands` false: nothing; `viewer` the portal's decision).
 */
function workflow({ state = "draft", revision = 2, valid = true, diagnostics = [], operations = ALL, restriction = null, viewer = null,
    commands = true, testRun = null } = {}) {
    const published = state === "published";
    const base = readModel({
        noRun: !testRun,
        ...(testRun ? { run: { runId: testRun.runId, mode: "test", status: "running", test: testRun.test },
            runs: [{ runId: testRun.runId, mode: "test", status: "running", revision, outcome: null }] } : {}),
        graph: valid ? { revision, initial: "poll", states } : null,
        definition: { state, semver: "1.0.0", currentRevision: revision, publishedRevision: published ? revision : null,
            publishedDefinitionHash: published ? hashOf(revision) : null },
        revision: { revision, definitionHash: hashOf(revision), valid, diagnostics, name: "watch-v2" },
    });
    if (!commands) return base;
    return { ...base, personCommands: { operations, restriction, run: null, ...(viewer ? { viewer } : {}) } };
}

/** The server's receipt for a started test; it now serves the workflow with that test run. */
const started = (command, serve) => {
    serve(workflow({ revision: command.expected_revision, testRun: { runId: TEST_RUN, test: { notice: WORKFLOW_V2_TEST_NOTICE_TEXT,
        agentMode: command.agent_mode, testedRevision: command.expected_revision, virtualClock: { elapsedSeconds: 0 }, coverage: { unanswered: [] },
        interceptions: [] } } }));
    return { workflowSessionId: "wf", operation: "test", revision: command.expected_revision, definitionHash: command.definition_hash,
        run: { runId: TEST_RUN, mode: "test", revision: command.expected_revision }, replayed: false };
};
const refused = (status, code, message, details) => async () => {
    throw Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
};

/** The workflow session wf with `initial` loaded; updateWorkflow answers with the next of `answers`. */
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
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: initial, readModelRunId: null } });
    return { controller, store, calls, serve, sent: () => calls.filter(call => call[0] === "updateWorkflow").map(call => call[2]) };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const review = store => selectWorkflowTestModal(store.getState(), 110, 40);
const texts = lines => lines.map(line => line.text);
/** Lines as one text: a wrapped sentence reads whole. */
const joined = lines => lines.map(line => (typeof line === "string" ? line : line.text).trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;
const modalOf = store => store.getState().ui.modal;
const type = (h, text) => h.controller.editWorkflowTestField({ type: "insert", text });
/** Empty the focused field of the review. */
function clear(h) {
    h.controller.editWorkflowTestField({ type: "edge", edge: "end" });
    for (let i = 0; i < 500; i++) {
        const modal = modalOf(h.store);
        if (!String(modal[modal.field] ?? "").length) return;
        h.controller.editWorkflowTestField({ type: "backspace" });
    }
}
const next = h => h.controller.editWorkflowTestField({ type: "switch" });
const without = (command, key) => Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));
const startedText = (revision, agents) => `Started test run test-r…0001 of revision ${revision} with ${agents}. A test result is not evidence that the `
    + "definition is safe to run live.";

async function opened(initial, answers = []) {
    const h = harness(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    return h;
}

async function reviewing(initial, answers = []) {
    const h = await opened(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_REVIEW);
    assert.equal(modalOf(h.store).type, "workflowTest");
    return h;
}

test("the view says what t reviews; the review is of the exact revision and hash with mocked agents; ctrl-t asks first, then the view shows the new test run", async () => {
    const h = await opened(workflow(), [started]);
    assert.ok(details(h.store).includes("Test: draft revision 2 — t reviews a test run beside the live run"), details(h.store).join("\n"));
    const view = modalOf(h.store);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_REVIEW);
    const opener = modalOf(h.store);
    assert.deepEqual([opener.type, opener.agentMode], ["workflowTest", "mocked"]);
    assert.deepEqual(opener.returnModal, view);
    assert.deepEqual(opener.pin, { state: "draft", revision: 2, definitionHash: hashOf(2) });
    assert.equal(statusOf(h.store), "Test review — ctrl-t start the test (asks first) · ctrl-a agents mocked/real · Esc back");
    const shown = review(h.store);
    assert.equal(shown.title, "Test review · draft revision 2 · not a sandbox");
    assert.ok(joined(shown.lines).startsWith(WORKFLOW_V2_TEST_NOTICE_TEXT), "the test notice comes first");
    for (const line of ["Definition: watch-v2 1.0.0", "Draft revision: 2", `Definition hash: ${hashOf(2)}`, "Validity: Valid",
        "Agent steps: mocked; the parent answers for each agent step (ctrl-a: real agents)", "ctrl-t Start test"]) {
        assert.ok(texts(shown.lines).includes(line), line);
    }
    assert.ok(!joined(shown.lines).includes(WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT), "no real-agent notice for mocked agents");
    assert.deepEqual([shown.fields, shown.field, shown.inputs, shown.vars, shown.scenario, shown.agentMode, shown.changed],
        [true, "inputs", "{}", "", "", "mocked", false]);
    assert.equal(shown.hint, "ctrl-t start the test (asks first) · ctrl-a agents mocked/real · Tab inputs/variables/scenario · Esc back");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    const confirm = modalOf(h.store);
    assert.deepEqual([confirm.type, confirm.title, confirm.confirmLabel], ["confirm", "Start Test Run", "Start Test"]);
    assert.equal(confirm.message, `Start a test run of draft revision 2 of watch-v2 1.0.0 (definition hash ${hashOf(2).slice(0, 12)}…) with mocked agents `
        + `(the parent answers for each agent step); inputs {}? ${WORKFLOW_V2_TEST_NOTICE_TEXT} The live run is not changed.`);
    assert.deepEqual(confirm.workflowRunCommand, { sessionId: "wf", operation: "test", runId: null, expectedRevision: 2, definitionHash: hashOf(2),
        inputs: {}, agentMode: "mocked" });
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(modalOf(h.store).type, "workflowTest", "back to the review");
    assert.equal(statusOf(h.store), "The test was not sent");
    assert.deepEqual(h.sent(), []);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-test-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "test", expected_revision: 2, definition_hash: hashOf(2), inputs: {}, agent_mode: "mocked" });
    assert.equal(statusOf(h.store), startedText(2, "mocked agents"));
    assert.deepEqual(modalOf(h.store), { ...view, occurrenceIndex: 0, detailsScroll: 0 }, "back to the view");
    assert.equal(h.store.getState().ui.workflowViews.wf.selectedRunId, TEST_RUN, "the view shows the new test run");
    await settle();
    assert.ok(h.calls.some(call => call[0] === "readWorkflow" && call[2]?.runId === TEST_RUN), "its own read model is read");
    assert.equal(h.store.getState().ui.workflowViews.wf.readModelRunId, TEST_RUN);
});

test("ctrl-a chooses real agents, with their notice; the confirm and the test name them, with the typed inputs, variables and scenario", async () => {
    const h = await reviewing(workflow(), [started]);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_AGENTS);
    assert.equal(modalOf(h.store).agentMode, "real");
    assert.equal(statusOf(h.store), "Agent steps: real agents. They spend model tokens; their workflow tool calls are mocked");
    let shown = review(h.store);
    assert.ok(texts(shown.lines).includes("Agent steps: real agents, which spend model tokens (ctrl-a: mocked)"));
    assert.ok(joined(shown.lines).includes(WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_AGENTS);
    assert.equal(modalOf(h.store).agentMode, "mocked");
    assert.equal(statusOf(h.store), "Agent steps: mocked. The parent answers for each agent step");
    assert.ok(!joined(review(h.store).lines).includes(WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_AGENTS);

    clear(h);
    type(h, '{"repo": "x"}');
    next(h);
    type(h, '{"n": 1}');
    next(h);
    type(h, "happy path");
    shown = review(h.store);
    assert.deepEqual([shown.field, shown.inputs, shown.vars, shown.scenario], ["scenario", '{"repo": "x"}', '{"n": 1}', "happy path"]);
    next(h);
    assert.equal(modalOf(h.store).field, "inputs", "Tab goes round the three fields");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(modalOf(h.store).message, `Start a test run of draft revision 2 of watch-v2 1.0.0 (definition hash ${hashOf(2).slice(0, 12)}…) with real `
        + `agents, which spend model tokens; inputs {"repo":"x"}, initial variables {"n":1}, scenario 'happy path'? ${WORKFLOW_V2_TEST_NOTICE_TEXT} `
        + `${WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT} The live run is not changed.`);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    assert.deepEqual(without(first, "operation_id"), { operation: "test", expected_revision: 2, definition_hash: hashOf(2), inputs: { repo: "x" },
        vars: { n: 1 }, agent_mode: "real", scenario: "happy path" });
    assert.equal(statusOf(h.store), startedText(2, "real agents, which spend model tokens"));
    await settle();
});

test("what is typed is checked first: JSON-object inputs and variables, a scenario name of at most 128 characters; nothing is sent and the text stays", async () => {
    const h = await reviewing(workflow());
    const errorOf = () => modalOf(h.store).error;
    clear(h);
    type(h, "[1]");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(errorOf(), 'Inputs must be a JSON object, for example {"repo": "name"}.');
    assert.equal(statusOf(h.store), errorOf());
    assert.ok(joined(review(h.store).lines).includes(errorOf()));
    clear(h);
    assert.equal(errorOf(), null, "editing clears the message");
    type(h, "{}");
    next(h);
    type(h, "3");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(errorOf(), 'Initial variables must be a JSON object, for example {"repo": "name"}.');
    clear(h);
    next(h);
    type(h, "x".repeat(129));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(errorOf(), "A scenario name is at most 128 characters.");
    const kept = modalOf(h.store);
    assert.deepEqual([kept.type, kept.inputs, kept.vars, kept.scenario.length], ["workflowTest", "{}", "", 129]);
    assert.deepEqual(h.sent(), []);
});

test("a start not available now is not sent and the review says why: compile errors, a viewer the portal refuses, another command being sent", async () => {
    const broken = await opened(workflow({ valid: false, diagnostics: [{ severity: "error", code: "STATE_UNKNOWN", path: "states.poll", message: "No state." }] }));
    assert.ok(details(broken.store).includes("Test: draft revision 2 (it has errors) — t reviews a test run beside the live run"));
    await broken.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_REVIEW);
    const shown = review(broken.store);
    assert.deepEqual(shown.lines.find(line => line.text.startsWith("Validity")), { text: "Validity: 1 error: it cannot be tested", color: "red" });
    const why = "Revision 2 has 1 error and cannot be tested; fix them first.";
    assert.ok(texts(shown.lines).includes(`ctrl-t Start test — not now: ${why}`));
    await broken.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(statusOf(broken.store), `The test cannot start now. ${why}`);
    assert.equal(modalOf(broken.store).type, "workflowTest");

    const denied = await reviewing(workflow({ viewer: { allowed: false, reason: "You may read this workflow but not command it." } }));
    await denied.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(statusOf(denied.store), "The test cannot start now. You may read this workflow but not command it.");

    const busy = await reviewing(workflow());
    busy.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { runCommand: { operation: "publish", runId: null, operationId: "op-1", args: null,
        phase: "pending", message: null, code: null } } });
    assert.equal(review(busy.store).busy, true);
    await busy.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(statusOf(busy.store), "The test cannot start now. Another command for this workflow is being sent.");
    for (const h of [broken, denied, busy]) assert.deepEqual(h.sent(), []);
});

test("the review is not offered in an agent state's subtree, by a host that takes no test from people, or without person commands", async () => {
    const refusedWith = async (initial, reason) => {
        const h = await opened(initial);
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_TEST_REVIEW);
        assert.equal(modalOf(h.store).type, "workflowView");
        assert.equal(statusOf(h.store), `A test cannot be started here. ${reason}`);
        assert.ok(!details(h.store).some(line => line.startsWith("Test:")), reason);
        assert.deepEqual(h.sent(), []);
    };
    await refusedWith(workflow({ operations: ["pause", "stop", "cancel"],
        restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" } }), `${SUBTREE} Its controlling agent is session parent-1.`);
    await refusedWith(workflow({ operations: ALL.slice(0, 8) }), "This workflow takes no test from people.");
    await refusedWith(workflow({ commands: false }), "This deployment takes no workflow commands from people.");
});

test("a stale revision is refused and read again: the review says it changed and sends nothing for it; ctrl-l reviews the new one, keeping what was typed", async () => {
    const h = await reviewing(workflow(), [refused(409, "REVISION_CONFLICT", "The definition is at revision 3, not 2."), started]);
    clear(h);
    type(h, '{"repo": "a"}');
    h.serve(workflow({ revision: 3 }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.sent()[0].expected_revision, 2);
    assert.equal(statusOf(h.store), "Starting the test was refused: The definition is at revision 3, not 2.");
    await settle();
    let shown = review(h.store);
    const change = `The workflow now shows revision 3 (definition hash ${hashOf(3).slice(0, 12)}…); this review is of revision 2, so nothing is sent for it. `
        + "ctrl-l reviews revision 3.";
    assert.equal(shown.changed, true);
    assert.ok(joined(shown.lines).includes(change), joined(shown.lines));
    assert.ok(joined(shown.lines).includes("! Starting the test was refused: The definition is at revision 3, not 2."));
    assert.equal(shown.hint, "ctrl-l review it as it is now · Esc back");
    assert.equal(modalOf(h.store).inputs, '{"repo": "a"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(statusOf(h.store), change);
    assert.equal(h.sent().length, 1);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_RELOAD);
    assert.equal(statusOf(h.store), "Reviewing revision 3 as it is now");
    shown = review(h.store);
    assert.equal(shown.title, "Test review · draft revision 3 · not a sandbox");
    assert.equal(shown.inputs, '{"repo": "a"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first, second] = h.sent();
    assert.deepEqual(without(second, "operation_id"), { operation: "test", expected_revision: 3, definition_hash: hashOf(3), inputs: { repo: "a" },
        agent_mode: "mocked" });
    assert.notEqual(second.operation_id, first.operation_id);
    assert.equal(statusOf(h.store), startedText(3, "mocked agents"));
    await settle();
});

test("publishing the revision under review meanwhile changes nothing that is tested: the review still starts it", async () => {
    const h = await reviewing(workflow());
    h.serve(workflow({ state: "published" }));
    await h.controller.ensureWorkflowReadModel("wf", { force: true });
    const shown = review(h.store);
    assert.equal(shown.changed, false);
    assert.equal(shown.title, "Test review · revision 2 · not a sandbox");
    assert.ok(texts(shown.lines).includes("Revision: 2"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    const confirm = modalOf(h.store);
    assert.equal(confirm.type, "confirm");
    assert.match(confirm.message, /^Start a test run of revision 2 of watch-v2 1\.0\.0 /);
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(h.sent(), []);
});

test("a refusal keeps what was typed, with the schema's problems; while the test is sent nothing else is; an answer that never came is sent again as itself", async () => {
    let lose;
    const h = await reviewing(workflow(), [
        refused(422, "WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.", [{ path: "/repo", message: "must be string" }]),
        () => new Promise((_, reject) => { lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); }),
        started,
    ]);
    const view = modalOf(h.store).returnModal;
    clear(h);
    type(h, '{"repo": 5}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const schema = "Starting the test was refused: Workflow inputs do not match inputs.schema. /repo: must be string.";
    assert.equal(statusOf(h.store), schema);
    assert.equal(modalOf(h.store).type, "workflowTest");
    assert.equal(modalOf(h.store).inputs, '{"repo": 5}');
    assert.ok(joined(review(h.store).lines).includes(`! ${schema}`));

    clear(h);
    type(h, '{"repo": "five"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    const confirming = h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    let shown = review(h.store);
    assert.equal(shown.busy, true);
    assert.ok(texts(shown.lines).includes("ctrl-t Starting test…"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    assert.equal(statusOf(h.store), "The test cannot start now. This command is being sent.");
    assert.equal(h.sent().length, 2);

    lose();
    await confirming;
    const lost = "Starting the test may not have reached the workflow: upstream unavailable. Retry sends the same command again.";
    assert.equal(statusOf(h.store), lost);
    assert.equal(modalOf(h.store).error, null, "the review's own earlier message gives way to the notice");
    shown = review(h.store);
    assert.ok(joined(shown.lines).includes(`! ${lost}`));
    assert.ok(joined(shown.lines).includes("ctrl-t sends the same test again once you confirm it; the server starts it once."));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_TEST_START);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first, second, third] = h.sent();
    assert.notEqual(second.operation_id, first.operation_id);
    assert.deepEqual(third, second, "the same test, with the same operation id");
    assert.equal(statusOf(h.store), startedText(2, "mocked agents"));
    assert.deepEqual(modalOf(h.store), { ...view, occurrenceIndex: 0, detailsScroll: 0 });
    await settle();
});

test("Esc closes the review back to the view; nothing is sent", async () => {
    const h = await reviewing(workflow());
    const view = modalOf(h.store).returnModal;
    type(h, "x");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), view);
    assert.equal(statusOf(h.store), "Closed the test review");
    assert.deepEqual(h.sent(), []);
});

test("the test review's pin, its change and its confirm text", () => {
    const tests = { state: "draft", name: "watch-v2", semver: "1.0.0", revision: 4, definitionHash: hashOf(4) };
    assert.equal(workflowTestPin(null), null);
    const pin = workflowTestPin(tests);
    assert.deepEqual(pin, { state: "draft", revision: 4, definitionHash: hashOf(4) });
    assert.equal(workflowTestChange(pin, tests), null);
    assert.equal(workflowTestChange(pin, { ...tests, state: "published" }), null, "publishing the same revision changes nothing tested");
    assert.equal(workflowTestChange(pin, null), "The workflow can no longer be tested here, so nothing is sent. Esc goes back.");
    assert.match(workflowTestChange(pin, { ...tests, revision: 5, definitionHash: hashOf(5) }), /^The workflow now shows revision 5 /);
    const confirm = workflowTestConfirm(pin, tests, { inputs: {}, agentMode: "real", scenario: "s".repeat(100) });
    assert.ok(confirm.message.includes(`, scenario '${"s".repeat(59)}…'?`));
    assert.ok(confirm.message.includes(WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT));
    assert.ok(confirm.message.endsWith(" The live run is not changed."));
});
