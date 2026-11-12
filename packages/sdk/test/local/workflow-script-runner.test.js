/**
 * The Workflow script runner: real Node processes, their context, tool calls and results. No database, worker or LLM is
 * required.
 */
import { describe, it, expect } from "vitest";
import { runScriptNode } from "../../src/workflow/runner.js";
import { WorkflowPackageToolError } from "../../src/workflow/package-pins.js";

function node(id, source, timeoutSeconds = 30) {
    return { id, source, timeoutSeconds };
}

function run(nodeDef, extra = {}) {
    return runScriptNode({
        sessionId: "session-under-test",
        node: nodeDef,
        context: { workflow: "wf", node: nodeDef.id, step: 1, inputs: { a: 2, b: 3 }, input: { from: "previous" } },
        callTool: async () => { throw new Error("no tools in this test"); },
        ...extra,
    });
}

describe("script runner", () => {
    it("stores a host package refusal only for a failing exit, not a handled valid result", async () => {
        const error = new WorkflowPackageToolError("fixture", {
            packageId: "package-id", package: "fixture-tools", version: "1.0.0", revision: "a".repeat(64),
            ownership: "owned", state: "unavailable", reason: "disabled",
        });
        const callTool = async () => { throw error; };
        const failed = await run(node("n", `await callTool("fixture", {});`), { callTool });
        expect(failed).toMatchObject({ resultSource: "exit", exitCode: 1,
            toolFailure: { message: error.message, details: error.details } });
        const handled = await run(node("n", `
            try { await callTool("fixture", {}); }
            catch { await setResult("handled", { unavailable: true }); }
        `), { callTool });
        expect(handled).toMatchObject({ resultSource: "reported", outcome: "handled", output: { unavailable: true } });
        expect(handled.toolFailure).toBeUndefined();
    });

    it("does not blame a caught package refusal for a later unrelated exception", async () => {
        const result = await run(node("n", `
            try { await callTool("fixture", {}); } catch {}
            throw new Error("unrelated script failure");
        `), { callTool: async () => { throw new WorkflowPackageToolError("fixture", {
            packageId: "package-id", package: "fixture-tools", version: "1.0.0", revision: "a".repeat(64),
            ownership: "owned", state: "unavailable", reason: "deleted",
        }); } });
        expect(result).toMatchObject({ resultSource: "exit", exitCode: 1 });
        expect(result.toolFailure).toBeUndefined();
        expect(result.output.stderr).toContain("unrelated script failure");
    });

    it("routes a node script's tool call to the session tool set and takes its reported result", async () => {
        const calls = [];
        const result = await run(node("n", `
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
        const result = await run(node("n", `
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
            const result = await run(node("n", `
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
        const result = await run(node("n", `
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
        const ok = await run(node("n", `console.log("plain text")`));
        expect(ok).toMatchObject({ outcome: "success", output: "plain text", resultSource: "exit", exitCode: 0 });

        const bad = await run(node("n", `console.error("boom"); process.exit(3);`));
        expect(bad).toMatchObject({ outcome: "failure", resultSource: "exit", exitCode: 3 });
        expect(bad.output).toMatchObject({ exitCode: 3 });
        expect(bad.output.stderr).toMatch(/boom/);
    });

    it("kills a script that runs past its timeout and reports outcome timeout", async () => {
        const started = Date.now();
        const result = await run(node("n", `await new Promise(() => setInterval(() => {}, 1000));`, 1));
        expect(result).toMatchObject({ outcome: "timeout", resultSource: "timeout", output: { timeoutSeconds: 1 } });
        expect(Date.now() - started).toBeLessThan(10_000);
    });
});
