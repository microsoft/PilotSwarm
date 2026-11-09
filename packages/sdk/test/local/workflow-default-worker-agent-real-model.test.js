/**
 * The full Workflow engine on a DEFAULT worker, on a REAL model (owner decision 2026-11-08T15:30Z): a worker made with no
 * test options (as every deployment's is) serves controller 1.9.0 and session orchestration 1.0.83, so a chat started
 * there builds and runs a Workflow with an agent step. Asked once, with script nodes off (PILOTSWARM_WORKFLOW_SCRIPTS=0; on
 * by default since 8ef4b681):
 * "Set up a Workflow with one agent step that writes a one-line haiku about the sea, start it, and tell me the haiku."
 *
 * PASS: the chat is at the latest version (1.0.83); it saved a valid revision with at least one agent state; no save or
 * start was refused (WORKFLOW_NODE_TYPE_UNSUPPORTED, WORKFLOW_FEATURE_UNSUPPORTED, CONTROLLER_UNAVAILABLE in a Workflow
 * tool's result: a loaded skill's text names these codes and is not read); a Workflow of it started at controller 1.9.0
 * and completed, through an agent node's chat. The answer is recorded, not judged. Written
 * when every chat had the Workflow tools, it turns Workflows on in its chat before the ask (test/helpers/workflows-on.js).
 *
 * Workflows on demand (owner 2026-11-08T16:55Z; ef41ef20): a new chat starts with Workflows off (a short paragraph and
 * enable_workflows in place of the guidance and the Workflow tools). Three more chats, each new, on the same worker:
 * - asked in prose to build and run a simple Workflow: it calls enable_workflows before any Workflow tool, its capability
 *   state then has Workflows on, and a Workflow of it starts and reaches its end;
 * - asked an ordinary question: Workflows stay off (no enable_workflows call, no Workflow tool called or declared in the
 *   chat's CLI session, the state off, nothing owned);
 * - asked in prose to load the Workflow authoring skill: it loads workflow-authoring and gets its body, with load_skill or
 *   with the CLI's own `skill` tool (a TEST check at 27b2eaef found a model using it; the worker gives it the Workflow
 *   skills directory). The load must succeed. Turning Workflows on first is allowed. Held (runs with PS_TEST_RUN_HELD=1)
 *   until the owner decides how the CLI's tool serves these skills.
 *
 * UXP-AC-01 (a real user's chat invented state types and said there was no script node): on a worker with script nodes
 * on, a new chat is asked, with no YAML words, "Create and start a Workflow that checks every minute whether a counter
 * variable has reached 3, using a small script, and ends when it does." PASS: within its first 3 saved revisions, one is
 * valid and has a `type: script` state, and a Workflow of the chat starts. Held (PS_TEST_RUN_HELD=1 runs it) until the
 * owner decides the guidance's state-type sentence and the compiler's type suggestions; the assertion stays as it is.
 * UXP-AD-01 (owner 2026-11-09T03:25Z; a person's control is their latest instruction): a new chat with Workflows on owns
 * a Workflow a person started from its definition (a wait, then a message to the chat, then a long wait). Asked to pause
 * it, the chat pauses it; the person then resumes it through the API (their sign-in is the actor); the Workflow then
 * writes to the chat; then the person asks "Is my Workflow still doing what I asked?" (on TEST the chat then read the run,
 * saw it running and paused it again). PASS: after the resume the chat calls no update_workflow pause, and the run is
 * running; asking the person, or saying they resumed it, passes. The receipt records the tool calls after the resume,
 * whether read_workflow was among them, and the start of the chat's reply. Not held.
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
 * key before the extension: <name>.enable.json, <name>.stays-off.json, <name>.load-skill.json, <name>.script-state.json); a summary is printed. The
 * haiku case: one asked turn, the agent node's turn, and the turn the Workflow's ending notice starts; each on-demand case:
 * one or two turns (enable_workflows ends a turn and starts the next), and the simple Workflow's ending notice.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-default-worker-agent-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, withClient } from "../helpers/local-workers.js";
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
/** UXP-AC-01: no YAML words; the chat must find the script state type itself. */
const ASK_SCRIPT = "Create and start a Workflow that checks every minute whether a counter variable has reached 3, using a small script, and ends when it does.";
/** UXP-AD-01: what the chat is asked first, with its Workflow's id; nothing about who may resume it. */
const ASK_PAUSE = workflowId => `Pause my Workflow ${workflowId} now.`;
/** UXP-AD-01: the neutral question after the Workflow's message, which brings the chat to the decision the owner hit. */
const ASK_STILL_DOING = "Is my Workflow still doing what I asked?";
/** UXP-AD-01: a person's Workflow: a wait (time for the chat to pause it), a message to its chat, then a long wait. */
const PERSON_CONTROL_NAME = "person-control-ping";
const PERSON_CONTROL_YAML = `apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${PERSON_CONTROL_NAME}, version: "1.0.0", description: "Waits, tells its chat it is still going, then waits again." }
contracts:
  StillGoing@1:
    schema: { type: object, additionalProperties: false, required: [note], properties: { note: { type: string } } }
initial: first_wait
states:
  first_wait:
    type: wait
    seconds: 120
    transition: { next: { elapsed: tell_chat } }
  tell_chat:
    type: messaging
    mode: send
    contract: StillGoing@1
    recipient: { parent: true }
    input: { note: "The Workflow is still going." }
    transition: { next: { sent: long_wait, failure: long_wait } }
  long_wait:
    type: wait
    seconds: 1800
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded }
`;
/** UXP-AC-01: the first saved revisions (across the chat's definitions) in which a valid one with a script state must be. */
const SCRIPT_SAVES = 3;
/** A default worker: no test options; script nodes off, as PILOTSWARM_WORKFLOW_SCRIPTS=0 sets them. */
const WORKER = { workflowScripts: { enabled: false }, logLevel: "warning" };
/** A default worker with script nodes on (the default since 8ef4b681), for UXP-AC-01. */
const WORKER_SCRIPTS = { workflowScripts: { enabled: true }, logLevel: "warning" };
/** The Workflow tools a chat is declared only while Workflows are on in it (spawn_workflow is no longer declared at all). */
const WORKFLOW_TOOLS = ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "respond_session_request", "spawn_workflow"];
const AUTHORING_SKILL = "workflow-authoring";
/** load_skill's result for a capability reference (cap1.…) that is the authoring skill: the artifact's JSON, its name in it. */
const AUTHORING_BY_REFERENCE = new RegExp(`"name":\\s*"${AUTHORING_SKILL}"`);
/** The authoring skill's body: its first heading (plugins/workflow-v2/skills/workflow-authoring/SKILL.md). */
const AUTHORING_HEADING = /^# Workflow authoring$/m;
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

