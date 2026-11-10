/**
 * Workflow from an agent: the full stack with a scripted model (real
 * workers, PostgreSQL, duroxide and the Copilot CLI). The parent drafts a
 * workflow (nothing runs), publishes the exact reviewed hash and starts it;
 * the scripts use the parent's delegated tools; the result wakes the parent.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";

const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-owner" };
const PROMPT = "Draft the fact pipeline, then publish and run it.";

const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: fact-pipeline, version: "1.0.0" }
inputs:
  schema: { type: object, required: [run], properties: { run: { type: string } } }
initialInput: { run: "\${inputs.run}" }
initial: remember
states:
  remember:
    type: script
    source: |
      const key = "wf-e2e/" + context.input.run;
      await callTool("store_fact", { key, value: { run: context.input.run } });
      await setResult("stored", { key });
    transition: { next: { stored: check, failure: broken } }
  check:
    type: script
    source: |
      const found = await callTool("read_facts", { key_pattern: context.input.key, scope: "session" });
      await setResult(found.count > 0 ? "found" : "missing", { key: context.input.key, count: found.count });
    transition: { next: { found: done, missing: broken, failure: broken } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  broken: { type: terminal, outcome: blocked, output: "\${input}" }
`;

const getEnv = useSuiteEnv(import.meta.url);

async function until(check, label, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

describe("workflow driven by an agent", () => {
    // Stage 2.1: workflow_definition saves revision 1 of the chat's definition, starts it, and reads it back with the Workflow
    // it started (a chat with Workflows on; on demand, owner 2026-11-08T16:55Z).
    it("saves without running, starts the saved revision, runs with delegated tools and wakes the parent once", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const respond = (_body, position) => {
            if (position.lastUserText.includes("type=ended")) return { content: "Noted the workflow result." };
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            const parse = (text) => {
                try { return JSON.parse(text ?? "{}"); }
                catch { return null; }
            };
            const previous = position.step >= 1 ? parse(position.toolResults[0]) : null;
            if (position.step >= 1 && !previous?.ok) return { content: `Stopping: unexpected tool result ${position.toolResults[0]}` };
            if (position.step === 0) {
                return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "fact-pipeline", yaml: YAML } }] };
            }
            if (position.step === 1) {
                return { tools: [{ name: "workflow_definition", args: { operation: "start", definition_id: previous.definitionId, inputs: { run: "first" } } }] };
            }
            if (position.step === 2) {
                return { tools: [{ name: "workflow_definition", args: { operation: "read", name: "fact-pipeline" } }] };
            }
            return { content: "Saved and started the workflow." };
        };
        await withScriptedModel(env, { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, model, qualifiedModel }) => {
            const mgmt = await createManagementClient(env);
            try {
                const parent = await client.createSession({ model: qualifiedModel, owner: OWNER });
                await turnWorkflowsOn(client._catalog, parent.sessionId);
                await parent.sendAndWait(PROMPT, TIMEOUT);

                const last = model.sessionRequests(PROMPT).find((record) => record.position.step === 3 && record.position.lastUserText.includes(PROMPT));
                expect(last, "the parent reached its final step").toBeTruthy();
                const results = last.body.messages.filter((message) => message.role === "tool")
                    .map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));
                expect(results.length, JSON.stringify(results)).toBe(3);
                const [saved, started, read] = results.map((text) => JSON.parse(text));
                expect(saved).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
                expect(saved.workflowId, "a save starts nothing").toBeUndefined();
                expect(started).toMatchObject({ ok: true, operation: "start", revision: 1, replayed: false, definitionId: saved.definitionId });
                expect(read).toMatchObject({ ok: true, definitionId: saved.definitionId, currentRevision: 1,
                    workflows: [expect.objectContaining({ workflowId: started.workflowId, revision: 1 })] });
                const draft = { workflowId: started.workflowId };
                started.run = { runId: started.runId };

                const store = client._catalog.workflowStore();
                const child = await until(async () => {
                    const row = await mgmt.getSession(draft.workflowId);
                    return row && ["completed", "failed", "cancelled"].includes(row.status) ? row : null;
                }, "workflow completion");
                expect(child.parentSessionId).toBe(parent.sessionId);
                const run = await store.readRun(started.run.runId);
                const orchestration = await client.duroxideClient.getStatus(run.controllerInstanceId);
                expect(run.status, JSON.stringify({ error: run.terminalError, orchestration })).toBe("completed");
                expect(run.terminalOutcome).toBe("succeeded");
                expect(run.terminalOutput).toEqual({ key: "wf-e2e/first", count: 1 });

                await until(() => model.sessionRequests(PROMPT)
                    .some((record) => record.position.lastUserText.includes("type=ended")), "the parent wake", 60_000);
                const wakes = model.sessionRequests(PROMPT).filter((record) => record.position.step === 0
                    && record.position.lastUserText.includes("type=ended"));
                expect(wakes).toHaveLength(1);
                expect(wakes[0].position.lastUserText).toContain(started.run.runId);
                const events = await mgmt.getSessionEvents(draft.workflowId);
                expect(events.filter((event) => event.eventType === "workflow.parent_notified")).toHaveLength(1);
                expect(events.filter((event) => event.eventType === "workflow.completed")).toHaveLength(1);
                // FU-25 (stage 2.4): each delegated tool call's window on the shared tool session is on the log, in order:
                // started, then ended with its duration; two calls never overlap.
                const windows = events.filter((event) => event.eventType === "workflow.tool_call_ended").map((event) => event.data);
                expect(windows.map((data) => data.tool)).toEqual(["store_fact", "read_facts"]);
                expect(events.filter((event) => event.eventType === "workflow.tool_call_started").map((event) => event.data.tool))
                    .toEqual(["store_fact", "read_facts"]);
                for (const data of windows) {
                    expect(data).toMatchObject({ ok: true, runId: started.run.runId });
                    expect(Date.parse(data.endedAt) - Date.parse(data.startedAt)).toBe(data.durationMs);
                }
                expect(Date.parse(windows[1].startedAt)).toBeGreaterThanOrEqual(Date.parse(windows[0].endedAt));
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});
