// The canvas app transition (issue 181, L3): the portal client's side of the
// legacy bridge. Pinned here:
//   1. only a page whose draw recorded no trust, or flagged an old app's page,
//      asks for the server's label, and only while the switch is on; owner
//      and agent pages never ask, even when flagged;
//   2. the label decides, never the flag: a missing operation, an error, an
//      answer for another revision or a legacy answer without the recorded
//      page is a failure (sealed); "not legacy" is an answer (wrapped);
//   3. one read per session, slot, revision and recorded page; only Retry
//      (force) reads the same key again; a new revision or page is a new key;
//   4. a label is kept only for the revision and page it answered.
import test from "node:test";
import assert from "node:assert/strict";

import { appReducer, createInitialState, createStore, PilotSwarmUiController } from "../src/index.js";
import { canvasEntryNeedsLegacyLabel, canvasLegacyLabelKey } from "../src/state.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function stateWithSession(id = "s1") {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: id, title: "One", status: "running" }] });
    return appReducer(state, { type: "sessions/selected", sessionId: id });
}

const entry = (state, key = "s1") => state.canvas.bySessionId[key];
const draw = (state, data, slot = 1) => appReducer(state, { type: "canvas/updated", sessionId: "s1", slot, rev: 1, sizeBytes: 10, ...data });

test("which entries ask for the label", () => {
    const base = { latestRev: 3, trust: "cross-owner", trustRecorded: false, legacyFlag: false };
    assert.equal(canvasEntryNeedsLegacyLabel(base, true), true, "drawn before the registry");
    assert.equal(canvasEntryNeedsLegacyLabel({ ...base, trustRecorded: true, legacyFlag: true }, true), true, "an old app's page");
    assert.equal(canvasEntryNeedsLegacyLabel({ ...base, trustRecorded: true }, true), false, "another user's registry page");
    assert.equal(canvasEntryNeedsLegacyLabel(base, false), false, "switch off");
    assert.equal(canvasEntryNeedsLegacyLabel(base, "true"), false, "only a real true");
    for (const trust of ["owner", "agent"]) {
        assert.equal(canvasEntryNeedsLegacyLabel({ ...base, trust, legacyFlag: true }, true), false, `${trust} never asks`);
    }
    assert.equal(canvasEntryNeedsLegacyLabel({ ...base, trust: undefined }, true), false, "unclassified waits for its draw event");
    assert.equal(canvasEntryNeedsLegacyLabel({ ...base, latestRev: 0 }, true), false);
    assert.equal(canvasEntryNeedsLegacyLabel(null, true), false);
    assert.equal(canvasLegacyLabelKey({ latestRev: 3, pageSha256: SHA_A }), `3:${SHA_A}`);
    assert.equal(canvasLegacyLabelKey({ latestRev: 3 }), "3:");
});

test("the draw records whether it had a trust and whether it flagged an old app's page", () => {
    let state = draw(stateWithSession(), {});
    assert.equal(entry(state).trust, "cross-owner");
    assert.equal(entry(state).trustRecorded, false);
    assert.equal(entry(state).legacyFlag, false);
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 2, trust: "cross-owner", legacy: true, pageSha256: SHA_A });
    assert.equal(entry(state).trustRecorded, true);
    assert.equal(entry(state).legacyFlag, true);
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 3, trust: "owner", legacy: "yes" });
    assert.equal(entry(state).legacyFlag, false, "only a real true flags");
    assert.equal(state.canvas.legacyMode, false, "the switch is off unless the server says on");
    state = appReducer(state, { type: "canvas/legacyMode", legacyMode: true });
    assert.equal(state.canvas.legacyMode, true);
});

