/**
 * Workflow Simplified stage 2.2, without a database: an agent's test of a revision, on request (chat-test.ts).
 * - Prepared answers: a fixture without arguments answers any call of its tool or state, but only when no fixture gives
 *   that call's exact arguments; stored fixtures keep it.
 * - The test call is refused before anything is read: on a host that runs no tests (WORKFLOW_TEST_UNAVAILABLE), without a
 *   name, with fixtures that are not prepared answers; a test id that is not this chat's test bench is TEST_NOT_FOUND.
 * - The report: the path, each visit's outcome and output, the first error in words, a call it had no answer for, the calls
 *   answered, the virtual time its waits took; passed only when the run completed with outcome succeeded.
 * - The test bench is a service session (workflow-test) and the scripts gate says "Nothing was tested.".
 * The runs themselves (fixtures answering, the clock, the cancel, the hiding) are test/local/workflow-chat-test.test.js.
 *
 * Run: node --test test/unit/workflow-chat-test.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { matchTestFixture, parseTestFixtures, storedTestFixtures } from "../../dist/workflow/v2/test-mode.js";
import { workflowDefinitionFromTool } from "../../dist/workflow/v2/definition-tool.js";
import { chatTestReport, testAnswerShapeWords, waitChatWorkflowTest, WORKFLOW_DEFINITION_TEST_WAIT_MS } from "../../dist/workflow/v2/chat-test.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";
import { isWorkflowTestBench, WORKFLOW_TEST_BENCH_KIND } from "../../dist/workflow/v2/test-bench.js";
import { workflowScriptsDisabledText } from "../../dist/workflow/v2/scripts-gate.js";
import { WORKFLOW_V2_TEST_EPOCH } from "../../dist/workflow/v2/store.js";

const sha = text => createHash("sha256").update(text).digest("hex");
const untouchable = what => new Proxy({}, { get: (_target, name) => { throw new Error(`${what}.${String(name)} was used`); } });
const call = (args, host, extra = {}) => workflowDefinitionFromTool(args, { callerSessionId: "chat", host, toolCallId: "call-1", owner: null,
    binding: async () => null, ...extra }).then(text => JSON.parse(text));

test("a fixture without arguments answers any call of its tool or step, after every exact one; stored fixtures keep it", () => {
    const fixtures = parseTestFixtures([
        { tool: "read_build", response: { kind: "success", value: { state: "any" } } },
        { tool: "read_build", arguments: { buildId: 7 }, response: { kind: "success", value: { state: "seven" } } },
        { operation: "agent", state: "summarize", response: { kind: "success", value: { outcome: "done", output: { lines: 3 } } } },
    ]);
    assert.equal(fixtures[0].argumentsSha256, null);
    assert.equal(fixtures[1].argumentsSha256, sha('{"buildId":7}'));
    const exact = matchTestFixture(fixtures, { operation: "tool.call", tool: "read_build", state: null, argumentsSha256: sha('{"buildId":7}') });
    assert.deepEqual(exact.response.value, { state: "seven" }, "the exact one first, whatever the order");
    const any = matchTestFixture(fixtures, { operation: "tool.call", tool: "read_build", state: null, argumentsSha256: sha('{"buildId":8}') });
    assert.deepEqual(any.response.value, { state: "any" });
    assert.equal(matchTestFixture(fixtures, { operation: "tool.call", tool: "store_fact", state: null, argumentsSha256: sha("{}") }), null);
    assert.equal(matchTestFixture(fixtures, { operation: "agent", tool: null, state: "summarize", argumentsSha256: sha("null") }).response.value.outcome, "done");
    assert.equal(matchTestFixture(fixtures, { operation: "agent", tool: null, state: "other", argumentsSha256: sha("null") }), null);
    assert.deepEqual(storedTestFixtures(JSON.parse(JSON.stringify(fixtures))).map(item => item.argumentsSha256), [null, sha('{"buildId":7}'), null]);
    assert.throws(() => storedTestFixtures([{ ...JSON.parse(JSON.stringify(fixtures[0])), argumentsSha256: 7 }]), /invalid shape/);
});

test("the test call is refused before anything is read: no test host, no name, fixtures that are not prepared answers, another session's id", async () => {
    const host = { store: untouchable("store"), catalog: untouchable("catalog"), duroxideClient: untouchable("duroxide") };
    const unavailable = await call({ operation: "test", name: "hn" }, host);
    assert.equal(unavailable.error.code, "WORKFLOW_TEST_UNAVAILABLE");
    assert.match(unavailable.error.message, /^This deployment cannot run Workflow tests\. Nothing was tested;/);
    const tester = { ...host, requests: true };
    assert.equal((await call({ operation: "test" }, tester)).error.code, "WORKFLOW_COMMAND_INVALID");
    for (const fixtures of ["none", [{ tool: "x" }], [{ tool: "x", response: { kind: "maybe" } }], [{ arguments: {}, response: { kind: "success", value: 1 } }]]) {
        const refused = await call({ operation: "test", name: "hn", fixtures }, tester);
        assert.equal(refused.error.code, "WORKFLOW_COMMAND_INVALID", JSON.stringify(fixtures));
    }
    const catalog = {
        getSession: async id => ({ sessionId: id, parentSessionId: id === "other-chat-bench" ? "other-chat" : "chat", deletedAt: null,
            serviceKind: id === "plain" ? null : WORKFLOW_TEST_BENCH_KIND }),
        getSessionCreationConfig: async () => ({ agentTest: { definitionId: "def-1", revision: 2 } }),
    };
    for (const testId of ["other-chat-bench", "plain"]) {
        const missing = await call({ operation: "test", test_id: testId }, { ...tester, catalog });
        assert.equal(missing.error.code, "TEST_NOT_FOUND", testId);
    }
});

test("the test bench is a service session; the scripts gate's words for a test", () => {
    assert.equal(WORKFLOW_TEST_BENCH_KIND, "workflow-test");
    assert.equal(isWorkflowTestBench({ serviceKind: "workflow-test" }), true);
    for (const row of [{ serviceKind: null }, { serviceKind: "regen-distiller" }, {}, null]) assert.equal(isWorkflowTestBench(row), false);
    assert.match(workflowScriptsDisabledText(["poll"], "test"), /Nothing was tested\.$/);
    assert.ok(WORKFLOW_DEFINITION_TEST_WAIT_MS < 5 * 60_000, "under a turn's 5-minute inactivity guard");
});

/** A store with one test run's visits and calls. */
function reportStore(nodes, interceptions) {
    return { listNodeExecutions: async () => nodes, listInterceptions: async () => interceptions };
}
const visit = (nodeId, ordinal, extra) => ({ nodeExecutionId: `nx-${nodeId}-${ordinal}`, nodeId, ordinal, state: "completed", winner: "effect",
    output: null, error: null, outcome: null, resultKind: null, inputSha256: sha("null"), ...extra });
