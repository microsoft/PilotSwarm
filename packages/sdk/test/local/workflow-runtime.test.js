/**
 * Workflow runtime: the script runner and the durable controller.
 *
 * Runner tests start real node / python / pwsh processes. Controller tests
 * run the real workflow-session orchestration on an in-memory duroxide
 * runtime. No database, worker or LLM is required.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { compileWorkflow, WORKFLOWS_DISABLED_MESSAGE } from "../../src/workflow/compiler.js";

// The state types a worker with script workflows on runs.
const SCRIPTS = new Set(["script"]);
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
import fs from "node:fs";

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

    it("reads a final JSON result line longer than the 16 KB stdout tail, and refuses one past the output limit", async () => {
        const big = await run(node("n", "node", `
            console.log("noise");
            console.log(JSON.stringify({ outcome: "found", output: { text: "y".repeat(40000) } }));
        `, { found: "done" }));
        expect(big).toMatchObject({ outcome: "found", resultSource: "stdout" });
        expect(big.output.text).toHaveLength(40000);
        await expect(run(node("n", "node", `
            console.log(JSON.stringify({ outcome: "found", output: "z".repeat(${SCRIPT_NODE_MAX_OUTPUT_BYTES + 100 * 1024}) }));
        `, { found: "done" }))).rejects.toThrow(/final line longer than/);
    });

    it("counts tool calls before they run, so concurrent calls cannot pass the limit", async () => {
        let admitted = 0;
        const result = await run(node("n", "node", `
            const settled = await Promise.allSettled(Array.from({ length: 501 }, (_, i) => callTool("slow", { i })));
            await setResult("success", { ok: settled.filter((r) => r.status === "fulfilled").length, refused: settled.filter((r) => r.status === "rejected").length });
        `), {
            callTool: async () => { admitted += 1; await new Promise((r) => setTimeout(r, 200)); return null; },
        });
        expect(admitted).toBe(500);
        expect(result.output).toEqual({ ok: 500, refused: 1 });
    });

    // Node scripts cannot start processes (Node's permission model), so this uses python.
    it.skipIf(process.platform === "win32" || !hasPython)("a background process the script leaves holding its output cannot keep the state running, and is killed", async () => {
        const marker = `pilotswarm-orphan-${Math.random().toString(36).slice(2)}`;
        const started = Date.now();
        // The script starts a child that inherits stdout and outlives it, then exits.
        const result = await run(node("n", "python", [
            "import subprocess, sys",
            `child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "${marker}"])`,
            'set_result("success", {"pid": child.pid})',
        ].join("\n"), { success: "done" }, 30));
        expect(result.outcome).toBe("success");
        expect(Date.now() - started).toBeLessThan(10_000);
        await new Promise((r) => setTimeout(r, 300));
        // Killed means gone, or a zombie waiting to be reaped (a container's
        // pid 1 may never reap it).
        const running = (pid) => {
            try { process.kill(pid, 0); } catch { return false; }
            try {
                const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
                return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
            } catch { return true; }
        };
        expect(running(result.output.pid), "the background process was killed with the state").toBe(false);

        // The same on timeout: the script is stuck and its child holds the output.
        const stuckStarted = Date.now();
        const stuck = await run(node("n", "python", [
            "import subprocess, sys, time",
            'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])',
            "while True: time.sleep(1)",
        ].join("\n"), { success: "done" }, 1));
        expect(stuck).toMatchObject({ outcome: "timeout", resultSource: "timeout" });
        expect(Date.now() - stuckStarted).toBeLessThan(10_000);
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

/**
 * These controller tests give scripts a fixed set of tools by name. In a
 * worker the tools are the parent agent's, run through a Copilot CLI tool
 * session (see workflow-tool-session.test.js); here a fake executor stands
 * in for that session, with a captured set that includes a shell so every
 * runtime is allowed.
 */
function withFakeTools(deps) {
    const { resolveTools, ...rest } = deps;
    if (rest.resolveToolBinding) return rest;
    const lookup = resolveTools ?? (async () => new Map());
    return {
        ...rest,
        resolveToolBinding: async (sessionId) => ({
            policy: "parent-tools-v1", parentSessionId: "parent", owner: { provider: "test", subject: "t" }, config: {},
            capabilities: { revision: 0, selections: [] }, excludedTools: [], tools: [{ name: "bash", schemaHash: "h" }], sessionId,
        }),
        openToolExecutor: async (sessionId) => {
            let tools = null;
            return {
                async call(name, args) {
                    tools ??= await lookup(sessionId);
                    const handler = tools.get(name);
                    if (!handler) throw new Error(`Tool '${name}' is not available to workflow scripts.`);
                    return handler(args);
                },
                async close() {},
            };
        },
    };
}

