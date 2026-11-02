/**
 * Workflow v2 test runs (design 05 tool-mocked testing; R19, R20, R28;
 * migration 0098), INACTIVE: only controller 1.9.0 runs them, and only a
 * host that starts 1.9.0 runs (the test-only option workflowRequests and a
 * host with `requests`) takes update_workflow operations test,
 * test_respond and test_advance.
 *
 * - Responses and fixtures (pure): their shapes, exact matching by
 *   operation, tool or state and arguments hash, and the state results an
 *   answer gives, checked as the live effect's would be.
 * - The store: a test run's virtual clock refuses a live run.
 * - Controller 1.9.0 on a native duroxide runtime: a test run of a draft
 *   revision runs its script normally; its tool calls are intercepted
 *   (a fixture answers one; the parent answers another by its id, once:
 *   repeats are idempotent, a different answer is a conflict, an invalid
 *   one is refused); a tool outside the grant is still refused; the live
 *   tool executor never opens; its wait runs on the virtual clock (no real
 *   sleeping), and an advance decides what became due in deadline order. A
 *   mocked agent state, a request and a send are intercepted and answered
 *   (no child, no delivery, no request exchange), a receive takes typed
 *   input, and read_workflow shows the notice, the virtual clock, every
 *   interception and the coverage. Fixtures answer an agent state; an
 *   advance times a request out; a cancel leaves open interceptions
 *   unanswered; agent mode real is refused; a draft edit makes the tested
 *   revision stale and the live run is never touched.
 *
 * Scripts run as real script processes (their direct effects are real, as
 * in any test run). No model runs. Not an activation proof.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, sendWorkflowInputFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    matchTestFixture, parseTestFixtures, parseTestResponse, testResultFor, WORKFLOW_V2_TEST_NOTICE,
} from "../../src/workflow/v2/test-mode.ts";
import {
    registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId, workflowTestControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor, WORKFLOW_V2_TEST_EPOCH } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-test-mode-test" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** The code of the error `call` throws (null when it throws none). */
function thrownCode(call) {
    try { call(); } catch (error) { return error?.code ?? `no code: ${String(error?.message ?? error)}`; }
    return null;
}

/** A definition as a document (JSON is YAML). */
const yamlOf = doc => JSON.stringify(doc, null, 2);
const head = name => ({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name, version: "1.0.0" } });