const bench = { testId: "bench-1", definitionId: "def-1", name: "hn-top-watch", revision: 3 };
const run = extra => ({ runId: "run-1", status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done", terminalError: null, stop: null,
    virtualNow: new Date(Date.parse(WORKFLOW_V2_TEST_EPOCH) + 90_000), createdAt: new Date(Date.now() - 4_000), finishedAt: new Date(), ...extra });

test("the report of a passed test: its path, outputs, mocked answers and the virtual time of its waits", async () => {
    const nodes = [
        visit("poll", 1, { outcome: "changed", resultKind: "business", output: { stories: 3 } }),
        visit("summarize", 1, { outcome: "done", resultKind: "business", output: { lines: 3 }, winner: "test" }),
        visit("pause", 1, { outcome: "elapsed", resultKind: "business", output: null }),
        visit("done", 1, { outcome: "succeeded", resultKind: "business", output: null }),
    ];
    const interceptions = [
        { interceptionId: "i-1", nodeExecutionId: "nx-poll-1", operation: "tool.call", tool: "web_fetch", arguments: { url: "https://example.com" },
            state: "responded", response: { disposition: "fixture" } },
        { interceptionId: "i-2", nodeExecutionId: "nx-summarize-1", operation: "agent", tool: null, arguments: null, state: "responded", response: { disposition: "fixture" } },
    ];
    const report = await chatTestReport({ store: reportStore(nodes, interceptions) }, bench, run());
    assert.equal(report.status, "passed");
    assert.deepEqual(report.path.map(item => [item.step, item.outcome, item.mocked]),
        [["poll", "changed", false], ["summarize", "done", true], ["pause", "elapsed", false], ["done", "succeeded", false]]);
    assert.equal(report.path[0].output, '{"stories":3}');
    assert.deepEqual(report.answeredCalls, [{ call: "tool call web_fetch in step poll", by: "prepared answer" }, { call: "agent step summarize", by: "prepared answer" }]);
    assert.equal(report.waitedVirtualSeconds, 90);
    assert.equal(report.firstError, null);
    assert.equal(report.unanswered, null);
    assert.match(report.notice, /scripts run normally/);
    assert.equal(report.message, "The test of hn-top-watch revision 3 passed: it ended at done (succeeded).");
});

