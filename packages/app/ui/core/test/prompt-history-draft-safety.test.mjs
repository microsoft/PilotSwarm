import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, buildHistoryModel, PilotSwarmUiController, promptDraftForPersistence } from "../src/index.js";

function harness() {
    const actor = { provider: "test", subject: "alice" };
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/context", principal: actor });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s" }, { sessionId: "other" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([{
        sessionId: "s", seq: 1, eventType: "user.message", data: { content: "Historical input", sender: { kind: "user", ...actor } },
    }]) });
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.syncPromptReferenceBrowser = () => {};
    return { store, controller };
}

test("session switch during recall restores original draft, caret and attachments", () => {
    const { store, controller } = harness();
    const image = { kind: "image", filename: "original.png" };
    controller.setPrompt("Unsent original", 3);
    controller.setPromptAttachments([image]);
    controller.recallPromptHistory(-1);
    assert.equal(store.getState().ui.prompt, "Historical input");
    assert.deepEqual(promptDraftForPersistence(store.getState().ui), { prompt: "Unsent original", cursor: 3, attachments: [image] });
    store.dispatch({ type: "sessions/selected", sessionId: "other" });
    controller.setPrompt("Other session draft");
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    assert.equal(store.getState().ui.prompt, "Unsent original");
    assert.equal(store.getState().ui.promptCursor, 3);
    assert.deepEqual(store.getState().ui.promptAttachments, [image]);
    assert.equal(store.getState().ui.promptHistoryNavigation, null);
});

test("attachment add, replace/upload-complete, or remove ends recall and Down never discards the edit", () => {
    for (const edit of ["add", "replace", "remove"]) {
        const { store, controller } = harness();
        controller.setPrompt("Original");
        controller.recallPromptHistory(-1);
        if (edit !== "add") {
            // A historical candidate can acquire attachment state before the
            // completion/removal event; preserve that actual event path.
            const ui = store.getState().ui;
            ui.promptAttachments = [{ kind: "image", filename: "staged.png" }];
        }
        const attachments = edit === "remove" ? [] : [{ kind: "image", filename: edit === "replace" ? "uploaded.png" : "new.png" }];
        controller.setPromptAttachments(attachments);
        assert.equal(store.getState().ui.promptHistoryNavigation, null);
        assert.equal(controller.recallPromptHistory(1), false);
        assert.equal(store.getState().ui.prompt, "Historical input");
        assert.deepEqual(store.getState().ui.promptAttachments, attachments);
    }
});
