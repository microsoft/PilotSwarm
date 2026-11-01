/**
 * Workflow sessions end to end: a real worker and client on
 * PostgreSQL (CMS, facts and duroxide), real script processes, and the
 * worker's own tool set. No LLM is needed: the workflow runs no model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, withClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";

const getEnv = useSuiteEnv(import.meta.url);
const hasPython = spawnSync("python3", ["--version"]).status === 0;
// PS_TEST_PWSH points at a PowerShell that is not on PATH (a portable install).
const pwshExecutable = process.env.PS_TEST_PWSH || "pwsh";
const hasPwsh = spawnSync(pwshExecutable, ["-NoLogo", "-NoProfile", "-Command", "exit 0"]).status === 0;

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

/**
 * A workflow session is always the child of an agent session. The parent
 * here is a plain catalog row: these tests run no model, so it never takes
 * a turn.
 */
async function createParent(env, { owner = null, state = null } = {}) {
    const catalog = await createCatalog(env);
    try {
        const parentSessionId = crypto.randomUUID();
        await catalog.createSession(parentSessionId, owner ? { owner } : {});
        if (state) await catalog.updateSession(parentSessionId, { state });
        return parentSessionId;
    } finally {
        await catalog.close();
    }
}

/** Start a workflow under a new parent, without waking that parent at the end. */
async function startWorkflow(env, client, config) {
    const parentSessionId = config.parentSessionId ?? await createParent(env);
    return client.createWorkflowSession({ notifyParent: false, ...config, parentSessionId });
}

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
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                await expect(startWorkflow(env, client, { yaml: WORKFLOW.replace("type: script", "type: agent") }))
                    .rejects.toMatchObject({ code: "WORKFLOW_STATE_TYPE_UNSUPPORTED", status: 400 });

                const parentSessionId = await createParent(env);
                const { sessionId, workflowName } = await startWorkflow(env, client, {
                    yaml: WORKFLOW,
                    inputs: { run: "first" },
                    parentSessionId,
                });
                expect(workflowName).toBe("remember-and-check");

                const view = await waitForTerminal(mgmt, sessionId);
                expect(view.status).toBe("completed");
                expect(view.sessionKind).toBe("workflow");
                expect(view.title).toBe("Workflow: remember-and-check");
                expect(view.parentSessionId).toBe(parentSessionId);

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
                const again = await startWorkflow(env, client, { sessionId, yaml: WORKFLOW, inputs: { run: "first" }, parentSessionId });
                expect(again.sessionId).toBe(sessionId);
                const after = await mgmt.getSessionEvents(sessionId);
                expect(after.filter((event) => event.eventType === "workflow.started")).toHaveLength(1);

                // After the session is deleted, the same id starts a new run instead of reviving a dead row.
                await mgmt.deleteSession(sessionId, "start over");
                expect(await mgmt.getSession(sessionId)).toBeNull();
                await startWorkflow(env, client, { sessionId, yaml: WORKFLOW, inputs: { run: "second" }, parentSessionId });
                const rerun = await waitForTerminal(mgmt, sessionId);
                expect(rerun.status).toBe("completed");
            } finally {
                await mgmt.stop?.();
            }
        });
    });

    it("fails the workflow with a clear reason when the worker has workflows off", async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflows: { stateTypes: [] } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const { sessionId } = await startWorkflow(env, client, { yaml: WORKFLOW, inputs: { run: "off" } });
                const view = await waitForTerminal(mgmt, sessionId);
                expect(view.status).toBe("failed");
                const events = await mgmt.getSessionEvents(sessionId);
                const failed = events.find((event) => event.eventType === "workflow.failed");
                expect(failed.data.error).toMatch(/Workflows are not enabled on this worker\. An operator enables them by listing the state types to run in PILOTSWARM_WORKFLOW_STATE_TYPES/);
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
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
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

                const first = await startWorkflow(env, client, { yaml: LONG });
                await waitForEvent(first.sessionId, "workflow.state_started");
                // Stop targets a turn; a workflow has none, so it answers at once and the run goes on.
                expect(await mgmt.stopSessionTurn(first.sessionId, { timeoutMs: 5_000 })).toEqual({
                    outcome: "no_active_turn",
                    detail: "workflow sessions have no turns; cancel the session to stop the run",
                });
                expect((await mgmt.getSession(first.sessionId)).status).toBe("running");
                // Anything but cancel, complete and delete is refused, so it cannot stop the script and run it again.
                await expect(mgmt.sendCommand(first.sessionId, { cmd: "set_model", id: "m-1", args: { model: "x" } }))
                    .rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await expect(mgmt.setSessionWorkspace(first.sessionId, { expectedRevision: 0, workspace: null }))
                    .rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                await mgmt.cancelPendingMessage(first.sessionId, ["client-1"]);
                await client.cancelPendingMessage(first.sessionId, ["client-2"]);
                await new Promise((r) => setTimeout(r, 1_500));
                expect(await mgmt.getSessionEvents(first.sessionId, 0, 200, ["workflow.state_cancelled", "workflow.state_started"]))
                    .toHaveLength(1);
                const started = Date.now();
                await mgmt.cancelSession(first.sessionId, "no longer needed");
                const cancelled = await mgmt.getSession(first.sessionId);
                expect(cancelled.status).toBe("cancelled");
                await waitForEvent(first.sessionId, "workflow.state_cancelled");
                expect(Date.now() - started).toBeLessThan(20_000);
                const end = (await waitForEvent(first.sessionId, "workflow.cancelled"))[0];
                expect(end.data).toMatchObject({ reason: "no longer needed", steps: 1 });

                const second = await startWorkflow(env, client, { yaml: LONG });
                await waitForEvent(second.sessionId, "workflow.state_started");
                await mgmt.deleteSession(second.sessionId, "cleanup");
                expect(await mgmt.getSession(second.sessionId)).toBeNull();

                // Deleting through the SDK client ends the run the same way: the script stops and the end is recorded.
                const third = await startWorkflow(env, client, { yaml: LONG });
                await waitForEvent(third.sessionId, "workflow.state_started");
                await client.deleteSession(third.sessionId);
                const thirdEnd = (await waitForEvent(third.sessionId, "workflow.cancelled"))[0];
                expect(thirdEnd.data).toMatchObject({ deleted: true });
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
      // Look itself up by id: other tests may have created more sessions than one page holds.
      const sessions = await callTool("list_sessions", { session_id: context.sessionId });
      const events = await callTool("read_agent_events", { agent_id: context.sessionId, event_types: ["workflow.started"] });
      await setResult("success", { sum, kinds: sessions.sessions.filter((s) => s.self).map((s) => s.kind), events });
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded, output: "\${states.use.result}" }
`;
        await withClient(env, {
            worker: {
                workflows: { stateTypes: ["script"] },
                mcpServers: { calc: { command: process.execPath, args: [calc], tools: ["add"] } },
            },
        }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const { sessionId } = await startWorkflow(env, client, { yaml });
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

    it("a synthetic workflow exercises every runtime, a loop across continue-as-new, both failure routes and tools", { timeout: 120_000 }, async () => {
        const LOOPS = 22; // more steps than one execution holds (20), so the run continues as new once
        const startRuntime = hasPython ? "python" : "node";
        const psRuntime = hasPwsh ? "powershell" : "node";
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: kitchen-sink, version: 1.0.0 }
inputs:
  run: { type: string, required: true }
  seed: { type: integer, required: true }
  loops: { type: integer, required: true }
configuration: { label: synthetic }
initial: start
states:
  start:
    type: script
    runtime: ${startRuntime}
    source: |
${hasPython
        ? `      call_tool("store_fact", {"key": "kitchen/" + context["inputs"]["run"], "value": {"seed": context["inputs"]["seed"]}})
      set_result("ready", {"count": 0, "runtime": "python"})`
        : `      await callTool("store_fact", { key: "kitchen/" + context.inputs.run, value: { seed: context.inputs.seed } });
      await setResult("ready", { count: 0, runtime: "node" });`}
    completion: { outcomes: [ready] }
    transition: { next: { ready: tick } }
  tick:
    type: script
    runtime: node
    source: |
      const count = context.input.count + 1;
      await setResult(count < context.inputs.loops ? "again" : "done", { count });
    completion: { outcomes: [again, done] }
    transition: { next: { again: tick, done: ps } }
  ps:
    type: script
    runtime: ${psRuntime}
    source: |
${hasPwsh
        ? `      $found = Invoke-PilotSwarmTool -Name 'read_facts' -Arguments @{ key_pattern = ('kitchen/' + $context.inputs.run); scope = 'session' }
      Set-PilotSwarmResult -Outcome 'ok' -Output @{ seed = $found.facts[0].value.seed; loops = $context.input.count; runtime = 'powershell' }`
        : `      const found = await callTool("read_facts", { key_pattern: "kitchen/" + context.inputs.run, scope: "session" });
      await setResult("ok", { seed: found.facts[0].value.seed, loops: context.input.count, runtime: "node" });`}
    completion: { outcomes: [ok] }
    transition: { next: { ok: boom } }
  boom:
    type: script
    runtime: node
    source: |
      process.stderr.write("intentional failure\\n");
      process.exit(3);
    completion: { outcomes: [success, failure] }
    transition: { next: { success: wrong, failure: recover } }
  recover:
    type: script
    runtime: node
    source: |
      const routed = context.input.exitCode === 3 && /intentional failure/.test(context.input.stderr);
      await setResult(routed ? "ok" : "bad", { recoveredFrom: context.input.exitCode });
    completion: { outcomes: [ok, bad] }
    transition: { next: { ok: slow, bad: wrong } }
  slow:
    type: script
    runtime: node
    timeoutSeconds: 1
    source: |
      await new Promise(() => setInterval(() => {}, 1000));
    completion: { outcomes: [success, timeout] }
    transition: { next: { success: wrong, timeout: checked } }
  checked:
    type: script
    runtime: node
    source: |
      const facts = await callTool("read_facts", { key_pattern: "kitchen/" + context.inputs.run, scope: "session" });
      const me = await callTool("list_sessions", { session_id: context.sessionId });
      const kind = me.sessions[0]?.kind ?? null;
      await setResult(facts.count === 1 && kind === "workflow" ? "verified" : "missing",
        { facts: facts.count, kind, timedOutAfter: context.input.timeoutSeconds });
    completion: { outcomes: [verified, missing] }
    transition: { next: { verified: finished, missing: wrong } }
  finished:
    type: terminal
    outcome: succeeded
    summary: Every runtime, the loop, both failure routes and the checks ran.
    output:
      label: \${configuration.label}
      loops: \${inputs.loops}
      start: \${states.start.result}
      lastTick: \${states.tick.result}
      ps: \${states.ps.result}
      recover: \${states.recover.result}
      checked: \${states.checked.result}
  wrong: { type: terminal, outcome: failed, summary: A route that should not be taken was taken. }
`;
        const env = getEnv();
        await withClient(env, {
            worker: { workflows: { stateTypes: ["script"], executables: { powershell: pwshExecutable } } },
        }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const run = `ks-${Math.random().toString(36).slice(2)}`;
                const { sessionId } = await startWorkflow(env, client, { yaml, inputs: { run, seed: 7, loops: LOOPS } });
                const view = await waitForTerminal(mgmt, sessionId);
                const events = await mgmt.getSessionEvents(sessionId, 0, 1_000);
                const workflowEvents = events.filter((event) => event.eventType.startsWith("workflow."));
                const end = workflowEvents.at(-1);
                expect(view.status, JSON.stringify(end?.data)).toBe("completed");

                const steps = 1 + LOOPS + 5;
                expect(end.eventType).toBe("workflow.completed");
                expect(end.data).toMatchObject({ outcome: "succeeded", stateId: "finished", steps,
                    summary: "Every runtime, the loop, both failure routes and the checks ran." });
                expect(JSON.parse(end.data.outputPreview)).toEqual({
                    label: "synthetic",
                    loops: LOOPS,
                    start: { count: 0, runtime: startRuntime },
                    lastTick: { count: LOOPS },
                    ps: { seed: 7, loops: LOOPS, runtime: psRuntime },
                    recover: { recoveredFrom: 3 },
                    checked: { facts: 1, kind: "workflow", timedOutAfter: 1 },
                });

                // The runtimes that ran are the ones declared (both non-Node ones where installed).
                const started = workflowEvents.find((event) => event.eventType === "workflow.started");
                expect(Object.fromEntries(started.data.states.filter((st) => st.type === "script").map((st) => [st.id, st.runtime])))
                    .toMatchObject({ start: startRuntime, ps: psRuntime, tick: "node" });

                // Every state ran exactly as often as the graph says, across continue-as-new: no state ran twice.
                const ran = workflowEvents.filter((event) => event.eventType === "workflow.state_started").map((event) => event.data.stateId);
                expect(ran).toEqual(["start", ...Array(LOOPS).fill("tick"), "ps", "boom", "recover", "slow", "checked"]);
                const completed = workflowEvents.filter((event) => event.eventType === "workflow.state_completed");
                expect(completed.map((event) => event.data.step)).toEqual(Array.from({ length: steps }, (_, i) => i + 1));
                expect(workflowEvents.filter((event) => event.eventType === "workflow.started")).toHaveLength(1);
                expect(workflowEvents.some((event) => ["workflow.state_failed", "workflow.state_cancelled"].includes(event.eventType))).toBe(false);

                // Both failure routes were taken as ordinary outcomes.
                const byState = (id) => completed.find((event) => event.data.stateId === id).data;
                expect(byState("boom")).toMatchObject({ outcome: "failure", resultSource: "exit", exitCode: 3 });
                expect(byState("boom").stderrTail).toMatch(/intentional failure/);
                expect(byState("slow")).toMatchObject({ outcome: "timeout", resultSource: "timeout" });
                expect(byState("start").toolCalls).toEqual([expect.objectContaining({ name: "store_fact", ok: true })]);
                expect(byState("ps").toolCalls).toEqual([expect.objectContaining({ name: "read_facts", ok: true })]);

                // The live canvas was drawn once and ended on the terminal state, through the continue-as-new.
                const canvas = await mgmt.getSessionEvents(sessionId, 0, 1_000, ["session.canvas_updated", "session.canvas_data"]);
                expect(canvas.filter((event) => event.eventType === "session.canvas_updated")).toHaveLength(1);
                expect(canvas.filter((event) => event.eventType === "session.canvas_data").at(-1).data.payload)
                    .toMatchObject({ status: "completed", outcome: "succeeded", current: "finished", step: steps });
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});

