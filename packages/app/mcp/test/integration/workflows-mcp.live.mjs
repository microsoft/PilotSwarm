#!/usr/bin/env node
/**
 * Live MCP integration suite for Phase 4 (Unit G: Workflows over MCP).
 * Exercises the real `pilotswarm-mcp` binary over StdioClientTransport in BOTH:
 *   1) Direct mode (`startDirectEnv`, sharing SESSION_STATE_DIR and ARTIFACT_DIR)
 *   2) Local no-auth Web API mode (`startWebEnv`)
 *
 * (Deployed-cluster authed Web MCP run is skipped ahead of owner sign-off per parent instructions.)
 *
 * Usage: node packages/app/mcp/test/integration/workflows-mcp.live.mjs
 */
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadSkillsSync } from "pilotswarm-sdk";
import { WORKFLOW_SKILLS_DIR } from "../../../../../packages/sdk/dist/workflow/guidance.js";
import { startWebEnv, mcpStdioArgs } from "./web-env.mjs";
import { startDirectEnv } from "./direct-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../..");

const ECHO_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: echo-flow
  version: "1.0.0"
inputs:
  schema:
    type: object
    required: [text]
    properties:
      text: { type: string }
    additionalProperties: false
initial: emit
states:
  emit:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { echoed: String(context.inputs.text ?? "") });
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

const ECHO_CARD = `---
name: echo-flow
description: Echoes input text through a simple script workflow.
whenToUse: When verifying packaged workflows over MCP.
inputs:
  example: { text: hello }
outcomes:
  done: Echoed the text.
  failed: Failed to run.
output: Object containing echoed text.
effects: Pure script step with no external calls.
---
Ask the caller for text, then start the workflow.
`;

const WAIT_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: hold-flow
  version: "1.0.0"
initial: hold
states:
  hold:
    type: wait
    seconds: 60
    transition:
      next:
        elapsed: done
  done:
    type: terminal
    outcome: succeeded
    output: { ok: true }
`;

const SUM_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: sum-pair
  version: "1.0.0"
inputs:
  schema:
    type: object
    required: [a, b]
    properties:
      a: { type: number }
      b: { type: number }
    additionalProperties: false
initial: compute
states:
  compute:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { sum: Number(context.inputs.a) + Number(context.inputs.b) });
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

const INVALID_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: broken-flow
  version: "1.0.0"
initial: step
states:
  step:
    type: javascript
    source: "return 1;"
`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const parse = (res) => {
    const text = res?.content?.[0]?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
};