async function startRuntime(provider, deps, runtimeOptions = {}) {
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", ...runtimeOptions });
    registerWorkflowActivities(runtime, withFakeTools(deps));
    for (const registration of WORKFLOW_SESSION_ORCHESTRATION_REGISTRY) {
        runtime.registerOrchestrationVersioned(WORKFLOW_SESSION_ORCHESTRATION_NAME, registration.version, registration.handler);
    }
    await runtime.start();
    return runtime;
}

async function runWorkflow(yaml, { deps = {}, inputs = {}, parentSessionId, extra = {} } = {}) {
    const provider = await SqliteProvider.inMemory();
    const catalog = fakeCatalog();
    const notifications = [];
    const fullDeps = {
        catalog,
        stateTypes: () => SCRIPTS,
        resolveTools: async () => new Map(),
        notifyParent: async (parent, prompt, sender, clientMessageId) => {
            const endSavedFirst = catalog.events.some((e) => /^workflow\.(completed|failed|cancelled)$/.test(e.eventType) && e.data?.result);
            notifications.push({ parent, prompt, sender, clientMessageId, endSavedFirst });
        },
        ...deps,
    };
    const runtime = await startRuntime(provider, fullDeps);
    try {
        const client = new Client(provider);
        const sessionId = `wf-${Math.random().toString(36).slice(2)}`;
        const instanceId = `session-${sessionId}`;
        await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
            sessionId, yaml, inputs, ...(parentSessionId ? { parentSessionId } : {}), ...extra,
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
        expect(notifications[0].sender).toEqual({ kind: "system", display: "workflow" });
        expect(notifications[0].prompt).toBe(`[SYSTEM: Workflow ${sessionId} finished: completed, outcome "succeeded", 3 steps. Read its result with read_workflow_result("${sessionId}").]`);
        expect(notifications[0].clientMessageId).toBe(`workflow:${sessionId}:terminal`);
        // The full result was saved with the end record before the parent was told.
        const end = catalog.events.find((e) => e.eventType === "workflow.completed");
        expect(end.data.result).toMatchObject({ sessionId, status: "completed", outcome: "succeeded", stateId: "reported", steps: 3, summary: "Reported.", output: { reported: 3 }, error: null, reason: null });
        expect(notifications[0].endSavedFirst).toBe(true);
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
  finished: { type: terminal, outcome: succeeded, output: "\${states.tick.result}" }
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
    output: { limit: "\${inputs.limit}", seen: "\${states.check.result}" }
`;
        const { status, catalog, notifications } = await runWorkflow(yaml, { inputs: { limit: 50 }, parentSessionId: "p" });
        expect(status.output).toMatchObject({
            status: "failed", outcome: "failed", stateId: "refused", summary: "Limit is over 10.",
            output: { limit: 50, seen: { limit: 50 } }, steps: 1,
        });
        expect(catalog.updates.at(-1)).toMatchObject({ state: "failed", lastError: "Limit is over 10." });
        expect(catalog.events.at(-1)).toMatchObject({ eventType: "workflow.failed", data: { stateId: "refused", outcome: "failed", summary: "Limit is over 10." } });
        expect(notifications[0].prompt).toMatch(/^\[SYSTEM: Workflow \S+ finished: failed, outcome "failed", 1 step\. Read its result with read_workflow_result/);
        expect(notifications[0].prompt).not.toMatch(/Limit is over 10/);

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
        expect(notifications[0].prompt).toMatch(/^\[SYSTEM: Workflow \S+ failed after 1 step\. Read its result with read_workflow_result/);
        expect(notifications[0].prompt).not.toMatch(/surprise/);
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
  done: { type: terminal, outcome: succeeded, output: "\${states.recover.result}" }
`;
        const unrouted = await runWorkflow(make("[success]", "{ success: done }"));
        expect(unrouted.status.output).toMatchObject({ status: "failed" });
        expect(unrouted.status.output.error).toMatch(/undeclared outcome 'failure'/);

        const routed = await runWorkflow(make("[success, failure]", "{ success: done, failure: recover }"));
        expect(routed.status.output).toMatchObject({ status: "completed", outcome: "succeeded", output: { recoveredFrom: 7 }, steps: 2 });
    });

    it("fails without running a script when the worker has workflows off", async () => {
        let ran = false;
        const { status, catalog } = await runWorkflow(BRANCHING_YAML, {
            deps: { stateTypes: () => new Set(), runNode: async () => { ran = true; throw new Error("must not run"); } },
        });
        expect(ran).toBe(false);
        expect(status.output).toMatchObject({ status: "failed", workflowName: null, steps: 0 });
        expect(status.output.error).toBe(WORKFLOWS_DISABLED_MESSAGE);
        expect(catalog.events.map((event) => event.eventType)).toEqual(["workflow.failed"]);
    });

    it("fails without running a script when the worker runs other state types but not script", async () => {
        let ran = false;
        const { status } = await runWorkflow(BRANCHING_YAML, {
            deps: { stateTypes: () => new Set(["agent"]), runNode: async () => { ran = true; throw new Error("must not run"); } },
        });
        expect(ran).toBe(false);
        expect(status.output).toMatchObject({ status: "failed", steps: 0 });
        expect(status.output.error).toBe(WORKFLOW_SCRIPTS_DISABLED_MESSAGE);
        expect(status.output.error).toMatch(/uses state type 'script', which this worker does not run\. An operator adds it to PILOTSWARM_WORKFLOW_STATE_TYPES/);
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
  done: { type: terminal, outcome: succeeded, output: "\${states.second.result}" }
`;
        const ok = (output) => ({ outcome: "success", output, resultSource: "reported", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", toolCalls: [] });
        let releaseHang;
        const firstRuntime = await startRuntime(provider, {
            catalog, stateTypes: () => SCRIPTS, resolveTools: async () => new Map(), notifyParent: async () => {},
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
            catalog, stateTypes: () => SCRIPTS, resolveTools: async () => new Map(), notifyParent: async () => {},
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
  done: { type: terminal, outcome: succeeded, output: "\${states.slow.result}" }
`;

async function startLongWorkflow({ runNode, parentSessionId = "parent-1" } = {}) {
    const provider = await SqliteProvider.inMemory();
    const catalog = fakeCatalog();
    const notifications = [];
    const deleted = [];
    const runtime = await startRuntime(provider, {
        catalog,
        stateTypes: () => SCRIPTS,
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
            expect(notifications.map((n) => n.prompt)).toEqual([expect.stringMatching(/^\[SYSTEM: Workflow \S+ was cancelled after 2 steps\. Read its result with read_workflow_result\("\S+"\)\.\]$/)]);
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
                catalog, canvas, stateTypes: () => SCRIPTS, resolveTools: async () => new Map(), notifyParent: async () => {},
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

describe("compiled graph sanity", () => {
    it("compiles the branching example used above", () => {
        const compiled = compileWorkflow(BRANCHING_YAML);
        expect(Object.keys(compiled.states)).toEqual(["collect", "decide", "report", "reported", "nothing"]);
        expect(compiled.states.decide.next).toEqual({ many: "report", few: "nothing" });
        expect(compiled.states.collect.timeoutSeconds).toBe(300);
        expect(compiled.states.nothing).toMatchObject({ type: "terminal", outcome: "blocked" });
    });
});

// ─── Wait states ────────────────────────────────────────────────

describe("workflow wait states (duroxide)", () => {
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

    const waitsOf = (catalog) => catalog.events.filter((e) => e.eventType === "workflow.state_waiting");
    // The wait's end is published once the wait step has recorded it and the timer is set.
    const waitingStatus = async (client, instanceId) => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            const raw = (await client.getStatus(instanceId))?.customStatus;
            const status = raw ? JSON.parse(raw) : null;
            if (status?.workflow?.waitingUntil) return status;
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("timed out waiting for the run to be waiting");
    };

    it("a polling loop waits between checks, crosses continue-as-new, and runs every state exactly as the graph says", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: poll, version: "1" }
initial: check
states:
  check: { type: script, runtime: node, source: stub, completion: { outcomes: [found, idle] }, transition: { next: { found: finished, idle: a } } }
  a: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: b } } }
  b: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: c } } }
  c: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: nap } } }
  nap: { type: wait, seconds: 1, transition: { next: check } }
  finished: { type: terminal, outcome: succeeded, output: "\${states.check.result}" }
