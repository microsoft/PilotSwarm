// Where the preview backs out to depends on how it was OPENED. A chat-opened
// preview must return to the chat pane AND leave the artifact list exactly as
// it was — following a transcript link must not reorganize the Files tab.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { PilotSwarmUiController, createStore } from "../src/index.js";

const base = () => {
    const s = createInitialState();
    return { ...s, files: { ...s.files, selectedArtifactId: "s1/list-pick.md" } };
};

test("chat origin captures the list's selection as the restore point", () => {
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/list-pick.md" });
    assert.equal(state.files.previewOrigin, "chat");
    assert.equal(state.files.restoreArtifactId, "s1/list-pick.md");
});

test("list origin clears any restore point", () => {
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/a.md" });
    state = appReducer(state, { type: "files/previewOrigin", origin: "list" });
    assert.equal(state.files.previewOrigin, "list");
    assert.equal(state.files.restoreArtifactId, null, "a list-opened preview has nothing to restore");
});

test("selecting from chat does not lose the restore point", () => {
    // revealArtifact records the origin, then dispatches files/select. The
    // select must not wipe what we need to restore on the way back.
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/list-pick.md" });
    state = appReducer(state, { type: "files/select", sessionId: "s1", filename: "from-chat.md" });
    assert.equal(state.files.selectedArtifactId, "s1/from-chat.md", "preview moved to the chat artifact");
    assert.equal(state.files.restoreArtifactId, "s1/list-pick.md", "restore point survives");
});

test("clearing the origin drops the restore point", () => {
    let state = base();
    state = appReducer(state, { type: "files/previewOrigin", origin: "chat", restoreArtifactId: "s1/a.md" });
    state = appReducer(state, { type: "files/previewOrigin", origin: null });
    assert.equal(state.files.previewOrigin, null);
    assert.equal(state.files.restoreArtifactId, null);
});

test("fullscreen chat-origin preview on phone keeps chat focus and restores originating mobile pane on close", async () => {
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "One", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "ui/focus", focusRegion: "chat" });
    store.dispatch({ type: "files/select", sessionId: "s1", filename: "list-pick.md" });

    let mobilePane = "workspace";
    controller.mobileView = { get: () => mobilePane, set: (next) => { mobilePane = next; } };

    await controller.revealArtifact("s1", "from-chat.md", { fullscreen: true, preserveSession: true });
    assert.equal(store.getState().files.fullscreen, true);
    assert.equal(store.getState().ui.requestedFocusRegion, "chat", "phone fullscreen overlay must not request inspector focus");
    assert.equal(store.getState().files.restoreMobilePane, "workspace");
    assert.equal(mobilePane, "workspace");

    // Simulate mobilePane having drifted to inspector (e.g. deep link): closing a
    // chat-origin preview restores the recorded originating mobile pane.
    mobilePane = "inspector";
    await controller.closeArtifactPreview();
    assert.equal(store.getState().files.fullscreen, false);
    assert.equal(store.getState().files.selectedArtifactId, "s1/list-pick.md");
    assert.equal(store.getState().ui.focusRegion, "chat");
    assert.equal(mobilePane, "workspace");
});

test("fullscreen reveal on TUI/desktop (no mobileView) still focuses inspector so Esc/j/k work", async () => {
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "One", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "ui/focus", focusRegion: "chat" });

    await controller.revealArtifact("s1", "from-agent.md", { fullscreen: true });
    assert.equal(store.getState().files.fullscreen, true);
    assert.equal(store.getState().ui.focusRegion, "inspector");
    assert.equal(store.getState().ui.requestedFocusRegion, "inspector");
});

test("phone show_artifact opens fullscreen overlay without modifying desktop paneAdjust and restores active mobile pane", async () => {
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.ensureFilesForSession = async () => null;
    controller.ensureFilePreview = async () => null;
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "One", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "ui/inspectorTab", inspectorTab: "sequence" });
    controller.collapseRightColumn();
    const collapsedAdjust = store.getState().ui.layout.paneAdjust;

    let mobilePane = "canvas";
    controller.mobileView = { get: () => mobilePane, set: (next) => { mobilePane = next; } };

    const revealed = controller.maybeRevealPresentedArtifact("s1", {
        eventType: "session.artifact_presented",
        createdAt: new Date().toISOString(),
        data: { filename: "chart.html", fullscreen: false },
    });
    assert.equal(revealed, true);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(store.getState().files.fullscreen, true);
    assert.equal(store.getState().files.paneOpen, false);
    assert.equal(store.getState().ui.layout.paneAdjust, collapsedAdjust, "phone show_artifact must not mutate desktop paneAdjust");
    assert.equal(store.getState().files.restoreMobilePane, "canvas");
    assert.equal(store.getState().files.restoreInspectorTab, "sequence");

    mobilePane = "inspector";
    await controller.closeArtifactPreview();
    assert.equal(mobilePane, "canvas", "closing show_artifact restores the phone pane that was active");
    assert.equal(store.getState().ui.inspectorTab, "sequence", "closing phone show_artifact restores the Diagnostics tab");
});

test("list-origin preview close keeps mobile inspector pane untouched", async () => {
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport: {} });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "One", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "files/select", sessionId: "s1", filename: "list-pick.md" });
    store.dispatch({ type: "files/previewOrigin", origin: "list" });
    store.dispatch({ type: "files/fullscreen", fullscreen: true });

    let mobilePane = "inspector";
    controller.mobileView = { get: () => mobilePane, set: (next) => { mobilePane = next; } };

    await controller.closeArtifactPreview();
    assert.equal(store.getState().files.fullscreen, false);
    assert.equal(store.getState().files.previewOrigin, null);
    assert.equal(mobilePane, "inspector", "list-origin close must stay on the Files inspector pane");
});
