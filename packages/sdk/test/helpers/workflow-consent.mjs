/**
 * The real-model consent cases' oracle and phase helpers (workflow-default-worker-agent-real-model.test.js), shared with
 * their model-free checks (test/unit/workflow-consent-oracle.test.mjs) and the scripted cron check
 * (test/local/workflow-consent-phase-settle.test.js). Reviews of d5118761: DR-04 and test review section 3; the DEV run
 * at d5118761 (a session cron held the first ask past 300 s).
 */

/** A session's row states between turns, or once it ended (nothing more comes). */
const BETWEEN_TURNS = new Set(["idle", "waiting", "input_required", "completed", "cancelled", "failed", "error"]);

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
export function consentVerdict(messages, { activation = false } = {}) {
    const verdicts = messages.map(classifyConsent);
    if (verdicts.some(item => item.verdict === "asks" && (!activation || item.activation))) return "asks";
    if (verdicts.some(item => item.verdict === "ambiguous" || (activation && item.verdict === "asks"))) return activation ? "no" : "ambiguous";
    return "no";
}

/** Whether `text` (one message, or a list of messages) asks the user's agreement to use (or, with `activation`, turn on) a Workflow. */
export function asksWorkflowAgreement(text, options = {}) {
    return consentVerdict(Array.isArray(text) ? text : [text], options) === "asks";
}

/**
 * The session's own messages in a phase, in full and each on its own: its assistant messages and the questions of its
 * ask_user calls, from `seq` on. A receipt shows an excerpt; the oracle reads all of them.
 */
export async function phaseMessages(catalog, sessionId, seq) {
    const events = await catalog.getSessionEvents(sessionId, seq, 5_000, ["assistant.message", "tool.execution_start"]);
    return events.map(event => event.eventType === "assistant.message"
        ? event.data?.content
        : String(event.data?.toolName ?? event.data?.name ?? "") === "ask_user" ? argsOf(event.data).question : null)
        .filter(value => typeof value === "string" && value);
}

/** A receipt's excerpt of a phase's messages (display only; the oracle reads them in full). */
export const excerpt = (messages, max = 1_200) => messages.join("\n").slice(0, max);

/**
 * A phase settles on its own turn (DEV run at d5118761: a session cron kept the session busy, so waiting for it to be fully
 * idle never ended): the phase's own user message (its text, after `afterSeq`), then an assistant message after it, then
 * the session between turns with no new event for two polls. A later cron turn starts a new user-visible turn of its own
 * and does not hold this one. Returns the phase's user message seq and whether it settled within `ms`.
 */
export async function phaseSettled(catalog, sessionId, text, afterSeq, ms) {
    let userSeq = null;
    let count = -1;
    let quiet = 0;
    const settled = Boolean(await until(async () => {
        const events = await catalog.getSessionEvents(sessionId, afterSeq, 5_000);
        if (userSeq === null) {
            const own = events.find(event => event.eventType === "user.message" && String(event.data?.content ?? "").includes(text));
            if (!own) return false;
            userSeq = own.seq;
        }
        if (!events.some(event => event.eventType === "assistant.message" && event.seq > userSeq)) return false;
        const row = await catalog.getSession(sessionId);
        quiet = BETWEEN_TURNS.has(row?.state) && events.length === count ? quiet + 1 : 0;
        count = events.length;
        return quiet >= 2;
    }, ms));
    return { userSeq, settled };
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
