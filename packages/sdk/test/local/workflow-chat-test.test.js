/**
 * Workflow Simplified stage 2.2, on PostgreSQL with controller 1.9.0 on a native runtime: an agent's test of a revision, on
 * request (chat-test.ts; spec "Agent-only test, on request"; readings item 6). The chat's workflow_definition test:
 * - runs the revision to its end on a hidden test bench with prepared answers: a script's tool call answered by a fixture
 *   without arguments, an agent step answered by its fixture, and a one-hour wait that passes at once on the virtual clock;
 *   the report gives the path, outputs, the mocked answers, the virtual time the wait took, and passed;
 * - a call with no prepared answer fails the test, which names it; its run is canceled, and nobody is told: the chat gets
 *   no test_waiting notice (the bench notifies nobody);
 * - the test bench is a service session (workflow-test): never a Workflow of the definition, never in a session list
 *   (management client, client), and the definition's list says each revision's last test;
 * - a test still running when the call's wait ends answers with its id; the same call with test_id reads it to its end;
 * - older ended tests of a definition beyond the newest 5 are deleted.
 *
 * Run: npx vitest run test/local/workflow-chat-test.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerWorkflowV2, sessionQueueTransport } from "../../src/workflow/v2/runtime.ts";
import { saveChatWorkflowDefinition, listChatWorkflowDefinitions } from "../../src/workflow/v2/chat-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/v2/definition-tool.ts";
import { WORKFLOW_DEFINITION_TESTS_KEPT } from "../../src/workflow/v2/chat-test.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "workflow-chat-test" };

const yamlOf = doc => JSON.stringify(doc, null, 2);
/** A script that reads a build, an agent step that summarizes it, an hour's wait, and the end. */
const DOC = {
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "build-watch", version: "1.0.0" },
    initial: "poll",
    schemas: { Summary: { type: "object", required: ["lines"], properties: { lines: { type: "integer" } }, additionalProperties: false } },
    states: {
        poll: {
            type: "script",
            source: "const build = await callTool(\"read_build\", { buildId: 7 });\nawait setResult(build.state === \"green\" ? \"green\" : \"red\", build);\n",
            transition: { next: { green: "summarize", red: "failed", failure: "failed" } },
        },
        summarize: {
            type: "agent", invoke: { prompt: "Summarize the build in input in up to three lines." }, outputSchema: { $ref: "#/schemas/Summary" },
            timeoutSeconds: 600, transition: { next: { done: "hold", failure: "failed" } },
        },
        hold: { type: "wait", seconds: 3600, transition: { next: { elapsed: "done" } } },
        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
        failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
};
const FIXTURES = [
    { tool: "read_build", response: { kind: "success", value: { state: "green" } } },
    { operation: "agent", state: "summarize", response: { kind: "success", value: { outcome: "done", output: { lines: 2 } } } },
];

