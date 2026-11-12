import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { readWorkflowView } from "../../src/workflow/tools.ts";

const getEnv = useSuiteEnv(import.meta.url);
const yaml = (required = "fixture_lookup", tools = "fixture_lookup") => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: agent-tools-admission, version: "1.0.0" }
initial: drain
states:
  drain:
    type: agent
    invoke: { prompt: "Call the harmless fixture." }
    tools: [${tools}]
    requiredTools: [${required}]
    transition: { next: { done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

describe("FB-020 agent tools at admission", () => {
    it("warns at Save/read, refuses before claiming, and admits with one durable delegation audit on keyed replay", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const session = randomUUID();
            const owner = { provider: "test", subject: session };
            await h.catalog.createSession(session, { owner });
            const binding = { policy: "node-parent-tools-v1", parentSessionId: session, owner, config: {},
                capabilities: { revision: 1, selections: [{ sourceId: "fixture", tools: ["fixture_lookup"], mcpServers: [] }] },
                tools: [{ name: "fixture_lookup", schemaHash: "fixture" }], sourceRevisions: { fixture: "v1" },
                excludedTools: [], boundAgentFingerprint: "fixture" };
            const delegated = { state: "drain", agent: "inline prompt",
                sources: [{ package: "fixture", ownership: "other_shared", tools: ["fixture_lookup"], mcpServers: [], mcpTools: [] }] };
            const dispatched = [];
            const host = { catalog: h.catalog, store: h.store, duroxideClient: {
                startOrchestrationVersioned: async id => dispatched.push(id),
                getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
            }, describeAgentTools: async (node, grant) => ({
                offered: grant?.agentStepTools === "selections" ? ["fixture_lookup"] : [],
                delegated: grant?.agentStepTools === "selections" ? delegated : { ...delegated, sources: [] },
            }) };
            const saved = await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "agent-tools-admission",
                yaml: yaml(), expected: null, actor: { kind: "session", sessionId: session }, operationId: "save", by: "session",
                binding: async () => null });
            expect(saved.receipt.diagnostics).toMatchObject([{ code: "WORKFLOW_TOOL_NOT_GRANTED" }]);
            const read = await h.store.sessionDefinitions.readRevision(saved.receipt.definitionId, 1);
            expect(read.diagnostics).toEqual(saved.receipt.diagnostics);
            const start = grant => startSessionWorkflowDefinition(host, { ownerSessionId: session,
                definition: { definitionId: saved.receipt.definitionId }, inputs: {}, actor: { kind: "system", name: "fixture" },
                operationId: "start", key: "one-start", owner, binding: grant });
            await expect(start(null)).rejects.toMatchObject({ code: "WORKFLOW_TOOLS_UNAVAILABLE" });
            expect(dispatched).toEqual([]);
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: saved.receipt.definitionId })).toEqual([]);
            const started = await start(binding);
            expect(started).toMatchObject({ replayed: false, delegated: [delegated] });
            const config = await h.catalog.getSessionCreationConfig(started.workflowId);
            expect(config.workflowToolBinding.agentStepTools).toBe("selections");
            expect(await start(null)).toMatchObject({ replayed: true, delegated: [delegated] });
            expect(await readWorkflowView(h.store, started.workflowId)).toMatchObject({ delegated: [delegated] });
            const events = await h.catalog.getSessionEvents(started.workflowId);
            expect(events.filter(event => event.eventType === "workflow.tools_delegated")).toHaveLength(1);
        } finally { await h.stop(); }
    });

    it("accepts default requirements without a package grant but refuses a named startup tool outside its ceiling", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: { provider: "test", subject: session } });
            const host = { catalog: h.catalog, store: h.store, duroxideClient: {
                startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
            }, describeAgentTools: async node => ({ offered: ["read_facts"],
                ...(node.invoke.agent ? { initialRequiredTool: "startup_lookup" } : {}),
                delegated: { state: node.id, agent: "inline prompt", sources: [] } }),
            resolveAgent: async () => ({ name: "fixture_agent", tools: ["startup_lookup"], initialRequiredTool: "startup_lookup" }) };
            const save = text => saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "agent-tools-admission",
                yaml: text, expected: null, actor: { kind: "session", sessionId: session }, operationId: randomUUID(), by: "session" });
            const saved = await save(yaml("read_facts", "read_facts"));
            const start = definitionId => startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId },
                inputs: {}, actor: { kind: "system", name: "fixture" }, operationId: randomUUID(), binding: null });
            expect(await start(saved.receipt.definitionId)).toMatchObject({ replayed: false });
            const namedYaml = yaml("read_facts", "read_facts").replace('invoke: { prompt: "Call the harmless fixture." }',
                "invoke: { agent: { name: fixture_agent } }");
            const named = await save(namedYaml);
            await expect(start(named.receipt.definitionId)).rejects.toMatchObject({ code: "WORKFLOW_TOOLS_UNAVAILABLE",
                message: expect.stringContaining("startup_lookup") });
        } finally { await h.stop(); }
    });
});
