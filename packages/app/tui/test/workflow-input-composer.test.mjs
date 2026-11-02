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

const REASON = "This session runs a workflow state. People cannot send it prompts, answers or steers; message the workflow's parent agent instead.";

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
        { sessionId: "c1", title: "Workflow node: review", status: "running", parentSessionId: "wf" },
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
    // Until the server answered, the composer is as for any session (and the server refuses what is sent).
    assert.match(render(controller), /<input/);
    await controller.ensureWorkflowInputPolicy("c1");
    assert.equal(render(controller), `<span data-kind="readonly">${REASON.replace(/'/g, "&#x27;")} Its controlling agent is session r1.</span>`);
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
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    assert.equal(render(controller), '<span data-kind="readonly">Workflow session</span>');
    assert.deepEqual(asked, []);
});
