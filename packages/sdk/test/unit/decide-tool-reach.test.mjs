/**
 * Which sessions get the agent `decide` tool (docs/proposals/agent-decide-tool.md, "Which agents get the tool"):
 * - every session with the system tool layer: ordinary, named, system and sub-agents;
 * - never for the service session (regen-distiller), nor on a worker without a Decision host;
 * - removed by a `tools` ceiling or a Workflow state's `tools:` unless they name it;
 * - closed to native tasks, refused in Workflow scripts, intercepted in Workflow test runs, and a reserved name;
 * - the per-turn cap counts per turn.
 *
 * Run after the SDK build: node --test test/unit/decide-tool-reach.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../dist/session-manager.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { DECIDE_MAX_CALLS_PER_TURN } from "../../dist/decision-tools.js";
import { findReservedPackageToolName } from "../../dist/reserved-tool-names.js";
import { NATIVE_SYNCHRONOUS_TOOLS } from "../../dist/native-task-policy.js";
import { isWorkflowControlTool } from "../../dist/workflow/tool-policy.js";
import { interceptWorkflowTestTools } from "../../dist/workflow/test-agent-tools.js";
import { CHOICE, fakeDecideHost } from "../helpers/decide-fixtures.mjs";

/** A SessionManager with a stubbed Copilot transport (as workflow-agent-tool-limit.test.mjs): each handle's config. */
function managerFixture(t, { host = fakeDecideHost().host } = {}) {
    const home = fs.mkdtempSync(join(tmpdir(), "ps-decide-reach-"));
    const configs = [];
    const manager = new SessionManager(undefined, null, {}, home);
    manager.workflowScriptsEnabled = true;
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    if (host) manager.setDecideToolHost(host);
    const open = config => {
        configs.push(config);
        fs.mkdirSync(join(home, config.sessionId), { recursive: true });
        return { disconnect: async () => {}, rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({ cancelled: true }) } } };
    };
    manager.ensureClient = async () => ({
        createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config),
        deleteSession: async () => {},
    });
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { manager, configs };
}

const names = config => config.tools.map(tool => tool.name);
const decideOf = config => config.tools.find(tool => tool.name === "decide");

test("ordinary, named-agent, system and sub-agent sessions are declared decide, and it answers them", async (t) => {
    const { manager, configs } = managerFixture(t);
    const sessions = [
        ["ordinary", { toolNames: [] }],
        ["named", { toolNames: ["read_facts"], agentIdentity: "triage-agent" }],
        ["tuner", { toolNames: [], agentIdentity: "agent-tuner" }],
        ["sweeper", { toolNames: [], agentIdentity: "sweeper" }],
        ["child", { toolNames: [], parentSessionId: "ordinary" }],
    ];
    for (const [id, config] of sessions) {
        await manager.getOrCreate(id, config, { turnIndex: 0 });
        assert.ok(names(configs.at(-1)).includes("decide"), `${id} is declared decide`);
        const answer = await decideOf(configs.at(-1)).handler({ question: CHOICE }, { toolCallId: `reach-${id}` });
        assert.equal(answer.ok, true, `${id}: ${JSON.stringify(answer)}`);
    }
});

test("the service session and a worker without a Decision host get no decide", async (t) => {
    const fixture = managerFixture(t);
    await fixture.manager.getOrCreate("distiller", { toolNames: [], agentIdentity: "regen-distiller" }, { turnIndex: 0 });
    assert.ok(!names(fixture.configs.at(-1)).includes("decide"), "regen-distiller gets no system tools");
    const hostless = managerFixture(t, { host: null });
    await hostless.manager.getOrCreate("hostless", { toolNames: [] }, { turnIndex: 0 });
    assert.ok(!names(hostless.configs.at(-1)).includes("decide"));
    assert.ok(names(hostless.configs.at(-1)).includes("store_fact"), "other tools are unchanged");
});