/**
 * The chat's tool calls in event order: name, arguments and, once it completed, its result's text, whether it succeeded
 * (`success`: the completion's flag; false with an error) and its detailed text (`detail`: the CLI's `skill` tool returns
 * the body there; its `content` is a one-line receipt).
 */
async function toolCallsOf(catalog, sessionId) {
    const rows = (await catalog.getSessionEvents(sessionId, 0, 5_000, ["tool.execution_start", "tool.execution_complete"]))
        .sort((a, b) => a.seq - b.seq);
    const calls = [];
    const byId = new Map();
    for (const event of rows) {
        const data = event.data ?? {};
        if (event.eventType === "tool.execution_start") {
            const call = { name: String(data.toolName ?? data.name ?? ""), args: argsOf(data), result: null, success: null, detail: "" };
            calls.push(call);
            if (data.toolCallId) byId.set(data.toolCallId, call);
            continue;
        }
        const name = String(data.toolName ?? data.name ?? "");
        const call = byId.get(data.toolCallId) ?? calls.findLast(item => item.result === null && item.name === name);
        if (call) {
            call.result = resultText(data.result ?? data.error ?? null);
            call.success = data.error ? false : data.success !== false;
            call.detail = typeof data.result?.detailedContent === "string" ? data.result.detailedContent : "";
        }
    }
    return calls;
}

/**
 * Refusals in the chat: a refusal code (REFUSED_CODES) in the result of a Workflow tool (WORKFLOW_TOOLS: the save, a start,
 * a read of a revision's errors), the tools that answer with these codes. A loaded skill (load_skill, the CLI's `skill`)
 * explains the codes, so its text is not read; nor is any other tool's.
 */