`;
        const ran = [];
        let checks = 0;
        const started = Date.now();
        const { status, catalog, executions, custom } = await runWorkflow(yaml, {
            deps: {
                runNode: async (request) => {
                    ran.push(request.node.id);
                    if (request.node.id !== "check") return okResult({ seen: request.priorOutput });
                    checks += 1;
                    return { ...okResult({ checks }), outcome: checks < 5 ? "idle" : "found" };
                },
            },
        });
        const elapsed = Date.now() - started;
        expect(status.status).toBe("Completed");
        // 4 loops of check, a, b, c and a wait (20 steps), then the check that finds work.
        expect(status.output).toMatchObject({ status: "completed", outcome: "succeeded", stateId: "finished", steps: 21, output: { checks: 5 } });
        expect(ran).toEqual([...Array(4).fill(["check", "a", "b", "c"]).flat(), "check"]);
        expect(executions === null || executions.length >= 2, "the run continued as new").toBe(true);
        const waits = waitsOf(catalog);
        expect(waits.map((e) => [e.data.stateId, e.data.step, e.data.seconds, e.data.visit])).toEqual([
            ["nap", 5, 1, 1], ["nap", 10, 1, 2], ["nap", 15, 1, 3], ["nap", 20, 1, 4],
        ]);
        for (const wait of waits) expect(typeof wait.data.until).toBe("number");
        expect(elapsed).toBeGreaterThanOrEqual(4 * 1000 - 100);
        // Each script state's runs are numbered across continue-as-new.
        expect(catalog.events.filter((e) => e.eventType === "workflow.state_started" && e.data.stateId === "check").map((e) => e.data.visit))
            .toEqual([1, 2, 3, 4, 5]);
        expect(custom).toMatchObject({ status: "completed", workflow: { stateId: "finished", step: 21 } });
    });

    it("cancel ends a run while it waits, at once, and the parent is told why", async () => {
        const provider = await SqliteProvider.inMemory();
        const catalog = fakeCatalog();
        const notifications = [];
        const runtime = await startRuntime(provider, {
            catalog, stateTypes: () => SCRIPTS, resolveTools: async () => new Map(),
            notifyParent: async (parent, prompt) => { notifications.push({ parent, prompt }); },
            runNode: async () => okResult(null),
        });
        try {
            const client = new Client(provider);
            const instanceId = "session-wait-cancel";
            await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
                sessionId: "wait-cancel", parentSessionId: "parent-1", inputs: {}, yaml: `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: long-wait, version: "1" }
