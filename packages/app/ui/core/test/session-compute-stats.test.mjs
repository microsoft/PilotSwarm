import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { PilotSwarmUiController } from "../src/controller.js";
import { selectInspector } from "../src/selectors.js";

async function fixture(execution, error) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({
        store, transport: {
            listSessions: async () => [], subscribeSession: () => () => {},
            getSessionMetricSummary: async () => ({ sessionId: "session" }),
            getSessionComputeExecution: async id => { assert.equal(id, "session"); if (error) throw new Error(error); return execution; },
        },
    });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "session", title: "Fixture", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "session" });
    await controller.ensureSessionStats({ force: true });
    const state = store.getState();
    const selected = selectInspector({ ...state, ui: { ...state.ui, inspectorTab: "stats" } }, { width: 90 });
    return selected.lines.map(line => Array.isArray(line) ? line.map(run => run.text || "").join("") : line.text || "").join("\n");
}

test("shared stats show unknown native authority instead of implying safe takeover", async () => {
    const text = await fixture({ phase: "unknown", pendingOperations: 3, identity: { transcriptEpoch: 2, generation: "generation-fixture" } });
    assert.match(text, /COMPUTE EXECUTION/);
    assert.match(text, /Phase\s+unknown/);
    assert.match(text, /Pending\s+3/);
    assert.match(text, /Epoch\s+2/);
});
test("compute authority errors stay visible while ordinary local sessions add no diagnostic card", async () => {
    assert.match(await fixture(null, "owned authority unavailable"), /Authority unavailable: owned authority unavailable/);
    assert.doesNotMatch(await fixture(null), /Compute Execution/);
});
