#!/usr/bin/env node
/**
 * Happy-path Workflow surface scenario: MCP (`pilotswarm-mcp` binary over StdioClientTransport).
 *
 * Complements `workflows-mcp.live.mjs` (which covers refusal/error paths) by running
 * the shared S1–S6 happy-path scenario in lockstep with the SDK direct and Web API
 * runners — adding rev-2 save/start, definition list/read, pause/resume/set_vars/kv
 * reads, and verified package/session cleanup — across both:
 *   1) Direct mode (`startDirectEnv`, package upload/delete via `env.mgmt`)
 *   2) Local Web API mode (`startWebEnv`, package upload/delete via MCP `push_agent_package` / `delete_agent_package`)
 *
 * Intentionally imports shared test helpers from `packages/sdk/test/helpers/` so
 * all three public surfaces execute the exact same scenario definition.
 *
 * Usage: node packages/app/mcp/test/integration/workflow-surface-mcp.live.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotEnv, startWebEnv, mcpStdioArgs } from "./web-env.mjs";
import { startDirectEnv } from "./direct-env.mjs";
import { startScriptedModel } from "../../../../sdk/test/helpers/scripted-model.mjs";
import { runWorkflowSurfaceScenario } from "../../../../sdk/test/helpers/workflow-surface-scenario.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../..");

async function ensureModelProviderForModelFreeRun() {
    loadDotEnv(ROOT);
    if (process.env.GITHUB_TOKEN || process.env.PS_MODEL_PROVIDERS_PATH) {
        return { close: async () => {} };
    }
    const prevProvidersPath = process.env.PS_MODEL_PROVIDERS_PATH;
    const model = await startScriptedModel({ respond: () => ({ content: "Ready." }) });
    const dir = fs.mkdtempSync(resolve(os.tmpdir(), "ps-wf-surface-mcp-model-"));
    const providersPath = resolve(dir, "model-providers.json");
    fs.writeFileSync(providersPath, JSON.stringify({
        providers: [{
            id: "wf-surface-scripted",
            type: "openai",
            baseUrl: model.baseUrl,
            apiKey: "synthetic",
            models: [{ name: "scripted-model", description: "Local scripted model for model-free workflow tests." }],
        }],
        defaultModel: "wf-surface-scripted:scripted-model",
    }, null, 2));
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    return {
        async close() {
            if (prevProvidersPath === undefined) delete process.env.PS_MODEL_PROVIDERS_PATH;
            else process.env.PS_MODEL_PROVIDERS_PATH = prevProvidersPath;
            await model.close().catch(() => {});
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

function parseTool(res, label) {
    const text = res?.content?.[0]?.text;
    let body = null;
    if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
    }
    assert.equal(Boolean(res?.isError), false, `${label} returned MCP error: ${JSON.stringify(body)}`);
    return body;
}

async function runMode(modeLabel, stdioOpts, packageOps) {
    const startedAt = Date.now();
    const transport = new StdioClientTransport(stdioOpts);
    const client = new Client({ name: `wf-surface-mcp-${modeLabel}`, version: "1.0.0" }, { capabilities: {} });

    const call = async (name, args = {}) => parseTool(
        await client.callTool({ name, arguments: args }),
        `${modeLabel}:${name}(${args?.operation ?? ""})`,
    );

    await client.connect(transport);
    try {
        const pkgHooks = packageOps
            ? packageOps(call)
            : {
                publishPackage: (_pkgName, files) => call("push_agent_package", {
                    scope: "shared",
                    files: files.map((f) => ({ path: f.path, content_base64: f.contentBase64 })),
                }),
                deletePackage: (pkgName) => call("delete_agent_package", {
                    name: pkgName,
                    confirm: true,
                    scope: "shared",
                }),
            };

        const adapter = {
            getWorkflowCapabilities: async () => {
                const caps = await call("get_capabilities", {});
                assert.deepEqual(caps.workflow_tools, {
                    read: true,
                    catalog: true,
                    session_for_workflow: true,
                    skills: true,
                    commands: true,
                    definitions: true,
                }, `mcp-${modeLabel} S1: workflow_tools all enabled`);
                return caps.workflows;
            },
            listWorkflowSkills: () => call("read_workflow_skill", {}),
            readWorkflowSkill: async (name) => {
                const skill = await call("read_workflow_skill", { name });
                assert.match(String(skill.note ?? ""), /read_workflow_skill/, `mcp-${modeLabel} S1: skill carries MCP note`);
                return skill;
            },
            createOwnerSession: async (title) => {
                const res = await call("create_session", { title });
                return { sessionId: res.session_id };
            },
            validateDefinition: (yaml) => call("workflow_definition", { operation: "validate", yaml }),
            saveDefinition: ({ ownerSessionId, name, yaml, definitionId, expectedRevision, operationId }) =>
                call("workflow_definition", {
                    operation: "save",
                    owner_session_id: ownerSessionId,
                    name,
                    yaml,
                    ...(definitionId ? { definition_id: definitionId } : {}),
                    ...(expectedRevision != null ? { expected_revision: expectedRevision } : {}),
                    operation_id: operationId,
                }),
            listDefinitions: async (ownerSessionId) => {
                const res = await call("workflow_definition", { operation: "list", owner_session_id: ownerSessionId });
                return res.definitions ?? [];
            },
            readDefinition: ({ ownerSessionId, definitionId, name, revision }) =>
                call("workflow_definition", {
                    operation: "read",
                    owner_session_id: ownerSessionId,
                    ...(definitionId ? { definition_id: definitionId } : {}),
                    ...(name ? { name } : {}),
                    ...(revision != null ? { revision } : {}),
                }),
            startDefinition: ({ ownerSessionId, definitionId, name, revision, inputs, vars, notifyParent, workspace, operationId }) =>
                call("workflow_definition", {
                    operation: "start",
                    owner_session_id: ownerSessionId,
                    ...(definitionId ? { definition_id: definitionId } : {}),
                    ...(name ? { name } : {}),
                    ...(revision != null ? { revision } : {}),
                    ...(inputs !== undefined ? { inputs } : {}),
                    ...(vars !== undefined ? { vars } : {}),
                    ...(notifyParent !== undefined ? { notify_on_completion: notifyParent } : {}),
                    workspace,
                    operation_id: operationId,
                }),
            readWorkflow: (workflowId, options = {}) => call("read_workflow", {
                session_id: workflowId,
                ...(options.runId !== undefined ? { run_id: options.runId } : {}),
                ...(options.kvRevision !== undefined ? { kv_revision: options.kvRevision } : {}),
                ...(options.kvKey !== undefined ? { kv_key: options.kvKey } : {}),
            }),
            updateWorkflow: (workflowId, command) => call("update_workflow", { session_id: workflowId, command }),
            deleteDefinition: ({ ownerSessionId, definitionId, name, operationId }) =>
                call("workflow_definition", {
                    operation: "delete",
                    owner_session_id: ownerSessionId,
                    ...(definitionId ? { definition_id: definitionId } : {}),
                    ...(name ? { name } : {}),
                    operation_id: operationId,
                }),
            ...pkgHooks,
            listCreatableWorkflows: async () => {
                const res = await call("list_creatable_workflows", {});
                return res.workflows ?? [];
            },
            readPackageCard: ({ ownerSessionId, name }) =>
                call("workflow_definition", { operation: "card", owner_session_id: ownerSessionId, name }),
            createSessionForWorkflow: async (ref) => {
                const res = await call("create_session_for_workflow", { ref });
                return { sessionId: res.session_id, workflowRef: res.workflow_ref, title: res.title };
            },
            copyDefinition: ({ ownerSessionId, name, definitionId, operationId }) =>
                call("workflow_definition", {
                    operation: "copy",
                    owner_session_id: ownerSessionId,
                    ...(definitionId ? { definition_id: definitionId } : {}),
                    ...(name ? { name } : {}),
                    operation_id: operationId,
                }),
            deleteSession: (sessionId) => call("delete_session", { session_id: sessionId }),
            verifySessionKind: async (sessionId, expectedKind) => {
                const listed = await call("list_sessions", {});
                const row = (listed.sessions ?? []).find((s) => s.session_id === sessionId);
                assert.equal(row?.session_kind, expectedKind, `mcp-${modeLabel}: list_sessions session_kind === ${expectedKind}`);
            },
        };

        const outcome = await runWorkflowSurfaceScenario(adapter, { prefix: `mcp-${modeLabel}` });
        const elapsedMs = Date.now() - startedAt;
        console.log(`✅ workflow-surface-mcp.live.mjs [${modeLabel}] PASS (${outcome.steps.join(", ")}) in ${(elapsedMs / 1000).toFixed(1)}s`);
    } finally {
        await client.close().catch(() => {});
    }
}

async function main() {
    const modelStub = await ensureModelProviderForModelFreeRun();
    try {
        // Mode 1: Direct datastore mode (--store; agent-package MCP tools are web-mode only)
        {
            const env = await startDirectEnv(ROOT);
            try {
                await runMode("direct", env.mcpStdioArgs(), () => ({
                    publishPackage: (_pkgName, files) => env.mgmt.uploadAgentPackage(files, "shared", null, true),
                    deletePackage: (pkgName) => env.mgmt.deleteAgentPackage(pkgName, null, true, { scope: "shared" }),
                }));
            } finally {
                await env.stop();
            }
        }

        // Mode 2: Local Web API mode (--api-url; package publish/delete ride MCP tools)
        {
            const env = await startWebEnv(ROOT);
            try {
                await runMode("web", mcpStdioArgs(ROOT, env.apiUrl));
            } finally {
                await env.stop();
            }
        }
    } finally {
        await modelStub.close();
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
