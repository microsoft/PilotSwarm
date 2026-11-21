/**
 * FB-008: a Start whose session's tool grant cannot be captured. Only script states call tools, through the grant captured
 * at Start. Before, workflow_definition start swallowed a failed capture (session-proxy.ts) and started the run with no
 * grant; its first script tool call then failed ("This workflow has no delegated tool grant; scripts in it cannot call
 * tools."), with nobody told at Start. spawn_workflow refused instead (WORKFLOW_PARENT_CONTEXT_UNAVAILABLE).
 *
 * - On a real worker (PostgreSQL, duroxide, the Copilot CLI, scripted model): a session with an in-memory application tool,
 *   which cannot be delegated durably (captureWorkflowToolBinding throws). Its Start of a revision with a script state is
 *   refused with the code and "Nothing was started", and no Workflow is made; its Start of a wait-only revision still starts
 *   and succeeds.
 * - On the store (no worker): the same two Starts with a capture that throws; the refused Start leaves nothing behind, so the
 *   same operation starts once the capture works. A repeat of a Start whose Workflow was stored is not given this refusal
 *   (its grant is only compared, as before; nothing new starts).
 *
 * Run: npx vitest run test/local/workflow-start-tool-grant.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, workflowParentContextUnavailable, workflowToolGrant } from "../../src/workflow/tool-policy.ts";
import { spawnWorkflowCompatFromTool, workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-start-tool-grant" };
const ENGINE = { kind: "system", name: "workflow-start-tool-grant-test" };
const CODE = WORKFLOW_PARENT_CONTEXT_UNAVAILABLE;

const SCRIPT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: poll-probe, version: "1.0.0" }
initial: probe
states:
  probe:
    type: script
    source: |
      await callTool("store_fact", { key: "fb-008/probe", value: { polled: true } });
      await setResult("success", { polled: true });
    transition: { next: { success: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const WAIT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: hold, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function until(check, label, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function refusal(promise) {
    try {
        const value = await promise;
        return { started: value };
    } catch (error) {
        return { error };
    }
}

describe("a Start whose session's tools cannot be handed to the Workflow (FB-008)", () => {
    it("on a real worker: a script revision is refused and nothing is started; a wait-only revision starts", { timeout: TIMEOUT }, async () => {
        const answers = {};
        const PROMPT = "Save and start the probe and the hold workflows.";
        const respond = (_body, position) => {
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            const steps = [
                { name: "workflow_definition", args: { operation: "save", name: "poll-probe", yaml: SCRIPT_YAML } },
                { name: "workflow_definition", args: { operation: "start", name: "poll-probe" } },
                { name: "workflow_definition", args: { operation: "save", name: "hold", yaml: WAIT_YAML } },
                { name: "workflow_definition", args: { operation: "start", name: "hold" } },
            ];
            if (position.step > 0) answers[position.step - 1] = JSON.parse(position.toolResults[0]);
            if (position.step < steps.length) return { tools: [steps[position.step]] };
            return { content: "Done." };
        };
        await withScriptedModel(getEnv(), { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, qualifiedModel }) => {
            // An application tool given in memory to this session: it cannot be delegated durably to a Workflow, so the
            // session's tool grant cannot be captured (captureWorkflowToolBinding throws).
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER, tools: [{
                name: "app_lookup", description: "An in-memory application tool.", parameters: { type: "object", properties: {} },
                handler: async () => "app-result",
            }] });
            await turnWorkflowsOn(client._catalog, session.sessionId);
            await session.send(PROMPT);
            await until(() => answers[3], "the hold start's answer");
            const store = client._catalog.workflowStore();
            const definitions = await store.sessionDefinitions.listDefinitions(session.sessionId);
            const probe = definitions.find(item => item.name === "poll-probe");
            const hold = definitions.find(item => item.name === "hold");
            expect(answers[0]).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
            // The script revision: refused, in words the agent can relay; no Workflow of it exists.
            const probeRuns = await store.sessionDefinitions.listWorkflows({ definitionId: probe.definitionId });
            let started = "";
            if (answers[1]?.ok) {
                // What the old path did: the run started with no grant, and its script failed at its first tool call.
                const run = await until(async () => {
                    const [row] = await store.listRuns(answers[1].workflowId);
                    return row && ["completed", "failed", "cancelled", "stopped"].includes(row.status) ? row : null;
                }, "the started probe's end", 60_000).catch(() => null);
                const visits = run ? await store.listNodeExecutions(run.runId) : [];
                started = `. A Workflow was started and ended ${run?.status ?? "(no end seen)"}; its probe visit: `
                    + JSON.stringify(visits.filter(visit => visit.nodeId === "probe").map(visit => ({ outcome: visit.outcome, error: visit.error }))).slice(0, 600);
            }
            expect(answers[1], `the start of a script revision${started}`).toMatchObject({ ok: false, error: { code: CODE } });
            expect(answers[1].error.message).toBe("poll-probe was not started: this session's tools could not be handed to it, and its "
                + "script state (probe) can call tools only through them. Nothing was started. Call workflow_definition start again; "
                + "if it is refused again, tell the user.");
            expect(answers[1].error.details).toEqual({ scriptNodes: ["probe"] });
            expect(probeRuns).toEqual([]);
            // The wait-only revision calls no tool: it starts without the grant and succeeds.
            expect(answers[3]).toMatchObject({ ok: true, operation: "start", name: "hold", revision: 1 });
            const holdRuns = await store.sessionDefinitions.listWorkflows({ definitionId: hold.definitionId });
            expect(holdRuns.map(row => row.workflowSessionId)).toEqual([answers[3].workflowId]);
            const holdRun = await until(async () => {
                const [row] = await store.listRuns(answers[3].workflowId);
                return row?.status === "completed" ? row : null;
            }, "the hold Workflow's success", 60_000);
            expect(holdRun.terminalOutcome).toBe("succeeded");
            const children = (await client._catalog.listSessions()).filter(row => row.parentSessionId === session.sessionId && row.sessionKind === "workflow");
            expect(children.map(row => row.sessionId)).toEqual([answers[3].workflowId]);
        });
    });

    it("retries the first failed durable empty-default capture on the next turn", { timeout: TIMEOUT }, async () => {
        await withScriptedModel(getEnv(), { respond: () => ({ content: "ok" }) }, async ({ client, worker, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
            const catalog = worker.catalog;
            const recordEvents = catalog.recordEvents.bind(catalog);
            let failures = 2;
            catalog.recordEvents = async (sessionId, events, workerNodeId) => {
                if (sessionId === session.sessionId && failures > 0
                    && events.some(event => event.eventType === "session.workspace_defaults")) {
                    failures -= 1;
                    throw Object.assign(new Error("temporary CMS failure"), { code: "ECONNREFUSED" });
                }
                return recordEvents(sessionId, events, workerNodeId);
            };
            await session.sendAndWait("first empty turn", TIMEOUT);
            expect(failures).toBe(0);
            expect((await catalog.getSessionEvents(session.sessionId))
                .filter(event => event.eventType === "session.workspace_defaults")).toHaveLength(0);
            await session.sendAndWait("retry empty turn", TIMEOUT);
            expect((await catalog.getSessionEvents(session.sessionId))
                .filter(event => event.eventType === "session.workspace_defaults")).toHaveLength(1);

            const host = { catalog, store: catalog.workflowStore(),
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const saved = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: session.sessionId, name: "empty-recovered", yaml: WAIT_YAML.replace("name: hold", "name: empty-recovered"),
                expected: null, actor: { kind: "session", sessionId: session.sessionId }, operationId: "save-empty-recovered", by: "session",
            })).receipt;
            const mgmt = await createManagementClient(getEnv());
            try {
                const started = await mgmt.startSessionWorkflowDefinition(session.sessionId, {
                    definitionId: saved.definitionId, inputs: {}, operationId: "start-empty-recovered",
                });
                expect((await catalog.getSessionCreationConfig(started.workflowId)).workflowWorkspace)
                    .toEqual({ workspace: null, defaults: null });
            } finally {
                await mgmt.stop();
            }
        });
    });

    it("agent Start keeps extra-only provider defaults without a parent attachment", { timeout: TIMEOUT }, async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-wf-extra-only-")));
        fs.mkdirSync(path.join(root, "checkout"));
        fs.mkdirSync(path.join(root, "shared"));
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        provider.defaultFolders = () => ({ extra: { shared: { root: "a", folder: "shared" } } });
        const prompt = "Save and start an explicit checkout with extra-only defaults.";
        const answers = {};
        const respond = (_body, position) => {
            if (!position.lastUserText.includes(prompt)) return { content: "ok" };
            const calls = [
                { name: "workflow_definition", args: { operation: "save", name: "extras", yaml: WAIT_YAML.replace("name: hold", "name: extras") } },
                { name: "workflow_definition", args: { operation: "start", name: "extras", workspace: { root: "a", folder: "checkout" } } },
            ];
            if (position.step > 0) answers[position.step - 1] = JSON.parse(position.toolResults[0]);
            return position.step < calls.length ? { tools: [calls[position.step]] } : { content: "Done." };
        };
        try {
            await withScriptedModel(getEnv(), { respond, worker: { workspaceProvider: provider } }, async ({ client, qualifiedModel }) => {
                const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
                await turnWorkflowsOn(client._catalog, session.sessionId);
                await session.send(prompt);
                await until(() => answers[1], "the extras-only Start");
                expect(answers[1]).toMatchObject({ ok: true, operation: "start" });
                expect((await client._catalog.getSessionCreationConfig(answers[1].workflowId)).workflowWorkspace).toEqual({
                    workspace: { schema: 1, root: "a", folder: "checkout" },
                    defaults: { workingFolder: null, extra: [{ name: "shared", root: "a", folder: "shared" }] },
                });
                const defaultsEvent = (await client._catalog.getSessionEvents(session.sessionId))
                    .filter(event => event.eventType === "session.workspace_defaults").at(-1);
                expect(defaultsEvent.data.capturedDefaults).toEqual({
                    workingFolder: null, extra: [{ name: "shared", root: "a", folder: "shared" }],
                });
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("persists one Start-time workspace and replays it after the parent moves", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            const saved = (await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "hold", yaml: WAIT_YAML,
                expected: null, actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            const firstWorkspace = { schema: 1, root: "repos", folder: "first", extra: { logs: { root: "logs", required: false } } };
            const defaults = { workingFolder: null, extra: [{ name: "shared", root: "shared", required: false }] };
            const binding = workspace => ({ policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER,
                config: { workspace, workspaceDefaults: defaults }, capabilities: { revision: 0, selections: [] }, tools: [],
                sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" });
            const start = (workspace, extra = {}) => startSessionWorkflowDefinition(host, {
                ownerSessionId: session, definition: { definitionId: saved.definitionId }, inputs: {}, actor: ENGINE,
                operationId: "pin-workspace", owner: OWNER, binding: binding(workspace), ...extra,
            });
            const made = await start(firstWorkspace);
            const stored = await h.catalog.getSessionCreationConfig(made.workflowId);
            expect(stored.workflowWorkspace).toEqual({ workspace: firstWorkspace, defaults });

            const moved = { schema: 1, root: "repos", folder: "moved" };
            const replay = await start(moved, { workspace: moved, workspaceInherited: true });
            expect(replay).toMatchObject({ workflowId: made.workflowId, replayed: true, revision: 1 });
            expect((await h.catalog.getSessionCreationConfig(made.workflowId)).workflowWorkspace).toEqual(stored.workflowWorkspace);

            await expect(start(firstWorkspace, { workspace: moved })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });

            const bridgeSaved = (await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "workspace-bridge",
                yaml: WAIT_YAML.replace("name: hold", "name: workspace-bridge"),
                expected: null, actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            const bridge = async (workspace, workspaceInherited = false) => JSON.parse(await workflowDefinitionFromTool({
                operation: "start", definition_id: bridgeSaved.definitionId, inputs: {}, key: "bridge-key",
                ...(workspace !== undefined ? { workspace } : {}),
            }, {
                callerSessionId: session, toolCallId: "bridge-call", host, owner: OWNER, nestingLevel: 0,
                binding: async () => { throw workflowParentContextUnavailable(); },
                workspace: async () => ({ workspace: firstWorkspace, defaults }),
                ...(workspaceInherited ? { workspaceInherited: true } : {}),
            }));
            const toolStarted = await bridge(undefined);
            expect(toolStarted).toMatchObject({ ok: true, operation: "start" });
            expect((await h.catalog.getSessionCreationConfig(toolStarted.workflowId)).workflowWorkspace)
                .toEqual({ workspace: firstWorkspace, defaults });
            const toolReplay = await bridge(moved, true);
            expect(toolReplay).toMatchObject({ ok: true, replayed: true, workflowId: toolStarted.workflowId });
            expect((await bridge(moved)).error).toMatchObject({ code: "OPERATION_CONFLICT" });

            const rawSaved = (await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "workspace-raw",
                yaml: WAIT_YAML.replace("name: hold", "name: workspace-raw"),
                expected: null, actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            const rawBridge = async (workspace, inherited = false) => JSON.parse(await workflowDefinitionFromTool({
                operation: "start", definition_id: rawSaved.definitionId, inputs: {}, key: "raw-key",
                ...(workspace !== undefined ? { workspace } : {}),
            }, {
                callerSessionId: session, toolCallId: "raw-bridge-call", host, owner: OWNER, nestingLevel: 0,
                binding: async () => { throw workflowParentContextUnavailable(); },
                workspace: async () => ({ workspace: null, defaults, workingDirectory: "/ws/raw-parent" }),
                ...(inherited ? { workspaceInherited: true } : {}),
            }));
            const rawStarted = await rawBridge(undefined);
            expect(rawStarted).toMatchObject({ ok: true });
            expect((await h.catalog.getSessionCreationConfig(rawStarted.workflowId)).workflowWorkspace)
                .toEqual({ workspace: null, defaults, workingDirectory: "/ws/raw-parent" });
            expect((await rawBridge(undefined)).replayed).toBe(true);
            expect((await rawBridge(null)).error).toMatchObject({ code: "OPERATION_CONFLICT" });
        } finally {
            await h.stop();
        }
    });

    it("all three Workflow Start surfaces distinguish omitted, object, null and none", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            const base = { schema: 1, root: "repos", folder: "parent", extra: { logs: { root: "logs" } } };
            const moved = { schema: 1, root: "repos", folder: "moved" };
            const defaults = { workingFolder: null, extra: [{ name: "shared", root: "shared", required: false }] };
            const binding = () => ({ policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER,
                config: { workspace: base, workspaceDefaults: defaults }, capabilities: { revision: 0, selections: [] }, tools: [],
                sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" });
            const capture = async () => ({ workspace: base, defaults });
            const modes = [
                ["omitted", undefined, { workspace: base, defaults }],
                ["object", moved, { workspace: moved, defaults }],
                ["null", null, { workspace: null, defaults }],
                ["none", "none", { workspace: null, defaults: null }],
            ];
            const save = async (name) => (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: session, name, yaml: WAIT_YAML.replace("name: hold", `name: ${name}`), expected: null,
                actor: { kind: "session", sessionId: session }, operationId: `save-${name}`, by: "session",
            })).receipt;
            const assertStored = async (workflowId, expected) => {
                expect((await h.catalog.getSessionCreationConfig(workflowId)).workflowWorkspace).toEqual(expected);
            };

            // The person/management API reaches startSessionWorkflowDefinition directly.
            for (const [label, value, expected] of modes) {
                const saved = await save(`api-${label}`);
                const started = await startSessionWorkflowDefinition(host, {
                    ownerSessionId: session, definition: { definitionId: saved.definitionId }, inputs: {}, actor: ENGINE,
                    operationId: `api-start-${label}`, owner: OWNER, binding,
                    ...(value !== undefined ? { workspace: value } : {}), workspaceDefaults: defaults,
                });
                await assertStored(started.workflowId, expected);
            }

            // workflow_definition uses the agent bridge and captures the same parent snapshot.
            for (const [label, value, expected] of modes) {
                const saved = await save(`definition-${label}`);
                const answer = JSON.parse(await workflowDefinitionFromTool({
                    operation: "start", definition_id: saved.definitionId, inputs: {}, key: `definition-${label}`,
                    ...(value !== undefined ? { workspace: value } : {}),
                }, {
                    callerSessionId: session, toolCallId: `definition-call-${label}`, host, owner: OWNER, nestingLevel: 0,
                    binding, workspace: capture,
                }));
                expect(answer).toMatchObject({ ok: true, operation: "start" });
                await assertStored(answer.workflowId, expected);
            }

            // The compatibility spawn_workflow path shares the same Start semantics.
            for (const [label, value, expected] of modes) {
                const yaml = WAIT_YAML.replace("name: hold", `name: spawn-${label}`);
                const answer = JSON.parse(await spawnWorkflowCompatFromTool({
                    yaml, state: "published", start: true, inputs: {}, key: `spawn-${label}`,
                    ...(value !== undefined ? { workspace: value } : {}),
                }, {
                    callerSessionId: session, operationId: `spawn-call-${label}`, host, owner: async () => OWNER,
                    binding: async () => binding(), workspace: capture,
                }));
                expect(answer).toMatchObject({ ok: true, operation: "save_and_start" });
                await assertStored(answer.workflowId, expected);
            }
        } finally {
            await h.stop();
        }
    });

    it("the person API captures pre-turn defaults and raw cwd for all four workspace values", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        const mgmt = await createManagementClient(getEnv());
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const session = randomUUID();
            const defaults = { workingFolder: { root: "home", folder: "people/alice" }, extra: [{ name: "shared", root: "shared" }] };
            const extra = defaults.extra;
            const raw = "/ws/preturn-person";
            await h.catalog.createSession(session, { owner: OWNER, creationConfig: { workspaceDefaults: defaults, workingDirectory: raw } });
            const moved = { root: "repos", folder: "person" };
            const modes = [
                ["omitted", undefined, { workspace: null, defaults, workingDirectory: raw }],
                ["object", moved, { workspace: { schema: 1, ...moved }, defaults }],
                ["null", null, { workspace: null, defaults }],
                ["none", "none", { workspace: null, defaults: null }],
            ];
            for (const [label, workspace, expected] of modes) {
                const saved = (await saveSessionWorkflowDefinition(host, {
                    ownerSessionId: session, name: `person-${label}`, yaml: WAIT_YAML.replace("name: hold", `name: person-${label}`),
                    expected: null, actor: { kind: "session", sessionId: session }, operationId: `person-save-${label}`, by: "session",
                })).receipt;
                const started = await mgmt.startSessionWorkflowDefinition(session, {
                    definitionId: saved.definitionId, inputs: {}, operationId: `person-start-${label}`,
                    ...(workspace !== undefined ? { workspace } : {}),
                });
                expect((await h.catalog.getSessionCreationConfig(started.workflowId)).workflowWorkspace).toEqual(expected);
            }

            const cleared = randomUUID();
            const staleDefaults = { workingFolder: { root: "home", folder: "people/stale" }, extra: [] };
            const currentDefaults = { workingFolder: { root: "home", folder: "people/current" }, extra };
            await h.catalog.createSession(cleared, { owner: OWNER, creationConfig: {
                workspace: moved, workspaceDefaults: staleDefaults, workingDirectory: "/ws/cleared-before-start",
            } });
            await h.catalog.recordEvents(cleared, [
                { eventType: "session.workspace_changed", data: { workspace: null, revision: 1, path: null, source: "external" } },
                ...Array.from({ length: 1_001 }, () => ({ eventType: "session.workspace_defaults", data: staleDefaults })),
                { eventType: "session.workspace_defaults", data: { ...currentDefaults, capturedDefaults: currentDefaults } },
            ], "person-start-workspace-history");
            const clearedSave = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: cleared, name: "person-after-clear", yaml: WAIT_YAML.replace("name: hold", "name: person-after-clear"),
                expected: null, actor: { kind: "session", sessionId: cleared }, operationId: "person-save-after-clear", by: "session",
            })).receipt;
            const afterClear = await mgmt.startSessionWorkflowDefinition(cleared, {
                definitionId: clearedSave.definitionId, inputs: {}, operationId: "person-start-after-clear",
            });
            expect((await h.catalog.getSessionCreationConfig(afterClear.workflowId)).workflowWorkspace).toEqual({
                workspace: null, defaults: currentDefaults,
            });

            const uncaptured = randomUUID();
            await h.catalog.createSession(uncaptured, { owner: OWNER, creationConfig: { workingDirectory: "/ws/no-default-snapshot" } });
            const uncapturedSave = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: uncaptured, name: "person-uncaptured", yaml: WAIT_YAML.replace("name: hold", "name: person-uncaptured"),
                expected: null, actor: { kind: "session", sessionId: uncaptured }, operationId: "person-save-uncaptured", by: "session",
            })).receipt;
            await expect(mgmt.startSessionWorkflowDefinition(uncaptured, {
                definitionId: uncapturedSave.definitionId, inputs: {}, operationId: "person-start-uncaptured",
            })).rejects.toMatchObject({ code: "WORKFLOW_COMMAND_INVALID", status: 400 });
            await h.catalog.recordEvents(uncaptured, [{
                eventType: "session.workspace_defaults",
                data: { revision: 0, workingFolder: null, extra: [], capturedDefaults: null },
            }], "person-empty-defaults-resolved");
            const afterEmptyTurn = await mgmt.startSessionWorkflowDefinition(uncaptured, {
                definitionId: uncapturedSave.definitionId, inputs: {}, operationId: "person-start-after-empty-turn",
            });
            expect((await h.catalog.getSessionCreationConfig(afterEmptyTurn.workflowId)).workflowWorkspace)
                .toEqual({ workspace: null, defaults: null, workingDirectory: "/ws/no-default-snapshot" });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    it("on the store: refused before anything is written, so the same operation starts once the capture works", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const dispatched = [];
            const host = {
                catalog: h.catalog, store: h.store,
                duroxideClient: {
                    startOrchestrationVersioned: async (instanceId) => { dispatched.push(instanceId); },
                    getStatus: async () => ({ status: "Running" }),
                    enqueueEvent: async () => {},
                },
            };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            const save = async (name, yaml) => (await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name, yaml, expected: null,
                actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            const grant = { value: null };
            let captures = 0;
            const binding = async () => {
                captures += 1;
                if (grant.value === null) throw workflowParentContextUnavailable();
                return grant.value;
            };
            const start = (definitionId, operationId) => startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId },
                inputs: {}, actor: ENGINE, operationId, owner: OWNER, binding });
            const probe = await save("poll-probe", SCRIPT_YAML.replace("fb-008/probe", "fb-008/store"));
            const hold = await save("hold", WAIT_YAML);

            // A wait-only revision starts without the grant.
            const held = await start(hold.definitionId, "start-hold");
            expect(held).toMatchObject({ operation: "start", name: "hold", revision: 1, replayed: false });
            expect(dispatched).toHaveLength(1);

            // A script revision is refused, and nothing is written: no Workflow, no claim, no dispatch.
            const operationId = "start-probe";
            const first = await refusal(start(probe.definitionId, operationId));
            expect(first.error?.code, first.error?.message ?? JSON.stringify(first.started)).toBe(CODE);
            expect(first.error.message).toMatch(/^poll-probe was not started: .+ Nothing was started\. Call workflow_definition start again; /);
            expect(first.error.details).toEqual({ scriptNodes: ["probe"] });
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: probe.definitionId })).toEqual([]);
            expect(dispatched).toHaveLength(1);

            // The same operation, once the capture works: it starts with that grant.
            grant.value = { policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER, config: {},
                capabilities: { revision: 0, selections: [] }, tools: [workflowToolGrant({ name: "store_fact", input_schema: { type: "object" } })],
                sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" };
            const second = await start(probe.definitionId, operationId);
            expect(second).toMatchObject({ operation: "start", name: "poll-probe", revision: 1, replayed: false });
            expect(dispatched).toHaveLength(2);
            const config = await h.catalog.getSessionCreationConfig(second.workflowId);
            expect(config.workflowToolBinding).toMatchObject({ policy: "node-parent-tools-v1", parentSessionId: session });

            // The same operation again with the capture failing: a stored Workflow's grant is only compared, never required
            // again, so this refusal is not given; nothing new starts and the stored grant is kept.
            grant.value = null;
            const before = captures;
            const replay = await refusal(start(probe.definitionId, operationId));
            expect(captures).toBe(before + 1);
            expect(replay.error?.code ?? null, replay.error?.message).not.toBe(CODE);
            expect((await h.catalog.getSessionCreationConfig(second.workflowId)).workflowToolBinding).toMatchObject({ parentSessionId: session });
            expect(dispatched).toHaveLength(2);
        } finally {
            await h.stop();
        }
    });
});
