// Session turn control, phase A1: the shared contract (routing names and tag,
// scheduling hooks, flag definition, helpers). Frozen orchestration versions
// must schedule exactly what they scheduled before.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSessionManagerProxy, createSessionProxy } from "../../dist/session-proxy.js";
import {
    AGENT_HANDOFF_CAPABILITY,
    WORKSPACE_CAPABILITY,
    TURN_CONTROL_CAPABILITY,
    TURN_CONTROL_ACTIVITY_NAMES,
    routeTurnControlActivity,
    registerTurnControlActivity,
} from "../../dist/activity-routing.js";
import {
    TURN_CONTROL_EVENT_TYPES,
    TURN_CONTROL_CHANNEL,
    TURN_CONTROL_MAX_OPEN,
    TURN_CONTROL_LOOK_INTERVAL_MS,
    STEERING_FEATURE_KEY,
    CARRIED_STEERS_WAKE_PROMPT,
    acceptsTurnControl,
    TurnControlUnavailableError,
} from "../../dist/turn-control-contract.js";
import * as sdk from "../../dist/index.js";
import { FEATURE_FLAGS } from "../../dist/feature-flags.js";
import { PgSessionCatalog } from "../../dist/cms.js";

const { OrchestrationContext } = createRequire(import.meta.url)("duroxide");
const context = () => new OrchestrationContext({ instanceId: "session-s", executionId: "1", orchestrationName: "durable-session-v2", orchestrationVersion: "1.0.81" });
const wire = (value) => JSON.parse(JSON.stringify(value));
const carried = [{ seq: 31, text: "use the v2 API" }];
const workspace = { schema: 1, root: "a", folder: "repo-x" };

