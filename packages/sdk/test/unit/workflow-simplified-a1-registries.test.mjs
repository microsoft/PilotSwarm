/**
 * A1 on every registry and server path (review SF-2). A session inside a Workflow (an agent node's chat and its
 * sub-agents) gets no definition tools from the SDK (workflow-simplified-a1.test.mjs), and also:
 * - no MCP server's spawn_workflow or update_workflow (a person-mode update_workflow of the PilotSwarm MCP server, or
 *   any other): its CLI handle filters them out, and a call of one is refused where calls are permitted;
 * - a person's workflow command that names the session it comes from (management client, Web API, MCP) is refused a
 *   definition operation when that session is inside a Workflow; a lineage that cannot be read refuses it.
 * The residual: a caller that holds a person's credential and names no session is that person (the receipt's known limit).
 *
 * Run: node --test test/unit/workflow-simplified-a1-registries.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../dist/session-manager.js";
import {
    WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT, WORKFLOW_DEFINITION_TOOLS_REFUSED, workflowDefinitionMcpPermission, workflowDefinitionMcpToolFilters,
} from "../../dist/workflow/input-policy.js";
import { refuseDefinitionFromInsideWorkflow, updateWorkflowForPerson, workflowCommandStatus } from "../../dist/workflow/human-commands.js";

const ROOT = { childSessionId: "node-chat", nodeExecutionId: "nx-1", workflowSessionId: "W", controllingSessionId: "P", distance: 0 };

test("the MCP filters and the permission gate: any server's spawn_workflow and update_workflow, nothing else", () => {
    assert.deepEqual(workflowDefinitionMcpToolFilters(["pilotswarm", "github"]), [
        "mcp:pilotswarm-spawn_workflow", "pilotswarm-spawn_workflow", "mcp:pilotswarm-update_workflow", "pilotswarm-update_workflow",
        "mcp:pilotswarm-workflow_definition", "pilotswarm-workflow_definition",
        "mcp:github-spawn_workflow", "github-spawn_workflow", "mcp:github-update_workflow", "github-update_workflow",
        "mcp:github-workflow_definition", "github-workflow_definition",
    ]);
    assert.deepEqual(workflowDefinitionMcpToolFilters([]), []);
    const seen = [];
    const gate = workflowDefinitionMcpPermission((request, extra) => { seen.push([request, extra]); return { kind: "approve-once" }; });
    for (const toolName of ["update_workflow", "spawn_workflow", "workflow_definition"]) {
        assert.deepEqual(gate({ kind: "mcp", serverName: "any", toolName, toolTitle: toolName, readOnly: false }, "x"),
            { kind: "reject", feedback: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT });
    }
    assert.deepEqual(gate({ kind: "mcp", serverName: "pilotswarm", toolName: "read_workflow", readOnly: true }, "x"), { kind: "approve-once" });
    assert.deepEqual(gate({ kind: "shell" }, "y"), { kind: "approve-once" });
    assert.deepEqual(seen.map(([request, extra]) => [request.toolName ?? request.kind, extra]), [["read_workflow", "x"], ["shell", "y"]]);
});

/** A SessionManager with one base MCP server whose Copilot transport is stubbed; each handle's config. */
function managerFixture(t) {
    const home = fs.mkdtempSync(join(tmpdir(), "ps-wf-a1-registries-"));
    const configs = [];
    const manager = new SessionManager(undefined, null, { baseMcpServers: { pilotswarm: { type: "http", url: "http://127.0.0.1:9/mcp", tools: ["*"] } } }, home);
    manager.workflowScriptsEnabled = true;
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const open = config => {
        configs.push(config);
        fs.mkdirSync(join(home, config.sessionId), { recursive: true });
        return { disconnect: async () => {}, rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({ cancelled: true }) } } };
    };
    manager.ensureClient = async () => ({
        createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config),
        deleteSession: async () => {},
    });
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { manager, configs };
}

