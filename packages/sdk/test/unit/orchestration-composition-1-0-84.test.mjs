import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import * as routing from "../../dist/activity-routing.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { createSessionProxy } from "../../dist/session-proxy.js";

const read = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const spawn = options => ManagedSession.subAgentToolDefs(options).find(tool => tool.name === "spawn_agent").parameters.properties;

test("1.0.84 is a distinct handler while 1.0.83 retains its frozen replay tree", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.84");
    const old = DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.83");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.equal(latest.version, "1.0.84");
    assert.notEqual(latest.handler, old.handler);
    assert.match(read("orchestration_1_0_83/index.ts"), /durableSessionOrchestration_1_0_83/);
    assert.match(read("orchestration_1_0_83/runtime.ts"), /"workflow-intake-v1"/);
    assert.match(read("orchestration/runtime.ts"), /"tool-composition-v1"/);
});

test("only composition turns expose grant and tools; old turns keep tool_names", () => {
    const legacy = spawn({});
    assert.ok(legacy.tool_names);
    assert.equal(Object.hasOwn(legacy, "grant"), false);
    assert.equal(Object.hasOwn(legacy, "tools"), false);
    const current = spawn({ toolComposition: true });
    assert.ok(current.grant);
    assert.ok(current.tools);
    assert.equal(Object.hasOwn(current, "tool_names"), false);
    assert.doesNotMatch(current.agent_name.description, /do not override.*grant/i);
});

test("composition uses new tagged V6 activities and fails closed without tag support", () => {
    assert.deepEqual(routing.COMPOSITION_TURN_ACTIVITY_NAMES, { runTurn: "runTurnV6", runTurn2: "runTurnEpochV6" });
    assert.equal(routing.TOOL_COMPOSITION_CAPABILITY, "pilotswarm.tool-composition.v1");
    const tags = [];
    const task = { withTag(tag) { tags.push(tag); return this; } };
    assert.equal(routing.routeToolCompositionActivity(task), task);
    assert.deepEqual(tags, ["pilotswarm.tool-composition.v1"]);
    assert.throws(() => routing.routeToolCompositionActivity({}), /tag routing support/);
    assert.deepEqual(routing.WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES, { runTurn: "runTurnV5", runTurn2: "runTurnEpochV5" });
});

test("a composition proxy keeps intake and epoch fields but never schedules a legacy turn", () => {
    const calls = [];
    const context = {
        scheduleActivityOnSession(name, input, affinity) {
            const call = { name, input, affinity, tags: [], withTag(tag) { this.tags.push(tag); return this; } };
            calls.push(call);
            return call;
        },
    };
    const proxy = createSessionProxy(context, "child", "affinity", { model: "fixture-model" }, "tool-composition-v1");
    const intake = { fixture: "retained" };
    proxy.runTurn("Task", false, 0, { intake, epochStart: true, transcriptEpoch: 2 });
    assert.equal(calls[0].name, "runTurnEpochV6");
    assert.deepEqual(calls[0].input.intake, intake);
    assert.equal(calls[0].input.transcriptEpoch, 2);
    assert.deepEqual(calls[0].tags, ["pilotswarm.tool-composition.v1"]);
    const historical = createSessionProxy(context, "old", "old-affinity", {}, "workflow-intake-v1");
    historical.runTurn("Task", false, 0, {});
    assert.equal(calls[1].name, "runTurnV5");
    assert.deepEqual(calls[1].tags, ["pilotswarm.workflow-request.v1"]);
});
