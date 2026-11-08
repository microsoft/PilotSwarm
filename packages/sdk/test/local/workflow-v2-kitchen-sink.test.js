/**
 * Stage 2.4 (PR 235 e50d2b74, ported to the V2 runner): one synthetic Workflow, end to end on real workers (PostgreSQL,
 * duroxide, the Copilot CLI) with a scripted model as the chat. The chat saves it with workflow_definition and starts
 * it; the run covers, with no model in the Workflow:
 * - script states with the chat's delegated tools (store_fact, then read_facts in a later step);
 * - a loop longer than one controller execution holds (WORKFLOW_V2_ADMISSIONS_PER_EXECUTION), so the run continues as
 *   new at least once, and every state still runs exactly as often as the graph says;
 * - a script that exits non-zero, routed as execution_failed with its exit code and stderr; a script past its timeout,
 *   routed as timed_out; a wait state; a terminal output built from what the steps carried;
 * - each tool call's window on the log (FU-25).
 * V2 scripts are Node only (PR 235's Python and PowerShell states and its live canvas are v1's). No `.env` needed beyond
 * the local suite's.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { WORKFLOW_V2_ADMISSIONS_PER_EXECUTION } from "../../src/workflow/v2/runtime.ts";

const TIMEOUT = 300_000;
const OWNER = { provider: "test", subject: "workflow-v2-kitchen-sink" };
const PROMPT = "Save the kitchen-sink Workflow Definition and start it.";
const LOOPS = WORKFLOW_V2_ADMISSIONS_PER_EXECUTION + 3;

const YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: kitchen-sink, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [run, seed, loops]
    properties: { run: { type: string }, seed: { type: integer }, loops: { type: integer } }
initialInput: { run: "\${inputs.run}" }
initial: start
states:
  start:
    type: script
    source: |
      await callTool("store_fact", { key: "kitchen/" + context.inputs.run, value: { seed: context.inputs.seed } });
      await setResult("ready", { count: 0 });
    transition: { next: { ready: tick } }
  tick:
    type: script
    source: |
      const count = context.input.count + 1;
      await setResult(count < context.inputs.loops ? "again" : "done", { count });
    transition: { next: { again: tick, done: read } }
  read:
    type: script
    source: |
      const found = await callTool("read_facts", { key_pattern: "kitchen/" + context.inputs.run, scope: "session" });
      await setResult("ok", { seed: found.facts[0].value.seed, loops: context.input.count });
    transition: { next: { ok: boom } }
  boom:
    type: script
    source: |
      process.stderr.write("intentional failure\\n");
      process.exit(3);
    outcomes: [never]
    transition: { next: { never: wrong, execution_failed: recover } }
  recover:
    type: script
    input: "\${runtime.error}"
    source: |
      const error = context.input;
      const routed = error.code === "execution_failed" && error.details.exitCode === 3 && /intentional failure/.test(error.details.stderr);
      await setResult(routed ? "ok" : "bad", { recoveredFrom: error.details.exitCode });
    transition: { next: { ok: slow, bad: wrong } }
  slow:
    type: script
    timeoutSeconds: 1
    source: |
      await new Promise(() => setInterval(() => {}, 1000));
    outcomes: [never]
    transition: { next: { never: wrong, timed_out: pause } }
  pause:
    type: wait
    seconds: 1
    input: "\${runtime.error}"
    transition: { next: { elapsed: checked } }
  checked:
    type: script
    source: |
      const facts = await callTool("read_facts", { key_pattern: "kitchen/" + context.inputs.run, scope: "session" });
      await setResult(facts.count === 1 && context.input.code === "timed_out" ? "verified" : "missing",
        { facts: facts.count, timedOutAfter: context.input.details.timeoutSeconds });
    transition: { next: { verified: finished, missing: wrong } }
  finished: { type: terminal, outcome: succeeded, output: "\${input}" }
  wrong: { type: terminal, outcome: failed, output: "\${input}" }
`;

const getEnv = useSuiteEnv(import.meta.url);

async function until(check, label, timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

describe("a synthetic V2 Workflow end to end (stage 2.4: PR 235's kitchen sink on the V2 runner)", () => {
    it("runs delegated tools, a loop across continue-as-new, both failure routes, a wait, each state exactly as often as the graph says", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const run = `ks-${Math.random().toString(36).slice(2)}`;
        const respond = (_body, position) => {
            if (position.lastUserText.includes("type=ended")) return { content: "Noted." };
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            const previous = position.step >= 1 ? JSON.parse(position.toolResults[0] ?? "{}") : null;
            if (position.step >= 1 && !previous?.ok) return { content: `Stopping: ${position.toolResults[0]}` };
            if (position.step === 0) return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "kitchen-sink", yaml: YAML } }] };
            if (position.step === 1) {
                return { tools: [{ name: "workflow_definition", args: { operation: "start", definition_id: previous.definitionId,
                    inputs: { run, seed: 7, loops: LOOPS } } }] };
            }
            return { content: "Started it." };
        };
        await withScriptedModel(env, { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, model, qualifiedModel }) => {
            const mgmt = await createManagementClient(env);
            try {
                const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
                await chat.sendAndWait(PROMPT, TIMEOUT);
                const last = model.sessionRequests(PROMPT).find((record) => record.position.step === 2 && record.position.lastUserText.includes(PROMPT));
                expect(last, "the chat reached its last step").toBeTruthy();
                const results = last.body.messages.filter((message) => message.role === "tool")
                    .map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));
                const [saved, started] = results.map((text) => JSON.parse(text));
                expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
                expect(started, JSON.stringify(started)).toMatchObject({ ok: true, operation: "start", revision: 1 });

                const store = client._catalog.workflowStore();
                const ended = await until(async () => {
                    const row = await store.readRun(started.runId);
                    return row && ["completed", "failed", "cancelled"].includes(row.status) ? row : null;
                }, "the run to end");
                expect(ended.status, JSON.stringify({ error: ended.terminalError })).toBe("completed");
                expect(ended).toMatchObject({ terminalOutcome: "succeeded", terminalNodeId: "finished", terminalOutput: { facts: 1, timedOutAfter: 1 } });

                // The controller continued as new at least once.
                const executions = await client.duroxideClient.listExecutions(ended.controllerInstanceId);
                expect(executions.length, JSON.stringify(executions)).toBeGreaterThan(1);

                // Every state ran exactly as often as the graph says, across continue-as-new.
                const events = await mgmt.getSessionEvents(started.workflowId, 0, 2_000);
                const workflowEvents = events.filter((event) => event.eventType.startsWith("workflow."));
                const startedStates = workflowEvents.filter((event) => event.eventType === "workflow.state_started").map((event) => event.data.stateId);
                expect(startedStates).toEqual(["start", ...Array(LOOPS).fill("tick"), "read", "boom", "recover", "slow", "pause", "checked", "finished"]);
                expect(workflowEvents.filter((event) => event.eventType === "workflow.started")).toHaveLength(1);
                expect(workflowEvents.filter((event) => event.eventType === "workflow.completed")).toHaveLength(1);

                // Both failure routes were taken: execution_failed with its exit code and stderr, timed_out with its timeout.
                const failed = workflowEvents.filter((event) => event.eventType === "workflow.state_failed");
                expect(failed.map((event) => [event.data.stateId, event.data.outcome])).toEqual([["boom", "execution_failed"], ["slow", "timed_out"]]);
                const nodes = await store.listNodeExecutions(started.runId, 500);
                const recover = nodes.find((node) => node.nodeId === "recover");
                expect(recover).toMatchObject({ outcome: "ok", output: { recoveredFrom: 3 } });
                expect(nodes.find((node) => node.nodeId === "read")).toMatchObject({ output: { seed: 7, loops: LOOPS } });

                // FU-25: the three delegated calls' windows, in order, never overlapping.
                const windows = workflowEvents.filter((event) => event.eventType === "workflow.tool_call_ended").map((event) => event.data);
                expect(windows.map((data) => [data.stateId, data.tool, data.ok])).toEqual([["start", "store_fact", true], ["read", "read_facts", true],
                    ["checked", "read_facts", true]]);
                for (let index = 1; index < windows.length; index += 1) {
                    expect(Date.parse(windows[index].startedAt)).toBeGreaterThanOrEqual(Date.parse(windows[index - 1].endedAt));
                }
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});
