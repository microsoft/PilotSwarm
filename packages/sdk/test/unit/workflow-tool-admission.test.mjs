/**
 * Workflow tool admission and authority: what spawn_workflow captures,
 * when a call is refused at run time (the soft redeploy rule), the
 * language rule (python and powershell need a parent shell), and the
 * absence of any generic tool fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowRuntimeRefusal, workflowToolsIncludeShell } from "../../dist/workflow/tool-policy.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { registerWorkflowActivities, WORKFLOW_TOOL_BINDING_MISSING_MESSAGE } from "../../dist/workflow/activities.js";
import { WORKFLOW_ACTIVITIES } from "../../dist/workflow/orchestration.js";
import { spawnWorkflowFromTool } from "../../dist/workflow/spawn.js";
import { SessionManager } from "../../dist/session-manager.js";

// ── Authority, re-checked before every call ──────────────────────────

function authorityFixture({ parentState = "idle", parentDeleted = false, parentOwner = { provider: "dev", subject: "alice" }, liveSelections } = {}) {
    const owner = { provider: "dev", subject: "alice" };
    const rows = {
        parent: { sessionId: "parent", state: parentState, owner: parentOwner, ...(parentDeleted ? { deletedAt: new Date() } : {}) },
        wf: { sessionId: "wf", sessionKind: "workflow", parentSessionId: "parent", owner },
    };
    const captured = [{ sourceId: "pkg-a", tools: ["pkg_tool"], mcpServers: ["pkg-mcp"] }];
    const manager = new SessionManager(undefined, null, {});
    manager.setSessionCatalog({
        async getSession(id) { return rows[id] ?? null; },
        async getSessionCapabilities() { return { revision: 2, selections: liveSelections ?? captured }; },
    });
    const binding = {
        policy: "parent-tools-v1", parentSessionId: "parent", owner, config: {},
        capabilities: { revision: 1, selections: captured }, tools: [], excludedTools: [],
        sourceRevisions: { "pkg-a": "rev-1" }, boundAgentFingerprint: "captured-fingerprint",
    };
    return { manager, binding };
}

test("authority holds when only a package revision or the bound-agent fingerprint changed", async () => {
    const { manager, binding } = authorityFixture();
    // The worker knows no source at rev-1 and its fingerprint differs; neither refuses a call.
    await manager.authorizeWorkflowTools("wf", binding, { name: "pkg_tool" });
    await manager.authorizeWorkflowTools("wf", binding, { name: "bash" });
    await manager.authorizeWorkflowTools("wf", binding, { name: "pkg-mcp-x", mcpServerName: "pkg-mcp" });
});

test("authority is lost when the parent ended or was deleted, or the owner changed", async () => {
    for (const [options, code] of [
        [{ parentState: "completed" }, "WORKFLOW_PARENT_AUTHORITY_LOST"],
        [{ parentState: "cancelled" }, "WORKFLOW_PARENT_AUTHORITY_LOST"],
        [{ parentDeleted: true }, "WORKFLOW_PARENT_AUTHORITY_LOST"],
        [{ parentOwner: { provider: "dev", subject: "bob" } }, "WORKFLOW_OWNER_CHANGED"],
    ]) {
        const { manager, binding } = authorityFixture(options);
        await assert.rejects(manager.authorizeWorkflowTools("wf", binding, { name: "bash" }), { code }, JSON.stringify(options));
    }
});

test("a revoked capability refuses only the tools it gave", async () => {
    const { manager, binding } = authorityFixture({ liveSelections: [] });
    await assert.rejects(manager.authorizeWorkflowTools("wf", binding, { name: "pkg_tool" }), { code: "WORKFLOW_CAPABILITY_REVOKED" });
    await assert.rejects(manager.authorizeWorkflowTools("wf", binding, { name: "x", mcpServerName: "pkg-mcp" }), { code: "WORKFLOW_CAPABILITY_REVOKED" });
    await manager.authorizeWorkflowTools("wf", binding, { name: "bash" });
    const narrowed = authorityFixture({ liveSelections: [{ sourceId: "pkg-a", tools: [], mcpServers: ["pkg-mcp"] }] });
    await assert.rejects(narrowed.manager.authorizeWorkflowTools("wf", narrowed.binding, { name: "pkg_tool" }), { code: "WORKFLOW_CAPABILITY_REVOKED" });
    await narrowed.manager.authorizeWorkflowTools("wf", narrowed.binding, { name: "x", mcpServerName: "pkg-mcp" });
});

test("capture refuses a parent with no live session on this worker", async () => {
    const manager = new SessionManager(undefined, null, {});
    manager.setSessionCatalog({ async getSession() { return null; } });
    await assert.rejects(manager.captureWorkflowToolBinding("not-live"), { code: "WORKFLOW_PARENT_CONTEXT_REQUIRED" });
});

// ── Languages ─────────────────────────────────────────────────────────

const workflowOf = (...runtimes) => compileWorkflow(`
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: languages, version: 1.0.0 }
initial: s0
states:
${runtimes.map((runtime, i) => `  s${i}:
    type: script
    runtime: ${runtime}
    source: "x"
    completion: { outcomes: [done] }
    transition: { next: { done: ${i + 1 < runtimes.length ? `s${i + 1}` : "end"} } }`).join("\n")}
  end: { type: terminal, outcome: succeeded }
`);

test("node scripts are always allowed; python and powershell need a parent shell", () => {
    const withShell = [{ name: "bash" }, { name: "view" }];
    const windowsShell = [{ name: "powershell" }];
    const noShell = [{ name: "view" }, { name: "store_fact" }];
    const mcpNamedBash = [{ name: "bash", mcpServerName: "tools", mcpToolName: "bash" }];
    assert.equal(workflowRuntimeRefusal(workflowOf("node"), noShell), null);
    assert.equal(workflowRuntimeRefusal(workflowOf("node"), []), null);
    for (const runtime of ["python", "powershell"]) {
        assert.equal(workflowRuntimeRefusal(workflowOf("node", runtime), withShell), null, runtime);
        assert.equal(workflowRuntimeRefusal(workflowOf(runtime), windowsShell), null, runtime);
        assert.match(workflowRuntimeRefusal(workflowOf("node", runtime), noShell),
            /^Python and PowerShell scripts need the parent agent to have a shell tool \(bash or powershell\); use runtime: node\. States: 's1' \((python|powershell)\)\.$/);
        assert.ok(workflowRuntimeRefusal(workflowOf(runtime), mcpNamedBash), "an MCP tool named bash is not the CLI shell");
    }
    assert.equal(workflowToolsIncludeShell(withShell), true);
    assert.equal(workflowToolsIncludeShell(mcpNamedBash), false);
});

const pythonYaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: py, version: 1.0.0 }
initial: run
states:
  run:
    type: script
    runtime: python
    source: print(1)
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded }
`;

function spawnDeps(tools) {
    const created = [];
    return {
        created,
        deps: {
            parentSessionId: "parent-agent",
            stateTypes: () => new Set(["script"]),
            getSession: async () => null,
            resolveOwner: async () => ({ provider: "dev", subject: "alice" }),
            captureToolBinding: async () => ({ policy: "parent-tools-v1", parentSessionId: "parent-agent", owner: { provider: "dev", subject: "alice" },
                config: {}, capabilities: { revision: 0, selections: [] }, excludedTools: [], tools }),
            createWorkflowSession: async (config, admission) => {
                created.push({ config, admission });
                return { sessionId: config.sessionId, workflowName: "py" };
            },
        },
    };
}

test("spawn_workflow refuses python without a parent shell, plainly, and starts it with one", async () => {
    const without = spawnDeps([{ name: "view", schemaHash: "h" }]);
    const refused = await spawnWorkflowFromTool({ yaml: pythonYaml }, { toolCallId: "a" }, without.deps);
    assert.match(refused, /^\[SYSTEM: spawn_workflow refused — Python and PowerShell scripts need the parent agent to have a shell tool \(bash or powershell\); use runtime: node\./);
    assert.equal(without.created.length, 0);
    const withShell = spawnDeps([{ name: "bash", schemaHash: "h" }]);
    assert.match(await spawnWorkflowFromTool({ yaml: pythonYaml }, { toolCallId: "b" }, withShell.deps), /^\[SYSTEM: started workflow session/);
    assert.deepEqual(withShell.created[0].admission.toolBinding.tools, [{ name: "bash", schemaHash: "h" }]);
});

test("spawn_workflow says when the parent's tools cannot be captured", async () => {
    const { deps } = spawnDeps([]);
    deps.captureToolBinding = async () => { throw Object.assign(new Error("This agent session has in-memory hooks or a permission handler, which a workflow cannot carry to another worker."), { code: "WORKFLOW_TOOLS_NOT_DELEGABLE" }); };
    assert.match(await spawnWorkflowFromTool({ yaml: pythonYaml }, { toolCallId: "c" }, deps),
        /^\[SYSTEM: spawn_workflow refused — This agent session has in-memory hooks .* Nothing was started\.\]$/);
});

// ── No generic fallback ───────────────────────────────────────────────

function activities(deps) {
    const registered = new Map();
    registerWorkflowActivities({ registerActivity: (name, fn) => registered.set(name, fn) }, {
        catalog: null, stateTypes: () => new Set(["script"]), notifyParent: async () => {}, ...deps,
    });
    return registered;
}

test("a workflow with script states and no captured tool set does not start, and its scripts do not run", async () => {
    let opened = 0, ran = 0;
    const registered = activities({
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { opened++; throw new Error("unreachable"); },
        runNode: async () => { ran++; return {}; },
    });
    const yaml = workflowOf("node");
    await assert.rejects(registered.get(WORKFLOW_ACTIVITIES.begin)(null, { sessionId: "wf", yaml: `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: n, version: 1.0.0 }
initial: s
states:
  s: { type: script, runtime: node, source: "x", completion: { outcomes: [done] }, transition: { next: { done: end } } }
  end: { type: terminal, outcome: succeeded }
` }), (error) => error.message === WORKFLOW_TOOL_BINDING_MISSING_MESSAGE);
    await assert.rejects(registered.get(WORKFLOW_ACTIVITIES.runScript)(null, {
        sessionId: "wf", workflowName: "n", stateId: "s0", node: yaml.states.s0, inputs: {}, priorOutput: null, step: 1,
    }), /WORKFLOW_PARENT_CONTEXT_REQUIRED/);
    assert.equal(opened, 0);
    assert.equal(ran, 0);
});

test("a saved binding without a shell stops a python state before it runs", async () => {
    let ran = 0;
    const registered = activities({
        resolveToolBinding: async () => ({ policy: "parent-tools-v1", tools: [{ name: "view", schemaHash: "h" }] }),
        openToolExecutor: async () => { throw new Error("unreachable"); },
        runNode: async () => { ran++; return {}; },
    });
    const workflow = workflowOf("python");
    await assert.rejects(registered.get(WORKFLOW_ACTIVITIES.runScript)(null, {
        sessionId: "wf", workflowName: "n", stateId: "s0", node: workflow.states.s0, inputs: {}, priorOutput: null, step: 1,
    }), /WORKFLOW_RUNTIME_REQUIRES_SHELL/);
    assert.equal(ran, 0);
});

test("the tool session opens at the first call, once, and closes when the state ends", async () => {
    const events = [];
    const registered = activities({
        resolveToolBinding: async () => ({ policy: "parent-tools-v1", tools: [] }),
        openToolExecutor: async (sessionId, _binding, step) => {
            events.push(`open ${sessionId} ${step}`);
            return { call: async (name) => { events.push(`call ${name}`); return { ok: true }; }, close: async () => { events.push("close"); } };
        },
        runNode: async (request) => {
            events.push("start");
            await request.callTool({ name: "a", arguments: {} });
            await request.callTool({ name: "b", arguments: {} });
            return { outcome: "done", output: null, resultSource: "reported", exitCode: 0, durationMs: 1, stdoutTail: "", stderrTail: "", toolCalls: [] };
        },
    });
    const workflow = workflowOf("node");
    await registered.get(WORKFLOW_ACTIVITIES.runScript)(null, {
        sessionId: "wf", workflowName: "n", stateId: "s0", node: workflow.states.s0, inputs: {}, priorOutput: null, step: 3,
    });
    assert.deepEqual(events, ["start", "open wf 3", "call a", "call b", "close"]);

    const quiet = [];
    const noCalls = activities({
        resolveToolBinding: async () => ({ policy: "parent-tools-v1", tools: [] }),
        openToolExecutor: async () => { quiet.push("open"); return { call: async () => null, close: async () => {} }; },
        runNode: async () => ({ outcome: "done", output: null, resultSource: "reported", exitCode: 0, durationMs: 1, stdoutTail: "", stderrTail: "", toolCalls: [] }),
    });
    await noCalls.get(WORKFLOW_ACTIVITIES.runScript)(null, {
        sessionId: "wf", workflowName: "n", stateId: "s0", node: workflow.states.s0, inputs: {}, priorOutput: null, step: 1,
    });
    assert.deepEqual(quiet, [], "a state with no tool call opens no CLI session");
});
