/**
 * Script workflow runtime: the script runner and the durable controller.
 *
 * Runner tests start real node / python / pwsh processes. Controller tests
 * run the real script-workflow orchestration on an in-memory duroxide
 * runtime. No database, worker or LLM is required.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { compileScriptWorkflow } from "../../src/script-workflow/compiler.js";
import { runScriptNode, SCRIPT_NODE_MAX_OUTPUT_BYTES } from "../../src/script-workflow/runner.js";
import {
    SCRIPT_WORKFLOW_ORCHESTRATION_NAME,
    SCRIPT_WORKFLOW_ORCHESTRATION_REGISTRY,
    SCRIPT_WORKFLOW_LATEST_VERSION,
    SCRIPT_WORKFLOW_STEPS_PER_EXECUTION,
} from "../../src/script-workflow/orchestration.js";
import {
    registerScriptWorkflowActivities,
    SCRIPT_WORKFLOWS_DISABLED_MESSAGE,
} from "../../src/script-workflow/activities.js";

const { Runtime, Client, SqliteProvider } = createRequire(import.meta.url)("duroxide");

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const hasPwsh = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "exit 0"]).status === 0;

function node(id, runtime, source, next = { success: null }, timeoutSeconds = 30) {
    return { id, runtime, source, next, timeoutSeconds };
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
    });
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
        const result = await run(node("n", "node", `await new Promise(() => setInterval(() => {}, 1000));`, { success: null }, 1));
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
    };
}

async function startRuntime(provider, deps, runtimeOptions = {}) {
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", ...runtimeOptions });
    registerScriptWorkflowActivities(runtime, deps);
    for (const registration of SCRIPT_WORKFLOW_ORCHESTRATION_REGISTRY) {
        runtime.registerOrchestrationVersioned(SCRIPT_WORKFLOW_ORCHESTRATION_NAME, registration.version, registration.handler);
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
        await client.startOrchestrationVersioned(instanceId, SCRIPT_WORKFLOW_ORCHESTRATION_NAME, {
            sessionId, yaml, inputs, ...(parentSessionId ? { parentSessionId } : {}),
        }, SCRIPT_WORKFLOW_LATEST_VERSION);
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
kind: ScriptWorkflow
metadata:
  name: branching
spec:
  entry: collect
  nodes:
    collect:
      type: script
      runtime: node
      source: |
        const fact = await callTool("read_facts", { key_pattern: context.inputs.key });
        await setResult("success", { count: fact.count });
      next:
        success: decide
    decide:
      type: script
      runtime: node
      source: |
        await setResult(context.input.count > 1 ? "many" : "few", context.input);
      next:
        many: report
        few: null
    report:
      type: script
      runtime: node
      source: |
        await setResult("done", { reported: context.input.count });
      next:
        done: null
`;

describe("script workflow controller (duroxide)", () => {
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
            status: "completed", workflowName: "branching", outcome: "done",
            output: { reported: 3 }, terminalNodeId: "report", steps: 3,
        });
        expect(toolCalls).toEqual([{ sid: sessionId, args: { key_pattern: "metrics/%" } }]);

        const types = catalog.events.map((event) => `${event.eventType}${event.data.nodeId ? `:${event.data.nodeId}` : ""}`);
        expect(types).toEqual([
            "workflow.started",
            "workflow.node_started:collect", "workflow.node_completed:collect",
            "workflow.node_started:decide", "workflow.node_completed:decide",
            "workflow.node_started:report", "workflow.node_completed:report",
            "workflow.completed",
        ]);
        expect(catalog.updates.at(0)).toMatchObject({ state: "running" });
        expect(catalog.updates.at(-1)).toMatchObject({ state: "completed", lastError: null });
        expect(custom).toMatchObject({ status: "completed", sessionKind: "workflow", workflow: { name: "branching", step: 3, outcome: "done" } });

        expect(notifications).toHaveLength(1);
        expect(notifications[0].parent).toBe("parent-1");
        expect(notifications[0].sender).toEqual({ kind: "system", display: "workflow branching" });
        expect(notifications[0].prompt).toMatch(/completed after 3 step\(s\)\. Outcome: done/);
    });

    it("ends early on an outcome whose target is null", async () => {
        const { status } = await runWorkflow(BRANCHING_YAML, {
            inputs: { key: "k" },
            deps: { resolveTools: async () => new Map([["read_facts", async () => ({ count: 1 })]]) },
        });
        expect(status.output).toMatchObject({ status: "completed", outcome: "few", terminalNodeId: "decide", steps: 2 });
    });

    it("continues as new to bound history and runs every node exactly once", async () => {
        const iterations = SCRIPT_WORKFLOW_STEPS_PER_EXECUTION * 2 + 5;
        const ran = [];
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata: { name: counter }
spec:
  entry: tick
  nodes:
    tick:
      type: script
      runtime: node
      source: "unused: runNode is stubbed"
      next: { again: tick, done: null }
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
        expect(status.output).toMatchObject({ outcome: "done", output: { count: iterations }, steps: iterations });
        expect(ran).toEqual(Array.from({ length: iterations }, (_, index) => index + 1));
        if (Array.isArray(executions)) expect(executions.length).toBeGreaterThanOrEqual(3);
    });

    it("fails the workflow on an undeclared outcome and tells the parent why", async () => {
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata: { name: strict }
spec:
  entry: only
  nodes:
    only:
      type: script
      runtime: node
      source: 'await setResult("surprise", null);'
      next: { success: null }
`;
        const { status, catalog, notifications } = await runWorkflow(yaml, { parentSessionId: "p" });
        expect(status.status).toBe("Completed");
        expect(status.output).toMatchObject({ status: "failed", workflowName: "strict", steps: 1 });
        expect(status.output.error).toMatch(/undeclared outcome 'surprise'/);
        expect(catalog.updates.at(-1)).toMatchObject({ state: "failed" });
        expect(catalog.events.at(-1).eventType).toBe("workflow.failed");
        expect(notifications[0].prompt).toMatch(/failed after 1 step\(s\)\. Error: .*surprise/);
    });

    it("fails a non-zero exit when the node does not route failure, and routes it when it does", async () => {
        const make = (next) => `
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata: { name: exits }
spec:
  entry: crash
  nodes:
    crash:
      type: script
      runtime: node
      source: 'process.exit(7)'
      next: ${next}
    recover:
      type: script
      runtime: node
      source: 'await setResult("success", { recoveredFrom: context.input.exitCode })'
      next: { success: null }
`;
        const unrouted = await runWorkflow(make("{ success: null }"));
        expect(unrouted.status.output).toMatchObject({ status: "failed" });
        expect(unrouted.status.output.error).toMatch(/undeclared outcome 'failure'/);

        const routed = await runWorkflow(make("{ success: null, failure: recover }"));
        expect(routed.status.output).toMatchObject({ status: "completed", output: { recoveredFrom: 7 }, steps: 2 });
    });

    it("fails without running a script when the worker has script workflows disabled", async () => {
        let ran = false;
        const { status, catalog } = await runWorkflow(BRANCHING_YAML, {
            deps: { enabled: () => false, runNode: async () => { ran = true; throw new Error("must not run"); } },
        });
        expect(ran).toBe(false);
        expect(status.output).toMatchObject({ status: "failed", workflowName: null, steps: 0 });
        expect(status.output.error).toBe(SCRIPT_WORKFLOWS_DISABLED_MESSAGE);
        expect(catalog.events.map((event) => event.eventType)).toEqual(["workflow.failed"]);
    });

    it("fails cleanly when the YAML is not a valid script workflow", async () => {
        const { status } = await runWorkflow(BRANCHING_YAML.replace("type: script", "type: agent"));
        expect(status.output).toMatchObject({ status: "failed", steps: 0 });
        expect(status.output.error).toMatch(/agent nodes are not supported/);
    });

    it("resumes on a new runtime after the worker stops mid-workflow without re-running finished nodes", async () => {
        const provider = await SqliteProvider.inMemory();
        const catalog = fakeCatalog();
        const ran = [];
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata: { name: restart }
spec:
  entry: first
  nodes:
    first: { type: script, runtime: node, source: "stub", next: { success: second } }
    second: { type: script, runtime: node, source: "stub", next: { success: null } }
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
        await client.startOrchestrationVersioned(instanceId, SCRIPT_WORKFLOW_ORCHESTRATION_NAME, {
            sessionId: "restart-wf", yaml, inputs: {},
        }, SCRIPT_WORKFLOW_LATEST_VERSION);

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

describe("compiled graph sanity", () => {
    it("compiles the branching example used above", () => {
        const compiled = compileScriptWorkflow(BRANCHING_YAML);
        expect(Object.keys(compiled.nodes)).toEqual(["collect", "decide", "report"]);
        expect(compiled.nodes.decide.next).toEqual({ many: "report", few: null });
        expect(compiled.nodes.collect.timeoutSeconds).toBe(300);
    });
});
