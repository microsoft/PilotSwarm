/**
 * The Workflow script runner: real node / python / pwsh processes, their context, tool calls and results. No database,
 * worker or LLM is required.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { runScriptNode, SCRIPT_NODE_MAX_OUTPUT_BYTES } from "../../src/workflow/runner.js";

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