test("a label is stored only for the revision and page it answered", () => {
    let state = draw(stateWithSession(), { pageSha256: SHA_A });
    const key = `1:${SHA_A}`;
    const label = { rev: 1, legacy: true, failed: false, pageSha256: SHA_A };
    const wrong = appReducer(state, { type: "canvas/legacyLabel", sessionId: "s1", slot: 1, key: `1:${SHA_B}`, label });
    assert.equal(wrong, state, "another page's label is ignored");
    state = appReducer(state, { type: "canvas/legacyLabel", sessionId: "s1", slot: 1, key, label });
    assert.deepEqual(entry(state).legacyLabel, { key, rev: 1, legacy: true, failed: false, pageSha256: SHA_A });
    // A re-read of the same draw (snapshot after a continuity break) keeps it.
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", slot: 1, rev: 1, sizeBytes: 10, pageSha256: SHA_A });
    assert.equal(entry(state).legacyLabel?.key, key, "same revision and page: kept");
    // A seed at the same revision keeps it; one that raises it drops it.
    state = appReducer(state, { type: "canvas/seed", entries: [{ sessionId: "s1", slot: 1, latestRev: 1, sizeBytes: 10 }] });
    assert.equal(entry(state).legacyLabel?.key, key);
    const raised = appReducer(state, { type: "canvas/seed", entries: [{ sessionId: "s1", slot: 1, latestRev: 2, sizeBytes: 10 }] });
    assert.equal(entry(raised).legacyLabel, undefined, "a new revision has no label");
    assert.equal(entry(raised).legacyFlag, undefined);
    // A new draw drops it.
    const redrawn = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 2, sizeBytes: 10, pageSha256: SHA_A });
    assert.equal(entry(redrawn).legacyLabel, null);
    // Clearing (Retry) sets null.
    const cleared = appReducer(state, { type: "canvas/legacyLabel", sessionId: "s1", slot: 1, key, label: null });
    assert.equal(entry(cleared).legacyLabel, null);
});

function controllerWith(state, label) {
    const calls = [];
    const transport = {
        listSessions: async () => [], subscribeSession: () => () => {}, getCurrentUserProfile: async () => ({ profileSettings: {} }),
        stop: async () => {},
    };
    if (label !== undefined) {
        transport.getCanvasRevisionLabel = async (args) => {
            calls.push(args);
            return typeof label === "function" ? label(args, calls.length) : label;
        };
    }
    const c = new PilotSwarmUiController({ store: createStore(appReducer, state), transport });
    return { c, calls };
}

const on = (state) => appReducer(state, { type: "canvas/legacyMode", legacyMode: true });

test("a page drawn before the registry: one read, legacy with the exact page", async () => {
    const { c, calls } = controllerWith(on(draw(stateWithSession(), {})), { sessionId: "s1", slot: 1, rev: 1, trust: "cross-owner", legacy: true, pageSha256: SHA_A });
    await c.ensureCanvasLegacyLabel("s1", 1);
    assert.deepEqual(calls, [{ sessionId: "s1", slot: 1 }]);
    assert.deepEqual(entry(c.getState()).legacyLabel, { key: "1:", rev: 1, legacy: true, failed: false, pageSha256: SHA_A });
    await c.ensureCanvasLegacyLabel("s1", 1);
    await c.ensureCanvasLegacyLabel("s1", 1);
    assert.equal(calls.length, 1, "one read per key");
    await c.ensureCanvasLegacyLabel("s1", 1, { force: true });
    assert.equal(calls.length, 2, "Retry reads again");
});

test("owner and agent pages never call the label, even when flagged; switch off never calls", async () => {
    for (const trust of ["owner", "agent"]) {
        const { c, calls } = controllerWith(on(draw(stateWithSession(), { trust, legacy: true, pageSha256: SHA_A })), { rev: 1, legacy: true, pageSha256: SHA_A });
        await c.ensureCanvasLegacyLabel("s1", 1);
        await c.ensureCanvasLegacyLabel("s1", 1, { force: true });
        assert.equal(calls.length, 0, trust);
        assert.equal(entry(c.getState()).legacyLabel, null);
    }
    const { c, calls } = controllerWith(draw(stateWithSession(), {}), { rev: 1, legacy: true, pageSha256: SHA_A });
    await c.ensureCanvasLegacyLabel("s1", 1);
    assert.equal(calls.length, 0, "switch off");
    // Another user's registry page (trust recorded, not flagged) asks nothing.
    const reg = controllerWith(on(draw(stateWithSession(), { trust: "cross-owner", pageSha256: SHA_A })), { rev: 1, legacy: true, pageSha256: SHA_A });
    await reg.c.ensureCanvasLegacyLabel("s1", 1);
    assert.equal(reg.calls.length, 0);
});