initial: first
states:
  first: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: nap } } }
  nap: { type: wait, seconds: 600, transition: { next: first } }
`,
            }, WORKFLOW_SESSION_LATEST_VERSION);
            const waiting = await waitingStatus(client, instanceId);
            expect(waitsOf(catalog)).toHaveLength(1);
            expect(waiting).toMatchObject({ status: "running", workflow: { stateId: "nap", step: 2 } });
            expect(waiting.workflow.waitingUntil).toBe(waitsOf(catalog)[0].data.until);

            const sent = Date.now();
            await client.enqueueEvent(instanceId, "messages", command("cancel"));
            const status = await client.waitForOrchestration(instanceId, 20_000);
            expect(Date.now() - sent).toBeLessThan(5_000);
            expect(status.output).toMatchObject({ status: "cancelled", stateId: "nap", steps: 2, reason: "cancel by test" });
            expect(catalog.events.map((e) => e.eventType).slice(-2)).toEqual(["workflow.state_waiting", "workflow.cancelled"]);
            expect(notifications.map((n) => n.prompt)).toEqual([expect.stringMatching(/^\[SYSTEM: Workflow \S+ was cancelled after 2 steps\. Read its result with read_workflow_result\("\S+"\)\.\]$/)]);
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("a stray message during a wait does not cut it short or end the run", async () => {
        const provider = await SqliteProvider.inMemory();
        const catalog = fakeCatalog();
        const runtime = await startRuntime(provider, {
            catalog, stateTypes: () => SCRIPTS, resolveTools: async () => new Map(), notifyParent: async () => {},
            runNode: async () => okResult(null),
        });
        try {
            const client = new Client(provider);
            const instanceId = "session-wait-stray";
            await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
                sessionId: "wait-stray", inputs: {}, yaml: `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: stray, version: "1" }
