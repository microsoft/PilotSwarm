import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createRegistryWorkflowAgentResolver, createWorkflowAgentResolver } from "../../src/workflow/agent-resolver.ts";
import { clientWorkflowAgentChildCreator, createWorkflowAgentNodeHost } from "../../src/workflow/agent-host.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { workflowAgentChildSessionId, workflowAgentClientMessageId, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);

const OWNER = { provider: "test", subject: "startup-fixture" };
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const TOOL = "startup_lookup";
const MODEL = "gpt-5.6-terra";
const AGENT = { name: "startup_agent", tools: [TOOL], initialRequiredTool: TOOL };

function fixture({ deployment = false, oldAgent = AGENT, activeAgent = AGENT } = {}) {
    const entry = {
        packageId: "startup-package", name: "startup-kit", scope: "shared", owner: null,
        semver: "1.1.0", sha256: NEW,
        manifest: { agents: [activeAgent] },
    };
    const rows = new Map([
        ["P", { owner: OWNER, parentSessionId: null, model: "fixture:model" }],
        ["W", { parentSessionId: "P", owner: OWNER, sessionKind: "workflow" }],
    ]);
    const catalog = {
        getSession: async id => rows.get(id) ?? null,
        getAgentPackagesInstallManifest: async () => deployment ? [] : [entry],
        getAgentPackage: vi.fn(async (name, viewer, admin, selector) => {
            expect(name).toBe(entry.name);
            expect(viewer).toMatchObject(OWNER);
            expect(admin).toBe(false);
            expect(selector).toMatchObject({ scope: "shared" });
            return { ...entry, enabled: true, versions: [{ sha256: OLD, semver: "1.0.0", manifest: { agents: [oldAgent] } }] };
        }),
    };
    const resolve = createWorkflowAgentResolver({
        catalog,
        ...(deployment ? { deploymentAgents: () => ({ userAgents: [{ ...activeAgent, prompt: "Fixture agent." }] }) } : {}),
    });
    return { catalog, rows, resolve };
}

function request({ pinned = false, inline = false, childSessionId = "C", clientMessageId = "first-prompt" } = {}) {
    return {
        childSessionId, workflowSessionId: "W", controllingSessionId: "P", runId: "run", nodeExecutionId: "nx", stateId: "inspect",
        task: inline ? { source: "prompt", prompt: "Inspect it." } : {
            source: "agent", name: AGENT.name, package: pinned ? "startup-kit" : null, version: pinned ? "1.0.0" : null,
            ...(pinned ? { packageId: "startup-package", revision: OLD } : {}),
        },
        prompt: "Inspect the fixture.", clientMessageId, deadlineAt: "2026-11-12T05:00:00Z",
    };
}

function host(f, send = vi.fn(async () => {})) {
    const createSession = vi.fn(async () => ({ send }));
    const stop = vi.fn(async () => {});
    return {
        send, createSession, stop,
        host: createWorkflowAgentNodeHost({
            getSession: f.catalog.getSession, resolveAgent: f.resolve,
            createChild: clientWorkflowAgentChildCreator(() => ({
                start: async () => {}, stop, createSession,
            })),
        }),
    };
}

