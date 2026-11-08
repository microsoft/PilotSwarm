/**
 * Workflow Simplified stage 2.5, on PostgreSQL with controller 1.9.0 on a native runtime: an agent's test of a revision of
 * an IMPORTED definition. Migration 0107 turns a stage 1 Workflow child into a chat definition whose id is
 * 'imported-<md5>', not a uuid (the e26fbc12 run found listTests compared it with a uuid column). This could not be checked
 * on TEST: every imported definition there belongs to people's own chats.
 * - workflow_definition test runs the imported revision to its end with a prepared answer and reports passed;
 * - the bench is listed for that definition only: not for the chat's other imported definition, and not for another chat's
 *   imported definition of the same name; the definition list says that revision's last test, and no other revision's.
 *
 * Run: npx vitest run test/local/workflow-chat-test-imported.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { registerWorkflowV2, sessionQueueTransport } from "../../src/workflow/v2/runtime.ts";
import { listChatWorkflowDefinitions } from "../../src/workflow/v2/chat-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/v2/definition-tool.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const CMS_LOCK_SEED = 0x63_6D_73;
const OWNER = { provider: "test", subject: "workflow-chat-test-imported" };
const ACTOR = { kind: "system", name: "workflow-chat-test-imported" };

const yamlOf = doc => JSON.stringify(doc, null, 2);
/** A stage 1 Workflow: a script reads a build and ends with it. */
const BUILD_WATCH = {
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "build-watch", version: "1.0.0" },
    initial: "poll",
    states: {
        poll: {
            type: "script",
            source: "const build = await callTool(\"read_build\", { buildId: 7 });\nawait setResult(build.state === \"green\" ? \"green\" : \"red\", build);\n",
            transition: { next: { green: "done", red: "failed", failure: "failed" } },
        },
        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
        failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
    },
};
/** Another stage 1 Workflow of the same chat. */
const HOLD = {
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "hold", version: "1.0.0" },
    initial: "hold",
    states: {
        hold: { type: "wait", seconds: 30, transition: { next: { elapsed: "done" } } },
        done: { type: "terminal", outcome: "succeeded" },
    },
};
const FIXTURES = [{ tool: "read_build", response: { kind: "success", value: { state: "green" } } }];

