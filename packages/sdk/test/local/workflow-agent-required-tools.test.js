import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { compileWorkflow, parseWorkflowIr } from "../../src/workflow/compiler.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";
import { workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { workflowAgentSelections } from "../../src/workflow/agent-tools.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const definition = extra => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: required-tool-fixture, version: "1.0.0" }
initial: drain
states:
  drain:
    type: agent
    invoke: { prompt: "Drain harmless fixture work." }
    requiredTools: [fixture_lookup, notes-read_note]
    ${extra}
    timeoutSeconds: 3600
    transition: { next: { done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const message = missing => "This step requires a call of each of these tools before it completes with an outcome: fixture_lookup, notes-read_note. "
    + `Not called in this cycle: ${missing.join(", ")}. Call it, then complete again with a new operation_id. `
    + "If a required tool is unavailable or keeps failing, complete with error execution_failed and say why.";

describe("FB-020 agent required-call contract", () => {
    it("validates distinct names and the ceiling, and retains them in IR version 1", () => {
        const valid = compileWorkflow(definition("tools: [fixture_lookup, notes-read_note]"));
        expect(valid.valid, JSON.stringify(valid.diagnostics)).toBe(true);
        expect(valid.ir.irVersion).toBe(1);
        expect(parseWorkflowIr(valid.ir).nodes.drain.requiredTools).toEqual(["fixture_lookup", "notes-read_note"]);
        for (const yaml of [
            definition("tools: none"), definition("tools: [fixture_lookup]"),
            definition("").replace("[fixture_lookup, notes-read_note]", "[]"),
            definition("").replace("[fixture_lookup, notes-read_note]", "[fixture_lookup, fixture_lookup]"),
            definition("").replace("[fixture_lookup, notes-read_note]", "[bad name]"),
            definition("").replace("[fixture_lookup, notes-read_note]", `[${Array.from({ length: 17 }, (_, i) => `tool_${i}`).join(", ")}]`),
        ]) expect(compileWorkflow(yaml).valid, yaml).toBe(false);
    });

    it("drops only colliding or forbidden exports, respects the ceiling and uses the step agent's MCP allowlist identity", () => {
        const selection = { sourceId: "fixture-source", sourceRef: "fixture-exact-ref",
            tools: ["collision", "lookup", "wait", "update_canvas"], mcpServers: ["allowed", "denied"] };
        const binding = { capabilities: { revision: 1, selections: [selection] }, tools: [
            ...selection.tools.map(name => ({ name, schemaHash: "fixture" })),
            ...selection.mcpServers.map(name => ({ name: "read_note", namespacedName: `${name}-read_note`,
                mcpServerName: name, mcpToolName: "read_note", schemaHash: "fixture" })),
        ] };
        const source = { id: "fixture-source", tools: new Map(), mcpServers: {
            allowed: { allowedAgents: ["fixture-agents:step_agent"] }, denied: { allowedAgents: ["fixture-agents:another_agent"] },
        } };
        const agent = { name: "step_agent", namespace: "fixture-agents", packageId: "fixture-agents", packageScope: "shared" };
        expect(workflowAgentSelections(binding, [source], [{ name: "collision" }], {}, agent)).toEqual([
            { ...selection, tools: ["lookup"], mcpServers: ["allowed"] },
        ]);
        expect(workflowAgentSelections(binding, [source], [{ name: "collision" }], {}, agent, ["lookup"])).toEqual([
            { ...selection, tools: ["lookup"], mcpServers: [] },
        ]);
        expect(workflowAgentSelections(binding, [source], [], {}, agent, [])).toEqual([]);
        expect(workflowAgentSelections(binding, [source], [], {}, null).flatMap(item => item.mcpServers)).toEqual([]);
    });

    const fixture = async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const parent = randomUUID(), workflowSessionId = randomUUID(), runId = randomUUID(), child = randomUUID();
            const owner = { provider: "test", subject: `required-tools-${randomUUID()}` };
            await h.catalog.createSession(parent, { owner });
            await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner });
            await h.catalog.createSession(child, { parentSessionId: workflowSessionId, owner });
            const yaml = definition("tools: [fixture_lookup, notes-read_note]");
            const compiled = compileWorkflow(yaml);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled,
                actor: { kind: "system", name: "required-tool-test" }, operationId: "create", requestSha256: "required-tool-test", publish: true,
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null },
            });
            const admit = async ordinal => {
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "drain", ordinal);
                const entered = await h.store.enterNode({
                    runId, nodeExecutionId, scopeId: "root", nodeId: "drain", ordinal, nodeType: "agent",
                    predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
                    agent: { childSessionId: child, controllingSessionId: parent, task: { source: "prompt", prompt: "Drain." },
                        outcomes: ["done"], outputSchema: null, timeoutSeconds: 3600 },
                });
                expect(entered.admitted).toBe(true);
                return nodeExecutionId;
            };
            const complete = async (nodeExecutionId, operation_id, result = { outcome: "done", output: null }) =>
                JSON.parse(await completeWorkflowNodeFromTool({ node_execution_id: nodeExecutionId, operation_id, ...result },
                    { callerSessionId: child, store: h.store }));
            const call = (nodeExecutionId, toolName, caller = child) =>
                h.store.recordAgentToolCall({ childSessionId: caller, nodeExecutionId, toolName });
            return { ...h, child, workflowSessionId, runId, admit, complete, call };
        } catch (error) { await h.stop(); throw error; }
    };

    it("refuses early outcomes, persists the refusal, and accepts after both exact calls in each visit", { timeout: 120_000 }, async () => {
        const h = await fixture();
        try {
            const visit = await h.admit(1);
            const first = await h.complete(visit, "early");
            expect(first).toMatchObject({ ok: false, replayed: false, error: {
                code: "REQUIRED_TOOLS_NOT_CALLED", message: message(["fixture_lookup", "notes-read_note"]), attemptsLeft: 2,
            } });
            expect(await h.complete(visit, "early")).toMatchObject({ ok: false, replayed: true, error: { code: "REQUIRED_TOOLS_NOT_CALLED" } });
            const grandchild = randomUUID();
            await h.catalog.createSession(grandchild, { parentSessionId: h.child });
            await h.call(visit, "fixture_lookup", grandchild);
            await h.call(visit, "notes/read_note");
            await h.call(visit, "fixture_lookup");
            expect(await h.complete(visit, "one-missing")).toMatchObject({ ok: false, error: {
                code: "REQUIRED_TOOLS_NOT_CALLED", message: message(["notes-read_note"]), attemptsLeft: 1,
            } });
            // Only the call's start is needed; no successful completion is recorded.
            await h.call(visit, "notes-read_note");
            expect(await h.complete(visit, "complete")).toMatchObject({ ok: true, outcome: "done" });
            const events = await h.catalog.getSessionEvents(h.workflowSessionId);
            expect(events.filter(event => event.eventType === "workflow.agent_tool_called" && event.data.nodeExecutionId === visit)
                .map(event => event.data.toolName)).toEqual(["fixture_lookup", "notes-read_note"]);
            const cycle2 = await h.admit(2);
            expect(await h.complete(cycle2, "new-cycle")).toMatchObject({ ok: false, error: {
                code: "REQUIRED_TOOLS_NOT_CALLED", message: message(["fixture_lookup", "notes-read_note"]),
            } });
            await h.call(visit, "fixture_lookup");
            expect(await h.complete(cycle2, "explicit-error", { error: { code: "execution_failed", message: "The fixture is unavailable." } }))
                .toMatchObject({ ok: true, kind: "error", outcome: "execution_failed" });
        } finally { await h.stop(); }
    });

    it("shares the three invalid-completion budget and preserves error-completion escape routes", { timeout: 120_000 }, async () => {
        const h = await fixture();
        try {
            const visit = await h.admit(1);
            expect(await h.complete(visit, "bad-shape", { outcome: "undeclared" })).toMatchObject({ ok: false, error: { code: "OUTPUT_INVALID" } });
            expect(await h.complete(visit, "missing-1")).toMatchObject({ ok: false, error: { code: "REQUIRED_TOOLS_NOT_CALLED", attemptsLeft: 1 } });
            expect(await h.complete(visit, "missing-2")).toMatchObject({ ok: false, error: {
                code: "OUTPUT_ATTEMPTS_EXHAUSTED", attemptsLeft: 0,
            }, state: { status: "completed", outcome: "invalid_output" } });
            const next = await h.admit(2);
            expect(await h.complete(next, "needs-input", { error: { code: "needs_input", message: "Need a decision." } }))
                .toMatchObject({ ok: true, outcome: "needs_input" });
        } finally { await h.stop(); }
    });
});
