/**
 * Workflow sessions end to end: a real worker and client on
 * PostgreSQL (CMS, facts and duroxide), real script processes, and the
 * worker's own tool set. No LLM is needed: the workflow runs no model.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, withClient } from "../helpers/local-workers.js";

const getEnv = useSuiteEnv(import.meta.url);
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const WORKFLOW = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: remember-and-check
  version: 1.0.0
inputs:
  run: { type: string, required: true }
initial: remember
states:
  remember:
    type: script
    runtime: ${hasPython ? "python" : "node"}
    source: |
${hasPython
        ? `      key = "e2e/" + context["inputs"]["run"]
      call_tool("store_fact", {"key": key, "value": {"n": 2}})
      set_result("success", {"key": key})`
        : `      const key = "e2e/" + context.inputs.run;
      await callTool("store_fact", { key, value: { n: 2 } });
      await setResult("success", { key });`}
    completion: { outcomes: [success] }
    transition: { next: { success: check } }
  check:
    type: script
    runtime: node
    source: |
      const found = await callTool("read_facts", { key_pattern: context.input.key, scope: "session" });
      await setResult(found.count > 0 ? "found" : "missing", { count: found.count, value: found.facts?.[0]?.value ?? null });
    completion: { outcomes: [found, missing] }
    transition: { next: { found: remembered, missing: lost } }
  remembered:
    type: terminal
    outcome: succeeded
    summary: The fact was stored and read back.
    output: \${states.check.result}
  lost: { type: terminal, outcome: failed, summary: The fact was not found. }
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
        await withClient(env, { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                await expect(client.createWorkflowSession({ yaml: WORKFLOW.replace("type: script", "type: agent") }))
                    .rejects.toMatchObject({ code: "WORKFLOW_INVALID" });

                const { sessionId, workflowName } = await client.createWorkflowSession({
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
                expect(workflowEvents.map((event) => `${event.eventType}${event.data?.stateId ? `:${event.data.stateId}` : ""}`)).toEqual([
                    "workflow.started",
                    "workflow.state_started:remember", "workflow.state_completed:remember",
                    "workflow.state_started:check", "workflow.state_completed:check",
                    "workflow.completed:remembered",
                ]);
                const done = workflowEvents.at(-1).data;
                expect(done).toMatchObject({ name: "remember-and-check", steps: 2, outcome: "succeeded", stateId: "remembered", summary: "The fact was stored and read back." });
                expect(JSON.parse(done.outputPreview)).toEqual({ count: 1, value: { n: 2 } });
                const remember = workflowEvents.find((event) => event.eventType === "workflow.state_completed" && event.data.stateId === "remember");
                expect(remember.data.toolCalls).toEqual([expect.objectContaining({ name: "store_fact", ok: true })]);

                // The live execution canvas was drawn once and updated per step.
                const canvasEvents = await mgmt.getSessionEvents(sessionId, 0, 200, ["session.canvas_updated", "session.canvas_data"]);
                const draws = canvasEvents.filter((e) => e.eventType === "session.canvas_updated");
                const ticks = canvasEvents.filter((e) => e.eventType === "session.canvas_data");
                expect(draws).toHaveLength(1);
                expect(draws[0].data).toMatchObject({ rev: 1, slot: 1, name: "Workflow" });
                expect(ticks.length).toBe(2 * 2 + 1);
                expect(ticks.at(-1).data.payload).toMatchObject({ status: "completed", outcome: "succeeded", current: "remembered", step: 2 });

                // A workflow session is not a conversation.
                await expect(mgmt.sendMessage(sessionId, "hello")).rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await expect(client.resumeSession(sessionId)).rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await expect(mgmt.steerSessionTurn(sessionId, { text: "go faster", requestId: "steer-1" }))
                    .rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await expect(mgmt.regenerateSession(sessionId)).rejects.toMatchObject({ code: "REGENERATE_UNSUPPORTED" });
                expect(await mgmt.stopSessionTurn(sessionId)).toMatchObject({ outcome: "no_active_turn" });

                // Creating with the same id again returns it without a second run.
                const again = await client.createWorkflowSession({ sessionId, yaml: WORKFLOW, inputs: { run: "first" } });
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
        await withClient(env, { worker: { workflowScripts: { enabled: false } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const { sessionId } = await client.createWorkflowSession({ yaml: WORKFLOW, inputs: { run: "off" } });
                const view = await waitForTerminal(mgmt, sessionId);
                expect(view.status).toBe("failed");
                const events = await mgmt.getSessionEvents(sessionId);
                const failed = events.find((event) => event.eventType === "workflow.failed");
                expect(failed.data.error).toMatch(/Workflow scripts are disabled on this worker/);
                expect(events.some((event) => event.eventType === "workflow.state_started")).toBe(false);
            } finally {
                await mgmt.stop?.();
            }
        });
    });

    it("cancel and delete from the management API stop a running script", async () => {
        const env = getEnv();
        const LONG = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: long, version: "1" }
initial: wait
states:
  wait:
    type: script
    runtime: node
    timeoutSeconds: 600
    source: |
      await new Promise(() => setInterval(() => {}, 1000));
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded }
`;
        await withClient(env, { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const waitForEvent = async (sessionId, type) => {
                    const deadline = Date.now() + 30_000;
                    while (Date.now() < deadline) {
                        const events = await mgmt.getSessionEvents(sessionId, 0, 200, [type]);
                        if (events.length) return events;
                        await new Promise((r) => setTimeout(r, 200));
                    }
                    throw new Error(`no ${type} on ${sessionId}`);
                };

                const first = await client.createWorkflowSession({ yaml: LONG });
                await waitForEvent(first.sessionId, "workflow.state_started");
                const started = Date.now();
                await mgmt.cancelSession(first.sessionId, "no longer needed");
                const cancelled = await mgmt.getSession(first.sessionId);
                expect(cancelled.status).toBe("cancelled");
                await waitForEvent(first.sessionId, "workflow.state_cancelled");
                expect(Date.now() - started).toBeLessThan(20_000);
                const end = (await waitForEvent(first.sessionId, "workflow.cancelled"))[0];
                expect(end.data).toMatchObject({ reason: "no longer needed", steps: 1 });

                const second = await client.createWorkflowSession({ yaml: LONG });
                await waitForEvent(second.sessionId, "workflow.state_started");
                await mgmt.deleteSession(second.sessionId, "cleanup");
                expect(await mgmt.getSession(second.sessionId)).toBeNull();
            } finally {
                await mgmt.stop?.();
            }
        });
    });

    it("scripts reach the worker's default MCP servers and the session tools, as the workflow session", async () => {
        const env = getEnv();
        const calc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/workflow-mcp/calc-server.mjs");
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: tools-check, version: "1" }
initial: use
states:
  use:
    type: script
    runtime: node
    source: |
      const sum = await callTool("calc/add", { a: 20, b: 22 });
      const sessions = await callTool("list_sessions", { include_children: true });
      const events = await callTool("read_agent_events", { agent_id: context.sessionId, event_types: ["workflow.started"] });
      await setResult("success", { sum, kinds: sessions.sessions.filter((s) => s.self).map((s) => s.kind), events });
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded, output: \${states.use.result} }
`;
        await withClient(env, {
            worker: {
                workflowScripts: { enabled: true },
                mcpServers: { calc: { command: process.execPath, args: [calc], tools: ["add"] } },
            },
        }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const { sessionId } = await client.createWorkflowSession({ yaml });
                const view = await waitForTerminal(mgmt, sessionId);
                const done = (await mgmt.getSessionEvents(sessionId, 0, 200, ["workflow.completed", "workflow.failed"]))[0];
                expect(view.status, JSON.stringify(done?.data)).toBe("completed");
                const output = JSON.parse(done.data.outputPreview);
                expect(output.sum).toBe("42");
                expect(output.kinds).toEqual(["workflow"]);
                // The same rule an agent meets: the caller is the workflow session itself.
                expect(output.events.error).toMatch(/cannot read your own session events/);
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});