describe("an agent's test of an imported definition's revision (stage 2.5)", () => {
    it("tests the 'imported-' definition's revision and lists the bench for that definition only", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        let runtime = null;
        try {
            // A stage 1 database: Workflow children of two chats, made before migration 0107.
            await runMigrations(direct, env.cmsSchema, CMS_MIGRATIONS(env.cmsSchema).filter(m => m.version <= "0106"), CMS_LOCK_SEED);
            const store = catalog.workflowStore();
            const stage1 = { catalog, store, duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const chat = randomUUID();
            const other = randomUUID();
            await catalog.createSession(chat, { owner: OWNER });
            await catalog.createSession(other, { owner: OWNER });
            // Stage 1 drafts, never started: nothing of them runs on the runtime below.
            const child = async (parent, doc) => {
                const id = randomUUID();
                await createWorkflowV2(stage1, { workflowSessionId: id, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR, operationId: `create-${id}`, publish: false });
                return id;
            };
            await child(chat, BUILD_WATCH);
            await child(chat, HOLD);
            await child(other, BUILD_WATCH);

            await catalog.initialize();
            const definitions = await store.chat.listDefinitions(chat);
            expect(definitions.map(item => [item.name, item.source, item.currentRevision])).toEqual([["build-watch", "imported", 1], ["hold", "imported", 1]]);
            const [imported, hold] = definitions;
            const [elsewhere] = await store.chat.listDefinitions(other);
            for (const item of [imported, hold, elsewhere]) expect(item.definitionId).toMatch(/^imported-[0-9a-f]{32}$/);
            expect(elsewhere.name).toBe("build-watch");
            expect(elsewhere.definitionId).not.toBe(imported.definitionId);

            // Controller 1.9.0 with workflow requests, as a worker of the test environment registers it.
            const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
            const client = new Client(provider);
            runtime = new Runtime(provider, {
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
                authorizeParentNotification: async () => true,
                notifyParent: async (parentSessionId, text) => { notices.push({ parentSessionId, text }); },
                deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
                wakeBackstopMs: 500,
                testPollMs: 50,
                workflowRequests: true,
                sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
            });
            await runtime.start();
            const host = { catalog, store, duroxideClient: client, requests: true, scripts: true };

            // The chat's agent tests revision 1 of the imported definition, by its id.
            const report = JSON.parse(await workflowDefinitionFromTool(
                { operation: "test", definition_id: imported.definitionId, revision: 1, fixtures: FIXTURES },
                { callerSessionId: chat, host, toolCallId: randomUUID(), owner: OWNER, binding: async () => null,
                    testWait: { waitMs: 90_000, pollMs: 50, graceMs: 10_000 } }));
            expect(report.ok, JSON.stringify(report)).toBe(true);
            expect(report).toMatchObject({ operation: "test", status: "passed", name: "build-watch", revision: 1, definitionId: imported.definitionId,
                run: { status: "completed", outcome: "succeeded", terminalState: "done" }, firstError: null, unanswered: null });
            expect(report.answeredCalls).toEqual([{ call: "tool call read_build in step poll", by: "prepared answer" }]);

            // The bench is listed for that definition and nowhere else.
            const forImported = await store.chat.listTests(chat, imported.definitionId);
            expect(forImported.map(item => [item.testId, item.definitionId, item.revision, item.verdict]))
                .toEqual([[report.testId, imported.definitionId, 1, "passed"]]);
            expect((await store.chat.listTests(chat)).map(item => item.testId)).toEqual([report.testId]);
            expect(await store.chat.listTests(chat, hold.definitionId)).toEqual([]);
            expect(await store.chat.listTests(chat, elsewhere.definitionId)).toEqual([]);
            expect(await store.chat.listTests(other)).toEqual([]);
            expect(await store.chat.listTests(other, elsewhere.definitionId)).toEqual([]);
            expect(await store.chat.listTests(other, imported.definitionId)).toEqual([]);
            const views = await listChatWorkflowDefinitions(host, chat);
            const viewOf = id => views.find(item => item.definitionId === id);
            expect(viewOf(imported.definitionId).revisions.find(item => item.revision === 1).lastTest)
                .toMatchObject({ testId: report.testId, verdict: "passed" });
            expect(viewOf(imported.definitionId).workflows.map(item => item.workflowSessionId)).not.toContain(report.testId);
            expect(viewOf(hold.definitionId).revisions.every(item => !item.lastTest)).toBe(true);
            const [otherView] = await listChatWorkflowDefinitions(host, other);
            expect(otherView.revisions.every(item => !item.lastTest)).toBe(true);
            // Another chat cannot test, or read the test of, this chat's imported definition.
            const foreign = JSON.parse(await workflowDefinitionFromTool({ operation: "test", test_id: report.testId },
                { callerSessionId: other, host, toolCallId: randomUUID(), owner: OWNER, binding: async () => null }));
            expect(foreign.error?.code, JSON.stringify(foreign)).toBe("TEST_NOT_FOUND");
            const crossed = JSON.parse(await workflowDefinitionFromTool(
                { operation: "test", definition_id: imported.definitionId, revision: 1, fixtures: FIXTURES },
                { callerSessionId: other, host, toolCallId: randomUUID(), owner: OWNER, binding: async () => null }));
            expect(crossed.error?.code, JSON.stringify(crossed)).toBe("DEFINITION_NOT_FOUND");
            expect(await store.chat.listTests(other)).toEqual([]);
            expect(notices).toEqual([]);
        } finally {
            if (runtime) await runtime.shutdown(100);
            await catalog.close();
            await direct.end();
        }
    });
});
