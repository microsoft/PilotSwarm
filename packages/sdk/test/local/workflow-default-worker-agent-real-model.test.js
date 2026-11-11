/**
 * The full Workflow engine on a DEFAULT worker, on a REAL model (owner decision 2026-11-08T15:30Z): a worker made with no
 * test options (as every deployment's is) serves the Workflow controller and session orchestration 1.0.83, so a session started
 * there builds and runs a Workflow with an agent step. Asked once, with script nodes off (PILOTSWARM_WORKFLOW_SCRIPTS=0; on
 * by default since 8ef4b681):
 * "Set up a Workflow with one agent step that writes a one-line haiku about the sea, start it, and tell me the haiku."
 *
 * PASS: the session is at the latest version (1.0.83); it saved a valid revision with at least one agent state; no save or
 * start was refused (WORKFLOW_NODE_TYPE_UNSUPPORTED, WORKFLOW_FEATURE_UNSUPPORTED, CONTROLLER_UNAVAILABLE in a Workflow
 * tool's result: a loaded skill's text names these codes and is not read); a Workflow of it started at the Workflow controller
 * and completed, through an agent node's session. The answer is recorded, not judged. Written
 * when every session had the Workflow tools, it turns Workflows on in its session before the ask (test/helpers/workflows-on.js).
 *
 * Workflows on demand (owner 2026-11-08T16:55Z; ef41ef20): a new session starts with Workflows off (a short paragraph and
 * enable_workflows in place of the guidance and the Workflow tools). Three more sessions, each new, on the same worker:
 * - asked in prose to build and run a simple Workflow: it calls enable_workflows before any Workflow tool, its capability
 *   state then has Workflows on, and a Workflow of it starts and reaches its end;
 * - asked an ordinary question: Workflows stay off (no enable_workflows call, no Workflow tool called or declared in the
 *   session's CLI session, the state off, nothing owned);
 * - asked in prose to load the Workflow authoring skill: it loads workflow-authoring and gets its body, with load_skill or
 *   with the CLI's own `skill` tool (a TEST check at 27b2eaef found a model using it; the worker gives it the Workflow
 *   skills directory). The load must succeed. Turning Workflows on first is allowed. Owner 2026-11-09T06:40Z approved how
 *   the CLI's tool serves these skills (A), so it runs with the other cases.
 *
 * Consent (owner 2026-11-11, review of aeb684f5 test item 4): only turning Workflows on needs the user's agreement. On a
 * worker with script nodes on:
 * - a new session (Workflows off) asked for a repeated check that suits a Workflow, without asking for one. Gating: it does
 *   not turn Workflows on and calls no Workflow tool; told "no", it still does not, and saves or starts nothing; told "yes",
 *   it turns them on, once, and reaches a valid, started Workflow. Each phase must end (settle) before the next message.
 *   Non-gating (KNOWN_CRON_GAP, owner decision B 2026-11-11, guidance follow-up): its first reply asks the user's agreement to
 *   use a Workflow (a question, not a mention: the consent oracle, checked with its own examples below);
 * - a new session with Workflows already on, asked the same. Non-gating (KNOWN_CRON_GAP): it saves a valid revision and
 *   starts a Workflow of it, without enable_workflows and without asking to turn Workflows on.
 * Each consent case is capped: its phases are bounded, and it cancels its session at the end (which ends a session cron
 * the model set), so a cron never holds the case past its timeout. Non-gating results go to receipt.nonGating.
 * The explicit request is the enable case above.
 *
 * UXP-AC-01 (a real user's session invented state types and said there was no script node): on a worker with script nodes
 * on, a new session is asked, with no YAML words, "Create and start a Workflow that checks every minute whether a counter
 * variable has reached 3, using a small script, and ends when it does." PASS: within its first 3 saved revisions, one is
 * valid and has a `type: script` state, and a Workflow of the session starts. Owner 2026-11-09T06:40Z approved the guidance's
 * state-type sentence (I1) and the compiler's type suggestions (I2), so it runs with the other cases; the assertion is
 * unchanged.
 * UXP-AD-01 (owner 2026-11-09T03:25Z; a person's control is their latest instruction): a new session with Workflows on owns
 * a Workflow a person started from its definition (a wait, then a message to the session, then a long wait). Asked to pause
 * it, the session pauses it; the person then resumes it through the API (their sign-in is the actor); the Workflow then
 * writes to the session; then the person asks "Is my Workflow still doing what I asked?" (on TEST the session then read the run,
 * saw it running and paused it again). PASS: after the resume the session calls no update_workflow pause, and the run is
 * running; asking the person, or saying they resumed it, passes. The receipt records the tool calls after the resume,
 * whether read_workflow was among them, and the start of the session's reply. Not held.
 * Every case checks tool calls, events, tool metadata and stored state, never the model's words.
 *
 * Every case reads the session's orchestration version after its first prompt: createSession writes only the session row,
 * and its instance (session-<id>) starts with the first prompt (client.ts _ensureOrchestrationAndSend). Read before,
 * Duroxide's getInstanceInfo fails with "get_instance_info: Instance not found" (this file's earlier failure at ~2 s).
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_REAL_MODEL=run with PS_WORKFLOW_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_REAL_MODEL_RECEIPT when set (an on-demand case's to the same path with its
 * key before the extension: <name>.enable.json, <name>.stays-off.json, <name>.load-skill.json, <name>.script-state.json,
 * <name>.consent.json, <name>.already-on.json); a summary is printed. The
 * haiku case: one asked turn, the agent node's turn, and the turn the Workflow's ending notice starts; each on-demand case:
 * one or two turns (enable_workflows ends a turn and starts the next), and the simple Workflow's ending notice.
 *
 *   PS_WORKFLOW_REAL_MODEL=run PS_WORKFLOW_REAL_MODEL_REF=<provider:model> \
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
import { realModelPlan } from "../helpers/workflow-real-model.mjs";
import { realModelWorkflowEvidence } from "../helpers/workflow-real-model-evidence.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-default-worker-agent-real-model" };
const ASK = "Set up a Workflow with one agent step that writes a one-line haiku about the sea, start it, and tell me the haiku.";
const ASK_SIMPLE = "Build a simple Workflow that waits 5 seconds and then finishes, start it, and tell me when it has finished.";
const ASK_PLAIN = "What is the capital of France? Answer in one word.";
const ASK_SKILL = "Load the Workflow authoring skill, then tell me in one sentence what it covers.";
/** Consent: a repeated check a script could do, with no word about Workflows. */
const ASK_REPEAT = "Every minute for the next five minutes, check whether https://example.com answers, then tell me how many of the checks got an answer.";
/** Consent: the user declines the suggestion, then accepts it. */
const ASK_DECLINE = "No, don't use a Workflow for that. Don't set anything up.";
const ASK_ACCEPT = "I changed my mind: yes, use a Workflow for it.";
/** UXP-AC-01: no YAML words; the session must find the script state type itself. */
const ASK_SCRIPT = "Create and start a Workflow that checks every minute whether a counter variable has reached 3, using a small script, and ends when it does.";
/** UXP-AD-01: what the session is asked first, with its Workflow's id; nothing about who may resume it. */
const ASK_PAUSE = workflowId => `Pause my Workflow ${workflowId} now.`;
/** UXP-AD-01: the neutral question after the Workflow's message, which brings the session to the decision the owner hit. */
const ASK_STILL_DOING = "Is my Workflow still doing what I asked?";
/** UXP-AD-01: a person's Workflow: a wait (time for the session to pause it), a message to its session, then a long wait. */
const PERSON_CONTROL_NAME = "person-control-ping";
const PERSON_CONTROL_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${PERSON_CONTROL_NAME}, version: "1.0.0", description: "Waits, tells its session it is still going, then waits again." }
contracts:
  StillGoing@1:
    schema: { type: object, additionalProperties: false, required: [note], properties: { note: { type: string } } }
