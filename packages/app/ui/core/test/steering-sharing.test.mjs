import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, PilotSwarmUiController, linkSessionSteering } from "../src/index.js";

function controller(transport = {}) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    return new PilotSwarmUiController({ store, transport });
}
const receipt = {
    schemaVersion: 1, sessionId: "s", requestId: "r", clientRequestId: "c", expectedTarget: "t",
    revision: 1, text: "Guidance", disposition: "not_delivered_turn_ended",
    actions: { canSendAsNewMessage: true, canWithdraw: false },
};

test("two panels and main chat share uncertain resend identity and in-flight exclusion after disposal", async () => {
    const calls = [];
    let fail = true;
    let release;
    let entered;
    const retryEntered = new Promise(resolve => { entered = resolve; });
    const transport = {
        getSteeringRequest: async () => receipt,
        sendMessage: async (sessionId, text, options) => {
            calls.push({ sessionId, text, options });
            if (fail) throw new Error("Lost reply");
            await new Promise(resolve => { release = resolve; entered(); });
        },
    };
    const main = controller(transport), panelA = controller(transport), panelB = controller(transport);
    main.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt });
    const disposeA = linkSessionSteering(main, panelA, "s");
    linkSessionSteering(main, panelB, "s");
    await panelA.resendSteering("s", "r");
    const id = calls[0].options.clientMessageIds[0];
    assert.equal(main.getState().steering.bySessionId.s.resends.r.phase, "uncertain");
    assert.equal(panelB.getState().steering.bySessionId.s.resends.r.clientMessageId, id);
    disposeA();
    fail = false;
    const retry = panelB.resendSteering("s", "r");
    await retryEntered;
    await main.resendSteering("s", "r");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.clientMessageIds[0], id);
    release();
    await retry;
    assert.equal(main.getState().steering.bySessionId.s.resends.r.phase, "queued");
});

test("disposed panel's lost steering acknowledgement remains reconcilable in main and another panel", async () => {
    let reject;
    const main = controller(), panel = controller({ steerSessionTurn: () => new Promise((_resolve, no) => { reject = no; }) });
    const dispose = linkSessionSteering(main, panel, "s");
    const request = { text: "Guidance", clientRequestId: "original", expectedTarget: "t", sessionId: "s", inFlight: true };
    panel.dispatch({ type: "steering/submissionStarted", sessionId: "s", request });
    const sending = panel.submitSteeringRequest("s", request);
    dispose();
    reject(new Error("Reply lost after panel removed"));
    await sending;
    assert.equal(main.getState().steering.bySessionId.s.pending.original.inFlight, false);
    const next = controller();
    linkSessionSteering(main, next, "s");
    assert.equal(next.getState().steering.bySessionId.s.pending.original.expectedTarget, "t");
    assert.match(next.getState().steering.bySessionId.s.pending.original.error, /Reply lost/);
});

test("main and linked panels exclude duplicate withdrawal while an acknowledged result survives panel disposal", async () => {
    const result = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const calls = [];
    const transport = {
        withdrawSteeringRequest: async (...args) => { calls.push(args); entered.resolve(); return result.promise; },
    };
    const main = controller(transport), panel = controller(transport), peer = controller(transport);
    const pending = { ...receipt, revision: 1, disposition: "accepted", actions: { canWithdraw: true } };
    main.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt: pending });
    const dispose = linkSessionSteering(main, panel, "s");
    linkSessionSteering(main, peer, "s");
    const withdrawal = panel.withdrawSteering("s", "r");
    await entered.promise;
    dispose();
    await main.withdrawSteering("s", "r");
    await peer.withdrawSteering("s", "r");
    assert.deepEqual(calls, [["s", "r"]]);
    result.resolve({ outcome: "withdrawn", receipt: { ...pending, revision: 2, disposition: "withdrawn", actions: { canWithdraw: false } } });
    await withdrawal;
    assert.equal(main.getState().steering.bySessionId.s.receipts.r.disposition, "withdrawn");
    assert.equal(peer.getState().steering.bySessionId.s.receipts.r.revision, 2);
    assert.equal(main.steeringWithdrawals.size, 0);
});

test("linked panels share access loss without retaining private guidance or stale action grants", () => {
    const main = controller(), panel = controller(), peer = controller();
    main.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt });
    linkSessionSteering(main, panel, "s");
    linkSessionSteering(main, peer, "s");
    panel.dispatch({ type: "steering/accessLost", sessionId: "s" });
    for (const view of [main, panel, peer]) {
        const entry = view.getState().steering.bySessionId.s;
        assert.equal(entry.accessLost, true);
        assert.deepEqual(entry.receipts, {});
        assert.deepEqual(entry.resends, {});
    }
});
