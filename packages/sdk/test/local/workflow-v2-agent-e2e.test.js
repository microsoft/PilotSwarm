/**
 * Workflow v2 from an agent: the full stack with a scripted model (real
 * workers, PostgreSQL, duroxide and the Copilot CLI). The parent drafts a v2
 * workflow (nothing runs), publishes the exact reviewed hash and starts it;
 * the scripts use the parent's delegated tools; the result wakes the parent.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-v2-owner" };
const PROMPT = "Draft the v2 fact pipeline, then publish and run it.";

const YAML = `
apiVersion: pilotswarm.dev/v2-draft
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
      const key = "v2-e2e/" + context.input.run;
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

describe("workflow v2 driven by an agent", () => {
    it("drafts without running, publishes the reviewed hash, runs with delegated tools and wakes the parent once", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const respond = (_body, position) => {
            if (position.lastUserText.includes("A child workflow ended")) return { content: "Noted the workflow result." };
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            const parse = (text) => {
                try { return JSON.parse(text ?? "{}"); }
                catch { return null; }
            };
            const previous = position.step >= 1 ? parse(position.toolResults[0]) : null;
            if (position.step >= 1 && !previous?.ok) return { content: `Stopping: unexpected tool result ${position.toolResults[0]}` };
            const draft = previous;
            if (position.step === 0) {
                return { tools: [{ name: "spawn_workflow", args: { yaml: YAML, key: "v2-e2e" } }] };
            }
            if (position.step === 1) {
                return { tools: [{ name: "update_workflow", args: {
                    workflow_id: draft.workflowId, operation: "publish_and_start", expected_revision: draft.revision,
                    definition_hash: draft.definitionHash, inputs: { run: "first" }, operation_id: "go-1",
                } }] };
            }
            if (position.step === 2) {
                const started = previous;
                return { tools: [{ name: "update_workflow", args: {
                    workflow_id: started.workflowId, operation: "publish_and_start", expected_revision: 1,
                    definition_hash: started.definitionHash, inputs: { run: "first" }, operation_id: "go-1",
                } }] };
            }
            return { content: "Published and started the workflow." };
        };
        await withScriptedModel(env, { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, model, qualifiedModel }) => {
            const mgmt = await createManagementClient(env);
            try {
                const parent = await client.createSession({ model: qualifiedModel, owner: OWNER });
                await parent.sendAndWait(PROMPT, TIMEOUT);

                const last = model.sessionRequests(PROMPT).find((record) => record.position.step === 3 && record.position.lastUserText.includes(PROMPT));
                expect(last, "the parent reached its final step").toBeTruthy();
                const results = last.body.messages.filter((message) => message.role === "tool")
                    .map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));
                expect(results.length, JSON.stringify(results)).toBe(3);
                const [draft, started, repeated] = results.map((text) => JSON.parse(text));
                expect(draft).toMatchObject({ ok: true, state: "draft", revision: 1, valid: true, run: null });
                expect(started).toMatchObject({ ok: true, state: "published", publishedRevision: 1, replayed: false });
                expect(started.run.mode).toBe("live");
                expect(repeated).toMatchObject({ ok: true, replayed: true });
                expect(repeated.run.runId).toBe(started.run.runId);

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
                expect(run.terminalOutput).toEqual({ key: "v2-e2e/first", count: 1 });

                await until(() => model.sessionRequests(PROMPT)
                    .some((record) => record.position.lastUserText.includes("A child workflow ended")), "the parent wake", 60_000);
                const wakes = model.sessionRequests(PROMPT).filter((record) => record.position.step === 0
                    && record.position.lastUserText.includes("A child workflow ended"));
                expect(wakes).toHaveLength(1);
                expect(wakes[0].position.lastUserText).toContain(started.run.runId);
                const events = await mgmt.getSessionEvents(draft.workflowId);
                expect(events.filter((event) => event.eventType === "workflow.parent_notified")).toHaveLength(1);
                expect(events.filter((event) => event.eventType === "workflow.completed")).toHaveLength(1);
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});
