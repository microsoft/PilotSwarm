import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, PilotSwarmUiController, buildHistoryModel } from "../src/index.js";

const actor = { provider: "test", subject: "alice" };
const image = { kind: "image", filename: "draft.png" };
function harness() {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/context", principal: actor });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s" }, { sessionId: "other" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([1, 2].map(seq => ({
        sessionId: "s", seq, eventType: "user.message",
        data: { content: `executed ${seq}`, sender: { kind: "user", ...actor } },
    }))) });
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.syncPromptReferenceBrowser = () => {};
    const pending = controller.buildOutboxItem("pending", "pending");
    const queued = controller.buildOutboxItem("queued", "queued");
    controller.setSessionOutboxItems("s", [pending, queued]);
    controller.setPrompt("unsent", 2);
    controller.setPromptAttachments([image]);
    return { store, controller, pending, queued, state: () => store.getState(),
        arrow: direction => controller.movePromptCursorVertical(direction) };
}

test("outbox precedes executed history and Down reverses the complete path to the text/caret/attachment stash", () => {
    const h = harness();
    for (const text of ["queued", "pending", "executed 2", "executed 1"]) {
        h.arrow(-1);
        assert.equal(h.state().ui.prompt, text);
        assert.equal(h.state().ui.promptAttachments.length, 0);
        assert.equal(Boolean(h.state().ui.promptEdit), ["queued", "pending"].includes(text));
    }
    for (const text of ["executed 2", "pending", "queued", "unsent"]) {
        h.arrow(1);
        assert.equal(h.state().ui.prompt, text);
    }
    assert.equal(h.state().ui.promptCursor, 2);
    assert.deepEqual(h.state().ui.promptAttachments, [image]);
    assert.equal(h.state().ui.promptEdit, null);
    assert.equal(h.state().ui.promptHistoryNavigation, null);
});

test("queue navigation does not require an attributed history viewer", () => {
    const h = harness();
    h.store.dispatch({ type: "auth/context", principal: null });
    h.arrow(-1);
    assert.equal(h.state().ui.promptEdit.itemId, h.queued.id);
    assert.equal(h.state().ui.promptEdit.phase, "queued");
});

test("accepted queued message identities are not visited twice across the queue/history boundary", () => {
    const h = harness();
    h.controller.recordAcceptedPrompt("s", h.queued.text, h.queued.clientMessageIds.map(id => `message:${id}`), actor);
    h.arrow(-1);
    h.arrow(-1);
    h.arrow(-1);
    assert.equal(h.state().ui.prompt, "executed 2");
});

test("editing history ends the bridge without changing queue items or restoring the old stash", () => {
    const h = harness();
    h.arrow(-1);
    h.arrow(-1);
    h.arrow(-1);
    h.controller.setPrompt("edited history");
    h.arrow(1);
    assert.equal(h.state().ui.prompt, "edited history");
    assert.equal(h.state().ui.promptHistoryNavigation, null);
    assert.deepEqual(h.controller.getSessionOutbox("s").map(item => item.text), ["pending", "queued"]);
    h.arrow(-1);
    assert.equal(h.state().ui.promptEdit.itemId, h.queued.id);
    h.arrow(1);
    assert.equal(h.state().ui.prompt, "edited history");
});

for (const steps of [1, 3]) {
    test(`switching sessions after ${steps} recalls preserves the original draft and attachments`, () => {
        const h = harness();
        for (let i = 0; i < steps; i++) h.arrow(-1);
        h.store.dispatch({ type: "sessions/selected", sessionId: "other" });
        h.store.dispatch({ type: "sessions/selected", sessionId: "s" });
        assert.equal(h.state().ui.prompt, "unsent");
        assert.equal(h.state().ui.promptCursor, 2);
        assert.deepEqual(h.state().ui.promptAttachments, [image]);
        assert.equal(h.state().ui.promptEdit, null);
        assert.equal(h.state().ui.promptHistoryNavigation, null);
    });
    test(`an attachment edit after ${steps} recalls ends navigation and survives Down`, () => {
        const h = harness();
        for (let i = 0; i < steps; i++) h.arrow(-1);
        const recalled = h.state().ui.prompt;
        const added = { ...image, filename: "added.png" };
        h.controller.setPromptAttachments([added]);
        h.arrow(1);
        assert.equal(h.state().ui.prompt, recalled);
        assert.deepEqual(h.state().ui.promptAttachments, [added]);
        assert.equal(h.state().ui.promptEdit, null);
        assert.equal(h.state().ui.promptHistoryNavigation, null);
    });
}

test("Down skips queue entries removed while history was selected and never recreates them", () => {
    const h = harness();
    h.arrow(-1);
    h.arrow(-1);
    h.arrow(-1);
    h.controller.setSessionOutboxItems("s", [h.queued]);
    h.arrow(1);
    assert.equal(h.state().ui.promptEdit.itemId, h.queued.id);
    h.arrow(1);
    assert.equal(h.state().ui.prompt, "unsent");
    assert.equal(h.controller.getSessionOutbox("s").length, 1);
});

test("menus and first/last-line boundaries keep priority over queued and executed input", () => {
    const h = harness();
    h.controller.setPrompt("first\nlast");
    assert.equal(h.controller.recallPromptInput(-1), false);
    h.controller.setPromptCursor(0);
    h.store.dispatch({ type: "ui/modal", modal: { type: "help" } });
    assert.equal(h.controller.recallPromptInput(-1), false);
    h.store.dispatch({ type: "ui/modal", modal: null });
    h.controller.setPrompt("@artifact");
    assert.equal(h.controller.recallPromptInput(-1), false);
    assert.equal(h.state().ui.promptEdit, null);
});