async function runModeFlow(modeLabel, stdioOpts, publishPkg, cleanupPkg) {
    const pkgName = `mcp-wf-${modeLabel}-${Date.now().toString(36)}`;
    const transport = new StdioClientTransport(stdioOpts);
    const client = new Client({ name: `wf-mcp-live-${modeLabel}`, version: "1.0.0" }, { capabilities: {} });
    const sessionsToClean = [];

    await publishPkg(pkgName);
    await client.connect(transport);
    try {
        // 1. Capabilities
        const caps = parse(await client.callTool({ name: "get_capabilities", arguments: {} }));
        assert.deepEqual(caps.workflow_tools, {
            read: true,
            catalog: true,
            session_for_workflow: true,
            skills: true,
            commands: true,
            definitions: true,
        }, `${modeLabel}: workflow_tools all true`);
        assert.equal(caps.workflows?.validate, true, `${modeLabel}: bootstrap advertises validate`);
        assert.equal(caps.workflows?.skills, true, `${modeLabel}: bootstrap advertises skills`);
        assert.equal(caps.workflows?.card, true, `${modeLabel}: bootstrap advertises card`);

        // 2. list_creatable_workflows -> create_session_for_workflow -> list_sessions session_kind
        const creatable = parse(await client.callTool({ name: "list_creatable_workflows", arguments: {} }));
        const ref = `${pkgName}/echo-flow`;
        assert.ok(creatable.workflows.some((w) => w.ref === ref), `${modeLabel}: ${ref} listed`);

        const coord = parse(await client.callTool({ name: "create_session_for_workflow", arguments: { ref } }));
        assert.ok(coord.session_id, `${modeLabel}: coord session created`);
        assert.equal(coord.workflow_ref, ref);
        assert.equal(coord.kickoff_sent, true);
        sessionsToClean.push(coord.session_id);

        const listed1 = parse(await client.callTool({ name: "list_sessions", arguments: {} }));
        const coordRow = listed1.sessions.find((s) => s.session_id === coord.session_id);
        assert.equal(coordRow?.session_kind, "agent", `${modeLabel}: coord session_kind === agent`);

        // 3. workflow_definition card & copy
        const cardRes = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "card", owner_session_id: coord.session_id, name: ref },
        }));
        assert.equal(cardRes.operation, "card");
        assert.equal(cardRes.name, ref);
        assert.equal(cardRes.attached, true);

        const copyRes = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "copy", owner_session_id: coord.session_id, name: ref, operation_id: `copy-${pkgName}` },
        }));
        assert.equal(copyRes.operation, "copy");
        assert.equal(copyRes.revision, 1);
        assert.equal(copyRes.name, "echo-flow");

        // 4. read_workflow_skill (list dynamic parity + workflow-authoring with note)
        const expectedSkillNames = loadSkillsSync(WORKFLOW_SKILLS_DIR).map((s) => s.name).sort((a, b) => a.localeCompare(b));
        const skillsList = parse(await client.callTool({ name: "read_workflow_skill", arguments: {} }));
        assert.deepEqual(skillsList.skills.map((s) => s.name), expectedSkillNames, `${modeLabel}: skills match WORKFLOW_SKILLS_DIR`);

        const authoring = parse(await client.callTool({ name: "read_workflow_skill", arguments: { name: "workflow-authoring" } }));
        assert.equal(authoring.name, "workflow-authoring");
        assert.ok(authoring.content.length > 200);
        assert.match(authoring.note, /read_workflow_skill/);

        // 5. create_session (0-turn owner) -> validate invalid -> validate valid
        const owner = parse(await client.callTool({ name: "create_session", arguments: { title: `wf-owner-${modeLabel}` } }));
        assert.ok(owner.session_id);
        sessionsToClean.push(owner.session_id);

        const badVal = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "validate", yaml: INVALID_YAML },
        }));
        assert.equal(badVal.valid, false);
        assert.ok(badVal.errors.length > 0);
        assert.equal(badVal.graph, null);

        const goodVal = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "validate", yaml: SUM_YAML },
        }));
        assert.equal(goodVal.valid, true);
        assert.equal(goodVal.name, "sum-pair");
        assert.ok(goodVal.graph && goodVal.inputsSchema);

        // 6. save hold-flow -> stale save 409 -> 0-turn start without workspace 400 -> start with workspace: "none"
        const savedHold = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "save", owner_session_id: owner.session_id, name: "hold-flow", yaml: WAIT_YAML, operation_id: "save-hold-1" },
        }));
        assert.equal(savedHold.revision, 1);

        const savedHold2 = parse(await client.callTool({
            name: "workflow_definition",
            arguments: {
                operation: "save",
                owner_session_id: owner.session_id,
                name: "hold-flow",
                definition_id: savedHold.definitionId,
                expected_revision: 1,
                yaml: WAIT_YAML,
                operation_id: "save-hold-2",
            },
        }));
        assert.equal(savedHold2.revision, 2);

        const staleRes = await client.callTool({
            name: "workflow_definition",
            arguments: {
                operation: "save",
                owner_session_id: owner.session_id,
                name: "hold-flow",
                definition_id: savedHold.definitionId,
                expected_revision: 1,
                yaml: WAIT_YAML,
                operation_id: "save-hold-stale",
            },
        });
        assert.equal(staleRes.isError, true);
        assert.equal(parse(staleRes).code, "REVISION_STALE");
        assert.equal(parse(staleRes).status, 409);

        // Check actor recorded on revision: direct mode stamps system ("management-client");
        // local no-auth web mode stamps the portal's no-auth principal ({ kind: "user", provider: "none", subject: "unknown" }).
        const readHold = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "read", owner_session_id: owner.session_id, name: "hold-flow" },
        }));
        if (modeLabel === "direct") {
            assert.equal(readHold.revision?.actor?.kind, "system", `${modeLabel}: actor.kind === system`);
        } else {
            assert.equal(readHold.revision?.actor?.kind, "user", `${modeLabel}: no-auth web portal stamps user principal`);
            assert.equal(readHold.revision?.actor?.provider, "none");
            assert.equal(readHold.revision?.actor?.subject, "unknown");
        }

        // 0-turn start without workspace -> 400 WORKFLOW_COMMAND_INVALID
        const noWsRes = await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "start", owner_session_id: owner.session_id, name: "hold-flow", operation_id: "start-no-ws" },
        });
        assert.equal(noWsRes.isError, true);
        assert.equal(parse(noWsRes).code, "WORKFLOW_COMMAND_INVALID");
        assert.equal(parse(noWsRes).status, 400);

        // Start hold-flow with workspace: "none" -> delete while active -> 409 DEFINITION_IN_USE -> cancel
        const startedHold = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "start", owner_session_id: owner.session_id, name: "hold-flow", workspace: "none", operation_id: "start-hold-1" },
        }));
        assert.ok(startedHold.workflowId);
        sessionsToClean.push(startedHold.workflowId);

        const delBusy = await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "delete", owner_session_id: owner.session_id, name: "hold-flow", operation_id: "del-busy-1" },
        });
        assert.equal(delBusy.isError, true);
        assert.equal(parse(delBusy).code, "DEFINITION_IN_USE");
        assert.equal(parse(delBusy).status, 409);

        const cancelHold = parse(await client.callTool({
            name: "update_workflow",
            arguments: { session_id: startedHold.workflowId, command: { operation: "cancel", operation_id: "cancel-hold-1" } },
        }));
        assert.equal(cancelHold.status, "cancelled");

        // Spawn-ref delete refusal over MCP: deleting a definition named by an active parent Workflow's spawn state -> 409 DEFINITION_IN_USE
        const spawnLeafYaml = [
            "apiVersion: pilotswarm.dev/v1",
            "kind: Workflow",
            'metadata: { name: spawn-leaf, version: "1.0.0" }',
            "initial: pause",
            "states:",
            "  pause: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }",
            "  done: { type: terminal, outcome: succeeded }",
        ].join("\n");
        const spawnParentYaml = [
            "apiVersion: pilotswarm.dev/v1",
            "kind: Workflow",
            'metadata: { name: spawn-parent, version: "1.0.0" }',
            "initial: wait_first",
            "states:",
            "  wait_first: { type: wait, seconds: 600, transition: { next: { elapsed: launch_leaf } } }",
            "  launch_leaf: { type: spawn, definition: spawn-leaf, transition: { next: { started: done, failure: fail } } }",
            "  done: { type: terminal, outcome: succeeded }",
            "  fail: { type: terminal, outcome: failed }",
        ].join("\n");
        await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "save", owner_session_id: owner.session_id, name: "spawn-leaf", yaml: spawnLeafYaml, operation_id: "save-spawn-leaf-1" },
        });
        await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "save", owner_session_id: owner.session_id, name: "spawn-parent", yaml: spawnParentYaml, operation_id: "save-spawn-parent-1" },
        });
        const startedSpawnParent = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "start", owner_session_id: owner.session_id, name: "spawn-parent", workspace: "none", operation_id: "start-spawn-parent-1" },
        }));
        assert.ok(startedSpawnParent.workflowId);
        sessionsToClean.push(startedSpawnParent.workflowId);

        const delSpawnRef = await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "delete", owner_session_id: owner.session_id, name: "spawn-leaf", operation_id: "del-spawn-leaf-busy" },
        });
        assert.equal(delSpawnRef.isError, true, `${modeLabel}: MCP delete must refuse active spawn reference`);
        const delSpawnRefBody = parse(delSpawnRef);
        assert.equal(delSpawnRefBody.code, "DEFINITION_IN_USE");
        assert.equal(delSpawnRefBody.status, 409);
        assert.match(String(delSpawnRefBody.error ?? ""), /spawn-parent #1/);
        assert.match(String(delSpawnRefBody.error ?? ""), /launch_leaf/);
        assert.deepEqual(delSpawnRefBody.details?.referencedBy, [
            { workflowSessionId: startedSpawnParent.workflowId, name: "spawn-parent", number: 1, spawnStates: ["launch_leaf"] },
        ]);

        const cancelSpawnParent = parse(await client.callTool({
            name: "update_workflow",
            arguments: { session_id: startedSpawnParent.workflowId, command: { operation: "cancel", operation_id: "cancel-spawn-parent-1" } },
        }));
        assert.equal(cancelSpawnParent.status, "cancelled");

        const delSpawnLeafAfter = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "delete", owner_session_id: owner.session_id, name: "spawn-leaf", operation_id: "del-spawn-leaf-ok" },
        }));
        assert.equal(delSpawnLeafAfter.operation, "delete");
        assert.equal(delSpawnLeafAfter.name, "spawn-leaf");

        // 7. Save & start sum-pair (script state) -> WORKFLOW_PERSON_START_NO_TOOL_BINDING -> poll read_workflow -> sum: 12
        const savedSum = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "save", owner_session_id: owner.session_id, name: "sum-pair", yaml: SUM_YAML, operation_id: "save-sum-1" },
        }));
        assert.equal(savedSum.revision, 1);

        const startedSum = parse(await client.callTool({
            name: "workflow_definition",
            arguments: {
                operation: "start",
                owner_session_id: owner.session_id,
                name: "sum-pair",
                inputs: { a: 7, b: 5 },
                workspace: "none",
                key: "sum-1",
            },
        }));
        assert.ok(startedSum.workflowId);
        sessionsToClean.push(startedSum.workflowId);
        assert.ok(
            startedSum.warnings?.some((w) => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING"),
            `${modeLabel}: script start must include WORKFLOW_PERSON_START_NO_TOOL_BINDING`,
        );

        // list_sessions shows child Workflow with session_kind: "workflow"
        const listed2 = parse(await client.callTool({ name: "list_sessions", arguments: {} }));
        const wfRow = listed2.sessions.find((s) => s.session_id === startedSum.workflowId);
        assert.equal(wfRow?.session_kind, "workflow", `${modeLabel}: child session_kind === workflow`);

        // Poll read_workflow until completed
        let view = null;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            view = parse(await client.callTool({ name: "read_workflow", arguments: { session_id: startedSum.workflowId } }));
            if (view?.run?.status === "completed" || view?.run?.status === "failed") break;
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.equal(view?.run?.status, "completed", `${modeLabel}: sum-pair completed (${JSON.stringify(view?.run)})`);
        assert.equal(view?.run?.outcome, "succeeded");
        const output = typeof view?.run?.output === "string" ? JSON.parse(view.run.output) : view?.run?.output;
        assert.equal(output?.sum, 12, `${modeLabel}: sum === 12`);

        // 8. Delete sum-pair by name -> replayed: false; retry same operation_id by name -> replayed: true
        const del1 = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "delete", owner_session_id: owner.session_id, name: "sum-pair", operation_id: "del-sum-1" },
        }));
        assert.equal(del1.replayed, false);

        const del2 = parse(await client.callTool({
            name: "workflow_definition",
            arguments: { operation: "delete", owner_session_id: owner.session_id, name: "sum-pair", operation_id: "del-sum-1" },
        }));
        assert.equal(del2.replayed, true);
        assert.equal(del2.definitionId, del1.definitionId);

        // 9. approval_respond refused 403 FORBIDDEN
        const appRes = await client.callTool({
            name: "update_workflow",
            arguments: {
                session_id: startedSum.workflowId,
                command: { operation: "approval_respond", approval_id: "a1", decision: "approve" },
            },
        });
        assert.equal(appRes.isError, true);
        assert.equal(parse(appRes).code, "FORBIDDEN");
        assert.equal(parse(appRes).status, 403);

        console.log(`✅ workflows-mcp.live.mjs [${modeLabel}] PASS`);
    } finally {
        for (const sid of sessionsToClean) {
            await client.callTool({ name: "delete_session", arguments: { session_id: sid } }).catch(() => {});
        }
        await client.close().catch(() => {});
        await cleanupPkg(pkgName);
    }
}

