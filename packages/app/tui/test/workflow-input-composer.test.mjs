// The TUI composer of a session in a workflow agent state's subtree (design 03 human-input denial; T115 "no human
// composer", T116 in the TUI): read-only, with the server's reason and the controlling agent, once the server said so;
// an ordinary session's prompt is as before. The server refuses such input whatever the composer shows.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "pilotswarm/ui-core";
import { PromptBar } from "../../ui/react/src/components.js";
import { UiPlatformProvider } from "../../ui/react/src/platform.js";

const REASON = "This session runs a step of a workflow. People cannot send it prompts, answers or steers; message the workflow's parent agent instead.";

function harness() {
    const asked = [];
    const transport = {
        getWorkflowInputPolicy: async (sessionId) => {
            asked.push(sessionId);
            return sessionId === "c1"
                ? { canSendPrompt: false, canAnswer: false, canSteer: false, reason: REASON, workflowSessionId: "wf", controllingSessionId: "r1" }
                : { canSendPrompt: true, canAnswer: true, canSteer: true, reason: null, workflowSessionId: null, controllingSessionId: null };
        },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "r1", title: "Root", status: "idle" },
        { sessionId: "wf", title: "Workflow: review", status: "running", sessionKind: "workflow", parentSessionId: "r1" },
        { sessionId: "c1", title: "Workflow step: review", status: "running", parentSessionId: "wf" },
        { sessionId: "s1", title: "Sub-agent", status: "idle", parentSessionId: "r1" },
    ] });
    return { controller, store, asked };
}

const platform = {
    Lines: ({ lines }) => React.createElement("span", { "data-kind": "readonly" }, lines.map(line => line.text).join("")),
    Input: ({ value, placeholder }) => React.createElement("input", { value, placeholder, readOnly: true }),
};
const render = controller => renderToStaticMarkup(React.createElement(UiPlatformProvider, { platform },
    React.createElement(PromptBar, { controller, rows: 1 })));

test("an agent state's child has a read-only composer with the server's reason and its controlling agent", async () => {
    const { controller, store, asked } = harness();
    store.dispatch({ type: "sessions/selected", sessionId: "c1" });
    // Before it is asked, the composer is as for any session; while the server is asked, it says so instead of offering
    // the message box (owner decision q18).
    assert.match(render(controller), /<input/);
    const pending = controller.ensureWorkflowInputPolicy("c1");
    assert.equal(render(controller), '<span data-kind="readonly">Checking whether you can send messages here…</span>');
    await pending;
    assert.equal(render(controller), `<span data-kind="readonly">${REASON.replace("workflow's", "workflow&#x27;s")} To change this, message Root.</span>`);
    assert.deepEqual(asked, ["c1"]);
});

test("an ordinary session's composer is unchanged, and it is never asked about; a workflow session keeps its own note", async () => {
    const { controller, store, asked } = harness();
    for (const sessionId of ["r1", "s1"]) {
        store.dispatch({ type: "sessions/selected", sessionId });
        await controller.ensureWorkflowInputPolicy(sessionId);
        const html = render(controller);
        assert.match(html, /<input/, sessionId);
        assert.match(html, /Type a message and press Enter/, sessionId);
    }
    // Workflow Simplified (spec 09, S4; 18): selecting a Workflow row keeps its session's chat, so its composer is the chat's.
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    assert.equal(store.getState().sessions.activeSessionId, "r1");
    assert.match(render(controller), /Type a message and press Enter/);
    // A Workflow whose session is not loaded stays active itself, and keeps its own note.
    store.dispatch({ type: "sessions/merged", session: { sessionId: "wf-alone", title: "Workflow: review", status: "running", sessionKind: "workflow",
        parentSessionId: "not-loaded" } });
    store.dispatch({ type: "sessions/selected", sessionId: "wf-alone" });
    assert.equal(store.getState().sessions.activeSessionId, "wf-alone");
    assert.equal(render(controller), '<span data-kind="readonly">Workflow session</span>');
    assert.deepEqual(asked, []);
});

