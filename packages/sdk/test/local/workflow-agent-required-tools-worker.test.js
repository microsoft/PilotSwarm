import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { systemText } from "../helpers/scripted-model.mjs";
import { useSuiteEnv } from "../helpers/local-env.js";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { resolveWorkflowCapabilitySnapshot } from "../../src/workflow/package-pins.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "required-tools-worker" };
const TOOL = "fixture_required_error";

describe("FB-020 required tools through the real worker and CLI", () => {
    it("counts an errored package call and exact delegated MCP call anew on both continued visits", { timeout: 180_000 }, async () => {
        const env = getEnv();
        const refusals = [];
        const traces = [];
        let visits = 0;
        await withScriptedModel(env, {
            worker: { logLevel: "warning", traceWriter: line => {
                traces.push(String(line));
                if (traces.length > 100) traces.shift();
            } },
            respond: (body, position) => {
                const tools = (body.tools ?? []).map(tool => tool.function?.name);
                if (!tools.includes("complete_workflow_node")) return { content: "ok" };
                expect(tools).toContain(TOOL);
                expect(tools).toContain("notes-read_note");
                const execution = [...`${position.lastUserText}\n${systemText(body)}`.matchAll(/nx-[a-f0-9]+/g)].at(-1)?.[0];
                expect(execution).toBeDefined();
                if (position.step === 0) {
                    visits++;
                    return { tools: [{ name: "complete_workflow_node", args: {
                        node_execution_id: execution, operation_id: `early-${execution}`, outcome: "done", output: null,
                    } }] };
                }
                if (position.step === 1) {
                    refusals.push(position.toolResults.at(-1));
                    return { tools: [{ name: TOOL, args: {} }, { name: "notes-read_note", args: {} }] };
                }
                if (position.step === 2) return { tools: [{ name: "complete_workflow_node", args: {
                    node_execution_id: execution, operation_id: `done-${execution}`, outcome: visits === 1 ? "again" : "done", output: null,
                } }] };
                return { content: "VISIT_COMPLETED" };
            },
        }, async ({ client, worker, qualifiedModel }) => {
            const manager = worker.sessionManager;
            const catalog = worker._catalog;
            const store = catalog.workflowStore();
            const source = {
                id: "required-worker-tools", name: "required-worker-tools", source: "published",
                revision: "fixture-one", scope: "user", owner: OWNER, packageId: "required-worker-tools",
                artifacts: [{ kind: "tool", name: TOOL }, { kind: "mcp", name: "notes" }],
                tools: new Map([[TOOL, {
                    name: TOOL, description: "Harmless required call that returns an error.",
                    parameters: { type: "object", properties: {}, additionalProperties: false },
                    handler: async () => { throw new Error("Expected harmless fixture failure."); },
                }]]),
                mcpServers: { notes: {
                    command: process.execPath,
                    args: [new URL("../helpers/native-task-mcp.mjs", import.meta.url).pathname, join(env.baseDir, "required-mcp-proof.txt")],
                    tools: ["read_note"],
                } },
            };
            manager.workerDefaults.getCapabilitySources = () => [source];
            const packageFixture = { packageId: source.id, name: source.name, scope: source.scope, owner: OWNER,
                enabled: true, active: { sha256: source.revision, semver: "1.0.0" } };
            manager.workerDefaults.getWorkflowCapabilitySnapshot = (binding, retained) =>
                resolveWorkflowCapabilitySnapshot(binding, retained, {
                    listAgentPackages: async () => [packageFixture],
                    getAgentPackage: async () => ({ ...packageFixture, versions: [packageFixture.active] }),
                }, [source]);
            const parent = await client.createSession({ owner: OWNER, model: qualifiedModel });
            expect(await parent.sendAndWait("Prepare the harmless fixture session.", 30_000)).toBe("ok");
            const managedParent = manager.sessions.get(parent.sessionId);
            expect(managedParent).toBeDefined();
            await managedParent.config.capabilityServices.use({
                source_ref: capabilityRef(source.id, source.revision, "source"), tools: [TOOL], mcp_servers: ["notes"],
                expected_revision: 0, request_id: "activate-required-fixture",
            });
            expect(await parent.sendAndWait("Refresh the activated fixture selections.", 30_000)).toBe("ok");
            const binding = await manager.captureWorkflowToolBinding(parent.sessionId);
            const mcp = binding.tools.find(tool => tool.mcpServerName === "notes");
            expect(mcp).toMatchObject({ name: "notes-read_note", namespacedName: "notes/read_note" });
            const workflowSessionId = randomUUID();
            const yaml = JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "required-worker", version: "1.0.0" },
                initial: "drain", states: {
                    drain: { type: "agent", invoke: { prompt: "Call the harmless required tools, then finish." },
                        requiredTools: [TOOL, "notes-read_note"], tools: [TOOL, "notes-read_note"],
                        timeoutSeconds: 120, outcomes: ["again", "done"],
                        transition: { next: { again: "pause", done: "done", failure: "failed" } } },
                    pause: { type: "wait", seconds: 1, transition: { next: { elapsed: "drain" } } },
                    done: { type: "terminal", outcome: "succeeded" }, failed: { type: "terminal", outcome: "failed" },
                },
            });
            const created = await createWorkflow({ catalog, store, duroxideClient: client._getDuroxideClient(),
                describeAgentTools: (...args) => manager.describeWorkflowAgentTools(...args) }, {
                workflowSessionId, parentSessionId: parent.sessionId, binding, yaml, publish: true,
                actor: { kind: "system", name: "required-worker" }, operationId: "create", notifyParent: false, start: { inputs: {} },
            });
            let ended;
            try {
                ended = await client._getDuroxideClient().waitForOrchestration(created.receipt.run.controllerInstanceId, 120_000);
            } catch (error) {
                console.info("FB020_WORKER_GATE_FAILURE", JSON.stringify({
                    run: await store.readRun(created.receipt.run.runId),
                    nodes: await store.listNodeExecutions(created.receipt.run.runId),
                    visits, refusals, traces,
                }).slice(0, 18_000));
                throw error;
            }
            expect(ended.status).toBe("Completed");
            const run = await store.readRun(created.receipt.run.runId);
            expect(run.terminalOutcome).toBe("succeeded");
            expect(visits).toBe(2);
            expect(refusals).toHaveLength(2);
            for (const refusal of refusals) expect(JSON.stringify(refusal)).toContain("REQUIRED_TOOLS_NOT_CALLED");
            const events = await catalog.getSessionEvents(workflowSessionId, 0, 500, ["workflow.agent_tool_called"]);
            for (const ordinal of [1, 2]) {
                const execution = nodeExecutionIdFor(run.runId, "root", "drain", ordinal);
                expect(events.filter(event => event.data.nodeExecutionId === execution).map(event => event.data.toolName).sort())
                    .toEqual([TOOL, "notes-read_note"].sort());
            }
        });
    });
});
