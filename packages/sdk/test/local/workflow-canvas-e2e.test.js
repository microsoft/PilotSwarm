/**
 * Workflow canvas writes end to end (design D3, D5, D6, D10; plan 2 task 5): a
 * parent agent with a scripted model (real worker, PostgreSQL, duroxide and
 * the Copilot CLI) saves and starts a Workflow.
 *
 * Its script state, through callTool and the parent's captured canvas tools:
 * draws on the parent's slot 7, ticks it twice back to back (the second tick
 * waits out the 100 ms limit instead of failing), writes a KV row with
 * ifMatch 0, repeats that write (it rejects with a message that starts with
 * CONFLICT), reads the row back, tries its own Workflow session (refused: a
 * Workflow has no canvas), and draws with no slot (slot 1). Its context
 * carries parentSessionId. Two parallel branches then tick slot 1 at once;
 * both ticks land.
 *
 * Then an agent state's child draws on slot 3 of "parent": the agent that
 * started the Workflow. Each draw lands on the parent, attributed to the
 * session that wrote it; nothing is drawn on the Workflow session.
 *
 * Run: npx vitest run test/local/workflow-canvas-e2e.test.js
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { systemText } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";

const TIMEOUT = 300_000;
const OWNER = { provider: "test", subject: "workflow-canvas-owner" };
const PROMPT = "Run the canvas workflow on my canvas.";
const CANVAS_EVENTS = ["session.canvas_updated", "session.canvas_data", "session.canvas_presented"];

const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: canvas-writer, version: "1.0.0" }
initial: paint
states:
  paint:
    type: script
    source: |
      const drawn = await callTool("draw_canvas", { session_id: "parent", slot: 7, html: "<!doctype html><p>x</p>" });
      await callTool("update_canvas", { session_id: "parent", slot: 7, data: { n: 1 } });
      await callTool("update_canvas", { session_id: "parent", slot: 7, patch: { n: 2 } });
      const put = { session_id: "parent", slot: 7, op: "put", key: "app/progress", value: { done: 1 }, ifMatch: 0 };
      const first = await callTool("canvas_kv", put);
      let conflict = null;
      try { await callTool("canvas_kv", put); } catch (error) { conflict = error.message; }
      const got = await callTool("canvas_kv", { session_id: "parent", slot: 7, op: "get", key: "app/progress" });
      let own = null;
      try { await callTool("draw_canvas", { session_id: context.workflowSessionId, slot: 7, html: "<!doctype html><p>own</p>" }); }
      catch (error) { own = error.message; }
      const plain = await callTool("draw_canvas", { session_id: "parent", html: "<!doctype html><p>default</p>" });
      await setResult("done", { drawn, first, conflict, got, own, plain, parent: context.parentSessionId });
    transition: { next: { done: race, failure: failed } }
  race:
    type: parallel
    timeoutSeconds: 120
    branches:
      left:
        initial: left_tick
        states:
          left_tick:
            type: script
            source: |
              await setResult("ticked", await callTool("update_canvas", { session_id: "parent", patch: { [context.branch.name]: true } }));
            transition: { next: { ticked: left_done, failure: left_failed } }
          left_done: { type: terminal, outcome: succeeded, output: "\${input}" }
          left_failed: { type: terminal, outcome: failed, output: "\${input}" }
      right:
        initial: right_tick
        states:
          right_tick:
            type: script
            source: |
              await setResult("ticked", await callTool("update_canvas", { session_id: "parent", patch: { [context.branch.name]: true } }));
            transition: { next: { ticked: right_done, failure: right_failed } }
          right_done: { type: terminal, outcome: succeeded, output: "\${input}" }
          right_failed: { type: terminal, outcome: failed, output: "\${input}" }
    transition: { next: { joined: mark, blocked: failed, timed_out: failed, failure: failed } }
  mark:
    type: agent
    invoke: { prompt: "Draw the step's mark on slot 3 of the agent that started this Workflow, then finish." }
    outcomes: [marked]
    timeoutSeconds: 180
    transition: { next: { marked: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

const getEnv = useSuiteEnv(import.meta.url);

async function until(check, label, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

describe("Workflow canvas writes", () => {
    it("a script and an agent step draw, tick and write KV on the parent agent's canvases; nothing lands on the Workflow", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        let started = null;
        const step = { tools: null, draw: null };
        const respond = (body, position) => {
            const tools = (body.tools ?? []).map((tool) => tool?.function?.name);
            if (tools.includes("complete_workflow_node")) {
                // The agent state's child: draw on the parent's slot 3, then complete the state.
                const execution = [...`${position.lastUserText}\n${systemText(body)}`.matchAll(/nx-[a-f0-9]+/g)].at(-1)?.[0];
                if (position.step === 0) {
                    step.tools = tools;
                    return { tools: [{ name: "draw_canvas", args: { session_id: "parent", slot: 3, html: "<!doctype html><p>s</p>" } }] };
                }
                if (position.step === 1) {
                    step.draw = position.toolResults.at(-1);
                    return { tools: [{ name: "complete_workflow_node", args: {
                        ...(execution ? { node_execution_id: execution } : {}), operation_id: "mark-1", outcome: "marked", output: null,
                    } }] };
                }
                return { content: "STATE_COMPLETED" };
            }
            if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
            if (position.step === 0) return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "canvas-writer", yaml: YAML } }] };
            if (position.step === 1) {
                return { tools: [{ name: "workflow_definition", args: { operation: "start", name: "canvas-writer", notify_on_completion: false } }] };
            }
            if (position.step === 2 && !started) started = JSON.parse(position.toolResults[0]);
            return { content: "Started the canvas workflow." };
        };
        await withScriptedModel(env, { respond, worker: { workflowScripts: { enabled: true } } }, async ({ client, qualifiedModel }) => {
            const mgmt = await createManagementClient(env);
            try {
                const parent = await client.createSession({ model: qualifiedModel, owner: OWNER });
                await turnWorkflowsOn(client._catalog, parent.sessionId);
                await parent.sendAndWait(PROMPT, TIMEOUT);
                expect(started, JSON.stringify(started)).toMatchObject({ ok: true, operation: "start" });
                const workflowId = started.workflowId;

                const store = client._catalog.workflowStore();
                const child = await until(async () => {
                    const row = await mgmt.getSession(workflowId);
                    return row && ["completed", "failed", "cancelled"].includes(row.status) ? row : null;
                }, "workflow end");
                const run = await store.readRun(started.runId);
                const nodes = await store.listNodeExecutions(started.runId);
                const toolCalls = (await mgmt.getSessionEvents(workflowId, 0, 500, ["workflow.tool_call_ended"])).map((event) => event.data);
                const evidence = JSON.stringify({ status: child.status, outcome: run.terminalOutcome, error: run.terminalError,
                    output: run.terminalOutput, nodes: nodes.map((node) => ({ id: node.nodeId, outcome: node.outcome, error: node.error })),
                    toolCalls, step });
                expect(child.parentSessionId).toBe(parent.sessionId);
                expect(run.terminalOutcome, evidence).toBe("succeeded");

                // The script's results.
                const paint = nodes.find((node) => node.nodeId === "paint");
                const out = paint.output;
                expect(out.drawn, evidence).toMatchObject({ drawn: true, slot: 7 });
                expect(out.first, evidence).toMatchObject({ ok: true, key: "app/progress" });
                expect(typeof out.conflict, evidence).toBe("string");
                expect(out.conflict.startsWith("CONFLICT"), evidence).toBe(true);
                expect(out.got, evidence).toMatchObject({ found: true, key: "app/progress", v: { done: 1 } });
                // D5: the KV row's writer is the Workflow, as an agent principal.
                expect(out.got.by, evidence).toMatchObject({ kind: "agent", id: `agent:${workflowId}` });
                expect(out.own, evidence).toContain("is a Workflow, and a Workflow has no canvas");
                expect(out.own, evidence).toContain(workflowId.slice(0, 8));
                expect(out.plain, evidence).toMatchObject({ drawn: true, slot: 1 });
                expect(out.parent).toBe(parent.sessionId);

                // The agent step's child drew slot 3 of "parent".
                expect(step.tools, evidence).toContain("draw_canvas");
                expect(String(step.draw), evidence).toContain('"drawn":true');

                const events = await client._catalog.getSessionEvents(parent.sessionId, 0, 1000, CANVAS_EVENTS);
                const draws = events.filter((event) => event.eventType === "session.canvas_updated");
                const drawsIn = (slot) => draws.filter((event) => (event.data?.slot ?? 1) === slot);
                expect(drawsIn(7).map((event) => event.data.by), JSON.stringify(draws)).toEqual([workflowId]);
                expect(drawsIn(1).map((event) => event.data.by), JSON.stringify(draws)).toEqual([workflowId]);
                const marks = drawsIn(3);
                expect(marks, JSON.stringify(draws)).toHaveLength(1);
                const stepSessionId = marks[0].data.by;
                expect(stepSessionId).not.toBe(workflowId);
                expect(stepSessionId).not.toBe(parent.sessionId);
                const stepRow = await client._catalog.getSession(stepSessionId);
                expect(stepRow).toMatchObject({ parentSessionId: workflowId, sessionKind: "agent" });

                // Both ticks landed, in order, written by the Workflow; the latest data is the merged { n: 2 }.
                const ticks = events.filter((event) => event.eventType === "session.canvas_data" && event.data?.slot === 7);
                expect(ticks.map((event) => event.data.payload), JSON.stringify(ticks)).toEqual([{ n: 1 }, { n: 2 }]);
                expect(ticks.map((event) => event.data.by)).toEqual([workflowId, workflowId]);
                const latest = ticks.reduce((a, b) => (Number(b.data.dataRev) > Number(a.data.dataRev) ? b : a));
                expect(latest.data.payload).toEqual({ n: 2 });

                // Review focus 3: two parallel branches tick slot 1 (no slot given) at once. A script tick waits out the
                // 100 ms limit instead of failing, so both land, one after the other, merged.
                for (const id of ["left_tick", "right_tick"]) {
                    expect(nodes.find((node) => node.nodeId === id)?.output, `${id} ${evidence}`).toMatchObject({ updated: true, mode: "patch" });
                }
                const branchTicks = events.filter((event) => event.eventType === "session.canvas_data" && event.data?.slot === 1);
                expect(branchTicks.map((event) => event.data.by), JSON.stringify(branchTicks)).toEqual([workflowId, workflowId]);
                expect(branchTicks.map((event) => event.data.dataRev)).toEqual([1, 2]);
                expect(branchTicks[1].data.payload).toEqual({ left: true, right: true });

                // Nothing was drawn, ticked or shown on the Workflow session itself.
                expect(await client._catalog.getSessionEvents(workflowId, 0, 1000, CANVAS_EVENTS)).toEqual([]);
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});
