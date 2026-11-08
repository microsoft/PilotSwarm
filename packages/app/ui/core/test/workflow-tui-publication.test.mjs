// The definition's Start in the TUI's workflow view (design 04 publish_and_start, start; spec draft 3: no publish-only
// step on any surface, review UI-4; INACTIVE: only where the portal offers a person a command): S opens a Start form of
// exactly the revision and definition hash the view shows (the portal's workflowV2DefinitionControls): ctrl-r starts it
// (a draft's revision is published and started in one step, a published one is started), with the run's inputs and
// initial variables as JSON objects; publishing alone is refused in words. Each asks first in a confirm dialog that names the revision, the
// hash and the inputs, and returns to the review; confirmed, the command is sent as the portal sends it (the shared
// controller's sendWorkflowRunCommand). Nothing is sent for a review whose workflow changed meanwhile (ctrl-l reviews it
// again), for an action not offered or not available now, or for inputs that are not JSON objects; a refusal and an
// answer that never came keep what was typed, and the same key resends the same command once confirmed. The review is
// not offered in an agent state's subtree, for a workflow with its live run or without person commands.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-publication.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectHelpModal, selectWorkflowPublicationModal,
    selectWorkflowViewModal, workflowPublicationChange, workflowPublicationConfirm, workflowPublicationPin,
} from "../src/index.js";
import { SUBTREE_REASON as SUBTREE, readModel, states } from "./workflow-v2-fixtures.mjs";

/** Every command a 1.9.0 host takes from people (human-commands.ts), in its order. */
const ALL = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "stop",
    "test", "test_respond", "test_advance"];
/** A revision's definition hash, 64 characters as the store's SHA-256 hex. */
const hashOf = revision => `sha${revision}`.padEnd(64, "0");
const LIVE = "run-live-0001";

/**
 * The workflow wf with its definition `state` at `revision` (valid or with `diagnostics`), its live run when `liveRun`,
 * and what it takes from people (`commands` false: nothing; `viewer` the portal's decision for the caller).
 */
function workflow({ state = "draft", revision = 2, valid = true, diagnostics = [], operations = ALL, restriction = null, viewer = null,
    commands = true, liveRun = false } = {}) {
    const published = state === "published";
    const base = readModel({
        noRun: !liveRun,
        ...(liveRun ? { run: { runId: LIVE, status: "running" }, runs: [{ runId: LIVE, mode: "live", status: "running", revision, outcome: null }] } : {}),
        graph: valid ? { revision, initial: "poll", states } : null,
        definition: { state, semver: "1.0.0", currentRevision: revision, publishedRevision: published ? revision : null,
            publishedDefinitionHash: published ? hashOf(revision) : null },
        revision: { revision, definitionHash: hashOf(revision), valid, diagnostics, name: "watch-v2" },
    });
    if (!commands) return base;
    return { ...base, personCommands: { operations, restriction, run: null, ...(viewer ? { viewer } : {}) } };
}

/** The server's receipt for an accepted publication command; it now serves the published revision (with its live run). */
const accepted = (operation, revision, runId = null) => (command, serve) => {
    serve(workflow({ state: "published", revision, liveRun: Boolean(runId) }));
    return { workflowSessionId: "wf", operation, state: "published", revision, yamlSha256: hashOf(revision), valid: true, irSha256: `ir-${revision}`,
        diagnostics: [], publishedRevision: revision, replayed: false,
        run: runId ? { runId, mode: "live", controllerInstanceId: "controller-1", revision, irSha256: `ir-${revision}` } : null };
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
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: initial, readModelRunId: null } });
    return { controller, store, calls, serve, sent: () => calls.filter(call => call[0] === "updateWorkflow").map(call => call[2]) };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const review = store => selectWorkflowPublicationModal(store.getState(), 110, 40);
