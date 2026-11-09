/**
 * An agent's test of a revision (chat-test.ts), gaps G1-G5, on PostgreSQL with the controller on a native runtime: one
 * definition that waits for a build event (a receive with no deadline), judges it (an agent step) and, to go again, polls
 * with a script (a granted tool and one the chat lacks) and waits for the next event.
 * - G1: receive fixtures give the receive its message on each visit, as a real message (the run's inbox, from the chat);
 *   without one for a visit the test fails TEST_STUCK, naming the receive fixture to add (with its visit).
 * - G2: per-visit fixtures answer the receive and the agent step differently on each visit; a visit-1 answer does not
 *   answer visit 2 (the test fails at once naming judge, visit 2, with its exact input).
 * - G3: a script's call of a tool the chat lacks (or of any tool, with no grant at all) is answered by its fixture, and the
 *   report says a run needs that tool; without a fixture the call fails as a live one would; a control tool is refused
 *   even with a fixture.
 * - G4: expect done passes there; expect failed (another state) fails; the bench keeps it. RLR-F6: expect is part of the
 *   test's identity: the same call (operation id) with another expect is refused (WORKFLOW_EXISTS, no new run), and with
 *   the same one (or none, both times) is the same test, run and stored expect, whose report a later test_id read repeats.
 * - RLR-F5: a report whose chat grant cannot be read says its tools were not checked (needsToolAtRunTime null).
 * - G5: the path gives each step's predecessor and route and its input.
 *
 * Run: npx vitest run test/local/workflow-chat-test-gaps.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerWorkflowV2, sessionQueueTransport } from "../../src/workflow/v2/runtime.ts";
import { saveChatWorkflowDefinition } from "../../src/workflow/v2/chat-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/v2/definition-tool.ts";
import { readWorkflowToolBinding, WORKFLOW_TOOL_POLICY } from "../../src/workflow/tool-policy.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-chat-test-gaps" };

const yamlOf = doc => JSON.stringify(doc, null, 2);
const LOOP = {
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "loop-watch", version: "1.0.0" },
    initial: "await_event",
    schemas: { BuildEvent: { type: "object", additionalProperties: false, required: ["buildId", "state"],
        properties: { buildId: { type: "integer" }, state: { type: "string" } } } },
    contracts: { "BuildEvent@1": { schema: { $ref: "#/schemas/BuildEvent" } } },
    states: {
        await_event: { type: "messaging", mode: "receive", contract: "BuildEvent@1", from: { parent: true }, correlate: { buildId: 7 },
            transition: { next: { received: "judge", failure: "failed" } } },
        judge: { type: "agent", invoke: { prompt: "Decide whether to look again." }, outcomes: ["again", "finish"], timeoutSeconds: 600,
            transition: { next: { again: "poll", finish: "done", failure: "failed" } } },
        poll: { type: "script", outcomes: ["ok"],
            source: "const build = await callTool(\"read_build\", { buildId: 7 });\nawait callTool(\"post_status\", { text: build.state });\n"
                + "await setResult(\"ok\", { build: build.state });\n",
            transition: { next: { ok: "await_event", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
        failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
};
const CONTROL = {
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "control-call", version: "1.0.0" }, initial: "spawn",
    states: {
        spawn: { type: "script", outcomes: ["ok"], source: "await callTool(\"spawn_agent\", { task: \"x\" });\nawait setResult(\"ok\", null);\n",
            transition: { next: { ok: "done", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
};
const success = value => ({ kind: "success", value });
const F = {
    event1: { operation: "receive", state: "await_event", visit: 1, response: success({ buildId: 7, state: "running" }) },
    event2: { operation: "receive", state: "await_event", visit: 2, response: success({ buildId: 7, state: "succeeded" }) },
    judge1: { operation: "agent", state: "judge", visit: 1, response: success({ outcome: "again", output: null }) },
    judgeAny: { operation: "agent", state: "judge", response: success({ outcome: "finish", output: null }) },
    readBuild: { tool: "read_build", response: success({ state: "running" }) },
    postStatus: { tool: "post_status", response: success("posted") },
};
const ALL_FIXTURES = Object.values(F);

/** The chat's grant: read_build only (post_status is a tool the chat lacks). */
const grant = chat => ({ policy: WORKFLOW_TOOL_POLICY, parentSessionId: chat, owner: OWNER, config: {}, capabilities: { selections: [] },
    tools: [{ name: "read_build", schemaHash: "h" }], sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "test" });

