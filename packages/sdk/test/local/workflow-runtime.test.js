/**
 * Workflow runtime: the script runner and the durable controller.
 *
 * Runner tests start real node / python / pwsh processes. Controller tests
 * run the real workflow-session orchestration on an in-memory duroxide
 * runtime. No database, worker or LLM is required.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { compileWorkflow } from "../../src/workflow/compiler.js";
import { runScriptNode, SCRIPT_NODE_MAX_OUTPUT_BYTES } from "../../src/workflow/runner.js";
import {
    WORKFLOW_SESSION_ORCHESTRATION_NAME,
    WORKFLOW_SESSION_ORCHESTRATION_REGISTRY,
    WORKFLOW_SESSION_LATEST_VERSION,
    WORKFLOW_STEPS_PER_EXECUTION,
} from "../../src/workflow/orchestration.js";
import {
    registerWorkflowActivities,
    WORKFLOW_SCRIPTS_DISABLED_MESSAGE,
} from "../../src/workflow/activities.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Runtime, Client, SqliteProvider } = createRequire(import.meta.url)("duroxide");

const hasPython = spawnSync("python3", ["--version"]).status === 0;
// PS_TEST_PWSH points at a PowerShell that is not on PATH (a portable install).
const pwshExecutable = process.env.PS_TEST_PWSH || "pwsh";
const hasPwsh = spawnSync(pwshExecutable, ["-NoLogo", "-NoProfile", "-Command", "exit 0"]).status === 0;

function node(id, runtime, source, next = { success: "done" }, timeoutSeconds = 30) {
    return { id, type: "script", runtime, source, outcomes: Object.keys(next), next, timeoutSeconds };
}

function run(nodeDef, extra = {}) {
    return runScriptNode({
        sessionId: "session-under-test",
        workflowName: "wf",
        node: nodeDef,
        inputs: { a: 2, b: 3 },
        priorOutput: { from: "previous" },
        step: 1,
        callTool: async () => { throw new Error("no tools in this test"); },
        ...extra,
    }, { executables: { powershell: pwshExecutable } });
}

describe("script runner", () => {
    it("routes a node script's tool call to the session tool set and takes its reported result", async () => {
        const calls = [];
        const result = await run(node("n", "node", `
            const echoed = await callTool("echo", { value: context.inputs.a + context.inputs.b });
            await setResult("success", { echoed, prior: context.input.from, node: context.node, step: context.step });
        `), {
            callTool: async (call) => { calls.push(call); return { echo: call.arguments.value }; },
        });
        expect(calls).toEqual([{ name: "echo", arguments: { value: 5 } }]);
        expect(result.outcome).toBe("success");
        expect(result.resultSource).toBe("reported");
        expect(result.output).toEqual({ echoed: { echo: 5 }, prior: "previous", node: "n", step: 1 });
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({ name: "echo", ok: true });
    });

    it("surfaces a failed tool call to the script as an error it can handle", async () => {
        const result = await run(node("n", "node", `
            try { await callTool("missing", {}); await setResult("unexpected"); }
            catch (error) { await setResult("handled", String(error.message)); }
        `), {
            callTool: async () => { throw new Error("Tool 'missing' is not available"); },
        });
        expect(result.outcome).toBe("handled");
        expect(result.output).toMatch(/not available/);
        expect(result.toolCalls[0]).toMatchObject({ name: "missing", ok: false });
    });

    it("does not pass the worker's environment to the script", async () => {
        process.env.PILOTSWARM_SECRET_FOR_TEST = "must-not-leak";
        try {
            const result = await run(node("n", "node", `
                console.log(JSON.stringify({ outcome: "success", output: {
                    secret: process.env.PILOTSWARM_SECRET_FOR_TEST ?? null,
                    hasEndpoint: Boolean(process.env.PILOTSWARM_WORKFLOW_ENDPOINT),
                } }));
            `));
            expect(result.resultSource).toBe("stdout");
            expect(result.output).toEqual({ secret: null, hasEndpoint: true });
        } finally {
            delete process.env.PILOTSWARM_SECRET_FOR_TEST;
        }
    });

    it("refuses tool calls that do not carry the run's token", async () => {
        const result = await run(node("n", "node", `
            const response = await fetch(process.env.PILOTSWARM_WORKFLOW_ENDPOINT + "/tool", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer wrong" },
                body: JSON.stringify({ name: "echo", arguments: {} }),
            });
            await setResult("success", response.status);
        `), { callTool: async () => "should not run" });
        expect(result.output).toBe(403);
        expect(result.toolCalls).toHaveLength(0);
    });

    it("maps exit codes to success and failure when the script reports nothing", async () => {
        const ok = await run(node("n", "node", `console.log("plain text")`));
        expect(ok).toMatchObject({ outcome: "success", output: "plain text", resultSource: "exit", exitCode: 0 });

        const bad = await run(node("n", "node", `console.error("boom"); process.exit(3);`));
        expect(bad).toMatchObject({ outcome: "failure", resultSource: "exit", exitCode: 3 });
        expect(bad.output).toMatchObject({ exitCode: 3 });
        expect(bad.output.stderr).toMatch(/boom/);
    });

    it("kills a script that runs past its timeout and reports outcome timeout", async () => {
        const started = Date.now();
        const result = await run(node("n", "node", `await new Promise(() => setInterval(() => {}, 1000));`, { success: "done" }, 1));
        expect(result).toMatchObject({ outcome: "timeout", resultSource: "timeout", output: { timeoutSeconds: 1 } });
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("rejects output too large to keep in durable history", async () => {
        await expect(run(node("n", "node", `
            await setResult("success", "x".repeat(${SCRIPT_NODE_MAX_OUTPUT_BYTES + 10}));
        `))).rejects.toThrow(/limit is/);
    });

    it("names the missing runtime when its executable is not installed", async () => {
        await expect(runScriptNode({
            sessionId: "s", workflowName: "wf", node: node("n", "python", "print(1)"),
            inputs: {}, priorOutput: null, step: 1, callTool: async () => null,
        }, { executables: { python: "/nonexistent/python-for-test" } })).rejects.toThrow(/python runtime/);
    });

    it.skipIf(!hasPython)("runs python with context, tool calls and set_result", async () => {
        const result = await run(node("n", "python", [
            "total = call_tool('add', {'a': context['inputs']['a'], 'b': context['inputs']['b']})",
            "set_result('success', {'total': total, 'prior': context['input']['from']})",
        ].join("\n")), {
            callTool: async (call) => call.arguments.a + call.arguments.b,
        });
        expect(result).toMatchObject({ outcome: "success", output: { total: 5, prior: "previous" }, resultSource: "reported" });
    });

    it.skipIf(!hasPwsh)("maps a powershell error to outcome failure with its message", async () => {
        const result = await run(node("n", "powershell", "throw 'disk full'"));
        expect(result).toMatchObject({ outcome: "failure", resultSource: "exit" });
        expect(result.output.stderr).toMatch(/disk full/);
    });

    it.skipIf(!hasPwsh)("runs powershell with context, tool calls and Set-PilotSwarmResult", async () => {
        const result = await run(node("n", "powershell", [
            "$total = Invoke-PilotSwarmTool -Name 'add' -Arguments @{ a = $context.inputs.a; b = $context.inputs.b }",
            "Set-PilotSwarmResult -Outcome 'success' -Output @{ total = $total }",
        ].join("\n")), {
            callTool: async (call) => call.arguments.a + call.arguments.b,
        });
        expect(result).toMatchObject({ outcome: "success", output: { total: 5 } });
    });
});

// ─── Durable controller ─────────────────────────────────────────

function fakeCatalog() {
    const events = [];
    const updates = [];
    return {
        events,
        updates,
        async recordEvents(sessionId, list) { for (const event of list) events.push({ sessionId, ...event }); },
        async updateSession(sessionId, changes) { updates.push({ sessionId, ...changes }); },
        async getSessionEvents(sessionId, _after, _limit, types) {
            return events.filter((e) => e.sessionId === sessionId && (!types || types.includes(e.eventType)));
        },
    };
}

async function startRuntime(provider, deps, runtimeOptions = {}) {
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", ...runtimeOptions });
    registerWorkflowActivities(runtime, deps);
    for (const registration of WORKFLOW_SESSION_ORCHESTRATION_REGISTRY) {
        runtime.registerOrchestrationVersioned(WORKFLOW_SESSION_ORCHESTRATION_NAME, registration.version, registration.handler);
    }
    await runtime.start();
    return runtime;
}

async function runWorkflow(yaml, { deps = {}, inputs = {}, parentSessionId } = {}) {
    const provider = await SqliteProvider.inMemory();
    const catalog = fakeCatalog();
    const notifications = [];
    const fullDeps = {
        catalog,
        enabled: () => true,
        resolveTools: async () => new Map(),
        notifyParent: async (parent, prompt, sender) => { notifications.push({ parent, prompt, sender }); },
        ...deps,
    };
    const runtime = await startRuntime(provider, fullDeps);
    try {
        const client = new Client(provider);
        const sessionId = `wf-${Math.random().toString(36).slice(2)}`;
        const instanceId = `session-${sessionId}`;
        await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
            sessionId, yaml, inputs, ...(parentSessionId ? { parentSessionId } : {}),
        }, WORKFLOW_SESSION_LATEST_VERSION);
        const status = await client.waitForOrchestration(instanceId, 60_000);
        const executions = await client.listExecutions?.(instanceId).catch?.(() => null) ?? null;
        const custom = (await client.getStatus(instanceId)).customStatus;
        return { status, catalog, notifications, executions, sessionId, custom: custom ? JSON.parse(custom) : null };
    } finally {
        await runtime.shutdown(100);
    }
}

const BRANCHING_YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: branching
  version: 1.0.0
inputs:
  key: { type: string, required: true }
initial: collect
states:
  collect:
    type: script
    runtime: node
    source: |
      const fact = await callTool("read_facts", { key_pattern: context.inputs.key });
      await setResult("success", { count: fact.count });
    completion: { outcomes: [success] }
    transition: { next: { success: decide } }
  decide:
    type: script
    runtime: node
    source: |
      await setResult(context.input.count > 1 ? "many" : "few", context.input);
    completion: { outcomes: [many, few] }
    transition: { next: { many: report, few: nothing } }
  report:
    type: script
    runtime: node
    source: |
      await setResult("done", { reported: context.input.count });
    completion: { outcomes: [done] }
    transition: { next: { done: reported } }
  reported:
    type: terminal
    outcome: succeeded
    summary: Reported.
    output: \${states.report.result}
  nothing:
    type: terminal
    outcome: blocked
    summary: Too few facts.
    output: \${states.decide.result}
`;

describe("workflow controller (duroxide)", () => {
    it("runs nodes in order, follows outcomes, routes tools to the workflow session and notifies the parent", async () => {
        const toolCalls = [];
        const { status, catalog, notifications, sessionId, custom } = await runWorkflow(BRANCHING_YAML, {
            inputs: { key: "metrics/%" },
            parentSessionId: "parent-1",
            deps: {
                resolveTools: async (sid) => new Map([["read_facts", async (args) => {
                    toolCalls.push({ sid, args });
                    return { count: 3 };
                }]]),
            },
        });

        expect(status.status).toBe("Completed");
        expect(status.output).toMatchObject({
            status: "completed", workflowName: "branching", outcome: "succeeded", summary: "Reported.",
            output: { reported: 3 }, stateId: "reported", steps: 3,
        });
        expect(toolCalls).toEqual([{ sid: sessionId, args: { key_pattern: "metrics/%" } }]);

        const types = catalog.events.map((event) => `${event.eventType}${event.data.stateId ? `:${event.data.stateId}` : ""}`);
        expect(types).toEqual([
            "workflow.started",
            "workflow.state_started:collect", "workflow.state_completed:collect",
            "workflow.state_started:decide", "workflow.state_completed:decide",
            "workflow.state_started:report", "workflow.state_completed:report",
            "workflow.completed:reported",
        ]);
        expect(catalog.updates.at(0)).toMatchObject({ state: "running" });
        expect(catalog.updates.at(-1)).toMatchObject({ state: "completed", lastError: null });
        expect(custom).toMatchObject({ status: "completed", sessionKind: "workflow", workflow: { name: "branching", stateId: "reported", step: 3, outcome: "succeeded" } });

        expect(notifications).toHaveLength(1);
        expect(notifications[0].parent).toBe("parent-1");
        expect(notifications[0].sender).toEqual({ kind: "system", display: "workflow branching" });
        expect(notifications[0].prompt).toMatch(/ended at state 'reported' with outcome succeeded after 3 step\(s\)\. Reported\. Output: \{"reported":3\}/);
    });

    it("ends at whichever terminal state an outcome leads to", async () => {
        const { status } = await runWorkflow(BRANCHING_YAML, {
            inputs: { key: "k" },
            deps: { resolveTools: async () => new Map([["read_facts", async () => ({ count: 1 })]]) },
        });
        expect(status.output).toMatchObject({ status: "completed", outcome: "blocked", stateId: "nothing", summary: "Too few facts.", output: { count: 1 }, steps: 2 });
    });

    it("continues as new to bound history and runs every node exactly once", async () => {
        const iterations = WORKFLOW_STEPS_PER_EXECUTION * 2 + 5;
        const ran = [];
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: counter, version: "1" }
initial: tick
states:
  tick:
    type: script
    runtime: node
    source: "unused: runNode is stubbed"
    completion: { outcomes: [again, done] }
    transition: { next: { again: tick, done: finished } }
  finished: { type: terminal, outcome: succeeded, output: \${states.tick.result} }
`;
        const { status, executions } = await runWorkflow(yaml, {
            inputs: { limit: iterations },
            deps: {
                runNode: async (request) => {
                    ran.push(request.step);
                    const count = (request.priorOutput?.count ?? 0) + 1;
                    return {
                        outcome: count >= request.inputs.limit ? "done" : "again",
                        output: { count },
                        resultSource: "reported", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", toolCalls: [],
                    };
                },
            },
        });
        expect(status.status).toBe("Completed");
        expect(status.output).toMatchObject({ outcome: "succeeded", stateId: "finished", output: { count: iterations }, steps: iterations });
        expect(ran).toEqual(Array.from({ length: iterations }, (_, index) => index + 1));
        if (Array.isArray(executions)) expect(executions.length).toBeGreaterThanOrEqual(3);
    });

    it("an authored failed terminal state ends the session failed, with its summary and output", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: guarded, version: "1" }
inputs:
  limit: { type: integer, required: true }
initial: check
states:
  check:
    type: script
    runtime: node
    source: 'await setResult(context.inputs.limit > 10 ? "over" : "ok", { limit: context.inputs.limit })'
    completion: { outcomes: [ok, over] }
    transition: { next: { ok: fine, over: refused } }
  fine: { type: terminal, outcome: succeeded }
  refused:
    type: terminal
    outcome: failed
    summary: Limit is over 10.
    output: { limit: \${inputs.limit}, seen: \${states.check.result} }
`;
        const { status, catalog, notifications } = await runWorkflow(yaml, { inputs: { limit: 50 }, parentSessionId: "p" });
        expect(status.output).toMatchObject({
            status: "failed", outcome: "failed", stateId: "refused", summary: "Limit is over 10.",
            output: { limit: 50, seen: { limit: 50 } }, steps: 1,
        });
        expect(catalog.updates.at(-1)).toMatchObject({ state: "failed", lastError: "Limit is over 10." });
        expect(catalog.events.at(-1)).toMatchObject({ eventType: "workflow.failed", data: { stateId: "refused", outcome: "failed", summary: "Limit is over 10." } });
        expect(notifications[0].prompt).toMatch(/ended at state 'refused' with outcome failed after 1 step\(s\)\. Limit is over 10\./);

        const missing = await runWorkflow(yaml, { inputs: {} });
        expect(missing.status.output).toMatchObject({ status: "failed", steps: 0 });
        expect(missing.status.output.error).toMatch(/Input 'limit' is required/);
    });

    it("fails the workflow on an undeclared outcome and tells the parent why", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: strict, version: "1" }
initial: only
states:
  only:
    type: script
    runtime: node
    source: 'await setResult("surprise", null);'
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded }
`;
        const { status, catalog, notifications } = await runWorkflow(yaml, { parentSessionId: "p" });
        expect(status.status).toBe("Completed");
        expect(status.output).toMatchObject({ status: "failed", workflowName: "strict", steps: 1 });
        expect(status.output.error).toMatch(/undeclared outcome 'surprise' \(declared: success\)/);
        expect(catalog.updates.at(-1)).toMatchObject({ state: "failed" });
        expect(catalog.events.at(-1).eventType).toBe("workflow.failed");
        expect(notifications[0].prompt).toMatch(/failed after 1 step\(s\)\. Error: .*surprise/);
    });

    it("fails a non-zero exit when the node does not route failure, and routes it when it does", async () => {
        const make = (outcomes, next) => `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: exits, version: "1" }
initial: crash
states:
  crash:
    type: script
    runtime: node
    source: 'process.exit(7)'
    completion: { outcomes: ${outcomes} }
    transition: { next: ${next} }
  recover:
    type: script
    runtime: node
    source: 'await setResult("success", { recoveredFrom: context.input.exitCode })'
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded, output: \${states.recover.result} }
`;
        const unrouted = await runWorkflow(make("[success]", "{ success: done }"));
        expect(unrouted.status.output).toMatchObject({ status: "failed" });
        expect(unrouted.status.output.error).toMatch(/undeclared outcome 'failure'/);

        const routed = await runWorkflow(make("[success, failure]", "{ success: done, failure: recover }"));
        expect(routed.status.output).toMatchObject({ status: "completed", outcome: "succeeded", output: { recoveredFrom: 7 }, steps: 2 });
    });

    it("fails without running a script when the worker has script workflows disabled", async () => {
        let ran = false;
        const { status, catalog } = await runWorkflow(BRANCHING_YAML, {
            deps: { enabled: () => false, runNode: async () => { ran = true; throw new Error("must not run"); } },
        });
        expect(ran).toBe(false);
        expect(status.output).toMatchObject({ status: "failed", workflowName: null, steps: 0 });
        expect(status.output.error).toBe(WORKFLOW_SCRIPTS_DISABLED_MESSAGE);
        expect(catalog.events.map((event) => event.eventType)).toEqual(["workflow.failed"]);
    });

    it("fails cleanly when the YAML is not a valid script workflow", async () => {
        const { status } = await runWorkflow(BRANCHING_YAML.replace("type: script", "type: agent"));
        expect(status.output).toMatchObject({ status: "failed", steps: 0 });
        expect(status.output.error).toMatch(/type 'agent' is not supported yet/);
    });

    it("resumes on a new runtime after the worker stops mid-workflow without re-running finished nodes", async () => {
        const provider = await SqliteProvider.inMemory();
        const catalog = fakeCatalog();
        const ran = [];
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: restart, version: "1" }
initial: first
states:
  first: { type: script, runtime: node, source: "stub", completion: { outcomes: [success] }, transition: { next: { success: second } } }
  second: { type: script, runtime: node, source: "stub", completion: { outcomes: [success] }, transition: { next: { success: done } } }
  done: { type: terminal, outcome: succeeded, output: \${states.second.result} }
`;
        const ok = (output) => ({ outcome: "success", output, resultSource: "reported", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", toolCalls: [] });
        let releaseHang;
        const firstRuntime = await startRuntime(provider, {
            catalog, enabled: () => true, resolveTools: async () => new Map(), notifyParent: async () => {},
            runNode: async (request) => {
                ran.push(`rt1:${request.node.id}`);
                if (request.node.id === "first") return ok({ from: "first" });
                // The worker "dies" while the second node runs.
                return new Promise((resolve) => { releaseHang = resolve; });
            },
        }, { workerLockTimeoutMs: 1_000 });

        const client = new Client(provider);
        const instanceId = "session-restart-wf";
        await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
            sessionId: "restart-wf", yaml, inputs: {},
        }, WORKFLOW_SESSION_LATEST_VERSION);

        const deadline = Date.now() + 20_000;
        while (!ran.includes("rt1:second") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        expect(ran).toEqual(["rt1:first", "rt1:second"]);
        await firstRuntime.shutdown(100);

        const secondRuntime = await startRuntime(provider, {
            catalog, enabled: () => true, resolveTools: async () => new Map(), notifyParent: async () => {},
            runNode: async (request) => {
                ran.push(`rt2:${request.node.id}`);
                return ok({ second: true, prior: request.priorOutput });
            },
        }, { workerLockTimeoutMs: 1_000 });
        try {
            const status = await client.waitForOrchestration(instanceId, 60_000);
            expect(status.status).toBe("Completed");
            expect(status.output).toMatchObject({ status: "completed", steps: 2, output: { second: true, prior: { from: "first" } } });
            // The finished first node was replayed from history, not re-run.
            expect(ran.filter((entry) => entry.endsWith(":first"))).toEqual(["rt1:first"]);
            expect(ran).toContain("rt2:second");
        } finally {
            releaseHang?.(ok(null));
            await secondRuntime.shutdown(100);
        }
    });
});

// ─── Cancellation ───────────────────────────────────────────────

const LONG_YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: long-running, version: "1" }
initial: first
states:
  first: { type: script, runtime: node, source: 'await setResult("success", null)', completion: { outcomes: [success] }, transition: { next: { success: slow } } }
  slow:
    type: script
    runtime: node
    timeoutSeconds: 600
    source: |
      process.stdout.write("started\\n");
      await new Promise(() => setInterval(() => {}, 1000));
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded, output: \${states.slow.result} }
`;

async function startLongWorkflow({ runNode, parentSessionId = "parent-1" } = {}) {
    const provider = await SqliteProvider.inMemory();
    const catalog = fakeCatalog();
    const notifications = [];
    const deleted = [];
    const runtime = await startRuntime(provider, {
        catalog,
        enabled: () => true,
        resolveTools: async () => new Map(),
        notifyParent: async (parent, prompt) => { notifications.push({ parent, prompt }); },
        deleteSession: async (id) => { deleted.push(id); },
        ...(runNode ? { runNode } : {}),
    // A running activity learns of its cancellation when it renews its lock;
    // a short lock keeps these tests fast (production renews every few seconds).
    }, { workerLockTimeoutMs: 1_000 });
    const client = new Client(provider);
    const sessionId = `wf-${Math.random().toString(36).slice(2)}`;
    const instanceId = `session-${sessionId}`;
    await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
        sessionId, yaml: LONG_YAML, inputs: {}, parentSessionId,
    }, WORKFLOW_SESSION_LATEST_VERSION);
    const waitFor = async (check, label, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (check()) return;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`timed out waiting for ${label}`);
    };
    return { provider, runtime, client, catalog, notifications, deleted, sessionId, instanceId, waitFor };
}

const okResult = (output) => ({ outcome: "success", output, resultSource: "reported", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", toolCalls: [] });
const command = (cmd, extra = {}) => JSON.stringify({ type: "cmd", cmd, id: `${cmd}-1`, args: { reason: `${cmd} by test` }, ...extra });

describe("workflow cancellation (duroxide)", () => {
    it("cancel stops the running script, ends the run as cancelled and tells the parent why", async () => {
        const { runtime, client, catalog, notifications, instanceId, waitFor } = await startLongWorkflow();
        try {
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_started" && e.data.stateId === "slow"), "the slow node to start");
            const started = Date.now();
            await client.enqueueEvent(instanceId, "messages", command("cancel"));
            const status = await client.waitForOrchestration(instanceId, 20_000);
            expect(status.status).toBe("Completed");
            expect(status.output).toMatchObject({ status: "cancelled", reason: "cancel by test", stateId: "slow", steps: 2 });
            // The script process is killed, not left to run to its 600 s timeout.
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_cancelled"), "the runner to report the kill");
            expect(Date.now() - started).toBeLessThan(10_000);
            expect(catalog.events.find((e) => e.eventType === "workflow.cancelled").data).toMatchObject({ reason: "cancel by test", steps: 2 });
            expect(catalog.updates.at(-1)).toMatchObject({ state: "cancelled", lastError: "cancel by test" });
            expect(notifications.map((n) => n.prompt)).toEqual([expect.stringMatching(/cancelled after 2 step\(s\)\. Reason: cancel by test/)]);
            const custom = JSON.parse((await client.getStatus(instanceId)).customStatus);
            expect(custom).toMatchObject({ status: "cancelled", workflow: { stateId: "slow" } });
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("complete stops a running workflow too, and a parent that asked is not told", async () => {
        let cancelSeen = false;
        const { runtime, client, notifications, instanceId, catalog, waitFor } = await startLongWorkflow({
            runNode: async (request) => {
                if (request.node.id === "first") return okResult(null);
                while (!request.isCancelled?.()) await new Promise((r) => setTimeout(r, 20));
                cancelSeen = true;
                return { ...okResult(null), outcome: "cancelled", resultSource: "cancelled" };
            },
        });
        try {
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_started" && e.data.stateId === "slow"), "the slow node to start");
            await client.enqueueEvent(instanceId, "messages", command("done", { requestedBy: "parent-1" }));
            const status = await client.waitForOrchestration(instanceId, 20_000);
            expect(status.output).toMatchObject({ status: "cancelled", reason: "done by test" });
            await waitFor(() => cancelSeen, "the node to see its cancellation");
            expect(notifications).toEqual([]);
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("delete stops the script and removes the session", async () => {
        const { runtime, client, deleted, sessionId, instanceId, catalog, waitFor } = await startLongWorkflow();
        try {
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_started" && e.data.stateId === "slow"), "the slow node to start");
            await client.enqueueEvent(instanceId, "messages", command("delete"));
            const status = await client.waitForOrchestration(instanceId, 20_000);
            expect(status.output).toMatchObject({ status: "deleted" });
            expect(deleted).toEqual([sessionId]);
            expect(catalog.updates.some((u) => u.state === "cancelled")).toBe(false);
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("a stray non-command message re-runs the interrupted node and the workflow still completes", async () => {
        const runs = [];
        const { runtime, client, instanceId, catalog, waitFor } = await startLongWorkflow({
            runNode: async (request) => {
                runs.push(request.node.id);
                if (request.node.id === "first") return okResult(null);
                if (runs.filter((id) => id === "slow").length === 1) {
                    while (!request.isCancelled?.()) await new Promise((r) => setTimeout(r, 20));
                    return { ...okResult(null), outcome: "cancelled", resultSource: "cancelled" };
                }
                return okResult({ second: true });
            },
        });
        try {
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_started" && e.data.stateId === "slow"), "the slow node to start");
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: "hello" }));
            const status = await client.waitForOrchestration(instanceId, 20_000);
            expect(status.output).toMatchObject({ status: "completed", output: { second: true }, steps: 2 });
            expect(runs).toEqual(["first", "slow", "slow"]);
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("cancelling the instance itself (how a client delete ends it) cancels the running node", async () => {
        let cancelSeen = false;
        const { runtime, client, instanceId, catalog, waitFor } = await startLongWorkflow({
            runNode: async (request) => {
                if (request.node.id === "first") return okResult(null);
                while (!request.isCancelled?.()) await new Promise((r) => setTimeout(r, 20));
                cancelSeen = true;
                return { ...okResult(null), outcome: "cancelled", resultSource: "cancelled" };
            },
        });
        try {
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_started" && e.data.stateId === "slow"), "the slow node to start");
            await client.cancelInstance(instanceId, "Session deleted");
            await waitFor(() => cancelSeen, "the running node to see the instance cancellation", 20_000);
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("a command that arrives between nodes is not lost", async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const { runtime, client, instanceId, catalog, waitFor } = await startLongWorkflow({
            runNode: async (request) => {
                if (request.node.id === "first") { await gate; return okResult(null); }
                while (!request.isCancelled?.()) await new Promise((r) => setTimeout(r, 20));
                return { ...okResult(null), outcome: "cancelled", resultSource: "cancelled" };
            },
        });
        try {
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_started" && e.data.stateId === "first"), "the first node to start");
            // Sent while the first node runs: it wins that race, so the first
            // node is the one stopped.
            await client.enqueueEvent(instanceId, "messages", command("cancel"));
            const status = await client.waitForOrchestration(instanceId, 20_000);
            release();
            expect(status.output).toMatchObject({ status: "cancelled", stateId: "first", steps: 1 });
        } finally {
            await runtime.shutdown(100);
        }
    });
});

// ─── Live canvas ────────────────────────────────────────────────

function fakeCanvas() {
    const draws = [];
    const ticks = [];
    return {
        draws,
        ticks,
        async draw(sessionId, html) { draws.push({ sessionId, html }); },
        async tick(sessionId, state) { ticks.push({ sessionId, state: JSON.parse(JSON.stringify(state)) }); },
    };
}

describe("workflow live canvas (duroxide)", () => {
    it("draws the graph once and ticks the state on every step and at the end", async () => {
        const canvas = fakeCanvas();
        const { status } = await runWorkflow(BRANCHING_YAML, {
            inputs: { key: "k" },
            deps: { canvas, resolveTools: async () => new Map([["read_facts", async () => ({ count: 3 })]]) },
        });
        expect(status.output).toMatchObject({ status: "completed", outcome: "succeeded", stateId: "reported" });
        expect(canvas.draws).toHaveLength(1);
        expect(canvas.draws[0].html).toContain('"entry":"collect"');
        expect(canvas.draws[0].html).toContain("applyData");
        // Two ticks per step (start, end) and one for the end of the run.
        expect(canvas.ticks).toHaveLength(3 * 2 + 1);
        const running = canvas.ticks[0].state;
        expect(running).toMatchObject({ status: "running", current: "collect", step: 1 });
        expect(running.nodes.collect).toMatchObject({ state: "running", runs: 1 });
        const last = canvas.ticks.at(-1).state;
        expect(last).toMatchObject({ status: "completed", outcome: "succeeded", summary: "Reported.", step: 3, current: "reported" });
        expect(last.nodes).toMatchObject({
            collect: { state: "done", lastOutcome: "success" }, decide: { state: "done", lastOutcome: "many" },
            report: { state: "done" }, reported: { state: "done" }, nothing: { state: "idle" },
        });
        expect(last.taken).toEqual({ "collect\u0001success": 1, "decide\u0001many": 1, "report\u0001done": 1 });
        expect(last.steps.map((s) => [s.step, s.node, s.outcome])).toEqual([[1, "collect", "success"], [2, "decide", "many"], [3, "report", "done"]]);
    });

    it("a cancelled run ends with the running node shown as stopped", async () => {
        const canvas = fakeCanvas();
        const { runtime, client, instanceId, catalog, waitFor } = await (async () => {
            const provider = await SqliteProvider.inMemory();
            const catalog = fakeCatalog();
            const runtime = await startRuntime(provider, {
                catalog, canvas, enabled: () => true, resolveTools: async () => new Map(), notifyParent: async () => {},
                runNode: async (request) => {
                    if (request.node.id === "first") return okResult(null);
                    while (!request.isCancelled?.()) await new Promise((r) => setTimeout(r, 20));
                    return { ...okResult(null), outcome: "cancelled", resultSource: "cancelled" };
                },
            });
            const client = new Client(provider);
            const instanceId = `session-wf-canvas-${Math.random().toString(36).slice(2)}`;
            await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
                sessionId: instanceId.slice("session-".length), yaml: LONG_YAML, inputs: {},
            }, WORKFLOW_SESSION_LATEST_VERSION);
            const waitFor = async (check, label) => {
                const deadline = Date.now() + 20_000;
                while (Date.now() < deadline) { if (check()) return; await new Promise((r) => setTimeout(r, 25)); }
                throw new Error(`timed out waiting for ${label}`);
            };
            return { runtime, client, instanceId, catalog, waitFor };
        })();
        try {
            await waitFor(() => catalog.events.some((e) => e.eventType === "workflow.state_started" && e.data.stateId === "slow"), "the slow node");
            await client.enqueueEvent(instanceId, "messages", command("cancel"));
            await client.waitForOrchestration(instanceId, 20_000);
            await waitFor(() => canvas.ticks.some((t) => t.state.status === "cancelled"), "the cancelled tick");
            const end = canvas.ticks.filter((t) => t.state.status === "cancelled").at(-1).state;
            expect(end).toMatchObject({ status: "cancelled", reason: "cancel by test" });
            expect(end.nodes.slow.state).toBe("cancelled");
            expect(end.nodes.first.state).toBe("done");
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("a canvas that cannot be written never fails the run", async () => {
        const { status } = await runWorkflow(BRANCHING_YAML, {
            inputs: { key: "k" },
            deps: {
                canvas: { draw: async () => { throw new Error("blob store down"); }, tick: async () => { throw new Error("blob store down"); } },
                resolveTools: async () => new Map([["read_facts", async () => ({ count: 0 })]]),
            },
        });
        expect(status.output).toMatchObject({ status: "completed", outcome: "blocked", stateId: "nothing" });
    });
});

// ─── MCP server tools ───────────────────────────────────────────

const CALC_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/workflow-mcp/calc-server.mjs");

describe("MCP server tools for scripts", () => {
    it("a node script calls MCP tools as <server>/<tool>, lists them, and is held to the server's tools list", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: mcp-use, version: "1" }
initial: use
states:
  use:
    type: script
    runtime: node
    source: |
      const sum = await callTool("calc/add", { a: 2, b: 40 });
      const info = await callTool("calc/info", {});
      const listed = await callTool("list_mcp_tools", {});
      let secret = null, failed = null, unknown = null;
      try { await callTool("calc/secret", {}); } catch (e) { secret = e.message; }
      try { await callTool("calc/fail", {}); } catch (e) { failed = e.message; }
      try { await callTool("nope/tool", {}); } catch (e) { unknown = e.message; }
      await setResult("success", { sum, info, listed, secret, failed, unknown });
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded, output: \${states.use.result} }
`;
        const { status, catalog } = await runWorkflow(yaml, {
            deps: {
                resolveMcpServers: async () => ({
                    calc: { command: process.execPath, args: [CALC_SERVER], tools: ["add", "info", "fail"], env: { CALC_LABEL: "from-config" } },
                }),
            },
        });
        expect(status.output.status).toBe("completed");
        const out = status.output.output;
        expect(out.sum).toBe("42");
        expect(out.info).toMatchObject({ env: "from-config" });
        expect(out.listed.servers).toEqual(["calc"]);
        expect(out.listed.tools.map((t) => t.name).sort()).toEqual(["calc/add", "calc/fail", "calc/info"]);
        expect(out.secret).toMatch(/not enabled on MCP server 'calc'/);
        expect(out.failed).toMatch(/calc refused/);
        expect(out.unknown).toMatch(/not available to workflow scripts.*MCP servers .*calc/);
        const done = catalog.events.find((e) => e.eventType === "workflow.state_completed");
        expect(done.data.toolCalls.map((c) => [c.name, c.ok])).toEqual([
            ["calc/add", true], ["calc/info", true], ["list_mcp_tools", true],
            ["calc/secret", false], ["calc/fail", false], ["nope/tool", false],
        ]);
    });

    it("the node's MCP server process ends when the node ends", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: mcp-lifetime, version: "1" }
initial: use
states:
  use:
    type: script
    runtime: node
    source: |
      const info = await callTool("calc/info", {});
      await setResult("success", { pid: info.pid });
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded, output: \${states.use.result} }
`;
        const { status } = await runWorkflow(yaml, {
            deps: { resolveMcpServers: async () => ({ calc: { command: process.execPath, args: [CALC_SERVER], tools: ["*"] } }) },
        });
        const pid = status.output.output.pid;
        expect(Number.isInteger(pid)).toBe(true);
        const deadline = Date.now() + 5_000;
        let alive = true;
        while (alive && Date.now() < deadline) {
            try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
        }
        expect(alive).toBe(false);
    });
});

describe("compiled graph sanity", () => {
    it("compiles the branching example used above", () => {
        const compiled = compileWorkflow(BRANCHING_YAML);
        expect(Object.keys(compiled.states)).toEqual(["collect", "decide", "report", "reported", "nothing"]);
        expect(compiled.states.decide.next).toEqual({ many: "report", few: "nothing" });
        expect(compiled.states.collect.timeoutSeconds).toBe(300);
        expect(compiled.states.nothing).toMatchObject({ type: "terminal", outcome: "blocked" });
    });
});