const texts = lines => lines.map(line => line.text);
/** Lines as one text: a wrapped sentence reads whole. */
const joined = lines => lines.map(line => (typeof line === "string" ? line : line.text).trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;
const modalOf = store => store.getState().ui.modal;
const type = (h, text) => h.controller.editWorkflowPublicationField({ type: "insert", text });
/** Empty the focused field of the review. */
function clear(h) {
    h.controller.editWorkflowPublicationField({ type: "edge", edge: "end" });
    for (let i = 0; i < 500; i++) {
        const modal = modalOf(h.store);
        if (!String(modal[modal.field === "vars" ? "vars" : "inputs"] ?? "").length) return;
        h.controller.editWorkflowPublicationField({ type: "backspace" });
    }
}
const without = (command, key) => Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));

async function opened(initial, answers = []) {
    const h = harness(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    return h;
}

async function reviewing(initial, answers = []) {
    const h = await opened(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
    assert.equal(modalOf(h.store).type, "workflowPublish");
    return h;
}

test("the view says what S starts; the Start form shows exactly the revision and hash; publishing alone is refused and nothing is sent", async () => {
    const h = await opened(workflow());
    assert.ok(details(h.store).includes("Start: revision 2 · not started — S starts it"), details(h.store).join("\n"));
    const view = modalOf(h.store);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
    const opener = modalOf(h.store);
    assert.equal(opener.type, "workflowPublish");
    assert.deepEqual(opener.returnModal, view);
    assert.deepEqual(opener.pin, { state: "draft", revision: 2, definitionHash: hashOf(2) });
    assert.equal(statusOf(h.store), "Start — ctrl-r start (asks first) · Tab inputs/variables · Esc back");
    const shown = review(h.store);
    assert.equal(shown.title, "Start · revision 2");
    // Review 19:27Z (row 26): the revision, no hash.
    assert.deepEqual(texts(shown.lines).slice(0, 4), ["Definition: watch-v2 1.0.0", "Revision: 2", "Validity: Valid",
        "Effects: Real, once it starts"]);
    assert.ok(!texts(shown.lines).some(line => line.startsWith("Definition hash")));
    // The evidence rows: no named agent here; no test row (test mode is hidden, and no test run is read).
    assert.deepEqual(texts(shown.lines).slice(4, 5), ["Agents: None: no node runs a named agent"]);
    assert.ok(!texts(shown.lines).some(line => line.startsWith("Tests of this revision")));
    assert.ok(joined(shown.lines).includes("Start runs this exact revision with real effects; the revision no longer changes after it starts."));
    assert.ok(texts(shown.lines).includes("ctrl-r Start"));
    assert.doesNotMatch(joined(shown.lines), /publish/i, "no publish words");
    assert.deepEqual([shown.fields, shown.field, shown.inputs, shown.vars, shown.changed], [true, "inputs", "{}", "", false]);
    assert.equal(shown.hint, "ctrl-r start · Tab inputs/variables · Esc back — each asks first");

    // Publishing alone is not offered (the old ctrl-p): refused in words, the form stays, nothing is sent.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(statusOf(h.store), "Only Start is offered: it starts this revision.");
    assert.equal(modalOf(h.store).type, "workflowPublish");
    assert.deepEqual(h.sent(), []);
});

test("ctrl-r publishes and starts the live run with the typed inputs and initial variables, after a confirm that names them", async () => {
    const h = await reviewing(workflow(), [accepted("publish_and_start", 2, LIVE)]);
    const view = modalOf(h.store).returnModal;
    clear(h);
    type(h, '{"repo": "pilotswarm", "limit": 3}');
    h.controller.editWorkflowPublicationField({ type: "switch" });
    type(h, '{"note": "first"}');
    const shown = review(h.store);
    assert.deepEqual([shown.field, shown.inputs, shown.vars], ["vars", '{"repo": "pilotswarm", "limit": 3}', '{"note": "first"}']);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    const confirm = modalOf(h.store);
    assert.equal(confirm.title, "Start Revision 2");
    assert.equal(confirm.confirmLabel, "Start");
    assert.equal(confirm.message, `Start revision 2 of watch-v2 1.0.0 with inputs `
        + '{"repo":"pilotswarm","limit":3} and initial variables {"note":"first"}? This revision no longer changes after it starts, and its effects are real.');
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-publish_and_start-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "publish_and_start", expected_revision: 2, definition_hash: hashOf(2),
        inputs: { repo: "pilotswarm", limit: 3 }, vars: { note: "first" } });
    assert.equal(statusOf(h.store), "Started revision 2.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
    assert.ok(!details(h.store).some(line => line.startsWith("Start:")), "a workflow with its live run offers no more Start");
});

test("what is typed is checked first: the inputs and initial variables must be JSON objects; nothing is sent and the text stays", async () => {
    const h = await reviewing(workflow());
    const errorOf = () => modalOf(h.store).error;
    clear(h);
    type(h, "[1]");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(errorOf(), 'Inputs must be a JSON object, for example {"repo": "name"}.');
    assert.equal(statusOf(h.store), errorOf());
    assert.ok(joined(review(h.store).lines).includes('Inputs must be a JSON object, for example {"repo": "name"}.'));
    type(h, " ");
    assert.equal(errorOf(), null, "typing clears the message");
    clear(h);
    type(h, "{bad");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.match(errorOf(), /^Inputs must be a JSON object: /);
    clear(h);
    h.controller.editWorkflowPublicationField({ type: "switch" });
    type(h, "3");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(errorOf(), 'Initial variables must be a JSON object, for example {"repo": "name"}.');
    assert.equal(modalOf(h.store).type, "workflowPublish", "no confirm");

    // Publishing alone is refused; what was typed stays.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    const kept = modalOf(h.store);
    assert.deepEqual([kept.type, kept.inputs, kept.vars], ["workflowPublish", "", "3"]);

    // The fields edit as text: the cursor, Home and End, a pasted line break as a space.
    h.controller.editWorkflowPublicationField({ type: "switch" });
    type(h, "{}");
    h.controller.editWorkflowPublicationField({ type: "move", chars: -1 });
    type(h, '"a":\r\n1');
    h.controller.editWorkflowPublicationField({ type: "edge", edge: "start" });
    h.controller.editWorkflowPublicationField({ type: "backspace" });
    const fields = modalOf(h.store);
    assert.deepEqual([fields.field, fields.inputs, fields.inputsCursor], ["inputs", '{"a": 1}', 0]);
    assert.deepEqual(h.sent(), []);
});

test("an action not available now is not sent and the review says why: compile errors, a viewer the portal refuses, another command being sent", async () => {
    const broken = await opened(workflow({ valid: false, diagnostics: [{ severity: "error", code: "STATE_UNKNOWN", path: "states.poll", message: "No state." }] }));
    assert.ok(details(broken.store).includes("Start: revision 2 · errors · not started — S starts it"));
    await broken.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
    assert.equal(modalOf(broken.store).type, "workflowPublish", "offered, so the review says why its actions are not available");
    let shown = review(broken.store);
    assert.deepEqual(shown.lines.find(line => line.text.startsWith("Validity")), { text: "Validity: 1 error: it cannot start", color: "red" });
    const why = shown.lines.find(line => line.text.startsWith("ctrl-r Start — not now: ")).text.slice("ctrl-r Start — not now: ".length);
    assert.match(why, /^Revision 2 has 1 error/);
    await broken.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(broken.store), `Start is not available now. ${why}`);
    assert.equal(modalOf(broken.store).type, "workflowPublish");

    const viewer = { allowed: false, reason: "You may read this workflow but not command it." };
    const denied = await reviewing(workflow({ viewer }));
    await denied.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(denied.store), "Start is not available now. You may read this workflow but not command it.");
    assert.equal(modalOf(denied.store).error, "Start is not available now. You may read this workflow but not command it.");

    const busy = await reviewing(workflow());
    busy.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { runCommand: { operation: "pause", runId: "run-x", operationId: "op-1", args: null,
        phase: "pending", message: null, code: null } } });
    shown = review(busy.store);
    assert.equal(shown.busy, true);
    await busy.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(busy.store), "Start is not available now. Another command for this Workflow is being sent.");
    for (const h of [broken, denied, busy]) assert.deepEqual(h.sent(), []);
});

