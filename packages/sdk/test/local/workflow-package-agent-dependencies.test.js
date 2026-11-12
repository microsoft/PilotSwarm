import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { createWorkflowAgentNodeHost } from "../../src/workflow/agent-host.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";
import { runScriptNode } from "../../src/workflow/runner.ts";
import { workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { resolveWorkflowCapabilitySnapshot } from "../../src/workflow/package-pins.ts";
import { workflowToolGrant } from "../../src/workflow/tool-policy.ts";
import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { bootstrapTurnOptions, resolveAgentDefinitionForCaller } from "../../src/session-proxy.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TOOL = "fb020_fixture_lookup";
const OWN_TOOL = "fb020_agent_owned_lookup";
const SIBLING_TOOL = "fb032_sibling_lookup";
const OWNER = { provider: "test", subject: "fb020-fixture-owner", email: null, displayName: null };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: package-agent-repro, version: "1.0.0" }
initial: script
states:
  script:
    type: script
    source: |
      const value = await callTool("${TOOL}", {});
      await setResult("done", value);
    transition: { next: { done: plain, failure: failed } }
  plain:
    type: agent
    invoke: { prompt: "Read the stand-in tool." }
    tools: [${TOOL}]
    timeoutSeconds: 30
    transition: { next: { done: named, failure: failed } }
  named:
    type: agent
    invoke: { agent: { name: fixture_agent, package: fixture-agents } }
    tools: [${TOOL}, ${OWN_TOOL}]
    timeoutSeconds: 30
    transition: { next: { done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

describe("FB-020: new Workflow agent steps receive captured parent selections", () => {
    const exercise = async ({ requireParentTool = false, states = ["plain", "named"], lifecycle = null, sibling = false } = {}) => {
        const h = await openWorkflowStore(getEnv());
        const dir = mkdtempSync(join(tmpdir(), "ps-fb020-"));
        const packageTool = {
            name: TOOL, description: "Return harmless stand-in data.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: vi.fn(async () => ({ marker: "fb020-fixture-only" })),
        };
        const source = {
            id: "fb020-fixture-package", name: "fixture-tools", source: "published",
            revision: "fixture-revision-1", scope: "user", owner: OWNER, packageId: "fb020-fixture-package",
            artifacts: [{ kind: "tool", name: TOOL, description: packageTool.description }],
            tools: new Map([[TOOL, packageTool]]), mcpServers: {},
        };
        const capturedSource = { ...source };
        const siblingSource = { ...source, id: "fb032-sibling-package", packageId: "fb032-sibling-package",
            name: "fixture-sibling", tools: new Map([[SIBLING_TOOL, {
                ...packageTool, name: SIBLING_TOOL, handler: vi.fn(async () => "sibling-remains"),
            }]]) };
        let packageDeleted = false;
        const pinnedCatalog = {
            listAgentPackages: async () => [...(packageDeleted ? [] : [source]), ...(sibling ? [siblingSource] : [])]
                .map(item => ({ packageId: item.id, name: item.name, scope: "user", owner: OWNER,
                    active: { semver: item.revision === capturedSource.revision ? "1.0.0" : "1.1.0" } })),
            getAgentPackage: async name => ({
                packageId: name === siblingSource.name ? siblingSource.id : source.id,
                name, enabled: true, scope: "user", owner: OWNER,
                versions: [{ semver: "1.0.0", sha256: capturedSource.revision }],
            }),
        };
        const agentTool = {
            name: OWN_TOOL, description: "Return the named agent's own harmless data.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: vi.fn(async () => ({ marker: "fb020-agent-owned" })),
        };
        const lookup = {
            fixture_agent: {
                prompt: "Fixture agent.", kind: "app-agent", toolNames: [OWN_TOOL],
                packageId: "fb020-fixture-agents", packageScope: "user", packageOwner: OWNER,
                initialRequiredTool: OWN_TOOL,
            },
        };
        const manager = new SessionManager(undefined, null, {
            frameworkBasePrompt: "Fixture base.", nativeSubagents: "off",
            getCapabilitySources: () => [source, ...(sibling ? [siblingSource] : [])],
            getWorkflowCapabilitySnapshot: (binding, retained, load) => resolveWorkflowCapabilitySnapshot(
                binding, retained, pinnedCatalog, [source, ...(sibling ? [siblingSource] : [])],
                load ? async id => id === siblingSource.id ? siblingSource : capturedSource : undefined),
            agentPromptLookup: lookup,
        }, dir);
        manager.setToolRegistry(new Map([[OWN_TOOL, agentTool], [TOOL, packageTool]]), {
            byPackage: new Map([
                ["fb020-fixture-agents", new Map([[OWN_TOOL, agentTool]])],
                [source.id, new Map([[TOOL, packageTool]])],
                [siblingSource.id, siblingSource.tools],
            ]),
            staticNames: new Set(),
        });

        manager.setSessionCatalog(h.catalog);
        manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
        const opened = new Map();
        // CLI and ordinary child dispatch are stand-ins; resolution, capability, grant, host and PostgreSQL paths are real.
        const open = config => {
            mkdirSync(join(dir, config.sessionId), { recursive: true });
            const handlers = new Map(config.tools.map(tool => [tool.name, tool]));
            const handle = {
                sessionId: config.sessionId, disconnect: vi.fn(async () => {}), abort: vi.fn(async () => {}),
                registerTools: tools => tools.forEach(tool => handlers.set(tool.name, tool)),
                rpc: {
                    tasks: { list: async () => ({ tasks: [] }) },
                    tools: {
                        initializeAndValidate: async () => {},
                        getCurrentMetadata: async () => ({ tools: config.tools.map(tool => ({
                            name: tool.name, description: tool.description, input_schema: tool.parameters,
                        })) }),
                        execute: async call => {
                            const tool = handlers.get(call.name);
                            if (!tool?.handler) throw new Error(`Fixture CLI tool unavailable: ${call.name}`);
                            return tool.handler(call.arguments, { sessionId: config.sessionId, toolCallId: call.toolCallId });
                        },
                    },
                },
            };
            opened.set(config.sessionId, config);
            return handle;
        };
        manager.ensureClient = async () => ({
            createSession: async config => open(config),
            resumeSession: async (_id, config) => open(config),
            deleteSession: async () => {},
        });
        let executor;
        let delegatedHandler;
        try {
            const parentSessionId = randomUUID();
            await h.catalog.createSession(parentSessionId, { owner: OWNER, model: "gpt-test" });
            const first = await manager.getOrCreate(parentSessionId, { model: "gpt-test" }, { turnIndex: 0 });
            expect(opened.get(parentSessionId).tools.map(tool => tool.name)).not.toContain(TOOL);
            const sourceRef = capabilityRef(source.id, source.revision, "source");
            const selection = { source_ref: sourceRef, tools: [TOOL], expected_revision: 0, request_id: "fb020-parent-attach" };
            await expect(first.config.capabilityServices.use(selection)).resolves.toEqual({ changed: true, revision: 1 });
            if (sibling) await first.config.capabilityServices.use({
                source_ref: capabilityRef(siblingSource.id, siblingSource.revision, "source"),
                tools: [SIBLING_TOOL], expected_revision: 1, request_id: "fb032-sibling-attach",
            });
            await manager.getOrCreate(parentSessionId, { model: "gpt-test" }, { turnIndex: 1 });
            expect(opened.get(parentSessionId).tools.map(tool => tool.name)).toContain(TOOL);
            const binding = await manager.captureWorkflowToolBinding(parentSessionId);
            if (requireParentTool) binding.agentStepTools = "selections";
            else delete binding.agentStepTools;
            expect(binding.capabilities.selections[0]).toMatchObject({ sourceId: source.id, tools: [TOOL] });
            expect(binding.sourceRevisions).toHaveProperty(source.id, source.revision);
            expect(binding.tools.map(tool => tool.name)).toContain(TOOL);

            const ordinarySpawn = vi.fn(async (parent, config, task, _level, _system, _title, _agentId,
                _splash, _explicitTitle, requiredTool) => {
                expect(parent).toBe(parentSessionId);
                const id = randomUUID();
                await h.catalog.createSession(id, { parentSessionId: parent, owner: OWNER, model: config.model });
                await manager.getOrCreate(id, config, { turnIndex: 0 });
                expect(bootstrapTurnOptions(requiredTool)).toEqual({ bootstrap: true, requiredTool: OWN_TOOL });
                expect(task).toBe("Use the same named fixture outside a Workflow.");
                return id;
            });
            const ordinaryRuntime = {
                ctx: { traceInfo: vi.fn() },
                input: { sessionId: parentSessionId },
                options: { nestingLevel: 0 },
                state: { config: { model: "gpt-test" }, subAgents: [], pendingPrompt: "" },
                manager: {
                    resolveAgentConfig: (name, caller) => {
                        expect(caller).toBe(parentSessionId);
                        return resolveAgentDefinitionForCaller({
                            agentName: name,
                            userAgents: [{
                                name: "fixture_agent", prompt: "Fixture agent.", tools: [OWN_TOOL],
                                initialRequiredTool: OWN_TOOL, schemaVersion: 3,
                                packageId: "fb020-fixture-agents", packageScope: "user", packageOwner: OWNER,
                            }],
                            getCallerOwnerKey: async () => `${OWNER.provider}\u0001${OWNER.subject}`,
                        });
                    },
                    spawnChildSession: ordinarySpawn,
                    recordSessionEvent: (id, events) => h.catalog.recordEvents(id, events),
                },
            };
            const spawning = handleSubAgentAction(ordinaryRuntime, {
                type: "spawn_agent", agentName: "fixture_agent",
                task: "Use the same named fixture outside a Workflow.",
            });
            let action = spawning.next();
            while (!action.done) action = spawning.next(await action.value);
            expect(action.value).toBe(true);
            expect(ordinarySpawn).toHaveBeenCalledOnce();
            expect(ordinaryRuntime.state.subAgents).toHaveLength(1);
            const ordinaryId = ordinaryRuntime.state.subAgents[0].sessionId;
            const ordinary = manager.sessions.get(ordinaryId);
            expect((await h.catalog.getSessionCapabilities(ordinaryId)).selections).toEqual([]);
            expect(opened.get(ordinaryId).tools.map(tool => tool.name)).not.toContain(TOOL);
            await expect(ordinary.config.tools.find(tool => tool.name === OWN_TOOL).handler({}, {}))
                .resolves.toEqual({ marker: "fb020-agent-owned" });

            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            await h.catalog.createWorkflowSession(workflowSessionId, {
                parentSessionId, owner: OWNER, creationConfig: { workflowToolBinding: binding },
            });
            const yaml = sibling ? YAML.replace(`tools: [${TOOL}]`, `tools: [${TOOL}, ${SIBLING_TOOL}]`) : YAML;
            const compiled = compileWorkflow(yaml);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            await h.store.createDefinition({
                workflowSessionId, parentSessionId, notifyParent: false, yaml, compiled,
                actor: { kind: "system", name: "fb020-repro" }, operationId: "create", requestSha256: "fb020-repro",
                publish: true, title: "FB-020 fixture",
                start: {
                    runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null,
                },
            });
            const originalDefinition = lookup.fixture_agent;
            lookup.fixture_agent = { ...originalDefinition, toolNames: [OWN_TOOL, TOOL] };
            for (const parent of [null, workflowSessionId]) {
                const invalidId = randomUUID();
                await h.catalog.createSession(invalidId, { owner: OWNER, ...(parent ? { parentSessionId: parent } : {}) });
                await expect(manager.getOrCreate(invalidId, {
                    model: "gpt-test", boundAgentName: "fixture_agent", boundAgentPackageId: "fb020-fixture-agents",
                    toolNames: [OWN_TOOL, TOOL], detachedPackageToolPolicy: "reject",
                    ...(parent ? { workflowAgentChild: true, workflowToolLimit: [OWN_TOOL, TOOL] } : {}),
                }, { turnIndex: 0 })).rejects.toMatchObject({
                    name: "PackageToolBindingError", code: "PACKAGE_TOOL_REQUIRES_BOUND_AGENT", toolName: TOOL,
                });
                expect(opened.has(invalidId)).toBe(false);
            }
            lookup.fixture_agent = originalDefinition;
            executor = await manager.openWorkflowToolExecutor(workflowSessionId, binding, 1);
            const script = compiled.ir.nodes.script;
            const result = await runScriptNode({
                sessionId: workflowSessionId,
                node: { id: script.id, source: script.source, timeoutSeconds: 30 },
                callTool: call => executor.call(call.name, call.arguments),
            });
            expect(result).toMatchObject({ outcome: "done", resultSource: "reported", output: { marker: "fb020-fixture-only" } });
            expect(packageTool.handler).toHaveBeenCalledOnce();

            const host = createWorkflowAgentNodeHost({
                getSession: id => h.catalog.getSession(id),
                resolveAgent: async () => ({
                    name: "fixture_agent", packageName: "fixture-agents", packageId: "fb020-fixture-agents", tools: [OWN_TOOL],
                }),
                createChild: async spec => {
                    await h.catalog.createSession(spec.sessionId, {
                        owner: spec.owner, parentSessionId: spec.parentSessionId, model: spec.model,
                    });
                    const limit = await h.store.readAgentToolLimit(spec.clientMessageId);
                    await manager.getOrCreate(spec.sessionId, {
                        model: "gpt-test", workflowAgentChild: true, workflowToolLimit: limit,
                        ...(spec.toolNames ? { toolNames: spec.toolNames } : {}),
                        ...(spec.boundAgentName ? { boundAgentName: spec.boundAgentName } : {}),
                        ...(spec.boundAgentPackageId ? { boundAgentPackageId: spec.boundAgentPackageId } : {}),
                    }, { turnIndex: 0, workflowAgentTools: {
                        workflowSessionId: spec.parentSessionId, nodeExecutionId: spec.clientMessageId,
                    } });
                },
            });
            for (const stateId of states) {
                const childSessionId = randomUUID();
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", stateId, 1);
                const task = stateId === "plain"
                    ? { source: "prompt", prompt: "Read the stand-in tool." }
                    : { source: "agent", name: "fixture_agent", package: "fixture-agents", version: null };
                const entry = await h.store.enterNode({
                    runId, nodeExecutionId, scopeId: "root", nodeId: stateId, ordinal: 1, nodeType: "agent",
                    predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
                    agent: { childSessionId, controllingSessionId: parentSessionId, task, outcomes: ["done"],
                        outputSchema: null, timeoutSeconds: 30 },
                });
                expect(entry).toMatchObject({ admitted: true, inserted: true });
                expect(await h.store.readAgentToolLimit(nodeExecutionId)).toEqual(stateId === "named"
                    ? [TOOL, OWN_TOOL] : sibling ? [TOOL, SIBLING_TOOL] : [TOOL]);
                expect(await host.spawn({
                    childSessionId, workflowSessionId, controllingSessionId: parentSessionId, runId, nodeExecutionId,
                    stateId, task, deadlineAt: new Date(Date.now() + 30_000).toISOString(),
                    prompt: "Fixture invocation.", clientMessageId: nodeExecutionId,
                })).toMatchObject({ spawned: true });
                const childConfig = opened.get(childSessionId);
                if (requireParentTool) {
                    const requested = childConfig.tools.find(tool => tool.name === TOOL);
                    delegatedHandler = requested?.handler;
                    expect(requested, `${stateId} step cannot call its requested parent-activated tool`).toBeDefined();
                    await expect(requested.handler({}, { sessionId: childSessionId, toolCallId: `fb020-${stateId}` }))
                        .resolves.toEqual({ marker: "fb020-fixture-only" });
                } else {
                    expect(childConfig.tools.map(tool => tool.name)).not.toContain(TOOL);
                    expect((await h.catalog.getSessionCapabilities(childSessionId)).selections).toEqual([]);
                }
                expect(childConfig.tools.map(tool => tool.name)).toContain("complete_workflow_node");
                const managed = manager.sessions.get(childSessionId);
                if (stateId === "named") {
                    const own = managed.config.tools.find(tool => tool.name === OWN_TOOL);
                    expect(own, "a named step retains its own declared package tool").toBeDefined();
                    await expect(own.handler({}, {})).resolves.toEqual({ marker: "fb020-agent-owned" });
                    await manager.dropWarmSession(childSessionId);
                    const resumed = await manager.getOrCreate(childSessionId, {
                        model: "gpt-test", workflowAgentChild: true, workflowToolLimit: [TOOL, OWN_TOOL],
                        boundAgentName: "fixture_agent", boundAgentPackageId: "fb020-fixture-agents", toolNames: [OWN_TOOL],
                    }, { turnIndex: 1, ...(requireParentTool ? {
                        workflowAgentTools: { workflowSessionId, nodeExecutionId },
                    } : {}) });
                    expect(opened.get(childSessionId).tools.map(tool => tool.name)).toContain(OWN_TOOL);
                    if (requireParentTool) {
                        expect(opened.get(childSessionId).tools.map(tool => tool.name)).toContain(TOOL);
                    } else {
                        expect(opened.get(childSessionId).tools.map(tool => tool.name)).not.toContain(TOOL);
                    }
                    await expect(resumed.config.tools.find(tool => tool.name === OWN_TOOL).handler({}, {}))
                        .resolves.toEqual({ marker: "fb020-agent-owned" });
                }
                await expect(managed.config.capabilityServices.use({
                    ...selection, request_id: `fb020-${stateId}-attach`,
                })).rejects.toThrow("Package activation is available only to the parent session");
                if (lifecycle) {
                    const handler = managed.config.tools.find(tool => tool.name === TOOL).handler;
                    if (lifecycle === "source republish") {
                        source.revision = "fixture-revision-2";
                        await expect(handler({}, {})).resolves.toEqual({ marker: "fb020-fixture-only" });
                    } else if (lifecycle === "package deleted") {
                        packageDeleted = true;
                        await expect(handler({}, {})).rejects.toThrow("that version was deleted.");
                    } else if (lifecycle === "parent end") {
                        await h.q("UPDATE SCHEMA.sessions SET state = 'completed' WHERE session_id = $1", [parentSessionId]);
                        await expect(handler({}, {})).rejects.toThrow("Workflow agent visit is no longer available.");
                    } else if (lifecycle === "stored binding removed") {
                        await h.q("UPDATE SCHEMA.sessions SET creation_config = creation_config #- '{workflowToolBinding,agentStepTools}' WHERE session_id = $1",
                            [workflowSessionId]);
                        await expect(handler({}, {})).rejects.toThrow("Workflow agent tool delegation is no longer available.");
                    } else {
                        const complete = JSON.parse(await completeWorkflowNodeFromTool({ node_execution_id: nodeExecutionId,
                            operation_id: "finish-visit", outcome: "done", output: null }, { callerSessionId: childSessionId, store: h.store }));
                        expect(complete.ok).toBe(true);
                        await expect(handler({}, {})).rejects.toThrow("Workflow agent visit is no longer available.");
                    }
                    await manager.dropWarmSession(childSessionId);
                    const reopened = await manager.getOrCreate(childSessionId, {
                        model: "gpt-test", workflowAgentChild: true,
                        workflowToolLimit: lifecycle === "source republish" || lifecycle === "package deleted"
                            ? sibling ? [TOOL, SIBLING_TOOL] : [TOOL] : [],
                    }, { turnIndex: 1, workflowAgentTools: { workflowSessionId, nodeExecutionId } });
                    if (lifecycle === "source republish") {
                        expect(reopened.config.tools.map(tool => tool.name)).toContain(TOOL);
                    } else {
                        expect(opened.get(childSessionId).tools.map(tool => tool.name)).not.toContain(TOOL);
                        expect(reopened.config.tools.map(tool => tool.name)).not.toContain(TOOL);
                    }
                    expect(opened.get(childSessionId).tools.map(tool => tool.name)).toContain("complete_workflow_node");
                    if (lifecycle === "package deleted") {
                        if (sibling) {
                            const kept = reopened.config.tools.find(tool => tool.name === SIBLING_TOOL);
                            expect(kept).toBeDefined();
                            await expect(kept.handler({}, {})).resolves.toBe("sibling-remains");
                        }
                        expect(await reopened.runTurn("Call the required tool.", { workflowRequiredTools: [TOOL] }))
                            .toMatchObject({ type: "error", retryable: false,
                                message: `Tool '${TOOL}' is not available. This Workflow is pinned to fixture-tools 1.0.0, and that version was deleted. Start a new Workflow to use a current version.` });
                        const finished = JSON.parse(await completeWorkflowNodeFromTool({ node_execution_id: nodeExecutionId,
                            operation_id: "finish-without-delegation", outcome: "done", output: null },
                        { callerSessionId: childSessionId, store: h.store }));
                        expect(finished.ok).toBe(true);
                    }
                }
            }
            expect(agentTool.handler).toHaveBeenCalledTimes(1 + (states.includes("named") ? 2 : 0));
            expect((await h.catalog.getSessionCapabilities(parentSessionId)).selections[0].tools).toEqual([TOOL]);
            await first.config.capabilityServices.use({
                ...selection, action: "remove", expected_revision: sibling ? 2 : 1, request_id: "fb020-remove",
            });
            if (lifecycle === "parent end") {
                await expect(executor.call(TOOL, {})).rejects.toThrow("Workflow parent authority is no longer available.");
            } else if (lifecycle === "package deleted") {
                await expect(executor.call(TOOL, {})).rejects.toThrow("that version was deleted.");
            } else {
                await expect(executor.call(TOOL, {})).resolves.toEqual({ marker: "fb020-fixture-only" });
            }
            if (requireParentTool && !lifecycle) {
                await expect(delegatedHandler({}, {}))
                    .resolves.toEqual({ marker: "fb020-fixture-only" });
            }
            expect(packageTool.handler).toHaveBeenCalledTimes(1 + (requireParentTool ? states.length : 0)
                + (lifecycle === "parent end" || lifecycle === "package deleted" ? 0 : 1)
                + (requireParentTool && !lifecycle ? 1 : 0) + (lifecycle === "source republish" ? 1 : 0));
        } finally {
            try {
                if (executor) await executor.close();
            } finally {
                try {
                    for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
                } finally {
                    await h.stop();
                    rmSync(dir, { recursive: true, force: true });
                }
            }
        }
    };

    it("keeps ordinary spawning separate and preserves a Workflow grant after parent unload on PostgreSQL",
        { timeout: 120_000 }, () => exercise());

    it.each(["plain", "named"])("%s agent can call its captured parent-activated tool",
        { timeout: 120_000 }, stateId => exercise({ requireParentTool: true, states: [stateId] }));

    it.each(["source republish", "package deleted", "parent end", "stored binding removed", "visit decided"])("preserves per-package authority after %s",
        { timeout: 120_000 }, lifecycle => exercise({ requireParentTool: true, states: ["plain"], lifecycle }));

    it("leaves sibling package tools on an agent turn and reports the missing required tool's exact cause",
        { timeout: 120_000 }, () => exercise({ requireParentTool: true, states: ["plain"], lifecycle: "package deleted", sibling: true }));
});
