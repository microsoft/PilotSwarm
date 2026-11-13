import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { resolveWorkflowCapabilitySnapshot } from "../../src/workflow/package-pins.ts";
import { createWorkflow } from "../../src/workflow/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "composition-workflow-fixture" };
const names = ["pkg_tool_a", "pkg_tool_b"];

describe("Workflow composition through real worker child turns", () => {
    it.each([
        { name: "parent unload", grant: undefined, ceiling: ["pkg_tool_a"], expected: ["complete_workflow_node", "pkg_tool_a"], unload: true },
        { name: "grant none", grant: "none", ceiling: ["pkg_tool_a"], expected: ["complete_workflow_node"] },
        { name: "temporary registry", grant: undefined, ceiling: ["pkg_tool_a"], expected: ["complete_workflow_node", "pkg_tool_a"], registryFailure: true },
        { name: "deployment tool", grant: undefined, ceiling: ["pkg_tool_a", "dep_tool_x"],
            expected: ["complete_workflow_node", "dep_tool_x", "pkg_tool_a"] },
    ])("$name pins the Start selections and applies grant $grant with a real child ceiling", { timeout: 180_000 },
        async ({ grant, ceiling, expected, unload, registryFailure }) => {
            const env = getEnv();
            const offers = [];
            const calls = [];
            let registryAvailable = true;
            await withScriptedModel(env, {
                tools: [{ name: "dep_tool_x", description: "Harmless deployment fixture.",
                    parameters: { type: "object", properties: {}, additionalProperties: false },
                    handler: async () => { calls.push("dep_tool_x"); return "CALLED"; } }],
                respond: (body, position) => {
                    const offered = (body.tools ?? []).map(tool => tool.function.name).sort();
                    if (!offered.includes("complete_workflow_node")) return { content: "PARENT_READY" };
                    if (position.step === 0) {
                        offers.push(offered);
                        if (offered.includes("pkg_tool_a")) {
                            registryAvailable = !registryFailure;
                            return { tools: [{ name: "pkg_tool_a", args: {} },
                                ...(offered.includes("dep_tool_x") ? [{ name: "dep_tool_x", args: {} }] : [])] };
                        }
                    }
                    if (registryFailure && position.step === 1) {
                        expect(position.toolResults.join("\n")).toContain("pkg_tool_a");
                        expect(position.toolResults.join("\n")).toContain("registry");
                        registryAvailable = true;
                    }
                    const execution = [...position.lastUserText.matchAll(/nx-[a-f0-9]+/g)].at(-1)?.[0];
                    expect(execution).toBeDefined();
                    if (position.step === (offered.includes("pkg_tool_a") ? 1 : 0)) {
                        return { tools: [{ name: "complete_workflow_node", args: {
                            node_execution_id: execution, operation_id: `done-${execution}`, outcome: "done", output: null,
                        } }] };
                    }
                    return { content: "WORKFLOW_DONE" };
                },
                worker: { logLevel: "warning" },
            }, async ({ client, worker, qualifiedModel }) => {
                const manager = worker.sessionManager;
                const deploymentSources = manager.workerDefaults.getCapabilitySources();
                const catalog = worker._catalog;
                const store = catalog.workflowStore();
                const source = {
                    id: "composition-source", name: "composition-source", source: "published", revision: "one",
                    scope: "user", owner: OWNER, packageId: "composition-source",
                    artifacts: names.map(name => ({ kind: "tool", name })),
                    tools: new Map(names.map(name => [name, {
                        name, description: `Harmless ${name}.`,
                        parameters: { type: "object", properties: {}, additionalProperties: false },
                        handler: async () => { calls.push(name); return "CALLED"; },
                    }])),
                    mcpServers: {},
                };
                const late = { ...source, id: "late-source", name: "late-source", packageId: "late-source", tools: new Map([
                    ["pkg_tool_late", { ...source.tools.get("pkg_tool_a"), name: "pkg_tool_late" }],
                ]), artifacts: [{ kind: "tool", name: "pkg_tool_late" }] };
                let sources = [source];
                manager.workerDefaults.getCapabilitySources = () => [...deploymentSources, ...sources];
                const packageOf = item => ({ packageId: item.id, name: item.name, scope: item.scope, owner: OWNER,
                    enabled: true, active: { sha256: item.revision, semver: "1.0.0" } });
                manager.workerDefaults.getWorkflowCapabilitySnapshot = (binding, retained) =>
                    resolveWorkflowCapabilitySnapshot(binding, retained, {
                        listAgentPackages: async () => {
                            if (!registryAvailable) throw new Error("Synthetic registry outage.");
                            return sources.map(packageOf);
                        },
                        getAgentPackage: async id => {
                            const item = sources.find(candidate => candidate.id === id);
                            return item ? { ...packageOf(item), versions: [packageOf(item).active] } : null;
                        },
                    }, [...deploymentSources, ...sources]);
                const parent = await client.createSession({ owner: OWNER, model: qualifiedModel, toolNames: ["dep_tool_x"] });
                expect(await parent.sendAndWait("Prepare the composition fixture.", 30_000)).toBe("PARENT_READY");
                const select = async (item, tools, revision, request) => {
                    await manager.sessions.get(parent.sessionId).config.capabilityServices.use({
                        source_ref: capabilityRef(item.id, item.revision, "source"), tools,
                        expected_revision: revision, request_id: request,
                    });
                    expect(await parent.sendAndWait("Refresh composition selections.", 30_000)).toBe("PARENT_READY");
                };
                await select(source, names, 0, "initial-selection");
                const binding = await manager.captureWorkflowToolBinding(parent.sessionId);
                expect(binding.tools.map(tool => tool.name)).toContain("dep_tool_x");
                const captured = JSON.stringify(binding);
                const yaml = JSON.stringify({
                    apiVersion: "pilotswarm.dev/v1", kind: "Workflow",
                    metadata: { name: "composition-worker", version: "1.0.0" }, initial: "gate",
                    states: {
                        gate: { type: "messaging", mode: "receive", contract: "Ready@1",
                            transition: { next: { received: "step", failure: "failed" } } },
                        step: { type: "agent", invoke: { prompt: "Call the offered harmless fixture, then finish." },
                            ...(grant === undefined ? {} : { grant }), tools: ceiling, outcomes: ["done"], timeoutSeconds: 120,
                            transition: { next: { done: "done", failure: "failed" } } },
                        done: { type: "terminal", outcome: "succeeded" }, failed: { type: "terminal", outcome: "failed" },
                    },
                    contracts: { "Ready@1": { schema: { type: "object" } } },
                });
                const created = await createWorkflow({
                    catalog, store, duroxideClient: client._getDuroxideClient(),
                    describeAgentTools: (...args) => manager.describeWorkflowAgentTools(...args),
                }, {
                    workflowSessionId: randomUUID(), parentSessionId: parent.sessionId, binding, yaml, publish: true,
                    actor: { kind: "system", name: "composition-fixture" }, operationId: "create",
                    notifyParent: false, start: { inputs: {} },
                });
                sources = [source, late];
                await select(late, ["pkg_tool_late"], 1, "late-selection");
                if (unload) {
                    await manager.sessions.get(parent.sessionId).config.capabilityServices.use({
                        source_ref: capabilityRef(source.id, source.revision, "source"), action: "remove",
                        tools: names,
                        expected_revision: 2, request_id: "unload-original-selection",
                    });
                    expect(await parent.sendAndWait("Refresh after unloading the original package.", 30_000)).toBe("PARENT_READY");
                }
                const { sendTypedWorkflowInput } = await import("../../src/workflow/service.ts");
                await sendTypedWorkflowInput({ catalog, store, duroxideClient: client._getDuroxideClient() }, {
                    workflowSessionId: created.receipt.workflowSessionId, runId: created.receipt.run.runId,
                    senderSessionId: parent.sessionId, contract: "Ready@1", payload: {}, operationId: "ready",
                });
                const ended = await client._getDuroxideClient().waitForOrchestration(created.receipt.run.controllerInstanceId, 120_000);
                expect(ended.status).toBe("Completed");
                expect((await store.readRun(created.receipt.run.runId)).terminalOutcome).toBe("succeeded");
                expect(offers).toEqual([expected]);
                expect(calls.sort()).toEqual(grant === "none" || registryFailure ? []
                    : ["pkg_tool_a", ...(ceiling.includes("dep_tool_x") ? ["dep_tool_x"] : [])].sort());
                expect(JSON.stringify(binding)).toBe(captured);
                const stored = (await catalog.getSessionCreationConfig(created.receipt.workflowSessionId)).workflowToolBinding;
                expect(stored.sourceRevisions[source.id]).toBe(source.revision);
                expect(stored.sourceRevisions).not.toHaveProperty(late.id);
                expect(stored.agentStepBindings.step.tools.map(tool => tool.name)).not.toContain("pkg_tool_late");
            });
        });
});
