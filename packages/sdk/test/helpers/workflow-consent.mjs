/**
 * The real-model consent cases' oracle and phase helpers (workflow-default-worker-agent-real-model.test.js), shared with
 * their model-free checks (test/unit/workflow-consent-oracle.test.mjs) and the scripted cron check
 * (test/local/workflow-consent-phase-settle.test.js). Reviews of d5118761: DR-04 and test review section 3; the DEV run
 * at d5118761 (a session cron held the first ask past 300 s); test review of 8951bc61, items 1 and 2.
 */

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
export function argsOf(data) {
    const value = data?.arguments ?? data?.args;
    if (typeof value === "string") {
        try { return JSON.parse(value) ?? {}; } catch { return {}; }
    }
    return value && typeof value === "object" ? value : {};
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
/** A question's action that carries out a proposal pointed back at: do it, proceed, go ahead (besides a use or activation verb). */
const CARRY_OUT = /\b(do|proceed|go ahead)\b/i;

/** What a question asks for: its text after its asking phrase ("Do you want me to delete it?": "me to delete it?"). */
function actionOf(question) {
    const match = CONSENT.exec(question);
    return match ? question.slice(match.index + match[0].length) : question;
}

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
 *   (PROPOSES or a verb) and does not rule it out (RULED_OUT), and its own action carries that proposal out (a use or
 *   activation verb, or do, proceed, go ahead; test review of 8951bc61 item 2: "Would you like me to delete it?" after a
 *   Workflow proposal is "ambiguous", not consent); a question about turning on after "Workflows are off" too;
 * - a question that proposes something else (NOT_A_PROPOSAL: cron, instead, manually, avoid, explain) proposes nothing;
 * - a question that names a Workflow but none of the above is "ambiguous" (manual review).
 * Returns { verdict: "asks" | "ambiguous" | "no", activation } where activation says the question asks to turn Workflows on.
 */
export function classifyConsent(message) {
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
        const action = actionOf(item);
        if (!activation && !USE_VERB.test(action) && !CARRY_OUT.test(action)) {
            if (!RULED_OUT.test(before)) ambiguous = true;
            return;
        }
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
 * else "ambiguous" when any is (in either mode: test review of 8951bc61 item 2; a question to use a Workflow without turning
 * Workflows on is "no" in activation mode), else "no".
 */
export function consentVerdict(messages, { activation = false } = {}) {
    const verdicts = messages.map(classifyConsent);
    if (verdicts.some(item => item.verdict === "asks" && (!activation || item.activation))) return "asks";
    if (verdicts.some(item => item.verdict === "ambiguous")) return "ambiguous";
    return "no";
}

/** Whether `text` (one message, or a list of messages) asks the user's agreement to use (or, with `activation`, turn on) a Workflow. */
export function asksWorkflowAgreement(text, options = {}) {
    return consentVerdict(Array.isArray(text) ? text : [text], options) === "asks";
}

/**
 * The session's own messages in a phase, in full and each on its own: its assistant messages and the questions of its
 * ask_user calls, after `seq` and up to `toSeq`. A receipt shows an excerpt; the oracle reads all of them.
 */
export async function phaseMessages(catalog, sessionId, seq, toSeq = Infinity) {
    const events = await catalog.getSessionEvents(sessionId, seq, 5_000, ["assistant.message", "tool.execution_start"]);
    return events.filter(event => event.seq <= toSeq).map(event => event.eventType === "assistant.message"
        ? event.data?.content
        : String(event.data?.toolName ?? event.data?.name ?? "") === "ask_user" ? argsOf(event.data).question : null)
        .filter(value => typeof value === "string" && value);
}

/** A receipt's excerpt of a phase's messages (display only; the oracle reads them in full). */
export const excerpt = (messages, max = 1_200) => messages.join("\n").slice(0, max);

/**
 * A phase's own turn (test review of 8951bc61 item 1; DEV run at d5118761): its user message, found by the client message id
 * it was sent with, and the first session.turn_completed after it. A session runs one turn at a time and a turn records
 * its prompt when it starts, so the first turn end after that record is the prompt's own turn; a cron's turn, before or
 * after, has its own end and never stands for it. The session's row state is not read (a turn that set a cron writes it
 * "running"). Returns the phase's user message seq, its turn's end seq and iteration, and whether it ended within `ms`.
 */
export async function phaseTurn(catalog, sessionId, clientMessageId, ms) {
    let userSeq = null;
    const end = await until(async () => {
        const events = await catalog.getSessionEvents(sessionId, userSeq ?? 0, 5_000, ["user.message", "session.turn_completed"]);
        if (userSeq === null) {
            const own = events.find(event => event.eventType === "user.message"
                && Array.isArray(event.data?.clientMessageIds) && event.data.clientMessageIds.includes(clientMessageId));
            if (!own) return null;
            userSeq = own.seq;
        }
        return events.find(event => event.eventType === "session.turn_completed" && event.seq > userSeq) ?? null;
    }, ms);
    return { clientMessageId, userSeq, endSeq: end?.seq ?? null, iteration: end?.data?.iteration ?? null, settled: Boolean(end) };
}

/** The highest event seq of the session so far. */
export async function lastSeqOf(catalog, sessionId) {
    return (await catalog.getSessionEvents(sessionId, 0, 5_000)).reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
}

/**
 * The first turn's outcome (owner decision B): "asked-for-workflow-consent" (the gating path continues), "chose-cron" (the
 * known gap, a named non-gating result; never a consent pass), or "ambiguous" (manual review: the oracle could not decide,
 * or the session did neither).
 */
export function firstTurnOutcome(consent, cron) {
    if (consent === "asks") return "asked-for-workflow-consent";
    if (cron) return "chose-cron";
    return "ambiguous";
}

/** Whether the session started a cron (session.cron_started). */
export async function cronStarted(catalog, sessionId) {
    return (await catalog.getSessionEvents(sessionId, 0, 5_000, ["session.cron_started"])).length > 0;
}

/** A tool result's text: a string, the content of an object result, or its JSON. */
export function resultText(result) {
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && typeof result.content === "string") return result.content;
    try { return JSON.stringify(result ?? null); } catch { return ""; }
}

/**
 * The session's tool calls in event order: name, arguments, its start's seq and, once it completed, its result's text,
 * whether it succeeded (`success`: the completion's flag; false with an error) and its detailed text (`detail`: the CLI's
 * `skill` tool returns the body there; its `content` is a one-line receipt).
 */
export async function toolCallsOf(catalog, sessionId) {
    const rows = (await catalog.getSessionEvents(sessionId, 0, 5_000, ["tool.execution_start", "tool.execution_complete"]))
        .sort((a, b) => a.seq - b.seq);
    const calls = [];
    const byId = new Map();
    for (const event of rows) {
        const data = event.data ?? {};
        if (event.eventType === "tool.execution_start") {
            const call = { name: String(data.toolName ?? data.name ?? ""), args: argsOf(data), result: null, success: null, detail: "", seq: event.seq };
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
 * Owner decision B (2026-11-11): with the repeated-check ask, the model sets a session cron instead of suggesting a Workflow
 * (Workflows off) or using one (Workflows on); DEV run of gpt-5.6-terra at 4fa702dc. Shipped as is; the Workflow guidance
 * is tuned against cron in a follow-up (issue 291 section 3). These checks are recorded in the receipt (receipt.nonGating)
 * and printed, and never fail the case.
 */
export const KNOWN_CRON_GAP = "known model gap (owner decision B, 2026-11-11): the model uses a session cron for a repeated check instead of "
    + "suggesting or using a Workflow; the Workflow guidance is tuned against cron in a follow-up";

/** Record a non-gating check in the receipt and print it when it does not hold; it never fails the case. */
export function reportNonGating(receipt, check, holds, evidence) {
    receipt.nonGating ??= [];
    receipt.nonGating.push({ check, holds, ...(holds ? {} : { knownGap: KNOWN_CRON_GAP }), evidence });
    if (!holds) console.warn(`[${receipt.test}] NON-GATING, does not hold: ${check}. ${KNOWN_CRON_GAP}`);
}

/** The Workflow tools a session is declared only while Workflows are on in it. */
export const CONSENT_WORKFLOW_TOOLS = ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "respond_session_request", "spawn_workflow"];

/**
 * The consent case's three phases on a new session with Workflows off (test review of 8951bc61 item 1), whatever each phase
 * did. The ask was sent with the client message id `ask.id`; the decline and the acceptance are sent here with theirs.
 * Each phase ends on its own turn (phaseTurn), within its cap; a phase whose turn did not end is recorded as not exercised,
 * and the next phase is sent all the same, so a cron (or anything else) in the first turn never stops the decline and the
 * acceptance. The acceptance also waits, within its cap, for a started Workflow (enable_workflows ends its turn and the
 * next turn, started at once, saves and starts it). Returns every phase's record, for consentGating and the receipt.
 */
export async function driveConsentCase({ catalog, session, ask, decline, accept, caps }) {
    const sessionId = session.sessionId;
    const store = catalog.workflowStore().sessionDefinitions;
    const flag = async () => (await catalog.getSessionCapabilities(sessionId))?.workflows === true;
    const owned = async () => ({ definitions: (await store.listDefinitions(sessionId)).length,
        workflows: (await store.listWorkflows({ ownerSessionId: sessionId })).length });
    const callsIn = async (from, to = Infinity) => (await toolCallsOf(catalog, sessionId)).filter(call => call.seq > from && call.seq <= to).map(call => call.name);
    const phase = async (turn, extra = {}) => {
        const record = { clientMessageId: turn.clientMessageId, exercised: turn.settled, userSeq: turn.userSeq, endSeq: turn.endSeq, iteration: turn.iteration, ...extra };
        if (turn.settled) {
            record.calls = await callsIn(turn.userSeq, turn.endSeq);
            record.messages = await phaseMessages(catalog, sessionId, turn.userSeq, turn.endSeq);
        }
        record.flag = await flag();
        return record;
    };

    const phases = {};
    phases.ask = await phase(await phaseTurn(catalog, sessionId, ask.id, caps.ask));
    phases.ask.cron = await cronStarted(catalog, sessionId);
    phases.ask.consent = phases.ask.exercised ? consentVerdict(phases.ask.messages) : null;
    phases.ask.outcome = phases.ask.exercised ? firstTurnOutcome(phases.ask.consent, phases.ask.cron) : "not-exercised";

    await session.send(decline.text, { clientMessageIds: [decline.id] });
    phases.decline = await phase(await phaseTurn(catalog, sessionId, decline.id, caps.decline));
    phases.decline.owned = await owned();

    const acceptSentAfter = await lastSeqOf(catalog, sessionId);
    await session.send(accept.text, { clientMessageIds: [accept.id] });
    const started = Date.now();
    const acceptTurn = await phaseTurn(catalog, sessionId, accept.id, caps.accept);
    phases.accept = await phase(acceptTurn);
    phases.accept.started = Boolean(acceptTurn.settled && await until(async () =>
        (await store.listWorkflows({ ownerSessionId: sessionId })).some(row => row.runStatus), Math.max(0, caps.accept - (Date.now() - started))));
    // Before the acceptance: every turn (a cron's included) up to its message; from it on: the rest of the session.
    const acceptFrom = acceptTurn.userSeq ?? acceptSentAfter;
    phases.beforeAcceptCalls = await callsIn(0, acceptFrom);
    phases.accept.callsFrom = await callsIn(acceptFrom);
    phases.accept.flag = await flag();
    phases.enables = (await toolCallsOf(catalog, sessionId)).filter(call => call.name === "enable_workflows").length;
    const definitions = await store.listDefinitions(sessionId);
    const revisions = (await Promise.all(definitions.map(definition => store.listRevisions(definition.definitionId)))).flat();
    phases.accept.validRevisions = revisions.filter(revision => revision.valid).length;
    phases.accept.workflows = (await store.listWorkflows({ ownerSessionId: sessionId }))
        .map(row => ({ id: row.workflowSessionId, revision: row.revision, status: row.runStatus }));
    return phases;
}

/**
 * The consent case's gating rules over driveConsentCase's record: every unmet rule, in words; none when it passes. A phase
 * that was not exercised is a failure of its own, never a pass:
 * - the ask: its own turn ended; it turns nothing on, calls no Workflow tool, Workflows stay off;
 * - the decline: its own turn ended; it turns nothing on, calls no Workflow tool; Workflows stay off; nothing saved or started;
 * - before the acceptance (every turn, a cron's included): no enable_workflows, no Workflow tool;
 * - the acceptance: its own turn ended; enable_workflows once in the session, from the acceptance on; Workflows on; a valid
 *   revision; a started Workflow.
 */
export function consentGating(phases, workflowTools = CONSENT_WORKFLOW_TOOLS) {
    const failures = [];
    const tools = calls => (calls ?? []).filter(name => workflowTools.includes(name));
    for (const [name, label] of [["ask", "the ask"], ["decline", "the decline"], ["accept", "the acceptance"]]) {
        if (!phases[name]?.exercised) failures.push(`${label} was not exercised: its own turn did not end within its cap`);
    }
    for (const [name, label] of [["ask", "the ask"], ["decline", "the decline"]]) {
        const record = phases[name] ?? {};
        if (record.exercised && record.calls.includes("enable_workflows")) failures.push(`${label} turned Workflows on (enable_workflows)`);
        if (record.exercised && tools(record.calls).length > 0) failures.push(`${label} called a Workflow tool: ${tools(record.calls).join(", ")}`);
        if (record.flag) failures.push(`Workflows were on after ${label}`);
    }
    const declined = phases.decline?.owned;
    if (declined && (declined.definitions !== 0 || declined.workflows !== 0)) failures.push(`something was saved or started by the decline: ${JSON.stringify(declined)}`);
    if ((phases.beforeAcceptCalls ?? []).includes("enable_workflows")) failures.push("Workflows were turned on before the acceptance");
    if (tools(phases.beforeAcceptCalls).length > 0) failures.push(`a Workflow tool was called before the acceptance: ${tools(phases.beforeAcceptCalls).join(", ")}`);
    const accept = phases.accept ?? {};
    if (accept.exercised) {
        if (phases.enables !== 1) failures.push(`enable_workflows was called ${phases.enables} times, not once`);
        if (!(accept.callsFrom ?? []).includes("enable_workflows")) failures.push("the acceptance did not call enable_workflows");
        if (!accept.flag) failures.push("Workflows were off after the acceptance");
        if (!(accept.validRevisions > 0)) failures.push("the acceptance saved no valid revision");
        if (!accept.started) failures.push("the acceptance started no Workflow");
    }
    return failures;
}