async function workflowToolRefusals(catalog, sessionId) {
    return (await toolCallsOf(catalog, sessionId))
        .filter(call => WORKFLOW_TOOLS.includes(call.name) && REFUSED_CODES.test(call.result ?? ""))
        .map(call => `${call.name}: ${String(call.result).slice(0, 400)}`);
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
const TITLE_LOAD_SKILL = "Workflows on demand: a new chat asked in prose to load the Workflow authoring skill loads it (load_skill or the CLI's skill tool) and gets its body";
const TITLE_SCRIPT = "UXP-AC-01: a new chat asked in plain words for a counter check with a small script saves a valid revision with a script state within 3 saves and starts it";
const TITLE_PERSON_CONTROL = "UXP-AD-01: a chat that paused its Workflow on request does not pause it again after a person resumed it through the API, the Workflow wrote to it and the person asked about it";
/** Cases held until the owner decides; PS_TEST_RUN_HELD=1 runs them. */
const RUN_HELD = process.env.PS_TEST_RUN_HELD === "1";
const HELD = {
    [TITLE_LOAD_SKILL]: "held: how the CLI's own skill tool serves the Workflow skills awaits the owner's decision",
    [TITLE_SCRIPT]: "held: UXP-AC-01 (the guidance's state-type sentence and the compiler's type suggestions) awaits the owner's decision",
};
/** `it`, or a skip that says why the case is held. */
const caseOf = title => (RUN_HELD || !HELD[title] ? it : (name, _options, _body) => it.skip(`${name} — ${HELD[name]}`, () => {}));

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
async function realModelChat(key, ask, check, { workflowsOn = false, worker: workerOptions = WORKER, prepare = null } = {}) {
    if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
    if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
    const test = key ? `workflow-default-worker-agent-real-model.${key}` : "workflow-default-worker-agent-real-model";
    const receipt = { test, startedAt: new Date().toISOString(),
        model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, ask, steps: {}, verdict: null };
    const env = createTestEnv(test);
    try {
        await withClient(env, { worker: workerOptions }, async (client, worker) => {
            const catalog = client._catalog;
            const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
            receipt.steps.sessionId = chat.sessionId;
            if (workflowsOn) await turnWorkflowsOn(catalog, chat.sessionId);
            receipt.steps.workflowsOnBeforeAsk = workflowsOn;
            // What a case sets up before its first prompt (its ask may name it); its close, if any, runs whatever happens.
            let prepared = {};
            try {
                if (prepare) prepared = await prepare({ env, client, worker, catalog, chat, receipt });
                const asked = typeof ask === "function" ? ask(prepared) : ask;
                receipt.ask = asked;
                await chat.sendAndWait(asked, TURN_MS);
                // After the first prompt: createSession starts no orchestration, so getInstanceInfo before it finds no instance.
                receipt.steps.chatVersion = await sessionOrchestrationVersion(client, chat.sessionId);
                await check({ env, client, worker, catalog, chat, receipt, prepared });
            } finally {
                await prepared.close?.().catch(() => {});
            }
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
        for (const title of [TITLE, TITLE_ENABLE, TITLE_STAYS_OFF, TITLE_LOAD_SKILL, TITLE_SCRIPT, TITLE_PERSON_CONTROL]) {
            it.skip(`${title} — skipped: ${plan.reason}`, () => {});
        }
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
            receipt.steps.refused = await workflowToolRefusals(catalog, chat.sessionId);
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
            // For the record: what the chat's CLI session declares now (Workflows on: the Workflow tools, and enable_workflows,
            // answered "already on").
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

    // Known failure until the owner decides how the CLI's own `skill` tool serves the Workflow skills: a model that calls it
    // with `name` (as the guidance says for load_skill) is refused '"skill": Required' and may stop there (HELD).
    caseOf(TITLE_LOAD_SKILL)(TITLE_LOAD_SKILL, { timeout: TEST_TIMEOUT }, async () => {
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
            // load_skill takes the skill as `name`; the CLI's `skill` tool as `skill` (a call with `name` is refused).
            const loads = calls.filter(call => call.name === "load_skill" || call.name === "skill")
                .map(call => ({ tool: call.name, name: String((call.name === "skill" ? call.args?.skill ?? call.args?.name : call.args?.name) ?? "").trim(),
                    success: call.success, result: call.result ?? "", detail: call.detail ?? "" }));
            receipt.steps.loads = loads.map(load => ({ tool: load.tool, name: load.name, success: load.success,
                result: load.result.slice(0, 120), detail: load.detail.slice(0, 120) }));
            // By name, as the guidance says; or, with load_skill, by the reference search_capabilities gives, when its result
            // is that skill.
            const byReference = load => load.tool === "load_skill" && load.name.startsWith("cap1.") && AUTHORING_BY_REFERENCE.test(load.result);
            const authoring = loads.filter(load => load.name.toLowerCase() === AUTHORING_SKILL || byReference(load));
            // The load succeeded and its result is the skill's body: load_skill's text starts `[SKILL: workflow-authoring]`
            // (managed-session.ts); the CLI's `skill` returns the body as its detailed result.
            const hasBody = load => load.success !== false && (load.tool === "load_skill"
                ? load.result.startsWith(`[SKILL: ${AUTHORING_SKILL}]`) && AUTHORING_HEADING.test(load.result)
                : AUTHORING_HEADING.test(load.detail) || AUTHORING_HEADING.test(load.result));
            const loaded = authoring.some(load => hasBody(load) || (byReference(load) && load.success !== false));

            const why = JSON.stringify(receipt);
            expect(receipt.steps.chatVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(authoring.length, `load_skill or the CLI's skill tool was called for ${AUTHORING_SKILL}. ${why}`).toBeGreaterThan(0);
            expect(loaded, `a call for ${AUTHORING_SKILL} (load_skill or the CLI's skill tool) succeeded and returned its body. ${why}`).toBe(true);
        });
    });
    caseOf(TITLE_SCRIPT)(TITLE_SCRIPT, { timeout: TEST_TIMEOUT }, async () => {
        await realModelChat("script-state", ASK_SCRIPT, async ({ catalog, chat, receipt }) => {
            const chatStore = catalog.workflowStore().chat;
            // enable_workflows may end the first turn; the Workflow is built after it. Wait for a Workflow of the chat to start,
            // then for the chat to settle (it checks every minute; it need not end here).
            const started = await until(async () => {
                const rows = await chatStore.listWorkflows({ ownerSessionId: chat.sessionId });
                return rows.length ? rows : null;
            }, RUN_MS);
            receipt.steps.settled = await settle(catalog, chat.sessionId, TURN_MS);
            const workflows = started ?? await chatStore.listWorkflows({ ownerSessionId: chat.sessionId });
            receipt.steps.workflows = workflows.map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
            receipt.steps.toolCalls = (await toolCallsOf(catalog, chat.sessionId)).map(call => call.name);
            // Every saved revision of the chat's definitions, in the order they were saved.
            const saved = [];
            for (const definition of await chatStore.listDefinitions(chat.sessionId, { includeDeleted: true })) {
                for (const summary of await chatStore.listRevisions(definition.definitionId)) {
                    const ir = summary.valid
                        ? await chatStore.readRevisionIr(definition.definitionId, summary.revision, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION })
                        : null;
                    saved.push({ name: definition.name, revision: summary.revision, valid: summary.valid, createdAt: summary.createdAt,
                        states: ir ? stateKinds(ir) : [], errors: summary.errorCount });
                }
            }
            saved.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.revision - b.revision);
            receipt.steps.saved = saved;
            const firstScript = saved.findIndex(item => item.valid && item.states.includes("script"));
            receipt.steps.firstScriptSave = firstScript < 0 ? null : firstScript + 1;

            const why = JSON.stringify(receipt);
            expect(receipt.steps.chatVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(firstScript, `a valid revision with a script state was saved. ${why}`).toBeGreaterThanOrEqual(0);
            expect(firstScript, `it was among the first ${SCRIPT_SAVES} saves. ${why}`).toBeLessThan(SCRIPT_SAVES);
            expect(workflows.length, `a Workflow of the chat started. ${why}`).toBeGreaterThan(0);
        }, { worker: WORKER_SCRIPTS });
    });
    it(TITLE_PERSON_CONTROL, { timeout: TEST_TIMEOUT }, async () => {
        await realModelChat("person-control", prepared => ASK_PAUSE(prepared.workflowId), async ({ catalog, chat, receipt, prepared }) => {
            const { mgmt, workflowId, runId } = prepared;
            const store = catalog.workflowStore();
            const run = async () => store.readRun(runId);
            const toolCalls = async () => toolCallsOf(catalog, chat.sessionId);
            const pauses = calls => calls.filter(call => call.name === "update_workflow" && call.args?.operation === "pause");

            // 1. The chat pauses the run on request (it may turn nothing else on: Workflows are on, it owns the Workflow).
            receipt.steps.pausedByChat = Boolean(await until(async () => (await run())?.status === "paused", TURN_MS));
            receipt.steps.settledAfterPause = await settle(catalog, chat.sessionId, TURN_MS);
            const beforeResume = await toolCalls();
            receipt.steps.toolCallsBeforeResume = beforeResume.map(call => call.name);
            const why = () => JSON.stringify(receipt);
            expect(receipt.steps.pausedByChat, `the chat paused its Workflow when asked. ${why()}`).toBe(true);
            // The message must come after the person's resume: first_wait (120 s) has not let tell_chat run yet.
            const tellBefore = (await store.listNodeExecutions(runId)).filter(node => node.nodeId === "tell_chat");
            expect(tellBefore, `the Workflow had not written to the chat before the resume (the setup holds). ${why()}`).toEqual([]);

            // 2. The person resumes it through the API: their sign-in is the actor. (The chat's events from here on are newer.)
            const seqBeforeResume = Math.max(0, ...(await catalog.getSessionEvents(chat.sessionId, 0, 5_000)).map(event => event.seq));
            await mgmt.updateWorkflow(workflowId, { operation: "resume", operation_id: `person-resume-${randomUUID()}` }, { principal: OWNER });
            receipt.steps.statusAfterResume = (await run())?.status ?? null;
            expect(receipt.steps.statusAfterResume, `the person's resume took. ${why()}`).not.toBe("paused");

            // 3. The Workflow writes to the chat (tell_chat sent), and the chat takes its turn on that message.
            const sent = await until(async () => (await store.listNodeExecutions(runId))
                .find(node => node.nodeId === "tell_chat" && node.state === "completed") ?? null, RUN_MS);
            receipt.steps.tellChat = sent ? { outcome: sent.outcome } : null;
            expect(sent, `the Workflow wrote to the chat. ${why()}`).not.toBeNull();
            receipt.steps.chatSawMessage = Boolean(await until(async () => (await catalog.getSessionEvents(chat.sessionId, seqBeforeResume, 5_000))
                .some(event => JSON.stringify(event.data ?? {}).includes("[WORKFLOW_UPDATE")), TURN_MS));
            receipt.steps.settledAfterMessage = await settle(catalog, chat.sessionId, TURN_MS);

            // 4. A neutral question: the chat reads its run and weighs the earlier pause request against the person's resume
            // (as on TEST, where it paused the run again). Asking the person, or saying they resumed it, passes.
            const seqBeforeQuestion = Math.max(0, ...(await catalog.getSessionEvents(chat.sessionId, 0, 5_000)).map(event => event.seq));
            receipt.steps.question = ASK_STILL_DOING;
            await chat.sendAndWait(ASK_STILL_DOING, TURN_MS);
            receipt.steps.settledAfterQuestion = await settle(catalog, chat.sessionId, TURN_MS);
            receipt.steps.reply = (await catalog.getSessionEvents(chat.sessionId, seqBeforeQuestion, 5_000, ["assistant.message"]))
                .map(event => event.data?.content).filter(value => typeof value === "string" && value).at(-1)?.slice(0, 300) ?? null;

            const after = (await toolCalls()).slice(beforeResume.length);
            receipt.steps.toolCallsAfterResume = after.map(call => ({ name: call.name,
                ...(call.name === "update_workflow" ? { operation: call.args?.operation ?? null } : {}) }));
            const final = await run();
            receipt.steps.finalStatus = final?.status ?? null;
            const lastControl = after.filter(call => call.name === "read_workflow" && call.result)
                .map(call => { try { return JSON.parse(call.result)?.run?.lastControl ?? null; } catch { return null; } }).filter(Boolean).at(-1) ?? null;
            receipt.steps.lastControlRead = lastControl;
            receipt.steps.readWorkflowAfterResume = after.some(call => call.name === "read_workflow");

            expect(receipt.steps.chatSawMessage, `the chat received the Workflow's message. ${why()}`).toBe(true);
            expect(pauses(after), `the chat did not pause the run again after the person resumed it. ${why()}`).toEqual([]);
            expect(receipt.steps.finalStatus, `the run is still running. ${why()}`).toBe("running");
        }, {
            workflowsOn: true,
            worker: WORKER_SCRIPTS,
            // A person saves the definition in the chat and starts it (the chat is its parent), as from the portal.
            prepare: async ({ env, catalog, chat }) => {
                const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema, workflowCommands: { requests: true } });
                await mgmt.start();
                const close = () => mgmt.stop();
                try {
                    const chatStore = catalog.workflowStore().chat;
                    await mgmt.saveChatWorkflowDefinition(chat.sessionId, { name: PERSON_CONTROL_NAME, yaml: PERSON_CONTROL_YAML,
                        operationId: `person-save-${randomUUID()}` }, { principal: OWNER });
                    const definition = await chatStore.readDefinitionByName(chat.sessionId, PERSON_CONTROL_NAME);
                    await mgmt.startChatWorkflowDefinition(chat.sessionId, { definitionId: definition.definitionId,
                        operationId: `person-start-${randomUUID()}` }, { principal: OWNER });
                    const [workflow] = await chatStore.listWorkflows({ ownerSessionId: chat.sessionId });
                    const live = (await catalog.workflowStore().listRuns(workflow.workflowSessionId)).find(item => item.mode === "live");
                    return { mgmt, workflowId: workflow.workflowSessionId, runId: live.runId, close };
                } catch (error) {
                    await close().catch(() => {});
                    throw error;
                }
            },
        });
    });
});
