/**
 * The session stats pane shows the Claude keep-warm pings of a session: the Tokens card has a "Keep-warm Pings" row and
 * a "Keep-warm Cost" row once the session has session.keepwarm_ping events. The controller reads the newest 1,000 of
 * them with the stats and a failed read only drops the two rows.
 *
 * Run: node --test ui/core/test/session-stats-keepwarm.test.mjs (from packages/app)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, selectInspector, PilotSwarmUiController } from "../src/index.js";

const SID = "session-stats-keepwarm";

const lineText = (line) => (Array.isArray(line) ? line.map((run) => run?.text ?? "").join("")
    : typeof line === "string" ? line
        : line?.text ?? (Array.isArray(line?.runs) ? line.runs.map((run) => run?.text ?? "").join("") : ""));

const ping = (ok, totalNanoAiu) => ({ data: { ok, ...(totalNanoAiu === undefined ? {} : { totalNanoAiu }) } });

function setup(transportExtras) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const sessions = [SID, "other-session"].map((sessionId) => ({ sessionId, title: sessionId, status: "idle", createdAt: 1, updatedAt: 1 }));
    store.dispatch({ type: "sessions/loaded", sessions });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const transport = {
        getSessionMetricSummary: async (sessionId) => ({ sessionId, tokensInput: 10, tokensOutput: 5 }),
        ...transportExtras,
    };
    return { store, controller: new PilotSwarmUiController({ store, transport }) };
}

function statsText(store) {
    const state = store.getState();
    const inspector = selectInspector({ ...state, ui: { ...state.ui, inspectorTab: "stats" } }, { width: 90 });
    return inspector.lines.map(lineText).join("\n");
}

async function loadedText(getSessionEvents) {
    const { store, controller } = setup(getSessionEvents ? { getSessionEvents } : {});
    await controller.ensureSessionStats();
    return statsText(store);
}

test("the Tokens card shows the ping count and the cost in AIU", async () => {
    const text = await loadedText(async () => [ping(true, 750000), ping(true, 250000)]);
    assert.match(text, /Keep-warm Pings +2\b/);
    assert.match(text, /Keep-warm Cost +0\.0010 AIU/);
});

test("a failed ping is counted apart", async () => {
    const text = await loadedText(async () => [ping(true, 500000), ping(false, 500000)]);
    assert.match(text, /Keep-warm Pings +1 \(1 failed\)/);
});

test("the cost reads not reported when no ping carried one, and partial when only some did", async () => {
    assert.match(await loadedText(async () => [ping(true), ping(true)]), /Keep-warm Cost +not reported/);
    assert.match(await loadedText(async () => [ping(true, 500000), ping(true)]), /Keep-warm Cost +0\.0005 AIU \(partial\)/);
});

test("a read of exactly 1,000 pings says it covers the newest ones", async () => {
    const text = await loadedText(async () => Array.from({ length: 1000 }, () => ping(true, 100000)));
    assert.match(text, /Keep-warm Pings +1000\+/);
    assert.match(text, /Keep-warm Cost +≥ 0\.1000 AIU \(newest 1,000\)/);
});

test("no keep-warm row without a ping, when the read fails, or when the transport cannot read events", async () => {
    for (const getSessionEvents of [async () => [], async () => { throw new Error("read failed"); }, undefined]) {
        const text = await loadedText(getSessionEvents);
        assert.ok(text.includes("Hit Ratio"), "the other stats are still shown");
        assert.ok(!text.includes("Keep-warm"), "no keep-warm row");
    }
});

test("one load reads the newest ping events of the active session, and sessions do not mix", async () => {
    const calls = [];
    const { store, controller } = setup({
        getSessionEvents: async (...args) => {
            calls.push(args);
            return args[0] === SID ? [ping(true, 100000)] : [];
        },
    });
    await controller.ensureSessionStats();
    assert.deepEqual(calls, [[SID, undefined, 1000, ["session.keepwarm_ping"]]]);
    store.dispatch({ type: "sessions/selected", sessionId: "other-session" });
    await controller.ensureSessionStats();
    const bySessionId = store.getState().sessionStats.bySessionId;
    assert.equal(bySessionId[SID].keepWarm.pings, 1);
    assert.equal(bySessionId["other-session"].keepWarm.pings, 0);
    assert.ok(!statsText(store).includes("Keep-warm"), "the other session shows no row");
});
