/**
 * G1 residual: a done or cancel is marked on its session (session.end_requested) before it is queued. The transcript and
 * the activity views (portal and TUI, both ui/core) show no row for the mark, and never its raw event type; the command
 * and the end still show as before.
 *
 * Run: node --test ui/core/test/session-end-mark-history.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendEventToHistory, buildHistoryModel } from "../src/history.js";

const T = Date.parse("2026-11-09T12:00:00.000Z");
const ev = (seq, eventType, data = {}) => ({ sessionId: "s1", seq, eventType, data, createdAt: new Date(T + seq * 1000).toISOString() });
const events = [
    ev(1, "user.message", { content: "Summarize the build." }),
    ev(2, "assistant.message", { content: "Working on it." }),
    ev(3, "session.end_requested", { cmd: "done", id: "done-1", requestedBy: "parent-1" }),
    ev(4, "session.command_received", { cmd: "done" }),
];

test("an end's mark adds no transcript or activity row, and its event type never shows; the command still does", () => {
    const history = buildHistoryModel(events);
    const text = JSON.stringify({ chat: history.chat, activity: history.activity });
    assert.doesNotMatch(text, /end_requested|session\.end/);
    assert.match(JSON.stringify(history.activity), /\/done/);
    assert.equal(history.chat.filter(item => item.role === "assistant").length, 1);
    // The live path is the same.
    const live = appendEventToHistory(buildHistoryModel(events.slice(0, 2)), events[2]);
    assert.doesNotMatch(JSON.stringify({ chat: live.chat, activity: live.activity }), /end_requested|session\.end/);
});