test("the review is not offered in an agent state's subtree, for a workflow with its live run, or without person commands", async () => {
    const refusedWith = async (initial, reason) => {
        const h = await opened(initial);
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PUBLICATION_REVIEW);
        assert.equal(modalOf(h.store).type, "workflowView");
        assert.equal(statusOf(h.store), `Start refused: ${reason}`);
        assert.ok(!details(h.store).some(line => line.startsWith("Start:")), reason);
        assert.deepEqual(h.sent(), []);
    };
    await refusedWith(workflow({ operations: ["pause", "stop", "cancel"],
        restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" } }), SUBTREE);
    await refusedWith(workflow({ state: "published", liveRun: true }), "This workflow has its live run; a new live run needs a new workflow.");
    await refusedWith(workflow({ commands: false }), "This deployment takes no Workflow commands from people.");
});

test("a stale revision is refused and read again: the review says it changed and sends nothing for it; ctrl-l reviews the new one, keeping the inputs", async () => {
    const h = await reviewing(workflow(), [refused(409, "REVISION_CONFLICT", "The draft is at revision 3, not 2."), accepted("publish_and_start", 3, LIVE)]);
    const view = modalOf(h.store).returnModal;
    clear(h);
    type(h, '{"repo": "a"}');
    // Someone saved revision 3 meanwhile; the view still shows revision 2.
    h.serve(workflow({ revision: 3 }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.sent()[0].expected_revision, 2);
    assert.equal(statusOf(h.store), "Publish and start refused: The draft is at revision 3, not 2.");
    await settle();
    let shown = review(h.store);
    assert.equal(modalOf(h.store).type, "workflowPublish", "the review stays");
    assert.equal(shown.changed, true);
    const change = `The Workflow now shows revision 3; this review is of revision 2, so nothing is sent for it. `
        + "ctrl-l reviews revision 3.";
    assert.ok(joined(shown.lines).includes(change), joined(shown.lines));
    assert.ok(joined(shown.lines).includes("! Publish and start refused: The draft is at revision 3, not 2."));
    assert.ok(!texts(shown.lines).some(line => line.startsWith("ctrl-")), "no action is offered for the old revision");
    assert.equal(shown.hint, "ctrl-l review it as it is now · Esc back");
    assert.equal(modalOf(h.store).inputs, '{"repo": "a"}');

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(h.store), change);
    assert.equal(modalOf(h.store).type, "workflowPublish");
    assert.equal(h.sent().length, 1);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RELOAD);
    assert.equal(statusOf(h.store), "Reviewing revision 3 as it is now");
    shown = review(h.store);
    assert.equal(shown.title, "Start · revision 3");
    // Review 19:27Z (row 26): no hash in the TUI.
    assert.ok(!texts(shown.lines).some(line => line.startsWith("Definition hash")));
    assert.equal(shown.inputs, '{"repo": "a"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RELOAD);
    assert.equal(statusOf(h.store), "This review already shows the workflow as it is now");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(modalOf(h.store).title, "Start Revision 3");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first, second] = h.sent();
    assert.deepEqual(without(second, "operation_id"), { operation: "publish_and_start", expected_revision: 3, definition_hash: hashOf(3), inputs: { repo: "a" } });
    assert.notEqual(second.operation_id, first.operation_id);
    assert.equal(statusOf(h.store), "Started revision 3.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
});

test("a draft published elsewhere while the review is open: nothing is sent for the draft; ctrl-l reviews the published definition, and ctrl-r starts its live run", async () => {
    const h = await reviewing(workflow(), [accepted("start", 2, LIVE)]);
    const view = modalOf(h.store).returnModal;
    h.serve(workflow({ state: "published" }));
    await h.controller.ensureWorkflowReadModel("wf", { force: true });
    const change = "Someone else made revision 2 final meanwhile, so nothing is sent for this form. ctrl-l shows the Workflow as it is now.";
    assert.ok(joined(review(h.store).lines).includes(change));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(statusOf(h.store), change);
    assert.deepEqual(h.sent(), []);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RELOAD);
    assert.equal(statusOf(h.store), "Reviewing revision 2 as it is now");
    const shown = review(h.store);
    assert.equal(shown.title, "Start · revision 2");
    assert.deepEqual(texts(shown.lines).slice(0, 3), ["Definition: watch-v2 1.0.0", "Revision: 2",
        "Effects: Real, once it starts"]);
    assert.ok(joined(shown.lines).includes("Start runs this revision with real effects."));
    assert.ok(texts(shown.lines).includes("ctrl-r Start"));
    assert.equal(shown.hint, "ctrl-r start · Tab inputs/variables · Esc back — each asks first");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_PUBLISH);
    assert.equal(statusOf(h.store), "Only Start is offered: it starts this revision.");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    const confirm = modalOf(h.store);
    assert.deepEqual([confirm.title, confirm.confirmLabel], ["Start Revision 2", "Start"]);
    assert.equal(confirm.message, `Start revision 2 of watch-v2 1.0.0 with inputs {}? Its effects are real.`);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    assert.match(first.operation_id, /^ui-start-./);
    assert.deepEqual(without(first, "operation_id"), { operation: "start", definition_hash: hashOf(2), inputs: {} });
    assert.equal(statusOf(h.store), "Started revision 2.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
});

test("a refusal keeps what was typed, with the schema's problems; while a command is sent nothing else is; an answer that never came is sent again as itself", async () => {
    let lose;
    const h = await reviewing(workflow(), [
        refused(422, "WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.", [{ path: "/repo", message: "must be string" }]),
        () => new Promise((_, reject) => { lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); }),
        accepted("publish_and_start", 2, LIVE),
    ]);
    const view = modalOf(h.store).returnModal;
    clear(h);
    type(h, '{"repo": 5}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const schema = "Publish and start refused: Workflow inputs do not match inputs.schema. /repo: must be string.";
    assert.equal(statusOf(h.store), schema);
    assert.equal(modalOf(h.store).type, "workflowPublish");
    assert.equal(modalOf(h.store).inputs, '{"repo": 5}');
    assert.ok(joined(review(h.store).lines).includes(`! ${schema}`));

    clear(h);
    type(h, '{"repo": "five"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    const confirming = h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    let shown = review(h.store);
    assert.equal(modalOf(h.store).type, "workflowPublish", "the review shows the command being sent");
    assert.equal(shown.busy, true);
    assert.ok(texts(shown.lines).includes("ctrl-r Starting…"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(statusOf(h.store), "Start is not available now. This command is being sent.");
    assert.equal(h.sent().length, 2);

    lose();
    await confirming;
    const lost = "Publish and start may not have reached the Workflow: upstream unavailable. Retry sends the same command again.";
    assert.equal(statusOf(h.store), lost);
    assert.equal(modalOf(h.store).error, null, "the review's own earlier message gives way to the notice");
    shown = review(h.store);
    assert.ok(joined(shown.lines).includes(`! ${lost}`));
    assert.ok(joined(shown.lines).includes("The same key sends the same command again once you confirm it; the server applies it once."));
    assert.equal(shown.inputs, '{"repo": "five"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first, second, third] = h.sent();
    assert.notEqual(second.operation_id, first.operation_id);
    assert.deepEqual(third, second, "the same command, with the same operation id");
    assert.equal(statusOf(h.store), "Started revision 2.");
    assert.deepEqual(modalOf(h.store), view);
    await settle();
});

test("Esc closes the review back to the view; nothing is sent", async () => {
    const h = await reviewing(workflow());
    const view = modalOf(h.store).returnModal;
    type(h, "x");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), view);
    assert.equal(statusOf(h.store), "Closed the Start form");
    assert.deepEqual(h.sent(), []);
});

test("the review's pin, its change and its confirm text", () => {
    const draftModel = { state: "draft", name: "watch-v2", semver: "1.0.0", revision: 4, definitionHash: hashOf(4), publishedRevision: null,
        publishedDefinitionHash: null, controls: [] };
    const publishedModel = { ...draftModel, state: "published", publishedRevision: 4, publishedDefinitionHash: hashOf(4) };
    assert.equal(workflowPublicationPin(null), null);
    assert.deepEqual(workflowPublicationPin(draftModel), { state: "draft", revision: 4, definitionHash: hashOf(4) });
    assert.deepEqual(workflowPublicationPin(publishedModel), { state: "published", revision: 4, definitionHash: hashOf(4) });
    assert.equal(workflowPublicationChange(workflowPublicationPin(draftModel), draftModel), null);
    assert.equal(workflowPublicationChange(workflowPublicationPin(draftModel), null),
        "The Workflow can no longer be started here, so nothing is sent. Esc goes back.");
    assert.match(workflowPublicationChange(null, draftModel), /^The Workflow now shows revision 4; /);
    const big = workflowPublicationConfirm("publish_and_start", workflowPublicationPin(draftModel), draftModel, { inputs: { text: "x".repeat(400) } });
    const quoted = big.message.slice(big.message.indexOf("with inputs ") + "with inputs ".length, big.message.indexOf("? This revision"));
    assert.equal(quoted.length, 160);
    assert.ok(quoted.endsWith("…"));
    assert.ok(!big.message.includes("initial variables"), "no variables, none named");
});

// Review UI-D11: the terminal's visible words say Start, YAML editor and definition, never draft or publish: the status
// after a Start confirmation is canceled, after Start, and the whole help.
test("UI-D11: canceling Start says 'Start was not sent'; the help has no draft or publish words", async () => {
    const h = await reviewing(workflow(), [accepted("publish_and_start", 2, LIVE)]);
    clear(h);
    type(h, '{"repo": "pilotswarm"}');
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    assert.equal(modalOf(h.store).type, "confirm");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(statusOf(h.store), "Start was not sent");
    assert.deepEqual(h.sent(), []);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_PUBLICATION_RUN);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(statusOf(h.store), "Started revision 2.");
    assert.doesNotMatch(statusOf(h.store), /publish|draft/i);
    const help = JSON.stringify(selectHelpModal(appReducer(h.store.getState(), { type: "ui/modal", modal: { type: "help" } }), 200).rows);
    assert.ok(help.includes("a definition you may change: C compares two versions of its YAML"), "the Compare entry");
    assert.doesNotMatch(help, /draft|publish/i);
});

// Review UI-F6: the status after saving YAML, valid or not, says the definition was saved and, with errors, that it cannot
// be started; no draft or publish words.
test("UI-F6: a YAML save's status says 'Saved the definition', and an invalid one 'cannot be started'", async () => {
    const { workflowV2RunCommandAccepted } = await import("../src/workflow-v2-commands.js");
    const valid = workflowV2RunCommandAccepted("replace_definition", null, { revision: 4, valid: true, diagnostics: [] });
    const invalid = workflowV2RunCommandAccepted("replace_definition", null, { revision: 5, valid: false,
        diagnostics: [{ severity: "error", message: "x" }, { severity: "warning", message: "y" }] });
    const replayed = workflowV2RunCommandAccepted("replace_definition", null, { revision: 4, valid: true, replayed: true });
    assert.equal(valid, "Saved the definition as revision 4.");
    assert.equal(invalid, "Saved the definition as revision 5. It has 1 error, so it cannot be started until they are fixed.");
    assert.equal(replayed, "Saved the definition as revision 4. It had already been accepted.");
    for (const text of [valid, invalid, replayed]) assert.doesNotMatch(text, /draft|publish/i);
});

