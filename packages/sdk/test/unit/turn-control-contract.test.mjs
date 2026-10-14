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

// Literal descriptors produced by the scheduling proxy at b2722575, before
// any turn-control code, for both prior contracts across normal, epoch-start
// and workspace turns, bare and with omitted/null/empty optional metadata.
// The metadata also carries carriedSteers, which the prior contracts ignore.
const BASELINE_B2722575 = {
        "legacy/plain/normal/bare": {
            "type": "activity",
            "name": "runTurn",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"turnIndex\":5}",
            "sessionId": "affinity"
        },
        "legacy/plain/normal/meta": {
            "type": "activity",
            "name": "runTurn",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"}}",
            "sessionId": "affinity"
        },
        "legacy/plain/epoch/bare": {
            "type": "activity",
            "name": "runTurn2",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"turnIndex\":5,\"epochStart\":true}",
            "sessionId": "affinity"
        },
        "legacy/plain/epoch/meta": {
            "type": "activity",
            "name": "runTurn2",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"bootstrap\":true,\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"},\"epochStart\":true}",
            "sessionId": "affinity"
        },
        "legacy/workspace/normal/bare": {
            "type": "activity",
            "name": "runTurn",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"turnIndex\":5}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "legacy/workspace/normal/meta": {
            "type": "activity",
            "name": "runTurn",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"}}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "legacy/workspace/epoch/bare": {
            "type": "activity",
            "name": "runTurn2",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"turnIndex\":5,\"epochStart\":true}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "legacy/workspace/epoch/meta": {
            "type": "activity",
            "name": "runTurn2",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"bootstrap\":true,\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"},\"epochStart\":true}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "agent-handoff-v2/plain/normal/bare": {
            "type": "activity",
            "name": "runTurnV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"turnIndex\":5}",
            "sessionId": "affinity",
            "tag": "pilotswarm.agent-handoff.v2"
        },
        "agent-handoff-v2/plain/normal/meta": {
            "type": "activity",
            "name": "runTurnV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"}}",
            "sessionId": "affinity",
            "tag": "pilotswarm.agent-handoff.v2"
        },
        "agent-handoff-v2/plain/epoch/bare": {
            "type": "activity",
            "name": "runTurnEpochV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"turnIndex\":5,\"epochStart\":true}",
            "sessionId": "affinity",
            "tag": "pilotswarm.agent-handoff.v2"
        },
        "agent-handoff-v2/plain/epoch/meta": {
            "type": "activity",
            "name": "runTurnEpochV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"model\":\"m\"},\"bootstrap\":true,\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"},\"epochStart\":true}",
            "sessionId": "affinity",
            "tag": "pilotswarm.agent-handoff.v2"
        },
        "agent-handoff-v2/workspace/normal/bare": {
            "type": "activity",
            "name": "runTurnV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"turnIndex\":5}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "agent-handoff-v2/workspace/normal/meta": {
            "type": "activity",
            "name": "runTurnV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"}}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "agent-handoff-v2/workspace/epoch/bare": {
            "type": "activity",
            "name": "runTurnEpochV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"turnIndex\":5,\"epochStart\":true}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "agent-handoff-v2/workspace/epoch/meta": {
            "type": "activity",
            "name": "runTurnEpochV3",
            "input": "{\"sessionId\":\"s\",\"prompt\":\"work\",\"config\":{\"workspace\":{\"schema\":1,\"root\":\"a\",\"folder\":\"repo-x\"}},\"bootstrap\":true,\"turnIndex\":5,\"nestingLevel\":0,\"retryCount\":0,\"snapshot\":{\"turnKey\":\"k\"},\"epochStart\":true}",
            "sessionId": "affinity",
            "tag": "pilotswarm.workspaces.v1"
        },
        "manager/legacy/plain": {
            "status": {
                "type": "activity",
                "name": "getSessionStatus",
                "input": "{\"sessionId\":\"c\"}"
            },
            "list": {
                "type": "activity",
                "name": "listChildSessions",
                "input": "{\"parentSessionId\":\"p\"}"
            },
            "update": {
                "type": "activity",
                "name": "updateCmsState",
                "input": "{\"sessionId\":\"s\",\"state\":\"error\",\"lastError\":\"boom\",\"waitReason\":null}"
            }
        },
        "manager/legacy/provenance": {
            "status": {
                "type": "activity",
                "name": "getSessionStatusV2",
                "input": "{\"sessionId\":\"c\"}"
            },
            "list": {
                "type": "activity",
                "name": "listChildSessionsV2",
                "input": "{\"parentSessionId\":\"p\"}"
            },
            "update": {
                "type": "activity",
                "name": "updateCmsState",
                "input": "{\"sessionId\":\"s\",\"state\":\"error\",\"lastError\":\"boom\",\"waitReason\":null}"
            }
        },
        "manager/agent-handoff-v2/plain": {
            "status": {
                "type": "activity",
                "name": "getSessionStatus",
                "input": "{\"sessionId\":\"c\"}"
            },
            "list": {
                "type": "activity",
                "name": "listChildSessions",
                "input": "{\"parentSessionId\":\"p\"}"
            },
            "update": {
                "type": "activity",
                "name": "updateCmsState",
                "input": "{\"sessionId\":\"s\",\"state\":\"error\",\"lastError\":\"boom\",\"waitReason\":null}"
            }
        },
        "manager/agent-handoff-v2/provenance": {
            "status": {
                "type": "activity",
                "name": "getSessionStatusV2",
                "input": "{\"sessionId\":\"c\"}",
                "tag": "pilotswarm.agent-handoff.v2"
            },
            "list": {
                "type": "activity",
                "name": "listChildSessionsV2",
                "input": "{\"parentSessionId\":\"p\"}",
                "tag": "pilotswarm.agent-handoff.v2"
            },
            "update": {
                "type": "activity",
                "name": "updateCmsState",
                "input": "{\"sessionId\":\"s\",\"state\":\"error\",\"lastError\":\"boom\",\"waitReason\":null}"
            }
        }
    };

