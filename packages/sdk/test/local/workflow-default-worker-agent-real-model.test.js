/**
 * The full Workflow engine on a DEFAULT worker, on a REAL model (owner decision 2026-11-08T15:30Z): a worker made with no
 * test options (as every deployment's is) serves controller 1.9.0 and session orchestration 1.0.83, so a chat started
 * there builds and runs a Workflow with an agent step. Asked once, with script nodes off (PILOTSWARM_WORKFLOW_SCRIPTS=0; on
 * by default since 8ef4b681):
 * "Set up a Workflow with one agent step that writes a one-line haiku about the sea, start it, and tell me the haiku."
 *
 * PASS: the chat is at the latest version (1.0.83); it saved a valid revision with at least one agent state; no save or
 * start was refused (WORKFLOW_NODE_TYPE_UNSUPPORTED, WORKFLOW_FEATURE_UNSUPPORTED, CONTROLLER_UNAVAILABLE); a Workflow of
 * it started at controller 1.9.0 and completed, through an agent node's chat. The answer is recorded, not judged. Written
 * when every chat had the Workflow tools, it turns Workflows on in its chat before the ask (test/helpers/workflows-on.js).
 *
 * Workflows on demand (owner 2026-11-08T16:55Z; ef41ef20): a new chat starts with Workflows off (a short paragraph and
 * enable_workflows in place of the guidance and the Workflow tools). Three more chats, each new, on the same worker:
 * - asked in prose to build and run a simple Workflow: it calls enable_workflows before any Workflow tool, its capability
 *   state then has Workflows on, and a Workflow of it starts and reaches its end;
 * - asked an ordinary question: Workflows stay off (no enable_workflows call, no Workflow tool called or declared in the
 *   chat's CLI session, the state off, nothing owned);
 * - asked in prose to load the Workflow authoring skill: it calls load_skill for workflow-authoring and gets the skill,
 *   never a tool named "skill" (the CLI's own; a TEST check at 27b2eaef found a model using it). Turning Workflows on
 *   first is allowed.
 * Every case checks tool calls, events, tool metadata and stored state, never the model's words.
 *
 * Every case reads the chat's orchestration version after its first prompt: createSession writes only the session row,
 * and its instance (session-<id>) starts with the first prompt (client.ts _ensureOrchestrationAndSend). Read before,
 * Duroxide's getInstanceInfo fails with "get_instance_info: Instance not found" (this file's earlier failure at ~2 s).
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_V2_REAL_MODEL=run with PS_WORKFLOW_V2_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_V2_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-v2-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_V2_REAL_MODEL_RECEIPT when set (an on-demand case's to the same path with its
 * key before the extension: <name>.enable.json, <name>.stays-off.json, <name>.load-skill.json); a summary is printed. The
 * haiku case: one asked turn, the agent node's turn, and the turn the Workflow's ending notice starts; each on-demand case:
 * one or two turns (enable_workflows ends a turn and starts the next), and the simple Workflow's ending notice.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-default-worker-agent-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";
import { sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";
import { WORKFLOW_V2_MILESTONE_IR_VERSION } from "../../src/workflow/v2/compiler.ts";
import { realModelPlan } from "../helpers/workflow-v2-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-default-worker-agent-real-model" };
const ASK = "Set up a Workflow with one agent step that writes a one-line haiku about the sea, start it, and tell me the haiku.";
const ASK_SIMPLE = "Build a simple Workflow that waits 5 seconds and then finishes, start it, and tell me when it has finished.";
const ASK_PLAIN = "What is the capital of France? Answer in one word.";
const ASK_SKILL = "Load the Workflow authoring skill, then tell me in one sentence what it covers.";
/** A default worker: no test options; script nodes off, as PILOTSWARM_WORKFLOW_SCRIPTS=0 sets them. */
const WORKER = { workflowScripts: { enabled: false }, logLevel: "warning" };
/** The Workflow tools a chat is declared only while Workflows are on in it (spawn_workflow is no longer declared at all). */
const WORKFLOW_TOOLS = ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "respond_session_request", "spawn_workflow"];
const AUTHORING_SKILL = "workflow-authoring";
/** load_skill's result for a capability reference (cap1.…) that is the authoring skill: the artifact's JSON, its name in it. */
const AUTHORING_BY_REFERENCE = new RegExp(`"name":\\s*"${AUTHORING_SKILL}"`);
const TURN_MS = 300_000;
const RUN_MS = 300_000;
const TEST_TIMEOUT = 15 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);
/** A chat's row states between turns, or once it ended (nothing more comes). */
const BETWEEN_TURNS = new Set(["idle", "waiting", "input_required", "completed", "cancelled", "failed", "error"]);
const REFUSED_CODES = /WORKFLOW_NODE_TYPE_UNSUPPORTED|WORKFLOW_FEATURE_UNSUPPORTED|CONTROLLER_UNAVAILABLE/;

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