// Adapted from the independent test design 090ad919-r2 (T1, T2a, T2c, T3): what the composer shows follows the session
// shown, from the server's lineage read only (design 03 "Direct human-input denial": the server refuses; UI controls are
// explanatory only; T115, T116). T2a's failure contract of the read stands; what the composer shows meanwhile is the
// owner's decision q18: a "could not check" line instead of the message box, and Enter checks again.
const DENIED = { canSendPrompt: false, canAnswer: false, canSteer: false, reason: REASON, workflowSessionId: "wf", controllingSessionId: "r1" };
const OPEN = { canSendPrompt: true, canAnswer: true, canSteer: true, reason: null, workflowSessionId: null, controllingSessionId: null };

function policyHarness(policyFor) {
    const asked = [];
    const transport = { getWorkflowInputPolicy: async (sessionId) => { asked.push(sessionId); return policyFor(sessionId); } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "r1", title: "Root", status: "idle" },
        { sessionId: "wf", title: "Workflow: review", status: "running", sessionKind: "workflow", parentSessionId: "r1" },
        { sessionId: "c1", title: "Workflow step: review", status: "running", parentSessionId: "wf" },
        { sessionId: "c2", title: "Workflow step: other", status: "running", parentSessionId: "wf" },
        { sessionId: "s1", title: "Sub-agent", status: "idle", parentSessionId: "r1" },
    ] });
    return { controller, store, asked };
}
const recorded = (store, id) => store.getState().ui.workflowInputPolicies?.[id];

test("the read-only composer of a subtree child does not follow the person to the next session, and returning reads nothing again", async () => {
    const { controller, store, asked } = policyHarness(sessionId => (sessionId === "c1" ? DENIED : OPEN));
    store.dispatch({ type: "sessions/selected", sessionId: "c1" });
    await controller.ensureWorkflowInputPolicy("c1");
    assert.match(render(controller), /data-kind="readonly"/);
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.equal(await controller.ensureWorkflowInputPolicy("s1"), null, "s1 is in no workflow's subtree");
    assert.deepEqual(asked, ["c1"], "the server is not asked about s1");
    assert.match(render(controller), /<input/);
    assert.doesNotMatch(render(controller), /People cannot send it prompts/);
    store.dispatch({ type: "sessions/selected", sessionId: "c1" });
    assert.match(render(controller), /data-kind="readonly"/, "c1's recorded policy, without asking again");
    assert.deepEqual(asked, ["c1"]);
});

test("a failed policy read resolves null, records nothing, shows that it could not check instead of the message box, and is read again on the next call", async () => {
    let fail = true;
    const { controller, store, asked } = policyHarness(async () => {
        if (fail) throw Object.assign(new Error("policy unavailable"), { status: 503 });
        return DENIED;
    });
    store.dispatch({ type: "sessions/selected", sessionId: "c1" });
    assert.equal(await controller.ensureWorkflowInputPolicy("c1"), null);
    assert.equal(recorded(store, "c1"), undefined);
    assert.deepEqual(asked, ["c1"]);
    assert.equal(render(controller), '<span data-kind="readonly">Could not check whether you can send messages here. Press Enter to check again.</span>');
    fail = false;
    assert.deepEqual(await controller.ensureWorkflowInputPolicy("c1"), DENIED);
    assert.deepEqual(asked, ["c1", "c1"]);
    assert.equal(recorded(store, "c1").canSendPrompt, false);
    // Words (spec 09, S7; review UI-17): the server's reason first, then the session to message.
    assert.match(render(controller), /data-kind="readonly">This session runs a step of a workflow\..* To change this, message Root\.</);
});

test("concurrent asks for one session share one server read", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { controller, asked } = policyHarness(async () => { await gate; return DENIED; });
    const first = controller.ensureWorkflowInputPolicy("c1");
    const second = controller.ensureWorkflowInputPolicy("c1");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(asked, ["c1"]);
    assert.deepEqual(a, b);
});

test("a late policy answer for a session the person already left changes only that session's record", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { controller, store } = policyHarness(async sessionId => { if (sessionId === "c2") { await gate; return DENIED; } return OPEN; });
    store.dispatch({ type: "sessions/selected", sessionId: "c2" });
    const pending = controller.ensureWorkflowInputPolicy("c2");
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.equal(await controller.ensureWorkflowInputPolicy("s1"), null);
    release();
    await pending;
    assert.match(render(controller), /<input/, "s1 keeps its ordinary composer");
    assert.equal(recorded(store, "s1"), undefined);
    store.dispatch({ type: "sessions/selected", sessionId: "c2" });
    assert.match(render(controller), /data-kind="readonly"/);
});
