/**
 * An agent's test of a revision (chat-test.ts), its gaps G1-G5, without a database:
 * - G1: a receive fixture (operation receive) is parsed only for an agent's test; the test gives it to its receive state as a
 *   real message comes (sendWorkflowInputV2: the run's contract check and acceptInput), before its clock moves; without one,
 *   a receive with a deadline still has its clock moved and one without fails TEST_STUCK, naming the fixture to add; a message
 *   the receive refuses fails the test at once (TEST_ANSWER_REFUSED).
 * - G2: a fixture's `visit` answers only that visit (exact arguments and visit, then exact arguments, then visit, then any).
 * - G3: the report lists the calls a prepared answer gave of tools the chat lacks (its grant, as the bench keeps it).
 *   RLR-F5: a grant it cannot read (or check) is said (needsToolAtRunTime null, toolsUnchecked), never an empty list.
 * - G4: `expect` (a terminal state or an outcome) decides pass; without it, outcome succeeded as before.
 * - G5: each step's predecessor and route, branch and input; an unanswered call's exact fixture skeleton.
 * The runs themselves are test/local/workflow-chat-test-gaps.test.js.
 *
 * Run: node --test test/unit/workflow-chat-test-gaps.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { matchTestFixture, parseTestFixtures, storedTestFixtures } from "../../dist/workflow/v2/test-mode.js";
import { workflowDefinitionFromTool, workflowDefinitionToolSpec } from "../../dist/workflow/v2/definition-tool.js";
import {
    chatTestBench, chatTestFixtureSkeleton, chatTestReport, parseChatTestExpect, waitChatWorkflowTest,
} from "../../dist/workflow/v2/chat-test.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";
import { canonicalJson } from "../../dist/workflow/v2/json.js";
import { WORKFLOW_V2_TEST_EPOCH } from "../../dist/workflow/v2/store.js";
import { WORKFLOW_TEST_BENCH_KIND } from "../../dist/workflow/v2/test-bench.js";
import { WORKFLOW_TOOL_POLICY } from "../../dist/workflow/tool-policy.js";
import { createWorkflowV2, previewWorkflowV2AgentVersions, sendWorkflowInputV2 } from "../../dist/workflow/v2/service.js";
import { workflowSessionGuidance, WORKFLOW_SESSION_GUIDANCE } from "../../dist/workflow/guidance.js";
import fs from "node:fs";

const sha = text => createHash("sha256").update(text).digest("hex");
const ALL = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true };
const ok = (kind = "success", value = null) => ({ kind, value });
const untouchable = what => new Proxy({}, { get: (_target, name) => { throw new Error(`${what}.${String(name)} was used`); } });

// ─── G2: visit ───

test("G2: a fixture's visit answers that visit only; exact arguments and visit, then exact arguments, then visit, then any", () => {
    const fixtures = parseTestFixtures([
        { tool: "read_build", response: ok("success", "any") },
        { tool: "read_build", visit: 2, response: ok("success", "visit 2") },
        { tool: "read_build", arguments: { id: 1 }, response: ok("success", "args") },
        { tool: "read_build", arguments: { id: 1 }, visit: 3, response: ok("success", "args visit 3") },
    ]);
    const effect = (visit, args = { id: 9 }) => ({ operation: "tool.call", tool: "read_build", state: null, argumentsSha256: sha(canonicalJson(args)), visit });
    const value = (visit, args) => matchTestFixture(fixtures, effect(visit, args))?.response.value ?? null;
    assert.equal(value(1), "any", "no fixture for visit 1: the one for any visit");
    assert.equal(value(2), "visit 2", "the visit's fixture wins over the one for any visit, whatever the order");
    assert.equal(value(3, { id: 1 }), "args visit 3", "exact arguments and visit first");
    assert.equal(value(2, { id: 1 }), "args", "exact arguments (any visit) before a visit's fixture without arguments");
    assert.equal(value(null), "any", "an effect with no visit takes only fixtures for any visit");
    // Negative control: without the any-visit fixtures, another visit has no answer.
    const only = parseTestFixtures([{ operation: "agent", state: "judge", visit: 1, response: ok("success", { outcome: "again", output: null }) }]);
    const agent = visit => matchTestFixture(only, { operation: "agent", tool: null, state: "judge", argumentsSha256: sha("null"), visit });
    assert.equal(agent(1).response.value.outcome, "again");
    assert.equal(agent(2), null, "a fixture for visit 1 never answers visit 2");
    assert.equal(agent(null), null);
});

test("G2: visit is 1 to 10000; a fixture without one keeps its stored form (no visit key); stored visits are read back and checked", () => {
    for (const visit of [0, -1, 1.5, "2", 10_001, true]) {
        assert.throws(() => parseTestFixtures([{ tool: "x", visit, response: ok() }]), /visit must be the visit it answers/, String(visit));
    }
    const [plain, visited] = parseTestFixtures([{ tool: "x", response: ok() }, { tool: "x", visit: 4, response: ok() }]);
    assert.equal(Object.hasOwn(plain, "visit"), false, "the stored form (and a test's request digest) of a fixture without visit is unchanged");
    assert.equal(canonicalJson(plain), canonicalJson({ operation: "tool.call", tool: "x", state: null, argumentsSha256: null, response: ok() }));
    assert.equal(visited.visit, 4);
    const stored = storedTestFixtures(JSON.parse(canonicalJson([plain, visited])));
    assert.deepEqual(stored.map(item => item.visit ?? null), [null, 4]);
    assert.throws(() => storedTestFixtures([{ ...JSON.parse(canonicalJson(visited)), visit: 0 }]), /invalid shape/);
});

// ─── G1: receive fixtures, parsing ───

test("G1: a receive fixture is parsed only for an agent's test: a state, the message as a success value, no arguments", () => {
    const receive = { operation: "receive", state: "await_event", response: ok("success", { buildId: 7 }) };
    // update_workflow's test takes no receive fixture (nothing gives it there).
    assert.throws(() => parseTestFixtures([receive]), /operation must be one of tool\.call, agent, send, request\./);
    const [parsed] = parseTestFixtures([receive], { receive: true });
    assert.deepEqual([parsed.operation, parsed.state, parsed.tool, parsed.argumentsSha256], ["receive", "await_event", null, null]);
    assert.equal(storedTestFixtures(JSON.parse(canonicalJson([parsed])))[0].operation, "receive");
    for (const [fixture, words] of [
        [{ ...receive, arguments: {} }, /gives the message as its response's value, not arguments/],
        [{ ...receive, response: { kind: "error", value: { code: "execution_failed", message: "m" } } }, /response is \{ kind: success, value: <the message> \}/],
        [{ operation: "receive", tool: "x", response: ok() }, /needs state/],
    ]) {
        assert.throws(() => parseTestFixtures([fixture], { receive: true }), words);
    }
});

test("G1: workflow_definition test parses receive fixtures (the start reads on); a fixture it refuses stops it first", async () => {
    const host = { store: untouchable("store"), catalog: untouchable("catalog"), duroxideClient: untouchable("duroxide"), requests: true };
    const call = args => workflowDefinitionFromTool({ operation: "test", name: "watch", ...args }, { callerSessionId: "chat", host, toolCallId: "c-1",
        owner: null, binding: async () => null }).then(text => JSON.parse(text));
    const accepted = await call({ fixtures: [{ operation: "receive", state: "await_event", visit: 2, response: ok("success", { buildId: 7 }) }] });
    assert.match(accepted.error.message, /^store\.\w+ was used$/, "parsed: the start went on to read the definition");
    const refused = await call({ fixtures: [{ operation: "receive", state: "await_event", arguments: {}, response: ok() }] });
    assert.equal(refused.error.code, "WORKFLOW_COMMAND_INVALID");
});

// ─── G1: the test gives a receive its message ───

const RECEIVER = ({ wait = false, from = "{ parent: true }" } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: watch, version: "1.0.0" }
initial: await_event
schemas:
  BuildEvent: { type: object, additionalProperties: false, required: [buildId, state], properties: { buildId: { type: integer }, state: { type: string } } }
contracts:
  BuildEvent@1: { schema: { $ref: "#/schemas/BuildEvent" } }
states:
  await_event:
    type: messaging
    mode: receive
    contract: BuildEvent@1
    from: ${from}
    correlate: { buildId: 7 }
${wait ? "    wait: { seconds: 300 }\n" : ""}    transition: { next: { received: done${wait ? ", elapsed: done" : ""} } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

/** One wait of a test whose run waits at receive await_event (visit `ordinal`), with these fixtures: what it did, and its report. */
async function receiveTest(fixtures, { wait = false, ordinal = 1, from = null, lag = 0, graceMs = 600_000 } = {}) {
    const compiled = compileWorkflowV2(RECEIVER({ wait }), ALL);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const runRow = (extra = {}) => ({ runId: "run-1", workflowSessionId: "bench-1", mode: "test", status: "running", revision: 1, irSha256: compiled.irSha256,
        controllerInstanceId: "ctl-1", terminalOutcome: null, terminalNodeId: null, terminalError: null, stop: null, finishedAt: null,
        virtualNow: new Date(Date.parse(WORKFLOW_V2_TEST_EPOCH)), createdAt: new Date(), ...extra });
    let current = runRow();
    const node = { nodeExecutionId: "nx-await", runId: "run-1", scopeId: "root", nodeId: "await_event", ordinal, nodeType: "messaging", state: "pending",
        predecessorId: null, arrivalRoute: null, input: null, inputSha256: sha("null"), outcome: null, resultKind: null, output: null, error: null, winner: null,
        receive: { contract: "BuildEvent@1", from: from ?? "chat", correlation: { buildId: 7 } },
        deadlineAt: wait ? new Date(Date.parse(WORKFLOW_V2_TEST_EPOCH) + 300_000) : null };
    const did = { accepted: [], advanced: [], cancelled: [], woken: [] };
    // `lag`: the reads of the open steps after the message is accepted before the run takes it (its receive stays open).
    let taking = null;
    const take = () => {
        node.state = "completed";
        current = runRow({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done", finishedAt: new Date() });
    };
    const store = {
        listRuns: async () => [current],
        readTestFixtures: async () => JSON.parse(canonicalJson(parseTestFixtures(fixtures, { receive: true }))),
        readRun: async () => current,
        readDefinition: async () => ({ state: "draft", parentSessionId: "chat" }),
        readRevisionIr: async () => compiled.ir,
        listOpenInterceptions: async () => ({ rows: [] }),
        listOpenNodeExecutions: async () => {
            if (taking !== null && --taking <= 0) { taking = null; take(); }
            return { rows: current.status === "running" && node.state === "pending" ? [node] : [] };
        },
        acceptInput: async input => {
            did.accepted.push(input);
            if (lag > 0) taking = lag;
            else take();
            return { receipt: { claimedBy: { nodeExecutionId: "nx-await", stateId: "await_event" } }, replayed: false, run: { ...current, status: "running" } };
        },
        advanceTestClock: async input => {
            did.advanced.push(input);
            current = runRow({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done", finishedAt: new Date() });
            throw new Error("the advance is the store's; stop here");
        },
        recordRunCancelRequest: async input => {
            did.cancelled.push(input.reason);
            current = runRow({ status: "cancelled", finishedAt: new Date(), terminalError: { code: "cancelled", message: input.reason } });
            throw new Error("the cancel is the store's; stop here");
        },
        listNodeExecutions: async () => [node],
        listInterceptions: async () => [],
    };
    const owner = { provider: "test", subject: "ada" };
    const catalog = {
        getSession: async id => id === "bench-1" ? { sessionId: id, sessionKind: "workflow", parentSessionId: "chat", deletedAt: null, isSystem: false, owner }
            : { sessionId: id, sessionKind: "agent", parentSessionId: null, deletedAt: null, isSystem: false, owner },
    };
    const duroxideClient = { enqueueEvent: async (...args) => { did.woken.push(args); } };
    const report = await waitChatWorkflowTest({ store, catalog, duroxideClient, requests: true },
        { testId: "bench-1", definitionId: "def-1", name: "watch", revision: 1 },
        { actor: { kind: "agent", sessionId: "chat" }, pollMs: 1, graceMs, waitMs: 2_000, sleep: async () => {} });
    return { did, report };
}

test("G1: a receive fixture is given as a real message (the run's input path), from its sender, before the clock moves", async () => {
    const message = { buildId: 7, state: "succeeded" };
    const { did, report } = await receiveTest([{ operation: "receive", state: "await_event", response: ok("success", message) }], { wait: true });
    assert.equal(did.accepted.length, 1);
    const [input] = did.accepted;
    assert.deepEqual({ workflowSessionId: input.workflowSessionId, runId: input.runId, senderSessionId: input.senderSessionId, operationId: input.operationId,
        contract: input.contract, correlationText: input.correlationText, payloadText: input.payloadText },
    { workflowSessionId: "bench-1", runId: "run-1", senderSessionId: "chat", operationId: "test-receive:nx-await", contract: "BuildEvent@1",
        correlationText: '{"buildId":7}', payloadText: canonicalJson(message) });
    assert.deepEqual(did.advanced, [], "its deadline is not reached first");
    assert.deepEqual(did.cancelled, []);
    assert.equal(did.woken.length, 1, "the run's controller is woken as for any message");
    assert.equal(report.status, "passed");
    // From the receive's own sender (`from`), not the chat, when it names one.
    const named = await receiveTest([{ operation: "receive", state: "await_event", response: ok("success", message) }], { from: "reporter-1" });
    assert.equal(named.did.accepted[0].senderSessionId, "reporter-1");
});

test("G1: a receive given its message keeps its clock until the run takes it; past the answer grace it is open as any receive", async () => {
    const fixtures = [{ operation: "receive", state: "await_event", response: ok("success", { buildId: 7, state: "succeeded" }) }];
    // The run takes the message only on the 5th look: its 300-second deadline must not be moved to first.
    const slow = await receiveTest(fixtures, { wait: true, lag: 5 });
    assert.equal(slow.did.accepted.length, 1, "given once, though the receive stays open for a while");
    assert.deepEqual(slow.did.advanced, [], "no clock move while the given message waits to be taken");
    assert.equal(slow.report.status, "passed");
    // Negative control: a message the run never takes holds the clock only for the grace; then the deadline path goes on.
    const never = await receiveTest(fixtures, { wait: true, lag: Number.POSITIVE_INFINITY, graceMs: 0 });
    assert.equal(never.did.accepted.length, 1, "still given only once");
    assert.equal(never.did.advanced.length, 1);
});

test("G1 negative controls: no receive fixture moves the clock (deadline) or fails TEST_STUCK naming the fixture to add (no deadline)", async () => {
    const timed = await receiveTest([], { wait: true });
    assert.deepEqual(timed.did.accepted, []);
    assert.equal(timed.did.advanced.length, 1, "today's deadline path");
    const stuck = await receiveTest([]);
    assert.deepEqual(stuck.did.accepted, []);
    assert.equal(stuck.did.cancelled.length, 1);
    assert.match(stuck.did.cancelled[0], /^TEST_STUCK: no prepared answer for the receive step await_event\. A receive step's message is a fixture /);
    assert.equal(stuck.report.status, "failed");
    assert.equal(stuck.report.unanswered.call, "receive step await_event");
    assert.deepEqual(stuck.report.unanswered.fixture, { operation: "receive", state: "await_event",
        response: { kind: "success", value: "<the message, as its contract's schema says>" } });
    assert.deepEqual(stuck.report.firstError.step, "await_event");
    assert.match(stuck.report.message, /failed: no prepared answer for the receive step await_event\. Add a fixture for it/);
});

test("G1 + G2: a receive fixture for another visit is not given; the visit's own one is", async () => {
    const fixtures = [{ operation: "receive", state: "await_event", visit: 1, response: ok("success", { buildId: 7, state: "running" }) }];
    const other = await receiveTest(fixtures, { ordinal: 2 });
    assert.deepEqual(other.did.accepted, []);
    assert.deepEqual(other.report.unanswered.fixture.visit, 2, "the skeleton names the visit it needs");
    const own = await receiveTest([...fixtures, { operation: "receive", state: "await_event", visit: 2, response: ok("success", { buildId: 7, state: "done" }) }],
        { ordinal: 2 });
    assert.equal(own.did.accepted[0].payloadText, canonicalJson({ buildId: 7, state: "done" }));
});

test("G1: a message its contract refuses fails the test at once (TEST_ANSWER_REFUSED), naming the receive and why", async () => {
    const { did, report } = await receiveTest([{ operation: "receive", state: "await_event", response: ok("success", { buildId: "seven" }) }]);
    assert.deepEqual(did.accepted, [], "refused before it is stored");
    assert.equal(did.cancelled.length, 1);
    assert.match(did.cancelled[0], /^TEST_ANSWER_REFUSED: the prepared answer for the receive step await_event was refused: The payload does not match contract BuildEvent@1\./);
    assert.equal(report.status, "failed");
    assert.equal(report.refused.call, "receive step await_event");
    assert.equal(report.unanswered, null);
    assert.equal(report.firstError.step, "await_event");
    assert.match(report.message, / Fix that fixture and test again\.$/);
});

// ─── G3, G4, G5: the report ───

const visitRow = (nodeId, ordinal, extra = {}) => ({ nodeExecutionId: `nx-${nodeId}-${ordinal}`, nodeId, ordinal, scopeId: "root", nodeType: "script",
    state: "completed", winner: "effect", output: null, error: null, outcome: null, resultKind: null, predecessorId: null, arrivalRoute: null,
    input: null, inputSha256: sha("null"), ...extra });
const runOf = extra => ({ runId: "run-1", workflowSessionId: "bench-1", revision: 1, irSha256: "ir", status: "completed", terminalOutcome: "succeeded",
    terminalNodeId: "done", terminalError: null, stop: null, virtualNow: new Date(Date.parse(WORKFLOW_V2_TEST_EPOCH)), createdAt: new Date(),
    finishedAt: new Date(), ...extra });
const BENCH = { testId: "bench-1", definitionId: "def-1", name: "watch", revision: 1 };
const reportHost = (nodes, interceptions, extra = {}) => ({ store: { listNodeExecutions: async () => nodes, listInterceptions: async () => interceptions,
    readRevisionIr: async () => { throw new Error("no revision here"); }, ...extra.store }, ...(extra.catalog ? { catalog: extra.catalog } : {}) });
const binding = tools => ({ policy: WORKFLOW_TOOL_POLICY, parentSessionId: "chat", owner: { provider: "test", subject: "ada" }, config: {},
    capabilities: { selections: [] }, tools: tools.map(name => ({ name, schemaHash: "h" })), sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "f" });

test("G3: the report lists the answered calls of tools the chat lacks (its grant on the bench); none when it has them all", async () => {
    const nodes = [visitRow("poll", 1, { outcome: "ok", resultKind: "business" }), visitRow("done", 1, { nodeType: "terminal", outcome: "succeeded", resultKind: "business" })];
    const calls = ["read_build", "post_status", "post_status"].map((tool, index) => ({ interceptionId: `i-${index}`, nodeExecutionId: "nx-poll-1",
        operation: "tool.call", tool, arguments: {}, state: "responded", response: { disposition: "fixture" } }));
    const withGrant = tools => chatTestReport(reportHost(nodes, calls, { catalog: { getSessionCreationConfig: async id => {
        assert.equal(id, "bench-1");
        return tools === null ? {} : { workflowToolBinding: binding(tools) };
    } } }), BENCH, runOf());
    const lacking = await withGrant(["read_build"]);
    assert.equal(lacking.status, "passed", "a test of a tool the chat lacks still passes");
    assert.deepEqual(lacking.needsToolAtRunTime, [{ call: "tool call post_status in step poll", tool: "post_status" }]);
    assert.match(lacking.message, /passed: it ended at done \(succeeded\)\. Its scripts call tools this chat does not have \(post_status\): the test answered them, but a run of this revision needs them\.$/);
    // Negative controls: a grant with both lists none; no grant at all lists every tool called (a grant that cannot be read: RLR-F5).
    assert.deepEqual((await withGrant(["read_build", "post_status"])).needsToolAtRunTime, []);
    assert.deepEqual((await withGrant(null)).needsToolAtRunTime.map(item => item.tool), ["read_build", "post_status"]);
});

test("RLR-F5: a grant the report cannot read or check is said so (needsToolAtRunTime null, toolsUnchecked), never the plain pass words", async () => {
    const nodes = [visitRow("poll", 1, { outcome: "ok", resultKind: "business" }), visitRow("done", 1, { nodeType: "terminal", outcome: "succeeded", resultKind: "business" })];
    const calls = ["read_build", "post_status", "post_status"].map((tool, index) => ({ interceptionId: `i-${index}`, nodeExecutionId: "nx-poll-1",
        operation: "tool.call", tool, arguments: {}, state: "responded", response: { disposition: "fixture" } }));
    const report = (catalog, interceptions = calls) => chatTestReport(reportHost(nodes, interceptions, catalog ? { catalog } : {}), BENCH, runOf());
    const withGrant = tools => ({ getSessionCreationConfig: async () => ({ workflowToolBinding: binding(tools) }) });
    // Controls: fully granted (checked, nothing missing, the plain pass words) and a missing tool (named).
    const granted = await report(withGrant(["read_build", "post_status"]));
    const plain = "The test of watch revision 1 passed: it ended at done (succeeded).";
    assert.deepEqual(granted.needsToolAtRunTime, []);
    assert.equal(granted.message, plain);
    const lacking = await report(withGrant(["read_build"]));
    assert.deepEqual(lacking.needsToolAtRunTime, [{ call: "tool call post_status in step poll", tool: "post_status" }]);
    for (const [what, catalog, reason] of [
        ["an invalid stored grant", { getSessionCreationConfig: async () => ({ workflowToolBinding: { policy: "?" } }) }, "the chat's tool grant, as the test keeps it, is not valid"],
        ["a grant read that fails", { getSessionCreationConfig: async () => { throw new Error("connection reset by 10.0.0.7"); } }, "the chat's tool grant could not be read"],
        ["a bench with no settings", { getSessionCreationConfig: async () => null }, "the chat's tool grant could not be read"],
        ["a host that cannot read grants", null, "this host cannot read the chat's tool grant"],
    ]) {
        const unchecked = await report(catalog);
        assert.equal(unchecked.status, "passed", `${what}: the run still ended as expected`);
        assert.notEqual(unchecked.message, granted.message, `${what}: never the fully granted test's words`);
        assert.notDeepEqual(unchecked.needsToolAtRunTime, granted.needsToolAtRunTime, `${what}: never the fully granted test's empty list`);
        assert.equal(unchecked.needsToolAtRunTime, null, `${what}: unknown, not an empty list`);
        assert.deepEqual(unchecked.toolsUnchecked, { reason, tools: ["read_build", "post_status"] }, what);
        assert.equal(unchecked.message, `${plain} It could not check whether this chat has the tools its scripts call (read_build, post_status): ${reason}. `
            + "The test answered those calls, but a run of this revision needs each of them; read this test again with workflow_definition "
            + "operation test and test_id bench-1 to check them.", what);
    }
    assert.deepEqual([granted.toolsUnchecked, lacking.toolsUnchecked], [null, null], "checked: nothing unchecked");
    // No tool call: nothing to check (the grant is not read), and nothing is said.
    const none = await report({ getSessionCreationConfig: async () => { throw new Error("not read"); } }, []);
    assert.deepEqual([none.needsToolAtRunTime, none.toolsUnchecked, none.message], [[], null, plain]);
});

const ENDS_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ends, version: "1.0.0" }
initial: check
states:
  check:
    type: script
    outcomes: [good, bad]
    source: |
      await setResult("bad", null);
    transition: { next: { good: done, bad: rejected, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  rejected: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

test("G4: expect names a terminal state of the revision or an outcome; anything else is refused with what it may name", () => {
    const { ir } = compileWorkflowV2(ENDS_YAML, ALL);
    assert.deepEqual(parseChatTestExpect("rejected", ir), { state: "rejected" });
    assert.deepEqual(parseChatTestExpect("failed", ir), { state: "failed" }, "a terminal state's id wins over the outcome of that name");
    assert.deepEqual(parseChatTestExpect("blocked", ir), { outcome: "blocked" });
    assert.equal(parseChatTestExpect(undefined, ir), null);
    for (const value of ["check", "nowhere", "", 7, "x".repeat(65)]) {
        assert.throws(() => parseChatTestExpect(value, ir), error => error.code === "WORKFLOW_COMMAND_INVALID"
            && /a terminal state \(done, rejected, failed\) or an outcome \(succeeded, blocked, failed, cancelled\)\. Nothing was tested\.$/.test(error.message),
        String(value));
    }
});

test("G4: pass is the expected end (that state or outcome) with nothing unanswered or refused; without expect, outcome succeeded", async () => {
    const nodes = [visitRow("check", 1, { outcome: "bad", resultKind: "business" }), visitRow("rejected", 1, { nodeType: "terminal", outcome: "blocked", resultKind: "business" })];
    const blocked = runOf({ terminalOutcome: "blocked", terminalNodeId: "rejected" });
    const report = expect => chatTestReport(reportHost(nodes, []), { ...BENCH, expect }, blocked);
    const asState = await report({ state: "rejected" });
    assert.equal(asState.status, "passed");
    assert.deepEqual(asState.expect, { state: "rejected" });
    assert.equal(asState.message, "The test of watch revision 1 passed: it ended at rejected (blocked), as expected.");
    assert.equal((await report({ outcome: "blocked" })).status, "passed");
    // Negative controls: another state or outcome, and no expect at all (succeeded), fail.
    const elsewhere = await report({ state: "done" });
    assert.equal(elsewhere.status, "failed");
    assert.equal(elsewhere.message, "The test of watch revision 1 failed: it ended completed (blocked) at rejected, not at the expected state done.");
    assert.equal((await report({ outcome: "failed" })).status, "failed");
    assert.equal((await report(null)).status, "failed");
    assert.equal((await report(undefined)).expect, null);
    // An unanswered call fails it, even at the expected end (here: a cancelled outcome is not a cancel by the test).
    const waiting = [{ interceptionId: "i-1", nodeExecutionId: "nx-check-1", operation: "tool.call", tool: "x", arguments: {}, state: "awaiting_parent", response: null }];
    const cancelled = await chatTestReport(reportHost([visitRow("check", 1, { state: "pending" })], waiting), { ...BENCH, expect: { outcome: "cancelled" } },
        runOf({ status: "cancelled", terminalOutcome: null, terminalNodeId: null, terminalError: { code: "cancelled", message: "TEST_UNANSWERED: no prepared answer for the tool call x in step check." } }));
    assert.equal(cancelled.status, "failed");
});

test("G4: the tool declares expect with tests (bounded) and not without; a bad expect is refused before anything is read; the bench keeps it", async () => {
    const spec = workflowDefinitionToolSpec();
    assert.equal(spec.parameters.properties.expect.type, "string");
    assert.equal(spec.parameters.properties.expect.maxLength, 64);
    assert.equal(Object.hasOwn(workflowDefinitionToolSpec({ tests: false }).parameters.properties, "expect"), false);
    const host = { store: untouchable("store"), catalog: untouchable("catalog"), duroxideClient: untouchable("duroxide"), requests: true };
    for (const expect of [7, "", "x".repeat(65), { state: "done" }]) {
        const refused = JSON.parse(await workflowDefinitionFromTool({ operation: "test", name: "watch", expect }, { callerSessionId: "chat", host,
            toolCallId: "c", owner: null, binding: async () => null }));
        assert.equal(refused.error.code, "WORKFLOW_COMMAND_INVALID", JSON.stringify(expect));
        assert.match(refused.error.message, /^expect must be a terminal state id or an outcome/);
    }
    // The bench's creation config keeps it; chatTestBench reads it (and none when it has none).
    const catalog = config => ({ getSession: async id => ({ sessionId: id, parentSessionId: "chat", deletedAt: null, serviceKind: WORKFLOW_TEST_BENCH_KIND }),
        getSessionCreationConfig: async () => config });
    const store = { chat: { readDefinition: async () => ({ name: "watch" }) } };
    assert.deepEqual((await chatTestBench({ catalog: catalog({ agentTest: { definitionId: "def-1", revision: 1, expect: { state: "rejected" } } }), store }, "chat", "b"))
        .expect, { state: "rejected" });
    assert.equal((await chatTestBench({ catalog: catalog({ agentTest: { definitionId: "def-1", revision: 1 } }), store }, "chat", "b")).expect, null);
});

test("RLR-F6: a test bench's expect (and revision) is part of its creation: a replay with another is WORKFLOW_EXISTS before anything is stored", async () => {
    // A catalog that keeps the claim's creation config (as JSONB does), and a store that counts what reaches it.
    let claimed = null;
    const reached = [];
    const host = { requests: true, scripts: true,
        catalog: {
            createWorkflowSessionV2: async (_id, options) => {
                if (claimed) return { created: false };
                claimed = JSON.parse(JSON.stringify(options.creationConfig));
                return { created: true };
            },
            getSession: async id => ({ sessionId: id, sessionKind: "workflow", parentSessionId: "chat", deletedAt: null, owner: null }),
            getSessionCreationConfig: async () => claimed,
        },
        store: { readDefinition: async () => null,
            createDefinition: async input => { reached.push(input.operationId); return { receipt: { run: null }, replayed: reached.length > 1 }; } },
    };
    const create = (expect, revision = 1) => createWorkflowV2(host, { workflowSessionId: "bench-1", parentSessionId: "chat", yaml: ENDS_YAML,
        actor: { kind: "agent", sessionId: "chat" }, operationId: "test-bench:op-1", publish: false, notifyParent: false,
        testBench: { definitionId: "def-1", revision, ...(expect ? { expect } : {}) } });
    await create({ state: "rejected" });
    assert.deepEqual(claimed.agentTest, { definitionId: "def-1", revision: 1, expect: { state: "rejected" } });
    assert.deepEqual(reached, ["test-bench:op-1"]);
    for (const [what, expect, revision] of [["another state", { state: "done" }], ["an outcome", { outcome: "blocked" }], ["none (the default)", null],
        ["another revision", { state: "rejected" }, 2]]) {
        const error = await create(expect, revision).then(() => null, refused => refused);
        assert.equal(error?.code, "WORKFLOW_EXISTS", what);
        assert.match(error.message, /^Test bench-1 was started by a different request \(another revision or expect\) under this operation; nothing was tested\./);
    }
    assert.deepEqual(reached, ["test-bench:op-1"], "nothing reached the store for a changed request");
    assert.deepEqual(claimed.agentTest.expect, { state: "rejected" }, "the stored test is unchanged");
    // The same expect: the same request (the store answers it from what it made).
    await create({ state: "rejected" });
    assert.equal(reached.length, 2);
    // The default (no expect: outcome succeeded) is its own identity: none again is the same; outcome succeeded is not.
    claimed = null;
    reached.length = 0;
    await create(null);
    assert.equal(Object.hasOwn(claimed.agentTest, "expect"), false);
    await create(null);
    assert.equal((await create({ outcome: "succeeded" }).then(() => null, refused => refused))?.code, "WORKFLOW_EXISTS");
    assert.equal(reached.length, 2);
});

const BRANCHES_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: views, version: "1.0.0" }
initial: views
states:
  views:
    type: parallel
    branches:
      quick: { initial: q, states: { q: { type: wait, seconds: 1, transition: { next: { elapsed: q_done } } }, q_done: { type: terminal, outcome: succeeded } } }
      careful: { initial: c, states: { c: { type: wait, seconds: 1, transition: { next: { elapsed: c_done } } }, c_done: { type: terminal, outcome: succeeded } } }
    transition: { next: { joined: items, blocked: done } }
  items:
    type: parallel
    forEach: [1, 2]
    body: { initial: i, states: { i: { type: wait, seconds: 1, transition: { next: { elapsed: i_done } } }, i_done: { type: terminal, outcome: succeeded } } }
    transition: { next: { joined: judge, blocked: done } }
  judge:
    type: agent
    invoke: { prompt: "Judge it." }
    outcomes: [again, finish]
    timeoutSeconds: 600
    transition: { next: { again: judge, finish: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`;

test("G5: each step says the step and route it came by, its branch (a named branch, or item N of a For each) and its input", async () => {
    const compiled = compileWorkflowV2(BRANCHES_YAML, ALL);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const fork = "nx-aa11", items = "nx-bb22";
    const nodes = [
        visitRow("views", 1, { nodeExecutionId: fork, nodeType: "parallel", outcome: "joined", resultKind: "business" }),
        visitRow("q", 1, { scopeId: `${fork}#0`, nodeType: "wait", predecessorId: fork, input: { text: "a".repeat(400) } }),
        visitRow("c", 1, { scopeId: `${fork}#1`, nodeType: "wait", predecessorId: fork }),
        visitRow("items", 1, { nodeExecutionId: items, nodeType: "parallel", predecessorId: fork, arrivalRoute: "joined" }),
        visitRow("i", 1, { scopeId: `${items}#1`, nodeType: "wait", predecessorId: items, input: 2 }),
        visitRow("judge", 1, { nodeType: "agent", predecessorId: items, arrivalRoute: "joined", outcome: "again", resultKind: "business" }),
        visitRow("judge", 2, { nodeType: "agent", predecessorId: "nx-judge-1", arrivalRoute: "again" }),
    ];
    const report = await chatTestReport({ store: { listNodeExecutions: async () => nodes, listInterceptions: async () => [],
        readRevisionIr: async () => compiled.ir } }, BENCH, runOf({ status: "running", finishedAt: null }));
    const step = (id, visit = 1) => report.path.find(item => item.step === id && item.visit === visit);
    assert.equal(Object.hasOwn(step("views"), "enteredBy"), false, "the first step came from nowhere");
    assert.equal(Object.hasOwn(step("views"), "branch"), false);
    assert.deepEqual([step("q").branch, step("c").branch, step("i").branch], ["quick", "careful", "item 2"]);
    assert.deepEqual(step("items").enteredBy, { step: "views", route: "joined" });
    assert.deepEqual(step("judge", 2).enteredBy, { step: "judge", route: "again" });
    assert.equal(step("i").input, "2");
    assert.ok(step("q").input.length === 161 && step("q").input.startsWith('{"text":"aaa') && step("q").input.endsWith("…"), step("q").input);
    assert.equal(Object.hasOwn(step("c"), "input"), false, "no input, no preview");
    // Without the revision (it cannot be read), a branch is still named by its index.
    const blind = await chatTestReport(reportHost(nodes, []), BENCH, runOf({ status: "running", finishedAt: null }));
    assert.deepEqual(blind.path.filter(item => item.branch).map(item => item.branch), ["item 1", "item 2", "item 2"]);
});

test("G5: an unanswered call's fixture skeleton is exact: parsed and matched, it answers that call (and that visit only)", async () => {
    const compiled = compileWorkflowV2(BRANCHES_YAML, ALL);
    const input = { round: 2, notes: ["x"] };
    const judge = visitRow("judge", 2, { nodeType: "agent", state: "pending", input, inputSha256: sha(canonicalJson(input)) });
    const waiting = [{ interceptionId: "i-1", nodeExecutionId: judge.nodeExecutionId, operation: "agent", tool: null, arguments: null, state: "awaiting_parent", response: null }];
    const report = await chatTestReport({ store: { listNodeExecutions: async () => [judge], listInterceptions: async () => waiting,
        readRevisionIr: async () => compiled.ir } }, BENCH,
    runOf({ status: "cancelled", terminalOutcome: null, terminalNodeId: null, terminalError: { code: "cancelled", message: "TEST_UNANSWERED: no prepared answer for the agent step judge. x" } }));
    const skeleton = report.unanswered.fixture;
    assert.deepEqual(skeleton, { operation: "agent", state: "judge", arguments: input, visit: 2,
        response: { kind: "success", value: { outcome: "<one of: again, finish>", output: "<its output, as its outputSchema says>" } } });
    const [parsed] = parseTestFixtures([skeleton]);
    const effect = visit => ({ operation: "agent", tool: null, state: "judge", argumentsSha256: judge.inputSha256, visit });
    assert.equal(matchTestFixture([parsed], effect(2)), parsed, "it answers the call it was made for");
    assert.equal(matchTestFixture([parsed], effect(1)), null, "and not another visit");
    // A tool call's skeleton carries the call's arguments (its script's visit only past the first); a large input is left out.
    assert.deepEqual(chatTestFixtureSkeleton({ operation: "tool.call", tool: "read_build", arguments: { id: 1 } }, { nodeId: "poll", ordinal: 1, input: null }),
        { operation: "tool.call", tool: "read_build", arguments: { id: 1 }, response: { kind: "success", value: "<what the tool returns>" } });
    assert.equal(Object.hasOwn(chatTestFixtureSkeleton({ operation: "send" }, { nodeId: "s", ordinal: 1, input: { big: "y".repeat(3_000) } }), "arguments"), false);
    assert.deepEqual(chatTestFixtureSkeleton({ operation: "request" }, { nodeId: "ask", ordinal: 3, input: null }).response.value,
        { response: "<the answer, as its contract's response schema says>" });
});

// ─── What the chat reads: the tool, the guidance, the skills, the service's words ───

const skillText = name => fs.readFileSync(new URL(`../../plugins/workflow-v2/skills/${name}/SKILL.md`, import.meta.url), "utf8");
const flat = text => text.replace(/\s+/g, " ");

test("the test's fixtures declaration names the load_skill call; the guidance says expect and receive fixtures, within its budget", () => {
    const fixtures = workflowDefinitionToolSpec({ tests: true }).parameters.properties.fixtures.description;
    assert.match(fixtures, /call load_skill with name workflow-tools/);
    assert.doesNotMatch(fixtures, /load_skill workflow-tools/, "never the bare `load_skill workflow-tools`");
    const sentence = "A test's `expect` names its end; receive fixtures give its messages.";
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes(sentence));
    const usual = workflowSessionGuidance(false, { scripts: true, clockWaits: true, requests: true });
    assert.ok(usual.includes(sentence) && usual.length <= 2250, `${usual.length}`);
    assert.ok(WORKFLOW_SESSION_GUIDANCE.length <= 2100, `${WORKFLOW_SESSION_GUIDANCE.length}`);
    // G-4: every turn runs a test (a frozen 1.0.82 turn's host too), so the test line stays; inside a Workflow, where no
    // definition is written, it gives way with the definition paragraphs.
    assert.ok(workflowSessionGuidance(false, { requests: false }).includes(sentence));
    assert.ok(!workflowSessionGuidance(false, { insideWorkflow: true }).includes(sentence));
});

test("the skills teach receive and visit fixtures, expect, the report's fields and tools a run needs, within their budgets", () => {
    const tools = flat(skillText("workflow-tools"));
    for (const phrase of [
        "`fixtures`, `expect?`, `test_id?`", "`send`, `request` or `receive` (`state` names the step)",
        "`visit` (1 or more): it answers only the n-th time the run reaches that state",
        "`receive`: the message a receive step gets, as `value` (no `arguments`).",
        "- { operation: receive, state: await_event, visit: 2, response: { kind: success, value: { buildId: 7, state: succeeded } } }",
        "the report lists it in `needsToolAtRunTime`: a run of the revision needs that tool.", "Control tools (such as `spawn_agent`) are always refused.",
        "`expect`: the terminal state id or the outcome (`succeeded`, `blocked`, `failed`, `cancelled`) the test must end at; default outcome `succeeded`.",
        "`enteredBy`: the step and route it came from; `branch`: its named branch or `item N` of a For each; `input`: a preview",
        "`unanswered`, whose `fixture` is the exact fixture to add: replace its `<...>` value.",
    ]) assert.ok(tools.includes(phrase), `workflow-tools: ${phrase}`);
    const patterns = flat(skillText("workflow-patterns"));
    for (const phrase of ["## Testing these patterns", "`{ operation: agent, state: quick_summary, ... }`", "`visit` counts per item",
        "In a loop, `visit: n` answers the n-th round of a state", "`{ operation: receive, state: <id>, visit?, response: { kind: success, value: <message> } }`"]) {
        assert.ok(patterns.includes(phrase), `workflow-patterns: ${phrase}`);
    }
    const authoring = flat(skillText("workflow-authoring"));
    for (const phrase of ["4. Test only when the person asks: `test` with `inputs`, `fixtures` (prepared answers) and `expect` (the end it must reach)",
        "`{ operation: receive, state: await_event, response: { kind: success, value: { buildId: 7, state: succeeded } } }`, `expect: done`."]) {
        assert.ok(authoring.includes(phrase), `workflow-authoring: ${phrase}`);
    }
    for (const [name, max] of [["workflow-tools", 20 * 1024], ["workflow-authoring", 20 * 1024], ["workflow-patterns", 8 * 1024]]) {
        assert.ok(Buffer.byteLength(skillText(name), "utf8") <= max, `${name}: ${Buffer.byteLength(skillText(name), "utf8")}`);
    }
});

test("the service's refusals say Workflow, never v2", async () => {
    const none = { store: { readDefinition: async () => null }, catalog: untouchable("catalog"), duroxideClient: untouchable("duroxide") };
    await assert.rejects(previewWorkflowV2AgentVersions(none, "wf-1"), error => error.code === "WORKFLOW_NOT_FOUND" && error.message === "No Workflow wf-1.");
    await assert.rejects(sendWorkflowInputV2(none, { workflowSessionId: "wf-1", senderSessionId: "chat", contract: "X@1", payload: {}, operationId: "op-1" }),
        error => error.code === "WORKFLOW_NOT_FOUND" && error.message === "Session wf-1 is not a durable Workflow.");
    const built = fs.readFileSync(new URL("../../dist/workflow/v2/service.js", import.meta.url), "utf8");
    assert.ok(built.includes("already exists and is not this parent's Workflow; nothing was changed."));
    assert.ok(built.includes('"This session catalog cannot create Workflows."'));
    for (const old of ["parent's v2 workflow", "No v2 workflow", "is not a version 2 workflow", "cannot create v2 workflows"]) {
        assert.ok(!built.includes(old), old);
    }
});