/** A script that calls a tool outside its grant, then read_build twice, then a one-hour wait. */
function toolsDoc() {
    return {
        ...head("tested"),
        initial: "fetch",
        states: {
            fetch: {
                type: "script",
                source: "let refused = null;\n"
                    + "try { await callTool(\"deploy\", { target: \"prod\" }); } catch (error) { refused = String((error && error.message) || error); }\n"
                    + "const first = await callTool(\"read_build\", { buildId: 101 });\n"
                    + "const second = await callTool(\"read_build\", { buildId: 102 });\n"
                    + "await setResult(\"ok\", { first, second, refused, mode: context.mode });\n",
                transition: { next: { ok: "hold", failure: "failed" } },
            },
            hold: { type: "wait", seconds: 3600, transition: { next: { elapsed: "done" } } },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    };
}

/** A mocked agent state, then a request to the parent, a send to the parent and a receive racing a five-minute wait. */
function mockedDoc() {
    return {
        ...head("mocked"),
        initialInput: { head: "abc" },
        initial: "review",
        schemas: {
            ReviewInput: { type: "object", required: ["head"], properties: { head: { type: "string" } } },
            Review: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } }, additionalProperties: false },
            Question: { type: "object", required: ["q"], properties: { q: { type: "string" } }, additionalProperties: false },
            Answer: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } }, additionalProperties: false },
            Note: { type: "object", required: ["note"], properties: { note: { type: "string" } } },
            Build: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
        },
        contracts: {
            "Approval@1": { schema: { $ref: "#/schemas/Question" }, response: { schema: { $ref: "#/schemas/Answer" } } },
            "Note@1": { schema: { $ref: "#/schemas/Note" } },
            "BuildEvent@1": { schema: { $ref: "#/schemas/Build" } },
        },
        states: {
            review: {
                type: "agent", invoke: { prompt: "Review the change at the given head." },
                inputSchema: { $ref: "#/schemas/ReviewInput" }, outputSchema: { $ref: "#/schemas/Review" }, timeoutSeconds: 600,
                transition: { next: { accepted: "ask", changes_required: "rework", timed_out: "late", failure: "failed" } },
            },
            ask: {
                type: "messaging", mode: "request", recipient: { parent: true }, contract: "Approval@1", input: { q: "ship?" }, timeoutSeconds: 900,
                transition: { next: { responded: "tell", declined: "blocked", timed_out: "late", failure: "failed" } },
            },
            tell: {
                type: "messaging", mode: "send", recipient: { parent: true }, contract: "Note@1", input: { note: "shipping" },
                transition: { next: { sent: "await_build", failure: "failed" } },
            },
            await_build: {
                type: "messaging", mode: "receive", contract: "BuildEvent@1", wait: { seconds: 300 },
                transition: { next: { received: "done", elapsed: "late" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            rework: { type: "terminal", outcome: "blocked", output: "${input}" },
            blocked: { type: "terminal", outcome: "blocked", output: "${input}" },
            late: { type: "terminal", outcome: "blocked", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    };
}

const PARALLEL_HOST = { enableRequests: true, enableAgents: true, enableParallel: true };

describe("workflow v2 test runs: responses and fixtures", () => {
    it("parses responses and fixtures strictly, matches fixtures exactly, and checks each answer as the live effect's result", () => {
        expect(parseTestResponse({ kind: "success", value: { a: 1 } })).toEqual({ kind: "success", value: { a: 1 } });
        expect(parseTestResponse({ kind: "success" })).toEqual({ kind: "success", value: null });
        expect(parseTestResponse({ kind: "cancel" })).toEqual({ kind: "cancel", value: null });
        expect(parseTestResponse({ kind: "error", value: { code: "unavailable", message: "down" } })).toEqual({ kind: "error", value: { code: "unavailable", message: "down" } });
        for (const bad of [null, [], { kind: "maybe" }, { kind: "cancel", value: 1 }, { kind: "error", value: { code: "x" } },
            { kind: "error", value: { message: "m", extra: 1 } }, { kind: "success", value: 1, other: true }]) {
            expect(thrownCode(() => parseTestResponse(bad)), JSON.stringify(bad)).toBe("TEST_RESPONSE_INVALID");
        }

        const fixtures = parseTestFixtures([
            { tool: "read_build", arguments: { buildId: 101 }, response: { kind: "success", value: { state: "running" } } },
            { operation: "agent", state: "review", arguments: { head: "abc" }, response: { kind: "success", value: { outcome: "accepted", output: { verdict: "ok" } } } },
        ]);
        expect(fixtures.map(fixture => [fixture.operation, fixture.tool, fixture.state])).toEqual([["tool.call", "read_build", null], ["agent", null, "review"]]);
        const argumentsSha256 = sha256Hex(canonicalJson({ buildId: 101 }));
        expect(matchTestFixture(fixtures, { operation: "tool.call", tool: "read_build", state: null, argumentsSha256 })).toBe(fixtures[0]);
        // Never by a tool name alone: other arguments, another tool or another operation match nothing.
        expect(matchTestFixture(fixtures, { operation: "tool.call", tool: "read_build", state: null, argumentsSha256: sha256Hex(canonicalJson({ buildId: 102 })) })).toBeNull();
        expect(matchTestFixture(fixtures, { operation: "tool.call", tool: "read_logs", state: null, argumentsSha256 })).toBeNull();
        expect(matchTestFixture(fixtures, { operation: "agent", tool: null, state: "review", argumentsSha256: sha256Hex(canonicalJson({ head: "abc" })) })).toBe(fixtures[1]);
        expect(parseTestFixtures(undefined)).toEqual([]);
        for (const bad of [{}, [{ arguments: {}, response: { kind: "success" } }], [{ tool: "t", response: { kind: "success" } }],
            [{ operation: "agent", tool: "t", arguments: {}, response: { kind: "success" } }], [{ tool: "t", arguments: {}, response: { kind: "nope" } }],
            [{ operation: "wait", state: "s", arguments: {}, response: { kind: "success" } }]]) {
            expect(thrownCode(() => parseTestFixtures(bad)), JSON.stringify(bad)).toBe("WORKFLOW_COMMAND_INVALID");
        }

        const compiled = compileWorkflowV2(yamlOf(mockedDoc()), PARALLEL_HOST);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        const { ir, irSha256 } = compiled;
        const at = (operation, args = {}) => ({ operation, interceptionId: `nx-1/${operation}`, arguments: args });
        // An agent: one of its outcomes, with an output that matches its schema; an error needs a runtime error code.
        expect(testResultFor(at("agent"), ir.nodes.review, ir, irSha256, { kind: "success", value: { outcome: "accepted", output: { verdict: "ok" } } }))
            .toEqual({ outcome: "accepted", resultKind: "business", valueText: canonicalJson({ verdict: "ok" }), winner: "test" });
        for (const value of [{ outcome: "maybe", output: { verdict: "ok" } }, { outcome: "accepted", output: { verdict: 5 } }, { outcome: "accepted", extra: 1 }]) {
            expect(thrownCode(() => testResultFor(at("agent"), ir.nodes.review, ir, irSha256, { kind: "success", value })), JSON.stringify(value))
                .toBe("TEST_RESPONSE_INVALID");
        }
        expect(testResultFor(at("agent"), ir.nodes.review, ir, irSha256, { kind: "error", value: { code: "needs_input", message: "Which base?" } }))
            .toMatchObject({ outcome: "needs_input", resultKind: "runtime_error", winner: "test" });
        expect(thrownCode(() => testResultFor(at("agent"), ir.nodes.review, ir, irSha256, { kind: "error", value: { code: "oops", message: "m" } })))
            .toBe("TEST_RESPONSE_INVALID");
        expect(testResultFor(at("agent"), ir.nodes.review, ir, irSha256, { kind: "cancel", value: null })).toMatchObject({ outcome: "cancelled", winner: "test" });
        // A request: a response that matches the contract's response schema, or a decline with a reason.
        expect(testResultFor(at("request"), ir.nodes.ask, ir, irSha256, { kind: "success", value: { response: { approved: true } } }))
            .toEqual({ outcome: "responded", resultKind: "business", valueText: canonicalJson({ approved: true }), winner: "test" });
        expect(testResultFor(at("request"), ir.nodes.ask, ir, irSha256, { kind: "success", value: { decline: { reason: "not now" } } }))
            .toMatchObject({ outcome: "declined", resultKind: "business" });
        for (const value of [{ response: { approved: "yes" } }, { decline: { why: "x" } }, { response: { approved: true }, decline: { reason: "r" } }, { approved: true }]) {
            expect(thrownCode(() => testResultFor(at("request"), ir.nodes.ask, ir, irSha256, { kind: "success", value })), JSON.stringify(value))
                .toBe("TEST_RESPONSE_INVALID");
        }
        // A send: sent, with what was sent and the mock's value. A tool call has no state result.
        expect(testResultFor(at("send", { recipient: "p", contract: "Note@1" }), ir.nodes.tell, ir, irSha256, { kind: "success", value: null }))
            .toMatchObject({ outcome: "sent", resultKind: "business", winner: "test" });
        expect(testResultFor(at("tool.call"), ir.nodes.review, ir, irSha256, { kind: "success", value: 1 })).toBeNull();
    });
});

describe("workflow v2 test runs: the store", () => {
    it("advances only a test run's virtual clock", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const parent = randomUUID();
            await h.catalog.createSession(parent, {});
            const yaml = yamlOf(toolsDoc());
            const compiled = compileWorkflowV2(yaml, PARALLEL_HOST);
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflowV2: { requestSha256: "test-mode" } } })).toEqual({ created: true });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "test-mode", publish: true, title: "Workflow: tested",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
            });
            expect(await h.store.readRun(runId)).toMatchObject({ mode: "live", virtualNow: null });
            await expect(h.store.advanceTestClock({ workflowSessionId, runId, seconds: 60, operationId: "adv-1", requestSha256: "a",
                projection: () => ({ sessionId: workflowSessionId }) })).rejects.toMatchObject({ code: "RUN_NOT_TEST" });
            await expect(h.store.advanceTestClock({ workflowSessionId, runId, seconds: 0, operationId: "adv-2", requestSha256: "a",
                projection: () => ({ sessionId: workflowSessionId }) })).rejects.toMatchObject({ code: "WORKFLOW_COMMAND_INVALID" });
            // A live run cannot carry a virtual clock or fixtures, even by direct SQL.
            await expect(h.q(`UPDATE SCHEMA.workflow_runs SET virtual_now = now() WHERE run_id = $1`, [runId])).rejects.toThrow(/workflow_runs_test_clock/);
        } finally {
            await h.stop();
        }
    });
});