test("turn-control names and tag are the published contract", () => {
    assert.equal(TURN_CONTROL_CAPABILITY, "pilotswarm.turn-control.v1");
    assert.deepEqual({ ...TURN_CONTROL_ACTIVITY_NAMES }, { runTurn: "runTurnV4", runTurn2: "runTurnEpochV4" });
    assert.deepEqual({ ...TURN_CONTROL_EVENT_TYPES }, {
        steer: "user.steer",
        stop: "user.stop",
        outcome: "session.control_outcome",
        steerConfirmed: "session.steer_confirmed",
        carriedSteersClosed: "session.carried_steers_closed",
    });
    assert.equal(TURN_CONTROL_CHANNEL, "pilotswarm_turn_control");
    assert.equal(TURN_CONTROL_MAX_OPEN, 20);
    assert.equal(TURN_CONTROL_LOOK_INTERVAL_MS, 5000);
    assert.equal(STEERING_FEATURE_KEY, "sessions.steering");
    assert.match(CARRIED_STEERS_WAKE_PROMPT, /^\[SYSTEM: /);
});

test("the SDK entry point exports the contract", () => {
    for (const name of [
        "TURN_CONTROL_EVENT_TYPES", "TURN_CONTROL_CHANNEL", "TURN_CONTROL_MAX_OPEN", "TURN_CONTROL_LOOK_INTERVAL_MS",
        "TURN_CONTROL_OUTCOME_POLL_MS", "TURN_CONTROL_STOP_TIMEOUT_MS", "STEERING_FEATURE_KEY",
        "CARRIED_STEERS_WAKE_PROMPT", "acceptsTurnControl", "TurnControlUnavailableError", "TURN_CONTROL_CAPABILITY",
    ]) {
        assert.ok(name in sdk, `${name} is exported`);
    }
});

test("1.0.81 turns go to runTurnV4 / runTurnEpochV4 with only the turn-control tag, workspace or not", () => {
    const ctx = context();
    const plain = createSessionProxy(ctx, "s", "affinity", { model: "m" }, "turn-control-v1");
    const withWorkspace = createSessionProxy(ctx, "s", "affinity", { workspace }, "turn-control-v1");
    const turns = [
        plain.runTurn("work", false, 3),
        plain.runTurn("work", true, 0, { epochStart: true }),
        withWorkspace.runTurn("work", false, 4, { workspaceRevision: 1 }),
        withWorkspace.runTurn("work", true, 0, { epochStart: true, workspaceRevision: 1 }),
    ];
    assert.deepEqual(turns.map((t) => [t.name, t.tag, t.sessionId]), [
        ["runTurnV4", TURN_CONTROL_CAPABILITY, "affinity"],
        ["runTurnEpochV4", TURN_CONTROL_CAPABILITY, "affinity"],
        ["runTurnV4", TURN_CONTROL_CAPABILITY, "affinity"],
        ["runTurnEpochV4", TURN_CONTROL_CAPABILITY, "affinity"],
    ]);
});

test("1.0.81 forwards carried steers only when there are some", () => {
    const proxy = createSessionProxy(context(), "s", "affinity", { model: "m" }, "turn-control-v1");
    assert.deepEqual(JSON.parse(wire(proxy.runTurn("work", false, 3, { carriedSteers: carried })).input).carriedSteers, carried);
    assert.equal("carriedSteers" in JSON.parse(wire(proxy.runTurn("work", false, 3, { carriedSteers: [] })).input), false);
    assert.equal("carriedSteers" in JSON.parse(wire(proxy.runTurn("work", false, 3)).input), false);
});

test("legacy and handoff contracts schedule exactly today's descriptors, even when handed carried steers", () => {
    const ctx = context();
    const meta = {
        retryCount: 1, clientMessageIds: ["c1"], snapshot: { turnKey: "k" }, transcriptEpoch: 2,
        stashedPrompts: ["held"], workspaceNotice: "note", requiredTool: undefined, parentSessionId: null,
    };
    const cases = [
        [createSessionProxy(ctx, "s", "affinity", { model: "m" }), false, {
            type: "activity", name: "runTurn", sessionId: "affinity",
            input: '{"sessionId":"s","prompt":"work","config":{"model":"m"},"turnIndex":5,"retryCount":1,"clientMessageIds":["c1"],"snapshot":{"turnKey":"k"},"transcriptEpoch":2,"stashedPrompts":["held"],"workspaceNotice":"note"}',
        }],
        [createSessionProxy(ctx, "s", "affinity", { model: "m" }, "agent-handoff-v2"), false, {
            type: "activity", name: "runTurnV3", sessionId: "affinity", tag: AGENT_HANDOFF_CAPABILITY,
            input: '{"sessionId":"s","prompt":"work","config":{"model":"m"},"turnIndex":5,"retryCount":1,"clientMessageIds":["c1"],"snapshot":{"turnKey":"k"},"transcriptEpoch":2,"stashedPrompts":["held"],"workspaceNotice":"note"}',
        }],
        [createSessionProxy(ctx, "s", "affinity", { workspace }, "agent-handoff-v2"), true, {
            type: "activity", name: "runTurnEpochV3", sessionId: "affinity", tag: WORKSPACE_CAPABILITY,
            input: '{"sessionId":"s","prompt":"work","config":{"workspace":{"schema":1,"root":"a","folder":"repo-x"}},"turnIndex":5,"retryCount":1,"clientMessageIds":["c1"],"snapshot":{"turnKey":"k"},"transcriptEpoch":2,"epochStart":true,"stashedPrompts":["held"],"workspaceNotice":"note"}',
        }],
    ];
    for (const [proxy, epochStart, expected] of cases) {
        const task = proxy.runTurn("work", false, 5, { ...meta, ...(epochStart ? { epochStart: true } : {}), carriedSteers: carried });
        assert.deepEqual(wire(task), expected);
    }
});

test("under turn-control-v1 every other routed activity keeps the handoff names and tag", () => {
    const ctx = context();
    const manager = createSessionManagerProxy(ctx, "turn-control-v1");
    const tasks = [
        manager.resolveAgentConfig("analyst"),
        manager.resolveAgentForRequiredTool("lookup"),
        manager.spawnChildSession("parent", {}, "work"),
    ];
    assert.deepEqual(tasks.map((t) => [t.name, t.tag]), [
        ["resolveAgentConfigV2", AGENT_HANDOFF_CAPABILITY],
        ["resolveAgentForRequiredToolV2", AGENT_HANDOFF_CAPABILITY],
        ["spawnChildSessionV2", AGENT_HANDOFF_CAPABILITY],
    ]);
    const proxy = createSessionProxy(ctx, "s", "affinity", { workspace }, "turn-control-v1");
    assert.equal(proxy.checkWorkspace({ workspace, revision: 1, turnIndex: 1 }).tag, WORKSPACE_CAPABILITY);
    assert.equal(proxy.abortTurn("why").tag, undefined);
});

test("updateCmsState carries closeControls only when set", () => {
    const manager = createSessionManagerProxy(context());
    assert.deepEqual(JSON.parse(wire(manager.updateCmsState("s", "error", "boom", null)).input),
        { sessionId: "s", state: "error", lastError: "boom", waitReason: null });
    assert.deepEqual(JSON.parse(wire(manager.updateCmsState("s", "idle")).input), { sessionId: "s", state: "idle" });
    assert.equal("closeControls" in JSON.parse(wire(manager.updateCmsState("s", "error", "boom", undefined, { closeControls: false })).input), false);
    assert.deepEqual(JSON.parse(wire(manager.updateCmsState("s", "error", "boom", undefined, { closeControls: true })).input),
        { sessionId: "s", state: "error", lastError: "boom", closeControls: true });
});

test("turn-control routing fails closed without tag support", () => {
    assert.throws(() => routeTurnControlActivity({ type: "activity", name: "runTurnV4" }), /tag routing support/);
});

test("registerTurnControlActivity registers the V4 names", () => {
    const names = [];
    const runtime = { registerActivity: (name) => names.push(name) };
    registerTurnControlActivity(runtime, "runTurn", () => {});
    registerTurnControlActivity(runtime, "runTurn2", () => {});
    assert.deepEqual(names, ["runTurnV4", "runTurnEpochV4"]);
});

test("sessions.steering is off, operator-controlled and needs no capability", () => {
    assert.deepEqual(FEATURE_FLAGS["sessions.steering"], {
        displayName: "Steer running turns",
        description: FEATURE_FLAGS["sessions.steering"].description,
        defaultEnabled: false,
        defaultAllowUserOverride: false,
        requiredCapability: null,
    });
    assert.ok(FEATURE_FLAGS["sessions.steering"].description.length > 0);
});

test("acceptsTurnControl: a running turn that started on the turn-control path", () => {
    assert.equal(acceptsTurnControl({ activeTurnIndex: 4, turnHigh: 4 }), true);
    assert.equal(acceptsTurnControl({ activeTurnIndex: 0, turnHigh: 0 }), true);
    assert.equal(acceptsTurnControl({ activeTurnIndex: 4, turnHigh: 3 }), false, "a legacy turn");
    assert.equal(acceptsTurnControl({ activeTurnIndex: null, turnHigh: 4 }), false, "no turn running");
    assert.equal(acceptsTurnControl({ activeTurnIndex: 4 }), false, "a catalog before migration 0082");
    assert.equal(acceptsTurnControl(null), false);
    assert.equal(acceptsTurnControl(undefined), false);
});

test("the catalog's turn-control methods are unavailable until migration 0082", async () => {
    const catalog = Object.create(PgSessionCatalog.prototype);
    for (const [method, args] of [
        ["turnControlAdd", ["s", "steer", "t", "r", null]],
        ["turnStart", ["s", 1]],
        ["turnLook", [[{ sessionId: "s", turn: 1, after: 0 }]]],
        ["turnEnd", ["s", 1, 0, "other", []]],
    ]) {
        await assert.rejects(() => catalog[method](...args), (err) => err instanceof TurnControlUnavailableError && err.code === "TURN_CONTROL_UNAVAILABLE");
    }
});

test("completeTurnWriteback reports open controls only when the procedure says true", async () => {
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.sql = { fn: { completeTurnWriteback: "x.cms_complete_turn_writeback" } };
    for (const [rows, expected] of [[[{ has_controls: null }], false], [[{ has_controls: false }], false], [[{ has_controls: true }], true], [[], false]]) {
        let sql;
        catalog.pool = { query: async (text) => { sql = text; return { rows }; } };
        assert.equal(await catalog.completeTurnWriteback({ sessionId: "s" }), expected);
        assert.match(sql, /AS has_controls$/);
    }
});

test("updateSession sends closeControls only when true", async () => {
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.sql = { fn: { updateSession: "x.cms_update_session" } };
    const sent = [];
    catalog.pool = { query: async (_text, params) => { sent.push(JSON.parse(params[1])); return { rows: [] }; } };
    await catalog.updateSession("s", { state: "error", closeControls: true });
    await catalog.updateSession("s", { state: "error", closeControls: false });
    await catalog.updateSession("s", { state: "idle" });
    assert.deepEqual(sent, [{ state: "error", closeControls: true }, { state: "error" }, { state: "idle" }]);
});
