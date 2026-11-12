import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import { workflowToolGrant } from "../../src/workflow/tool-policy.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "workflow-tool-requirements" };
const ACTOR = { kind: "system", name: "workflow-tool-requirements-test" };
const yaml = source => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: poller, version: "1.0.0" }
initial: poll
states:
  poll:
    type: script
    source: |
      ${source}
      await setResult("success", {});
    transition: { next: { success: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

describe("Workflow start tool preflight (FB-009 and FB-014)", () => {
    it("warns at Save/read, refuses before a claim, and starts once the literal tool is granted", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const dispatched = [];
            const host = { catalog: h.catalog, store: h.store, duroxideClient: {
                startOrchestrationVersioned: async id => { dispatched.push(id); },
                getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
            } };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            const binding = { policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER, config: {},
                capabilities: { revision: 0, selections: [] }, tools: [], sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" };
            const context = { callerSessionId: session, host, owner: OWNER, toolCallId: randomUUID(), binding: async () => binding };
            const save = JSON.parse(await workflowDefinitionFromTool({ operation: "save", name: "poller",
                yaml: yaml('await callTool("read_facts", {});') }, context));
            expect(save).toMatchObject({ ok: true, valid: true, errors: [], warnings: [{ code: "WORKFLOW_TOOL_NOT_GRANTED" }] });
            expect(save.warnings[0].message).toContain("read_facts");
            const read = JSON.parse(await workflowDefinitionFromTool({ operation: "read", name: "poller" }, context));
            expect(read.shown.warnings).toEqual(save.warnings);
            const start = async () => JSON.parse(await workflowDefinitionFromTool({ operation: "start", name: "poller" },
                { ...context, toolCallId: "start-once" }));
            const refused = await start();
            expect(refused).toMatchObject({ ok: false, error: { code: "WORKFLOW_TOOLS_UNAVAILABLE" } });
            expect(refused.error.message).toContain("read_facts");
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: save.definitionId })).toEqual([]);
            expect(dispatched).toEqual([]);
            const children = (await h.catalog.listSessions()).filter(row => row.parentSessionId === session && row.sessionKind === "workflow");
            expect(children).toEqual([]);
            binding.tools.push(workflowToolGrant({ name: "read_facts", input_schema: { type: "object" } }));
            const admitted = await start();
            expect(admitted).toMatchObject({ ok: true, replayed: false, revision: 1 });
            expect(dispatched).toHaveLength(1);
            const replay = await start();
            expect(replay).toMatchObject({ ok: true, replayed: true, workflowId: admitted.workflowId, runId: admitted.runId });
        } finally { await h.stop(); }
    });

    it("a canvas call refuses even an old grant, while dynamic names return a visible warning", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = { catalog: h.catalog, store: h.store, duroxideClient: {
                startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {},
            } };
            const session = randomUUID();
            await h.catalog.createSession(session, { owner: OWNER });
            const binding = { policy: "node-parent-tools-v1", parentSessionId: session, owner: OWNER, config: {},
                capabilities: { revision: 0, selections: [] }, tools: [workflowToolGrant({ name: "update_canvas", input_schema: {} })],
                sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fixture" };
            const save = source => saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "poller", yaml: yaml(source),
                expected: null, actor: { kind: "session", sessionId: session }, operationId: randomUUID(), by: "session" });
            const saved = await save('await callTool("update_canvas", { session_id: "parent", data: {} });');
            await expect(startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId: saved.receipt.definitionId },
                inputs: {}, actor: ACTOR, operationId: "canvas-start", owner: OWNER, binding })).rejects.toMatchObject({
                code: "WORKFLOW_TOOLS_UNAVAILABLE", message: expect.stringContaining("needs a live agent session"),
            });
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: saved.receipt.definitionId })).toEqual([]);
            const dynamic = await saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "poller", yaml: yaml("await callTool(context.inputs.tool, {});"),
                expected: { definitionId: saved.receipt.definitionId, revision: 1 }, actor: { kind: "session", sessionId: session },
                operationId: randomUUID(), by: "session" });
            const started = await startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId: dynamic.receipt.definitionId },
                inputs: { tool: "read_facts" }, actor: ACTOR, operationId: "dynamic-start", owner: OWNER, binding });
            expect(started.warnings).toMatchObject([{ code: "WORKFLOW_TOOLS_DYNAMIC" }]);
        } finally { await h.stop(); }
    });
});
