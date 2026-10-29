/**
 * Script workflow sessions end to end: a real worker and client on
 * PostgreSQL (CMS, facts and duroxide), real script processes, and the
 * worker's own tool set. No LLM is needed: the workflow runs no model.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, withClient } from "../helpers/local-workers.js";

const getEnv = useSuiteEnv(import.meta.url);
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const WORKFLOW = `
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata:
  name: remember-and-check
spec:
  entry: remember
  nodes:
    remember:
      type: script
      runtime: ${hasPython ? "python" : "node"}
      source: |
${hasPython
        ? `        key = "e2e/" + context["inputs"]["run"]
        call_tool("store_fact", {"key": key, "value": {"n": 2}})
        set_result("success", {"key": key})`
        : `        const key = "e2e/" + context.inputs.run;
        await callTool("store_fact", { key, value: { n: 2 } });
        await setResult("success", { key });`}
      next:
        success: check
    check:
      type: script
      runtime: node
      source: |
        const found = await callTool("read_facts", { key_pattern: context.input.key, scope: "session" });
        await setResult(found.count > 0 ? "found" : "missing", { count: found.count, value: found.facts?.[0]?.value ?? null });
      next:
        found: null
        missing: null
`;

async function waitForTerminal(mgmt, sessionId, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    let view = null;
    while (Date.now() < deadline) {
        view = await mgmt.getSession(sessionId);
        if (view && ["completed", "failed"].includes(view.status)) return view;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`workflow ${sessionId} did not finish; last status ${view?.status}`);
}

describe("script workflow sessions (worker + client + PostgreSQL)", () => {
    it("runs the graph durably, gives scripts the session's tools, and records an execution log", async () => {
        const env = getEnv();
        await withClient(env, { worker: { scriptWorkflows: { enabled: true } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                await expect(client.createScriptWorkflowSession({ yaml: WORKFLOW.replace("type: script", "type: agent") }))
                    .rejects.toMatchObject({ code: "WORKFLOW_INVALID" });

                const { sessionId, workflowName } = await client.createScriptWorkflowSession({
                    yaml: WORKFLOW,
                    inputs: { run: "first" },
                });
                expect(workflowName).toBe("remember-and-check");

                const view = await waitForTerminal(mgmt, sessionId);
                expect(view.status).toBe("completed");
                expect(view.sessionKind).toBe("workflow");
                expect(view.title).toBe("Workflow: remember-and-check");

                const listed = (await mgmt.listSessions()).find((session) => session.sessionId === sessionId);
                expect(listed?.sessionKind).toBe("workflow");

                const events = await mgmt.getSessionEvents(sessionId);
                const workflowEvents = events.filter((event) => event.eventType.startsWith("workflow."));
                expect(workflowEvents.map((event) => `${event.eventType}${event.data?.nodeId ? `:${event.data.nodeId}` : ""}`)).toEqual([
                    "workflow.started",
                    "workflow.node_started:remember", "workflow.node_completed:remember",
                    "workflow.node_started:check", "workflow.node_completed:check",
                    "workflow.completed",
                ]);
                const done = workflowEvents.at(-1).data;
                expect(done).toMatchObject({ name: "remember-and-check", steps: 2, outcome: "found", terminalNodeId: "check" });
                expect(JSON.parse(done.outputPreview)).toEqual({ count: 1, value: { n: 2 } });
                const remember = workflowEvents.find((event) => event.eventType === "workflow.node_completed" && event.data.nodeId === "remember");
                expect(remember.data.toolCalls).toEqual([expect.objectContaining({ name: "store_fact", ok: true })]);

                // A workflow session is not a conversation.
                await expect(mgmt.sendMessage(sessionId, "hello")).rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await expect(client.resumeSession(sessionId)).rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await expect(mgmt.steerSessionTurn(sessionId, { text: "go faster", requestId: "steer-1" }))
                    .rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await expect(mgmt.regenerateSession(sessionId)).rejects.toMatchObject({ code: "REGENERATE_UNSUPPORTED" });
                expect(await mgmt.stopSessionTurn(sessionId)).toMatchObject({ outcome: "no_active_turn" });

                // Creating with the same id again returns it without a second run.
                const again = await client.createScriptWorkflowSession({ sessionId, yaml: WORKFLOW, inputs: { run: "first" } });
                expect(again.sessionId).toBe(sessionId);
                const after = await mgmt.getSessionEvents(sessionId);
                expect(after.filter((event) => event.eventType === "workflow.started")).toHaveLength(1);
            } finally {
                await mgmt.stop?.();
            }
        });
    });

    it("fails the workflow with a clear reason when the worker has script workflows off", async () => {
        const env = getEnv();
        await withClient(env, { worker: { scriptWorkflows: { enabled: false } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const { sessionId } = await client.createScriptWorkflowSession({ yaml: WORKFLOW, inputs: { run: "off" } });
                const view = await waitForTerminal(mgmt, sessionId);
                expect(view.status).toBe("failed");
                const events = await mgmt.getSessionEvents(sessionId);
                const failed = events.find((event) => event.eventType === "workflow.failed");
                expect(failed.data.error).toMatch(/Script workflows are disabled on this worker/);
                expect(events.some((event) => event.eventType === "workflow.node_started")).toBe(false);
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});
