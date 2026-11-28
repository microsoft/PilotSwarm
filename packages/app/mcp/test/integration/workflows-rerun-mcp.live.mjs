#!/usr/bin/env node
/**
 * Live MCP integration suite for Phase 3 I7 Task 8b: re-run a Workflow from a step over MCP.
 * Exercises the real `pilotswarm-mcp` binary over StdioClientTransport in direct mode (`startDirectEnv`) and in local no-auth
 * Web API mode (`startWebEnv`, the portal in this process):
 *   - run_again (source-revision default, then a fixed revision), continue and supply; key replay and 409 OPERATION_CONFLICT;
 *   - read_workflow: rerun_plan, visit.reused, visit.supplied, run.rerunOf and view.reruns; read_workflow_skill workflow-rerun;
 *   - 400 RERUN_ARGUMENT_REFUSED and 400 WORKFLOW_READ_INVALID;
 *   - OQ5: an answered approval is never reused over MCP (403 RERUN_APPROVAL_REUSED; rerun_plan allowed: false), while the
 *     owner's direct (non-MCP) plan may reuse it;
 *   - OQ1: the web owner's token without originating_session_id inherits the source's tool grant (grant: "inherited"); with
 *     originating_session_id, and in direct mode (no person), 409 WORKFLOW_TOOLS_UNAVAILABLE.
 * Sources that need a person's approval or an agent's tool grant are made in this process through the SDK (a person cannot
 * answer an approval over MCP, and only an agent session captures a tool grant).
 *
 * Usage: DATABASE_URL=... node packages/app/mcp/test/integration/workflows-rerun-mcp.live.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PilotSwarmManagementClient, workflowScriptsOptionFromEnv } from "pilotswarm-sdk";
import { startSessionWorkflowDefinition } from "../../../../../packages/sdk/dist/workflow/session-definitions.js";
import { nodeExecutionIdFor } from "../../../../../packages/sdk/dist/workflow/store.js";
import { WORKFLOW_TOOL_POLICY } from "../../../../../packages/sdk/dist/workflow/tool-policy.js";
import { startWebEnv, mcpStdioArgs, loadDotEnv } from "./web-env.mjs";
import { startDirectEnv } from "./direct-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../..");

const steps = (finishSource) => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: rerun-steps
  version: "1.0.0"
initial: prepare
states:
  prepare:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { n: 1 });
    transition:
      next:
        ok: finish
        failure: failed
  finish:
    type: script
    outcomes: [ok]
    source: |
      ${finishSource}
    transition:
      next:
        ok: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;
const STEPS_REV1 = steps('throw new Error("finish failed");');
const STEPS_REV2 = steps('await setResult("ok", { fixed: "revision 2" });');

const APPROVAL_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-approval, version: "1.0.0" }
initial: gate
states:
  gate:
    type: approval
    question: "Go on?"
    timeoutSeconds: 600
    transition: { next: { approved: after, rejected: failed, timed_out: failed } }
  after:
    type: script
    outcomes: [ok]
    source: |
      throw new Error("after failed");
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const TOOL_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-tools, version: "1.0.0" }
initial: first
states:
  first:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", {});
    transition: { next: { ok: second, failure: failed } }
  second:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.call === true) await callTool("read_facts", { key_pattern: "x" });
      throw new Error("second failed");
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const TOOL_CAPS = { revision: 1, selections: [{ sourceId: "pkg:demo", sourceRef: "pkg:demo", tools: ["read_facts"], mcpServers: [] }] };

const parse = (res) => {
    const text = res?.content?.[0]?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
};

async function runModeFlow(modeLabel, stdioOpts, principal) {
    const transport = new StdioClientTransport(stdioOpts);
    const client = new Client({ name: `wf-rerun-mcp-live-${modeLabel}`, version: "1.0.0" }, { capabilities: {} });
    const inproc = new PilotSwarmManagementClient({ store: process.env.DATABASE_URL, workflowCommands: {}, ...workflowScriptsOptionFromEnv() });
    await inproc.start();
    const catalog = inproc._catalog;
    const sessionsToClean = [];
    const call = async (name, args) => {
        const res = await client.callTool({ name, arguments: args });
        return { isError: res.isError === true, body: parse(res) };
    };
    const ok = async (name, args) => {
        const res = await call(name, args);
        assert.equal(res.isError, false, `${modeLabel}: ${name} ${JSON.stringify(args)} -> ${JSON.stringify(res.body)}`);
        return res.body;
    };
    const refused = async (name, args, code, status) => {
        const res = await call(name, args);
        assert.equal(res.isError, true, `${modeLabel}: ${name} must be refused ${code}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, code, `${modeLabel}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.status, status, `${modeLabel}: ${JSON.stringify(res.body)}`);
        return res.body;
    };
    const ended = async (workflowId, timeoutMs = 90_000) => {
        const deadline = Date.now() + timeoutMs;
        let view = null;
        while (Date.now() < deadline) {
            view = await ok("read_workflow", { session_id: workflowId });
            if (["completed", "failed", "cancelled"].includes(view?.run?.status)) return view;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(`${modeLabel}: ${workflowId} did not end: ${JSON.stringify(view?.run)}`);
    };
    const visit = (view, stateId) => [...(view.run.nodeExecutions ?? []), ...(view.run.openExecutions ?? [])]
        .find((row) => row.stateId === stateId && row.ordinal === 1);
    const ownerSession = async (title) => {
        const id = randomUUID();
        await catalog.createSession(id, { owner: principal, title });
        sessionsToClean.push(id);
        return id;
    };

    await client.connect(transport);
    try {
        const caps = await ok("get_capabilities", {});
        if (modeLabel === "web") assert.equal(caps.workflows?.rerun, true, "web: bootstrap advertises workflows.rerun");

        // 1. A source that fails at finish, started over MCP.
        const owner = await ownerSession(`rerun-owner-${modeLabel}`);
        const saved = await ok("workflow_definition", { operation: "save", owner_session_id: owner, name: "rerun-steps", yaml: STEPS_REV1, operation_id: `save-${owner}-1` });
        const source = await ok("workflow_definition", { operation: "start", owner_session_id: owner, definition_id: saved.definitionId, workspace: "none",
            notify_on_completion: false, key: "source-1" });
        sessionsToClean.push(source.workflowId);
        const sourceView = await ended(source.workflowId);
        assert.equal(sourceView.run.outcome, "failed", `${modeLabel}: the source fails at finish`);
        const prepareId = visit(sourceView, "prepare").nodeExecutionId;
        const finishId = visit(sourceView, "finish").nodeExecutionId;

        // 2. The plan: the failed step, the source revision, allowed; refusals for other selectors and for an output.
        const { rerunPlan: plan } = await ok("read_workflow", { session_id: source.workflowId, rerun_plan: {} });
        assert.equal(plan.from.stateId, "finish");
        assert.equal(plan.revision.target, 1);
        assert.equal(plan.allowed, true, `${modeLabel}: ${plan.blockedReason}`);
        await refused("read_workflow", { session_id: source.workflowId, rerun_plan: {}, run_id: source.runId }, "WORKFLOW_READ_INVALID", 400);
        await refused("read_workflow", { session_id: source.workflowId, rerun_plan: { outcome: "ok", output: { fixed: 1 } } }, "WORKFLOW_READ_INVALID", 400);

        // 3. The source revision is the default even after revision 2 is saved: the re-run fails at finish again.
        await ok("workflow_definition", { operation: "save", owner_session_id: owner, name: "rerun-steps", definition_id: saved.definitionId,
            expected_revision: 1, yaml: STEPS_REV2, operation_id: `save-${owner}-2` });
        for (const extra of [{ inputs: { a: 1 } }, { workspace: "none" }]) {
            await refused("workflow_definition", { operation: "start", owner_session_id: owner, rerun_from: { workflow_id: source.workflowId },
                operation_id: `refused-${randomUUID()}`, ...extra }, "RERUN_ARGUMENT_REFUSED", 400);
        }
        const again = await ok("workflow_definition", { operation: "start", owner_session_id: owner, rerun_from: { workflow_id: source.workflowId },
            notify_on_completion: false, key: "again-1" });
        sessionsToClean.push(again.workflowId);
        assert.equal(again.revision, 1, `${modeLabel}: source-revision default`);
        assert.equal(again.rerun.mode, "run_again");
        const againView = await ended(again.workflowId);
        assert.equal(againView.run.outcome, "failed");
        assert.equal(againView.run.rerunOf.workflowId, source.workflowId);
        assert.equal(visit(againView, "prepare").reused.executionId, prepareId, `${modeLabel}: prepare is reused`);
        assert.equal(visit(againView, "finish").reused, undefined, `${modeLabel}: finish ran again`);

        // 4. run_again on revision 2 completes.
        const fixed = await ok("workflow_definition", { operation: "start", owner_session_id: owner, revision: 2,
            rerun_from: { workflow_id: source.workflowId, execution_id: finishId, mode: "run_again" },
            notify_on_completion: false, key: "fixed-1" });
        sessionsToClean.push(fixed.workflowId);
        assert.equal(fixed.revision, 2);
        const fixedView = await ended(fixed.workflowId);
        assert.equal(fixedView.run.outcome, "succeeded", `${modeLabel}: ${JSON.stringify(fixedView.run)}`);

        // 5. continue from prepare: finish runs again (revision 1 fails).
        const cont = await ok("workflow_definition", { operation: "start", owner_session_id: owner,
            rerun_from: { workflow_id: source.workflowId, execution_id: prepareId, mode: "continue" }, notify_on_completion: false, key: "continue-1" });
        sessionsToClean.push(cont.workflowId);
        assert.equal(cont.rerun.mode, "continue");
        const contView = await ended(cont.workflowId);
        assert.equal(visit(contView, "prepare").reused.executionId, prepareId);
        assert.equal(visit(contView, "finish").reused, undefined);

        // 6. supply finish's result: the run completes without running finish; key replay; a changed note conflicts.
        const supplyArgs = { operation: "start", owner_session_id: owner, notify_on_completion: false, key: "supply-1",
            rerun_from: { workflow_id: source.workflowId, execution_id: finishId, mode: "supply", result: { outcome: "ok", output: { fixed: "supplied" } },
                note: "Checked in the external system." } };
        const supplied = await ok("workflow_definition", supplyArgs);
        sessionsToClean.push(supplied.workflowId);
        assert.equal(supplied.rerun.mode, "supply");
        const replay = await ok("workflow_definition", supplyArgs);
        assert.equal(replay.replayed, true);
        assert.equal(replay.workflowId, supplied.workflowId);
        await refused("workflow_definition", { ...supplyArgs, rerun_from: { ...supplyArgs.rerun_from, note: "Another note." } }, "OPERATION_CONFLICT", 409);
        const suppliedView = await ended(supplied.workflowId);
        assert.equal(suppliedView.run.outcome, "succeeded");
        assert.equal(visit(suppliedView, "finish").supplied.note, "Checked in the external system.");
        assert.equal(visit(suppliedView, "finish").supplied.from.executionId, finishId);
        assert.equal(suppliedView.run.rerunOf.mode, "supply");

        // 7. The source lists its re-runs.
        const reread = await ok("read_workflow", { session_id: source.workflowId });
        const rerunIds = (reread.reruns ?? []).map((item) => item.workflowId).sort();
        assert.deepEqual(rerunIds, [again.workflowId, fixed.workflowId, cont.workflowId, supplied.workflowId].sort(), `${modeLabel}: view.reruns`);

        // 8. OQ5: an answered approval is never reused over MCP; the owner's direct plan may reuse it.
        const gateSaved = await ok("workflow_definition", { operation: "save", owner_session_id: owner, name: "rerun-approval", yaml: APPROVAL_YAML,
            operation_id: `save-${owner}-gate` });
        const gated = await ok("workflow_definition", { operation: "start", owner_session_id: owner, definition_id: gateSaved.definitionId,
            workspace: "none", notify_on_completion: false, key: "gate-1" });
        sessionsToClean.push(gated.workflowId);
        const approvalId = nodeExecutionIdFor(gated.runId, "root", "gate", 1);
        let pending = null;
        for (const deadline = Date.now() + 60_000; Date.now() < deadline && !pending;) {
            const view = await ok("read_workflow", { session_id: gated.workflowId });
            pending = visit(view, "gate")?.approval?.contextSha256 ? visit(view, "gate").approval : null;
            if (!pending) await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(pending, `${modeLabel}: the approval opens`);
        await inproc.updateWorkflow(gated.workflowId, { operation: "approval_respond", operation_id: `answer-${approvalId}`, run_id: gated.runId,
            approval_id: approvalId, context_sha256: pending.contextSha256, decision: "approved" }, { principal });
        const gatedView = await ended(gated.workflowId);
        assert.equal(gatedView.run.outcome, "failed");
        const afterId = visit(gatedView, "after").nodeExecutionId;
        const mcpPlan = (await ok("read_workflow", { session_id: gated.workflowId, rerun_plan: { execution_id: afterId } })).rerunPlan;
        assert.equal(mcpPlan.allowed, false, `${modeLabel}: MCP never reuses an answered approval`);
        await refused("workflow_definition", { operation: "start", owner_session_id: owner, rerun_from: { workflow_id: gated.workflowId, execution_id: afterId },
            notify_on_completion: false, key: "gate-rerun-1" }, "RERUN_APPROVAL_REUSED", 403);
        const ownerPlan = (await inproc.readWorkflow(gated.workflowId, { rerunPlan: { executionId: afterId } }, { principal })).rerunPlan;
        assert.equal(ownerPlan.allowed, true, `${modeLabel}: the owner's direct plan may reuse it (${ownerPlan.blockedReason})`);

        // 9. OQ1: a source started with the owner's session tool grant (as the session's agent starts it).
        const toolOwner = await ownerSession(`rerun-tools-${modeLabel}`);
        await catalog.saveSessionCapabilities(toolOwner, 0, TOOL_CAPS);
        const toolSaved = await ok("workflow_definition", { operation: "save", owner_session_id: toolOwner, name: "rerun-tools", yaml: TOOL_YAML,
            operation_id: `save-${toolOwner}` });
        const host = await inproc._sessionForDefinitions(toolOwner);
        const toolSource = await startSessionWorkflowDefinition(host, {
            ownerSessionId: toolOwner, parentSessionId: toolOwner, definition: { definitionId: toolSaved.definitionId }, revision: 1, inputs: {},
            actor: { kind: "user", ...principal }, owner: principal, operationId: `tool-source-${toolOwner}`, notifyParent: false,
            workspace: null, workspaceDefaults: null,
            binding: {
                policy: WORKFLOW_TOOL_POLICY, parentSessionId: toolOwner, owner: principal, config: { workspace: null, workspaceDefaults: null },
                capabilities: TOOL_CAPS, tools: [{ name: "read_facts", schemaHash: "h-rf" }], sourceRevisions: { "pkg:demo": "rev-1" },
                excludedTools: [], boundAgentFingerprint: "fp-1",
            },
        });
        sessionsToClean.push(toolSource.workflowId);
        const toolView = await ended(toolSource.workflowId);
        assert.equal(toolView.run.outcome, "failed");
        const secondId = visit(toolView, "second").nodeExecutionId;
        const toolRerun = { operation: "start", owner_session_id: toolOwner, notify_on_completion: false,
            rerun_from: { workflow_id: toolSource.workflowId, execution_id: secondId } };
        await refused("workflow_definition", { ...toolRerun, key: "tools-proxied", originating_session_id: owner }, "WORKFLOW_TOOLS_UNAVAILABLE", 409);
        if (modeLabel === "web") {
            const inherited = await ok("workflow_definition", { ...toolRerun, key: "tools-owner" });
            sessionsToClean.push(inherited.workflowId);
            assert.equal(inherited.rerun.grant, "inherited", "web: the owner's token inherits the source's grant");
            assert.equal(Boolean(inherited.warnings?.some((w) => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING")), false);
            assert.equal((await ok("read_workflow", { session_id: toolSource.workflowId, rerun_plan: { execution_id: secondId } })).rerunPlan.grantSource, "inherited");
        } else {
            await refused("workflow_definition", { ...toolRerun, key: "tools-direct" }, "WORKFLOW_TOOLS_UNAVAILABLE", 409);
        }

        console.log(`✅ workflows-rerun-mcp.live.mjs [${modeLabel}] PASS`);
    } finally {
        for (const sid of sessionsToClean.reverse()) {
            await client.callTool({ name: "delete_session", arguments: { session_id: sid } }).catch(() => {});
        }
        await client.close().catch(() => {});
        await inproc.stop().catch(() => {});
    }
}

async function main() {
    loadDotEnv(ROOT);
    {
        const env = await startDirectEnv(ROOT);
        try {
            await runModeFlow("direct", env.mcpStdioArgs(), { provider: "entra", subject: `mcp-rerun-owner-${randomUUID()}` });
        } finally {
            await env.stop();
        }
    }
    {
        const env = await startWebEnv(ROOT);
        try {
            // The local no-auth portal's principal (see workflows-mcp.live.mjs).
            await runModeFlow("web", mcpStdioArgs(ROOT, env.apiUrl), { provider: "none", subject: "unknown" });
        } finally {
            await env.stop();
        }
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