// ─── Controller 1.9.0 on a native runtime ────────────────────

/**
 * A worker-equivalent registration with workflowRequests and the request tag
 * declared. Scripts are granted read_build only; the live tool executor
 * must never open; parent notices are authorized and recorded. No agent
 * host: a mocked agent state never needs one.
 */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    const notices = [];
    const opened = [];
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => ({ tools: [{ name: "read_build", schemaHash: "h" }], excludedTools: [] }),
        openToolExecutor: async sessionId => { opened.push(sessionId); throw new Error("A test run never opens the live tool executor."); },
        authorizeParentNotification: async () => true,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notices.push({ parentSessionId, text, clientMessageId }); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        testPollMs: 50,
        workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, notices, opened, host: { catalog, store, duroxideClient: client, requests: true },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session, a draft workflow of `doc` it created, and its tool calls on it. */
async function draftOf(h, doc) {
    const parentId = randomUUID();
    await h.catalog.createSession(parentId, {});
    const workflowId = randomUUID();
    const created = await createWorkflowV2(h.host, { workflowSessionId: workflowId, parentSessionId: parentId, yaml: yamlOf(doc), actor: ACTOR, operationId: "create" });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const context = { callerSessionId: parentId, host: h.host };
    const update = async args => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context));
    return {
        parentId, workflowId, definitionHash: created.receipt.yamlSha256, update,
        read: async (args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        input: async args => JSON.parse(await sendWorkflowInputFromTool({ workflow_id: workflowId, ...args }, context)),
        async test(operationId, args = {}) {
            const started = await update({ operation: "test", operation_id: operationId, expected_revision: 1, definition_hash: created.receipt.yamlSha256,
                inputs: {}, ...args });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "test" } });
            return started.run.runId;
        },
        respond: (runId, interceptionId, response, operationId) =>
            update({ operation: "test_respond", operation_id: operationId, run_id: runId, interception_id: interceptionId, response }),
        advance: (runId, seconds, operationId) => update({ operation: "test_advance", operation_id: operationId, run_id: runId, seconds }),
    };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

