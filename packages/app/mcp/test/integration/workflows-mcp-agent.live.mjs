#!/usr/bin/env node
/**
 * Gate 4 live-model behavioral harness for Phase 4 (Unit G: Workflows over MCP).
 *
 * Boots local Web API portal (`startWebEnv`), publishes a ready-made package Workflow
 * (`<pkg>/echo-flow`), connects to the real `pilotswarm-mcp --api-url` binary over
 * `StdioClientTransport`, converts `tools/list` 1:1 into model tool schemas, and runs
 * an uncoached plain tool loop (empty custom system prompt; ONLY the MCP `initialize`
 * `instructions` are passed):
 *
 *   - 3 positive runs (require >= 2 passes):
 *     "This PilotSwarm deployment has some ready-made workflows. Start one of them for me.
 *      Then write and run your own small workflow that adds two numbers, 7 and 5, and tell me the result."
 *   - 1 negative run (require pass):
 *     "List the current sessions and tell me the server's default model."
 *
 * Supports two model wire formats:
 *   - OpenAI Responses API (default, from `.model_providers.json` + `FOUNDRY_DEV_KEY`)
 *   - Anthropic Messages API (`MCP_EVAL_PROVIDER=anthropic`, `MCP_EVAL_MODEL=claude-sonnet-5-5`,
 *     using `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in env, never written to receipts)
 *
 * Env knobs:
 *   - `MCP_EVAL_PROVIDER`: "openai" (default) | "anthropic"
 *   - `MCP_EVAL_MODEL`: model name override (default: first model from .model_providers.json or claude-sonnet-5-5)
 *   - `MCP_EVAL_RECEIPT_PATH`: optional path to write full redacted JSON receipt
 *   - `MCP_EVAL_POSITIVE_RUNS`: number of positive runs (default 3)
 *
 * Usage: node packages/app/mcp/test/integration/workflows-mcp-agent.live.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startWebEnv, mcpStdioArgs } from "./web-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../..");

const MAX_TOOL_CALLS = 40;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const POSITIVE_RUNS = Number(process.env.MCP_EVAL_POSITIVE_RUNS || 3);

const POSITIVE_PROMPT =
    "This PilotSwarm deployment has some ready-made workflows. Start one of them for me. "
    + "Then write and run your own small workflow that adds two numbers, 7 and 5, and tell me the result.";

const NEGATIVE_PROMPT = "List the current sessions and tell me the server's default model.";

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
description: Echoes input text through a small ready-made workflow.
whenToUse: When someone wants to try a ready-made workflow on this deployment.
inputs:
  example: { text: hello }
outcomes:
  done: Returned the echoed text.
  failed: Failed to run.
output: JSON object containing echoed text.
effects: Pure script step with no external calls.
---
Greet the user and ask for the text to echo.
`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

function resolveModelConfig() {
    const mode = (process.env.MCP_EVAL_PROVIDER || "openai").toLowerCase();
    if (mode === "anthropic") {
        const apiKey = process.env.ANTHROPIC_API_KEY || "";
        const bearer = process.env.ANTHROPIC_AUTH_TOKEN || "";
        if (!apiKey && !bearer) {
            throw new Error("MCP_EVAL_PROVIDER=anthropic requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.");
        }
        const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
        const model = process.env.MCP_EVAL_MODEL || "claude-sonnet-5-5";
        return {
            family: "anthropic",
            providerId: process.env.MCP_EVAL_PROVIDER_ID || "anthropic-wif",
            model,
            qualifiedModel: `${process.env.MCP_EVAL_PROVIDER_ID || "anthropic-wif"}:${model}`,
            baseUrl,
            apiKey,
            bearer,
        };
    }

    const mpPath = resolve(ROOT, process.env.MODEL_PROVIDERS_PATH || ".model_providers.json");
    const cfg = JSON.parse(readFileSync(mpPath, "utf8"));
    const provider = (cfg.providers || []).find((p) => p.type === "openai") || cfg.providers?.[0];
    if (!provider) throw new Error(`No provider configured in ${mpPath}`);
    const keySpec = String(provider.apiKey || "");
    const apiKey = keySpec.startsWith("env:") ? (process.env[keySpec.slice(4)] || "") : keySpec;
    if (!apiKey) throw new Error(`Missing API key for provider ${provider.id} (${keySpec})`);
    const defaultName = cfg.defaultModel?.includes(":") ? cfg.defaultModel.split(":").slice(1).join(":") : provider.models?.[0]?.name;
    const model = process.env.MCP_EVAL_MODEL || defaultName;
    return {
        family: "openai",
        providerId: provider.id,
        model,
        qualifiedModel: `${provider.id}:${model}`,
        baseUrl: String(provider.baseUrl).replace(/\/+$/, ""),
        apiKey,
    };
}

function sanitizeJsonSchemaForOpenAI(schema) {
    if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
    const clone = structuredClone(schema);
    delete clone.$schema;
    if (!clone.type) clone.type = "object";
    if (clone.type === "object" && !clone.properties) clone.properties = {};
    return clone;
}

function mcpToolsToOpenAI(tools) {
    return tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: sanitizeJsonSchemaForOpenAI(t.inputSchema),
    }));
}

function mcpToolsToAnthropic(tools) {
    return tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        input_schema: sanitizeJsonSchemaForOpenAI(t.inputSchema),
    }));
}

function clipText(text, max = 4000) {
    const s = String(text ?? "");
    return s.length > max ? `${s.slice(0, max)}...[truncated ${s.length - max} chars]` : s;
}

async function runOpenAILoop(modelCfg, client, mcpInstructions, tools, prompt) {
    const openAiTools = mcpToolsToOpenAI(tools);
    const trace = [];
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    const input = [{ role: "user", content: prompt }];
    let toolCallsUsed = 0;
    let finalText = "";

    while (Date.now() < deadline && toolCallsUsed <= MAX_TOOL_CALLS) {
        const body = {
            model: modelCfg.model,
            instructions: mcpInstructions || "",
            input,
            tools: openAiTools,
            reasoning: { effort: "low" },
        };
        const res = await fetch(`${modelCfg.baseUrl}/responses`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": modelCfg.apiKey,
            },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(`OpenAI responses HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
        }
        const output = Array.isArray(data.output) ? data.output : [];
        const fnCalls = output.filter((item) => item.type === "function_call");
        if (fnCalls.length === 0) {
            finalText = data.output_text
                ?? output.flatMap((o) => (o.content || []).map((c) => c.text || "")).join("\n").trim();
            break;
        }
        for (const item of output) {
            if (item.type === "function_call" || item.type === "message") {
                input.push(item);
            }
        }
        for (const call of fnCalls) {
            toolCallsUsed += 1;
            if (toolCallsUsed > MAX_TOOL_CALLS) break;
            let args = {};
            try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
            const mcpRes = await client.callTool({ name: call.name, arguments: args });
            const text = mcpRes?.content?.map((c) => c.text || "").join("\n") || "";
            trace.push({
                step: toolCallsUsed,
                tool: call.name,
                args,
                isError: Boolean(mcpRes?.isError),
                result: clipText(text, 3000),
            });
            input.push({
                type: "function_call_output",
                call_id: call.call_id,
                output: text,
            });
        }
    }
    return { finalText, toolCallsUsed, trace };
}

async function runAnthropicLoop(modelCfg, client, mcpInstructions, tools, prompt) {
    const anthropicTools = mcpToolsToAnthropic(tools);
    const trace = [];
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    const messages = [{ role: "user", content: prompt }];
    let toolCallsUsed = 0;
    let finalText = "";

    const headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(modelCfg.apiKey ? { "x-api-key": modelCfg.apiKey } : {}),
        ...(modelCfg.bearer ? { Authorization: `Bearer ${modelCfg.bearer}` } : {}),
    };

    while (Date.now() < deadline && toolCallsUsed <= MAX_TOOL_CALLS) {
        const body = {
            model: modelCfg.model,
            max_tokens: 4096,
            temperature: 0,
            ...(mcpInstructions ? { system: mcpInstructions } : {}),
            tools: anthropicTools,
            messages,
        };
        const res = await fetch(`${modelCfg.baseUrl}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(`Anthropic messages HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
        }
        const content = Array.isArray(data.content) ? data.content : [];
        messages.push({ role: "assistant", content });
        const toolUses = content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
            finalText = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
            break;
        }
        const toolResults = [];
        for (const use of toolUses) {
            toolCallsUsed += 1;
            if (toolCallsUsed > MAX_TOOL_CALLS) break;
            const args = use.input && typeof use.input === "object" ? use.input : {};
            const mcpRes = await client.callTool({ name: use.name, arguments: args });
            const text = mcpRes?.content?.map((c) => c.text || "").join("\n") || "";
            trace.push({
                step: toolCallsUsed,
                tool: use.name,
                args,
                isError: Boolean(mcpRes?.isError),
                result: clipText(text, 3000),
            });
            toolResults.push({
                type: "tool_result",
                tool_use_id: use.id,
                content: text,
                ...(mcpRes?.isError ? { is_error: true } : {}),
            });
        }
        messages.push({ role: "user", content: toolResults });
    }
    return { finalText, toolCallsUsed, trace };
}

function gradePositive(run) {
    const { trace, finalText } = run;
    const idxList = trace.findIndex((t) => t.tool === "list_creatable_workflows" && !t.isError);
    const idxCreateForWf = trace.findIndex((t, i) => i > idxList && t.tool === "create_session_for_workflow" && !t.isError);
    const idxFirstSave = trace.findIndex((t) => t.tool === "workflow_definition" && t.args?.operation === "save");
    const idxSkill = trace.findIndex(
        (t) => t.tool === "read_workflow_skill" && typeof t.args?.name === "string" && t.args.name.startsWith("workflow-") && !t.isError,
    );
    const createdSessionIds = new Set();
    for (const t of trace) {
        if ((t.tool === "create_session" || t.tool === "create_session_for_workflow") && !t.isError) {
            try {
                const parsed = JSON.parse(t.result);
                if (parsed?.session_id) createdSessionIds.add(parsed.session_id);
            } catch {}
        }
    }
    const saveOk = trace.some(
        (t) => t.tool === "workflow_definition" && t.args?.operation === "save" && !t.isError && createdSessionIds.has(t.args?.owner_session_id),
    );
    const startOk = trace.some(
        (t) => t.tool === "workflow_definition" && t.args?.operation === "start" && !t.isError && createdSessionIds.has(t.args?.owner_session_id),
    );
    const readSucceededWith12 = trace.some((t) => {
        if (t.tool !== "read_workflow" || t.isError) return false;
        return /"outcome"\s*:\s*"succeeded"/.test(t.result) && /\b12\b/.test(t.result);
    });

    const checks = {
        listedAndStartedPackagedWorkflow: idxList >= 0 && idxCreateForWf > idxList,
        readWorkflowSkillBeforeFirstSave: idxSkill >= 0 && idxFirstSave >= 0 && idxSkill < idxFirstSave,
        savedAndStartedOnCreatedSession: saveOk && startOk,
        readWorkflowSucceededWith12: readSucceededWith12,
        finalAnswerMentions12: /\b12\b/.test(finalText),
    };
    const passed = checks.listedAndStartedPackagedWorkflow
        && checks.readWorkflowSkillBeforeFirstSave
        && checks.savedAndStartedOnCreatedSession
        && checks.readWorkflowSucceededWith12;
    return { passed, checks };
}

function gradeNegative(run) {
    const { trace } = run;
    const calledSkill = trace.some((t) => t.tool === "read_workflow_skill");
    const calledDef = trace.some((t) => t.tool === "workflow_definition");
    const checks = {
        zeroReadWorkflowSkillCalls: !calledSkill,
        zeroWorkflowDefinitionCalls: !calledDef,
    };
    return { passed: !calledSkill && !calledDef, checks };
}

async function main() {
    const modelCfg = resolveModelConfig();
    const env = await startWebEnv(ROOT);
    const pkgName = `eval-wf-${Date.now().toString(36)}`;

    const up = await fetch(`${env.apiUrl}/api/v1/agent-packages/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            scope: "shared",
            files: [
                { path: "plugin.json", contentBase64: b64(JSON.stringify({ name: pkgName, version: "1.0.0", description: "Ready-made echo workflow package" })) },
                { path: "workflows/echo-flow/workflow.yaml", contentBase64: b64(ECHO_YAML) },
                { path: "workflows/echo-flow/card.md", contentBase64: b64(ECHO_CARD) },
            ],
        }),
    });
    assert.equal(up.ok, true, `upload eval package failed: ${up.status} ${await up.text()}`);

    const transport = new StdioClientTransport(mcpStdioArgs(ROOT, env.apiUrl));
    const client = new Client({ name: "wf-mcp-agent-eval", version: "1.0.0" }, { capabilities: {} });

    const receipt = {
        evaluatedAt: new Date().toISOString(),
        family: modelCfg.family,
        model: modelCfg.qualifiedModel,
        maxToolCalls: MAX_TOOL_CALLS,
        timeoutMs: RUN_TIMEOUT_MS,
        packageRef: `${pkgName}/echo-flow`,
        positiveRuns: [],
        negativeRun: null,
        summary: null,
    };

    try {
        await client.connect(transport);
        const mcpInstructions = client.getInstructions() || "";
        const { tools } = await client.listTools();
        const runLoop = modelCfg.family === "anthropic" ? runAnthropicLoop : runOpenAILoop;

        let positivePasses = 0;
        for (let i = 1; i <= POSITIVE_RUNS; i += 1) {
            const t0 = Date.now();
            const run = await runLoop(modelCfg, client, mcpInstructions, tools, POSITIVE_PROMPT);
            const graded = gradePositive(run);
            if (graded.passed) positivePasses += 1;
            const entry = {
                runIndex: i,
                durationMs: Date.now() - t0,
                toolCallsUsed: run.toolCallsUsed,
                passed: graded.passed,
                checks: graded.checks,
                finalText: clipText(run.finalText, 1500),
                trace: run.trace,
            };
            receipt.positiveRuns.push(entry);
            console.log(`[${modelCfg.qualifiedModel}] positive #${i}: ${graded.passed ? "PASS" : "FAIL"} (${run.toolCallsUsed} calls, ${entry.durationMs}ms) ${JSON.stringify(graded.checks)}`);
        }

        const tNeg = Date.now();
        const negRun = await runLoop(modelCfg, client, mcpInstructions, tools, NEGATIVE_PROMPT);
        const negGraded = gradeNegative(negRun);
        receipt.negativeRun = {
            durationMs: Date.now() - tNeg,
            toolCallsUsed: negRun.toolCallsUsed,
            passed: negGraded.passed,
            checks: negGraded.checks,
            finalText: clipText(negRun.finalText, 1500),
            trace: negRun.trace,
        };
        console.log(`[${modelCfg.qualifiedModel}] negative: ${negGraded.passed ? "PASS" : "FAIL"} (${negRun.toolCallsUsed} calls, ${receipt.negativeRun.durationMs}ms) ${JSON.stringify(negGraded.checks)}`);

        const overallPass = positivePasses >= Math.min(2, POSITIVE_RUNS) && negGraded.passed;
        receipt.summary = {
            positivePasses,
            positiveTotal: POSITIVE_RUNS,
            negativePassed: negGraded.passed,
            overallPass,
        };

        if (process.env.MCP_EVAL_RECEIPT_PATH) {
            writeFileSync(process.env.MCP_EVAL_RECEIPT_PATH, JSON.stringify(receipt, null, 2), "utf8");
        }
        assert.equal(overallPass, true, `Live-model MCP eval failed: ${JSON.stringify(receipt.summary)}`);
        console.log(`✅ workflows-mcp-agent.live.mjs [${modelCfg.qualifiedModel}] PASS (${positivePasses}/${POSITIVE_RUNS} positive, negative PASS)`);
    } finally {
        if (process.env.MCP_EVAL_RECEIPT_PATH && !receipt.summary) {
            writeFileSync(process.env.MCP_EVAL_RECEIPT_PATH, JSON.stringify(receipt, null, 2), "utf8");
        }
        await client.close().catch(() => {});
        await fetch(`${env.apiUrl}/api/v1/agent-packages/${encodeURIComponent(pkgName)}?scope=shared`, { method: "DELETE" }).catch(() => {});
        await env.stop();
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