initial: nap
states:
  nap: { type: wait, seconds: 2, transition: { next: after } }
  after: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: done } } }
  done: { type: terminal, outcome: succeeded }
`,
            }, WORKFLOW_SESSION_LATEST_VERSION);
            const deadline = Date.now() + 20_000;
            while (!waitsOf(catalog).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
            const until = waitsOf(catalog)[0].data.until;
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: "hello" }));
            const status = await client.waitForOrchestration(instanceId, 20_000);
            expect(status.output).toMatchObject({ status: "completed", steps: 2 });
            const afterStarted = catalog.events.find((e) => e.eventType === "workflow.state_started" && e.data.stateId === "after");
            expect(afterStarted, "the state after the wait ran").toBeTruthy();
            expect(Date.now()).toBeGreaterThanOrEqual(until - 50);
        } finally {
            await runtime.shutdown(100);
        }
    });

    it("a worker restart during a wait resumes the same timer and does not re-run the state before it", async () => {
        const provider = await SqliteProvider.inMemory();
        const catalog = fakeCatalog();
        const ran = [];
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: restart-wait, version: "1" }
initial: first
states:
  first: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: nap } } }
  nap: { type: wait, seconds: 8, transition: { next: second } }
  second: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: done } } }
  done: { type: terminal, outcome: succeeded, output: "\${states.second.result}" }
`;
        const deps = (label) => ({
            catalog, stateTypes: () => SCRIPTS, resolveTools: async () => new Map(), notifyParent: async () => {},
            runNode: async (request) => { ran.push(`${label}:${request.node.id}`); return okResult({ by: label, prior: request.priorOutput }); },
        });
        // A short lock lets the second runtime take over work the first held when it stopped.
        const firstRuntime = await startRuntime(provider, deps("rt1"), { workerLockTimeoutMs: 1_000 });
        const client = new Client(provider);
        const instanceId = "session-restart-wait";
        await client.startOrchestrationVersioned(instanceId, WORKFLOW_SESSION_ORCHESTRATION_NAME, {
            sessionId: "restart-wait", yaml, inputs: {},
        }, WORKFLOW_SESSION_LATEST_VERSION);
        // Stop the first worker once the run is waiting on its timer.
        const until = (await waitingStatus(client, instanceId)).workflow.waitingUntil;
        expect(waitsOf(catalog)[0].data.until).toBe(until);
        await firstRuntime.shutdown(100);
        // The worker is gone for most of the wait.
        await new Promise((r) => setTimeout(r, 6_000));
        const secondRuntime = await startRuntime(provider, deps("rt2"), { workerLockTimeoutMs: 1_000 });
        try {
            const status = await client.waitForOrchestration(instanceId, 30_000);
            const finishedAt = Date.now();
            expect(status.output).toMatchObject({ status: "completed", steps: 3, output: { by: "rt2", prior: { by: "rt1", prior: null } } });
            expect(ran).toEqual(["rt1:first", "rt2:second"]);
            expect(waitsOf(catalog)).toHaveLength(1);
            // The timer kept its original end: a wait restarted after the 6 s outage would end 6 s or more after it.
            expect(finishedAt - until, `finished ${finishedAt - until} ms after the wait's end`).toBeLessThan(2_000);
            expect(finishedAt).toBeGreaterThanOrEqual(until - 50);
        } finally {
            await secondRuntime.shutdown(100);
        }
    });

    it("a clock wait ends at the recorded next clock time and passes the last occurrence on, so a DST hour is not repeated", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: nightly, version: "1" }
initial: nightly
states:
  nightly: { type: wait, at: { hour: 2, minute: 0, tz: America/Los_Angeles }, transition: { next: report } }
  report: { type: script, runtime: node, source: stub, completion: { outcomes: [again, stop] }, transition: { next: { again: nightly, stop: done } } }
  done: { type: terminal, outcome: succeeded }