async function main() {
    // Mode A: Direct mode (startDirectEnv)
    {
        const env = await startDirectEnv(ROOT);
        try {
            await runModeFlow(
                "direct",
                env.mcpStdioArgs(),
                async (pkgName) => {
                    await env.mgmt.uploadAgentPackage(
                        [
                            { path: "plugin.json", contentBase64: b64(JSON.stringify({ name: pkgName, version: "1.0.0", description: "MCP direct live test" })) },
                            { path: "workflows/echo-flow/workflow.yaml", contentBase64: b64(ECHO_YAML) },
                            { path: "workflows/echo-flow/card.md", contentBase64: b64(ECHO_CARD) },
                        ],
                        "shared",
                        null,
                        true,
                    );
                },
                async (pkgName) => {
                    await env.mgmt.deleteAgentPackage(pkgName, null, true, { scope: "shared" }).catch(() => {});
                },
            );
        } finally {
            await env.stop();
        }
    }

    // Mode B: Local no-auth Web API mode (startWebEnv)
    {
        const env = await startWebEnv(ROOT);
        try {
            await runModeFlow(
                "web",
                mcpStdioArgs(ROOT, env.apiUrl),
                async (pkgName) => {
                    const res = await fetch(`${env.apiUrl}/api/v1/agent-packages/upload`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            scope: "shared",
                            files: [
                                { path: "plugin.json", contentBase64: b64(JSON.stringify({ name: pkgName, version: "1.0.0", description: "MCP web live test" })) },
                                { path: "workflows/echo-flow/workflow.yaml", contentBase64: b64(ECHO_YAML) },
                                { path: "workflows/echo-flow/card.md", contentBase64: b64(ECHO_CARD) },
                            ],
                        }),
                    });
                    assert.equal(res.ok, true, `uploadAgentPackage via HTTP failed: ${res.status} ${await res.text()}`);
                },
                async (pkgName) => {
                    await fetch(`${env.apiUrl}/api/v1/agent-packages/${encodeURIComponent(pkgName)}?scope=shared`, { method: "DELETE" }).catch(() => {});
                },
            );
        } finally {
            await env.stop();
        }
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