test("the report of a failed test names its first error in words, or the call it had no answer for; a running test says how to read it", async () => {
    const stderr = `${"    at frame (file:///x.mjs:1:1)\n".repeat(30)}Error: Unknown model: gpt-imaginary`;
    const failedNodes = [visit("poll", 1, { outcome: "execution_failed", resultKind: "runtime_error",
        error: { code: "execution_failed", message: "m", details: { exitCode: 1, stderr } } }), visit("failed", 1, { outcome: "failed", resultKind: "business" })];
    const failed = await chatTestReport({ store: reportStore(failedNodes, []) }, bench, run({ terminalOutcome: "failed", terminalNodeId: "failed" }));
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.firstError, { step: "poll", words: "the script stopped with an error: Unknown model: gpt-imaginary" });
    assert.match(failed.message, /failed: it ended completed \(failed\) after poll failed: the script stopped with an error: Unknown model: gpt-imaginary\.$/);

    const waitingNodes = [visit("poll", 1, { state: "pending" })];
    const waiting = [{ interceptionId: "i-9", nodeExecutionId: "nx-poll-1", operation: "tool.call", tool: "read_build", arguments: { buildId: 7 },
        state: "awaiting_parent", response: null }];
    const cancelled = await chatTestReport({ store: reportStore(waitingNodes, waiting) }, bench, run({ status: "cancelled", terminalOutcome: null, terminalNodeId: null,
        terminalError: { code: "cancelled", message: "TEST_UNANSWERED: no prepared answer for the tool call read_build in step poll." } }));
    assert.equal(cancelled.status, "failed");
    const toolShape = 'A tool call\'s answer is { kind: "success", value: <what the tool returns> }. A failure is { kind: "error", value: '
        + '{ code: "execution_failed", message: "..." } } (code: a runtime error code).';
    assert.deepEqual(cancelled.unanswered, { call: "tool call read_build in step poll", arguments: '{"buildId":7}', expected: toolShape });
    assert.equal(cancelled.message, "The test of hn-top-watch revision 3 failed: no prepared answer for the tool call read_build in step poll. "
        + `Add a fixture for it (or fix the definition) and test again. ${toolShape}`);
    assert.deepEqual(cancelled.firstError, { step: "poll", words: `no prepared answer for the tool call read_build in step poll. ${toolShape}` });

    const running = await chatTestReport({ store: reportStore(waitingNodes, []) }, bench, run({ status: "running", terminalOutcome: null, finishedAt: null }));
    assert.equal(running.status, "running");
    assert.match(running.message, /Read it again with workflow_definition operation test and test_id bench-1; do not start another test meanwhile\.$/);
    // A completed run whose outcome is not succeeded is a failed test.
    assert.equal((await chatTestReport({ store: reportStore([], []) }, bench, run({ terminalOutcome: "blocked" }))).status, "failed");
});

// Agent Smith 1.4.2 smoke (F-SM2): a prepared answer of the wrong shape was refused silently, and the test then said
// "no prepared answer" (TEST_UNANSWERED). Now the test fails at once with TEST_ANSWER_REFUSED: why, and the shape it needs.
const AGENT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: triage, version: "1.0.0" }
initial: classify
states:
  classify:
    type: agent
    invoke: { prompt: "Classify it." }
    timeoutSeconds: 600
    transition: { next: { done: finished, failure: failed } }
  finished: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

