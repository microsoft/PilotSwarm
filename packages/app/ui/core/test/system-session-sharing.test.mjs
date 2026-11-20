import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmUiController } from "../src/controller.js";
import { appReducer } from "../src/reducer.js";
import { selectShareSessionModal } from "../src/selectors.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";

const grant = { provider: "dev", subject: "bob", displayName: "Bob", access: "read" };

function harness({ isSystemRow = true, accessSequence = null } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const calls = [];
    let accessReads = 0;
    const transport = {
        getSessionAccess: async () => {
            if (accessSequence) return accessSequence[Math.min(accessReads++, accessSequence.length - 1)];
            return { isSystem: true, systemVisibility: "read", visibility: "private" };
        },
        listSessionShares: async () => [grant],
        revokeSessionShare: async (sessionId, user) => { calls.push(["revoke", sessionId, user]); },
        grantSessionShare: async () => { calls.push(["grant"]); },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    const session = {
        sessionId: "child-of-system",
        title: "System child",
        status: "idle",
        isSystem: isSystemRow,
        visibility: "private",
        createdAt: 1,
        updatedAt: 2,
    };
    store.dispatch({ type: "sessions/loaded", sessions: [session] });
    store.dispatch({ type: "sessions/selected", sessionId: session.sessionId });
    return { controller, store, session, calls };
}

test("a child of a system root inherits the policy and keeps only revocation", async () => {
    const { controller, store, session, calls } = harness({ isSystemRow: false });
    await controller.openShareSessionModal();
    assert.equal(store.getState().ui.modal.isSystem, true, "the access snapshot, not the row flag, controls policy");
    const rendered = selectShareSessionModal(store.getState());
    const details = rendered.detailsLines.flat().map((run) => run.text).join(" ");
    assert.match(details, /General: deployment policy \(readable\)/);
    assert.match(details, /inactive \(read\)/);
    assert.equal(rendered.placeholder, "Existing grant name to revoke (-name)");

    controller.setShareSessionValue("Bob");
    await controller.confirmShareSessionModal();
    assert.deepEqual(calls, [], "a system tree cannot stage a new grant");
    assert.match(store.getState().ui.statusText, /only revocation is allowed/i);

    controller.setShareSessionValue("-Bob");
    await controller.confirmShareSessionModal();
    assert.deepEqual(calls, [["revoke", session.sessionId, { provider: "dev", subject: "bob" }]]);
});

test("an expansion rechecks access immediately before transport", async () => {
    const { controller, store, calls } = harness({
        isSystemRow: false,
        accessSequence: [
            { isSystem: false, systemVisibility: null, visibility: "private" },
            { isSystem: true, systemVisibility: "admin", visibility: "private" },
        ],
    });
    await controller.openShareSessionModal();
    controller.setShareSessionValue("Carol");
    await controller.confirmShareSessionModal();
    assert.deepEqual(calls, []);
    assert.match(store.getState().ui.statusText, /only revocation is allowed/i);
});

test("visibility cycling resolves the tree before sending a change", async () => {
    const { controller, calls } = harness({ isSystemRow: false });
    controller.transport.setSessionVisibility = async () => { calls.push(["visibility"]); };
    await controller.cycleSessionVisibility();
    assert.deepEqual(calls, []);
});

test("an access result for the previous selection cannot open a stale sharing dialog", async () => {
    let resolveAccess;
    const { controller, store } = harness();
    controller.transport.getSessionAccess = () => new Promise((resolve) => { resolveAccess = resolve; });
    const opening = controller.openShareSessionModal();
    store.dispatch({ type: "sessions/selected", sessionId: "another-session" });
    resolveAccess({ isSystem: false, systemVisibility: null, visibility: "private" });
    await opening;
    assert.equal(store.getState().ui.modal, null);
});