const awaiting = (h, interceptionId) => until(async () => {
    const record = await h.store.readInterception(interceptionId);
    return record?.state === "awaiting_parent" ? record : null;
}, `interception ${interceptionId}`);

const pendingNode = (h, nodeExecutionId) => until(async () => {
    const node = await h.store.readNodeExecution(nodeExecutionId);
    return node?.state === "pending" ? node : null;
}, `node ${nodeExecutionId} to wait`);

describe("workflow v2 test runs: controller 1.9.0 (inactive, test-only registration)", () => {
    it("runs a draft's script normally with its tool calls intercepted, and its wait on the virtual clock", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, toolsDoc());
            const started = await draft.update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: draft.definitionHash,
                inputs: {}, fixtures: [{ tool: "read_build", arguments: { buildId: 101 }, response: { kind: "success", value: { state: "running" } } }] });
            expect(started).toMatchObject({ ok: true, operation: "test", replayed: false, state: "draft", revision: 1,
                run: { mode: "test", revision: 1 }, test: { agentMode: "mocked", notice: WORKFLOW_V2_TEST_NOTICE } });
            const runId = started.run.runId;
            expect(await draft.update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {},
                fixtures: [{ tool: "read_build", arguments: { buildId: 101 }, response: { kind: "success", value: { state: "running" } } }] }))
                .toMatchObject({ ok: true, replayed: true, run: { runId } });
            expect(await h.store.readRun(runId)).toMatchObject({ mode: "test", testAgentMode: "mocked", controllerInstanceId: workflowTestControllerInstanceId(runId),
                controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, virtualNow: new Date(WORKFLOW_V2_TEST_EPOCH) });

            // The fixture answered the first call; the second waits for the parent, who is told.
            const fetch = nodeExecutionIdFor(runId, "root", "fetch", 1);
            const second = await awaiting(h, `${fetch}/call-2`);
            expect(second).toMatchObject({ operation: "tool.call", tool: "read_build", arguments: { buildId: 102 }, response: null,
                virtualAt: new Date(WORKFLOW_V2_TEST_EPOCH) });
            expect(await h.store.readInterception(`${fetch}/call-1`)).toMatchObject({
                state: "responded", response: { kind: "success", value: { state: "running" }, disposition: "fixture" },
            });
            await until(async () => (h.notices.length > 0 ? h.notices : null), "the parent's notice");
            expect(h.notices.map(notice => [notice.parentSessionId, notice.clientMessageId])).toEqual([[draft.parentId, `workflow-test:${fetch}/call-2`]]);
            expect(h.notices[0].text).toContain("untrusted workflow data");

            // An invalid answer is refused and the call stays open; the parent's answer is taken once.
            expect(await draft.respond(runId, second.interceptionId, { kind: "maybe" }, "r-0")).toMatchObject({ ok: false, error: { code: "TEST_RESPONSE_INVALID" } });
            const answer = { kind: "success", value: { state: "passed" } };
            expect(await draft.respond(runId, second.interceptionId, answer, "r-1"))
                .toMatchObject({ ok: true, replayed: false, interception: { operation: "tool.call", state: "responded" } });
            const hold = nodeExecutionIdFor(runId, "root", "hold", 1);
            const waiting = await pendingNode(h, hold);
            expect(await draft.respond(runId, second.interceptionId, answer, "r-2")).toMatchObject({ ok: true, replayed: true });
            expect(await draft.respond(runId, second.interceptionId, { kind: "success", value: { state: "failed" } }, "r-3"))
                .toMatchObject({ ok: false, error: { code: "TEST_RESPONSE_CONFLICT" } });

            // The one-hour wait is on the virtual clock: real time decides nothing, and an advance decides it once due.
            expect(waiting.deadlineAt.toISOString()).toBe("9000-01-01T01:00:00.000Z");
            await pause(1_000);
            expect((await h.store.readNodeExecution(hold)).state).toBe("pending");
            expect(await draft.advance(runId, 3_599, "adv-1")).toMatchObject({ ok: true, replayed: false, from: "9000-01-01T00:00:00.000000Z",
                virtualNow: "9000-01-01T00:59:59.000000Z", decided: [] });
            expect((await h.store.readNodeExecution(hold)).state).toBe("pending");
            const due = await draft.advance(runId, 1, "adv-2");
            expect(due).toMatchObject({ ok: true, virtualNow: "9000-01-01T01:00:00.000000Z", decided: [{ nodeExecutionId: hold, stateId: "hold", outcome: "elapsed" }] });
            expect(await draft.advance(runId, 1, "adv-2")).toEqual({ ...due, replayed: true });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done", terminalOutput: {
                first: { state: "running" }, second: { state: "passed" }, mode: "test", refused: expect.stringMatching(/'deploy' is not uniquely admitted/),
            } });
            expect(h.opened).toEqual([]);
            expect(await draft.advance(runId, 1, "adv-3")).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });

            // read_workflow: the notice, the virtual clock, every interception and the coverage of the tested revision.
            const view = await draft.read({ run_id: runId });
            expect(view.run.test).toMatchObject({
                notice: WORKFLOW_V2_TEST_NOTICE, agentMode: "mocked", testedRevision: 1, stale: false,
                virtualClock: { now: "9000-01-01T01:00:00.000Z", elapsedSeconds: 3_600 },
                coverage: { complete: true, entered: ["done", "fetch", "hold"], notEntered: ["failed"], unanswered: [],
                    routes: [{ from: "fetch", route: "ok", to: "hold", count: 1 }, { from: "hold", route: "elapsed", to: "done", count: 1 }] },
            });
            expect(view.run.test.interceptions.map(item => [item.interceptionId, item.state, item.response?.disposition]))
                .toEqual([[`${fetch}/call-1`, "responded", "fixture"], [`${fetch}/call-2`, "responded", "parent"]]);
            // The draft was never published, and no live run exists.
            expect(view.definition.state).toBe("draft");
            expect(view.runs.map(item => item.mode)).toEqual(["test"]);
        } finally {
            await h.stop();
        }
    });

    it("intercepts a mocked agent, a request and a send, answers each as its live effect, and takes typed input on a receive", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, mockedDoc());
            const runId = await draft.test("test-1");
            const id = state => nodeExecutionIdFor(runId, "root", state, 1);

            // The agent state: no child is created (this worker has no agent host); the parent supplies its typed result.
            const agent = await awaiting(h, `${id("review")}/agent`);
            expect(agent).toMatchObject({ operation: "agent", responseSchema: "Review", arguments: {
                input: { head: "abc" }, outcomes: ["accepted", "changes_required"], outputSchema: "Review", timeoutSeconds: 600,
                task: { source: "prompt", prompt: "Review the change at the given head." } } });
            expect((await h.store.readNodeExecution(id("review"))).deadlineAt.toISOString()).toBe("9000-01-01T00:10:00.000Z");
            expect(await draft.respond(runId, agent.interceptionId, { kind: "success", value: { outcome: "accepted", output: { verdict: 5 } } }, "a-0"))
                .toMatchObject({ ok: false, error: { code: "TEST_RESPONSE_INVALID" } });
            expect(await draft.respond(runId, agent.interceptionId, { kind: "success", value: { outcome: "maybe" } }, "a-1"))
                .toMatchObject({ ok: false, error: { code: "TEST_RESPONSE_INVALID" } });
            expect((await h.store.readInterception(agent.interceptionId)).state).toBe("awaiting_parent");
            expect(await draft.respond(runId, agent.interceptionId, { kind: "success", value: { outcome: "accepted", output: { verdict: "ok" } } }, "a-2"))
                .toMatchObject({ ok: true, node: { stateId: "review", state: "completed", outcome: "accepted" } });
            expect(await h.store.readAgentInvocation(id("review"))).toBeNull();

            // The request: its answer must match the contract's response schema.
            const ask = await awaiting(h, `${id("ask")}/request`);
            expect(ask).toMatchObject({ operation: "request", responseSchema: "Answer", arguments: { contract: "Approval@1", payload: { q: "ship?" },
                recipient: draft.parentId, timeoutSeconds: 900 } });
            expect(await draft.respond(runId, ask.interceptionId, { kind: "success", value: { response: { approved: "yes" } } }, "q-0"))
                .toMatchObject({ ok: false, error: { code: "TEST_RESPONSE_INVALID" } });
            expect(await draft.respond(runId, ask.interceptionId, { kind: "success", value: { response: { approved: true } } }, "q-1"))
                .toMatchObject({ ok: true, node: { outcome: "responded" } });

            // The send: not delivered; the parent's answer decides it sent.
            const tell = await awaiting(h, `${id("tell")}/send`);
            expect(tell).toMatchObject({ operation: "send", arguments: { contract: "Note@1", payload: { note: "shipping" }, recipient: draft.parentId } });
            expect(await draft.respond(runId, tell.interceptionId, { kind: "success" }, "s-1")).toMatchObject({ ok: true, node: { outcome: "sent" } });

            // The receive takes typed input given to the test run, before its virtual deadline.
            await pendingNode(h, id("await_build"));
            expect(await draft.input({ contract: "BuildEvent@1", payload: { status: "green" }, run_id: runId, operation_id: "in-1" }))
                .toMatchObject({ ok: true, claimedBy: { stateId: "await_build" } });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { status: "green" } });

            // Nothing was delivered or exchanged for real: no outbox message, no request record, no child.
            expect(await h.store.listOutbox(runId)).toEqual([]);
            expect(await h.store.listAgentInvocations(runId)).toEqual([]);
            const view = await draft.read({ run_id: runId });
            expect(view.run.test.interceptions.map(item => [item.operation, item.response?.disposition])).toEqual([["agent", "parent"], ["request", "parent"], ["send", "parent"]]);
            expect(view.run.test.coverage).toMatchObject({ entered: ["ask", "await_build", "done", "review", "tell"], notEntered: ["blocked", "failed", "late", "rework"] });
            const events = await h.catalog.getSessionEvents(draft.workflowId, 0, 500);
            expect(events.filter(event => event.eventType === "workflow.test_answered").map(event => event.data.operation)).toEqual(["agent", "request", "send"]);
        } finally {
            await h.stop();
        }
    });

    it("answers an agent state from a fixture, times a request out on an advance, and leaves a cancelled test's interceptions unanswered", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, mockedDoc());
            // A fixture for the agent state's exact input answers it at once; the parent is not asked.
            const fixed = await draft.test("test-1", { fixtures: [{ operation: "agent", state: "review", arguments: { head: "abc" },
                response: { kind: "success", value: { outcome: "changes_required", output: { verdict: "redo" } } } }] });
            expect(await ended(h, fixed)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "rework", terminalOutput: { verdict: "redo" } });
            expect(await h.store.readInterception(`${nodeExecutionIdFor(fixed, "root", "review", 1)}/agent`))
                .toMatchObject({ state: "responded", response: { disposition: "fixture" } });
            expect(h.notices).toEqual([]);

            // A request that gets no answer times out when the virtual clock reaches its deadline; a late answer is refused.
            const late = await draft.test("test-2");
            const review = `${nodeExecutionIdFor(late, "root", "review", 1)}/agent`;
            await awaiting(h, review);
            expect(await draft.respond(late, review, { kind: "success", value: { outcome: "accepted", output: { verdict: "ok" } } }, "a-1")).toMatchObject({ ok: true });
            const ask = await awaiting(h, `${nodeExecutionIdFor(late, "root", "ask", 1)}/request`);
            expect(await draft.advance(late, 899, "adv-1")).toMatchObject({ ok: true, decided: [] });
            expect(await draft.advance(late, 1, "adv-2")).toMatchObject({ ok: true, virtualNow: "9000-01-01T00:15:00.000000Z",
                decided: [{ stateId: "ask", outcome: "timed_out" }] });
            expect(await ended(h, late)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "late",
                terminalOutput: { code: "timed_out" } });
            expect(await draft.respond(late, ask.interceptionId, { kind: "success", value: { response: { approved: true } } }, "q-1"))
                .toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });

            // A cancel ends a test run with an open interception; it stays unanswered, and no answer is taken after the end.
            const cancelled = await draft.test("test-3");
            const open = await awaiting(h, `${nodeExecutionIdFor(cancelled, "root", "review", 1)}/agent`);
            expect(await draft.update({ operation: "cancel", operation_id: "cancel-1", run_id: cancelled, reason: "enough" })).toMatchObject({ ok: true });
            expect(await ended(h, cancelled)).toMatchObject({ status: "cancelled" });
            expect(await draft.respond(cancelled, open.interceptionId, { kind: "cancel" }, "x-1")).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            expect((await draft.read({ run_id: cancelled })).run.test.coverage.unanswered).toEqual([open.interceptionId]);

            // Agent mode real is not available; a test names the exact current revision; a draft edit makes earlier results stale.
            expect(await draft.update({ operation: "test", operation_id: "test-4", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {},
                agent_mode: "real" })).toMatchObject({ ok: false, error: { code: "TEST_AGENT_MODE_UNSUPPORTED" } });
            const edited = yamlOf({ ...mockedDoc(), description: "edited" });
            expect(await draft.update({ operation: "replace_definition", operation_id: "edit-1", expected_revision: 1, yaml: edited }))
                .toMatchObject({ ok: true, revision: 2 });
            expect(await draft.update({ operation: "test", operation_id: "test-5", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {} }))
                .toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
            expect((await draft.read({ run_id: fixed })).run.test).toMatchObject({ testedRevision: 1, stale: true });
            expect((await draft.read()).runs.every(item => item.mode === "test")).toBe(true);
        } finally {
            await h.stop();
        }
    });
});