async function until(read, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) return null;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

/** A tool event's arguments as an object (recorded as an object, or as JSON text). */
function argsOf(data) {
    const value = data?.arguments ?? data?.args;
    if (typeof value === "string") {
        try { return JSON.parse(value) ?? {}; } catch { return {}; }
    }
    return value && typeof value === "object" ? value : {};
}

/** A tool result's text: a string, the content of an object result, or its JSON. */
function resultText(result) {
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && typeof result.content === "string") return result.content;
    try { return JSON.stringify(result ?? null); } catch { return ""; }
}

/** The chat's tool calls in event order: name, arguments and (once it completed) its result's text. */
async function toolCallsOf(catalog, sessionId) {
    const rows = (await catalog.getSessionEvents(sessionId, 0, 5_000, ["tool.execution_start", "tool.execution_complete"]))
        .sort((a, b) => a.seq - b.seq);
    const calls = [];
    const byId = new Map();
    for (const event of rows) {
        const data = event.data ?? {};
        if (event.eventType === "tool.execution_start") {
            const call = { name: String(data.toolName ?? data.name ?? ""), args: argsOf(data), result: null };
            calls.push(call);
            if (data.toolCallId) byId.set(data.toolCallId, call);
            continue;
        }
        const name = String(data.toolName ?? data.name ?? "");
        const call = byId.get(data.toolCallId) ?? calls.findLast(item => item.result === null && item.name === name);
        if (call) call.result = resultText(data.result ?? data.error ?? null);
    }
    return calls;
}

/**
 * Waits until the chat is between turns: its row idle (or waiting) and no new event for two polls. enable_workflows
 * ends its turn and the next one starts at once, so a returned sendAndWait does not mean the chat is done. False when
 * `ms` runs out.
 */
async function settle(catalog, sessionId, ms) {
    let count = -1;
    let quiet = 0;
    return Boolean(await until(async () => {
        const [row, rows] = await Promise.all([catalog.getSession(sessionId), catalog.getSessionEvents(sessionId, 0, 5_000)]);
        quiet = BETWEEN_TURNS.has(row?.state) && rows.length === count ? quiet + 1 : 0;
        count = rows.length;
        return quiet >= 2;
    }, ms));
}

/** The tool names the chat's live CLI session declares to the model (its tool metadata), sorted; null when not warm here. */
async function declaredTools(worker, sessionId) {
    const managed = worker.sessionManager.get(sessionId);
    if (!managed) return null;
    const metadata = await managed.getCopilotSession().rpc.tools.getCurrentMetadata();
    return (metadata?.tools ?? []).map(tool => (typeof tool === "string" ? tool : tool?.name)).filter(Boolean).sort();
}