test("anything the portal cannot confirm seals the page; not legacy is an answer", async () => {
    const flagged = on(draw(stateWithSession(), { trust: "cross-owner", legacy: true, pageSha256: SHA_A }));
    const cases = [
        ["no operation", undefined, { legacy: false, failed: true }],
        ["the operation throws", () => { throw new Error("facts down"); }, { legacy: false, failed: true }],
        ["no answer", null, { legacy: false, failed: true }],
        ["another revision", { rev: 2, legacy: true, pageSha256: SHA_A }, { legacy: false, failed: true }],
        ["legacy without a page", { rev: 1, legacy: true }, { legacy: false, failed: true }],
        ["legacy with a malformed page", { rev: 1, legacy: true, pageSha256: "abc" }, { legacy: false, failed: true }],
        ["legacy for other bytes than the draw recorded", { rev: 1, legacy: true, pageSha256: SHA_B }, { legacy: false, failed: true }],
        ["not legacy", { rev: 1, legacy: false, pageSha256: SHA_A }, { legacy: false, failed: false }],
        ["legacy, the recorded page", { rev: 1, legacy: true, pageSha256: SHA_A }, { legacy: true, failed: false }],
    ];
    for (const [name, answer, expected] of cases) {
        const { c } = controllerWith(flagged, answer);
        await c.ensureCanvasLegacyLabel("s1", 1);
        const label = entry(c.getState()).legacyLabel;
        assert.equal(label?.legacy, expected.legacy, name);
        assert.equal(label?.failed, expected.failed, name);
        assert.equal(label?.pageSha256, expected.legacy ? SHA_A : null, name);
    }
});

test("a card changed after the draw: a new revision is a new key and is read again", async () => {
    const answers = [
        { rev: 1, legacy: true, pageSha256: SHA_A },
        { rev: 2, legacy: false, pageSha256: SHA_B },
    ];
    const { c, calls } = controllerWith(on(draw(stateWithSession(), { trust: "cross-owner", legacy: true, pageSha256: SHA_A })), (_args, n) => answers[n - 1]);
    await c.ensureCanvasLegacyLabel("s1", 1);
    assert.equal(entry(c.getState()).legacyLabel.legacy, true);
    c.dispatch({ type: "canvas/updated", sessionId: "s1", slot: 1, rev: 2, sizeBytes: 10, trust: "cross-owner", legacy: true, pageSha256: SHA_B });
    assert.equal(entry(c.getState()).legacyLabel, null, "the old label does not stand for the new page");
    await c.ensureCanvasLegacyLabel("s1", 1);
    assert.equal(calls.length, 2);
    assert.equal(entry(c.getState()).legacyLabel.legacy, false);
    assert.equal(entry(c.getState()).legacyLabel.key, `2:${SHA_B}`);
});

test("a dropped label is put back from the record, with no second read", async () => {
    const { c, calls } = controllerWith(on(draw(stateWithSession(), {})), { rev: 1, legacy: true, pageSha256: SHA_A });
    await c.ensureCanvasLegacyLabel("s1", 1);
    c.dispatch({ type: "canvas/legacyLabel", sessionId: "s1", slot: 1, key: "1:", label: null });
    assert.equal(entry(c.getState()).legacyLabel, null);
    await c.ensureCanvasLegacyLabel("s1", 1);
    assert.equal(calls.length, 1);
    assert.equal(entry(c.getState()).legacyLabel?.legacy, true);
});

test("slots are separate keys; a read in flight at stop writes nothing", async () => {
    let state = on(draw(stateWithSession(), {}));
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", slot: 2, rev: 1, sizeBytes: 10 });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { c, calls } = controllerWith(state, async ({ slot }) => { await gate; return { rev: 1, slot, legacy: true, pageSha256: SHA_A }; });
    const one = c.ensureCanvasLegacyLabel("s1", 1);
    const two = c.ensureCanvasLegacyLabel("s1", 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((call) => call.slot), [1, 2]);
    await c.stop();
    release();
    await Promise.all([one, two]);
    assert.equal(entry(c.getState()).legacyLabel, null, "no write after stop");
    assert.equal(entry(c.getState(), "s1#2").legacyLabel, null);
});