`;
        const calls = [];
        let reports = 0;
        const { status, catalog, custom } = await runWorkflow(yaml, {
            deps: {
                // A fake clock: "the next 02:00" is 800 ms after the wait starts.
                nextClockTime: (at, afterMs, lastOccurrenceKey) => {
                    calls.push({ at, afterMs, lastOccurrenceKey });
                    return { nextFireAtMs: afterMs + 800, occurrenceKey: `occ-${calls.length}`, localTime: `night ${calls.length}`, skippedOccurrences: 0 };
                },
                runNode: async () => { reports += 1; return { ...okResult(null), outcome: reports < 2 ? "again" : "stop" }; },
            },
        });
        expect(status.output).toMatchObject({ status: "completed", steps: 4 });
        expect(calls.map((c) => [c.at, c.lastOccurrenceKey])).toEqual([
            [{ minute: 0, hour: 2, tz: "America/Los_Angeles" }, undefined],
            [{ minute: 0, hour: 2, tz: "America/Los_Angeles" }, "occ-1"],
        ]);
        const waits = waitsOf(catalog);
        expect(waits.map((e) => [e.data.stateId, e.data.schedule, e.data.localTime, e.data.until - calls[waits.indexOf(e)].afterMs])).toEqual([
            ["nightly", "daily at 02:00 America/Los_Angeles", "night 1", 800],
            ["nightly", "daily at 02:00 America/Los_Angeles", "night 2", 800],
        ]);
        // The run waited for each recorded end before going on.
        const reportStarts = catalog.events.filter((e) => e.eventType === "workflow.state_started");
        expect(reportStarts).toHaveLength(2);
        expect(custom).toMatchObject({ status: "completed" });
    });

    it("a loop of script states that never waits fails at the limit; waiting resets the count", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: spin, version: "1" }
initial: a
states:
  a: { type: script, runtime: node, source: stub, completion: { outcomes: [again, rest, stop] }, transition: { next: { again: a, rest: nap, stop: done } } }
  nap: { type: wait, seconds: 1, transition: { next: a } }
  done: { type: terminal, outcome: succeeded }
`;
        const spinning = await runWorkflow(yaml, {
            extra: { maxScriptRunsBetweenWaits: 5 },
            deps: { runNode: async () => ({ ...okResult(null), outcome: "again" }) },
        });
        expect(spinning.status.output).toMatchObject({ status: "failed", steps: 5, stateId: "a" });
        expect(spinning.status.output.error).toMatch(/ran 5 script states without reaching a wait state/);

        let n = 0;
        const resting = await runWorkflow(yaml, {
            extra: { maxScriptRunsBetweenWaits: 5 },
            deps: { runNode: async () => { n += 1; return { ...okResult(null), outcome: n === 12 ? "stop" : n % 4 === 0 ? "rest" : "again" }; } },
        });
        // 12 script runs with two waits between them: never more than 5 in a row.
        expect(resting.status.output).toMatchObject({ status: "completed", steps: 14 });
    });
});

describe("workflow finish (duroxide)", () => {
    it("retries the end of a run when telling the parent fails, and records the end once", async () => {
        let attempts = 0;
        const notified = [];
        const ids = [];
        const { status, catalog, sessionId } = await runWorkflow(`
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: notify-retry, version: "1" }
initial: only
states:
  only: { type: script, runtime: node, source: stub, completion: { outcomes: [success] }, transition: { next: { success: done } } }
  done: { type: terminal, outcome: succeeded }
`, {
            parentSessionId: "parent-1",
            deps: {
                runNode: async () => okResult(null),
                notifyParent: async (parent, prompt, _sender, clientMessageId) => {
                    attempts += 1;
                    ids.push(clientMessageId);
                    if (attempts === 1) throw new Error("queue unavailable");
                    notified.push({ parent, prompt });
                },
            },
        });
        expect(status.output).toMatchObject({ status: "completed", outcome: "succeeded" });
        expect(attempts).toBe(2);
        expect(notified).toEqual([{ parent: "parent-1", prompt: expect.stringMatching(/finished: completed, outcome "succeeded"/) }]);
        expect(catalog.events.filter((e) => e.eventType === "workflow.completed")).toHaveLength(1);
        // Both attempts carry the same id, so the parent's queue keeps one of them.
        expect(ids).toEqual([`workflow:${sessionId}:terminal`, `workflow:${sessionId}:terminal`]);
    }, 30_000);
});