describe("polling workflows with wait states (worker + client + PostgreSQL, no model)", () => {
    // Documents may declare waits of a second here; production's minimum is 60.
    let savedMinWait;
    beforeAll(() => {
        savedMinWait = process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS;
        process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS = "1";
    });
    afterAll(() => {
        if (savedMinWait === undefined) delete process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS;
        else process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS = savedMinWait;
    });

    const pollYaml = (foundAfter) => `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: poll-builds, version: 1.0.0 }
inputs:
  run: { type: string, required: true }
initial: check
states:
  check:
    type: script
    runtime: node
    source: |
      const key = "poll/" + context.inputs.run + "/checks";
      const prior = await callTool("read_facts", { key_pattern: key, scope: "session" });
      const n = (prior.facts?.[0]?.value?.n ?? 0) + 1;
      await callTool("store_fact", { key, value: { n } });
      await setResult(n >= ${foundAfter} ? "found" : "idle", { n });
    completion: { outcomes: [found, idle] }
    transition: { next: { found: handle, idle: sleep } }
  handle:
    type: script
    runtime: node
    source: |
      await callTool("store_fact", { key: "poll/" + context.inputs.run + "/handled", value: { afterChecks: context.input.n } });
      await setResult("done", { handledAfter: context.input.n });
    completion: { outcomes: [done] }
    transition: { next: { done: finished } }
  sleep:
    type: wait
    seconds: 1
    transition: { next: check }
  finished:
    type: terminal
    outcome: succeeded
    summary: Found work and handled it.
    output: "\${states.handle.result}"
`;

    it("checks, waits and checks again until it finds work, then handles it and ends", { timeout: 120_000 }, async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const run = `poll-${Math.random().toString(36).slice(2)}`;
                const { sessionId } = await startWorkflow(env, client, { yaml: pollYaml(3), inputs: { run } });
                const view = await waitForTerminal(mgmt, sessionId);
                const events = (await mgmt.getSessionEvents(sessionId, 0, 1_000)).filter((e) => e.eventType.startsWith("workflow."));
                const end = events.at(-1);
                expect(view.status, JSON.stringify(end?.data)).toBe("completed");
                expect(end.data).toMatchObject({ outcome: "succeeded", stateId: "finished", steps: 6, summary: "Found work and handled it." });
                expect(JSON.parse(end.data.outputPreview)).toEqual({ handledAfter: 3 });
                expect(events.filter((e) => /^workflow\.state_(started|waiting)$/.test(e.eventType)).map((e) => `${e.data.stateId}#${e.data.visit}`))
                    .toEqual(["check#1", "sleep#1", "check#2", "sleep#2", "check#3", "handle#1"]);
                const waits = events.filter((e) => e.eventType === "workflow.state_waiting");
                const checkStarts = events.filter((e) => e.eventType === "workflow.state_started" && e.data.stateId === "check");
                // Each check after a wait started no earlier than that wait's end.
                for (let i = 0; i < waits.length; i += 1) {
                    expect(new Date(checkStarts[i + 1].createdAt).getTime()).toBeGreaterThanOrEqual(waits[i].data.until - 50);
                }
                const canvas = await mgmt.getSessionEvents(sessionId, 0, 1_000, ["session.canvas_data"]);
                expect(canvas.at(-1).data.payload).toMatchObject({ status: "completed", current: "finished", nodes: { check: { runs: 3 }, sleep: { runs: 2, state: "done" } } });
            } finally {
                await mgmt.stop?.();
            }
        });
    });

    it("a loop with no terminal state runs until cancelled, and cancel stops it while it waits", { timeout: 120_000 }, async () => {
        const env = getEnv();
        const yaml = pollYaml(1_000_000).replace(/  handle:[\s\S]*?transition: \{ next: \{ done: finished \} \}\n/, "")
            .replace("found: handle, idle: sleep", "found: sleep, idle: sleep")
            .replace(/  finished:[\s\S]*$/, "")
            .replace("seconds: 1", "seconds: 2");
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const { sessionId } = await startWorkflow(env, client, { yaml, inputs: { run: `forever-${Math.random().toString(36).slice(2)}` } });
                const deadline = Date.now() + 60_000;
                let waits = [];
                while (Date.now() < deadline) {
                    waits = await mgmt.getSessionEvents(sessionId, 0, 100, ["workflow.state_waiting"]);
                    if (waits.length >= 2) break;
                    await new Promise((r) => setTimeout(r, 200));
                }
                expect(waits.length).toBeGreaterThanOrEqual(2);
                expect((await mgmt.getSession(sessionId)).status).toBe("running");
                await mgmt.cancelSession(sessionId, "enough polling");
                expect((await mgmt.getSession(sessionId)).status).toBe("cancelled");
                const end = (await mgmt.getSessionEvents(sessionId, 0, 1_000, ["workflow.cancelled"]))[0]
                    ?? await (async () => {
                        const until = Date.now() + 20_000;
                        while (Date.now() < until) {
                            const rows = await mgmt.getSessionEvents(sessionId, 0, 1_000, ["workflow.cancelled"]);
                            if (rows.length) return rows[0];
                            await new Promise((r) => setTimeout(r, 200));
                        }
                        return null;
                    })();
                expect(end?.data).toMatchObject({ reason: "enough polling" });
                expect(["check", "sleep"]).toContain(end.data.stateId);
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});