describe("FB-020: named Workflow startup tool uses the ordinary spawn contract", () => {
    it.each([false, true])("carries startup metadata through registry/deployment resolution (deployment=%s)", async deployment => {
        const f = fixture({ deployment });
        expect(await f.resolve(AGENT.name, "P")).toMatchObject({ initialRequiredTool: TOOL });
        const h = host(f);
        expect(await h.host.spawn(request())).toMatchObject({ spawned: true });
        expect(h.send).toHaveBeenCalledWith("Inspect the fixture.", {
            requiredTool: TOOL, clientMessageIds: ["first-prompt"],
            sender: expect.objectContaining({ kind: "agent", sessionId: "W" }),
        });
        expect(h.createSession.mock.calls[0][0].toolNames).toEqual([TOOL]);
        expect(h.stop).toHaveBeenCalledOnce();
    });

    it("leaves inline prompts unchanged and does not invent a required tool for a named agent without one", async () => {
        const plain = host(fixture());
        await plain.host.spawn(request({ inline: true }));
        expect(plain.send.mock.calls[0][1]).not.toHaveProperty("bootstrap");
        expect(plain.send.mock.calls[0][1]).not.toHaveProperty("requiredTool");
        const named = host(fixture({ activeAgent: { name: AGENT.name, tools: [] } }));
        await named.host.spawn(request());
        expect(named.send.mock.calls[0][1]).not.toHaveProperty("bootstrap");
        expect(named.send.mock.calls[0][1]).not.toHaveProperty("requiredTool");
    });

    it("keeps first-prompt retry identity, but does not repeat startup after the child's first turn", async () => {
        const f = fixture();
        const h = host(f);
        await h.host.spawn(request());
        f.rows.set("C", { parentSessionId: "W", owner: OWNER, currentIteration: 0, turnHigh: -1 });
        await h.host.spawn(request());
        expect(h.send.mock.calls[1][1]).toEqual(h.send.mock.calls[0][1]);
        f.rows.set("C", { parentSessionId: "W", owner: OWNER, currentIteration: 0, turnHigh: 0 });
        await h.host.spawn(request({ clientMessageId: "next-visit" }));
        expect(h.send.mock.calls[2][1]).not.toHaveProperty("requiredTool");
        expect(h.send.mock.calls[2][1]).not.toHaveProperty("bootstrap");
        expect(h.send.mock.calls[2][1].clientMessageIds).toEqual(["next-visit"]);
    });

    it("uses the real turn-control watermark, not the first completed turn's zero-based iteration", async () => {
        const store = await openWorkflowStore(getEnv());
        try {
            const childSessionId = randomUUID();
            await store.catalog.createSession(childSessionId, { owner: OWNER });
            const f = fixture();
            const get = f.catalog.getSession;
            f.catalog.getSession = id => id === childSessionId ? store.catalog.getSession(id) : get(id);
            const h = host(f);
            expect(await store.catalog.getSession(childSessionId)).toMatchObject({ currentIteration: 0, turnHigh: -1 });
            await h.host.spawn(request({ childSessionId }));
            expect(h.send.mock.calls[0][1].requiredTool).toBe(TOOL);
            await store.catalog.turnStart(childSessionId, 0);
            await store.catalog.turnEnd(childSessionId, 0, 0, "other", []);
            expect(await store.catalog.getSession(childSessionId)).toMatchObject({ currentIteration: 0, turnHigh: 0 });
            await h.host.spawn(request({ childSessionId, clientMessageId: "next-visit" }));
            expect(h.send.mock.calls[1][1]).not.toHaveProperty("requiredTool");
        } finally {
            await store.stop();
        }
    });

    it.each([AGENT, { name: AGENT.name, tools: [] }])("uses only the pinned revision's startup declaration", async oldAgent => {
        const f = fixture({ oldAgent, activeAgent: { name: AGENT.name, tools: ["new_startup"], initialRequiredTool: "new_startup" } });
        const h = host(f);
        expect(await h.host.spawn(request({ pinned: true }))).toMatchObject({ spawned: true });
        expect(f.catalog.getAgentPackage).toHaveBeenCalledOnce();
        expect(h.send.mock.calls[0][1].requiredTool).toBe(oldAgent.initialRequiredTool);
        expect(h.createSession.mock.calls[0][0].boundAgentPackageId).toBe(`startup-package@${OLD}`);
        expect(h.createSession.mock.calls[0][0].toolNames).toEqual([]);
    });

    it("refuses an unavailable pinned revision without sending the active agent's startup", async () => {
        const f = fixture();
        f.catalog.getAgentPackage.mockResolvedValueOnce(null);
        const h = host(f);
        expect(await h.host.spawn(request({ pinned: true }))).toMatchObject({ refused: { code: "unavailable" } });
        expect(h.createSession).not.toHaveBeenCalled();
        expect(h.send).not.toHaveBeenCalled();
    });

    it("the registry-only resolver preserves a pinned startup requirement too", async () => {
        const f = fixture({ activeAgent: { ...AGENT, initialRequiredTool: "new_startup", tools: ["new_startup"] } });
        f.resolve = createRegistryWorkflowAgentResolver(f.catalog);
        const h = host(f);
        await h.host.spawn(request({ pinned: true }));
        expect(h.send.mock.calls[0][1]).toMatchObject({ requiredTool: TOOL });
        expect(h.send.mock.calls[0][1]).not.toHaveProperty("bootstrap");
    });

    it.each([true, false])("records the first Workflow task prompt in the actual runTurn activity (required=%s)", async required => {
        const turn = makeRunTurnHarness({ catalogExtras: {
            turnStart: async (_id, _index, records) => {
                turn.recordedEvents.push(...records);
                return { stopped: false, controls: [] };
            },
            completeTurnWriteback: async () => false,
            turnEnd: async () => ({ stopped: false, late: [] }),
        } });
        const childSessionId = randomUUID();
        const clientMessageId = `workflow:W:run:agent:nx-${"1".repeat(40)}`;
        const send = vi.fn(async (prompt, opts) => {
            await turn.runTurn(childSessionId, { prompt, ...opts }, "runTurnV5");
        });
        const f = fixture({ activeAgent: required ? AGENT : { name: AGENT.name, tools: [] } });
        await host(f, send).host.spawn(request({ childSessionId, clientMessageId }));
        expect(turn.recordedEvents).toContainEqual(expect.objectContaining({
            eventType: "user.message",
            data: expect.objectContaining({ content: "Inspect the fixture.", clientMessageIds: [clientMessageId] }),
        }));
        expect(turn.session.runTurn.mock.calls[0][1].requiredTool).toBe(required ? TOOL : undefined);
    });

    it.each(["never-called", "called", "excluded"])("enforces the host's opening contract in a real child SDK/CLI turn: %s",
        { timeout: 30_000 }, async mode => {
            const home = mkdtempSync(join(tmpdir(), "ps-workflow-startup-"));
            const called = [];
            const events = [];
            const server = await createNativeCopilotProvider(body => mode === "called" && body.messages.at(-1).role !== "tool"
                ? { tools: [{ name: TOOL, args: {} }] } : { content: "UNENFORCED_COMPLETION" });
            const registry = new ModelProviderRegistry({ providers: [{
                id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL],
            }] });
            const manager = new SessionManager(undefined, null, {
                modelProviders: registry, turnTimeoutMs: 10_000, nativeSubagents: "off",
                agentPromptLookup: { [AGENT.name]: {
                    prompt: "Fixture startup agent.", kind: "app-agent", packageId: "startup-package",
                    packageScope: "shared", toolNames: [TOOL], initialRequiredTool: TOOL,
                } },
            }, join(home, "sessions"));
            const tool = {
                name: TOOL, description: "Inspect harmless local fixture data.",
                parameters: { type: "object", properties: {} },
                handler: async () => { called.push(TOOL); return "FIXTURE_DATA"; },
            };
            manager.setToolRegistry(new Map([[TOOL, tool]]), {
                byPackage: new Map([["startup-package", new Map([[TOOL, tool]])]]), staticNames: new Set(),
            });
            manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
            let result;
            const childSessionId = randomUUID();
            const send = vi.fn(async (prompt, opts) => {
                const managed = await manager.getOrCreate(childSessionId, {
                    model: `fixture:${MODEL}`, workingDirectory: home,
                    boundAgentName: AGENT.name, boundAgentPackageId: "startup-package",
                    workflowAgentChild: true,
                    toolNames: [TOOL], ...(mode === "excluded" ? { workflowToolLimit: [] } : {}),
                }, { turnIndex: 0 });
                // An old Start can reach its first turn without the newer host's prompt metadata.
                result = await managed.runTurn(prompt, { turnIndex: 0, onEvent: event => events.push(event) });
            });
            try {
                const h = host(fixture(), send);
                await h.host.spawn(request({ childSessionId }));
                if (mode === "called") {
                    expect(result).toMatchObject({ type: "completed" });
                    expect(called).toEqual([TOOL]);
                    expect(events.some(event => event.eventType === "tool.execution_start" && event.data.toolName === TOOL)).toBe(true);
                } else {
                    expect(result).toMatchObject({ type: "error", retryable: false });
                    expect(result.message).toContain(TOOL);
                    expect(called).toEqual([]);
                    if (mode === "excluded") {
                        for (const body of server.requests) {
                            expect((body.tools ?? []).map(tool => tool.function?.name ?? tool.name)).not.toContain(TOOL);
                        }
                    }
                }
                expect(send.mock.calls[0][1]).toMatchObject({ requiredTool: TOOL });
                expect(send.mock.calls[0][1]).not.toHaveProperty("bootstrap");
            } finally {
                await manager.shutdown();
                await server.close();
                rmSync(home, { recursive: true, force: true });
            }
        });

    it("refuses a pre-upgrade Workflow's first named turn before a model request when its stored ceiling excludes startup",
        { timeout: 120_000 }, async () => {
        const db = await openWorkflowStore(getEnv());
        const home = mkdtempSync(join(tmpdir(), "ps-workflow-legacy-startup-"));
        const server = await createNativeCopilotProvider(() => ({ content: "UNENFORCED_COMPLETION" }));
        const registry = new ModelProviderRegistry({ providers: [{
            id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL],
        }] });
        const manager = new SessionManager(undefined, null, {
            modelProviders: registry, turnTimeoutMs: 10_000, nativeSubagents: "off",
            agentPromptLookup: { [AGENT.name]: {
                prompt: "Fixture startup agent.", kind: "app-agent", toolNames: [TOOL], initialRequiredTool: TOOL,
            } },
        }, join(home, "sessions"));
        const tool = { name: TOOL, description: "Inspect harmless local fixture data.",
            parameters: { type: "object", properties: {} }, handler: vi.fn(async () => "FIXTURE_DATA") };
        manager.setToolRegistry(new Map([[TOOL, tool]]), { staticNames: new Set([TOOL]) });
        manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
        manager.setSessionCatalog(db.catalog);
        try {
            const parent = randomUUID();
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            const nodeExecutionId = nodeExecutionIdFor(runId, "root", "inspect", 1);
            const childSessionId = workflowAgentChildSessionId(nodeExecutionId);
            const yaml = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: legacy-startup, version: "1.0.0" }
initial: inspect
states:
  inspect:
    type: agent
    invoke: { agent: { name: startup_agent } }
    tools: none
    timeoutSeconds: 3600
    transition: { next: { done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
            const compiled = compileWorkflow(yaml);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            await db.catalog.createSession(parent, { owner: OWNER });
            // A pre-upgrade Start has neither a composition binding nor startup prompt metadata.
            await db.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: OWNER,
                creationConfig: { workflow: { requestSha256: "legacy-startup" } } });
            await db.store.createDefinition({ workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled,
                actor: { kind: "system", name: "startup-fixture" }, operationId: "create", requestSha256: "legacy-startup",
                publish: true, title: "Workflow: legacy startup",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null } });
            expect(await db.catalog.getSessionCreationConfig(workflowSessionId)).not.toHaveProperty("workflowToolBinding");
            await db.store.enterNode({ runId, nodeExecutionId, scopeId: "root", nodeId: "inspect", ordinal: 1,
                nodeType: "agent", predecessorId: null, arrivalRoute: null, inputText: "{}", kvRevision: 1,
                waitSeconds: null, immediate: null,
                agent: { childSessionId, controllingSessionId: parent, task: {
                    source: "agent", name: AGENT.name, package: null, version: null,
                }, outcomes: ["done"], outputSchema: null, timeoutSeconds: 3600 } });
            await db.catalog.createSession(childSessionId, { parentSessionId: workflowSessionId, owner: OWNER });
            const turn = makeRunTurnHarness({ owner: OWNER,
                catalogExtras: { workflowStore: () => db.store,
                    getSession: id => db.catalog.getSession(id),
                    getSessionCreationConfig: id => db.catalog.getSessionCreationConfig(id),
                    setActiveTurnIndex: (...args) => db.catalog.setActiveTurnIndex(...args) },
                managerExtras: { getOrCreate: vi.fn((...args) => manager.getOrCreate(...args)),
                    refreshModelProviders: () => manager.refreshModelProviders(),
                    normalizeModelRef: model => manager.normalizeModelRef(model) } });
            const result = await turn.runTurn(childSessionId, {
                prompt: "Inspect the fixture.", config: {
                    model: `fixture:${MODEL}`, workingDirectory: home, boundAgentName: AGENT.name, toolNames: [TOOL],
                },
                clientMessageIds: [workflowAgentClientMessageId(nodeExecutionId)],
            }, "runTurn");
            const [, config] = turn.sessionManager.getOrCreate.mock.calls[0];
            expect(config).toMatchObject({ workflowAgentChild: true, workflowToolLimit: [] });
            expect(config).not.toHaveProperty("workflowStartupRequiredTool");
            expect(result).toMatchObject({ type: "error", retryable: false, message: expect.stringContaining(TOOL) });
            expect(server.requests).toEqual([]);
            expect(tool.handler).not.toHaveBeenCalled();
            const completion = await db.store.completeAgentNode({ childSessionId, operationId: "startup-refused",
                call: { error: { code: "execution_failed", message: result.message } } });
            expect(completion).toMatchObject({ kind: "accepted", receipt: { stateId: "inspect", outcome: "execution_failed" } });
            expect(await db.store.readNodeExecution(nodeExecutionId)).toMatchObject({
                nodeId: "inspect", resultKind: "runtime_error", error: { message: expect.stringContaining(TOOL) },
            });
        } finally {
            await manager.shutdown();
            await server.close();
            await db.stop();
            rmSync(home, { recursive: true, force: true });
        }
    });
});