initial: first_wait
states:
  first_wait:
    type: wait
    seconds: 120
    transition: { next: { elapsed: tell_session } }
  tell_session:
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
/** UXP-AC-01: the first saved revisions (across the session's definitions) in which a valid one with a script state must be. */
const SCRIPT_SAVES = 3;
/** A default worker: no test options; script nodes off, as PILOTSWARM_WORKFLOW_SCRIPTS=0 sets them. */
const WORKER = { workflowScripts: { enabled: false }, logLevel: "warning" };
/** A default worker with script nodes on (the default since 8ef4b681), for UXP-AC-01. */
const WORKER_SCRIPTS = { workflowScripts: { enabled: true }, logLevel: "warning" };
/** The Workflow tools a session is declared only while Workflows are on in it (spawn_workflow is no longer declared at all). */
const WORKFLOW_TOOLS = ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "respond_session_request", "spawn_workflow"];
const AUTHORING_SKILL = "workflow-authoring";
/** load_skill's result for a capability reference (cap1.…) that is the authoring skill: the artifact's JSON, its name in it. */
const AUTHORING_BY_REFERENCE = new RegExp(`"name":\\s*"${AUTHORING_SKILL}"`);
/** The authoring skill's body: its first heading (plugins/workflow/skills/workflow-authoring/SKILL.md). */
const AUTHORING_HEADING = /^# Workflow authoring$/m;
const TURN_MS = 300_000;
const RUN_MS = 300_000;
const TEST_TIMEOUT = 15 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);
/** A session's row states between turns, or once it ended (nothing more comes). */
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
 * The session's tool calls in event order: name, arguments and, once it completed, its result's text, whether it succeeded
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
 * Refusals in the session: a refusal code (REFUSED_CODES) in the result of a Workflow tool (WORKFLOW_TOOLS: the save, a start,
 * a read of a revision's errors), the tools that answer with these codes. A loaded skill (load_skill, the CLI's `skill`)
 * explains the codes, so its text is not read; nor is any other tool's.
 */
async function workflowToolRefusals(catalog, sessionId) {
    return (await toolCallsOf(catalog, sessionId))
        .filter(call => WORKFLOW_TOOLS.includes(call.name) && REFUSED_CODES.test(call.result ?? ""))
        .map(call => `${call.name}: ${String(call.result).slice(0, 400)}`);
}

/**
 * Waits until the session is between turns: its row idle (or waiting) and no new event for two polls. enable_workflows
 * ends its turn and the next one starts at once, so a returned sendAndWait does not mean the session is done. False when
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

/** The tool names the session's live CLI session declares to the model (its tool metadata), sorted; null when not warm here. */
async function declaredTools(worker, sessionId) {
    const managed = worker.sessionManager.get(sessionId);
    if (!managed) return null;
    const metadata = await managed.getCopilotSession().rpc.tools.getCurrentMetadata();
    return (metadata?.tools ?? []).map(tool => (typeof tool === "string" ? tool : tool?.name)).filter(Boolean).sort();
}

/**
 * Owner decision B (2026-11-11): with the repeated-check ask, the model sets a session cron instead of suggesting a Workflow
 * (Workflows off) or using one (Workflows on); DEV run of gpt-5.6-terra at 4fa702dc (fact pse/wfv2/results/dev-t5-realmodel-20261111).
 * Shipped as is; the Workflow guidance is tuned against cron in a follow-up. These checks are recorded in the receipt
 * (receipt.nonGating) and printed, and never fail the case.
 */
const KNOWN_CRON_GAP = "known model gap (owner decision B, 2026-11-11): the model uses a session cron for a repeated check instead of "
    + "suggesting or using a Workflow; the Workflow guidance is tuned against cron in a follow-up";

/** Record a non-gating check in the receipt and print it when it does not hold; it never fails the case. */
function reportNonGating(receipt, check, holds, evidence) {
    receipt.nonGating ??= [];
    receipt.nonGating.push({ check, holds, ...(holds ? {} : { knownGap: KNOWN_CRON_GAP }), evidence });
    if (!holds) console.warn(`[${receipt.test}] NON-GATING, does not hold: ${check}. ${KNOWN_CRON_GAP}`);
}

/** The caps of the consent cases' phases: together within TEST_TIMEOUT, with room for the stop and the evidence. */
const CONSENT_ASK_MS = 210_000;
const CONSENT_DECLINE_MS = 150_000;
const CONSENT_ACCEPT_MS = 300_000;
const ALREADY_ON_MS = 300_000;
const STOP_MS = 90_000;

/**
 * End the case's session cleanly within its cap: cancel it through the management API (which ends a session cron and the
 * session's Workflows with it), then wait until its orchestration has ended. True when it ended within STOP_MS.
 */
