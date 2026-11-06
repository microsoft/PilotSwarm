/**
 * Workflow Simplified, Run again in stage 1 (W8; owner feedback 2026-11-06: "why can't it create another workflow from the
 * same definition??"). On the tested engine a Workflow is a workflow child with one live run, so another Workflow from a
 * definition is the same YAML spawned again by the session's chat:
 * - the Workflow tab's Start another… asks the chat in one ordinary message that names the definition, the Workflow
 *   whose YAML it repeats, the number the new one gets, how to start it (the same YAML, unchanged; no key or a new one;
 *   never renamed) and the inputs; the person's own draft is not touched;
 * - the new child has the same name, so it is listed under the same definition as the next number (O5); a renamed one
 *   would be a definition of its own, which is why the chat is told not to rename it.
 *
 * Run: node --test test/workflow-simplified-run-again.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { workflowDefinitionsOf, workflowRowTitle, workflowStartAnotherText } from "../src/workflow-owner.js";

const OWNER = "owner-1";
const at = n => 1_800_000_000_000 + n * 60_000;
const workflow = (sessionId, name, n, status = "running") => ({
    sessionId, sessionKind: "workflow", title: `Workflow: ${name}`, status, parentSessionId: OWNER, createdAt: at(n), updatedAt: at(n),
});
const SESSIONS = [
    { sessionId: OWNER, title: "Stock check", status: "idle", createdAt: at(0), updatedAt: at(0) },
    workflow("wf-1", "check-items", 1, "completed"),
    workflow("wf-2", "check-items", 2, "running"),
];
const byIdOf = sessions => Object.fromEntries(sessions.map(session => [session.sessionId, session]));

test("the message names the definition, the Workflow it repeats, the new number, the same YAML unchanged, no key, and the inputs", () => {
    const text = workflowStartAnotherText({ name: "check-items", version: "1.0.0", fromSessionId: "wf-2", fromNumber: 2, nextNumber: 3,
        inputs: { items: ["apple", "cherry"] } });
    assert.equal(text, [
        "Start another Workflow from the definition check-items (version 1.0.0): it is check-items #3.",
        "Call spawn_workflow with the same YAML as check-items #2, unchanged: the same metadata.name and version. Pass no key, or a new key. "
            + "Do not rename the definition.",
        "If you do not have that YAML, read it with read_workflow (workflow_id wf-2, include_yaml true).",
        "Start it as the first one was started (for version 2: state published and start true).",
        'Inputs: {"items":["apple","cherry"]}',
    ].join("\n"));
    assert.match(workflowStartAnotherText({ name: "check-items", inputs: {} }), /\nIt takes no inputs\.$/);
    assert.match(workflowStartAnotherText({ name: "check-items" }), /\nUse the same inputs as before\.$/);
    assert.match(workflowStartAnotherText({ name: "check-items", inputs: {}, vars: { limit: 3 } }), /\nVariables: \{"limit":3\}$/);
    assert.match(workflowStartAnotherText({}), /^Start another Workflow from the definition workflow\./);
});

test("Start another… sends one message to the session's chat, keeps the person's draft and says what it asked", async () => {
    const sent = [];
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const controller = new PilotSwarmUiController({ store, transport: {
        sendMessage: async (...args) => { sent.push(args); },
        getSessionEvents: async () => [],
        getSessionEventsBefore: async () => [],
    } });
    store.dispatch({ type: "sessions/loaded", sessions: SESSIONS });
    store.dispatch({ type: "sessions/selected", sessionId: OWNER });
    controller.setPrompt("my own words", 12);
    const result = await controller.startAnotherWorkflow("wf-2", { inputs: { n: 1 } });
    assert.deepEqual(result, { ok: true, parentSessionId: OWNER });
    assert.equal(sent.length, 1);
    const [to, text, options] = sent[0];
    assert.equal(to, OWNER);
    assert.deepEqual(options, { enqueueOnly: true });
    assert.match(text, /^Start another Workflow from the definition check-items: it is check-items #3\.\n/);
    assert.ok(text.includes("Call spawn_workflow with the same YAML as check-items #2, unchanged"), text);
    assert.ok(text.includes("workflow_id wf-2, include_yaml true"), text);
    assert.ok(text.endsWith('Inputs: {"n":1}'), text);
    assert.equal(store.getState().ui.prompt, "my own words", "the person's draft is not touched");
    assert.equal(store.getState().ui.statusText, "Asked the chat to start check-items #3.");

    // A connection that cannot send messages refuses in words; nothing is sent.
    const quiet = new PilotSwarmUiController({ store, transport: {} });
    const refused = await quiet.startAnotherWorkflow("wf-2", {});
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "This connection cannot send messages.");
    assert.equal(sent.length, 1);
});

test("the Workflow the chat starts with the same YAML is listed under the same definition as the next number; a renamed one is not", () => {
    const again = [...SESSIONS, workflow("wf-3", "check-items", 3, "running")];
    const definitions = workflowDefinitionsOf(byIdOf(again), OWNER);
    assert.equal(definitions.length, 1);
    assert.deepEqual(definitions[0].workflows, [{ sessionId: "wf-1", number: 1 }, { sessionId: "wf-2", number: 2 }, { sessionId: "wf-3", number: 3 }]);
    assert.equal(workflowRowTitle(byIdOf(again), byIdOf(again)["wf-3"]), "check-items #3");
    // The owner's case: "spawn another one" renamed the definition (dad-joke-every-30-seconds-2), so it became its own.
    const renamed = [...SESSIONS, workflow("wf-r", "check-items-2", 3, "running")];
    assert.deepEqual(workflowDefinitionsOf(byIdOf(renamed), OWNER).map(item => [item.name, item.workflows.length]),
        [["check-items-2", 1], ["check-items", 2]]);
});