/** Every state of an IR, a parallel body's or branch's included, as `type` (`messaging:<mode>` for a messaging state). */
function stateKinds(ir) {
    const kinds = [];
    const visit = nodes => {
        for (const node of Object.values(nodes ?? {})) {
            kinds.push(node.type === "messaging" ? `messaging:${node.mode}` : node.type);
            if (node.body?.nodes) visit(node.body.nodes);
            for (const branch of Object.values(node.branches ?? {})) visit(branch?.nodes);
        }
    };
    visit(ir?.nodes);
    return kinds;
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "a default worker: a real model builds and runs a Workflow with an agent step (scripts off)";
const TITLE_ENABLE = "Workflows on demand: a new chat asked in prose to build and run a simple Workflow calls enable_workflows, then runs it to its end";
const TITLE_STAYS_OFF = "Workflows on demand: a new chat asked an ordinary question keeps Workflows off (no enable_workflows, no Workflow tool declared)";
const TITLE_LOAD_SKILL = "Workflows on demand: a new chat asked in prose to load the Workflow authoring skill calls load_skill (workflow-authoring), never \"skill\"";

/** Where a case's receipt goes: PS_WORKFLOW_V2_REAL_MODEL_RECEIPT, with an on-demand case's key before its extension. */
function receiptPath(key) {
    const path = process.env.PS_WORKFLOW_V2_REAL_MODEL_RECEIPT;
    if (!path) return null;
    return key ? path.replace(/(\.json)?$/i, `.${key}$1`) : path;
}

/**
 * One new chat on a worker made with WORKER, in its own test environment: with `workflowsOn`, Workflows turned on in it
 * before its first prompt (test/helpers/workflows-on.js, as enable_workflows would); `ask` once (sendAndWait), then the
 * chat's orchestration version (its instance exists from the first prompt on), then `check({ env, client, worker,
 * catalog, chat, receipt })`. Prints the receipt and writes it (receiptPath), with the verdict, whatever the outcome.
 */
async function realModelChat(key, ask, check, { workflowsOn = false } = {}) {
    if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
    if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
    const test = key ? `workflow-default-worker-agent-real-model.${key}` : "workflow-default-worker-agent-real-model";
    const receipt = { test, startedAt: new Date().toISOString(),
        model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, ask, steps: {}, verdict: null };
    const env = createTestEnv(test);
    try {
        await withClient(env, { worker: WORKER }, async (client, worker) => {
            const catalog = client._catalog;
            const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
            receipt.steps.sessionId = chat.sessionId;
            if (workflowsOn) await turnWorkflowsOn(catalog, chat.sessionId);
            receipt.steps.workflowsOnBeforeAsk = workflowsOn;
            await chat.sendAndWait(ask, TURN_MS);
            // After the first prompt: createSession starts no orchestration, so getInstanceInfo before it finds no instance.
            receipt.steps.chatVersion = await sessionOrchestrationVersion(client, chat.sessionId);
            await check({ env, client, worker, catalog, chat, receipt });
        });
        receipt.verdict = "PASS";
    } catch (error) {
        receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
        throw error;
    } finally {
        receipt.endedAt = new Date().toISOString();
        console.log(`[${test}] ${JSON.stringify(receipt)}`);
        const path = receiptPath(key);
        if (path) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
        }
        await env.cleanup();
    }
}

/** Waits until every Workflow the chat started has ended (at least one); the rows, or null when `ms` runs out. */
function workflowsEnded(chatStore, sessionId, ms) {
    return until(async () => {
        const rows = await chatStore.listWorkflows({ ownerSessionId: sessionId });
        return rows.length > 0 && rows.every(row => row.runStatus && !ACTIVE.has(row.runStatus)) ? rows : null;
    }, ms);
}