async function stopSession(env, client, sessionId, receipt) {
    const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema });
    await mgmt.start();
    try {
        await mgmt.cancelSession(sessionId, "the case ended (its cap)").catch(error => { receipt.steps.stopError = String(error?.message ?? error); });
        const ended = await until(async () => {
            const status = (await client._getDuroxideClient().getStatus(`session-${sessionId}`)).status;
            return ["Completed", "Failed", "Terminated"].includes(status) ? status : null;
        }, STOP_MS);
        receipt.steps.stopped = ended ?? "did not end within the stop cap";
        return ended !== null;
    } finally {
        await mgmt.stop();
    }
}

/** Whether the session started a cron (session.cron_started). */
async function cronStarted(catalog, sessionId) {
    return (await catalog.getSessionEvents(sessionId, 0, 5_000, ["session.cron_started"])).length > 0;
}

/** A phrase that asks the user for agreement. */
const CONSENT = /\b(would you like|do you want|want me to|shall i|should i|may i|can i|could i|ok(?:ay)? (?:to|if)|is (?:it|that) ok(?:ay)?|would it be ok(?:ay)?|would you prefer|like me to|go ahead|do you agree|agree to|happy for me to|sound good)\b/i;
const WORKFLOW = /\bworkflows?\b/i;
/** Using a Workflow: setting one up, using, running, creating, building, starting or making one. */
const USE_VERB = /\b(set(?:\s+\S+){0,2}\s+up|use|run|create|build|start|make)\b/i;
/** Turning Workflows on, the object between the verb and "on" included ("turn Workflows on"). */
const ACTIVATE_VERB = /\b(turn(?:\s+\S+){0,2}\s+on|switch(?:\s+\S+){0,2}\s+on|enable|activate)\b/i;
/** A question that proposes something other than using a Workflow: an alternative, avoiding it, explaining it, manual work. */
const NOT_A_PROPOSAL = /\b(cron|instead|manual(?:ly)?|avoid|without|explain|tell you (?:more )?about|what (?:a |an )?workflows? (?:is|are|does)|not use|don'?t use|keep checking|by hand|myself)\b/i;
/** An earlier sentence that proposes an alternative to a Workflow. */
const ALTERNATIVE = /\b(cron|instead|manual(?:ly)?|avoid|by hand)\b/i;
/** An earlier sentence that rules a Workflow out: unavailable, declined, refused, unnecessary or already on. */
const RULED_OUT = /\b(unavailable|not available|isn'?t available|aren'?t available|can(?:not|'t)|unable|declin\w*|refus\w*|won'?t|no need|unnecessary|not needed|already (?:on|enabled|active))\b/i;
/** A question that points back at the earlier sentence's proposal. */
const ANAPHOR = /\b(it|that|this|one|them|so)\b|\bgo ahead\b/i;
/** An earlier sentence that proposes a Workflow (fits, suits, would help) or says how one would be used. */
const PROPOSES = /\b(fit|fits|suit|suits|would (?:help|work|be)|could|can|is a good|would let)\b/i;

/** Markdown emphasis, code marks and trailing quotes or brackets removed, so "**May I?**" ends in "?". */
function plainText(text) {
    return String(text ?? "").replace(/[*_`~]+/g, "").replace(/\s+/g, " ").trim();
}

/** A message's sentences, each with its ending mark (trailing quotes or brackets dropped). */
function sentences(text) {
    return plainText(text).split(/(?<=[.!?])["')\]]*\s+/).map(item => item.replace(/["')\]]+$/, "").trim()).filter(Boolean);
}

/**
 * Consent oracle (reviews of d5118761, DR-04 and test review section 3): what one message asks. Each question (ending in
 * "?") with an asking phrase (CONSENT) is judged on its own:
 * - it proposes a Workflow when it names a Workflow and a use or activation verb (or asks for "a Workflow" outright), or
 *   when it points back (ANAPHOR) at the sentence just before it, in the same message, which names a Workflow, proposes it
 *   (PROPOSES or a verb) and does not rule it out (RULED_OUT); a question about turning on after "Workflows are off" too;
 * - a question that proposes something else (NOT_A_PROPOSAL: cron, instead, manually, avoid, explain) proposes nothing;
 * - a question that names a Workflow but none of the above is "ambiguous" (manual review).
 * Returns { verdict: "asks" | "ambiguous" | "no", activation } where activation says the question asks to turn Workflows on.
 */
function classifyConsent(message) {
    const items = sentences(message);
    let ambiguous = false;
    let asks = null;
    items.forEach((item, index) => {
        if (asks?.activation) return;
        if (!item.endsWith("?") || !CONSENT.test(item) || NOT_A_PROPOSAL.test(item)) return;
        const activation = ACTIVATE_VERB.test(item);
        if (WORKFLOW.test(item)) {
            if (USE_VERB.test(item) || activation || /\b(?:like|want|prefer)\s+(?:a|an|the)?\s*workflows?\b/i.test(item)) {
                asks = { activation: activation || Boolean(asks?.activation) };
            } else {
                ambiguous = true;
            }
            return;
        }
        const before = items[index - 1] ?? "";
        if (!ANAPHOR.test(item) || !WORKFLOW.test(before) || ALTERNATIVE.test(before)) return;
        if (activation && /\b(off|disabled|not on)\b/i.test(before) && !/\b(unavailable|not available|can(?:not|'t)|unable)\b/i.test(before)) {
            asks = { activation: true };
        } else if (!RULED_OUT.test(before) && (PROPOSES.test(before) || USE_VERB.test(before) || ACTIVATE_VERB.test(before))) {
            asks = { activation: activation || ACTIVATE_VERB.test(before) || Boolean(asks?.activation) };
        } else if (!RULED_OUT.test(before)) {
            ambiguous = true;
        }
    });
    if (asks) return { verdict: "asks", activation: asks.activation };
    return { verdict: ambiguous ? "ambiguous" : "no", activation: false };
}

/**
 * The oracle over a phase: its messages (each judged on its own: a Workflow sentence in one message never makes another
 * message's question about it), in full. "asks" when any message asks (with `activation`, asks to turn Workflows on),
 * else "ambiguous" when any is, else "no".
 */
function consentVerdict(messages, { activation = false } = {}) {
    const verdicts = messages.map(classifyConsent);
    if (verdicts.some(item => item.verdict === "asks" && (!activation || item.activation))) return "asks";
    if (verdicts.some(item => item.verdict === "ambiguous" || (activation && item.verdict === "asks"))) return activation ? "no" : "ambiguous";
    return "no";
}

/** Whether `text` (one message, or a list of messages) asks the user's agreement to use (or, with `activation`, turn on) a Workflow. */
function asksWorkflowAgreement(text, options = {}) {
    return consentVerdict(Array.isArray(text) ? text : [text], options) === "asks";
}

/**
 * The session's own messages in a phase, in full and each on its own: its assistant messages and the questions of its
 * ask_user calls, from `seq` on. A receipt shows an excerpt; the oracle reads all of them.
 */
async function phaseMessages(catalog, sessionId, seq) {
    const events = await catalog.getSessionEvents(sessionId, seq, 5_000, ["assistant.message", "tool.execution_start"]);
    return events.map(event => event.eventType === "assistant.message"
        ? event.data?.content
        : String(event.data?.toolName ?? event.data?.name ?? "") === "ask_user" ? argsOf(event.data).question : null)
        .filter(value => typeof value === "string" && value);
}

/** A receipt's excerpt of a phase's messages (display only; the oracle reads them in full). */
const excerpt = (messages, max = 1_200) => messages.join("\n").slice(0, max);

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
const TITLE_ENABLE = "Workflows on demand: a new session asked in prose to build and run a simple Workflow calls enable_workflows, then runs it to its end";
const TITLE_STAYS_OFF = "Workflows on demand: a new session asked an ordinary question keeps Workflows off (no enable_workflows, no Workflow tool declared)";
const TITLE_LOAD_SKILL = "Workflows on demand: a new session asked in prose to load the Workflow authoring skill loads it (load_skill or the CLI's skill tool) and gets its body";
const TITLE_SCRIPT = "UXP-AC-01: a new session asked in plain words for a counter check with a small script saves a valid revision with a script state within 3 saves and starts it";
const TITLE_CONSENT = "Consent: with Workflows off, a repeated check gets a suggestion and no activation; a decline keeps them off; an acceptance turns them on once";
const TITLE_ALREADY_ON = "Consent: with Workflows already on, the same repeated check uses a Workflow without turning them on again";
const TITLE_PERSON_CONTROL = "UXP-AD-01: a session that paused its Workflow on request does not pause it again after a person resumed it through the API, the Workflow wrote to it and the person asked about it";
/** Every case runs: none is held any more (owner 2026-11-09T06:40Z decided A, I1 and I2). */
const caseOf = () => it;

/** Where a case's receipt goes: PS_WORKFLOW_REAL_MODEL_RECEIPT, with an on-demand case's key before its extension. */
function receiptPath(key) {
    const path = process.env.PS_WORKFLOW_REAL_MODEL_RECEIPT;
    if (!path) return null;
    return key ? path.replace(/(\.json)?$/i, `.${key}$1`) : path;
}

/**
 * One new session on a worker made with WORKER, in its own test environment: with `workflowsOn`, Workflows turned on in it
 * before its first prompt (test/helpers/workflows-on.js, as enable_workflows would); `ask` once (sendAndWait), then the
 * session's orchestration version (its instance exists from the first prompt on), then `check({ env, client, worker,
 * catalog, session, receipt })`. Then, whatever the check found, the evidence of the session's Workflows (receipt.evidence:
 * each saved revision's YAML and diagnostics, each run's status, outcome and error, each node execution's state, outcome
 * and error; test/helpers/workflow-real-model-evidence.mjs), read before the environment is cleaned up. Prints the
 * receipt and writes it (receiptPath), with the verdict, whatever the outcome.
 */
async function realModelSession(key, ask, check, { workflowsOn = false, worker: workerOptions = WORKER, prepare = null, waitForAsk = true } = {}) {
    if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
    if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_REAL_MODEL_TARGET=local).");
    const test = key ? `workflow-default-worker-agent-real-model.${key}` : "workflow-default-worker-agent-real-model";
    const receipt = { test, startedAt: new Date().toISOString(),
        model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, ask, steps: {}, verdict: null };
    const env = createTestEnv(test);
    try {
        await withClient(env, { worker: workerOptions }, async (client, worker) => {
            const catalog = client._catalog;
            const session = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
            receipt.steps.sessionId = session.sessionId;
            if (workflowsOn) await turnWorkflowsOn(catalog, session.sessionId);
            receipt.steps.workflowsOnBeforeAsk = workflowsOn;
            // What a case sets up before its first prompt (its ask may name it); its close, if any, runs whatever happens.
            let prepared = {};
            try {
                if (prepare) prepared = await prepare({ env, client, worker, catalog, session, receipt });
                const asked = typeof ask === "function" ? ask(prepared) : ask;
                receipt.ask = asked;
                // A case that bounds its own phases sends its ask without waiting for the turn's answer: a session that sets a
                // cron answers through its scheduled turns, and sendAndWait would wait past the case's cap (DEV run at 4fa702dc).
                if (waitForAsk) await session.sendAndWait(asked, TURN_MS);
                else await session.send(asked);
                // After the first prompt: createSession starts no orchestration, so getInstanceInfo before it finds no instance.
                receipt.steps.sessionVersion = await sessionOrchestrationVersion(client, session.sessionId);
                await check({ env, client, worker, catalog, session, receipt, prepared });
            } finally {
                receipt.evidence = await realModelWorkflowEvidence(catalog, session.sessionId);
                await prepared.close?.().catch(() => {});
            }
        });
        receipt.verdict = receipt.nonGating?.some(item => !item.holds) ? "PASS (with known model gaps, non-gating)" : "PASS";
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

/** Waits until every Workflow the session started has ended (at least one); the rows, or null when `ms` runs out. */
function workflowsEnded(definitionStore, sessionId, ms) {
    return until(async () => {
        const rows = await definitionStore.listWorkflows({ ownerSessionId: sessionId });
        return rows.length > 0 && rows.every(row => row.runStatus && !ACTIVE.has(row.runStatus)) ? rows : null;
    }, ms);
}

describe("the consent oracle (no model)", () => {
    it("counts a question that proposes using a Workflow, and nothing else", () => {
        for (const text of [
            "I can set this up as a Workflow so it runs without me. Would you like me to do that?",
            "Shall I turn on Workflows and run the check as one?",
            "A Workflow fits this: it costs no model turns. Want me to set one up?",
            "Do you want me to run this as a Workflow?",
            "Would you like a Workflow for this?",
            "**Do you want me to build a Workflow for this?**",
            "Workflows are off in this session. Want me to turn them on?",
        ]) expect(consentVerdict([text]), text).toBe("asks");
        for (const text of [
            "Workflows are unavailable in this session.",
            "Workflows are off, so I cannot do that.",
            "A Workflow would fit this well.",
            "I checked the site five times; it answered every time.",
            "Would you like me to check again in an hour?",
            "Should I keep checking? The site answered.",
            // DR-04 and test review section 3: each statement and question rejected on its own is rejected joined too.
            "Workflows are unavailable in this session. Would you like me to perform the checks manually?",
            "Workflows are unavailable. Would you like me to use cron instead?",
            "Would you like me to explain what a Workflow is?",
            "Do you want me to avoid Workflows?",
            "Workflows are off. Should I keep checking manually?",
            "Workflows aren't available here, so I set a cron. Want me to change it?",
        ]) expect(consentVerdict([text]), text).toBe("no");
        // A question in one message is never about a Workflow named in another.
        expect(consentVerdict(["Workflows are off.", "Should I keep checking?"])).toBe("no");
        expect(consentVerdict(["A Workflow would fit this.", "Want me to do that?"])).toBe("no");
        // A question that names a Workflow but proposes nothing the oracle recognizes: ambiguous, for manual review.
        expect(consentVerdict(["Would you like me to check how Workflows handle this?"])).toBe("ambiguous");
    });

    it("counts a question that asks to turn Workflows on, wherever it is, and nothing else", () => {
        for (const text of [
            "May I turn Workflows on?",
            "**May I enable Workflows?**",
            "Shall I turn on Workflows for this session?",
            `${"The site answered. ".repeat(100)}May I turn Workflows on?`,
        ]) expect(asksWorkflowAgreement(text, { activation: true }), text.slice(-60)).toBe(true);
        for (const text of [
            "Would you like me to report when the Workflow is done?",
            "Workflows are already on, so no activation is needed. Would you like me to report when the check is done?",
            "Do you want me to run this as a Workflow?",
        ]) expect(asksWorkflowAgreement(text, { activation: true }), text).toBe(false);
    });
});

describe("the full Workflow engine on a default worker, on a real model", () => {
    if (plan.state === "skip") {
        for (const title of [TITLE, TITLE_ENABLE, TITLE_STAYS_OFF, TITLE_CONSENT, TITLE_ALREADY_ON, TITLE_LOAD_SKILL, TITLE_SCRIPT, TITLE_PERSON_CONTROL]) {
            it.skip(`${title} — skipped: ${plan.reason}`, () => {});
        }
        return;
    }

    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession(null, ASK, async ({ env, catalog, session, receipt }) => {
            const definitionStore = catalog.workflowStore().sessionDefinitions;
            const events = types => catalog.getSessionEvents(session.sessionId, 0, 5_000, types);
            // Written when every session had the Workflow tools: Workflows are turned on before the ask (realModelSession's
            // workflowsOn); TITLE_ENABLE covers a session that turns them on itself. Revisions are read once its Workflows ended.
            const ended = await workflowsEnded(definitionStore, session.sessionId, RUN_MS);
            receipt.steps.workflows = (ended ?? await definitionStore.listWorkflows({ ownerSessionId: session.sessionId }))
                .map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
            receipt.steps.toolCalls = (await events(["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
            receipt.steps.refused = await workflowToolRefusals(catalog, session.sessionId);
            receipt.steps.workflowsOn = (await catalog.getSessionCapabilities(session.sessionId))?.workflows === true;
            const valid = [];
            for (const definition of await definitionStore.listDefinitions(session.sessionId, { includeDeleted: true })) {
                for (const summary of await definitionStore.listRevisions(definition.definitionId)) {
                    if (!summary.valid) continue;
                    const ir = await definitionStore.readRevisionIr(definition.definitionId, summary.revision);
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
            expect(receipt.steps.sessionVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(valid.some(item => item.states.includes("agent")), `a valid revision with an agent state. ${why}`).toBe(true);
            expect(receipt.steps.refused, `no refusal. ${why}`).toEqual([]);
            expect(receipt.steps.workflows.length, `a Workflow started. ${why}`).toBeGreaterThan(0);
            expect(receipt.steps.workflows.some(row => row.status === "completed"), `a Workflow completed. ${why}`).toBe(true);
            expect(runs.every(version => version === "1.0.0"), `every run at the Workflow controller. ${why}`).toBe(true);
        }, { workflowsOn: true });
    });

    it(TITLE_ENABLE, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession("enable", ASK_SIMPLE, async ({ worker, catalog, session, receipt }) => {
            const definitionStore = catalog.workflowStore().sessionDefinitions;
            // sendAndWait may come back with the enable_workflows turn's own answer: the Workflow is built on the next turn.
            const ended = await workflowsEnded(definitionStore, session.sessionId, RUN_MS);
            const workflows = ended ?? await definitionStore.listWorkflows({ ownerSessionId: session.sessionId });
            receipt.steps.workflows = workflows.map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
            const names = (await toolCallsOf(catalog, session.sessionId)).map(call => call.name);
            receipt.steps.toolCalls = names;
            const state = await catalog.getSessionCapabilities(session.sessionId);
            receipt.steps.workflowsFlag = state?.workflows ?? null;
            // For the record: what the session's CLI session declares now (Workflows on: the Workflow tools, and enable_workflows,
            // answered "already on").
            receipt.steps.declared = await declaredTools(worker, session.sessionId).catch(error => `unreadable: ${error?.message ?? error}`);
            const enabledAt = names.indexOf("enable_workflows");
            const firstWorkflowTool = names.findIndex(name => WORKFLOW_TOOLS.includes(name));

            const why = JSON.stringify(receipt);
            expect(receipt.steps.sessionVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(enabledAt, `enable_workflows was called. ${why}`).toBeGreaterThanOrEqual(0);
            expect(state?.workflows, `the session's capability state has Workflows on. ${why}`).toBe(true);
            expect(firstWorkflowTool, `a Workflow tool was called, after enable_workflows. ${why}`).toBeGreaterThan(enabledAt);
            expect(names, `the Workflow was saved with workflow_definition. ${why}`).toContain("workflow_definition");
            expect(workflows.length, `a Workflow of the session started. ${why}`).toBeGreaterThan(0);
            expect(ended, `every Workflow of the session reached its end. ${why}`).not.toBeNull();
        });
    });

    it(TITLE_STAYS_OFF, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession("stays-off", ASK_PLAIN, async ({ worker, catalog, session, receipt }) => {
            receipt.steps.settled = await settle(catalog, session.sessionId, TURN_MS);
            const names = (await toolCallsOf(catalog, session.sessionId)).map(call => call.name);
            receipt.steps.toolCalls = names;
            const state = await catalog.getSessionCapabilities(session.sessionId);
            receipt.steps.workflowsFlag = state?.workflows ?? null;
            receipt.steps.ownsWorkflows = await catalog.workflowStore().sessionDefinitions.hasWorkflows(session.sessionId);
            const declared = await declaredTools(worker, session.sessionId);
            receipt.steps.declared = declared;

            const why = JSON.stringify(receipt);
            expect(receipt.steps.sessionVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(names, `enable_workflows was not called. ${why}`).not.toContain("enable_workflows");
            expect(names.filter(name => WORKFLOW_TOOLS.includes(name)), `no Workflow tool was called. ${why}`).toEqual([]);
            expect(state?.workflows === true, `the session's capability state has Workflows off. ${why}`).toBe(false);
            expect(receipt.steps.ownsWorkflows, `the session owns no Workflow Definition or Workflow. ${why}`).toBe(false);
            expect(declared, `the session's CLI session is warm on this worker. ${why}`).not.toBeNull();
            expect(declared, `enable_workflows is declared while Workflows are off. ${why}`).toContain("enable_workflows");
            expect(declared.filter(name => WORKFLOW_TOOLS.includes(name)), `no Workflow tool is declared. ${why}`).toEqual([]);
        });
    });

    it(TITLE_CONSENT, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession("consent", ASK_REPEAT, async ({ env, client, catalog, session, receipt }) => {
            const definitionStore = catalog.workflowStore().sessionDefinitions;
            const calls = async () => (await toolCallsOf(catalog, session.sessionId)).map(call => call.name);
            const flag = async () => (await catalog.getSessionCapabilities(session.sessionId))?.workflows === true;
            const lastSeq = async () => (await catalog.getSessionEvents(session.sessionId, 0, 5_000)).reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
            const owned = async () => ({ definitions: (await definitionStore.listDefinitions(session.sessionId)).length,
                workflows: (await definitionStore.listWorkflows({ ownerSessionId: session.sessionId })).length });
            const why = () => JSON.stringify(receipt);
            try {
                // The ask. Gating: nothing turned on. Non-gating (KNOWN_CRON_GAP): the reply asks to use a Workflow.
                receipt.steps.settledAsk = await settle(catalog, session.sessionId, CONSENT_ASK_MS);
                expect(receipt.steps.settledAsk, `the ask's turn ended. ${why()}`).toBe(true);
                expect(receipt.steps.sessionVersion, why()).toBe(DURABLE_SESSION_LATEST_VERSION);
                receipt.steps.askCalls = await calls();
                receipt.steps.askFlag = await flag();
                const askMessages = await phaseMessages(catalog, session.sessionId, 0);
                receipt.steps.askWords = excerpt(askMessages);
                receipt.steps.askCron = await cronStarted(catalog, session.sessionId);
                expect(receipt.steps.askCalls, `the ask turns nothing on. ${why()}`).not.toContain("enable_workflows");
                expect(receipt.steps.askCalls.filter(name => WORKFLOW_TOOLS.includes(name)), `the ask calls no Workflow tool. ${why()}`).toEqual([]);
                expect(receipt.steps.askFlag, `Workflows stay off after the ask. ${why()}`).toBe(false);
                // Two named non-gating results: the consent question (asks, ambiguous for manual review, or no), and the cron
                // choice, reported on its own: a cron is never counted as Workflow consent.
                receipt.steps.askConsent = consentVerdict(askMessages);
                reportNonGating(receipt, "the off reply asks the user's agreement to use a Workflow", receipt.steps.askConsent === "asks",
                    { verdict: receipt.steps.askConsent, ...(receipt.steps.askConsent === "ambiguous" ? { manualReview: true } : {}),
                        words: receipt.steps.askWords.slice(0, 400) });
                reportNonGating(receipt, "the off reply sets no session cron for the repeated check", !receipt.steps.askCron,
                    { cron: receipt.steps.askCron });

                // The decline. Gating: Workflows stay off, no Workflow tool, nothing saved or started.
                const beforeDecline = await lastSeq();
                await session.send(ASK_DECLINE);
                receipt.steps.settledDecline = await settle(catalog, session.sessionId, CONSENT_DECLINE_MS);
                expect(receipt.steps.settledDecline, `the decline's turn ended. ${why()}`).toBe(true);
                receipt.steps.declineCalls = (await calls()).slice(receipt.steps.askCalls.length);
                receipt.steps.declineFlag = await flag();
                receipt.steps.declineWords = excerpt(await phaseMessages(catalog, session.sessionId, beforeDecline + 1), 600);
                receipt.steps.declineOwned = await owned();
                expect(receipt.steps.declineCalls, `the decline turns nothing on. ${why()}`).not.toContain("enable_workflows");
                expect(receipt.steps.declineCalls.filter(name => WORKFLOW_TOOLS.includes(name)), `no Workflow tool after the decline. ${why()}`).toEqual([]);
                expect(receipt.steps.declineFlag, `Workflows stay off after the decline. ${why()}`).toBe(false);
                expect(receipt.steps.declineOwned, `nothing was saved or started after the decline. ${why()}`).toEqual({ definitions: 0, workflows: 0 });

                // The acceptance. Gating: Workflows turn on, once, and the session reaches a valid, started Workflow.
                await session.send(ASK_ACCEPT);
                receipt.steps.acceptStarted = Boolean(await until(async () =>
                    (await definitionStore.listWorkflows({ ownerSessionId: session.sessionId })).some(row => row.runStatus), CONSENT_ACCEPT_MS));
                const all = await calls();
                receipt.steps.acceptCalls = all.slice(receipt.steps.askCalls.length + receipt.steps.declineCalls.length);
                receipt.steps.acceptFlag = await flag();
                const definitions = await definitionStore.listDefinitions(session.sessionId);
                const revisions = (await Promise.all(definitions.map(definition => definitionStore.listRevisions(definition.definitionId)))).flat();
                receipt.steps.acceptValidRevisions = revisions.filter(revision => revision.valid).length;
                receipt.steps.acceptWorkflows = (await definitionStore.listWorkflows({ ownerSessionId: session.sessionId }))
                    .map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
                expect(all.filter(name => name === "enable_workflows"), `the acceptance turns them on, once. ${why()}`).toHaveLength(1);
                expect(receipt.steps.acceptCalls, `the acceptance calls enable_workflows. ${why()}`).toContain("enable_workflows");
                expect(receipt.steps.acceptFlag, `Workflows are on after the acceptance. ${why()}`).toBe(true);
                expect(receipt.steps.acceptValidRevisions, `the acceptance saved a valid revision. ${why()}`).toBeGreaterThan(0);
                expect(receipt.steps.acceptStarted, `the acceptance started a Workflow. ${why()}`).toBe(true);
            } finally {
                // The case's cap: the session (and any cron or Workflow it started) ends here, whatever happened above.
                receipt.steps.stoppedCleanly = await stopSession(env, client, session.sessionId, receipt);
            }
            expect(receipt.steps.stoppedCleanly, `the case ended its session within its cap. ${why()}`).toBe(true);
        }, { worker: WORKER_SCRIPTS, waitForAsk: false });
    });

    it(TITLE_ALREADY_ON, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession("already-on", ASK_REPEAT, async ({ env, client, catalog, session, receipt }) => {
            const definitionStore = catalog.workflowStore().sessionDefinitions;
            const why = () => JSON.stringify(receipt);
            try {
                expect(receipt.steps.sessionVersion, why()).toBe(DURABLE_SESSION_LATEST_VERSION);
                // Capped: a started Workflow, or a cron (the known gap: the session would answer through its scheduled turns),
                // or the session at rest, whichever comes first within ALREADY_ON_MS.
                receipt.steps.outcome = await until(async () => {
                    if ((await definitionStore.listWorkflows({ ownerSessionId: session.sessionId })).some(row => row.runStatus)) return "workflow";
                    if (await cronStarted(catalog, session.sessionId)) return "cron";
                    return await settle(catalog, session.sessionId, 2_000) ? "settled" : null;
                }, ALREADY_ON_MS) ?? "cap reached";
                const names = (await toolCallsOf(catalog, session.sessionId)).map(call => call.name);
                receipt.steps.toolCalls = names;
                const definitions = await definitionStore.listDefinitions(session.sessionId);
                const revisions = (await Promise.all(definitions.map(definition => definitionStore.listRevisions(definition.definitionId)))).flat();
                receipt.steps.validRevisions = revisions.filter(revision => revision.valid).length;
                receipt.steps.workflows = (await definitionStore.listWorkflows({ ownerSessionId: session.sessionId }))
                    .map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
                receipt.steps.cron = await cronStarted(catalog, session.sessionId);
                const messages = await phaseMessages(catalog, session.sessionId, 0);
                receipt.steps.words = excerpt(messages);
                receipt.steps.asksActivation = asksWorkflowAgreement(messages, { activation: true });
                // Non-gating (KNOWN_CRON_GAP): it uses a Workflow (a valid revision, started) without enable_workflows and
                // without asking to turn Workflows on (judged on its full messages). The cron choice is its own named result.
                const used = receipt.steps.validRevisions > 0 && receipt.steps.workflows.some(row => row.status)
                    && !names.includes("enable_workflows") && !receipt.steps.asksActivation;
                reportNonGating(receipt, "with Workflows already on, the session uses a started Workflow without enable_workflows or asking", used,
                    { outcome: receipt.steps.outcome, toolCalls: names, asksActivation: receipt.steps.asksActivation, workflows: receipt.steps.workflows });
                reportNonGating(receipt, "with Workflows already on, the session sets no session cron for the repeated check", !receipt.steps.cron,
                    { cron: receipt.steps.cron });
            } finally {
                receipt.steps.stoppedCleanly = await stopSession(env, client, session.sessionId, receipt);
            }
            // Gating: the case ends its session (and any cron) within its cap.
            expect(receipt.steps.stoppedCleanly, `the case ended its session within its cap. ${why()}`).toBe(true);
        }, { workflowsOn: true, worker: WORKER_SCRIPTS, waitForAsk: false });
    });

    // Known failure until the owner decides how the CLI's own `skill` tool serves the Workflow skills: a model that calls it
    // with `name` (as the guidance says for load_skill) is refused '"skill": Required' and may stop there (HELD).
    caseOf(TITLE_LOAD_SKILL)(TITLE_LOAD_SKILL, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession("load-skill", ASK_SKILL, async ({ catalog, session, receipt }) => {
            // Turning Workflows on first is allowed: enable_workflows ends its turn (sendAndWait may return there) and the next
            // one, started at once, loads the skill. So wait for a load (load_skill or "skill") to have its result, or for the
            // session to be quiet with something after its last enable_workflows call; then for the session to settle.
            const loadedOrQuiet = async () => {
                const calls = await toolCallsOf(catalog, session.sessionId);
                if (calls.some(call => (call.name === "load_skill" || call.name === "skill") && call.result !== null)) return true;
                if (calls.at(-1)?.name === "enable_workflows") return false;
                return settle(catalog, session.sessionId, 5_000);
            };
            receipt.steps.loadedOrQuiet = Boolean(await until(loadedOrQuiet, TURN_MS));
            receipt.steps.settled = await settle(catalog, session.sessionId, TURN_MS);
            const calls = await toolCallsOf(catalog, session.sessionId);
            receipt.steps.toolCalls = calls.map(call => call.name);
            receipt.steps.workflowsFlag = (await catalog.getSessionCapabilities(session.sessionId))?.workflows ?? null;
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
            expect(receipt.steps.sessionVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(authoring.length, `load_skill or the CLI's skill tool was called for ${AUTHORING_SKILL}. ${why}`).toBeGreaterThan(0);
            expect(loaded, `a call for ${AUTHORING_SKILL} (load_skill or the CLI's skill tool) succeeded and returned its body. ${why}`).toBe(true);
        });
    });
    caseOf(TITLE_SCRIPT)(TITLE_SCRIPT, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession("script-state", ASK_SCRIPT, async ({ catalog, session, receipt }) => {
            const definitionStore = catalog.workflowStore().sessionDefinitions;
            // enable_workflows may end the first turn; the Workflow is built after it. Wait for a Workflow of the session to start,
            // then for the session to settle (it checks every minute; it need not end here).
            const started = await until(async () => {
                const rows = await definitionStore.listWorkflows({ ownerSessionId: session.sessionId });
                return rows.length ? rows : null;
            }, RUN_MS);
            receipt.steps.settled = await settle(catalog, session.sessionId, TURN_MS);
            const workflows = started ?? await definitionStore.listWorkflows({ ownerSessionId: session.sessionId });
            receipt.steps.workflows = workflows.map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
            receipt.steps.toolCalls = (await toolCallsOf(catalog, session.sessionId)).map(call => call.name);
            // Every saved revision of the session's definitions, in the order they were saved.
            const saved = [];
            for (const definition of await definitionStore.listDefinitions(session.sessionId, { includeDeleted: true })) {
                for (const summary of await definitionStore.listRevisions(definition.definitionId)) {
                    const ir = summary.valid
                        ? await definitionStore.readRevisionIr(definition.definitionId, summary.revision)
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
            expect(receipt.steps.sessionVersion, why).toBe(DURABLE_SESSION_LATEST_VERSION);
            expect(firstScript, `a valid revision with a script state was saved. ${why}`).toBeGreaterThanOrEqual(0);
            expect(firstScript, `it was among the first ${SCRIPT_SAVES} saves. ${why}`).toBeLessThan(SCRIPT_SAVES);
            expect(workflows.length, `a Workflow of the session started. ${why}`).toBeGreaterThan(0);
        }, { worker: WORKER_SCRIPTS });
    });
    it(TITLE_PERSON_CONTROL, { timeout: TEST_TIMEOUT }, async () => {
        await realModelSession("person-control", prepared => ASK_PAUSE(prepared.workflowId), async ({ catalog, session, receipt, prepared }) => {
            const { mgmt, workflowId, runId } = prepared;
            const store = catalog.workflowStore();
            const run = async () => store.readRun(runId);
            const toolCalls = async () => toolCallsOf(catalog, session.sessionId);
            const pauses = calls => calls.filter(call => call.name === "update_workflow" && call.args?.operation === "pause");

            // 1. The session pauses the run on request (it may turn nothing else on: Workflows are on, it owns the Workflow).
            receipt.steps.pausedBySession = Boolean(await until(async () => (await run())?.status === "paused", TURN_MS));
            receipt.steps.settledAfterPause = await settle(catalog, session.sessionId, TURN_MS);
            const beforeResume = await toolCalls();
            receipt.steps.toolCallsBeforeResume = beforeResume.map(call => call.name);
            const why = () => JSON.stringify(receipt);
            expect(receipt.steps.pausedBySession, `the session paused its Workflow when asked. ${why()}`).toBe(true);
            // The message must come after the person's resume: first_wait (120 s) has not let tell_session run yet.
            const tellBefore = (await store.listNodeExecutions(runId)).filter(node => node.nodeId === "tell_session");
            expect(tellBefore, `the Workflow had not written to the session before the resume (the setup holds). ${why()}`).toEqual([]);

            // 2. The person resumes it through the API: their sign-in is the actor. (The session's events from here on are newer.)
            const seqBeforeResume = Math.max(0, ...(await catalog.getSessionEvents(session.sessionId, 0, 5_000)).map(event => event.seq));
            await mgmt.updateWorkflow(workflowId, { operation: "resume", operation_id: `person-resume-${randomUUID()}` }, { principal: OWNER });
            receipt.steps.statusAfterResume = (await run())?.status ?? null;
            expect(receipt.steps.statusAfterResume, `the person's resume took. ${why()}`).not.toBe("paused");

            // 3. The Workflow writes to the session (tell_session sent), and the session takes its turn on that message.
            const sent = await until(async () => (await store.listNodeExecutions(runId))
                .find(node => node.nodeId === "tell_session" && node.state === "completed") ?? null, RUN_MS);
            receipt.steps.tellSession = sent ? { outcome: sent.outcome } : null;
            expect(sent, `the Workflow wrote to the session. ${why()}`).not.toBeNull();
            receipt.steps.sessionSawMessage = Boolean(await until(async () => (await catalog.getSessionEvents(session.sessionId, seqBeforeResume, 5_000))
                .some(event => JSON.stringify(event.data ?? {}).includes("[WORKFLOW_UPDATE")), TURN_MS));
            receipt.steps.settledAfterMessage = await settle(catalog, session.sessionId, TURN_MS);

            // 4. A neutral question: the session reads its run and weighs the earlier pause request against the person's resume
            // (as on TEST, where it paused the run again). Asking the person, or saying they resumed it, passes.
            const seqBeforeQuestion = Math.max(0, ...(await catalog.getSessionEvents(session.sessionId, 0, 5_000)).map(event => event.seq));
            receipt.steps.question = ASK_STILL_DOING;
            await session.sendAndWait(ASK_STILL_DOING, TURN_MS);
            receipt.steps.settledAfterQuestion = await settle(catalog, session.sessionId, TURN_MS);
            receipt.steps.reply = (await catalog.getSessionEvents(session.sessionId, seqBeforeQuestion, 5_000, ["assistant.message"]))
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

            expect(receipt.steps.sessionSawMessage, `the session received the Workflow's message. ${why()}`).toBe(true);
            expect(pauses(after), `the session did not pause the run again after the person resumed it. ${why()}`).toEqual([]);
            expect(receipt.steps.finalStatus, `the run is still running. ${why()}`).toBe("running");
        }, {
            workflowsOn: true,
            worker: WORKER_SCRIPTS,
            // A person saves the definition in the session and starts it (the session is its parent), as from the portal.
            prepare: async ({ env, catalog, session }) => {
                const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema, workflowCommands: {} });
                await mgmt.start();
                const close = () => mgmt.stop();
                try {
                    const definitionStore = catalog.workflowStore().sessionDefinitions;
                    await mgmt.saveSessionWorkflowDefinition(session.sessionId, { name: PERSON_CONTROL_NAME, yaml: PERSON_CONTROL_YAML,
                        operationId: `person-save-${randomUUID()}` }, { principal: OWNER });
                    const definition = await definitionStore.readDefinitionByName(session.sessionId, PERSON_CONTROL_NAME);
                    await mgmt.startSessionWorkflowDefinition(session.sessionId, { definitionId: definition.definitionId,
                        operationId: `person-start-${randomUUID()}` }, { principal: OWNER });
                    const [workflow] = await definitionStore.listWorkflows({ ownerSessionId: session.sessionId });
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