test("a tools ceiling and a Workflow state's tools: remove decide unless they name it", async (t) => {
    const { manager, configs } = managerFixture(t);
    await manager.getOrCreate("ceiling", { toolNames: [], toolCeiling: ["read_facts"] }, { turnIndex: 0 });
    assert.ok(!names(configs.at(-1)).includes("decide"));
    await manager.getOrCreate("ceiling-named", { toolNames: [], toolCeiling: ["read_facts", "decide"] }, { turnIndex: 0 });
    assert.ok(names(configs.at(-1)).includes("decide"));
    await manager.getOrCreate("state", { toolNames: [], workflowInsideWorkflow: true, workflowToolLimit: ["read_facts"] }, { turnIndex: 0 });
    assert.ok(!names(configs.at(-1)).includes("decide"));
    await manager.getOrCreate("state-named", { toolNames: [], workflowInsideWorkflow: true, workflowToolLimit: ["custom:decide"] }, { turnIndex: 0 });
    assert.deepEqual(names(configs.at(-1)), ["decide"]);
});

/** The decide handler a session's live handle runs now (its config is refreshed on every getOrCreate). */
const liveDecide = (manager, sessionId) => manager.sessions.get(sessionId).config.tools.find(tool => tool.name === "decide");

test("the per-turn cap counts the calls of one turn, across a second getOrCreate in it, and starts again at the next turn", async (t) => {
    const fake = fakeDecideHost();
    const { manager } = managerFixture(t, { host: fake.host });
    await manager.getOrCreate("capped", { toolNames: [] }, { turnIndex: 0 });
    for (let index = 0; index < DECIDE_MAX_CALLS_PER_TURN; index += 1) {
        assert.equal((await liveDecide(manager, "capped").handler({ question: CHOICE }, { toolCallId: `t0-${index}` })).ok, true);
    }
    // A second getOrCreate in the same turn (a retry) keeps the turn's count.
    await manager.getOrCreate("capped", { toolNames: [] }, { turnIndex: 0 });
    const over = await liveDecide(manager, "capped").handler({ question: CHOICE }, { toolCallId: "t0-over" });
    assert.equal(over.error?.reason, "per_turn_limit", JSON.stringify(over));
    await manager.getOrCreate("capped", { toolNames: [] }, { turnIndex: 1 });
    assert.equal((await liveDecide(manager, "capped").handler({ question: CHOICE }, { toolCallId: "t1-0" })).ok, true);
});

test("each call's ledger row names the session's agent", async (t) => {
    const fake = fakeDecideHost();
    const { manager, configs } = managerFixture(t, { host: fake.host });
    await manager.getOrCreate("agent-row", { toolNames: [], agentIdentity: "triage-agent" }, { turnIndex: 0 });
    assert.equal((await decideOf(configs.at(-1)).handler({ question: CHOICE }, { toolCallId: "row" })).ok, true);
    const [claim] = fake.claims.values();
    assert.equal(claim.agentId, "triage-agent");
    assert.equal(claim.sessionId, "agent-row");
});

test("decide is a reserved name, closed to native tasks, refused in Workflow scripts and intercepted in Workflow test runs", async () => {
    assert.equal(findReservedPackageToolName(["decide"], [], []), "decide", "a package cannot shadow decide");
    assert.equal(NATIVE_SYNCHRONOUS_TOOLS.has("decide"), false, "native tasks get no platform tool unless granted (phase 2)");
    assert.equal(isWorkflowControlTool("decide"), true, "a script uses a Decision state, not decide");
    const tool = { name: "decide", handler: async () => { throw new Error("the live handler ran in a test run"); } };
    const calls = [];
    const [intercepted] = interceptWorkflowTestTools([tool], async (name, args) => { calls.push([name, args]); return { ok: true, fixture: true }; },
        error => ({ error: String(error) }));
    assert.equal(await intercepted.handler({ question: CHOICE }), JSON.stringify({ ok: true, fixture: true }));
    assert.deepEqual(calls, [["decide", { question: CHOICE }]]);
});

