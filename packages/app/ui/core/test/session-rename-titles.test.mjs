/**
 * Renamed sessions show in the list as the person typed them.
 *
 * WHY THIS EXISTS: the list used to split a renamed agent session's title on
 * any " - " or ": " the person typed, so "Fix login redirect - follow up"
 * showed as "follow up · Deepwiki: Fix login redirect". The rename box also
 * counted the agent's name against a 60-character limit and stopped taking
 * characters without saying why.
 *
 * Run: node --test test/session-rename-titles.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";
import { PilotSwarmUiController } from "../src/controller.js";
import {
    RENAME_SESSION_MAX_LENGTH,
    getRenameSessionEditableTitle,
    getRenameSessionPrefix,
    selectRenameSessionModal,
    selectSessionRows,
} from "../src/index.js";

function rowFor(title, agentId) {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "aaaabbbb-1111-2222-3333-444444444444", title, agentId, status: "idle", createdAt: 1, updatedAt: 2 }] });
    return (selectSessionRows(store.getState())[0]?.text || "").trim();
}

test("the person's words stay whole and in order after the agent name", () => {
    assert.match(rowFor("Deepwiki: Fix login redirect - follow up", "deepwiki"), /Fix login redirect - follow up · Deepwiki/);
    assert.match(rowFor("Generic-crawler: Phase 2: backfill the October corpus", "generic-crawler"), /Phase 2: backfill the October corpus · Generic-crawler/);
    const long = "Investigate the nightly replication lag regression on the westus3 read replicas";
    assert.match(rowFor(`Kingsley Shacklebolt — Azure Control Plane: ${long}`, "control-plane"), new RegExp(`${long} · Azure Control Plane · Kingsley Shacklebolt`));
});

test("agent names still lead with the title, then the type, then the persona", () => {
    assert.match(rowFor("Mad-Eye Moody - R2D Train Watcher: M61 Conductor", "mad-eye-moody"), /M61 Conductor · R2D Train Watcher · Mad-Eye Moody/);
    assert.match(rowFor("R2D Train Watcher: M61 Conductor · Mad-Eye Moody", "mad-eye-moody"), /M61 Conductor · R2D Train Watcher · Mad-Eye Moody/);
    assert.match(rowFor("Deepwiki: Weekly sync notes", "deepwiki"), /Weekly sync notes · Deepwiki/);
});

test("a title that is not an agent name is shown as it is", () => {
    assert.match(rowFor("UX card wall: Harbor Clerk Arrival Logging", "harbor-clerk"), /^UX card wall: Harbor Clerk Arrival Logging/);
    assert.match(rowFor("Fix login - follow up", "deepwiki"), /^Fix login - follow up/);
    assert.match(rowFor("Release: M70 checklist", undefined), /^Release: M70 checklist/);
});

test("the rename box keeps the agent prefix only when it is the agent's name", () => {
    const smith = { sessionId: "s1", agentId: "agent-manager", title: "Agent Smith: TRON MOTD" };
    assert.equal(getRenameSessionPrefix(smith, ["Agent Smith"]), "Agent Smith");
    assert.equal(getRenameSessionEditableTitle(smith, ["Agent Smith"]), "TRON MOTD");
    const wall = { sessionId: "s2", agentId: "harbor-clerk", title: "UX card wall: Plain new name" };
    assert.equal(getRenameSessionPrefix(wall, ["Harbor Clerk"]), null);
    assert.equal(getRenameSessionEditableTitle(wall, ["Harbor Clerk"]), "UX card wall: Plain new name");
    assert.equal(getRenameSessionPrefix({ sessionId: "s3", agentId: "deepwiki", title: "Deepwiki: x" }), "Deepwiki");
});

function controllerWith(session, agents) {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const transport = {
        listCreatableAgents: async () => agents,
        renameSession: async () => {},
        listSessions: async () => [session],
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [session] });
    store.dispatch({ type: "sessions/selected", sessionId: session.sessionId });
    return { controller, store };
}

test("the rename box takes 100 characters whatever the agent's name, and counts them", async () => {
    const session = { sessionId: "aaaabbbb-1111-2222-3333-444444444444", agentId: "control-plane", title: "Kingsley Shacklebolt — Azure Control Plane: aaaabbbb", status: "idle", createdAt: 1, updatedAt: 2 };
    const { controller, store } = controllerWith(session, [{ name: "control-plane", title: "Kingsley Shacklebolt — Azure Control Plane" }]);
    controller.openRenameSessionModal();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.getState().ui.modal.maxLength, RENAME_SESSION_MAX_LENGTH);
    assert.equal(RENAME_SESSION_MAX_LENGTH, 100);
    controller.setRenameSessionValue("y".repeat(140));
    assert.equal(store.getState().ui.modal.value.length, 100, "the box stops at 100");
    const counter = selectRenameSessionModal(store.getState()).detailsLines.flat().map((run) => run.text).join("");
    assert.match(counter, /100 \/ 100, the limit/);
    controller.setRenameSessionValue("short");
    assert.match(selectRenameSessionModal(store.getState()).detailsLines.flat().map((run) => run.text).join(""), /5 \/ 100(?!,)/);
});

test("the rename box learns a custom agent title from the catalog", async () => {
    const session = { sessionId: "aaaabbbb-1111-2222-3333-444444444445", agentId: "agent-manager", title: "Agent Smith: TRON MOTD", status: "idle", createdAt: 1, updatedAt: 2 };
    const { controller, store } = controllerWith(session, [{ name: "agent-manager", title: "Agent Smith" }]);
    controller.openRenameSessionModal();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const modal = store.getState().ui.modal;
    assert.equal(modal.agentTitlePrefix, "Agent Smith");
    assert.equal(modal.value, "TRON MOTD");
});
