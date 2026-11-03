import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMotdAdminState, createMotdDraft, formatMotdTimestamp, formatMotdWindow, motdScheduleSummary } from "../src/motd.js";
import { MotdAdminPanel, MotdSplash } from "../../react/src/motd.js";

const now = Date.parse("2026-11-01T22:16:00Z");
const message = { motdId: "1", startsAt: "2026-11-01T15:00:00Z", endsAt: "2026-11-02T20:00:00Z",
    bodyMd: "Local times", status: "live" };
const cases = [
    { zone: "America/Los_Angeles", name: "Pacific Time",
        range: "Sun, Nov 1, 7:00 AM until Mon, Nov 2, 12:00 PM",
        dst: "Sat, Oct 31, 9:00 AM until Mon, Nov 2, 12:00 PM",
        noEnd: "Sun, Nov 1, 7:00 AM", boundary: "Thu, Dec 31, 4:30 PM" },
    { zone: "Asia/Kolkata", name: "India Standard Time",
        range: "Sun, Nov 1, 8:30 PM until Tue, Nov 3, 1:30 AM",
        dst: "Sat, Oct 31, 9:30 PM until Tue, Nov 3, 1:30 AM",
        noEnd: "Sun, Nov 1, 8:30 PM", boundary: "Fri, Jan 1, 2027, 6:00 AM" },
];
function inZone(zone, run) {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try { run(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}
for (const expected of cases) {
    test(`MoTD range uses browser-local dates and generic zone: ${expected.zone}`, () => inZone(expected.zone, () => {
        assert.equal(formatMotdWindow(message, now), `${expected.range} (${expected.name})`);
        assert.equal(message.startsAt, "2026-11-01T15:00:00Z");
        assert.equal(message.endsAt, "2026-11-02T20:00:00Z");
    }));
    test(`MoTD range spanning DST formats each endpoint locally: ${expected.zone}`, () => inZone(expected.zone, () => {
        assert.equal(formatMotdWindow({ ...message, startsAt: "2026-10-31T16:00:00Z" }, now), `${expected.dst} (${expected.name})`);
    }));
    test(`MoTD no-end and legacy timestamps remain local: ${expected.zone}`, () => inZone(expected.zone, () => {
        const text = `${expected.noEnd} until replaced (${expected.name})`;
        assert.equal(formatMotdWindow({ ...message, endsAt: null }, now), text);
        assert.equal(formatMotdWindow({ fromAt: message.startsAt, toAt: null }, now), text);
    }));
    test(`MoTD year follows the viewer's local calendar and editor summary: ${expected.zone}`, () => inZone(expected.zone, () => {
        assert.equal(formatMotdTimestamp("2027-01-01T00:30:00Z", now), expected.boundary);
        assert.match(formatMotdTimestamp("2025-06-01T12:00:00Z", now), /2025/);
        assert.doesNotMatch(formatMotdTimestamp(message.startsAt, now), /2026/);
        const draft = { ...createMotdDraft(), startMode: "custom", startDate: "2027-06-01", startTime: "09:00",
            endMode: "custom", endDate: "2027-06-02", endTime: "18:00" };
        assert.match(motdScheduleSummary(draft, now), /Jun 1, 2027, 9:00 AM until.*Jun 2, 2027, 6:00 PM/);
    }));
    test(`MoTD admin, reader, phone and preview share local formatting: ${expected.zone}`, t => {
        t.mock.timers.enable({ apis: ["Date"], now });
        inZone(expected.zone, () => {
            const text = `${expected.range} (${expected.name})`;
            const state = { ...createMotdAdminState(), today: message, history: [message] };
            for (const isAdmin of [true, false]) {
                const html = renderToStaticMarkup(React.createElement(MotdAdminPanel, { controller: {}, state, isAdmin, canRead: true }));
                assert.equal(html.split(text).length - 1, 2, "Today and history use the same local window");
            }
            for (const mobile of [true, false]) for (const preview of [true, false]) {
                const html = renderToStaticMarkup(React.createElement(MotdSplash, { message, mobile, preview, onDismiss: () => {} }));
                assert.ok(html.includes(text), "Every splash footer uses the local window");
            }
        });
    });
}