const baselineMeta = {
    retryCount: 0, clientMessageIds: [], parentSessionId: null, nestingLevel: 0, requiredTool: undefined,
    snapshot: { turnKey: "k" }, transcriptEpoch: 0, stashedPrompts: [], workspaceRevision: 0, workspaceNotice: "",
    sender: null, carriedSteers: carried,
};

test("legacy and handoff contracts schedule exactly the b2722575 descriptors, even when handed carried steers", () => {
    const ctx = new OrchestrationContext({ instanceId: "session-s", executionId: "1", orchestrationName: "durable-session-v2", orchestrationVersion: "1.0.80" });
    let compared = 0;
    for (const contract of [undefined, "agent-handoff-v2"]) {
        for (const [cfgName, cfg] of [["plain", { model: "m" }], ["workspace", { workspace }]]) {
            for (const epoch of [false, true]) {
                const proxy = createSessionProxy(ctx, "s", "affinity", cfg, contract);
                const key = `${contract ?? "legacy"}/${cfgName}/${epoch ? "epoch" : "normal"}`;
                assert.deepEqual(wire(proxy.runTurn("work", false, 5, epoch ? { epochStart: true } : undefined)), BASELINE_B2722575[`${key}/bare`], `${key}/bare`);
                assert.deepEqual(wire(proxy.runTurn("work", epoch, 5, { ...baselineMeta, ...(epoch ? { epochStart: true } : {}) })), BASELINE_B2722575[`${key}/meta`], `${key}/meta`);
                compared += 2;
            }
        }
    }
    for (const contract of [undefined, "agent-handoff-v2"]) {
        for (const provenance of [false, true]) {
            const manager = createSessionManagerProxy(ctx, contract, provenance ? { childResultProvenance: true } : undefined);
            const key = `manager/${contract ?? "legacy"}/${provenance ? "provenance" : "plain"}`;
            assert.deepEqual({
                status: wire(manager.getSessionStatus("c")),
                list: wire(manager.listChildSessions("p")),
                update: wire(manager.updateCmsState("s", "error", "boom", null)),
            }, BASELINE_B2722575[key], key);
            compared += 1;
        }
    }
    assert.equal(compared, Object.keys(BASELINE_B2722575).length);
});

test("under turn-control-v1 status and child-list provenance keep the handoff names and tag", () => {
    const manager = createSessionManagerProxy(context(), "turn-control-v1", { childResultProvenance: true });
    assert.deepEqual(wire(manager.getSessionStatus("c")), {
        type: "activity", name: "getSessionStatusV2", input: '{"sessionId":"c"}', tag: AGENT_HANDOFF_CAPABILITY,
    });
    assert.deepEqual(wire(manager.listChildSessions("p")), {
        type: "activity", name: "listChildSessionsV2", input: '{"parentSessionId":"p"}', tag: AGENT_HANDOFF_CAPABILITY,
    });
    const plain = createSessionManagerProxy(context(), "turn-control-v1");
    assert.deepEqual(wire(plain.getSessionStatus("c")), { type: "activity", name: "getSessionStatus", input: '{"sessionId":"c"}' });
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

test("the catalog's turn-control methods report a schema without migration 0082 as unavailable", async () => {
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.sql = { fn: { turnControlAdd: "x.a", turnStart: "x.b", turnLook: "x.c", turnEnd: "x.d" } };
    catalog.pool = { query: async () => { throw Object.assign(new Error("function does not exist"), { code: "42883" }); } };
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

test("other catalog errors from turn-control procedures pass through", async () => {
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.sql = { fn: { turnStart: "x.b" } };
    catalog.pool = { query: async () => { throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }); } };
    await assert.rejects(() => catalog.turnStart("s", 1), /connection refused/);
});

test("turnLook with no running turns makes no query", async () => {
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.pool = { query: async () => { throw new Error("no query expected"); } };
    assert.deepEqual(await catalog.turnLook([]), []);
});