describe("a workflow session needs an agent parent and keeps its first start request (worker + client + PostgreSQL, no model)", () => {
    const SHORT = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: short, version: "1" }
inputs:
  run: { type: string, required: true }
initial: go
states:
  go:
    type: script
    runtime: node
    source: |
      await setResult("success", { run: context.inputs.run });
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded, output: "\${states.go.result}" }
`;
    const ALICE = { provider: "test", subject: "alice", email: "alice@example.com", displayName: "Alice" };
    const BOB = { provider: "test", subject: "bob", email: "bob@example.com", displayName: "Bob" };

    it("refuses a workflow without a parent, and with a parent that cannot own a run", async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const catalog = await createCatalog(env);
            try {
                const lonely = crypto.randomUUID();
                for (const parentSessionId of [undefined, "", "   "]) {
                    await expect(client.createWorkflowSession({ sessionId: lonely, yaml: SHORT, inputs: { run: "x" }, parentSessionId }))
                        .rejects.toMatchObject({ code: "WORKFLOW_PARENT_REQUIRED", status: 400, message: expect.stringMatching(/must be started by an agent session/) });
                }
                expect(await catalog.getSession(lonely)).toBeNull();

                const invalid = async (parentSessionId, reason, owner) => {
                    const sessionId = crypto.randomUUID();
                    await expect(client.createWorkflowSession({ sessionId, yaml: SHORT, inputs: { run: "x" }, parentSessionId, ...(owner ? { owner } : {}) }))
                        .rejects.toMatchObject({ code: "WORKFLOW_PARENT_INVALID", status: 400, message: expect.stringMatching(reason) });
                    expect(await catalog.getSession(sessionId)).toBeNull();
                };
                await invalid(crypto.randomUUID(), /does not exist or was deleted/);

                const deleted = await createParent(env);
                await catalog.softDeleteSession(deleted);
                await invalid(deleted, /does not exist or was deleted/);

                for (const state of ["completed", "failed", "cancelled"]) {
                    await invalid(await createParent(env, { state }), new RegExp(`it has ended \\(state ${state}\\)`));
                }

                const agent = await createParent(env, { owner: ALICE });
                const workflow = await client.createWorkflowSession({ yaml: SHORT, inputs: { run: "parent" }, parentSessionId: agent, notifyParent: false });
                await invalid(workflow.sessionId, /it is a workflow session/, ALICE);

                await invalid(agent, /belongs to a different owner/, BOB);
                await invalid(await createParent(env), /belongs to a different owner/, BOB);
            } finally {
                await catalog.close();
            }
        });
    });

    it("gives the workflow its parent's owner, and the caller's when they match", async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const catalog = await createCatalog(env);
            try {
                const parentSessionId = await createParent(env, { owner: ALICE });
                const inherited = await client.createWorkflowSession({ yaml: SHORT, inputs: { run: "a" }, parentSessionId, notifyParent: false });
                expect((await catalog.getSession(inherited.sessionId)).owner).toMatchObject({ provider: "test", subject: "alice" });
                const explicit = await client.createWorkflowSession({ yaml: SHORT, inputs: { run: "b" }, parentSessionId, owner: { provider: "test", subject: "alice" }, notifyParent: false });
                const row = await catalog.getSession(explicit.sessionId);
                expect(row.owner).toMatchObject({ provider: "test", subject: "alice" });
                expect(row.parentSessionId).toBe(parentSessionId);
            } finally {
                await catalog.close();
            }
        });
    });

    it("saves the first start request: the same request returns the session with one run, a different one is refused", { timeout: 60_000 }, async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            const catalog = await createCatalog(env);
            try {
                const parentSessionId = await createParent(env);
                const sessionId = crypto.randomUUID();
                const request = { sessionId, yaml: SHORT, inputs: { run: "one", extra: { b: 2, a: 1 } }, parentSessionId, notifyParent: false };
                await client.createWorkflowSession(request);
                const saved = (await catalog.getSessionCreationConfig(sessionId)).workflowStart;
                expect(saved).toEqual({ sessionId, yaml: SHORT, inputs: { run: "one", extra: { a: 1, b: 2 } }, parentSessionId, notifyParent: false });

                // Key order does not make a request different.
                const again = await client.createWorkflowSession({ ...request, inputs: { extra: { a: 1, b: 2 }, run: "one" } });
                expect(again).toEqual({ sessionId, workflowName: "short" });
                const view = await waitForTerminal(mgmt, sessionId);
                expect(view.status).toBe("completed");
                expect(await client.createWorkflowSession(request)).toEqual({ sessionId, workflowName: "short" });
                expect(await mgmt.getSessionEvents(sessionId, 0, 200, ["workflow.started"])).toHaveLength(1);

                const otherParent = await createParent(env);
                for (const change of [
                    { inputs: { run: "two", extra: { a: 1, b: 2 } } },
                    { notifyParent: true },
                    { parentSessionId: otherParent },
                    { yaml: SHORT.replace("name: short", "name: shorter") },
                ]) {
                    await expect(client.createWorkflowSession({ ...request, ...change }))
                        .rejects.toMatchObject({ code: "WORKFLOW_ADMISSION_CONFLICT", status: 409, message: expect.stringMatching(/already started with a different request/) });
                }
                expect((await catalog.getSessionCreationConfig(sessionId)).workflowStart).toEqual(saved);
                expect(await mgmt.getSessionEvents(sessionId, 0, 200, ["workflow.started"])).toHaveLength(1);
            } finally {
                await catalog.close();
                await mgmt.stop?.();
            }
        });
    });

    it("concurrent creates of one id keep the first request: the same request runs once, a different one is refused", { timeout: 60_000 }, async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            const catalog = await createCatalog(env);
            try {
                const parentSessionId = await createParent(env);
                const same = crypto.randomUUID();
                const request = { sessionId: same, yaml: SHORT, inputs: { run: "same" }, parentSessionId, notifyParent: false };
                const results = await Promise.all([client.createWorkflowSession(request), client.createWorkflowSession(request)]);
                expect(results.map((result) => result.sessionId)).toEqual([same, same]);
                await waitForTerminal(mgmt, same);
                expect(await mgmt.getSessionEvents(same, 0, 200, ["workflow.started"])).toHaveLength(1);

                const raced = crypto.randomUUID();
                const settled = await Promise.allSettled([
                    client.createWorkflowSession({ ...request, sessionId: raced, inputs: { run: "left" } }),
                    client.createWorkflowSession({ ...request, sessionId: raced, inputs: { run: "right" } }),
                ]);
                const won = settled.filter((result) => result.status === "fulfilled");
                const lost = settled.filter((result) => result.status === "rejected");
                expect(won).toHaveLength(1);
                expect(lost).toHaveLength(1);
                expect(lost[0].reason).toMatchObject({ code: "WORKFLOW_ADMISSION_CONFLICT" });
                const winner = settled[0].status === "fulfilled" ? "left" : "right";
                expect((await catalog.getSessionCreationConfig(raced)).workflowStart.inputs).toEqual({ run: winner });
                const done = await waitForTerminal(mgmt, raced);
                expect(done.status).toBe("completed");
                const end = (await mgmt.getSessionEvents(raced, 0, 200, ["workflow.completed"]))[0];
                expect(JSON.parse(end.data.outputPreview)).toEqual({ run: winner });
            } finally {
                await catalog.close();
                await mgmt.stop?.();
            }
        });
    });
});