test("a session inside a Workflow is offered no MCP definition tool and is refused one; another session keeps them", async (t) => {
    const { manager, configs } = managerFixture(t);
    const mcpUpdate = { kind: "mcp", serverName: "pilotswarm", toolName: "update_workflow", toolTitle: "Update Workflow", readOnly: false };
    const mcpRead = { kind: "mcp", serverName: "pilotswarm", toolName: "read_workflow", toolTitle: "Read Workflow", readOnly: true };

    await manager.getOrCreate("node-chat", { toolNames: [], workflowInsideWorkflow: true }, { turnIndex: 0 });
    const inside = configs.at(-1);
    assert.deepEqual(Object.keys(inside.mcpServers), ["pilotswarm"]);
    for (const filter of ["mcp:pilotswarm-update_workflow", "pilotswarm-update_workflow", "mcp:pilotswarm-spawn_workflow"]) {
        assert.ok(inside.excludedTools.includes(filter), filter);
    }
    assert.deepEqual(await inside.onPermissionRequest(mcpUpdate, { sessionId: "node-chat" }), { kind: "reject", feedback: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT });
    assert.notEqual((await inside.onPermissionRequest(mcpRead, { sessionId: "node-chat" }))?.kind, "reject", "reading stays");

    await manager.getOrCreate("plain", { toolNames: [] }, { turnIndex: 0 });
    const outside = configs.at(-1);
    assert.ok(!outside.excludedTools.some(name => name.includes("update_workflow") || name.includes("spawn_workflow")));
    assert.notEqual((await outside.onPermissionRequest(mcpUpdate, { sessionId: "plain" }))?.kind, "reject", "an ordinary session keeps them");
});

/** A host whose workflow "wf" exists; the lineage of "node-chat" is inside a Workflow, "chat" is not, "broken" cannot be read. */
function hostOf() {
    const reads = [];
    return {
        reads,
        host: {
            catalog: { getSession: async id => { reads.push(["session", id]); return id === "wf" ? { sessionKind: "workflow", deletedAt: null } : null; } },
            store: {
                readDefinition: async id => { reads.push(["definition", id]); return null; },
                readWorkflowLineage: async id => {
                    reads.push(["lineage", id]);
                    if (id === "broken") throw new Error("lineage unavailable");
                    return id === "node-chat" ? { sessionId: id, level: 2, agentRoot: ROOT } : { sessionId: id, level: 1, agentRoot: null };
                },
            },
            duroxideClient: {},
        },
    };
}

const PERSON = { kind: "user", provider: "test", subject: "alice" };
const failureOf = async promise => {
    try { await promise; } catch (error) { return { code: error.code, message: error.message }; }
    return null;
};

test("a person's command that names a session inside a Workflow is refused a definition operation, before the workflow is read", async () => {
    for (const operation of ["replace_definition", "publish", "publish_and_start", "start"]) {
        const { host, reads } = hostOf();
        const failure = await failureOf(updateWorkflowForPerson({ operation, operation_id: "o-1" },
            { host, workflowSessionId: "wf", actor: PERSON, originatingSessionId: "node-chat" }));
        assert.deepEqual(failure, { code: WORKFLOW_DEFINITION_TOOLS_REFUSED, message: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT }, operation);
        assert.deepEqual(reads, [["lineage", "node-chat"]], `${operation}: only the caller's lineage was read`);
    }
    assert.equal(workflowCommandStatus(WORKFLOW_DEFINITION_TOOLS_REFUSED), 403);
    // A run or brake command from inside is not a definition operation; it goes on (here to the workflow's own checks).
    const { host } = hostOf();
    const pause = await failureOf(updateWorkflowForPerson({ operation: "pause", operation_id: "o-2" },
        { host, workflowSessionId: "wf", actor: PERSON, originatingSessionId: "node-chat" }));
    assert.equal(pause.code, "WORKFLOW_NOT_FOUND");
    // A session outside every Workflow, and no session named: as before.
    for (const originatingSessionId of ["chat", undefined, null]) {
        const outside = await failureOf(updateWorkflowForPerson({ operation: "publish", operation_id: "o-3" },
            { host: hostOf().host, workflowSessionId: "wf", actor: PERSON, originatingSessionId }));
        assert.equal(outside.code, "WORKFLOW_NOT_FOUND", String(originatingSessionId));
    }
    // A lineage that cannot be read refuses the command; a session id that is not one is refused as invalid.
    assert.equal((await failureOf(refuseDefinitionFromInsideWorkflow(hostOf().host.store, "publish", "broken"))).message, "lineage unavailable");
    for (const bad of ["", "  ", 42, "x".repeat(257)]) {
        assert.equal((await failureOf(refuseDefinitionFromInsideWorkflow(hostOf().host.store, "publish", bad))).code, "WORKFLOW_COMMAND_INVALID", String(bad));
    }
});
