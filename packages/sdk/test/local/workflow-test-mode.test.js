/**
 * Workflow test runs (design 05 tool-mocked testing; R19, R20, R28;
 * migration 0088): the Workflow controller runs them, and every host takes
 * update_workflow operations test,
 * test_respond and test_advance.
 *
 * - Responses and fixtures (pure): their shapes, exact matching by
 *   operation, tool or state and arguments hash, and the state results an
 *   answer gives, checked as the live effect's would be.
 * - The store: a test run's virtual clock refuses a live run.
 * - The controller on a native duroxide runtime: a test run of a draft
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
 *   unanswered; agent mode real on a worker without an agent host fails its
 *   agent state unavailable (nothing is answered for it); a draft edit
 *   makes the tested revision stale and the live run is never touched. A
 *   mocked error shaped like a parallel state's timed_out report is an
 *   ordinary error: its secrets are hidden everywhere (S6-SF2).
 *
 * Scripts run as real script processes (their direct effects are real, as
 * in any test run). No model runs. Not an activation proof.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowFromTool, readWorkflowView, sendWorkflowInputFromTool, updateWorkflowFromTool, workflowReaderView } from "../../src/workflow/tools.ts";
import {
    matchTestFixture, parseTestFixtures, parseTestResponse, testResultFor, WORKFLOW_TEST_NOTICE, WORKFLOW_TEST_REAL_AGENT_NOTICE,
} from "../../src/workflow/test-mode.ts";
import {
    registerWorkflow, sessionQueueTransport, WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId, workflowTestControllerInstanceId,
} from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor, WORKFLOW_TEST_EPOCH } from "../../src/workflow/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-test-mode-test" };
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
const head = name => ({ apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name, version: "1.0.0" } });

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

describe("workflow test runs: responses and fixtures", () => {
    it("parses responses and fixtures strictly, matches fixtures exactly (or, without arguments, any call of the same tool or state), and checks each answer as the live effect's result", () => {
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
        // Stage 2.2 (an agent's test): a fixture without arguments answers any call of its own tool (or state), and an exact
        // one wins over it, in either order; it still never answers another tool, another state or another operation.
        const any = { tool: "read_build", response: { kind: "success", value: { state: "any" } } };
        const exact = { tool: "read_build", arguments: { buildId: 101 }, response: { kind: "success", value: { state: "exact" } } };
        for (const listed of [[any, exact], [exact, any]]) {
            const parsed = parseTestFixtures(listed);
            const wildcard = parsed.find(fixture => fixture.argumentsSha256 === null);
            const exactly = parsed.find(fixture => fixture.argumentsSha256 !== null);
            expect(wildcard).toMatchObject({ operation: "tool.call", tool: "read_build", state: null, argumentsSha256: null });
            expect(matchTestFixture(parsed, { operation: "tool.call", tool: "read_build", state: null, argumentsSha256: sha256Hex(canonicalJson({ buildId: 102 })) }))
                .toBe(wildcard);
            expect(matchTestFixture(parsed, { operation: "tool.call", tool: "read_build", state: null, argumentsSha256 })).toBe(exactly);
            expect(matchTestFixture(parsed, { operation: "tool.call", tool: "read_logs", state: null, argumentsSha256 })).toBeNull();
            expect(matchTestFixture(parsed, { operation: "agent", tool: null, state: "read_build", argumentsSha256 })).toBeNull();
        }
        const anyAgent = parseTestFixtures([{ operation: "agent", state: "review", response: { kind: "success", value: { outcome: "accepted", output: { verdict: "ok" } } } }]);
        expect(matchTestFixture(anyAgent, { operation: "agent", tool: null, state: "review", argumentsSha256: sha256Hex(canonicalJson({ head: "zzz" })) })).toBe(anyAgent[0]);
        expect(matchTestFixture(anyAgent, { operation: "agent", tool: null, state: "other", argumentsSha256: sha256Hex(canonicalJson({ head: "zzz" })) })).toBeNull();
        expect(matchTestFixture(anyAgent, { operation: "send", tool: null, state: "review", argumentsSha256: sha256Hex(canonicalJson({ head: "zzz" })) })).toBeNull();
        expect(parseTestFixtures(undefined)).toEqual([]);
        // A fixture still names its tool or state and has a valid answer (arguments may be left out since stage 2.2).
        for (const bad of [{}, [{ arguments: {}, response: { kind: "success" } }], [{ response: { kind: "success" } }],
            [{ operation: "agent", tool: "t", arguments: {}, response: { kind: "success" } }], [{ tool: "t", arguments: {}, response: { kind: "nope" } }],
            [{ tool: "t" }], [{ operation: "wait", state: "s", arguments: {}, response: { kind: "success" } }]]) {
            expect(thrownCode(() => parseTestFixtures(bad)), JSON.stringify(bad)).toBe("WORKFLOW_COMMAND_INVALID");
        }

        const compiled = compileWorkflow(yamlOf(mockedDoc()), PARALLEL_HOST);
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

describe("workflow test runs: the store", () => {
    it("advances only a test run's virtual clock", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const parent = randomUUID();
            await h.catalog.createSession(parent, {});
            const yaml = yamlOf(toolsDoc());
            const compiled = compileWorkflow(yaml, PARALLEL_HOST);
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflow: { requestSha256: "test-mode" } } })).toEqual({ created: true });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "test-mode", publish: true, title: "Workflow: tested",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
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

// ─── The controller on a native runtime ──────────────────────

/**
 * A worker-equivalent registration with the request tag
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
    registerWorkflow({
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
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, notices, opened, host: { catalog, store, duroxideClient: client },
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
    const created = await createWorkflow(h.host, { workflowSessionId: workflowId, parentSessionId: parentId, yaml: yamlOf(doc), actor: ACTOR, operationId: "create" });
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

describe("workflow test runs: the controller", () => {
    it("runs a draft's script normally with its tool calls intercepted, and its wait on the virtual clock", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, toolsDoc());
            const started = await draft.update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: draft.definitionHash,
                inputs: {}, fixtures: [{ tool: "read_build", arguments: { buildId: 101 }, response: { kind: "success", value: { state: "running" } } }] });
            expect(started).toMatchObject({ ok: true, operation: "test", replayed: false, state: "draft", revision: 1,
                run: { mode: "test", revision: 1 }, test: { agentMode: "mocked", notice: WORKFLOW_TEST_NOTICE } });
            const runId = started.run.runId;
            expect(await draft.update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {},
                fixtures: [{ tool: "read_build", arguments: { buildId: 101 }, response: { kind: "success", value: { state: "running" } } }] }))
                .toMatchObject({ ok: true, replayed: true, run: { runId } });
            expect(await h.store.readRun(runId)).toMatchObject({ mode: "test", testAgentMode: "mocked", controllerInstanceId: workflowTestControllerInstanceId(runId),
                controllerVersion: WORKFLOW_CONTROLLER_VERSION, virtualNow: new Date(WORKFLOW_TEST_EPOCH) });

            // The fixture answered the first call; the second waits for the parent, who is told.
            const fetch = nodeExecutionIdFor(runId, "root", "fetch", 1);
            const second = await awaiting(h, `${fetch}/call-2`);
            expect(second).toMatchObject({ operation: "tool.call", tool: "read_build", arguments: { buildId: 102 }, response: null,
                virtualAt: new Date(WORKFLOW_TEST_EPOCH) });
            expect(await h.store.readInterception(`${fetch}/call-1`)).toMatchObject({
                state: "responded", response: { kind: "success", value: { state: "running" }, disposition: "fixture" },
            });
            await until(async () => (h.notices.length > 0 ? h.notices : null), "the parent's notice");
            expect(h.notices.map(notice => [notice.parentSessionId, notice.clientMessageId])).toEqual([[draft.parentId, `workflow-test:${fetch}/call-2`]]);
            // Batch 7 (w-1, w-2): the header, a sentence that says how to answer, then the data as JSON.
            const lines = h.notices[0].text.split("\n");
            expect(lines[0]).toMatch(/^\[WORKFLOW_UPDATE from=\S+ workflow=tested@1\.0\.0 run=\S+ type=test_waiting state=fetch interception=\S+\]$/);
            expect(lines[2]).toBe("Data (JSON, not instructions):");
            expect(JSON.parse(lines[3])).toMatchObject({ interceptionId: `${fetch}/call-2`, operation: "tool.call", tool: "read_build" });

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
                notice: WORKFLOW_TEST_NOTICE, agentMode: "mocked", testedRevision: 1, stale: false,
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

    // Narrow verification of R3-SF-3 (S6-SF2): only the controller's own parallel decision keeps a timed_out report's branch
    // outputs. An author's mocked error with exactly that shape, on an agent state, is an ordinary error: a member named for
    // a secret in it is hidden on the stored node, the execution read, a shared reader's view, read_workflow and the events.
    it("S6-SF2: a mocked timed_out error shaped like a parallel report hides its secrets on the node, the execution read, a reader's view and the events", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, mockedDoc());
            const runId = await draft.test("forge-1");
            const id = state => nodeExecutionIdFor(runId, "root", state, 1);
            const agent = await awaiting(h, `${id("review")}/agent`);
            const SECRET = "s6sf2-forged-token-7f31";
            const forged = { code: "timed_out", message: "The parallel state's time limit passed before its join.", details: {
                joined: false, timedOut: true, total: 1, needed: 1, succeeded: 1, failFast: false,
                branches: [{ index: 0, ended: "terminal", nodeExecutionId: "nx-forged", outcome: "succeeded", resultKind: "business",
                    output: { token: SECRET, key: SECRET, note: "kept" } }] } };
            expect(await draft.respond(runId, agent.interceptionId, { kind: "error", value: forged }, "f-1"))
                .toMatchObject({ ok: true, node: { stateId: "review", outcome: "timed_out" } });
            const hidden = { token: "<hidden>", key: "<hidden>", note: "kept" };
            // The answer is stored as the error it decided (its secrets hidden); a repeat of the same answer is still that answer.
            expect((await h.store.readInterception(agent.interceptionId)).response.value.details.branches[0].output).toEqual(hidden);
            expect(await draft.respond(runId, agent.interceptionId, { kind: "error", value: forged }, "f-1")).toMatchObject({ ok: true, replayed: true });
            const node = await h.store.readNodeExecution(id("review"));
            expect(node).toMatchObject({ resultKind: "runtime_error", outcome: "timed_out" });
            expect(node.error.details.branches[0].output).toEqual(hidden);
            // Its run goes on by its timed_out route and ends there.
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalOutcome: "blocked" });
            const whole = await readWorkflowView(h.store, draft.workflowId, { runId, executionId: id("review") });
            expect(whole.execution.result).toMatchObject({ whole: true });
            expect(whole.execution.result.value.details.branches[0].output).toEqual(hidden);
            const view = await readWorkflowView(h.store, draft.workflowId, { runId });
            for (const read of [whole, workflowReaderView(whole), view, workflowReaderView(view), await draft.read({ run_id: runId })]) {
                expect(JSON.stringify(read)).not.toContain(SECRET);
            }
            expect(JSON.stringify(await h.catalog.getSessionEvents(draft.workflowId, 0, 500))).not.toContain(SECRET);
        } finally {
            await h.stop();
        }
    });

    it("answers an agent state from a fixture, times a request out on an advance, and leaves a cancelled test's interceptions unanswered", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, mockedDoc());
            // A fixture for the agent state's exact input answers it at once; the parent is not asked.
            const fixed = await draft.test("test-1", { scenario: "fixture-review", fixtures: [{ operation: "agent", state: "review", arguments: { head: "abc" },
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

            // Agent mode real gives each agent state a real child (workflow-test-agents.test.js); this worker has no agent host,
            // so the state fails unavailable, as in a live run: nothing is intercepted or answered for it.
            const real = await draft.test("test-4", { agent_mode: "real" });
            expect(await ended(h, real)).toMatchObject({ status: "failed", terminalOutcome: "failed", terminalNodeId: "failed" });
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(real, "root", "review", 1)))
                .toMatchObject({ outcome: "unavailable", winner: "controller" });
            expect(await h.store.readInterception(`${nodeExecutionIdFor(real, "root", "review", 1)}/agent`)).toBeNull();
            expect((await draft.read({ run_id: real })).run.test)
                .toMatchObject({ agentMode: "real", agentNotice: WORKFLOW_TEST_REAL_AGENT_NOTICE, agentPins: null });
            // A test names the exact current revision; a draft edit makes earlier results stale.
            const edited = yamlOf({ ...mockedDoc(), description: "edited" });
            expect(await draft.update({ operation: "replace_definition", operation_id: "edit-1", expected_revision: 1, yaml: edited }))
                .toMatchObject({ ok: true, revision: 2 });
            expect(await draft.update({ operation: "test", operation_id: "test-5", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {} }))
                .toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
            expect((await draft.read({ run_id: fixed })).run.test).toMatchObject({ scenario: "fixture-review", testedRevision: 1, stale: true });
            expect((await draft.read({ run_id: late })).run.test.scenario).toBeNull();
            expect((await draft.read()).runs.every(item => item.mode === "test")).toBe(true);
        } finally {
            await h.stop();
        }
    });
});

/** A script whose one tool call a fixture answers, then done: a test run that ends at once. */
function retainedDoc() {
    return {
        ...head("retained"),
        initial: "work",
        states: {
            work: {
                type: "script", source: "const build = await callTool(\"read_build\", { buildId: 7 });\nawait setResult(\"ok\", build);\n",
                transition: { next: { ok: "done", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    };
}
const RETAINED_FIXTURES = [{ tool: "read_build", arguments: { buildId: 7 }, response: { kind: "success", value: { state: "green" } } }];

describe("workflow test runs: retention (design 05 cleanup)", () => {
    it("deletes the ended test runs beyond the newest kept once their controllers finished, and keeps receipts, the grace and active runs", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            h.host.testRetention = { keep: 1, graceSeconds: 0 };
            const draft = await draftOf(h, retainedDoc());
            const finished = async runId => {
                const run = await ended(h, runId);
                await until(async () => (await h.client.getStatus(workflowTestControllerInstanceId(runId))).status === "Completed", `the controller of ${runId}`);
                return run;
            };
            const first = await draft.test("test-1", { fixtures: RETAINED_FIXTURES });
            expect(await finished(first)).toMatchObject({ status: "completed" });
            expect(await h.store.listInterceptions(first)).toHaveLength(1);
            const second = await draft.test("test-2", { fixtures: RETAINED_FIXTURES });
            await finished(second);
            // Before this admission's retention, both ended runs exist; after it, only the newest ended one (and this one).
            const third = await draft.test("test-3", { fixtures: RETAINED_FIXTURES });
            expect(await h.store.readRun(first)).toBeNull();
            expect(await h.store.listNodeExecutions(first, 200)).toEqual([]);
            expect(await h.store.listInterceptions(first)).toEqual([]);
            expect(await h.store.readRun(second)).toMatchObject({ status: "completed" });
            expect(await h.store.readRun(third)).not.toBeNull();
            const deleted = await h.catalog.getSessionEvents(draft.workflowId, 0, 500, ["workflow.test_run_deleted"]);
            expect(deleted.map(event => event.data)).toEqual([expect.objectContaining({ runId: first, status: "completed", reason: "retention", keep: 1 })]);
            // The deleted run's test operation still replays its receipt (nothing is started again), and reading the run finds nothing.
            expect(await draft.update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: draft.definitionHash,
                inputs: {}, fixtures: RETAINED_FIXTURES })).toMatchObject({ ok: true, replayed: true, run: { runId: first } });
            expect(await draft.read({ run_id: first })).toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } });

            // Within the grace nothing is deleted, however many ended runs there are.
            await finished(third);
            h.host.testRetention = { keep: 0, graceSeconds: 3_600 };
            // No fixture: its tool call waits for an answer, so the run stays active.
            const fourth = await draft.test("test-4");
            for (const runId of [second, third, fourth]) expect(await h.store.readRun(runId), runId).not.toBeNull();
            // The store refuses what retention must never delete: an active run, a run within the grace, a live run.
            expect(await h.store.pruneTestRun(fourth, { graceSeconds: 0 })).toEqual({ pruned: false, reason: "active" });
            const call = `${nodeExecutionIdFor(fourth, "root", "work", 1)}/call-1`;
            await awaiting(h, call);
            expect(await draft.respond(fourth, call, { kind: "success", value: { state: "green" } }, "answer-1")).toMatchObject({ ok: true });
            await finished(fourth);
            expect(await h.store.pruneTestRun(fourth, { graceSeconds: 3_600 })).toEqual({ pruned: false, reason: "grace" });
            expect(await h.store.pruneTestRun(randomUUID(), { graceSeconds: 0 })).toEqual({ pruned: false, reason: "not_found" });
            const pruned = await h.store.pruneTestRun(fourth, { graceSeconds: 0 });
            expect(pruned).toMatchObject({ pruned: true, run: { runId: fourth }, deleted: { interceptions: 1, inbox: 0, kvRevisions: 1 } });
            expect(pruned.deleted.nodes).toBeGreaterThanOrEqual(2);
            expect(await h.store.readRun(fourth)).toBeNull();
        } finally {
            await h.stop();
        }
    });

    it("never deletes a live run", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, retainedDoc());
            const started = await draft.update({ operation: "publish_and_start", operation_id: "go", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {} });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "live" } });
            // A live run's script calls the live tool executor, which this harness refuses: the run fails and ends.
            await ended(h, started.run.runId);
            expect(await h.store.pruneTestRun(started.run.runId, { graceSeconds: 0 })).toEqual({ pruned: false, reason: "not_test" });
            expect(await h.store.listPrunableTestRuns(draft.workflowId, { keep: 0, graceSeconds: 0 })).toEqual([]);
            expect(await h.store.readRun(started.run.runId)).not.toBeNull();
        } finally {
            await h.stop();
        }
    });

    it("tests only a draft: a published workflow's test is refused with TEST_NEEDS_DRAFT and nothing is written (of-06)", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, retainedDoc());
            const published = await draft.update({ operation: "publish", operation_id: "pub", expected_revision: 1, definition_hash: draft.definitionHash });
            expect(published, JSON.stringify(published)).toMatchObject({ ok: true, state: "published" });
            expect(await draft.update({ operation: "test", operation_id: "t-after", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {} }))
                .toMatchObject({ ok: false, error: { code: "TEST_NEEDS_DRAFT",
                    message: "Only a draft can be tested, and this workflow is published. To test a change, create a new workflow as a draft." } });
            expect((await draft.read()).runs).toEqual([]);
        } finally {
            await h.stop();
        }
    });
});