test("F-SM2: a prepared answer of the wrong shape fails the test at once, saying why and the shape it needs", async () => {
    const compiled = compileWorkflowV2(AGENT_YAML, { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    let current = run({ workflowSessionId: "bench-1", mode: "test", status: "running", revision: 3, irSha256: compiled.irSha256, terminalOutcome: null,
        terminalNodeId: null, finishedAt: null });
    const node = visit("classify", 1, { nodeExecutionId: "nx-1", state: "pending" });
    const held = { interceptionId: "i-1", nodeExecutionId: "nx-1", operation: "agent", tool: null, arguments: null, state: "awaiting_parent", response: null };
    const reasons = [];
    const store = {
        listRuns: async () => [current],
        readTestFixtures: async () => JSON.parse(JSON.stringify(parseTestFixtures([
            { operation: "agent", state: "classify", response: { kind: "success", value: { outcome: "finished", output: null } } }]))),
        readRun: async () => current,
        listOpenInterceptions: async () => ({ rows: current.status === "running" ? [held] : [] }),
        readNodeExecution: async () => node,
        readRevisionIr: async () => compiled.ir,
        recordRunCancelRequest: async input => {
            reasons.push(input.reason);
            current = { ...current, status: "cancelled", finishedAt: new Date(), terminalError: { code: "cancelled", message: input.reason } };
            throw new Error("the cancel is the store's; stop here");
        },
        listNodeExecutions: async () => [node],
        listInterceptions: async () => [held],
    };
    // The grace is long: the refusal, not the grace, ends the test.
    const report = await waitChatWorkflowTest({ store, catalog: {}, duroxideClient: {}, requests: true }, bench,
        { actor: { kind: "agent", sessionId: "chat" }, pollMs: 1, graceMs: 600_000, waitMs: 60_000, sleep: async () => {} });
    const reason = "the prepared answer for the agent step classify was refused: Outcome 'finished' is not one of the state's outcomes. "
        + "An agent step's answer is { kind: \"success\", value: { outcome: \"done\", output: <its output, as its outputSchema says> } }. "
        + "A failure is { kind: \"error\", value: { code: \"execution_failed\", message: \"...\" } } (code: a runtime error code).";
    assert.deepEqual(reasons, [`TEST_ANSWER_REFUSED: ${reason}`]);
    assert.equal(report.status, "failed");
    assert.deepEqual(report.refused, { call: "agent step classify", reason });
    assert.equal(report.unanswered, null, "it had an answer: not 'no prepared answer'");
    assert.equal(report.message, `The test of hn-top-watch revision 3 failed: ${reason} Fix that fixture and test again.`);
});

test("F-SM2: the shape each kind of call's answer needs, with what a failure looks like", () => {
    const failure = ' A failure is { kind: "error", value: { code: "execution_failed", message: "..." } } (code: a runtime error code).';
    assert.equal(testAnswerShapeWords("request"), 'A request step\'s answer is { kind: "success", value: { response: <the answer, as its contract\'s '
        + 'response schema says> } }, or { kind: "success", value: { decline: { reason: "..." } } } to decline it.' + failure);
    assert.equal(testAnswerShapeWords("send"), 'A send step\'s answer is { kind: "success", value: <any value> }.' + failure);
    assert.equal(testAnswerShapeWords("tool.call"), 'A tool call\'s answer is { kind: "success", value: <what the tool returns> }.' + failure);
    assert.match(testAnswerShapeWords("agent"), /outcome: <one of its outcomes>/);
    assert.match(testAnswerShapeWords("agent", ["done", "skipped"]), /outcome: "done" \| "skipped"/);
});

// Coordinator 22:05Z (smoke F-SM2 follow-up): a request step, its prepared answer mis-shaped and right, and none at all. A
// refused answer and a missing one each end the test at once, saying the shape a request's answer needs; the step's first
// error is the cancel's reason; a right answer is left to the run.
const REQUEST_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: security, version: "1.0.0" }
initial: security_review
schemas:
  Ask: { type: object, required: [q], properties: { q: { type: string } }, additionalProperties: false }
  Answer: { type: object, required: [approved], properties: { approved: { type: boolean } }, additionalProperties: false }
contracts:
  Review@1:
    schema: { $ref: "#/schemas/Ask" }
    response: { schema: { $ref: "#/schemas/Answer" } }
states:
  security_review:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Review@1
    input: { q: "approve?" }
    timeoutSeconds: 600
    transition: { next: { responded: finished, declined: finished, timed_out: finished, failure: finished } }
  finished: { type: terminal, outcome: succeeded }
`;

/** One wait of a test whose run holds one request (security_review) open, with these fixtures; what it cancelled with, and its report. */
async function requestTest(fixtures) {
    const compiled = compileWorkflowV2(REQUEST_YAML, { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true });
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    let current = run({ workflowSessionId: "bench-1", mode: "test", status: "running", revision: 3, irSha256: compiled.irSha256, terminalOutcome: null,
        terminalNodeId: null, finishedAt: null });
    const node = visit("security_review", 1, { nodeExecutionId: "nx-1", state: "pending" });
    const held = { interceptionId: "i-1", nodeExecutionId: "nx-1", operation: "request", tool: null, arguments: { q: "approve?" }, state: "awaiting_parent", response: null };
    const reasons = [];
    const store = {
        listRuns: async () => [current],
        readTestFixtures: async () => JSON.parse(JSON.stringify(parseTestFixtures(fixtures))),
        readRun: async () => current,
        listOpenInterceptions: async () => ({ rows: current.status === "running" ? [held] : [] }),
        readNodeExecution: async () => node,
        readRevisionIr: async () => compiled.ir,
        listOpenNodeExecutions: async () => ({ rows: [] }),
        recordRunCancelRequest: async input => {
            reasons.push(input.reason);
            current = { ...current, status: "cancelled", finishedAt: new Date(), terminalError: { code: "cancelled", message: input.reason } };
            throw new Error("the cancel is the store's; stop here");
        },
        listNodeExecutions: async () => [node],
        listInterceptions: async () => [held],
    };
    const report = await waitChatWorkflowTest({ store, catalog: {}, duroxideClient: {}, requests: true }, bench,
        { actor: { kind: "agent", sessionId: "chat" }, pollMs: 1, graceMs: 600_000, waitMs: 200, sleep: async () => {} });
    return { reasons, report };
}

const REQUEST_SHAPE = 'A request step\'s answer is { kind: "success", value: { response: <the answer, as its contract\'s response schema says> } }, '
    + 'or { kind: "success", value: { decline: { reason: "..." } } } to decline it. A failure is { kind: "error", value: { code: "execution_failed", '
    + 'message: "..." } } (code: a runtime error code).';

test("a request step: an answer shaped as an agent's, or a bare response, is refused at once with the shape a request needs", async () => {
    for (const value of [{ outcome: "responded", output: { approved: true } }, { approved: true }]) {
        const { reasons, report } = await requestTest([{ operation: "request", state: "security_review", response: { kind: "success", value } }]);
        assert.equal(reasons.length, 1, JSON.stringify(value));
        assert.match(reasons[0], /^TEST_ANSWER_REFUSED: the prepared answer for the request step security_review was refused: A request's success response is \{ response \} or \{ decline: \{ reason \} \}\. /);
        assert.ok(reasons[0].endsWith(REQUEST_SHAPE), reasons[0]);
        assert.equal(report.status, "failed");
        assert.equal(report.unanswered, null);
        assert.equal(report.refused.call, "request step security_review");
        assert.deepEqual(report.firstError, { step: "security_review", words: report.refused.reason });
        assert.match(report.message, /^The test of hn-top-watch revision 3 failed: the prepared answer for the request step security_review was refused: .+ Fix that fixture and test again\.$/);
    }
});

test("a request step: { response } and { decline: { reason } } are not refused (the run takes them); with no fixture the test fails naming the shape", async () => {
    for (const value of [{ response: { approved: true } }, { decline: { reason: "not now" } }]) {
        const { reasons, report } = await requestTest([{ operation: "request", state: "security_review", response: { kind: "success", value } }]);
        assert.deepEqual(reasons, [], JSON.stringify(value));
        assert.equal(report.status, "running");
    }
    const { reasons, report } = await requestTest([]);
    assert.deepEqual(reasons, [`TEST_UNANSWERED: no prepared answer for the request step security_review. ${REQUEST_SHAPE}`]);
    assert.equal(report.status, "failed");
    assert.equal(report.unanswered.expected, REQUEST_SHAPE);
    assert.deepEqual(report.firstError, { step: "security_review", words: `no prepared answer for the request step security_review. ${REQUEST_SHAPE}` });
    assert.equal(report.message, "The test of hn-top-watch revision 3 failed: no prepared answer for the request step security_review. "
        + `Add a fixture for it (or fix the definition) and test again. ${REQUEST_SHAPE}`);
});

test("the test operation's answer shapes and a two-fixture example are in the workflow-tools skill its declaration names", async () => {
    const { workflowDefinitionToolSpec } = await import("../../dist/workflow/v2/definition-tool.js");
    const fs = await import("node:fs");
    const spec = workflowDefinitionToolSpec();
    assert.match(spec.parameters.properties.fixtures.description, /load_skill workflow-tools/);
    const tools = fs.readFileSync(new URL("../../plugins/workflow-v2/skills/workflow-tools/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.ok(tools.includes("a tool call's result; an agent step's `{ outcome, output }`; a request step's `{ response }` or `{ decline: { reason } }`; a send step's any value."));
    assert.ok(tools.includes('- { operation: agent, state: classify, response: { kind: success, value: { outcome: bug, output: { label: "bug" } } } }'));
    assert.ok(tools.includes("- { operation: request, state: approve, response: { kind: success, value: { response: { approved: true } } } }"));
    assert.ok(tools.includes("An answer of the wrong shape fails the test, which says the shape it needs."));
});

