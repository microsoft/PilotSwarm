/**
 * The `debug.enable_model_event_logging` feature flag.
 *
 * Off (the published default): the runTurn activity does not write the
 * CLI's large model.* trace events to the CMS. On, for the cluster or for the
 * session owner: it writes them in full. hook.start and the other events are
 * written either way.
 *
 * Run: npx vitest run test/local/feature-model-event-logging.test.js
 */
import { describe, expect, it, vi } from "vitest";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";
import {
    MODEL_EVENT_LOGGING_FEATURE,
    MODEL_EVENT_TYPES_RECORDED_WHEN_LOGGING,
    modelEventLoggingEnabled,
} from "../../src/model-event-logging.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

const key = MODEL_EVENT_LOGGING_FEATURE;
const alice = { provider: "test", subject: "alice" };
const bob = { provider: "test", subject: "bob" };

/** A loaded worker cache. `cluster` undefined = no saved cluster row (published defaults). */
async function flagCache({ cluster, allowUserOverride = true, users = {} } = {}) {
    const settings = [];
    if (cluster !== undefined) {
        settings.push({ featureKey: key, scope: "cluster", userId: null, enabled: cluster, allowUserOverride, revision: "1" });
    }
    let userId = 1;
    for (const [subject, enabled] of Object.entries(users)) {
        settings.push({ featureKey: key, scope: "user", userId: userId++, owner: { provider: "test", subject },
            enabled, allowUserOverride: null, revision: "1" });
    }
    const cache = new FeatureFlagCache({
        revisions: async () => [{ featureKey: key, revision: "1" }],
        snapshot: async () => ({ definitions: [{ featureKey: key, ...FEATURE_FLAGS[key], revision: "1" }], settings }),
    });
    await cache.pollRevisionsAndRefresh();
    return cache;
}

const SNAPSHOT_TEXT = "s".repeat(50_000);
const MODEL_EVENTS = [
    { eventType: "model.message", data: { kind: "message", message: { role: "assistant", content: "hi" } } },
    { eventType: "model.messages_snapshot", data: { kind: "messages_snapshot", messages: [{ role: "user", content: SNAPSHOT_TEXT }] } },
    { eventType: "model.tool_execution", data: { kind: "tool_execution", toolName: "bash" } },
    { eventType: "model.model_call_success", data: { kind: "model_call_success" } },
];
const OTHER_EVENTS = [
    { eventType: "hook.start", data: { hookType: "preToolUse" } },
    { eventType: "model.turn_started", data: { kind: "turn_started" } },
    { eventType: "assistant.message", data: { content: "Done." } },
];

async function runTurnRecording({ cache, owner = alice, events = [...MODEL_EVENTS, ...OTHER_EVENTS] }) {
    const harness = makeRunTurnHarness({
        owner,
        featureFlagCache: cache,
        turn: async (opts) => {
            for (const event of events) opts.onEvent(event);
            return { type: "completed", content: "Done.", events };
        },
    });
    const result = await harness.runTurn();
    const types = harness.recordedEvents.map((event) => event.eventType);
    return { harness, result, types };
}

const skipsModelEvents = (types) => {
    for (const type of MODEL_EVENT_TYPES_RECORDED_WHEN_LOGGING) expect(types, `${type} must be skipped`).not.toContain(type);
    for (const { eventType } of OTHER_EVENTS) expect(types, `${eventType} must be recorded`).toContain(eventType);
};
const recordsModelEvents = (types) => {
    for (const { eventType } of [...MODEL_EVENTS, ...OTHER_EVENTS]) expect(types, `${eventType} must be recorded`).toContain(eventType);
};

describe("model event logging feature flag", () => {
    it("covers exactly the four large model event types", () => {
        expect([...MODEL_EVENT_TYPES_RECORDED_WHEN_LOGGING].sort()).toEqual([
            "model.message", "model.messages_snapshot", "model.model_call_success", "model.tool_execution",
        ]);
        expect(MODEL_EVENT_TYPES_RECORDED_WHEN_LOGGING.has("hook.start")).toBe(false);
        expect(FEATURE_FLAGS[key]).toMatchObject({ defaultEnabled: false, defaultAllowUserOverride: true, requiredCapability: null });
    });

    it("is off without a cache, before the cache loads, and by published default", async () => {
        expect(modelEventLoggingEnabled(null, alice)).toBe(false);
        const unloaded = new FeatureFlagCache({ revisions: async () => [], snapshot: async () => ({ definitions: [], settings: [] }) });
        expect(modelEventLoggingEnabled(unloaded, alice)).toBe(false);
        expect(modelEventLoggingEnabled(await flagCache(), alice)).toBe(false);
    });

    it("skips the four model event types by default and keeps hook.start", async () => {
        skipsModelEvents((await runTurnRecording({ cache: await flagCache() })).types);
        skipsModelEvents((await runTurnRecording({ cache: await flagCache({ cluster: false }) })).types);
        skipsModelEvents((await runTurnRecording({ cache: null })).types);
    });

    it("records them in full when the cluster turns it on", async () => {
        const { harness, types } = await runTurnRecording({ cache: await flagCache({ cluster: true }) });
        recordsModelEvents(types);
        const snapshot = harness.recordedEvents.find((event) => event.eventType === "model.messages_snapshot");
        expect(snapshot.data.messages[0].content).toBe(SNAPSHOT_TEXT);
    });

    it("lets the session owner's On beat the cluster's Off", async () => {
        const cache = await flagCache({ cluster: false, users: { alice: true } });
        recordsModelEvents((await runTurnRecording({ cache, owner: alice })).types);
        skipsModelEvents((await runTurnRecording({ cache, owner: bob })).types);
    });

    it("lets the session owner's Off beat the cluster's On", async () => {
        const cache = await flagCache({ cluster: true, users: { alice: false } });
        skipsModelEvents((await runTurnRecording({ cache, owner: alice })).types);
        recordsModelEvents((await runTurnRecording({ cache, owner: bob })).types);
    });

    it("ignores the owner's preference when the cluster locks the setting", async () => {
        const cache = await flagCache({ cluster: false, allowUserOverride: false, users: { alice: true } });
        skipsModelEvents((await runTurnRecording({ cache, owner: alice })).types);
    });

    it("follows the cluster setting for a session without an owner", async () => {
        recordsModelEvents((await runTurnRecording({ cache: await flagCache({ cluster: true }), owner: null })).types);
        skipsModelEvents((await runTurnRecording({ cache: await flagCache({ cluster: false, users: { alice: true } }), owner: null })).types);
    });

    it("reads the flag once per turn, not once per event", async () => {
        const cache = await flagCache({ cluster: true });
        const resolve = vi.spyOn(cache, "resolve");
        const many = Array.from({ length: 100 }, (_, i) => ({ eventType: "model.message", data: { kind: "message", i } }));
        const { harness, types } = await runTurnRecording({ cache, events: many });
        expect(types.filter((type) => type === "model.message")).toHaveLength(100);
        expect(resolve.mock.calls.filter(([feature]) => feature === key)).toHaveLength(1);
        expect(harness.sessionManager.getFeatureFlagCache).toHaveBeenCalledTimes(1);
    });

    it("leaves the turn result alone: it never carries model events", async () => {
        const { result } = await runTurnRecording({ cache: await flagCache({ cluster: true }) });
        expect(result.events.some((event) => event.eventType.startsWith("model."))).toBe(false);
    });
});
