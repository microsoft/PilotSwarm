import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMotdDraft, motdDraftWindow, motdScheduleSummary, duplicateMotdDraft,
    PilotSwarmUiController, createInitialState, createStore, appReducer } from "../src/index.js";
import { MotdSchedulePicker, MotdSplash } from "../../react/src/motd.js";

const now = Date.parse("2026-11-01T20:00:00Z");
test("default schedule is Now and Never with a plain summary", () => {
    const draft = createMotdDraft();
    assert.deepEqual(motdDraftWindow(draft, now), { from: now, to: null });
    assert.equal(motdScheduleSummary(draft, now), "Shows now until replaced or deleted.");
});
test("preset lengths anchor to the chosen start, including future custom starts", () => {
    for (const [mode, duration] of [["hour", 3_600_000], ["day", 86_400_000], ["week", 604_800_000]]) {
        const window = motdDraftWindow({ ...createMotdDraft(), endMode: mode }, now);
        assert.equal(window.to - window.from, duration);
        const custom = motdDraftWindow({ ...createMotdDraft(), startMode: "custom", startDate: "2030-11-01", startTime: "09:00", endMode: mode }, now);
        assert.equal(custom.to - custom.from, duration);
    }
});
test("invalid local dates and skipped daylight-saving times are rejected", () => {
    assert.ok(Number.isNaN(motdDraftWindow({ ...createMotdDraft(), startMode: "custom", startDate: "2030-02-30" }, now).from));
    const prior = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
        assert.ok(Number.isNaN(motdDraftWindow({ ...createMotdDraft(), startMode: "custom", startDate: "2027-03-14", startTime: "02:30" }, now).from));
        const source = { fromAt: "2020-01-01T00:00:00Z", toAt: "2020-01-01T01:01:00Z", bodyMd: "Body" };
        const copy = duplicateMotdDraft(source, {}, Date.parse("2026-11-01T08:10:00Z"));
        assert.equal(copy.endMode, "custom");
        assert.equal(motdDraftWindow(copy, Date.parse("2026-11-01T08:10:00Z")).to, Date.parse("2026-11-01T09:11:00Z"));
    } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});
test("picker renders native radios, separate date and time controls, zone and no datetime-local", () => {
    const draft = { ...createMotdDraft(), startMode: "custom", endMode: "custom", startDate: "2030-11-01", endDate: "2030-11-02" };
    const html = renderToStaticMarkup(React.createElement(MotdSchedulePicker, { controller: {}, draft, busy: false }));
    for (const label of ["Starts", "Ends", "Never - until replaced or deleted", "Your time zone:"]) assert.ok(html.includes(label), label);
    assert.match(html, /type="date"/); assert.doesNotMatch(html, /datetime-local/);
    assert.match(html, /value="09:15"/);
    for (const label of ["Start time", "End time"]) assert.ok(html.includes(label), label);
});
test("a schedule spanning daylight-saving changes uses the generic zone name", () => {
    const prior = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
        const summary = motdScheduleSummary({ ...createMotdDraft(), startMode: "custom", startDate: "2030-11-02",
            startTime: "09:00", endMode: "custom", endDate: "2030-11-08", endTime: "18:00" }, now);
        assert.match(summary, /9:00 AM.*6:00 PM \(Pacific Time\)\./);
        assert.doesNotMatch(summary, /Daylight|Standard/);
    } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});
test("missing ends render as until replaced rather than an invalid date", () => {
    const html = renderToStaticMarkup(React.createElement(MotdSplash, { message: {
        motdId: "1", startsAt: "2026-11-01T00:00:00Z", endsAt: null, bodyMd: "No end",
    }, onDismiss: () => {} }));
    assert.match(html, /until replaced/);
    assert.doesNotMatch(html, /Invalid Date|1970/);
});
test("uncertain relative-end publication freezes time input and retry identity", async t => {
    t.mock.timers.enable({ apis: ["Date"], now });
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    const profile = { provider: "test", subject: "admin", isAdmin: true };
    store.dispatch({ type: "admin/profile/loaded", profile });
    const calls = [];
    const controller = new PilotSwarmUiController({ store, transport: {
        createMotd: async input => { calls.push(input); if (calls.length === 1) throw new Error("uncertain"); },
    } });
    controller.setMotdDraft({ bodyMd: "Body", endMode: "hour" });
    await controller.createAdminMotd();
    t.mock.timers.tick(60_000);
    await controller.createAdminMotd();
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[0].startsAt, undefined);
    assert.equal(calls[0].endsAt, "2026-11-01T21:00:00.000Z");
});
test("an uncertain Now/custom-end retry remains possible after its end has passed", async t => {
    t.mock.timers.enable({ apis: ["Date"], now });
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "admin/profile/loaded", profile: { provider: "test", subject: "admin", isAdmin: true } });
    const calls = [];
    const controller = new PilotSwarmUiController({ store, transport: {
        createMotd: async input => { calls.push(input); if (calls.length === 1) throw new Error("uncertain"); },
    } });
    const parts = new Date(now + 60_000);
    const local = new Date(parts.getTime() - parts.getTimezoneOffset() * 60_000).toISOString();
    controller.setMotdDraft({ bodyMd: "Body", endMode: "custom", endDate: local.slice(0, 10), endTime: local.slice(11, 16) });
    await controller.createAdminMotd();
    t.mock.timers.tick(120_000);
    await controller.createAdminMotd();
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
});
test("Duplicate recognizes presets after small client/server creation-time differences", () => {
    for (const [mode, duration] of [["hour", 3_600_000], ["day", 86_400_000], ["week", 604_800_000]]) {
        const source = { startsAt: new Date(now + 130).toISOString(), createdAt: new Date(now + 130).toISOString(),
            endsAt: new Date(now + duration).toISOString(), bodyMd: "Body" };
        assert.equal(duplicateMotdDraft(source, {}, now).endMode, mode);
    }
    const exactOther = { startsAt: new Date(now).toISOString(), endsAt: new Date(now + 3_539_000).toISOString(), bodyMd: "Body" };
    assert.equal(duplicateMotdDraft(exactOther, {}, now).endMode, "custom");
    const explicitStart = { startsAt: new Date(now).toISOString(), createdAt: new Date(now - 60_000).toISOString(),
        endsAt: new Date(now + 3_599_870).toISOString(), bodyMd: "Body" };
    assert.equal(duplicateMotdDraft(explicitStart, {}, now).endMode, "custom");
});