describe("the full Workflow engine on a default worker, on a real model", () => {
    if (plan.state === "skip") {
        for (const title of [TITLE, TITLE_ENABLE, TITLE_STAYS_OFF, TITLE_LOAD_SKILL]) it.skip(`${title} — skipped: ${plan.reason}`, () => {});
        return;
    }

    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        await realModelChat(null, ASK, async ({ env, catalog, chat, receipt }) => {
            const chatStore = catalog.workflowStore().chat;
            const events = types => catalog.getSessionEvents(chat.sessionId, 0, 5_000, types);
            // Written when every chat had the Workflow tools: Workflows are turned on before the ask (realModelChat's
            // workflowsOn); TITLE_ENABLE covers a chat that turns them on itself. Revisions are read once its Workflows ended.
            const ended = await workflowsEnded(chatStore, chat.sessionId, RUN_MS);
            receipt.steps.workflows = (ended ?? await chatStore.listWorkflows({ ownerSessionId: chat.sessionId }))
                .map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
            receipt.steps.toolCalls = (await events(["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
            receipt.steps.refused = (await events(["tool.execution_complete"])).map(event => JSON.stringify(event.data ?? {}))
                .filter(text => REFUSED_CODES.test(text)).map(text => text.slice(0, 400));
            receipt.steps.workflowsOn = (await catalog.getSessionCapabilities(chat.sessionId))?.workflows === true;
            const valid = [];
            for (const definition of await chatStore.listDefinitions(chat.sessionId, { includeDeleted: true })) {
                for (const summary of await chatStore.listRevisions(definition.definitionId)) {
                    if (!summary.valid) continue;
                    const ir = await chatStore.readRevisionIr(definition.definitionId, summary.revision, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
                    valid.push({ name: definition.name, revision: summary.revision, states: stateKinds(ir) });
                }
            }
            receipt.steps.valid = valid;
            const runs = [];
            for (const row of receipt.steps.workflows) {
                const run = (await catalog.pool.query(`SELECT controller_version FROM "${env.cmsSchema}".workflow_runs WHERE workflow_session_id = $1`,
                    [row.id])).rows[0];
                runs.push(run?.controller_version ?? null);
            }
            receipt.steps.controllerVersions = runs;
            receipt.steps.answer = (await events(["assistant.message"])).map(event => event.data?.content)
                .filter(value => typeof value === "string" && value).at(-1)?.slice(0, 300) ?? null;

            const why = JSON.stringify(receipt);
            expect(receipt.steps.chatVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(valid.some(item => item.states.includes("agent")), `a valid revision with an agent state. ${why}`).toBe(true);
            expect(receipt.steps.refused, `no refusal. ${why}`).toEqual([]);
            expect(receipt.steps.workflows.length, `a Workflow started. ${why}`).toBeGreaterThan(0);
            expect(receipt.steps.workflows.some(row => row.status === "completed"), `a Workflow completed. ${why}`).toBe(true);
            expect(runs.every(version => version === "1.9.0"), `every run at controller 1.9.0. ${why}`).toBe(true);
        }, { workflowsOn: true });
    });

    it(TITLE_ENABLE, { timeout: TEST_TIMEOUT }, async () => {
        await realModelChat("enable", ASK_SIMPLE, async ({ worker, catalog, chat, receipt }) => {
            const chatStore = catalog.workflowStore().chat;
            // sendAndWait may come back with the enable_workflows turn's own answer: the Workflow is built on the next turn.
            const ended = await workflowsEnded(chatStore, chat.sessionId, RUN_MS);
            const workflows = ended ?? await chatStore.listWorkflows({ ownerSessionId: chat.sessionId });
            receipt.steps.workflows = workflows.map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
            const names = (await toolCallsOf(catalog, chat.sessionId)).map(call => call.name);
            receipt.steps.toolCalls = names;
            const state = await catalog.getSessionCapabilities(chat.sessionId);
            receipt.steps.workflowsFlag = state?.workflows ?? null;
            // For the record: what the chat's CLI session declares now (Workflows on: the Workflow tools, no enable_workflows).
            receipt.steps.declared = await declaredTools(worker, chat.sessionId).catch(error => `unreadable: ${error?.message ?? error}`);
            const enabledAt = names.indexOf("enable_workflows");
            const firstWorkflowTool = names.findIndex(name => WORKFLOW_TOOLS.includes(name));

            const why = JSON.stringify(receipt);
            expect(receipt.steps.chatVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(enabledAt, `enable_workflows was called. ${why}`).toBeGreaterThanOrEqual(0);
            expect(state?.workflows, `the chat's capability state has Workflows on. ${why}`).toBe(true);
            expect(firstWorkflowTool, `a Workflow tool was called, after enable_workflows. ${why}`).toBeGreaterThan(enabledAt);
            expect(names, `the Workflow was saved with workflow_definition. ${why}`).toContain("workflow_definition");
            expect(workflows.length, `a Workflow of the chat started. ${why}`).toBeGreaterThan(0);
            expect(ended, `every Workflow of the chat reached its end. ${why}`).not.toBeNull();
        });
    });

    it(TITLE_STAYS_OFF, { timeout: TEST_TIMEOUT }, async () => {
        await realModelChat("stays-off", ASK_PLAIN, async ({ worker, catalog, chat, receipt }) => {
            receipt.steps.settled = await settle(catalog, chat.sessionId, TURN_MS);
            const names = (await toolCallsOf(catalog, chat.sessionId)).map(call => call.name);
            receipt.steps.toolCalls = names;
            const state = await catalog.getSessionCapabilities(chat.sessionId);
            receipt.steps.workflowsFlag = state?.workflows ?? null;
            receipt.steps.ownsWorkflows = await catalog.workflowStore().chat.hasWorkflows(chat.sessionId);
            const declared = await declaredTools(worker, chat.sessionId);
            receipt.steps.declared = declared;

            const why = JSON.stringify(receipt);
            expect(receipt.steps.chatVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(names, `enable_workflows was not called. ${why}`).not.toContain("enable_workflows");
            expect(names.filter(name => WORKFLOW_TOOLS.includes(name)), `no Workflow tool was called. ${why}`).toEqual([]);
            expect(state?.workflows === true, `the chat's capability state has Workflows off. ${why}`).toBe(false);
            expect(receipt.steps.ownsWorkflows, `the chat owns no Workflow Definition or Workflow. ${why}`).toBe(false);
            expect(declared, `the chat's CLI session is warm on this worker. ${why}`).not.toBeNull();
            expect(declared, `enable_workflows is declared while Workflows are off. ${why}`).toContain("enable_workflows");
            expect(declared.filter(name => WORKFLOW_TOOLS.includes(name)), `no Workflow tool is declared. ${why}`).toEqual([]);
        });
    });

    it(TITLE_LOAD_SKILL, { timeout: TEST_TIMEOUT }, async () => {
        await realModelChat("load-skill", ASK_SKILL, async ({ catalog, chat, receipt }) => {
            // Turning Workflows on first is allowed: enable_workflows ends its turn (sendAndWait may return there) and the next
            // one, started at once, loads the skill. So wait for a load (load_skill or "skill") to have its result, or for the
            // chat to be quiet with something after its last enable_workflows call; then for the chat to settle.
            const loadedOrQuiet = async () => {
                const calls = await toolCallsOf(catalog, chat.sessionId);
                if (calls.some(call => (call.name === "load_skill" || call.name === "skill") && call.result !== null)) return true;
                if (calls.at(-1)?.name === "enable_workflows") return false;
                return settle(catalog, chat.sessionId, 5_000);
            };
            receipt.steps.loadedOrQuiet = Boolean(await until(loadedOrQuiet, TURN_MS));
            receipt.steps.settled = await settle(catalog, chat.sessionId, TURN_MS);
            const calls = await toolCallsOf(catalog, chat.sessionId);
            receipt.steps.toolCalls = calls.map(call => call.name);
            receipt.steps.workflowsFlag = (await catalog.getSessionCapabilities(chat.sessionId))?.workflows ?? null;
            const loads = calls.filter(call => call.name === "load_skill")
                .map(call => ({ name: String(call.args?.name ?? "").trim(), result: call.result ?? "" }));
            receipt.steps.loadSkill = loads.map(load => ({ name: load.name, result: load.result.slice(0, 120) }));
            // By name, as the guidance says; or by the reference search_capabilities gives, when its result is that skill.
            const byReference = load => load.name.startsWith("cap1.") && AUTHORING_BY_REFERENCE.test(load.result);
            const authoring = loads.filter(load => load.name.toLowerCase() === AUTHORING_SKILL || byReference(load));
            const loaded = authoring.some(load => load.result.startsWith(`[SKILL: ${AUTHORING_SKILL}]`) || byReference(load));

            const why = JSON.stringify(receipt);
            expect(receipt.steps.chatVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(receipt.steps.toolCalls, `no tool named "skill" was called. ${why}`).not.toContain("skill");
            expect(authoring.length, `load_skill was called for ${AUTHORING_SKILL}. ${why}`).toBeGreaterThan(0);
            expect(loaded, `load_skill returned the ${AUTHORING_SKILL} skill. ${why}`).toBe(true);
        });
    });
});
