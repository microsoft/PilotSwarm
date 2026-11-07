import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { FeatureFlagsPanel } from "../../react/src/feature-flags-panel.js";
import { projectFeatureWorkerState } from "../../../../sdk/api/src/admin-diagnostics.js";

// Base Agent V2 and Native Copilot tasks are always on (server rows carry
// alwaysOn). The UI no longer recomputes a "requires native tasks" state.
const BASE = "agents.base_v2", NATIVE = "copilot.native_tasks", LOGGING = "debug.enable_model_event_logging";
const NOTICE = "This switch is now always on and may be removed in a future release.";
const profile = { provider: "test", subject: "owner", isAdmin: false };
function alwaysOn(key) {
    // Stored rows from before the change stay in the database; the server ignores them.
    return { featureKey: key, displayName: key, description: "Feature", revision: "1",
        defaultEnabled: false, defaultAllowUserOverride: true,
        cluster: { enabled: false, allowUserOverride: true }, user: { enabled: false },
        effective: true, source: "always_on", supported: true, alwaysOn: true, notice: NOTICE, userOverrideIgnored: false };
}
function normal(enabled) {
    return { featureKey: LOGGING, displayName: "Model event logging", description: "Feature", revision: "1",
        defaultEnabled: false, defaultAllowUserOverride: true, cluster: null, user: enabled === undefined ? null : { enabled },
        effective: enabled === true, source: enabled === undefined ? "default" : "user", supported: true, alwaysOn: false, userOverrideIgnored: false };
}
function fixture() {
    let offline = false;
    const writes = [];
    const data = { flags: [alwaysOn(NATIVE), alwaysOn(BASE), normal()] };
    const store = createStore(appReducer, createInitialState({ mode: "remote" }));
    store.dispatch({ type: "admin/profile/loaded", profile });
    const transport = { listSessions: async () => [], subscribeSession: () => () => {},
        getMyFeatureFlags: async () => { if (offline) throw new Error("refresh offline"); return data; },
        setMyFeatureFlag: async input => { writes.push(input); return { revision: "2", setting: { enabled: input.enabled } }; } };
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, writes, offline: () => { offline = true; },
        current: key => store.getState().admin.features.data.flags.find(value => value.featureKey === key) };
}

for (const enabled of [true, false]) test(`saving another flag ${enabled ? "On" : "Off"} leaves Base V2 and native tasks always on, even if refresh fails`, async () => {
    const h = fixture();
    await h.controller.refreshFeatureFlags();
    h.offline();
    await h.controller.saveFeatureFlag(LOGGING, { enabled });
    assert.equal(h.current(LOGGING).effective, enabled);
    for (const key of [BASE, NATIVE]) {
        assert.deepEqual(h.current(key), alwaysOn(key), `${key} keeps the server's always-on row`);
        assert.equal(h.current(key).reason, undefined);
    }
    assert.equal(h.writes.length, 1, "no implicit prerequisite mutation");
});

test("Base V2 and native tasks cannot be saved and render as always on, with no prerequisite warning", async () => {
    const h = fixture();
    await h.controller.refreshFeatureFlags();
    await h.controller.saveFeatureFlag(BASE, { enabled: false });
    await h.controller.saveFeatureFlag(NATIVE, { enabled: false });
    assert.equal(h.writes.length, 0);
    const state = h.store.getState();
    const html = renderToStaticMarkup(React.createElement(FeatureFlagsPanel, { controller: h.controller,
        features: state.admin.features, isAdmin: false, workers: [] }));
    for (const key of [BASE, NATIVE]) assert.match(html, new RegExp(`data-feature-key="${key.replace(/\./g, "\\.")}" data-always-on="true"`));
    assert.equal(html.split("Always on. " + NOTICE).length - 1, 2);
    assert.doesNotMatch(html, /requires Native Copilot tasks|preference is saved|configured for native tasks/);
});

test("safe worker diagnostics retain the Base V2 capability and revision", () => {
    assert.deepEqual(projectFeatureWorkerState({ protocolVersion: 1, initialized: true,
        supportedKeys: [BASE, NATIVE, "private.internal"],
        appliedRevisions: { [BASE]: "4", [NATIVE]: "8", "private.internal": "1" } }), {
        protocolVersion: 1, initialized: true, supportedKeys: [BASE, NATIVE],
        appliedRevisions: { [BASE]: "4", [NATIVE]: "8" },
    });
});