async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        // As a worker reads it: the Workflow's own creation config (the bench keeps the chat's grant).
        resolveToolBinding: async sessionId => readWorkflowToolBinding((await catalog.getSessionCreationConfig(sessionId))?.workflowToolBinding),
        openToolExecutor: async () => { throw new Error("A test run never opens the live tool executor."); },
        authorizeParentNotification: async () => true,
        notifyParent: async () => undefined,
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        testPollMs: 50,
        workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    const host = { catalog, store, duroxideClient: client, requests: true, scripts: true };
    const chat = randomUUID();
    await catalog.createSession(chat, { owner: OWNER });
    for (const doc of [LOOP, CONTROL]) {
        const saved = (await saveChatWorkflowDefinition(host, { ownerSessionId: chat, name: doc.metadata.name, yaml: yamlOf(doc), expected: null,
            actor: { kind: "chat", sessionId: chat }, operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
        expect(saved.valid, JSON.stringify(saved.diagnostics)).toBe(true);
    }
    // `granted: false`: a chat with no tool grant at all (the bench has none). `toolCallId`: a repeat of one call (its operation id).
    // `on`: another host (a catalog that reads otherwise).
    const tool = (args, { granted = true, toolCallId = randomUUID(), on = host } = {}) => workflowDefinitionFromTool({ name: "loop-watch", operation: "test", ...args },
        { callerSessionId: chat, host: on, toolCallId, owner: OWNER, binding: async () => granted ? grant(chat) : null,
            testWait: { waitMs: 120_000, pollMs: 50, graceMs: 10_000 } })
        .then(text => JSON.parse(text));
    return {
        catalog, store, chat, tool, host,
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

describe("an agent's test of a revision: receive fixtures, visits, tools the chat lacks, the expected end, the report (G1-G5)", () => {
    it("runs a loop to its expected end with per-visit messages and answers; tells which tools a run needs", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const report = await h.tool({ fixtures: ALL_FIXTURES, expect: "done" });
            expect(report, JSON.stringify(report)).toMatchObject({ status: "passed", expect: { state: "done" },
                run: { status: "completed", outcome: "succeeded", terminalState: "done" }, unanswered: null, refused: null });
            expect(report.message).toMatch(/passed: it ended at done \(succeeded\), as expected\. Its scripts call tools this chat does not have \(post_status\)/);
            // G1 + G2: each visit of the receive got its own message; the agent step answered "again", then "finish".
            expect(report.path.map(item => [item.step, item.visit, item.outcome])).toEqual([
                ["await_event", 1, "received"], ["judge", 1, "again"], ["poll", 1, "ok"], ["await_event", 2, "received"], ["judge", 2, "finish"],
                ["done", 1, "succeeded"]]);
            const step = (id, visit = 1) => report.path.find(item => item.step === id && item.visit === visit);
            expect(step("await_event", 1).output).toBe('{"buildId":7,"state":"running"}');
            expect(step("await_event", 2).output).toBe('{"buildId":7,"state":"succeeded"}');
            // G5: where each step came from, and what it was given.
            expect(step("await_event", 1).enteredBy).toBeUndefined();
            expect(step("poll").enteredBy).toEqual({ step: "judge", route: "again" });
            expect(step("judge", 2).enteredBy).toEqual({ step: "await_event", route: "received" });
            expect(step("judge", 2).input).toBe('{"buildId":7,"state":"succeeded"}');
            // G3: post_status was answered by its fixture (no real call); the chat lacks it, so a run needs it.
            expect(report.needsToolAtRunTime).toEqual([{ call: "tool call post_status in step poll", tool: "post_status" }]);
            expect(report.answeredCalls).toContainEqual({ call: "tool call post_status in step poll", by: "prepared answer" });
            // G1: the messages went through the run's inbox, from the chat (the receive's sender), once per visit.
            const inbox = await h.store.listInbox(report.runId);
            expect(inbox.map(item => [item.senderSessionId, item.contract, item.payload.state, item.consumedBy !== null])).toEqual([
                [h.chat, "BuildEvent@1", "running", true], [h.chat, "BuildEvent@1", "succeeded", true]]);
            expect(inbox.every(item => item.operationId.startsWith("test-receive:"))).toBe(true);
            // G4: the bench keeps what it expects.
            expect((await h.catalog.getSessionCreationConfig(report.testId)).agentTest.expect).toEqual({ state: "done" });
            // RLR-F5: read again where the bench's grant reads as invalid: its tools were not checked, and it says so.
            const invalidGrant = new Proxy(h.catalog, { get: (target, name) => name === "getSessionCreationConfig"
                ? async id => ({ ...await target.getSessionCreationConfig(id), workflowToolBinding: { policy: "?" } })
                : typeof target[name] === "function" ? target[name].bind(target) : target[name] });
            const unchecked = await h.tool({ test_id: report.testId }, { on: { ...h.host, catalog: invalidGrant } });
            expect(unchecked, JSON.stringify(unchecked)).toMatchObject({ status: "passed", runId: report.runId, needsToolAtRunTime: null,
                toolsUnchecked: { reason: "the chat's tool grant, as the test keeps it, is not valid", tools: ["read_build", "post_status"] } });
            expect(unchecked.message).not.toBe(report.message);
            expect(unchecked.message).toMatch(/could not check whether this chat has the tools its scripts call \(read_build, post_status\)/);
            expect(await h.tool({ test_id: report.testId })).toEqual(report);

            // G4 negative control: the same run, expecting another end, fails.
            const elsewhere = await h.tool({ fixtures: ALL_FIXTURES, expect: "failed" });
            expect(elsewhere, JSON.stringify(elsewhere)).toMatchObject({ status: "failed", run: { terminalState: "done" } });
            expect(elsewhere.message).toMatch(/failed: it ended completed \(succeeded\) at done, not at the expected state failed\.$/);
            const unknown = await h.tool({ fixtures: ALL_FIXTURES, expect: "nowhere" });
            expect(unknown.error?.code, JSON.stringify(unknown)).toBe("WORKFLOW_COMMAND_INVALID");
        } finally {
            await h.stop();
        }
    });

    it("fails naming what is missing: a visit's message (TEST_STUCK), a visit's answer, a tool the chat lacks; a control tool is refused", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // G1 + G2: no message for the receive's second visit (event1 is for visit 1 only).
            const stuck = await h.tool({ fixtures: ALL_FIXTURES.filter(item => item !== F.event2), expect: "done" });
            expect(stuck, JSON.stringify(stuck)).toMatchObject({ status: "failed", run: { status: "cancelled" },
                unanswered: { call: "receive step await_event", fixture: { operation: "receive", state: "await_event", visit: 2,
                    response: { kind: "success", value: "<the message, as its contract's schema says>" } } } });
            // G2: the agent step's visit-1 answer does not answer visit 2: it fails at once, giving the exact fixture.
            const judged = await h.tool({ fixtures: ALL_FIXTURES.filter(item => item !== F.judgeAny), expect: "done" });
            expect(judged, JSON.stringify(judged)).toMatchObject({ status: "failed", unanswered: { call: "agent step judge",
                fixture: { operation: "agent", state: "judge", arguments: { buildId: 7, state: "succeeded" }, visit: 2 } } });
            expect(judged.tookSeconds).toBeLessThan(10);
            // G3: no fixture for the tool the chat lacks: the call fails as a live one would (no real call).
            const lacking = await h.tool({ fixtures: ALL_FIXTURES.filter(item => item !== F.postStatus), expect: "done" });
            expect(lacking, JSON.stringify(lacking)).toMatchObject({ status: "failed", run: { terminalState: "failed" }, firstError: { step: "poll" } });
            expect(JSON.stringify(lacking.firstError.words)).toMatch(/post_status/);
            // A control tool is never answered, even by a fixture.
            const control = await h.tool({ name: "control-call", fixtures: [{ tool: "spawn_agent", response: success("spawned") }] });
            expect(control, JSON.stringify(control)).toMatchObject({ status: "failed", run: { terminalState: "failed" }, firstError: { step: "spawn" } });
            expect(control.answeredCalls).toEqual([]);
            expect(JSON.stringify(control.firstError.words)).toMatch(/Workflow control tool 'spawn_agent' is not permitted/);
        } finally {
            await h.stop();
        }
    });

    it("RLR-F6: expect is part of the test's identity: another expect under the same call is refused; the same one is the same test",
        { timeout: TIMEOUT }, async () => {
            const h = await harness(getEnv());
            try {
                // control-call ends at its failed state: a test expecting done fails.
                const toolCallId = randomUUID();
                const first = await h.tool({ name: "control-call", fixtures: [], expect: "done" }, { toolCallId });
                expect(first, JSON.stringify(first)).toMatchObject({ status: "failed", expect: { state: "done" }, run: { terminalState: "failed" } });
                // The same call expecting the end it reached: refused; no new run, and the stored test and its verdict are unchanged.
                const changed = await h.tool({ name: "control-call", fixtures: [], expect: "failed" }, { toolCallId });
                expect(changed.error?.code, JSON.stringify(changed)).toBe("WORKFLOW_EXISTS");
                expect(changed.error.message).toMatch(/another revision or expect/);
                expect((await h.store.listRuns(first.testId)).map(run => run.runId)).toEqual([first.runId]);
                expect((await h.catalog.getSessionCreationConfig(first.testId)).agentTest.expect).toEqual({ state: "done" });
                expect(await h.tool({ test_id: first.testId })).toEqual(first);
                // The same call with the same expect: the same test, run and stored expect; the same report as a test_id read.
                expect(await h.tool({ name: "control-call", fixtures: [], expect: "done" }, { toolCallId })).toEqual(first);
                // The default (no expect: outcome succeeded) is part of it too: none both times is the same test; then expect is another.
                const plainCall = randomUUID();
                const plain = await h.tool({ name: "control-call", fixtures: [] }, { toolCallId: plainCall });
                expect(plain, JSON.stringify(plain)).toMatchObject({ status: "failed", expect: null });
                expect(await h.tool({ name: "control-call", fixtures: [] }, { toolCallId: plainCall })).toEqual(plain);
                const named = await h.tool({ name: "control-call", fixtures: [], expect: "succeeded" }, { toolCallId: plainCall });
                expect(named.error?.code, JSON.stringify(named)).toBe("WORKFLOW_EXISTS");
                expect((await h.store.listRuns(plain.testId)).map(run => run.runId)).toEqual([plain.runId]);
                expect(await h.tool({ test_id: plain.testId })).toEqual(plain);
            } finally {
                await h.stop();
            }
        });

    it("with no tool grant at all, fixtures still answer a script's calls; an unanswered one fails as a run's would", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const report = await h.tool({ fixtures: ALL_FIXTURES, expect: "done" }, { granted: false });
            expect(report, JSON.stringify(report)).toMatchObject({ status: "passed", run: { terminalState: "done" } });
            expect(report.needsToolAtRunTime.map(item => item.tool)).toEqual(["read_build", "post_status"]);
            expect(await h.catalog.getSessionCreationConfig(report.testId)).not.toHaveProperty("workflowToolBinding");
            // Negative control: no fixture for read_build, no grant: the error a run without a grant has.
            const unanswered = await h.tool({ fixtures: ALL_FIXTURES.filter(item => item !== F.readBuild), expect: "done" }, { granted: false });
            expect(unanswered, JSON.stringify(unanswered)).toMatchObject({ status: "failed", run: { terminalState: "failed" }, firstError: { step: "poll" } });
            expect(JSON.stringify(unanswered.firstError.words)).toMatch(/no delegated tool grant/);
        } finally {
            await h.stop();
        }
    });
});
