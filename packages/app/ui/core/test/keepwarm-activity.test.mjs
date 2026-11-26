/**
 * The activity feed (portal and TUI, both ui/core) labels the Claude keep-warm heartbeat's events: session.keepwarm_ping
 * as "[keep-warm] ping <n> · <status> · <cached> cached" and session.keepwarm_stopped as
 * "[keep-warm] stopped · <reason> · <n> pings". The transcript ignores both.
 *
 * Run: node --test ui/core/test/keepwarm-activity.test.mjs (from packages/app)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendEventToHistory, buildHistoryModel } from "../src/history.js";

const T = Date.parse("2026-11-09T12:00:00.000Z");
const ev = (seq, eventType, data) => ({ sessionId: "s1", seq, eventType, ...(data === undefined ? {} : { data }), createdAt: new Date(T + seq * 1000).toISOString() });

// Both paths build the feed: a history load and the live append of each event.
function feeds(event) {
    return [
        buildHistoryModel([event]),
        [event].reduce(appendEventToHistory, buildHistoryModel()),
    ];
}

function assertFeed(event, text, color) {
    for (const history of feeds(event)) {
        assert.equal(history.chat.length, 0, "no chat item");
        assert.equal(history.activity.length, 1);
        const [item] = history.activity;
        assert.match(item.text, new RegExp(`^\\[[^\\]]+\\] ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
        assert.equal(item.line.find((run) => run.text === "[keep-warm]")?.color, color);
    }
}

test("an ok ping shows its number, status and cached tokens; a failed ping is yellow; no reply and no count are left readable", () => {
    assertFeed(ev(1, "session.keepwarm_ping", { ping: 3, status: 200, ok: true, tokensCacheRead: 74600 }), "[keep-warm] ping 3 · 200 · 74.6k cached", "cyan");
    assertFeed(ev(2, "session.keepwarm_ping", { ping: 4, status: 429, ok: false, tokensCacheRead: null }), "[keep-warm] ping 4 · 429", "yellow");
    assertFeed(ev(3, "session.keepwarm_ping", { ping: 5, status: null, ok: false }), "[keep-warm] ping 5 · no reply", "yellow");
});

test("a stop shows its reason and the ping count, with one ping in the singular", () => {
    assertFeed(ev(4, "session.keepwarm_stopped", { reason: "cache-miss", pings: 3 }), "[keep-warm] stopped · cache-miss · 3 pings", "gray");
    assertFeed(ev(5, "session.keepwarm_stopped", { reason: "max-pings", pings: 1 }), "[keep-warm] stopped · max-pings · 1 ping", "gray");
});

test("an event with no data does not throw and still shows a line", () => {
    assertFeed(ev(6, "session.keepwarm_ping"), "[keep-warm] ping · no reply", "yellow");
    assertFeed(ev(7, "session.keepwarm_stopped"), "[keep-warm] stopped", "gray");
});
