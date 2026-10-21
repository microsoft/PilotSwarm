/**
 * Session PRECHECK selector: the read-only text, the inline control, and the
 * controller action that sends the owner's or admin's choice with the
 * schedule revision.
 *
 * Run: node --test test/cron-precheck-selector.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appReducer, createInitialState, createStore, PilotSwarmUiController } from "../src/index.js";
import { CronPrecheckControl, describeCronPrecheck } from "../../react/src/web-app.js";

const SESSION = {
    sessionId: "s1",
    cronActive: true,
    cronKind: "interval",
    cronInterval: 300,
    cronPrecheck: "queue",
    cronPrecheckSource: "agent",
    cronRevision: 2,
    cronPrecheckOptions: [{ name: "queue", kind: "worker" }, { name: "pkg-queue", kind: "package" }],
};

test("PRECHECK text: name or None, operator source and a broken streak; nothing without an interval cron", () => {
    assert.equal(describeCronPrecheck(SESSION), "queue");
    assert.equal(describeCronPrecheck({ ...SESSION, cronPrecheck: undefined }), "None");
    assert.equal(
        describeCronPrecheck({ ...SESSION, cronPrecheckSource: "operator", cronPrecheckHealth: { outcome: "timeout", since: 1, count: 3 } }),
        "queue · set by operator · broken: timeout ×3",
    );
    assert.equal(describeCronPrecheck({ ...SESSION, cronActive: false }), null);
    assert.equal(describeCronPrecheck({ ...SESSION, cronKind: "wall-clock" }), null);
    assert.equal(describeCronPrecheck({ ...SESSION, isGroup: true }), null);
});

test("the control lists None plus the session's own options, and is read-only without a handler", () => {
    const html = renderToStaticMarkup(React.createElement(CronPrecheckControl, { session: SESSION, onApply: () => {} }));
    assert.match(html, /<select[^>]*aria-label="Precheck"/);
    assert.match(html, /<option value="">None<\/option>/);
    assert.match(html, /<option value="queue" selected="">queue<\/option>/);
    assert.match(html, /<option value="pkg-queue">pkg-queue \(package\)<\/option>/);

    const readOnly = renderToStaticMarkup(React.createElement(CronPrecheckControl, { session: SESSION, onApply: null }));
    assert.doesNotMatch(readOnly, /<select/);
    assert.match(readOnly, />queue</);

    const off = renderToStaticMarkup(React.createElement(CronPrecheckControl, { session: { ...SESSION, cronActive: false }, onApply: () => {} }));
    assert.doesNotMatch(off, /<select/);
});

function controllerFor(session, transport) {
    const state = createInitialState({ mode: "web" });
    state.sessions.byId = { [session.sessionId]: session };
    state.sessions.activeSessionId = session.sessionId;
    return new PilotSwarmUiController({ store: createStore(appReducer, state), transport });
}

test("the controller sends the choice with the schedule revision; None is null", async () => {
    const calls = [];
    const controller = controllerFor(SESSION, {
        setSessionCronPrecheck: async (sessionId, input) => { calls.push([sessionId, input]); return { ok: true, precheck: input.precheck, revision: 3 }; },
    });
    await controller.setSessionCronPrecheckChoice({ sessionId: "s1", precheck: "pkg-queue", reason: " switch to package " });
    await controller.setSessionCronPrecheckChoice({ sessionId: "s1", precheck: null, reason: "off" });
    assert.deepEqual(calls, [
        ["s1", { precheck: "pkg-queue", expectedRevision: 2, reason: "switch to package" }],
        ["s1", { precheck: null, expectedRevision: 2, reason: "off" }],
    ]);
});

test("the controller refuses without a reason or an interval cron, and reports a stale revision", async () => {
    const calls = [];
    const transport = { setSessionCronPrecheck: async () => { calls.push(1); throw Object.assign(new Error("STALE: refresh"), { code: "CONFLICT" }); } };
    const blank = controllerFor(SESSION, transport);
    assert.equal(await blank.setSessionCronPrecheckChoice({ sessionId: "s1", precheck: "queue", reason: "  " }), null);
    const off = controllerFor({ ...SESSION, cronKind: "wall-clock" }, transport);
    assert.equal(await off.setSessionCronPrecheckChoice({ sessionId: "s1", precheck: "queue", reason: "x" }), null);
    assert.equal(calls.length, 0);
    const stale = controllerFor(SESSION, transport);
    assert.equal(await stale.setSessionCronPrecheckChoice({ sessionId: "s1", precheck: "queue", reason: "x" }), null);
    assert.match(stale.getState().ui.statusText ?? JSON.stringify(stale.getState().ui), /STALE/);
});