/** A worker-equivalent registration (workflowRequests; scripts granted read_build only); parent notices are recorded. */
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
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => ({ tools: [{ name: "read_build", schemaHash: "h" }], excludedTools: [] }),
        openToolExecutor: async () => { throw new Error("A test run never opens the live tool executor."); },
        // Authorized here, so a notice the runtime sent would be recorded: an agent's test must send none.
        authorizeParentNotification: async () => true,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notices.push({ parentSessionId, text, clientMessageId }); },
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
    const saved = (await saveChatWorkflowDefinition(host, { ownerSessionId: chat, name: "build-watch", yaml: yamlOf(DOC), expected: null,
        actor: { kind: "chat", sessionId: chat }, operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
    expect(saved.valid, JSON.stringify(saved.diagnostics)).toBe(true);
    const tool = (args, toolCallId = randomUUID(), testWait = { waitMs: 90_000, pollMs: 50, graceMs: 10_000 }) =>
        workflowDefinitionFromTool({ name: "build-watch", ...args }, { callerSessionId: chat, host, toolCallId, owner: OWNER, binding: async () => null, testWait })
            .then(text => JSON.parse(text));
    return {
        catalog, store, client, notices, host, chat, saved, tool,
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

describe("an agent's test of a revision, on request (stage 2.2)", () => {
    it("runs the revision to its end with prepared answers; its wait passes at once; the report says passed; the bench is hidden", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        const mgmt = await createManagementClient(getEnv());
        try {
            const report = await h.tool({ operation: "test", fixtures: FIXTURES });
            expect(report.ok, JSON.stringify(report)).toBe(true);
            expect(report).toMatchObject({ operation: "test", status: "passed", name: "build-watch", revision: 1, definitionId: h.saved.definitionId,
                run: { status: "completed", outcome: "succeeded", terminalState: "done" }, firstError: null, unanswered: null });
            expect(report.path.map(item => [item.step, item.outcome, item.mocked])).toEqual([
                ["poll", "green", false], ["summarize", "done", true], ["hold", "elapsed", false], ["done", "succeeded", false]]);
            expect(report.answeredCalls).toEqual([{ call: "tool call read_build in step poll", by: "prepared answer" },
                { call: "agent step summarize", by: "prepared answer" }]);
            // The hour's wait passed on the virtual clock, at once.
            expect(report.waitedVirtualSeconds).toBeGreaterThanOrEqual(3600);
            expect(report.tookSeconds).toBeLessThan(120);
            expect(report.notice).toMatch(/scripts run normally/);

            // The bench: a service session under the chat; no Workflow of the definition; no session list shows it.
            const bench = await h.catalog.getSession(report.testId);
            expect(bench).toMatchObject({ parentSessionId: h.chat, sessionKind: "workflow", serviceKind: "workflow-test", serviceOf: null });
            const [view] = await listChatWorkflowDefinitions(h.host, h.chat);
            expect(view.workflows).toEqual([]);
            expect(view.revisions.find(item => item.revision === 1).lastTest).toMatchObject({ testId: report.testId, verdict: "passed" });
            const listed = [
                ...(await mgmt.listSessions()).map(row => row.sessionId),
                ...(await mgmt.listSessionsPage({ limit: 200 })).sessions.map(row => row.sessionId),
            ];
            expect(listed).toContain(h.chat);
            expect(listed).not.toContain(report.testId);
            // The chat was told nothing.
            expect(h.notices).toEqual([]);
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    it("a call with no prepared answer fails the test, which names it; its run is canceled; nobody is told", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // No answer for the agent step.
            const report = await h.tool({ operation: "test", fixtures: [FIXTURES[0]] });
            expect(report, JSON.stringify(report)).toMatchObject({ status: "failed", unanswered: { call: "agent step summarize" }, run: { status: "cancelled" } });
            // Coordinator 22:05Z: the report says the shape the missing answer needs, and the step's first error is the cancel's reason.
            const agentShape = 'An agent step\'s answer is { kind: "success", value: { outcome: "done", output: <its output, as its outputSchema says> } }. '
                + 'A failure is { kind: "error", value: { code: "execution_failed", message: "..." } } (code: a runtime error code).';
            expect(report.message).toBe("The test of build-watch revision 1 failed: no prepared answer for the agent step summarize. "
                + `Add a fixture for it (or fix the definition) and test again. ${agentShape}`);
            expect(report.firstError).toEqual({ step: "summarize", words: `no prepared answer for the agent step summarize. ${agentShape}` });
            // No answer for the tool call (another one's arguments are prepared: the exact match only).
            const tool = await h.tool({ operation: "test", fixtures: [{ tool: "read_build", arguments: { buildId: 8 }, response: { kind: "success", value: {} } }] });
            expect(tool, JSON.stringify(tool)).toMatchObject({ status: "failed", unanswered: { call: "tool call read_build in step poll", arguments: '{"buildId":7}' } });
            expect(h.notices).toEqual([]);
            const [view] = await listChatWorkflowDefinitions(h.host, h.chat);
            expect(view.revisions.find(item => item.revision === 1).lastTest).toMatchObject({ testId: tool.testId, verdict: "failed" });
        } finally {
            await h.stop();
        }
    });

    // Coordinator 22:05Z (Agent Smith smoke on TEST): a request step's fixture shaped as an agent's ({ outcome, output }) or as
    // the bare answer was refused silently, and the test then said "no prepared answer". A request step's answer is
    // { response } or { decline: { reason } }: the right shapes pass, a wrong one fails the test at once, saying why.
    it("a request step: { response } and { decline } pass; an answer shaped as an agent's fails at once with TEST_ANSWER_REFUSED", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const doc = {
                apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "security-check", version: "1.0.0" },
                initial: "security_review",
                schemas: {
                    Ask: { type: "object", required: ["q"], properties: { q: { type: "string" } }, additionalProperties: false },
                    Answer: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } }, additionalProperties: false },
                },
                contracts: { "Review@1": { schema: { $ref: "#/schemas/Ask" }, response: { schema: { $ref: "#/schemas/Answer" } } } },
                states: {
                    security_review: { type: "messaging", mode: "request", recipient: { parent: true }, contract: "Review@1", input: { q: "approve?" },
                        timeoutSeconds: 600, transition: { next: { responded: "approved", declined: "declined", timed_out: "declined", failure: "declined" } } },
                    approved: { type: "terminal", outcome: "succeeded" },
                    declined: { type: "terminal", outcome: "succeeded" },
                },
            };
            const saved = (await saveChatWorkflowDefinition(h.host, { ownerSessionId: h.chat, name: "security-check", yaml: yamlOf(doc), expected: null,
                actor: { kind: "chat", sessionId: h.chat }, operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
            expect(saved.valid, JSON.stringify(saved.diagnostics)).toBe(true);
            const fixture = value => [{ operation: "request", state: "security_review", response: { kind: "success", value } }];
            const responded = await h.tool({ operation: "test", name: "security-check", fixtures: fixture({ response: { approved: true } }) });
            expect(responded, JSON.stringify(responded)).toMatchObject({ status: "passed", run: { terminalState: "approved" }, refused: null, unanswered: null });
            const declined = await h.tool({ operation: "test", name: "security-check", fixtures: fixture({ decline: { reason: "not now" } }) });
            expect(declined, JSON.stringify(declined)).toMatchObject({ status: "passed", run: { terminalState: "declined" } });
            const misShaped = await h.tool({ operation: "test", name: "security-check", fixtures: fixture({ outcome: "responded", output: { approved: true } }) });
            expect(misShaped, JSON.stringify(misShaped)).toMatchObject({ status: "failed", unanswered: null, run: { status: "cancelled" },
                refused: { call: "request step security_review" } });
            expect(misShaped.refused.reason).toMatch(/^the prepared answer for the request step security_review was refused: A request's success response is \{ response \} or \{ decline: \{ reason \} \}\. A request step's answer is /);
            expect(misShaped.firstError).toEqual({ step: "security_review", words: misShaped.refused.reason });
            expect(misShaped.message).toMatch(/ Fix that fixture and test again\.$/);
            // It ended at once, not after the grace for an answer (10 s here).
            expect(misShaped.tookSeconds).toBeLessThan(10);
            expect(h.notices).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it("a test still running when the wait ends answers with its id; test_id reads it to its end; tests beyond the newest 5 are deleted", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const first = await h.tool({ operation: "test", fixtures: FIXTURES }, randomUUID(), { waitMs: 0, pollMs: 50, graceMs: 10_000 });
            expect(first, JSON.stringify(first)).toMatchObject({ status: "running" });
            expect(first.message).toContain(`test_id ${first.testId}`);
            const read = await h.tool({ operation: "test", test_id: first.testId });
            expect(read, JSON.stringify(read)).toMatchObject({ status: "passed", testId: first.testId });
            // Another chat's test id is not this chat's.
            const other = randomUUID();
            await h.catalog.createSession(other, { owner: OWNER });
            const foreign = JSON.parse(await workflowDefinitionFromTool({ operation: "test", test_id: first.testId },
                { callerSessionId: other, host: h.host, toolCallId: "x", owner: OWNER, binding: async () => null }));
            expect(foreign.error.code).toBe("TEST_NOT_FOUND");
            // Retention: after more tests, only the newest WORKFLOW_DEFINITION_TESTS_KEPT remain (the first one is deleted).
            for (let index = 0; index < WORKFLOW_DEFINITION_TESTS_KEPT; index += 1) {
                expect((await h.tool({ operation: "test", fixtures: FIXTURES })).status).toBe("passed");
            }
            const tests = await h.store.chat.listTests(h.chat, h.saved.definitionId);
            // S2RT-F8: the newest five ended tests, no more (retention runs again when a test ends).
            expect(tests.length).toBeLessThanOrEqual(WORKFLOW_DEFINITION_TESTS_KEPT);
            // A definition's tests are found by its id in the bench's creation config, whatever the id's form: an imported
            // stage 1 definition's id is not a uuid (migration 0107: 'imported-<md5>'), and listing its tests reads nothing
            // else (e26fbc12 run: a uuid column compared with the id as text failed every definition read).
            expect(await h.store.chat.listTests(h.chat, `imported-${"0".repeat(32)}`)).toEqual([]);
            expect(tests.map(item => item.testId)).not.toContain(first.testId);
            expect((await h.catalog.getSession(first.testId))?.deletedAt ?? "deleted").toBeTruthy();
        } finally {
            await h.stop();
        }
    });

    // Stage 2 review S2RT-F8: six tests overlap (each still running when the next starts), then all end, read by their ids,
    // with no seventh test started: the definition keeps the newest five ended tests.
    it("S2RT-F8: six overlapping tests that all end keep the newest five, with no later test started", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const running = [];
            for (let index = 0; index < WORKFLOW_DEFINITION_TESTS_KEPT + 1; index += 1) {
                const started = await h.tool({ operation: "test", fixtures: FIXTURES }, randomUUID(), { waitMs: 0, pollMs: 50, graceMs: 10_000 });
                expect(started.status, JSON.stringify(started)).toBe("running");
                running.push(started.testId);
            }
            for (const testId of running) expect((await h.tool({ operation: "test", test_id: testId })).status).toBe("passed");
            const until = Date.now() + 15_000;
            let kept = await h.store.chat.listTests(h.chat, h.saved.definitionId);
            while (kept.length > WORKFLOW_DEFINITION_TESTS_KEPT && Date.now() < until) {
                await new Promise(resolve => setTimeout(resolve, 200));
                kept = await h.store.chat.listTests(h.chat, h.saved.definitionId);
            }
            expect(kept.map(item => item.verdict)).toEqual(Array(WORKFLOW_DEFINITION_TESTS_KEPT).fill("passed"));
            expect(kept.map(item => item.testId)).not.toContain(running[0]);
        } finally {
            await h.stop();
        }
    });

    // Stage 2 review S2RT-F6: a chat's hidden tests follow its lifetime and its definition's.
    it("S2RT-F6: a running test ends when its chat is canceled or its definition deleted; no test is made for an ended or deleted chat", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const runOfTest = async (testId) => (await h.store.listRuns(testId, 5))[0] ?? null;
            // A test held at its hour's wait (nobody advances its clock), then the chat is canceled: its run ends, its report stays.
            const held = await h.tool({ operation: "test", fixtures: FIXTURES }, randomUUID(), { waitMs: 0, pollMs: 50, graceMs: 10_000 });
            expect(held.status).toBe("running");
            // A second definition's test, held too, then that definition is deleted.
            const other = (await saveChatWorkflowDefinition(h.host, { ownerSessionId: h.chat, name: "other-watch",
                yaml: yamlOf({ ...DOC, metadata: { name: "other-watch", version: "1.0.0" } }), expected: null, actor: { kind: "chat", sessionId: h.chat },
                operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
            const otherTest = await h.tool({ operation: "test", name: "other-watch", fixtures: FIXTURES }, randomUUID(), { waitMs: 0, pollMs: 50, graceMs: 10_000 });
            expect(otherTest.status, JSON.stringify(otherTest)).toBe("running");
            await h.store.chat.deleteDefinition({ ownerSessionId: h.chat, definitionId: other.definitionId, actor: { kind: "user", provider: "test", subject: "ada" },
                operationId: `delete-${randomUUID()}`, requestSha256: "x" });
            expect(await runOfTest(otherTest.testId)).toMatchObject({ status: "cancelled", mode: "test" });
            expect((await h.catalog.getSession(otherTest.testId)).deletedAt ?? null).toBe(null);
            await h.catalog.updateSession(h.chat, { state: "cancelled" });
            expect(await runOfTest(held.testId)).toMatchObject({ status: "cancelled", mode: "test" });
            expect((await h.store.chat.listTests(h.chat)).map(item => [item.testId, item.verdict]))
                .toEqual(expect.arrayContaining([[held.testId, "failed"], [otherTest.testId, "failed"]]));
            // An ended chat makes no new test (its definition is still live), and nothing is claimed.
            const before = (await h.store.chat.listTests(h.chat)).length;
            const ended = await h.tool({ operation: "test", fixtures: FIXTURES });
            expect(ended.error?.code, JSON.stringify(ended)).toBe("CHAT_NOT_LIVE");
            expect((await h.store.chat.listTests(h.chat)).length).toBe(before);
        } finally {
            await h.stop();
        }
    });

    // A paused hidden test: deleting its definition ends it. endDefinitionTests cancelled the run but left paused_from set,
    // which the 0091 check workflow_runs_paused_from refuses, so the deletion failed (found with the lock-order test, at ea596f23).
    it("a definition deleted while its hidden test's run is paused: the deletion succeeds, the run is canceled with no paused_from, its report stays", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const direct = new pg.Pool({ connectionString: env.store, max: 1 });
        try {
            const held = await h.tool({ operation: "test", fixtures: FIXTURES }, randomUUID(), { waitMs: 0, pollMs: 50, graceMs: 10_000 });
            expect(held.status, JSON.stringify(held)).toBe("running");
            const [run] = await h.store.listRuns(held.testId, 5);
            // Paused as a pause leaves it: paused_from is the status it was paused from (0091).
            await direct.query(`UPDATE "${env.cmsSchema}".workflow_runs SET status = 'paused', paused_from = status WHERE run_id = $1`, [run.runId]);
            expect((await h.store.readRun(run.runId)).status).toBe("paused");
            await h.store.chat.deleteDefinition({ ownerSessionId: h.chat, definitionId: h.saved.definitionId, actor: { kind: "user", provider: "test", subject: "ada" },
                operationId: `delete-${randomUUID()}`, requestSha256: "x" });
            const { rows } = await direct.query(`SELECT status, paused_from, mode FROM "${env.cmsSchema}".workflow_runs WHERE run_id = $1`, [run.runId]);
            expect(rows).toEqual([{ status: "cancelled", paused_from: null, mode: "test" }]);
            expect((await h.store.chat.listTests(h.chat)).map(item => [item.testId, item.verdict])).toEqual(expect.arrayContaining([[held.testId, "failed"]]));
        } finally {
            await direct.end();
            await h.stop();
        }
    });

    it("refuses a revision with errors, and on a host that runs no scripts a revision with a script node, before anything is made", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const scriptsOff = JSON.parse(await workflowDefinitionFromTool({ operation: "test", name: "build-watch", fixtures: FIXTURES },
                { callerSessionId: h.chat, host: { ...h.host, scripts: false }, toolCallId: "off", owner: OWNER, binding: async () => null }));
            expect(scriptsOff.error.code).toBe("WORKFLOW_SCRIPTS_DISABLED");
            expect(scriptsOff.error.message).toMatch(/Nothing was tested\.$/);
            expect(await h.store.chat.listTests(h.chat)).toEqual([]);
            await saveChatWorkflowDefinition(h.host, { ownerSessionId: h.chat, name: "build-watch", yaml: yamlOf({ ...DOC, initial: "nowhere" }),
                expected: { definitionId: h.saved.definitionId, revision: 1 }, actor: { kind: "chat", sessionId: h.chat }, operationId: `save-${randomUUID()}`, by: "chat" });
            const broken = await h.tool({ operation: "test", revision: 2, fixtures: FIXTURES });
            expect(broken.error.code).toBe("DEFINITION_INVALID");
            expect(broken.error.message).toMatch(/Revision 2 of build-watch has errors, so it cannot be tested\. Nothing was tested\.$/);
            // Without a revision: the newest valid one (1).
            expect((await h.tool({ operation: "test", fixtures: FIXTURES })).revision).toBe(1);
        } finally {
            await h.stop();
        }
    });
});