test("the per-turn count survives the warm handle being dropped and made again in the same turn", async (t) => {
    const fake = fakeDecideHost();
    const { manager } = managerFixture(t, { host: fake.host });
    await manager.getOrCreate("dropped", { toolNames: [] }, { turnIndex: 0 });
    for (let index = 0; index < DECIDE_MAX_CALLS_PER_TURN; index += 1) {
        assert.equal((await liveDecide(manager, "dropped").handler({ question: CHOICE }, { toolCallId: `d-${index}` })).ok, true);
    }
    await manager.dropWarmSession("dropped");
    await manager.getOrCreate("dropped", { toolNames: [] }, { turnIndex: 0 });
    const over = await liveDecide(manager, "dropped").handler({ question: CHOICE }, { toolCallId: "d-over" });
    assert.equal(over.error?.reason, "per_turn_limit", JSON.stringify(over));
});

test("a turn's Stop reaches PilotSwarm tools as invocation.turnSignal", async () => {
    const seen = [];
    const probe = { name: "decide", description: "probe", parameters: { type: "object", properties: {} },
        handler: async (_args, invocation) => { seen.push(invocation.turnSignal); return "ok"; } };
    const managed = new ManagedSession("turn-signal", { abort: async () => {} }, { tools: [probe] });
    const turnState = { pendingActions: [], queuedActions: [], subAgents: [], session: null, waitThreshold: 30, stop: new AbortController() };
    managed.activeTurnState = turnState;
    const handler = managed.buildToolHandlers(turnState).find(tool => tool.name === "decide").handler;
    await handler({}, { toolCallId: "probe-1" });
    assert.ok(seen[0] instanceof AbortSignal, "the handler gets the turn's signal");
    assert.equal(seen[0].aborted, false);
    managed.abort();
    assert.equal(seen[0].aborted, true, "an abort (Stop) aborts the turn's signal");
});

test("a build for an earlier turn index never resets the current turn's count", async (t) => {
    const fake = fakeDecideHost();
    const { manager } = managerFixture(t, { host: fake.host });
    await manager.getOrCreate("ordered", { toolNames: [] }, { turnIndex: 0 });
    await manager.getOrCreate("ordered", { toolNames: [] }, { turnIndex: 1 });
    for (let index = 0; index < DECIDE_MAX_CALLS_PER_TURN; index += 1) {
        assert.equal((await liveDecide(manager, "ordered").handler({ question: CHOICE }, { toolCallId: `o-${index}` })).ok, true);
    }
    await manager.getOrCreate("ordered", { toolNames: [] }, { turnIndex: 0 });
    const over = await liveDecide(manager, "ordered").handler({ question: CHOICE }, { toolCallId: "o-over" });
    assert.equal(over.error?.reason, "per_turn_limit", JSON.stringify(over));
});

test("the counter bound forgets only sessions without a live handle: a running turn keeps its count", async (t) => {
    const fake = fakeDecideHost();
    const { manager } = managerFixture(t, { host: fake.host });
    manager.decideTurnCountersMax = 1;
    await manager.getOrCreate("busy", { toolNames: [] }, { turnIndex: 0 });
    for (let index = 0; index < DECIDE_MAX_CALLS_PER_TURN; index += 1) {
        assert.equal((await liveDecide(manager, "busy").handler({ question: CHOICE }, { toolCallId: `b-${index}` })).ok, true);
    }
    for (const other of ["other-1", "other-2", "other-3"]) await manager.getOrCreate(other, { toolNames: [] }, { turnIndex: 0 });
    await manager.dropWarmSession("other-1");
    await manager.getOrCreate("other-4", { toolNames: [] }, { turnIndex: 0 });
    await manager.getOrCreate("busy", { toolNames: [] }, { turnIndex: 0 });
    const over = await liveDecide(manager, "busy").handler({ question: CHOICE }, { toolCallId: "b-over" });
    assert.equal(over.error?.reason, "per_turn_limit", JSON.stringify(over));
});
