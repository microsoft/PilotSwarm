/**
 * Read-only projection of Workflow V2 data for the workflow graph and node
 * details. It reads two sources and never calls anything:
 *
 *  - durable session events (`workflow.started`, `workflow.state_*`, ...), whose
 *    shapes are written in packages/sdk/src/workflow/v2/runtime.ts and store.ts;
 *  - an optional read model, the object `readWorkflowV2View` returns
 *    (packages/sdk/src/workflow/v2/tools.ts). The caller supplies it; this module
 *    has no endpoint of its own.
 *
 * A payload that does not have the V2 shape is refused with a reason. It is
 * never read as a legacy workflow, and a legacy payload is never read as V2.
 * Canvas ticks are not read at all: V2 does not draw a workflow canvas.
 */
import { formatLocalTime, shortSessionId as shortId } from "./formatting.js";

// Agent and parallel states (IR 8) and stopped runs are written only by controller 1.9.0 (INACTIVE: only tests run it);
// they are read here so a test deployment shows them, and nothing else changes for the others.
const STATE_TYPES = new Set(["script", "wait", "messaging", "agent", "parallel", "terminal"]);
const MESSAGING_MODES = new Set(["receive", "send", "request"]);
const TERMINAL_OUTCOMES = new Set(["succeeded", "blocked", "failed", "cancelled"]);
const RUN_STATUSES = new Set(["admitted", "running", "paused", "completed", "failed", "cancelled", "stopped"]);
const STATE_EVENTS = new Set(["workflow.state_started", "workflow.state_completed", "workflow.state_failed", "workflow.state_cancelled"]);
const END_EVENTS = { "workflow.completed": "completed", "workflow.failed": "failed", "workflow.cancelled": "cancelled", "workflow.stopped": "stopped" };

/**
 * The sections of a run that the read pages (design 04 read_workflow "Bounded history pagination"; readWorkflowV2View
 * run.pages): node executions, inbox, outbox and a test run's held calls. A read model without run.pages is an
 * older server's, which listed a run's first rows by entry and paged no further.
 */
export const WORKFLOW_V2_READ_SECTIONS = Object.freeze(["executions", "inbox", "outbox", "interceptions"]);
/** An older server's read model lists at most this many node executions of a run. */
const LEGACY_EXECUTION_LIMIT = 200;
const ROW_KEYS = { executions: "nodeExecutionId", inbox: "messageId", outbox: "exchangeId", interceptions: "interceptionId" };

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const definedOnly = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
const text = value => typeof value === "string" && value ? value : undefined;

/** "v2" or "legacy" for a `workflow.started` payload, "unknown" when it has no state list. */
export function workflowShape(data) {
    if (!isRecord(data) || !Array.isArray(data.states)) return "unknown";
    if (typeof data.irSha256 === "string" || typeof data.definitionHash === "string") return "v2";
    const v2State = data.states.some(state => isRecord(state)
        && (state.type === "wait" || state.type === "messaging" || (state.type === "script" && Array.isArray(state.outcomes))));
    return v2State ? "v2" : "legacy";
}

/** The state's kind: script, wait, receive, send, request or terminal. */
export function workflowV2Kind(node) {
    return node?.type === "messaging" ? node.mode : node?.type;
}

function invalidState(node, why) {
    return new Error(`Step '${node.id}' is not a valid ${node.type} step: ${why}.`);
}

function checkState(node) {
    if (node.type === "terminal") {
        if (!TERMINAL_OUTCOMES.has(node.outcome)) throw invalidState(node, "its outcome is unknown");
        return;
    }
    if (!isRecord(node.next)) throw invalidState(node, "it has no next steps");
    for (const target of Object.values(node.next)) if (typeof target !== "string") throw invalidState(node, "a next step is not a step id");
    if (!Array.isArray(node.outcomes) || node.outcomes.some(outcome => typeof outcome !== "string")) throw invalidState(node, "it lists no outcomes");
    if (node.type === "wait" && typeof node.seconds !== "number" && typeof node.seconds !== "string") throw invalidState(node, "it has no duration");
    if (node.type === "messaging" && (!MESSAGING_MODES.has(node.mode) || typeof node.contract !== "string")) {
        throw invalidState(node, "its messaging mode or message type is unknown");
    }
    if (node.type === "agent" && (!isRecord(node.invoke) || (node.invoke.source !== "prompt" && node.invoke.source !== "agent"))) {
        throw invalidState(node, "it has no task");
    }
    if (node.type === "parallel" && (!isRecord(node.body) || typeof node.body.initial !== "string" || !Array.isArray(node.body.states)
        || !Number.isSafeInteger(node.concurrency))) {
        throw invalidState(node, "it has no body or concurrency");
    }
}

/**
 * Validate a V2 state list (`workflow.started.states`, or `graph` of the read
 * model). The states are kept as given, so every transition is preserved.
 */
export function workflowV2Definition(data, meta = {}) {
    if (!isRecord(data) || !Array.isArray(data.states) || !data.states.length) throw new Error("The workflow definition has no steps.");
    const ids = new Set();
    for (const node of data.states) {
        if (!isRecord(node) || typeof node.id !== "string" || !node.id || !STATE_TYPES.has(node.type)) {
            throw new Error("The workflow definition contains an invalid or unsupported step.");
        }
        if (ids.has(node.id)) throw new Error(`The workflow definition repeats step '${node.id}'.`);
        ids.add(node.id);
        checkState(node);
    }
    const initial = data.initial || data.states[0].id;
    if (!ids.has(initial)) throw new Error("The workflow's first step is not defined.");
    for (const node of data.states) {
        for (const target of Object.values(node.next || {})) {
            if (!ids.has(target)) throw new Error(`Step '${node.id}' leads to a step that is not defined.`);
        }
    }
    return {
        shape: "v2", name: data.name ?? meta.name ?? undefined, version: data.version ?? meta.version ?? undefined, initial, states: data.states,
        ...definedOnly({ revision: data.revision ?? meta.revision, definitionHash: data.definitionHash ?? meta.definitionHash,
            irSha256: data.irSha256 ?? meta.irSha256 }),
    };
}

const INTAKE_REFUSALS = { refused_full: "queue full", refused_size: "message too large" };

/**
 * The recipient's later intake refusal of a delivered outbox message, from the optional `intakeOutcome` and
 * `intakeOutcomeAt` that readWorkflowV2View adds only when set. It is read beside the delivery and never changes
 * it. Both fields absent (or null) is no annotation: null. A known outcome gives `{ kind, reason, at }`. Anything
 * else (an unrecognized outcome, a time with no outcome) is `kind: "unknown"`, never shown as success or refusal.
 */
export function workflowV2IntakeOutcome(message) {
    const outcome = message?.intakeOutcome, at = message?.intakeOutcomeAt;
    const hasOutcome = outcome !== undefined && outcome !== null, hasAt = at !== undefined && at !== null;
    if (!hasOutcome && !hasAt) return null;
    const when = typeof at === "string" && at ? at : null;
    if (typeof outcome === "string" && Object.hasOwn(INTAKE_REFUSALS, outcome)) return { kind: outcome, reason: INTAKE_REFUSALS[outcome], at: when };
    const raw = typeof outcome === "string" && outcome ? (outcome.length > 60 ? `${outcome.slice(0, 59)}…` : outcome) : null;
    return { kind: "unknown", reason: null, raw, at: when };
}

export function formatSeconds(seconds) {
    if (!Number.isFinite(seconds)) return String(seconds);
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${+(seconds / 60).toFixed(1)} min`;
    return `${+(seconds / 3600).toFixed(1)} h`;
}

const party = value => value === null || value === undefined ? "any permitted sender" : value === "parent" ? "the parent session" : String(value);

/** An agent state's task as one line: the agent it names, with the package and version it names, or an inline prompt. */
export function workflowV2AgentTask(node) {
    return node?.invoke?.source === "agent"
        ? `${node.invoke.name}${node.invoke.package ? ` · ${node.invoke.package}${node.invoke.version ? ` ${node.invoke.version}` : ""}` : ""}`
        : "Inline prompt";
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A long hash by its first 12 characters and "…" (a person reads the whole one on hover or in a copy). Pure. */
export function workflowV2ShortHash(value) {
    return `${value.slice(0, 12)}…`;
}
const shortHash = workflowV2ShortHash;

/**
 * What a named agent state is bound to (design 03, 04, 09; R09, R18; mock
 * M17 "Inspect package pin"): the workflow interface the state names (its
 * graph's `invoke.interface`, `<name>@<version>`), and its pin in `source`,
 * the shown run's pins (projectWorkflowV2): `{ by: "publication" | "test",
 * pins }` (migration 0103's publication pins, or a real-agent test run's,
 * migration 0105), or `{ by: "mocked" }` for a mocked test run, whose
 * agents do not run. A pin is the package, version, exact revision and the
 * interface's digest publication matched. Null for any other state.
 */
export function workflowV2AgentBinding(node, source = null) {
    if (node?.type !== "agent" || node.invoke?.source !== "agent") return null;
    const named = typeof node.invoke.interface === "string" && node.invoke.interface ? node.invoke.interface : null;
    const raw = isRecord(source?.pins) && isRecord(source.pins[node.id]) ? source.pins[node.id] : null;
    const iface = raw && isRecord(raw.interface) && text(raw.interface.name) && text(raw.interface.version)
        && typeof raw.interface.digest === "string" && SHA256_HEX.test(raw.interface.digest)
        ? { ref: `${raw.interface.name}@${raw.interface.version}`, digest: raw.interface.digest } : null;
    const pin = raw ? {
        name: text(raw.name) ?? null, package: text(raw.package) ?? null, version: text(raw.version) ?? null,
        revision: typeof raw.revision === "string" && SHA256_HEX.test(raw.revision) ? raw.revision : null, interface: iface,
    } : null;
    return { interface: named, pinnedBy: pin ? source.by : null, mocked: source?.by === "mocked", pin };
}

/** The binding as `[label, value]` rows for a state's details, in the same words in the portal and the TUI. */
export function workflowV2AgentBindingRows(binding) {
    if (!binding) return [];
    const rows = [];
    if (binding.interface) rows.push(["Interface", binding.interface]);
    if (binding.mocked) rows.push(["Agent in this test", "Mocked: the parent or the test's answers give its typed result"]);
    const pin = binding.pin;
    if (pin) {
        const what = pin.package
            ? `${pin.package}${pin.version ? ` ${pin.version}` : ""}${pin.revision ? ` · revision ${shortHash(pin.revision)}` : " · by version"}`
            : `${pin.name ?? "agent"} · a deployment agent, by name`;
        rows.push([binding.pinnedBy === "test" ? "Locked for this test" : "Locked by publishing", what]);
        if (pin.interface) rows.push(["Interface fingerprint", `${pin.interface.ref} · ${shortHash(pin.interface.digest)}`]);
        else if (binding.interface) rows.push(["Interface fingerprint", "Not locked"]);
    }
    return rows;
}

/** One short line that names what the state does. */
export function workflowV2NodeLabel(node) {
    switch (workflowV2Kind(node)) {
        case "script": return `script · ${node.runtime || "node"}`;
        case "wait": return typeof node.seconds === "number" ? `wait · ${formatSeconds(node.seconds)}` : "wait · bound duration";
        case "receive": return `receive · ${node.contract}`;
        case "send": return `send · ${node.contract}`;
        case "request": return `request · ${node.contract}`;
        case "agent": return node.invoke?.source === "agent" ? `agent · ${node.invoke.name}` : "agent · inline prompt";
        case "parallel": return `parallel · ${node.concurrency === 1 ? "one branch at a time" : `up to ${node.concurrency} branches`}`;
        // A branch's end is not the workflow's (owner batch 7, H2).
        case "terminal": return `${typeof node.parallel === "string" ? "branch ends" : "ends"} · ${node.outcome}`;
        default: return String(node?.type || "step");
    }
}

/** A business outcome of the state, or a runtime-error route (failure and error codes). */
export function workflowV2RouteKind(node, label) {
    if (!node || node.type === "terminal") return "outcome";
    return Array.isArray(node.outcomes) && node.outcomes.includes(label) ? "outcome" : "error";
}

/**
 * Mark each laid-out edge as an outcome route, a runtime-error route, or both (labels merged onto one edge). A route
 * that leaves a parallel step's join bar (owner batch 7, H2) is its parallel step's (`owner`); a branch end's line into
 * the join bar is "join".
 */
export function annotateWorkflowV2Edges(definition, layout) {
    const byId = new Map(definition.states.map(node => [node.id, node]));
    for (const edge of layout.edges) {
        // A parallel state's edge to its body's first state (or into its branch box) is how each branch starts, not a route.
        if (edge.branch) { edge.kind = "branch"; continue; }
        if (edge.join) { edge.kind = "join"; continue; }
        const kinds = new Set(edge.outcomes.map(label => workflowV2RouteKind(byId.get(edge.owner ?? edge.from), label)));
        edge.kind = kinds.size > 1 ? "mixed" : [...kinds][0];
    }
    return layout;
}

/**
 * The notices the portal lists behind its Notices button (owner batch 5, g-03): the projection's banners about the
 * definition and the shown run, each with a level and its text. "No run yet" is left out: the run's status says it
 * (g-07). Owner batch 7 (H1): while the parent agent is still writing the latest revision (`draftInProgress`,
 * workflowV2DraftInProgress), that revision's errors are said calmly, as information that is not counted (`quiet`).
 * Pure.
 */
export function workflowV2ShownNotices(banners, { draftInProgress = null } = {}) {
    if (!Array.isArray(banners)) return [];
    return banners.filter(banner => isRecord(banner) && typeof banner.text === "string" && banner.text && banner.code !== "no-run")
        .map(banner => (draftInProgress && banner.code === "invalid-revision"
            ? { level: "info", code: "draft-in-progress", quiet: true, text: `The agent is still writing this workflow. ${banner.text}` } : banner));
}

/** How many notices the Notices button counts: every shown notice but the quiet ones (H1). Pure. */
export function workflowV2NoticeCount(notices) {
    return Array.isArray(notices) ? notices.filter(notice => !notice?.quiet).length : 0;
}

/**
 * The Notices button (H1; review UI7-2): `shown` whenever there is a notice, quiet ones included, or a failed read, so a
 * quiet notice stays reachable; `count`, the counted notices and the failed read; `level`, its tint, from the counted
 * ones only (a failed read is an error). A button with only quiet notices has no count and no tint. Pure.
 */
export function workflowV2NoticeBadge(notices, readError = false) {
    const list = Array.isArray(notices) ? notices.filter(isRecord) : [];
    const counted = list.filter(notice => !notice.quiet);
    const count = counted.length + (readError ? 1 : 0);
    return { shown: list.length > 0 || Boolean(readError), count, level: readError ? "error" : counted.length ? workflowV2NoticeLevel(counted) : null };
}

/** The most serious level among notices, for the Notices button's tint: "error", "warning", "info", or null for none. */
export function workflowV2NoticeLevel(notices) {
    const levels = new Set((Array.isArray(notices) ? notices : []).map(notice => notice?.level));
    return levels.has("error") ? "error" : levels.has("warning") ? "warning" : levels.size ? "info" : null;
}

/**
 * How many of a test run's held calls wait for an answer (the Test calls button's count): its coverage's unanswered calls
 * when the read says them, otherwise the listed calls that wait for the parent. 0 without a test. Pure.
 */
export function workflowV2OpenCalls(test) {
    if (!isRecord(test)) return 0;
    if (Array.isArray(test.coverage?.unanswered)) return test.coverage.unanswered.length;
    return Array.isArray(test.interceptions) ? test.interceptions.filter(item => isRecord(item) && item.state === "awaiting_parent").length : 0;
}

const isTruncated = value => typeof value === "string" && value.endsWith("…");

/** A preview string as text to display. JSON is indented only when the whole value arrived. Never HTML. */
export function formatWorkflowValue(value) {
    if (value === undefined || value === null) return { text: "", truncated: false };
    if (typeof value !== "string") return { text: JSON.stringify(value, null, 2), truncated: false };
    if (isTruncated(value)) return { text: value, truncated: true };
    try {
        const parsed = JSON.parse(value);
        return { text: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2), truncated: false };
    } catch {
        return { text: value, truncated: false };
    }
}

/**
 * The older pages a person loaded for run `runId` (the view's `olderHistory`, which the controller's
 * loadOlderWorkflowHistory writes: { runId, sections: { [section]: { items, nextCursor } }, loading, error }), or null
 * when there are none for exactly that run. Pure.
 */
export function workflowV2OlderSections(older, runId) {
    return isRecord(older) && typeof runId === "string" && older.runId === runId && isRecord(older.sections) ? older.sections : null;
}

/**
 * Whether a section's loaded older pages (`loaded`: { items, nextCursor }) still join the read model's page of it: the
 * page has no older row, or its oldest row is among the loaded ones. When newer rows pushed the page past every loaded
 * row, they do not: what lies between was never read, so the loaded rows are not shown with the page and older history
 * starts again from the page (workflowV2OlderStart). Pure.
 */
function joinsPage(run, section, loaded) {
    if (!isRecord(loaded) || !Array.isArray(loaded.items)) return false;
    const pageRows = workflowV2RunPageRows(run, section);
    const cursor = isRecord(run?.pages) && isRecord(run.pages[section]) ? run.pages[section].nextCursor : null;
    if (!pageRows.length || !isRecord(cursor)) return true;
    const key = ROW_KEYS[section];
    return loaded.items.some(row => isRecord(row) && row[key] === pageRows[0][key]);
}

/**
 * Where reading a run's older history starts (loadOlderWorkflowHistory), per section the read model pages: the older
 * pages already loaded for this run when they still join its page (joinsPage), otherwise the page itself with its
 * cursor, so the next older page follows the newest rows without a gap. Pure.
 */
export function workflowV2OlderStart(run, older = null) {
    const pages = isRecord(run?.pages) ? run.pages : null;
    const loaded = isRecord(run) ? workflowV2OlderSections(older, run.runId) : null;
    const sections = {};
    for (const section of WORKFLOW_V2_READ_SECTIONS) {
        if (!isRecord(pages?.[section])) continue;
        sections[section] = joinsPage(run, section, loaded?.[section]) && isRecord(loaded?.[section])
            ? loaded[section] : { items: workflowV2RunPageRows(run, section), nextCursor: isRecord(pages[section].nextCursor) ? pages[section].nextCursor : null };
    }
    return sections;
}

/**
 * One run's rows of each section as one list (R01 history; design 04 read_workflow): before them the rows of the older
 * pages a person loaded for exactly this run (`older`) that still join the page (joinsPage; otherwise they are left out
 * and the section counted in `gaps`), then the open rows the read model lists apart from its page (openExecutions,
 * openInbox, openOutbox, test.openInterceptions: older than the page), then the page. One row per id; what the read
 * model holds wins over an older page. An older page's row that was still open when it was read (pending, or waiting
 * for an answer), and that the read model now neither holds nor lists as open while its open list is complete, has
 * changed since: it is left out and counted (`staleOlder`), never shown as it was. Pure.
 */
export function workflowV2RunRows(run, older = null) {
    const list = value => Array.isArray(value) ? value.filter(isRecord) : [];
    const loaded = isRecord(run) ? workflowV2OlderSections(older, run.runId) : null;
    const pages = isRecord(run?.pages) ? run.pages : null;
    let staleOlder = 0;
    let gaps = 0;
    const merge = (section, page, open, stillOpen) => {
        const key = ROW_KEYS[section];
        const pageRows = list(page);
        const paged = new Set(pageRows.map(row => row[key]));
        const fresh = [...list(open).filter(row => !paged.has(row[key])), ...pageRows];
        const seen = new Set(fresh.map(row => row[key]));
        const openComplete = pages?.[section]?.openComplete === true;
        const before = [];
        const joined = isRecord(loaded?.[section]) && joinsPage(run, section, loaded[section]);
        if (isRecord(loaded?.[section]) && !joined) gaps++;
        for (const row of joined ? list(loaded[section].items) : []) {
            const id = row[key];
            if (typeof id !== "string" || seen.has(id)) continue;
            seen.add(id);
            if (stillOpen && stillOpen(row) && openComplete) { staleOlder++; continue; }
            before.push(row);
        }
        return [...before, ...fresh];
    };
    const test = isRecord(run?.test) ? run.test : null;
    const nodeExecutions = merge("executions", run?.nodeExecutions, run?.openExecutions, row => row.state === "pending");
    const inbox = merge("inbox", run?.inbox, run?.openInbox, null);
    const outbox = merge("outbox", run?.outbox, run?.openOutbox, row => row.state === "pending");
    const interceptions = test ? merge("interceptions", test.interceptions, test.openInterceptions, row => row.state === "awaiting_parent") : [];
    return { nodeExecutions, inbox, outbox, interceptions, staleOlder, gaps };
}

/**
 * How much of a run's history is loaded (readWorkflowV2View run.pages, with the older pages a person loaded for exactly
 * this run): `next` names, per section, the cursor of the next older page (the last loaded older page's while it joins
 * the read model's page, else the read model's), absent once its oldest row is loaded; `complete` says every node
 * execution of the run is loaded (no older page, and every open one listed); `openComplete` that every open row of
 * every section is listed (at most 500 each); `loading` and `error` are the last older-page read's. A read model
 * without pages (an older server) lists a run's first node executions and pages no further: complete only below its
 * limit of 200. Pure.
 */
export function workflowV2RunHistory(run, older = null) {
    const pages = isRecord(run?.pages) ? run.pages : null;
    const loaded = isRecord(run) ? workflowV2OlderSections(older, run.runId) : null;
    const next = {};
    for (const section of WORKFLOW_V2_READ_SECTIONS) {
        const own = isRecord(loaded?.[section]) && joinsPage(run, section, loaded[section]) && Object.hasOwn(loaded[section], "nextCursor")
            ? loaded[section].nextCursor : undefined;
        const cursor = own !== undefined ? own : pages?.[section]?.nextCursor;
        if (isRecord(cursor)) next[section] = cursor;
    }
    const mine = isRecord(older) && isRecord(run) && older.runId === run.runId;
    const executions = Array.isArray(run?.nodeExecutions) ? run.nodeExecutions.length : 0;
    return {
        paged: pages !== null,
        next,
        more: Object.keys(next).length > 0,
        complete: pages ? !next.executions && pages.executions?.openComplete !== false : executions < LEGACY_EXECUTION_LIMIT,
        openComplete: pages ? WORKFLOW_V2_READ_SECTIONS.every(section => pages[section]?.openComplete !== false) : true,
        loading: mine && older.loading === true,
        error: mine && typeof older.error === "string" && older.error ? older.error : null,
    };
}

function normalizeRun(raw, older = null) {
    if (!isRecord(raw) || typeof raw.runId !== "string" || !RUN_STATUSES.has(raw.status)) return null;
    const rows = workflowV2RunRows(raw, older);
    return {
        runId: raw.runId, mode: raw.mode, status: raw.status, outcome: raw.outcome ?? null,
        pausedFrom: raw.pausedFrom ?? null, pauseSettled: typeof raw.pauseSettled === "boolean" ? raw.pauseSettled : null,
        // A graceful stop (controller 1.9.0) and a test run's evidence (notice, virtual clock, interceptions, coverage); its
        // interceptions are its page, the waiting ones the page does not hold and any older pages loaded, as one list.
        stop: isRecord(raw.stop) ? raw.stop : null, test: isRecord(raw.test) ? { ...raw.test, interceptions: rows.interceptions } : null,
        terminalState: raw.terminalState ?? null, output: raw.output ?? null, error: raw.error ?? null,
        kvRevision: raw.kvRevision, kv: raw.kv, nodeExecutions: rows.nodeExecutions, inbox: rows.inbox, outbox: rows.outbox,
        history: { ...workflowV2RunHistory(raw, older), staleOlder: rows.staleOlder, gaps: rows.gaps },
    };
}

const unrecognized = reason => ({ ok: false, status: "unrecognized", definition: null, diagnostics: [], run: null, overlay: false,
    banners: [{ level: "error", text: reason }] });

const LIVE_RUN_STATUSES = new Set(["admitted", "running", "paused"]);

/**
 * The replies a run holds that no step has taken yet (owner decision q15, mock M16): the messages in its inbox, as a read
 * model's run lists them (its page, `inbox`, and the open rows it lists apart, `openInbox`), that no step took and that
 * have not expired at `now` (epoch milliseconds). A reply can arrive before the run is ready for it (paused, not started,
 * or not yet at the step that takes it); it waits until that step takes it or it expires. Older pages a person loaded
 * are not counted: a row they hold may have been taken since, and every reply still waiting is in the open rows. Pure.
 */
export function workflowV2WaitingReplies(run, now) {
    const seen = new Set();
    const rows = [...(Array.isArray(run?.inbox) ? run.inbox : []), ...(Array.isArray(run?.openInbox) ? run.openInbox : [])];
    return rows.filter(row => {
        if (!isRecord(row) || row.claimedBy || seen.has(row.messageId)) return false;
        seen.add(row.messageId);
        return !(typeof row.expiresAt === "string" && Date.parse(row.expiresAt) <= now);
    });
}

/**
 * What a person reads about replies waiting in a live run (q15), by why the run has not taken them yet; null for none, a
 * run that has ended or one that is stopping (it takes no new step, so it will not use them). Pure.
 */
export function workflowV2WaitingRepliesNotice(run, count) {
    if (!Number.isSafeInteger(count) || count < 1 || !LIVE_RUN_STATUSES.has(run?.status) || isRecord(run.stop)) return null;
    const one = count === 1;
    const head = one ? "Reply waiting: 1 reply" : `Replies waiting: ${count} replies`;
    const it = one ? "it" : "them";
    if (run.status === "paused") return `${head} arrived while the run is paused. The run uses ${it} once it resumes.`;
    if (run.status === "admitted") return `${head} arrived before the run started. The run uses ${it} when it reaches the step that takes ${it}.`;
    return `${head} ${one ? "has" : "have"} arrived and ${one ? "waits" : "wait"} for the step that takes ${it}.`;
}

/** The words a run's status gains while replies wait in it (q15): " · 1 reply waiting", or "" for none. Pure. */
export function workflowV2WaitingRepliesLabel(count) {
    return Number.isSafeInteger(count) && count > 0 ? ` · ${count === 1 ? "1 reply" : `${count} replies`} waiting` : "";
}

/**
 * Project the object `readWorkflowV2View` returns. `status` is one of ready,
 * draft, invalid (no graph can be shown), unavailable (valid but no graph),
 * invalid-graph or unrecognized. `older` is the view's olderHistory: the older
 * pages a person loaded, merged into the model's run only when they are for
 * that run (workflowV2RunRows). `now` (epoch milliseconds, the current time
 * unless given) decides only whether a waiting reply has expired.
 */
export function projectWorkflowV2ReadModel(model, { older = null, now = Date.now() } = {}) {
    if (!isRecord(model) || typeof model.workflowId !== "string" || !isRecord(model.definition)
        || !isRecord(model.revision) || typeof model.revision.valid !== "boolean" || !Array.isArray(model.runs)) {
        return unrecognized("This workflow data has an unknown format, so it was not shown.");
    }
    const { definition: lifecycle, revision } = model;
    const banners = [];
    const diagnostics = (Array.isArray(revision.diagnostics) ? revision.diagnostics : []).filter(isRecord).map(item => ({
        severity: item.severity === "warning" ? "warning" : "error", code: String(item.code ?? ""), path: String(item.path ?? ""),
        message: String(item.message ?? ""), line: Number.isSafeInteger(item.line) ? item.line : undefined,
    }));
    let graph = null;
    if (model.graph !== null && model.graph !== undefined) {
        try {
            graph = workflowV2Definition(model.graph, { name: revision.name ?? undefined, version: lifecycle.semver ?? undefined,
                revision: model.graph.revision, definitionHash: revision.definitionHash });
        } catch (error) {
            return { ...unrecognized(`The workflow graph is not valid: ${error.message}`), status: "invalid-graph", workflowId: model.workflowId, diagnostics };
        }
    }
    let status = "ready";
    if (lifecycle.state === "deleted") banners.push({ level: "warning", text: "This workflow has been deleted." });
    if (!revision.valid) {
        const errors = diagnostics.filter(item => item.severity === "error").length;
        status = graph ? "ready" : "invalid";
        // Its code lets the screen say it calmly while the parent agent is still writing it (owner batch 7, H1).
        banners.push({ level: "error", code: "invalid-revision",
            text: `Revision ${revision.revision} has ${errors || "unlisted"} error${errors === 1 ? "" : "s"} and cannot run.`
            + (graph ? ` Showing revision ${graph.revision}.` : "") });
    } else if (!graph) {
        status = "unavailable";
        banners.push({ level: "warning", text: `Revision ${revision.revision} is valid, but its graph is not available.` });
    } else if (lifecycle.state === "draft") {
        status = "draft";
        banners.push({ level: "info", text: `Draft revision ${graph.revision} · not published.` });
    } else if (graph.revision !== revision.revision) {
        banners.push({ level: "info", text: `Showing published revision ${graph.revision}. Revision ${revision.revision} is a newer draft.` });
    }
    // Everything above is the workflow's (its definition, revision and graph), whichever run was asked for; what follows is the run's.
    const workflowBanners = [...banners];
    const run = normalizeRun(model.run, older);
    const runInfo = run ? model.runs.find(item => item?.runId === run.runId) : null;
    const runRevision = Number.isSafeInteger(runInfo?.revision) ? runInfo.revision : null;
    let overlay = Boolean(run && graph);
    if (run && graph && runRevision === null) {
        overlay = false;
        banners.push({ level: "warning", text: "This run's revision is not listed, so its step status is not shown on the graph." });
    } else if (run && graph && runRevision !== graph.revision) {
        overlay = false;
        banners.push({ level: "warning", text: `This run used revision ${runRevision}; the graph shows revision ${graph.revision}, so its step status is not shown on the graph.` });
    }
    if (model.run !== null && model.run !== undefined && !run) {
        banners.push({ level: "warning", text: "This run's data has an unknown format, so it was not shown." });
    } else if (!run && model.runs.length) {
        banners.push({ level: "info", text: `No live run is selected; ${model.runs.length === 1 ? "1 other run exists" : `${model.runs.length} other runs exist`}.` });
    } else if (!run) {
        // The portal says this once, in the run's status (batch 5, g-07); the terminal lists it among its notices.
        banners.push({ level: "info", text: "No run yet.", code: "no-run" });
    }
    // A test run (design 05; INACTIVE outside controller 1.9.0's tests): its notice stays visible, with the revision it tested,
    // its virtual clock and what still waits for the parent's answer. Never shown as a production result.
    if (run?.test) {
        const test = run.test;
        banners.push({ level: "warning", text: typeof test.notice === "string" && test.notice
            ? test.notice : "TEST — workflow tools are mocked, but scripts run normally." });
        // Agent mode real: its agent states run real agent sessions (they spend model tokens), whose framework tools are mocked.
        if (test.agentMode === "real") {
            banners.push({ level: "warning", text: typeof test.agentNotice === "string" && test.agentNotice
                ? test.agentNotice : "Agent steps run real agent sessions; their workflow tool calls are mocked." });
        }
        if (test.stale === true) {
            banners.push({ level: "warning", text: `This test ran revision ${test.testedRevision}; the definition is now at revision ${lifecycle.currentRevision}, so its result is stale.` });
        }
        if (isRecord(test.virtualClock) && Number.isSafeInteger(test.virtualClock.elapsedSeconds)) {
            banners.push({ level: "info", text: `Virtual clock: ${formatSeconds(test.virtualClock.elapsedSeconds)} after the test began. Script clocks are real.` });
        }
        const open = Array.isArray(test.coverage?.unanswered) ? test.coverage.unanswered.length : 0;
        if (open) banners.push({ level: "info", text: `${open} call${open === 1 ? " waits" : "s wait"} for the parent's answer.` });
    }
    // Replies that arrived before the run was ready for them (q15, mock M16): counted from the read's own rows.
    const replies = run ? workflowV2WaitingReplies(model.run, now).length : 0;
    const repliesNotice = workflowV2WaitingRepliesNotice(run, replies);
    const waitingReplies = repliesNotice ? replies : 0;
    if (repliesNotice) banners.push({ level: "info", text: repliesNotice });
    // How much of the run's history is loaded: the read pages a run newest first and lists its open rows apart, so its
    // current states are read however long its history is; older history is loaded on request (loadOlderWorkflowHistory).
    const history = run?.history;
    if (history && !history.paged && !history.complete) {
        banners.push({ level: "info", text: `Only the first ${LEGACY_EXECUTION_LIMIT} visits are listed, so counts may be incomplete.` });
    } else if (history?.next?.executions) {
        banners.push({ level: "info", text: "Older visits of this run are not loaded, so counts may be incomplete." });
    }
    if (history?.paged && !history.openComplete) {
        banners.push({ level: "warning", text: "This run has more open steps, inputs, deliveries or waiting calls than one read lists (500 of each), so some of them are not shown." });
    }
    if (history?.staleOlder) {
        banners.push({ level: "info", text: history.staleOlder === 1
            ? "1 row loaded from older history changed after it was read and is left out; read older history again to see it now."
            : `${history.staleOlder} rows loaded from older history changed after they were read and are left out; read older history again to see them now.` });
    }
    if (history?.gaps) {
        banners.push({ level: "info", text: "Newer rows arrived after older history was loaded, so the older rows no longer join them and are not shown; read older history again to see them." });
    }
    if (history?.error) banners.push({ level: "warning", text: `Older history could not be read: ${history.error}` });
    return {
        ok: true, status, workflowId: model.workflowId, definition: graph, diagnostics, banners, workflowBanners, run, overlay, runRevision, waitingReplies,
        lifecycle: lifecycle.state, semver: lifecycle.semver ?? null, currentRevision: lifecycle.currentRevision, latestRevision: revision.revision,
        publishedRevision: lifecycle.publishedRevision ?? null, validRevision: revision.valid, runs: model.runs,
        // What publication pinned each named agent state to (migration 0103; only a definition with any has them).
        publishedAgentPins: isRecord(lifecycle.publishedAgentPins) ? lifecycle.publishedAgentPins : null,
    };
}

function latestRunId(events, excluded = new Set()) {
    for (let i = events.length - 1; i >= 0; i--) {
        const type = events[i]?.eventType;
        const id = events[i]?.data?.runId;
        if (typeof id === "string" && !excluded.has(id) && (STATE_EVENTS.has(type) || Object.hasOwn(END_EVENTS, type) || type === "workflow.started"
            || type === "workflow.paused" || type === "workflow.resumed")) return id;
    }
    return null;
}

/**
 * Runs known not to be the live run: their start event, the run list of a read model that projects, or that model's own
 * run (the run it was read for, listed or not) gives another mode. A model's own run whose mode is not "live" is
 * excluded whatever the mode is, so a run that was read as a test run, and is neither listed nor has its start loaded,
 * is never taken for the live run when the selection goes back to live and its own model is still loading or failed.
 */
function notLiveRunIds(events, model) {
    const ids = new Set();
    for (const event of events) {
        const data = event?.data;
        if (event?.eventType === "workflow.started" && typeof data?.runId === "string" && typeof data.mode === "string" && data.mode !== "live") ids.add(data.runId);
    }
    for (const item of model?.ok ? model.runs : []) {
        if (typeof item?.runId === "string" && typeof item.mode === "string" && item.mode !== "live") ids.add(item.runId);
    }
    const own = model?.ok ? model.run : null;
    if (own && typeof own.runId === "string" && own.mode !== "live") ids.add(own.runId);
    return ids;
}

function mergeExecution(prev, next) {
    if (!prev) return definedOnly(next);
    const completed = prev.status === "completed" || next.status === "completed";
    const merged = prev.status === "completed" && next.status !== "completed"
        ? { ...definedOnly(next), ...definedOnly(prev) } : { ...definedOnly(prev), ...definedOnly(next) };
    return { ...merged, status: completed ? "completed" : "pending" };
}

function executionFromEvent(type, data) {
    const base = { id: data.nodeExecutionId, stateId: data.stateId, ordinal: Number.isSafeInteger(data.step) ? data.step : undefined };
    if (type === "workflow.state_started") {
        return { ...base, status: "pending", catchAll: data.catchAll === true ? true : undefined, immediateOutcome: text(data.immediateOutcome) };
    }
    const common = { ...base, status: "completed", outcome: text(data.outcome), messageId: text(data.messageId), contract: text(data.contract),
        senderSessionId: text(data.senderSessionId), exchangeId: text(data.exchangeId), recipientSessionId: text(data.recipientSessionId),
        recipientKind: text(data.recipientKind), responderSessionId: text(data.responderSessionId), inputMessageId: text(data.inputMessageId),
        attempts: Number.isSafeInteger(data.attempts) ? data.attempts : undefined };
    if (type === "workflow.state_failed") {
        return { ...common, resultKind: "runtime_error", errorPreview: data.error, effectStatus: text(data.effectStatus),
            catchAll: data.catchAll === true ? true : undefined };
    }
    return { ...common, resultKind: data.resultKind === "business" || data.resultKind === "runtime_error" ? data.resultKind : undefined,
        outputPreview: data.outputPreview };
}

function collectExecutions(events, runId, run, overlay) {
    const executions = new Map();
    let ignoredEvents = 0;
    let ignoredRows = 0;
    const add = (execution, source) => {
        executions.set(execution.id, { ...mergeExecution(executions.get(execution.id), execution),
            sources: [...new Set([...(executions.get(execution.id)?.sources || []), source])] });
    };
    if (run && overlay) {
        for (const row of run.nodeExecutions) {
            if (typeof row.nodeExecutionId !== "string" || typeof row.stateId !== "string" || (row.state !== "pending" && row.state !== "completed")) {
                ignoredRows++;
                continue;
            }
            add({ id: row.nodeExecutionId, stateId: row.stateId, ordinal: Number.isSafeInteger(row.ordinal) ? row.ordinal : undefined,
                status: row.state, outcome: text(row.outcome), resultKind: row.resultKind ?? undefined, outputPreview: row.outputPreview,
                errorPreview: row.errorPreview, winner: text(row.winner), attempts: Number.isSafeInteger(row.attempts) ? row.attempts : undefined,
                kvRevision: row.kvRevision ?? undefined, deadline: text(row.deadline), completedAt: text(row.completedAt),
                predecessorId: text(row.predecessorId),
                receive: isRecord(row.receive) ? row.receive : undefined,
                agent: isRecord(row.agent) && typeof row.agent.childSessionId === "string" ? row.agent : undefined,
                scopeId: text(row.scopeId), branch: isRecord(row.branch) ? row.branch : undefined,
                branches: Number.isSafeInteger(row.branches) ? row.branches : undefined }, "read");
        }
    }
    if (runId && (overlay || !run)) {
        for (const event of events) {
            if (!STATE_EVENTS.has(event?.eventType)) continue;
            const data = isRecord(event.data) ? event.data : {};
            if (typeof data.runId !== "string" || typeof data.nodeExecutionId !== "string" || typeof data.stateId !== "string"
                || event.eventType === "workflow.state_cancelled") {
                ignoredEvents++;
                continue;
            }
            if (data.runId === runId) add(executionFromEvent(event.eventType, data), "event");
        }
    } else if (!runId) {
        // Only events that name no run are unreadable; an event of a run that was left out belongs to that run.
        ignoredEvents += events.filter(event => STATE_EVENTS.has(event?.eventType) && !(isRecord(event.data) && typeof event.data.runId === "string")).length;
    }
    if (run && overlay) {
        for (const message of run.outbox) {
            const found = executions.get(message.nodeExecutionId);
            if (found) found.outbox = { state: message.state, attempts: message.attempts, recipientSessionId: message.recipientSessionId,
                recipientKind: message.recipientKind, contract: message.contract, deliveredAt: message.deliveredAt ?? null,
                payloadPreview: message.payloadPreview, errorPreview: message.errorPreview, inputMessageId: message.inputMessageId ?? null,
                ...definedOnly({ intake: workflowV2IntakeOutcome(message) ?? undefined }) };
        }
        for (const message of run.inbox) {
            const found = message.claimedBy ? executions.get(message.claimedBy) : null;
            if (found) found.inbox = { messageId: message.messageId, contract: message.contract, senderSessionId: message.senderSessionId,
                acceptedAt: message.acceptedAt, claimedAt: message.claimedAt, payloadPreview: message.payloadPreview };
        }
    }
    return { executions: [...executions.values()], ignoredEvents, ignoredRows };
}

/**
 * The run's status from the read model and the durable events. An end is final
 * from either source. Otherwise the read model's status is used, then the latest
 * pause or resume event, then whether any state event exists.
 */
export function workflowV2RunStatus({ run = null, events = [], runId = null, readModelAfterSeq = null } = {}) {
    let end = null;
    let control = null;
    let begun = false;
    for (const event of events) {
        const data = isRecord(event?.data) ? event.data : {};
        if (!runId || data.runId !== runId) continue;
        if (Object.hasOwn(END_EVENTS, event.eventType)) end = { status: END_EVENTS[event.eventType], outcome: data.outcome ?? null, stateId: data.stateId ?? null, error: data.error, code: text(data.code) };
        else if (event.eventType === "workflow.paused") control = { kind: "paused", seq: event.seq };
        else if (event.eventType === "workflow.resumed") control = { kind: "running", seq: event.seq };
        else if (event.eventType === "workflow.started" || STATE_EVENTS.has(event.eventType)) begun = true;
    }
    if (!end && run && ["completed", "failed", "cancelled", "stopped"].includes(run.status)) {
        end = { status: run.status, outcome: run.outcome, stateId: run.terminalState, error: run.error ?? undefined, code: undefined };
    }
    const mode = run?.mode === "test" ? "Test run · " : "";
    if (end) {
        // A terminal state with an outcome is the workflow's own decision. A failure without one is a runtime or controller failure.
        const business = end.stateId !== null && end.outcome !== null;
        const label = end.status === "completed" ? `Completed · ${end.outcome ?? "ended"}`
            : end.status === "cancelled" ? "Cancelled"
            : end.status === "stopped" ? "Stopped · no new step was started after the stop"
                : business ? `Failed · ended at '${end.stateId}' (${end.outcome})` : `Failed · ${end.code || "runtime error"}`;
        return { phase: end.status, ended: true, label: mode + label, businessOutcome: business ? end.outcome : null, error: end.error,
            terminalState: end.stateId };
    }
    // A read model carries no sequence number. A pause or resume event it may not have seen can contradict it, and nothing
    // here can say which is newer, so the status is reported as unverified. `readModelAfterSeq` is supplied by the caller: the
    // highest event sequence it had loaded before it fetched the read model; events up to it are older than the snapshot.
    const guarded = Number.isSafeInteger(readModelAfterSeq);
    const contradicts = control && run && (run.status === "paused") !== (control.kind === "paused")
        && !(guarded && Number.isSafeInteger(control.seq) && control.seq <= readModelAfterSeq);
    if (contradicts) {
        const modelSays = run.status === "paused" ? "paused" : run.status;
        return { phase: "unverified", ended: false, stale: true, conflict: { readModel: modelSays, events: control.kind === "paused" ? "paused" : "resumed" },
            label: `${mode}Status not certain · its data says ${modelSays}, latest event says ${control.kind === "paused" ? "paused" : "resumed"}` };
    }
    const status = run?.status ?? (control?.kind ?? (begun ? "running" : null));
    switch (status) {
        case "admitted": return { phase: "admitted", ended: false, label: `${mode}Waiting to start` };
        case "paused": {
            const label = run?.pausedFrom === "admitted" ? "Paused before it started"
                : run?.pauseSettled === false ? "Pausing · waiting for running steps to finish" : "Paused";
            return { phase: run?.pauseSettled === false ? "pausing" : "paused", ended: false, label: mode + label };
        }
        case "running": return run?.stop
            ? { phase: "stopping", ended: false, label: `${mode}Stopping · steps already started may finish until ${run.stop.deadline ? shownTime(run.stop.deadline) : "its deadline"}` }
            : { phase: "running", ended: false, label: `${mode}Running` };
        default:
            return control?.kind === "paused" ? { phase: "paused", ended: false, label: "Paused" } : { phase: "none", ended: false, label: "No run yet" };
    }
}

const outcomeText = (kind, outcome) => {
    if (kind === "receive") return outcome === "received" ? "Received" : outcome === "elapsed" ? "Wait elapsed · no message" : `Done · ${outcome}`;
    if (kind === "wait") return outcome === "elapsed" ? "Elapsed" : `Done · ${outcome}`;
    if (kind === "send") return outcome === "sent" ? "Sent · queued at recipient" : `Done · ${outcome}`;
    if (kind === "request") return outcome === "responded" ? "Responded" : outcome === "declined" ? "Declined" : `Done · ${outcome}`;
    if (kind === "parallel") return outcome === "joined" ? "Joined · every branch succeeded" : outcome === "blocked" ? "Blocked · a branch did not succeed" : `Done · ${outcome}`;
    if (kind === "agent") return `Completed by its agent · ${outcome}`;
    return outcome ? `Done · ${outcome}` : "Done";
};

const pendingText = (kind, execution) => {
    if (kind === "wait") return "Waiting";
    if (kind === "receive") return "Waiting for message";
    if (kind === "send") return execution?.outbox?.state === "delivered" ? "Sent · queued at recipient" : "Delivering";
    if (kind === "request") return "Awaiting response";
    if (kind === "agent") return "Agent working · waiting for its typed result";
    if (kind === "parallel") return "Running its branches";
    return execution?.immediateOutcome ? "Deciding" : "Running";
};

/** Human lines for one execution of a state. Values that must not be read as HTML are not touched here; React renders them as text. */
export function describeWorkflowV2Execution(node, execution) {
    const kind = workflowV2Kind(node);
    const lines = [];
    if (!execution) return lines;
    const pending = execution.status === "pending";
    if (kind === "wait") {
        if (pending) lines.push(execution.deadline ? `Waiting until ${workflowV2EventTime(execution.deadline) ?? execution.deadline}.` : `Waiting ${typeof node.seconds === "number" ? formatSeconds(node.seconds) : "for its bound duration"}.`);
        else if (execution.outcome === "elapsed") lines.push("The wait elapsed.");
    } else if (kind === "receive") {
        const wanted = execution.receive ? { contract: execution.receive.contract, from: execution.receive.from } : { contract: node.contract, from: node.from };
        if (pending) {
            lines.push(`Waiting for ${wanted.contract} from ${party(wanted.from)}.`);
            if (execution.deadline) lines.push(`If none arrives by ${workflowV2EventTime(execution.deadline) ?? execution.deadline}, the step continues on 'elapsed'.`);
        } else if (execution.outcome === "received") {
            lines.push(`Received ${execution.contract || wanted.contract}${execution.senderSessionId ? ` from ${execution.senderSessionId}` : ""}.`);
        } else if (execution.outcome === "elapsed") lines.push("The wait limit passed before a matching message arrived.");
    } else if (kind === "send") {
        const to = execution.recipientSessionId || execution.outbox?.recipientSessionId || party(node.recipient);
        if (pending && execution.outbox?.state !== "delivered") lines.push(`Delivering ${node.contract} to ${to}.`);
        else if (execution.resultKind === "runtime_error" || execution.outbox?.state === "failed") lines.push(`Delivery to ${to} failed.`);
        else {
            lines.push(`${node.contract} was delivered to the queue of ${to}.`);
            lines.push("This does not show that the recipient read, answered or acted on it.");
        }
    } else if (kind === "request") {
        const to = execution.outbox?.recipientSessionId || party(node.recipient);
        if (pending) lines.push(`Awaiting a response to ${node.contract} from ${to}.`);
        else if (execution.outcome === "responded") lines.push(`${execution.responderSessionId || to} responded.`);
        else if (execution.outcome === "declined") lines.push(`${execution.responderSessionId || to} declined the request.`);
    } else if (kind === "agent") {
        // Its agent chat (id, open, who may write) is shown once, beside the step: the portal's Agent session, the terminal's Agent chats.
        if (pending) lines.push("Only the agent's typed result completes this step; its chat messages do not.");
    } else if (kind === "parallel") {
        if (Number.isSafeInteger(execution.branches)) lines.push(`${execution.branches} branch${execution.branches === 1 ? "" : "es"} from its manifest.`);
        if (pending) lines.push(`Branches start at '${node.body?.initial}', ${node.concurrency === 1 ? "one at a time" : `up to ${node.concurrency} at a time`}.`);
    }
    if (execution.branch && Number.isSafeInteger(execution.branch.index)) lines.push(`In branch ${workflowV2BranchNumber(execution.branch.index)} of its parallel step.`);
    if (execution.catchAll) lines.push("Entered as the workflow's catch-all step after an unhandled runtime error.");
    return lines;
}

/**
 * One visit's state as the graph says it (`run`, the shown run's status): a pending visit while the run runs, is paused,
 * is not certain or ended first; an ended visit by its result. { state, phase, stateLabel, outcome, resultKind }; a
 * pending visit has no outcome of its own. The step's node view says its shown visit this way; a branch step's picker
 * says each branch's visit this way (review UI7-3).
 */
function visitStatus(node, execution, run) {
    const kind = workflowV2Kind(node);
    if (execution.status === "pending") {
        if (run.ended) return { state: "cancelled", phase: "ended-early", stateLabel: "Run ended first" };
        if (run.phase === "unverified") return { state: "idle", phase: "unverified", stateLabel: "Pending · run status not certain" };
        if (run.phase === "paused") return { state: "idle", phase: "paused", stateLabel: "Pending · run paused" };
        return { state: "running", phase: kind === "script" ? "running" : "waiting", stateLabel: pendingText(kind, execution) };
    }
    const ended = { outcome: execution.outcome, resultKind: execution.resultKind };
    // A parallel step's own time limit (owner decision join-k-of-n) passed before its join.
    if (kind === "parallel" && execution.resultKind === "runtime_error" && execution.outcome === "timed_out") {
        return { ...ended, state: "failed", phase: "error", stateLabel: "Time limit passed before the join" };
    }
    if (execution.resultKind === "runtime_error") {
        return { ...ended, state: "failed", phase: "error",
            stateLabel: `Runtime error${execution.outcome ? ` · ${execution.outcome}` : execution.effectStatus ? ` · action ${execution.effectStatus}` : ""}` };
    }
    if (node.type === "terminal") {
        return { ...ended, outcome: node.outcome, state: node.outcome === "failed" ? "failed" : node.outcome === "cancelled" ? "cancelled" : "done",
            phase: "done", stateLabel: `Ended · ${node.outcome}` };
    }
    // A join of the first k (owner decision join-k-of-n) says how many it took; a join blocked at its time limit says so
    // (J1b, Q3: k could no longer happen by then).
    const first = kind === "parallel" ? workflowV2JoinFirst(node) : null;
    const atLimit = kind === "parallel" && execution.outcome === "blocked" && workflowV2DecidedAtLimit(execution) ? " · the time limit passed" : "";
    if (execution.resultKind === "business" && first !== null && (execution.outcome === "joined" || execution.outcome === "blocked")) {
        return { ...ended, state: "done", phase: "done", stateLabel: execution.outcome === "joined"
            ? `Joined · the first ${first === 1 ? "branch" : `${first} branches`} succeeded`
            : `Blocked · ${first === 1 ? "no branch" : `fewer than ${first} branches`} could succeed${atLimit}` };
    }
    if (atLimit && execution.resultKind === "business") return { ...ended, state: "done", phase: "done", stateLabel: `${outcomeText(kind, execution.outcome)}${atLimit}` };
    if (execution.resultKind === "business") return { ...ended, state: "done", phase: "done", stateLabel: outcomeText(kind, execution.outcome) };
    return { ...ended, state: "done", phase: "unclassified", stateLabel: "Completed · how it ended was not recorded" };
}

/**
 * Where each visit of a branch step was (adversarial review R2-UI-5), by its execution id: its branch (`index`, and its
 * `number` as people read it), its parallel step's visit (`parallelVisit`, that visit's number, when known) and a `label`
 * ("branch 2", or "branch 2 · parallel visit 1" when the step has visits in more than one parallel visit). Pure.
 */
export function workflowV2VisitPlaces(executions, parallelOrdinals = null) {
    const list = (Array.isArray(executions) ? executions : []).filter(item => typeof item?.id === "string" && isRecord(item.branch)
        && typeof item.branch.parallelNodeExecutionId === "string" && Number.isSafeInteger(item.branch.index));
    const visits = new Set(list.map(item => item.branch.parallelNodeExecutionId));
    return Object.fromEntries(list.map(item => {
        const ordinal = parallelOrdinals instanceof Map ? parallelOrdinals.get(item.branch.parallelNodeExecutionId) : undefined;
        const parallelVisit = Number.isSafeInteger(ordinal) ? ordinal : null;
        const number = workflowV2BranchNumber(item.branch.index);
        return [item.id, { index: item.branch.index, number, parallelExecutionId: item.branch.parallelNodeExecutionId, parallelVisit,
            label: `branch ${number}${visits.size > 1 ? ` · parallel visit ${parallelVisit ?? "not loaded"}` : ""}` }];
    }));
}

/**
 * The scope a visit's number counts in (adversarial review R2-UI-4): one branch of one parallel visit
 * ("<parallel visit>#<index>", as the runtime names the scope), else the scope the read model or event names, else the
 * root. Visits of a step in different branches, or in another visit of its parallel step, are never compared by number.
 */
export function workflowV2VisitScope(execution) {
    const branch = execution?.branch;
    if (isRecord(branch) && typeof branch.parallelNodeExecutionId === "string" && Number.isSafeInteger(branch.index)) {
        return `${branch.parallelNodeExecutionId}#${branch.index}`;
    }
    return text(execution?.scopeId) ?? "root";
}

/** When a visit ended, to order ended visits across scopes (the read model's completedAt); -Infinity when not known. */
const endedAt = item => {
    const time = typeof item?.completedAt === "string" ? Date.parse(item.completedAt) : NaN;
    return Number.isFinite(time) ? time : -Infinity;
};

/**
 * A step's visits by the scope they count in (R2-UI-4), each scope's shown visit (shownVisit, within the scope), and the
 * scopes that are the step's now: a branch step's are the branches of its parallel step's shown visit (`parallelVisit`),
 * when any reached the step; every other step's are all of them.
 */
function visitScopes(list, parallelVisit) {
    const byScope = new Map();
    for (const item of list) {
        const key = workflowV2VisitScope(item);
        if (!byScope.has(key)) byScope.set(key, []);
        byScope.get(key).push(item);
    }
    const scopes = [...byScope].map(([key, items]) => ({ key, items, ...shownVisit(items),
        index: Number.isSafeInteger(items[0]?.branch?.index) ? items[0].branch.index : null }));
    const current = typeof parallelVisit?.id === "string"
        ? scopes.filter(scope => scope.items.some(item => item.branch?.parallelNodeExecutionId === parallelVisit.id)) : [];
    return { scopes, current: current.length ? current : scopes };
}

function nodeView(node, executions, context) {
    const kind = workflowV2Kind(node);
    const list = executions.filter(item => item.stateId === node.id).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    // R2-UI-4: visit numbers count within a scope (the root, or one branch of one parallel visit). Each scope's pending
    // visit is stale only against an ended visit of the same scope, and a branch step says its branches' state in the
    // parallel step's shown visit: running while any of them runs, else its latest ended visit there.
    const { scopes, current } = visitScopes(list, typeof node.parallel === "string" ? context.parallelVisits?.get(node.parallel) ?? null : null);
    const byBranch = (a, b) => (a.index ?? Infinity) - (b.index ?? Infinity);
    const running = current.filter(scope => scope.pending).sort(byBranch);
    const pending = running[0]?.pending;
    const latestDone = current.map(scope => scope.latestDone).filter(Boolean)
        .reduce((latest, item) => (!latest || endedAt(item) > endedAt(latest) || (endedAt(item) === endedAt(latest) && (item.ordinal ?? 0) >= (latest.ordinal ?? 0)) ? item : latest), null)
        ?? undefined;
    // A pending execution older than a completed one of its own scope lost its completion from the loaded history.
    const stalePending = scopes.some(scope => scope.items.some(item => item.status === "pending" && item !== scope.pending));
    const reachedByRun = node.type === "terminal" && context.terminalState === node.id;
    // Each scope's visits count on their own: the visits a step had are the sum of its scopes'.
    const runs = Math.max(scopes.reduce((sum, scope) => sum + Math.max(scope.items.length, ...scope.items.map(item => item.ordinal ?? 0)), 0), reachedByRun ? 1 : 0);
    let state = "idle", phase = "not-reached", stateLabel = context.stateless ?? (context.hasRun ? "Not reached" : "No run");
    const result = latestDone || null;
    let outcome = result?.outcome, resultKind = result?.resultKind;
    // While a visit is pending its status is said, and Last outcome stays the latest ended visit's.
    const shown = pending && !(node.type === "terminal" && context.run.ended) ? pending : result;
    if (shown) {
        const status = visitStatus(node, shown, context.run);
        ({ state, phase, stateLabel } = status);
        if (shown === result) ({ outcome, resultKind } = status);
        // Several branches reached the step: how many of them run it now (R2-UI-4).
        if (shown === pending && current.length > 1 && running.length > 0 && status.state === "running") {
            stateLabel = `${stateLabel} · in ${running.length} of ${plural(current.length, "branch", "branches")}`;
        }
    } else if (reachedByRun) {
        state = node.outcome === "failed" ? "failed" : node.outcome === "cancelled" ? "cancelled" : "done";
        phase = "done"; outcome = node.outcome; resultKind = "business"; stateLabel = `Ended · ${node.outcome}`;
    }
    // Every loaded visit, newest first: older history a person loaded reaches any visit of the state.
    const history = [...list].reverse();
    const binding = workflowV2AgentBinding(node, context.pins);
    const view = {
        ...node, shape: "v2", kind, label: workflowV2NodeLabel(node), state, phase, stateLabel, runs,
        ...(binding ? { binding } : {}),
        partial: !context.complete || stalePending || runs > list.length,
        outcome: outcome ?? (node.type === "terminal" ? node.outcome : undefined), resultKind,
        result, pending: pending || null, current: pending || latestDone || null, executions: history,
        description: [...describeWorkflowV2Execution(node, pending || latestDone), ...branchProgressLines(node, pending || latestDone, context)],
        ...(node.type === "parallel" ? { evidence: workflowV2BranchEvidence(context.executions, context.states, pending || latestDone, context.complete, node) } : {}),
    };
    // Owner batch 7 (H2): a parallel step's branch box and join bar; a branch step's visit in each branch, for its picker.
    if (node.type === "parallel") view.joinBar = workflowV2JoinView(view, context);
    if (typeof node.parallel === "string") {
        view.branches = workflowV2BranchChoices(list, context.parallelVisits?.get(node.parallel) ?? null, { node, run: context.run });
        view.where = workflowV2VisitPlaces(list, context.parallelOrdinals?.get(node.parallel) ?? null);
    }
    return view;
}

/**
 * The pins that apply to the graph's named agent states for the shown run (R18): a real-agent test run's own (only
 * when its revision is the graph's), none for a mocked test run, otherwise the publication's when the graph is the
 * published revision. Null when none apply (a draft, or no read model).
 */
function agentPinSource(shared, run, bound, active) {
    if (run?.test) {
        if (run.test.agentMode !== "real") return { by: "mocked", pins: null };
        return bound && isRecord(run.test.agentPins) ? { by: "test", pins: run.test.agentPins } : null;
    }
    return shared?.ok && isRecord(shared.publishedAgentPins) && Number.isSafeInteger(shared.publishedRevision)
        && active?.revision === shared.publishedRevision ? { by: "publication", pins: shared.publishedAgentPins } : null;
}

/**
 * Everything the V2 graph, header and details need from a definition, durable
 * events and the read models. Always returns; it reports what it ignored
 * instead of throwing.
 *
 * `readModel` is the read model read for the current run selection
 * (`selectedRunId`, null for the live run): only its run is ever overlaid.
 * `workflowModel` is the last read model of any selection; while the
 * selection's own model is not there (still loading, or its read failed),
 * its workflow-wide parts (the graph or that there is none, the definition
 * state, the revision with its diagnostics, the runs) still decide what is
 * drawn, and its run is never shown. Without its own model a selected run
 * shows only its own events; only the live selection falls back to the
 * latest run in the events, never one known to be another kind of run.
 * `olderHistory` (the view's) is the older pages of history a person loaded;
 * they join the selection's own model only for the run it shows. `now`
 * (epoch milliseconds) decides only whether a waiting reply has expired.
 */
export function projectWorkflowV2({ definition = null, readModel = null, workflowModel = null, selectedRunId = null, events = [], readModelAfterSeq = null,
    olderHistory = null, now = Date.now() } = {}) {
    const model = readModel ? projectWorkflowV2ReadModel(readModel, { older: olderHistory, now }) : null;
    const wide = model || !workflowModel ? null : projectWorkflowV2ReadModel(workflowModel, { now });
    // The workflow-wide source: the selection's own model, else another selection's model that projects.
    const shared = model ?? (wide?.ok ? wide : null);
    const banners = model ? [...model.banners] : shared ? [...shared.workflowBanners] : [];
    const modelOk = Boolean(model?.ok);
    // A read model that says there is no graph is not overridden by an older run's definition, whichever run it was read for.
    const active = shared?.ok ? shared.definition : definition?.shape === "v2" ? definition : null;
    // With a read model, only the run it names, and only when that run used the graph's revision, may be overlaid.
    // Events that belong to no selected run, to another run than the one selected, or to another revision, are never
    // painted onto the graph.
    const selection = selectedRunId ?? null;
    const run = modelOk ? model.run : null;
    // Without its own model, the live selection stands for the latest run in the events that is not known to be another kind.
    const runId = modelOk ? run?.runId ?? null : selection ?? latestRunId(events, notLiveRunIds(events, shared));
    let bound = modelOk ? Boolean(run && model.overlay) : true;
    let unboundRevision = modelOk ? model.runRevision : null;
    if (!modelOk && runId && active?.revision !== undefined) {
        const begun = events.findLast(event => event?.eventType === "workflow.started" && event.data?.runId === runId);
        // A run's revision never changes, so the workflow's run list says it when the run's start is not among the loaded events.
        const listed = shared?.ok ? shared.runs.find(item => item?.runId === runId)?.revision : undefined;
        const revision = Number.isSafeInteger(begun?.data?.revision) ? begun.data.revision : listed;
        if (Number.isSafeInteger(revision) && revision !== active.revision) {
            bound = false; unboundRevision = revision;
            banners.push({ level: "warning", text: `This run used revision ${revision}; the graph shows revision ${active.revision}, so its step status is not shown on the graph.` });
        }
    }
    const { executions, ignoredEvents, ignoredRows } = bound
        ? collectExecutions(events, runId, run, true) : { executions: [], ignoredEvents: 0, ignoredRows: 0 };
    let status = !bound && modelOk && !run
        ? { phase: "none", ended: false, label: model.runs.length ? "No live run selected" : "No run yet" }
        : workflowV2RunStatus({ run, events: bound || !modelOk ? events : [], runId, readModelAfterSeq });
    // A selected run whose own read model is not here (yet), and none of whose events are loaded.
    if (!modelOk && selection !== null && status.phase === "none") status = { ...status, label: "Selected run not loaded" };
    if (!bound && runId) status = { ...status, terminalState: null, label: `${unboundRevision === null ? "Run of an unknown revision" : `Revision ${unboundRevision} run`} · ${status.label}` };
    // Replies waiting in the shown run beside its status (q15, mock M16: "Paused · 1 reply waiting"); the banner says why.
    if (bound && modelOk && model.waitingReplies > 0 && !status.ended) {
        status = { ...status, label: `${status.label}${workflowV2WaitingRepliesLabel(model.waitingReplies)}` };
    }
    if (status.phase === "unverified") {
        banners.push({ level: "warning", text: `Run status is not certain: the workflow's data says ${status.conflict.readModel} but its latest event says ${status.conflict.events}. Refresh to read it again.` });
    }
    if (ignoredEvents) banners.push({ level: "warning", text: `${ignoredEvents} workflow event${ignoredEvents === 1 ? "" : "s"} had an unknown format and ${ignoredEvents === 1 ? "was" : "were"} ignored.` });
    if (ignoredRows) banners.push({ level: "warning", text: `${ignoredRows} visit${ignoredRows === 1 ? "" : "s"} had an unknown format and ${ignoredRows === 1 ? "was" : "were"} ignored.` });
    const known = new Set((active?.states || []).map(node => node.id));
    const unknown = executions.filter(item => !known.has(item.stateId)).length;
    if (unknown) banners.push({ level: "warning", text: `${unknown === 1 ? "1 visit belongs" : `${unknown} visits belong`} to steps that are not in this graph.` });
    const context = { run: status, hasRun: status.phase !== "none", terminalState: bound ? status.terminalState ?? run?.terminalState ?? null : null,
        complete: Boolean(run && bound && run.history.complete), stateless: !bound && runId ? "Not shown on the graph" : undefined,
        // Every open row is listed (R2-UI-7): the branches running now are all known even when older history is not loaded.
        openComplete: Boolean(run && bound && run.history.openComplete),
        pins: agentPinSource(shared, run, bound, active) };
    // Each parallel state's branches as the loaded executions show them (mock M21 active and queued counts, M22 a blocked join).
    context.branchProgress = workflowV2BranchProgress(executions, active?.states || []);
    // Each branch's result for a parallel step's evidence (owner decision q16; mocks M22 to M24).
    context.executions = executions;
    context.states = active?.states || [];
    // Owner batch 7 (H2): each parallel step's shown visit, for its branch steps' branch pickers.
    context.parallelVisits = new Map(context.states.filter(node => node?.type === "parallel").map(node => {
        const visit = shownVisit(executions.filter(item => item.stateId === node.id).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)));
        return [node.id, visit.pending ?? visit.latestDone];
    }));
    // Each parallel step's visits by their number, so a branch step's visit says which of them it was in (R2-UI-5).
    context.parallelOrdinals = new Map(context.states.filter(node => node?.type === "parallel").map(node => [node.id,
        new Map(executions.filter(item => item.stateId === node.id && typeof item.id === "string" && Number.isSafeInteger(item.ordinal))
            .map(item => [item.id, item.ordinal]))]));
    const nodes = (active?.states || []).map(node => nodeView(node, executions, context));
    return {
        shape: "v2", status, definition: active, nodes, banners, readModel: model, runId, bound,
        diagnostics: shared?.diagnostics || [], inbox: bound ? run?.inbox || [] : [], outbox: bound ? run?.outbox || [] : [],
        output: bound ? run?.output ?? null : null, error: bound ? run?.error ?? null : null, modelStatus: shared?.status ?? null,
        // Why the shown run ended (owner decision q14), from its read and its end events; null while it runs.
        ending: bound && run && status.ended ? workflowV2RunEnding(run, events) : null,
        // The workflow's latest revision: its number, whether it is valid, and its errors (owner batch 7, H1).
        latest: shared?.ok ? { revision: shared.latestRevision, valid: shared.validRevision,
            errors: shared.diagnostics.filter(item => item.severity === "error").length } : null,
    };
}

/**
 * Whether the workflow's parent agent is still writing its latest revision (owner batch 7, H1): that revision is not
 * valid, and `parentWorking` (the parent agent's session is in a turn: workflowParentWorking). `{ revision, errors }`
 * for the calm in-progress screen, or null for today's invalid state. Pure.
 */
export function workflowV2DraftInProgress(projection, parentWorking) {
    const latest = projection?.latest;
    if (parentWorking !== true || !isRecord(latest) || latest.valid !== false) return null;
    return { revision: latest.revision, errors: latest.errors };
}

/** "Revision 3 has 2 errors" (or "unlisted errors" when the read lists none). Pure. */
export function workflowV2RevisionErrorsText(revision, errors) {
    return `Revision ${revision} has ${errors || "unlisted"} error${errors === 1 ? "" : "s"}`;
}

/** Collapse neighbouring executions that ended the same way, with the same output, into one row. The raw list stays available to the caller. */
export function compactWorkflowV2Executions(executions) {
    const rows = [];
    for (const execution of executions) {
        // Only visits of one scope are combined: never two branches', or two parallel visits' (adversarial review R2-UI-5).
        const key = JSON.stringify([workflowV2VisitScope(execution), execution.status, execution.outcome, execution.resultKind,
            execution.outputPreview ?? null, execution.errorPreview ?? null]);
        const last = rows.at(-1);
        if (last && last.key === key && execution.status === "completed") {
            last.count++;
            last.from = Math.min(last.from, execution.ordinal ?? last.from);
            last.to = Math.max(last.to, execution.ordinal ?? last.to);
        } else {
            rows.push({ key, execution, count: 1, from: execution.ordinal ?? 0, to: execution.ordinal ?? 0 });
        }
    }
    return rows;
}

/**
 * Which execution of a state a person reads (R01 history; design 02 node occurrences), by its exact identity: the one `selection` names
 * ({ runId, stateId, executionId }) when it is for exactly this run (`runId`, the run the projection overlays) and this
 * state (`node`, a v2 node view); otherwise the state's latest completed execution, as before. A chosen execution that
 * is not among the state's loaded executions is `missing`, and the latest result is never shown in its place. `index`
 * is its place in `node.executions` (newest first), -1 when there is none. Pure.
 */
export function workflowV2ShownExecution(node, runId, selection, branch = null) {
    const executions = Array.isArray(node?.executions) ? node.executions : [];
    const chosen = isRecord(selection) && typeof selection.executionId === "string" && selection.executionId !== ""
        && selection.stateId === node?.id && (selection.runId ?? null) === (runId ?? null);
    if (!chosen) {
        // A branch step with a branch chosen in its details (or its default branch): that branch's latest ended visit,
        // never another branch's in its place (adversarial review R2-UI-5).
        const ofBranch = isRecord(branch) && Number.isSafeInteger(branch.index);
        const execution = ofBranch ? (isRecord(branch.ended) ? branch.ended : null) : isRecord(node?.result) ? node.result : null;
        return { chosen: false, missing: false, execution, executionId: execution?.id ?? null,
            index: execution ? executions.findIndex(item => item?.id === execution.id) : -1, ...(ofBranch ? { branchIndex: branch.index } : {}) };
    }
    const index = executions.findIndex(item => item?.id === selection.executionId);
    return { chosen: true, missing: index < 0, execution: index < 0 ? null : executions[index], executionId: selection.executionId, index };
}

/**
 * One execution's own result as a person reads it: `pending` (it has not ended), `error` (a runtime error: its recorded
 * error preview, its code and any effect status), `output` (its output preview, JSON null included), `none` (it ended
 * without an output), or `missing` (no execution). `truncated`: the read cut the preview short (it ends with "…"), so
 * the whole value is not in the read model. Values are previews as read, never another execution's. Pure.
 */
export function workflowV2ExecutionResult(execution) {
    if (!isRecord(execution)) return { kind: "missing", value: null, truncated: false, code: null, effectStatus: null };
    const code = typeof execution.outcome === "string" && execution.outcome ? execution.outcome : null;
    const effectStatus = typeof execution.effectStatus === "string" && execution.effectStatus ? execution.effectStatus : null;
    if (execution.status === "pending") return { kind: "pending", value: null, truncated: false, code: null, effectStatus: null };
    if (execution.resultKind === "runtime_error") {
        const value = execution.errorPreview === undefined ? null : execution.errorPreview;
        return { kind: "error", value, truncated: isTruncated(value), code, effectStatus };
    }
    if (execution.outputPreview !== undefined && execution.outputPreview !== null) {
        return { kind: "output", value: execution.outputPreview, truncated: isTruncated(execution.outputPreview), code, effectStatus };
    }
    return { kind: "none", value: null, truncated: false, code, effectStatus };
}

/** The rows of one section's page in a read model's run, before any older page: its node executions, inbox, outbox or a test run's interceptions. Pure. */
export function workflowV2RunPageRows(run, section) {
    const value = section === "executions" ? run?.nodeExecutions : section === "inbox" ? run?.inbox : section === "outbox" ? run?.outbox
        : section === "interceptions" ? run?.test?.interceptions : null;
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The key of one execution's whole value in the view's `executionValues`: its run, then the execution. */
export function workflowV2ExecutionValueKey(runId, executionId) {
    return JSON.stringify([runId ?? null, executionId]);
}

/**
 * One execution's whole value as the view read it (`executionValues`, which the controller's loadWorkflowExecutionValue
 * writes: { runId, executionId, phase: loading, loaded or failed, result, error }), for exactly that run and execution;
 * null when it was not read. Pure.
 */
export function workflowV2ExecutionValue(values, runId, executionId) {
    if (!isRecord(values) || typeof executionId !== "string" || !executionId) return null;
    const entry = values[workflowV2ExecutionValueKey(runId, executionId)];
    return isRecord(entry) && entry.executionId === executionId && (entry.runId ?? null) === (runId ?? null) ? entry : null;
}

/**
 * What one execution's whole value shows (design 04 read_workflow execution_id; mock M10 "Inspect typed output"; D07):
 * `loading`; `failed` with its error; `none` (it has no result: it has not ended); `value`, the whole output or runtime
 * error (`label`) as read, a string as it is and any other JSON indented, with its size in bytes; or `preview`, a stored
 * value larger than a read returns (none is written), its bounded preview with its size and the limit. Null without an
 * entry. Never another execution's value. Pure.
 */
export function workflowV2WholeValue(entry) {
    if (!isRecord(entry)) return null;
    if (entry.phase === "loading") return { kind: "loading" };
    if (entry.phase === "failed") return { kind: "failed", error: typeof entry.error === "string" && entry.error ? entry.error : "The value could not be read." };
    const result = isRecord(entry.result) ? entry.result : null;
    if (!result) return { kind: "none" };
    const label = result.kind === "error" ? "Runtime error" : "Output";
    const bytes = Number.isSafeInteger(result.bytes) ? result.bytes : null;
    if (result.whole === true) {
        const value = result.value ?? null;
        return { kind: "value", label, bytes, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
    }
    return { kind: "preview", label, bytes, limitBytes: Number.isSafeInteger(result.limitBytes) ? result.limitBytes : null,
        text: typeof result.preview === "string" ? result.preview : "" };
}

/** The key of one KV revision's snapshot in the view's `kvRevisions`: its run, then the revision. */
export function workflowV2KvRevisionKey(runId, revision) {
    return JSON.stringify([runId ?? null, revision]);
}

/**
 * One KV revision's snapshot as the view read it (`kvRevisions`, which the controller's loadWorkflowKvRevision writes:
 * { runId, revision, phase: loading, loaded or failed, kv, error }), for exactly that run and revision; null when it
 * was not read. Pure.
 */
export function workflowV2KvSnapshot(snapshots, runId, revision) {
    if (!isRecord(snapshots) || !Number.isSafeInteger(revision)) return null;
    const entry = snapshots[workflowV2KvRevisionKey(runId, revision)];
    return isRecord(entry) && entry.revision === revision && (entry.runId ?? null) === (runId ?? null) ? entry : null;
}

/**
 * The variables a state's visit applied and the run's accepted ones now (design 02 open KV: a state reads the revision
 * pinned when it was admitted; mock M15 "Accepted 9 / applied 8"): { applied, accepted, same }, or null when the visit
 * names no revision. Pure.
 */
export function workflowV2KvApplied(execution, run) {
    const applied = Number.isSafeInteger(execution?.kvRevision) && execution.kvRevision >= 1 ? execution.kvRevision : null;
    if (applied === null) return null;
    const accepted = Number.isSafeInteger(run?.kvRevision) && run.kvRevision >= 1 ? run.kvRevision : null;
    return { applied, accepted, same: accepted !== null && accepted === applied };
}

const kvShown = entry => (Object.hasOwn(entry, "value") ? JSON.stringify(entry.value) : typeof entry.preview === "string" ? entry.preview : "");

/**
 * Two revisions of a run's variables compared key by key (mock M15 "Compare snapshots"): from the snapshots the read
 * returns (kv.entries: key, bytes, sha256, value or preview), each key `added`, `removed`, `changed` (another sha256)
 * or `same`, with the value shown before and after (whole JSON when the read sent it whole, else its preview), sorted
 * by key, and the counts. Null unless both are loaded. Pure.
 */
export function workflowV2KvCompare(before, after) {
    const entriesOf = snapshot => (isRecord(snapshot?.kv) && Array.isArray(snapshot.kv.entries) ? snapshot.kv.entries.filter(isRecord) : null);
    const from = entriesOf(before), to = entriesOf(after);
    if (!from || !to) return null;
    const byKey = list => new Map(list.filter(entry => typeof entry.key === "string").map(entry => [entry.key, entry]));
    const a = byKey(from), b = byKey(to);
    const rows = [...new Set([...a.keys(), ...b.keys()])].sort().map(key => {
        const x = a.get(key), y = b.get(key);
        const change = !x ? "added" : !y ? "removed" : x.sha256 === y.sha256 ? "same" : "changed";
        return { key, change, before: x ? kvShown(x) : null, after: y ? kvShown(y) : null };
    });
    const counts = { added: 0, removed: 0, changed: 0, same: 0 };
    for (const row of rows) counts[row.change] += 1;
    return { from: before.kv.revision, to: after.kv.revision, rows, counts,
        whole: before.kv.whole === true && after.kv.whole === true };
}

/**
 * Each parallel state execution's branches as the loaded executions show them (mock M21 "active and queued counts",
 * M22 "JOIN BLOCKED k / n accepted"): by the parallel state's node execution id, the branches that have begun
 * (`started`), those with work still pending (`active`), and those that reached a terminal state that succeeded
 * (`succeeded`). From the executions loaded only: older history not loaded may hold more (the caller says so). Pure.
 */
export function workflowV2BranchProgress(executions, states = []) {
    const succeededTerminal = new Set((Array.isArray(states) ? states : []).filter(node => node?.type === "terminal" && node.outcome === "succeeded").map(node => node.id));
    const byParallel = new Map();
    for (const execution of Array.isArray(executions) ? executions : []) {
        const branch = execution?.branch;
        if (!isRecord(branch) || typeof branch.parallelNodeExecutionId !== "string" || !Number.isSafeInteger(branch.index)) continue;
        const branches = byParallel.get(branch.parallelNodeExecutionId) ?? new Map();
        const seen = branches.get(branch.index) ?? { pending: false, succeeded: false };
        if (execution.status === "pending") seen.pending = true;
        if (execution.status === "completed" && succeededTerminal.has(execution.stateId)) seen.succeeded = true;
        branches.set(branch.index, seen);
        byParallel.set(branch.parallelNodeExecutionId, branches);
    }
    const progress = new Map();
    for (const [id, branches] of byParallel) {
        const list = [...branches.values()];
        progress.set(id, { started: list.length, active: list.filter(item => item.pending).length, succeeded: list.filter(item => item.succeeded).length });
    }
    return progress;
}

/** A parallel state's branches now, as lines of its description: active, queued and ended while it runs; a blocked join's k of n. */
function branchProgressLines(node, execution, context) {
    if (node?.type !== "parallel" || !execution || !Number.isSafeInteger(execution.branches)) return [];
    const progress = context.branchProgress?.get(execution.id) ?? { started: 0, active: 0, succeeded: 0 };
    const note = context.complete ? "" : " (in the loaded history)";
    if (execution.status === "pending") {
        const counts = workflowV2BranchCounts(execution.branches, progress, context);
        return [counts.partial
            ? `Branches now${note}: ${counts.runningExact ? "" : "at least "}${counts.running} active, at least ${counts.done} ended, `
                + `${counts.unknown} not in the loaded history (queued, or ended earlier).`
            : `Branches now: ${counts.running} active, ${counts.queued} queued, ${counts.done} ended.`];
    }
    if (execution.outcome === "blocked") {
        // A join of the first k (owner decision join-k-of-n) says how many it needed; J1b: that its time limit passed.
        const first = workflowV2JoinFirst(node);
        return [`Join blocked${note}: ${progress.succeeded} of ${execution.branches} branches succeeded${first !== null ? `; it needed ${first}` : ""}`
            + `${workflowV2DecidedAtLimit(execution) ? "; the time limit passed" : ""}.`];
    }
    return [];
}

// ── A parallel step's branch box, join bar and branch picker (owner batch 7, H2) ─────────────────────────────────────

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * A branch's number as people read it: its index plus one, so the first branch is "branch 1" (owner batch 7, H2). The
 * data (events, the read model, the parent agent's messages) keep the index from 0. Pure.
 */
export function workflowV2BranchNumber(index) {
    return Number.isSafeInteger(index) ? index + 1 : index;
}

/** "branches 2, 3" or "branch 2" for the branch indexes given (from 0), as people read them. Pure. */
export function workflowV2BranchList(indexes) {
    const list = Array.isArray(indexes) ? indexes : [];
    return `${list.length === 1 ? "branch" : "branches"} ${list.map(workflowV2BranchNumber).join(", ")}`;
}

/** "the list in ${input.items}" for a binding, "3 items" for a literal list (never its values: SF-3). Pure. */
export function workflowV2ForEachText(forEach) {
    if (typeof forEach === "string" && forEach) return `the list in ${forEach}`;
    if (isRecord(forEach) && Number.isSafeInteger(forEach.count)) return `${plural(forEach.count, "item")} in the definition`;
    return "a list this view does not show";
}

/**
 * A parallel step's branch steps in the order a branch meets them (owner batch 7, H2): from its first step along its
 * routes, breadth first, then any step no route reaches, in body order. Only steps of `states`. Pure.
 */
export function workflowV2BranchSteps(parallel, states) {
    const byId = new Map((Array.isArray(states) ? states : []).filter(isRecord).map(node => [node.id, node]));
    const members = (Array.isArray(parallel?.body?.states) ? parallel.body.states : []).filter(id => byId.has(id));
    const inBody = new Set(members);
    const order = [];
    const queue = inBody.has(parallel?.body?.initial) ? [parallel.body.initial] : [];
    while (queue.length) {
        const id = queue.shift();
        if (order.includes(id)) continue;
        order.push(id);
        for (const target of Object.values(byId.get(id).next || {})) if (inBody.has(target) && !order.includes(target)) queue.push(target);
    }
    return [...order, ...members.filter(id => !order.includes(id))];
}

/** The visit of a state the graph shows: its pending visit unless a later one ended, else its latest ended visit. */
function shownVisit(list) {
    const latestDone = list.findLast(item => item.status === "completed");
    const pending = list.findLast(item => item.status === "pending" && (!latestDone || (item.ordinal ?? 0) >= (latestDone.ordinal ?? 0)));
    return { pending: pending ?? null, latestDone: latestDone ?? null };
}

const JOIN_WORDS = { waiting: "waiting for its branches", joined: "joined", blocked: "blocked", failed: "failed", cancelled: "ended early",
    timed_out: "time limit passed" };

/** The k of a parallel step's join of the first k (owner decision join-k-of-n, IR 9); null for a join of every branch. Pure. */
export function workflowV2JoinFirst(node) {
    const first = isRecord(node?.join) ? node.join.first : null;
    return Number.isSafeInteger(first) && first >= 1 ? first : null;
}

/** How many items a parallel step runs when the graph or its shown visit says it (a literal list's count, or the visit's branches); else null. Pure. */
function joinItems(node, visit) {
    if (Number.isSafeInteger(visit?.branches)) return visit.branches;
    return isRecord(node?.forEach) && Number.isSafeInteger(node.forEach.count) ? node.forEach.count : null;
}

/**
 * A parallel step's join rule as people read it (owner decision join-k-of-n): "all required" for every branch; "first
 * success" for the first 1; "first 2 of 5" when the items are known (a literal list, or the shown visit's), else
 * "first 2". Pure.
 */
export function workflowV2JoinRule(node, visit = null) {
    const first = workflowV2JoinFirst(node);
    if (first === null) return "all required";
    if (first === 1) return "first success";
    const items = joinItems(node, visit);
    return items === null ? `first ${first}` : `first ${first} of ${items}`;
}

/**
 * The join rule in words, for a parallel step's details (owner decision join-k-of-n): who must succeed, what happens to
 * the others, and failFast. Pure.
 */
export function workflowV2JoinWords(node) {
    const first = workflowV2JoinFirst(node);
    const rule = first === null ? "Every branch must succeed"
        : first === 1 ? "The first branch to succeed joins; the others are cancelled"
            : `The first ${first} branches to succeed join; the others are cancelled`;
    if (!node?.failFast) return rule;
    return `${rule} · ${first === null ? "the first failure cancels the others" : "once the join can no longer succeed, the others are cancelled"}`;
}

/**
 * A parallel step's own time limit (owner decision join-k-of-n, IR 9; the engine enforces it), as people read it: null
 * without one; else `{ text, title }`. It says "time limit 30 s" (or "time limit from the input" for a binding), and
 * "time limit until <time>" while the shown visit waits with a deadline; once it timed out, the title says when it passed
 * (the join's own words say that it did). Pure.
 */
export function workflowV2JoinLimit(node, visit = null, { running = false, timedOut = false } = {}) {
    const seconds = node?.timeoutSeconds;
    if (seconds === undefined || seconds === null) return null;
    const length = typeof seconds === "number" ? formatSeconds(seconds) : null;
    const from = length === null ? `set from the input (${String(seconds)}) when the step starts` : `${length} from the step's start`;
    const deadline = typeof visit?.deadline === "string" ? workflowV2EventTime(visit.deadline) : null;
    const text = length === null ? "time limit from the input" : `time limit ${length}`;
    if (timedOut) return { text, title: `The time limit is ${from}. It passed before the join${deadline ? `, at ${deadline}` : ""}.` };
    if (running && deadline) return { text: `time limit until ${deadline}`, title: `The time limit is ${from}: it passes at ${deadline}.` };
    return { text, title: `The time limit is ${from}.` };
}

/**
 * Whether a parallel step's visit was decided at or after its own time limit (owner decision join-k-of-n, J1b): its
 * deadline and the time it ended, as the read model gives them (to the millisecond). A join decided then counted only
 * the successes saved by the deadline. Pure.
 */
export function workflowV2DecidedAtLimit(execution) {
    if (!isRecord(execution) || execution.status !== "completed") return false;
    const deadline = typeof execution.deadline === "string" ? Date.parse(execution.deadline) : NaN;
    const completed = typeof execution.completedAt === "string" ? Date.parse(execution.completedAt) : NaN;
    return Number.isFinite(deadline) && Number.isFinite(completed) && completed >= deadline;
}

/**
 * What a parallel step's branch box and join bar show (owner batch 7, H2; owner decision join-k-of-n): the join's
 * `state` (idle, waiting, joined, blocked, done, failed, timed_out or cancelled, from the step's own state and outcome),
 * its `rule` ("all required", "first success", "first 2 of 5") and `label` ("join · <rule>"), its `stateText`, its own
 * time limit (`limit`: { text, title } from workflowV2JoinLimit; null without one), and the box's label ("Each branch")
 * with, while the step runs, its branches now: `counts` { running, queued, done } and their `text`. `view` is the
 * parallel step's node view. Pure.
 */
export function workflowV2JoinView(view, context) {
    const visit = view.pending || view.result || null;
    const running = view.state === "running";
    const timedOut = !running && view.result?.outcome === "timed_out" && view.result?.resultKind === "runtime_error";
    // J1b (Q3): blocked at its time limit, because k could no longer happen by then.
    const blockedAtLimit = !running && view.result?.outcome === "blocked" && workflowV2DecidedAtLimit(view.result);
    const state = running ? "waiting" : timedOut ? "timed_out"
        : view.state === "done" ? (view.outcome === "joined" || view.outcome === "blocked" ? view.outcome : "done")
            : view.state === "failed" || view.state === "cancelled" ? view.state : "idle";
    const progress = running && visit ? context.branchProgress?.get(visit.id) ?? { started: 0, active: 0 } : null;
    const counts = progress && Number.isSafeInteger(visit.branches) ? workflowV2BranchCounts(visit.branches, progress, context) : null;
    const rule = workflowV2JoinRule(view, visit);
    return {
        id: `join:${view.id}`, state, rule, label: `join · ${rule}`, stateText: blockedAtLimit ? "blocked · time limit passed" : JOIN_WORDS[state] ?? null,
        limit: workflowV2JoinLimit(view, visit, { running, timedOut: timedOut || blockedAtLimit }),
        group: { label: "Each branch", counts, text: counts === null ? null : counts.partial
            ? `${counts.runningExact ? "" : "at least "}${counts.running} running · at least ${counts.done} done · ${counts.unknown} unknown`
            : `${counts.running} running · ${counts.queued} queued · ${counts.done} done` },
    };
}

/**
 * A running parallel visit's branches now (adversarial review R2-UI-7), from the loaded executions (`progress`,
 * workflowV2BranchProgress) and its `total`. With every execution of the run loaded the counts are exact: { running,
 * queued, done }. Without, a branch with no loaded row may have ended in the older history as well as not started:
 * { running, done (at least), unknown, partial: true, runningExact } and no queued count; running is exact while every
 * open row is listed (the read lists them all). Pure.
 */
export function workflowV2BranchCounts(total, progress, context) {
    const started = Math.max(0, progress?.started ?? 0);
    const running = Math.max(0, progress?.active ?? 0);
    const done = Math.max(0, started - running);
    if (context?.complete) return { running, queued: Math.max(0, total - started), done };
    return { running, done, unknown: Math.max(0, total - started), partial: true, runningExact: context?.openComplete === true };
}

/**
 * A branch step's visits in the shown visit of its parallel step, for its details' branch picker (owner batch 7, H2):
 * `{ parallelExecutionId, choices, defaultIndex }`, a choice per branch that reached the step, by branch: { index,
 * execution (its latest visit of the step in that branch, by the visit numbers within the branch), label } and, given
 * the step (`node`) and the run's status (`run`), `status` (that visit's state, as the step's own is said) and
 * `lastOutcome` (the latest ended visit in that branch: its outcome and result kind), so the details say the chosen
 * branch's status and outcome, never another branch's (review UI7-3). The default is the first branch where the step
 * runs; else, as the read model records no end time (visit numbers count within a branch, not across branches), the
 * highest-numbered branch where it ended (review UI7-6). Null when the parallel step has no shown visit or no branch
 * reached the step. Pure.
 */
export function workflowV2BranchChoices(executions, parallelVisit, { node = null, run = null } = {}) {
    if (!isRecord(parallelVisit) || typeof parallelVisit.id !== "string") return null;
    const byBranch = new Map();
    const doneByBranch = new Map();
    for (const execution of Array.isArray(executions) ? executions : []) {
        const branch = execution?.branch;
        if (!isRecord(branch) || branch.parallelNodeExecutionId !== parallelVisit.id || !Number.isSafeInteger(branch.index)) continue;
        const prior = byBranch.get(branch.index);
        if (!prior || (execution.ordinal ?? 0) >= (prior.ordinal ?? 0)) byBranch.set(branch.index, execution);
        const priorDone = doneByBranch.get(branch.index);
        if (execution.status === "completed" && (!priorDone || (execution.ordinal ?? 0) >= (priorDone.ordinal ?? 0))) doneByBranch.set(branch.index, execution);
    }
    if (!byBranch.size) return null;
    const choices = [...byBranch].sort((a, b) => a[0] - b[0]).map(([index, execution]) => {
        const done = doneByBranch.get(index) ?? null;
        return {
            // `ended`: the branch's latest ended visit of the step, the result its Output shows (R2-UI-5).
            index, execution, ended: done,
            label: `Branch ${workflowV2BranchNumber(index)} · ${execution.status === "pending" ? "running" : execution.outcome ? `ended '${execution.outcome}'` : "ended"}`,
            ...(isRecord(node) && isRecord(run) ? {
                status: visitStatus(node, execution, run),
                // A branch's end has its terminal's outcome, as the step's own Last outcome does.
                lastOutcome: done ? { outcome: (node.type === "terminal" && done.resultKind !== "runtime_error" ? node.outcome : done.outcome) ?? null,
                    resultKind: done.resultKind ?? null } : null,
            } : {}),
        };
    });
    const running = choices.find(choice => choice.execution.status === "pending");
    const ended = choices.filter(choice => choice.execution.status === "completed").at(-1);
    return { parallelExecutionId: parallelVisit.id, choices, defaultIndex: (running ?? ended ?? choices[0]).index };
}

/**
 * What a person's branch choice is kept for: the workflow session, the shown run, the parallel step's visit and the
 * step. Another workflow, run or visit of the parallel step starts again from the default branch. Pure.
 */
export function workflowV2BranchPickKey(sessionId, runId, node) {
    return JSON.stringify([sessionId ?? null, runId ?? null, node?.branches?.parallelExecutionId ?? null, node?.id ?? null]);
}

/** The choice a branch picker shows: the one for `index` when the step has it, else the default. Null without choices. Pure. */
export function workflowV2BranchChoice(branches, index = null) {
    if (!isRecord(branches) || !Array.isArray(branches.choices) || !branches.choices.length) return null;
    return branches.choices.find(choice => choice.index === index) ?? branches.choices.find(choice => choice.index === branches.defaultIndex) ?? branches.choices[0];
}

/**
 * One line, its whitespace collapsed, cut to `max` characters with "…" (the activity list, the reasons and results it
 * shows, and the question to the parent agent). Pure.
 */
export function workflowV2Clipped(value, max = 200) {
    const one = String(value ?? "").replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ── Activity, why a run or a step ended, and the sessions under a step (owner decision q14; mocks M09, M14) ──────────

const ACTIVITY_LIMIT = 50;
const clipped = workflowV2Clipped;
const parsedJson = value => {
    if (isRecord(value)) return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return isRecord(parsed) ? parsed : null; } catch { return null; }
};

/** Who acted, from an event's actor record, in plain words; null when the event names nobody. Pure. */
export function workflowV2ActorText(actor) {
    if (!isRecord(actor)) return null;
    if (actor.kind === "user") return text(actor.displayName) ?? text(actor.email) ?? text(actor.subject) ?? "a person";
    if (actor.kind === "agent") return text(actor.sessionId) ? `agent session ${shortId(actor.sessionId)}` : "an agent";
    if (actor.kind === "system") return text(actor.name) ?? "the system";
    return null;
}

/**
 * An event's or a deadline's time as people read it (owner decision local-time-20261104): "YYYY-MM-DD HH:MM:SS <zone>"
 * in the reader's own time zone, the browser's (the terminal machine's in the TUI), with the zone's short name
 * (formatLocalTime); null for no time. `timeZone` (an IANA name) fixes the zone, for tests. Stored data stays ISO UTC.
 */
export function workflowV2EventTime(value, timeZone = undefined) {
    return formatLocalTime(value, { timeZone });
}

/** A time the read model or an event gives as ISO text, as people read it (workflowV2EventTime); the text as is when it is no time. */
const shownTime = value => workflowV2EventTime(value) ?? value;

const names = value => {
    const keys = Array.isArray(value) ? value.filter(key => typeof key === "string" && key) : [];
    return keys.length > 5 ? `${keys.slice(0, 5).join(", ")} and ${keys.length - 5} more` : keys.join(", ");
};
const because = value => (text(value) ? `: ${clipped(value)}` : "");
/** A skipped run-end notice after an attempt that may have queued it (D-R1). */
const EARLIER_ATTEMPT = " An earlier attempt may have told the parent.";

/**
 * "; 1 step was still running when the time to finish ended, so it was cancelled" for a stop whose time to finish
 * ended with steps still running (`graceExpired`, `cancelledCount`); "" otherwise. The activity line and why the run
 * ended say it the same way.
 */
function stoppedRunningText(data) {
    const count = Number.isSafeInteger(data?.cancelledCount) ? data.cancelledCount : 0;
    if (data?.graceExpired !== true || !count) return "";
    return `; ${count === 1 ? "1 step was" : `${count} steps were`} still running when the time to finish ended, so ${count === 1 ? "it was" : "they were"} cancelled`;
}

// The log's long forms are Markdown: a value an event carries is one inline code span, so it cannot become markup.
const filled = value => typeof value === "string" && value.trim() !== "";
const span = (value, max = 120) => {
    const one = String(value ?? "").replace(/\s+/g, " ").trim();
    return `\`${(one.length > max ? `${one.slice(0, max - 1)}…` : one).replace(/`/g, "'")}\``;
};
const spanKeys = value => {
    const keys = Array.isArray(value) ? value.filter(key => typeof key === "string" && key !== "") : [];
    const shown = keys.slice(0, 5).map(key => span(key, 40)).join(", ");
    return keys.length > 5 ? `${shown} and ${keys.length - 5} more` : shown;
};
const NOBODY_NAMED = new Set(["a person", "an agent", "the system"]);
const byWho = actor => {
    const who = workflowV2ActorText(actor);
    return who ? ` by ${NOBODY_NAMED.has(who) ? who : span(who, 60)}` : "";
};
const stepOf = data => (text(data.stateId) ? `step '${data.stateId}'` : "a step");
const StepOf = data => `${stepOf(data)[0].toUpperCase()}${stepOf(data).slice(1)}`;

/**
 * One sentence table for the workflow's events (ui-05). `short` is the event's line in the activity list
 * ({ text, level }); `long` is its line in the session's step log ({ text, summary, color }, Markdown) for the run's
 * control events. An event without a form is not shown on that screen. Add an event once, here. The log's step, start
 * and end lines, which also write version 1 runs and the definition table, stay in workflow-sessions.js.
 */
const WORKFLOW_EVENT_TEXT = {
    "workflow.started": { short: data => ({ text: `${data.mode === "test" ? "Test run" : "Run"} started${Number.isSafeInteger(data.revision) ? ` (revision ${data.revision})` : ""}` }) },
    "workflow.paused": {
        short: data => ({ text: `Paused${because(data.reason)}`, level: "warning" }),
        long: data => ({ text: `⏸ Workflow paused${byWho(data.actor)}${filled(data.reason) ? `: ${span(data.reason, 200)}` : "."}`, summary: "paused", color: "yellow" }),
    },
    "workflow.resumed": {
        short: data => ({ text: `Resumed${because(data.reason)}` }),
        long: data => ({ text: `▶ Workflow resumed${byWho(data.actor)}${filled(data.reason) ? `: ${span(data.reason, 200)}` : "."}`, summary: "resumed", color: "gray" }),
    },
    "workflow.vars_set": {
        short: data => {
            const parts = [names(data.set) ? `set ${names(data.set)}` : "", names(data.deleted) ? `removed ${names(data.deleted)}` : ""].filter(Boolean);
            return { text: `Variables changed${parts.length ? `: ${parts.join("; ")}` : ""}` };
        },
        long: data => {
            const set = spanKeys(data.set), removed = spanKeys(data.deleted);
            const parts = [set ? `set ${set}` : "", removed ? `removed ${removed}` : ""].filter(Boolean);
            const revision = Number.isSafeInteger(data.kvRevision) ? ` (revision ${data.kvRevision})` : "";
            return { text: `✎ Workflow variables updated${byWho(data.actor)}${revision}${parts.length ? `: ${parts.join("; ")}` : ""}.`, summary: "variables updated", color: "gray" };
        },
    },
    "workflow.stop_requested": {
        short: data => ({ text: `Stop asked; steps already started may finish${text(data.deadlineAt) ? ` until ${shownTime(data.deadlineAt)}` : ""}${because(data.reason)}`, level: "warning" }),
        // The step log's line (adversarial review R2-UI-6).
        long: data => ({ text: `⏹ Stop asked${byWho(data.actor)}: steps already started may finish${text(data.deadlineAt) ? ` until ${span(shownTime(data.deadlineAt), 40)}` : ""}`
            + `${filled(data.reason) ? `. Reason: ${span(data.reason, 200)}` : "."}`, summary: "stop asked", color: "yellow" }),
    },
    "workflow.stopped": {
        short: data => ({ text: `Run stopped${because(data.reason)}${stoppedRunningText(data)}`, level: "warning" }),
        long: data => ({ text: `⏹ Workflow stopped${filled(data.reason) ? `: ${span(data.reason, 200)}` : ""}${stoppedRunningText(data)}.`,
            summary: "stopped", color: "yellow" }),
    },
    "workflow.cancel_requested": {
        short: data => {
            const count = Array.isArray(data.effects) ? data.effects.length : 0;
            return { text: `Asked ${count === 1 ? "1 running action" : `${count} running actions`} to stop`, level: "warning" };
        },
        long: data => {
            const count = Array.isArray(data.effects) ? data.effects.length : 0;
            return { text: `⏹ Asked ${count} running action${count === 1 ? "" : "s"} to stop. They may take a moment to end.`,
                summary: `${count} action${count === 1 ? "" : "s"} asked to stop`, color: "yellow" };
        },
    },
    "workflow.cancelled": {
        short: data => ({ text: `Run cancelled${data.deleted === true || data.command === "delete" ? " (the workflow was deleted)" : ""}${because(data.reason)}`, level: "warning" }),
    },
    "workflow.completed": { short: data => ({ text: `Run ended${text(data.outcome) ? ` ${data.outcome}` : ""}${text(data.stateId) ? ` at '${data.stateId}'` : ""}` }) },
    "workflow.failed": { short: data => ({ text: `Run failed${text(data.stateId) ? ` at '${data.stateId}'` : ""}${because(data.error)}`, level: "error" }) },
    "workflow.input_accepted": {
        short: data => ({ text: `Input${text(data.contract) ? ` ${data.contract}` : ""} accepted${text(data.senderSessionId) ? ` from session ${shortId(data.senderSessionId)}` : ""}` }),
        long: data => {
            const from = filled(data.senderSessionId) ? ` from ${span(String(data.senderSessionId).slice(0, 8), 20)}` : "";
            const contract = filled(data.contract) ? ` ${span(data.contract, 80)}` : "";
            const claimed = filled(data.claimedBy);
            return { text: `✉ Input${contract}${from} accepted by the workflow; ${claimed ? "a waiting receive step took it" : "it waits for a receive step"}.`,
                summary: claimed ? "input accepted and taken" : "input accepted", color: "gray" };
        },
    },
    "workflow.recovered": {
        short: data => ({ text: `Restart asked${text(data.requestedBy) ? ` by session ${shortId(data.requestedBy)}` : ""}`, level: "warning" }),
        long: data => {
            const action = filled(data.action) ? data.action : null;
            // The event and its receipt are stored before the controller is started (service.ts), so it records a request, not a start.
            const what = action === "dispatched" ? "a restart of the run was recorded; this does not show that it has started"
                : action ? `action ${span(action, 60)} recorded` : "recovery recorded";
            const by = filled(data.requestedBy) ? ` by ${span(String(data.requestedBy).slice(0, 8), 20)}` : "";
            return { text: `↻ Recovery requested${by}: ${what}.`, summary: "recovery requested", color: "yellow" };
        },
    },
    "workflow.parent_notified": {
        long: data => ({ text: `✉ The parent session was told that the run ended${filled(data.parentSessionId) ? ` (${span(String(data.parentSessionId).slice(0, 8), 20)})` : ""}.`,
            summary: "parent told the run ended", color: "gray" }),
    },
    "workflow.parent_notification_skipped": {
        // Batch 7 (n-2): a live run's end the parent agent was not told of, and why ("notifications are off", "parent is gone").
        // After an earlier attempt that may have queued the notice (D-R1, earlierAttempt), it says so.
        short: data => ({ text: `The parent agent was not told${because(data.reason)}.${data.earlierAttempt === true ? EARLIER_ATTEMPT : ""}`, level: "warning" }),
        long: data => {
            const reason = filled(data.reason) ? `: ${span(data.reason, 200)}` : "";
            const earlier = data.earlierAttempt === true ? `${reason ? "." : ""}${EARLIER_ATTEMPT}` : "";
            return { text: `✉ The parent session was not told that the run ended${reason || "."}${earlier}`, summary: "parent not told", color: "yellow" };
        },
    },
    "workflow.state_started": { short: data => ({ text: `${StepOf(data)} started${Number.isSafeInteger(data.ordinal) ? ` (visit ${data.ordinal})` : ""}` }) },
    "workflow.state_completed": { short: data => ({ text: `${StepOf(data)} ended${text(data.outcome) ? ` '${data.outcome}'` : ""}` }) },
    "workflow.state_failed": {
        short: data => {
            const error = parsedJson(data.error);
            // With no error text, what happened to its action, as the step log says it.
            const reason = error?.message ?? (error ? null : data.error) ?? (text(data.effectStatus) ? `the action ${data.effectStatus}` : null);
            return { text: `${StepOf(data)} failed${text(data.outcome) ? ` (${data.outcome})` : ""}${because(reason)}`, level: "error" };
        },
    },
    "workflow.state_cancelled": { short: data => ({ text: `${StepOf(data)} stopped`, level: "warning" }) },
    "workflow.agent_spawned": {
        short: data => ({ text: `Agent chat for ${stepOf(data)} created${text(data.childSessionId) ? ` (session ${shortId(data.childSessionId)})` : ""}`
            + `${text(data.deadline) ? `; its time limit is ${shownTime(data.deadline)}` : ""}` }),
    },
    "workflow.agent_ended": {
        short: data => ({ text: `Agent chat for ${stepOf(data)} ended${workflowV2AgentEndText(data.end) ? ` (${workflowV2AgentEndText(data.end)})` : ""}` }),
    },
    "workflow.agent_end_failed": { short: data => ({ text: `Ending the agent chat for ${stepOf(data)} did not succeed yet; it is tried again`, level: "warning" }) },
    // Owner decision Q2: the agent chat ended its turn without finishing its step, and was reminded to finish it.
    "workflow.agent_reminded": {
        short: data => ({ text: `${StepOf(data)} reminded to finish`
            + `${Number.isSafeInteger(data.n) && Number.isSafeInteger(data.max) ? ` (${data.n} of ${data.max})` : ""}` }),
    },
    "workflow.request_delivered": {
        short: data => ({ text: `Request${text(data.contract) ? ` ${data.contract}` : ""} sent${text(data.responderSessionId) ? ` to session ${shortId(data.responderSessionId)}` : ""}`
            + `${text(data.deadlineAt) ? `; answer due by ${shownTime(data.deadlineAt)}` : ""}` }),
    },
    "workflow.response_wake_abandoned": {
        short: () => ({ text: "An answer arrived, but waking the run was not confirmed; the run collects the answer later", level: "warning" }),
    },
    "workflow.branches_cancelled": {
        // IR 9: why, when it is not failFast: the join had its successes, or the parallel step's own time limit passed.
        short: data => ({ text: data.reason === "join" ? "The other branches were cancelled: the join had the successes it needs"
            : data.reason === "timeout" ? "The running branches were cancelled: the parallel step's time limit passed"
                : "The other branches were cancelled", level: "warning" }),
    },
    "workflow.test_intercepted": {
        short: data => ({ text: `Call${text(data.operation) ? ` ${data.operation}` : ""}${text(data.tool) ? ` · ${data.tool}` : ""}${text(data.stateId) ? ` in ${stepOf(data)}` : ""}` }),
    },
    "workflow.test_clock_advanced": { short: data => ({ text: `Test clock advanced${Number.isSafeInteger(data.seconds) ? ` by ${formatSeconds(data.seconds)}` : ""}` }) },
};

/**
 * One workflow event in one of the table's forms: "short" for the activity list ({ text, level }), "long" for the step
 * log ({ text, summary, color }); null when the event has no such form, so that screen does not show it. Never throws
 * for a malformed record. Pure.
 */
export function workflowEventText(type, data, form = "short") {
    const row = typeof type === "string" && Object.hasOwn(WORKFLOW_EVENT_TEXT, type) ? WORKFLOW_EVENT_TEXT[type] : null;
    const write = row && (form === "short" || form === "long") ? row[form] : null;
    return write ? write(isRecord(data) ? data : {}) : null;
}

/**
 * Who did what and when in a workflow (owner decision q14; mock M09 "Inspect audit"): the workflow session's own events,
 * newest first, as plain lines { seq, at, what, who, level }, for one run (`runId`) and, when given, one visit of a step
 * (`nodeExecutionId`); at most `limit`. Only what the events record is shown: who acted is named where the event names
 * them (a pause, a resume, a variables change, a stop). Pure.
 */
export function workflowV2Activity(events, { runId = null, nodeExecutionId = null, limit = ACTIVITY_LIMIT } = {}) {
    const rows = [];
    for (const event of Array.isArray(events) ? events : []) {
        if (!isRecord(event) || typeof event.eventType !== "string") continue;
        const data = isRecord(event.data) ? event.data : {};
        if (runId !== null && data.runId !== runId) continue;
        if (nodeExecutionId !== null && data.nodeExecutionId !== nodeExecutionId) continue;
        const line = workflowEventText(event.eventType, data, "short");
        if (!line) continue;
        rows.push({ seq: Number.isSafeInteger(event.seq) ? event.seq : null, at: workflowV2EventTime(event.createdAt), what: line.text,
            who: workflowV2ActorText(data.actor), level: line.level ?? "info" });
    }
    return rows.reverse().slice(0, Math.max(0, limit));
}

const ENDED_STATUSES = new Set(["completed", "failed", "cancelled", "stopped"]);

/**
 * Why a run ended (owner decision q14; mock M14 "Inspect cancellation"): from the run as the read shows it and its end
 * events: completed at its last step; failed at a step or by a runtime error (its message); cancelled, with the reason
 * and who asked when the record names them, or because the workflow was deleted; stopped, with the reason, who asked
 * and what was still running when the time to finish ended. { status, why, who, at, text }, or null while it runs. Pure.
 */
export function workflowV2RunEnding(run, events = []) {
    if (!isRecord(run) || !ENDED_STATUSES.has(run.status)) return null;
    const mine = (Array.isArray(events) ? events : []).filter(event => isRecord(event) && isRecord(event.data) && event.data.runId === run.runId);
    const last = type => mine.findLast(event => event.eventType === type) ?? null;
    const envelope = parsedJson(run.error);
    const details = isRecord(envelope?.details) ? envelope.details : {};
    let why, who = null, end = null;
    if (run.status === "completed") {
        end = last("workflow.completed");
        why = `It reached '${run.terminalState ?? "its last step"}'${text(run.outcome) ? ` (${run.outcome})` : ""}`;
    } else if (run.status === "failed") {
        end = last("workflow.failed");
        why = text(run.terminalState) ? `It reached '${run.terminalState}' (${run.outcome ?? "failed"})`
            : `A runtime error${text(envelope?.code) ? ` (${envelope.code})` : ""}${because(envelope?.message)}`;
    } else if (run.status === "cancelled") {
        end = last("workflow.cancelled");
        const deleted = end?.data.deleted === true || end?.data.command === "delete" || details.command === "delete";
        why = `${deleted ? "The workflow was deleted" : "It was cancelled"}${because(end?.data.reason ?? envelope?.message)}`;
        who = text(details.requestedBy) ? `session ${shortId(details.requestedBy)}` : null;
    } else {
        end = last("workflow.stopped");
        const asked = last("workflow.stop_requested");
        why = `It was stopped${because(end?.data.reason ?? asked?.data.reason ?? run.stop?.reason)}${stoppedRunningText(end?.data)}`;
        who = workflowV2ActorText(asked?.data.actor);
    }
    const at = workflowV2EventTime(end?.createdAt);
    return { status: run.status, why, who, at, text: `Why it ended: ${why}.${who ? ` Asked by ${who}.` : ""}${at ? ` (${at})` : ""}` };
}

/** How a branch cancelled by a branch-cancelling decision stands, by its step's winner (owner decision join-k-of-n). */
const BRANCH_CANCELS = { join_timeout: "cancelled at time limit", join: "cancelled after the join", fail_fast: "cancelled" };
/**
 * A branch whose last step finished but whose next step never started (J1b "finished"; its result is kept): how it
 * stands and why, by what came first: the time limit, the join, the join's block (failFast), or the run's own end ("").
 */
const FINISHED_BEFORE = {
    join_timeout: { status: "finished before the time limit", why: "the time limit passed before its next step started" },
    join: { status: "finished before the join", why: "the join already had the successes it needs, so its next step did not start" },
    fail_fast: { status: "finished before the join was blocked", why: "the join was blocked, so its next step did not start" },
    "": { status: "finished before the run ended", why: "the run ended before its next step started" },
};

/**
 * A branch's last step among its loaded visits (review J1-R1): the one no other names as the step before it
 * (`predecessorId`, which read_workflow gives a branch's steps); without that, the latest in the order the read lists
 * them. Pure.
 */
function branchLast(list) {
    const named = new Set(list.flatMap(item => typeof item.predecessorId === "string" ? [item.predecessorId] : []));
    const ends = list.filter(item => !named.has(item.id));
    return ends.length === 1 ? ends[0] : list[list.length - 1];
}

/**
 * Whether a parallel step's visit ended after its own time limit passed (owner decision join-k-of-n, J1b): a branch of
 * it was cancelled at the time limit, or it was decided at or after its deadline. Pure.
 */
function timeLimitPassed(parallel, executions) {
    if (!isRecord(parallel) || parallel.status !== "completed") return false;
    if (executions.some(execution => execution.winner === "join_timeout")) return true;
    const deadline = typeof parallel.deadline === "string" ? Date.parse(parallel.deadline) : NaN;
    const completed = typeof parallel.completedAt === "string" ? Date.parse(parallel.completedAt) : NaN;
    return Number.isFinite(deadline) && Number.isFinite(completed) && completed >= deadline;
}

const VISIT_WINNERS = {
    cancel: "The run was cancelled while it ran",
    stop: "The run was stopped, and this step was still running when the time to finish ended",
    deadline: "The run's time limit passed",
    fail_fast: "Another branch failed, so this one was cancelled",
    // Owner decision join-k-of-n (IR 9): a join of the first k that had its successes, and a parallel step's own time limit.
    join: "The join already had the successes it needs, so this branch was cancelled",
    join_timeout: "The parallel step's time limit passed, so this branch was cancelled",
};

/**
 * Why one visit of a step ended (owner decision q14; mock M14): its time limit, the run's cancellation, stop or time
 * limit, another branch's failure, its outcome, or a runtime error with its message; for an agent step, how its chat was
 * ended. { why, detail, agent, text }, or null for a visit that has not ended. Pure.
 */
export function workflowV2VisitEnding(execution) {
    if (!isRecord(execution) || execution.status !== "completed") return null;
    const error = parsedJson(execution.errorPreview);
    let why;
    const byWinner = execution.outcome !== "timed_out" && Boolean(VISIT_WINNERS[execution.winner]);
    if (execution.outcome === "timed_out") why = "Its time limit passed";
    else if (byWinner) why = VISIT_WINNERS[execution.winner];
    else if (execution.resultKind === "business") why = `It ended '${execution.outcome}'`;
    else if (execution.resultKind === "runtime_error") why = `A runtime error (${execution.outcome ?? text(error?.code) ?? "not recorded"})`;
    else why = "How it ended was not recorded";
    const detail = !byWinner && execution.resultKind === "runtime_error" && text(error?.message) ? clipped(error.message) : null;
    const end = isRecord(execution.agent) ? workflowV2AgentEndText(execution.agent.end) : null;
    const agent = end ? `Its agent chat ended (${end}).` : null;
    return { why, detail, agent, text: `${why}.${detail ? ` ${detail}` : ""}${agent ? ` ${agent}` : ""}` };
}

/** How an agent step's chat ended, in the words every screen uses: "cancelled" or "its result was taken"; null for none. Pure. */
export function workflowV2AgentEndText(end) {
    return end === "cancel" ? "cancelled" : end === "done" ? "its result was taken" : null;
}

/**
 * The sessions under a step (owner decision q14; mock M14 "View owned subtree"): its agent chat (`rootId`) and every
 * session started under it, from the session rows loaded (`byId`), each with its title, status and depth (the chat 0),
 * in tree order; at most `limit`. Sessions not loaded here are not shown. Pure.
 */
export function workflowV2SessionSubtree(byId, rootId, limit = 50) {
    if (!isRecord(byId) || typeof rootId !== "string" || !rootId) return [];
    const children = new Map();
    for (const row of Object.values(byId)) {
        if (!isRecord(row) || typeof row.sessionId !== "string" || typeof row.parentSessionId !== "string") continue;
        if (!children.has(row.parentSessionId)) children.set(row.parentSessionId, []);
        children.get(row.parentSessionId).push(row.sessionId);
    }
    const out = [];
    const seen = new Set();
    const visit = (sessionId, depth) => {
        if (seen.has(sessionId) || out.length >= limit) return;
        seen.add(sessionId);
        const row = isRecord(byId[sessionId]) ? byId[sessionId] : null;
        out.push({ sessionId, title: text(row?.title) ?? null, status: text(row?.status) ?? "not loaded", depth });
        for (const child of children.get(sessionId) ?? []) visit(child, depth + 1);
    };
    visit(rootId, 0);
    return out;
}

// ── Evidence of a parallel step's branches, and asking the parent agent about a step (owner decision q16; M22 to M24) ──

/**
 * Each branch of one visit of a parallel step (owner decision q16; mocks M22 "JOIN BLOCKED k / n", M23 "Inspect
 * conflict", M24 "Inspect evidence"): by branch, how it stands, its last step, its outcome, a short result and, for a
 * branch that did not succeed, why; owner batch 7 (H2): its current step's deadline and, when that step is an agent
 * step, its agent chat (`agent`, the chat's session id). Owner decision join-k-of-n: how it stands is running, queued,
 * succeeded, succeeded after the time limit (J1b: it did not count), failed (it ended without success), cancelled at
 * time limit (the parallel step's own time limit), cancelled after the join (a join of the first k had its successes),
 * cancelled (another branch failed under failFast), finished before the time limit, before the join, before the join
 * was blocked or before the run ended (J1b "finished": its last step finished and its result is kept, but its next step
 * never started; one whose next step is a succeeded end, saved by the time limit, counts as a success), not started,
 * or not in the loaded history. A branch's last step is the end of its chain of steps (review J1-R1). From the executions loaded (`complete`: whether every one is): a branch with none may only be outside the
 * loaded history. A blocked join names the branches that block it; `needed` is how many successes the join needs
 * (`node`, the parallel step, says its join; every branch without it); `timedOut` says the time limit ended it
 * (timed_out, or blocked by then), and `joinedAfterLimit` that it joined after its time limit passed. { total, needed,
 * succeeded, running, queued, blocked, timedOut, joinedAfterLimit, blocking, rows }, or null when the visit names no
 * branch count.
 * `index` and `blocking` count from 0 (the data's); people read them through workflowV2BranchNumber. Pure.
 */
export function workflowV2BranchEvidence(executions, states, parallel, complete = true, node = null) {
    if (!isRecord(parallel) || !Number.isSafeInteger(parallel.branches) || parallel.branches < 0) return null;
    const byId = new Map((Array.isArray(states) ? states : []).filter(isRecord).map(state => [state.id, state]));
    const groups = new Map();
    for (const execution of Array.isArray(executions) ? executions : []) {
        const branch = execution?.branch;
        if (!isRecord(branch) || branch.parallelNodeExecutionId !== parallel.id || !Number.isSafeInteger(branch.index)) continue;
        if (!groups.has(branch.index)) groups.set(branch.index, []);
        groups.get(branch.index).push(execution);
    }
    const rows = [];
    // The branches whose success counts: succeeded ones, and (J1b) finished ones whose next step is a succeeded end.
    const counted = new Set();
    const visited = [...groups.values()].flat();
    const limitPassed = timeLimitPassed(parallel, visited);
    const deadlineMs = typeof parallel.deadline === "string" ? Date.parse(parallel.deadline) : NaN;
    // What cut a branch between two of its steps: the parallel step's time limit (after it no branch starts a new step,
    // J1b), its join, or failFast's block; else the run's own end.
    const cutWinner = parallel.status !== "completed" ? null
        : parallel.outcome === "timed_out" || (limitPassed && (parallel.outcome === "joined"
            || (parallel.outcome === "blocked" && !visited.some(execution => execution.winner === "fail_fast")))) ? "join_timeout"
            : parallel.outcome === "joined" ? "join" : parallel.outcome === "blocked" ? "fail_fast" : "";
    for (let index = 0; index < parallel.branches; index += 1) {
        const list = (groups.get(index) ?? []).slice().sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
        if (!list.length) {
            rows.push({ index, status: !complete ? "not in the loaded history" : parallel.status === "pending" ? "queued" : "not started",
                step: null, outcome: null, result: null, why: null, deadline: null, agent: null });
            continue;
        }
        const pending = list.find(item => item.status === "pending") ?? null;
        const last = pending ?? branchLast(list);
        const state = byId.get(last.stateId);
        const terminal = state?.type === "terminal";
        const succeeded = !pending && terminal && state.outcome === "succeeded";
        const error = parsedJson(last.errorPreview);
        // A step whose result takes one of its routes: its branch went on (between two of its steps), or was cut there.
        const route = !pending && !terminal && typeof last.outcome === "string" && isRecord(state?.next)
            ? (Object.hasOwn(state.next, last.outcome) ? last.outcome : last.resultKind === "runtime_error" && Object.hasOwn(state.next, "failure") ? "failure" : null)
            : null;
        const routed = route !== null;
        const cancelledBy = typeof last.winner === "string" && Object.hasOwn(BRANCH_CANCELS, last.winner) ? BRANCH_CANCELS[last.winner] : null;
        // Finished (J1b): its last step finished and its result is kept, but its next step never started: the time limit,
        // the join or its block came first, or the run's own end.
        const cut = cancelledBy === null && routed && parallel.status === "completed" ? cutWinner ?? "" : null;
        // A success is saved when the work before its end finished: its last step, or the step before its terminal.
        const work = terminal ? list.find(item => item.id === last.predecessorId) ?? list.filter(item => byId.get(item.stateId)?.type !== "terminal").at(-1) : last;
        const inTime = !Number.isFinite(deadlineMs) || typeof work?.completedAt !== "string" || Date.parse(work.completedAt) <= deadlineMs;
        // A success saved after the time limit did not count toward a join that did not happen.
        const late = succeeded && parallel.status === "completed" && parallel.outcome !== "joined" && !inTime;
        // A finished step whose route leads to a succeeded end, saved by the time limit, counts as a success (J1b).
        const next = route !== null ? byId.get(state.next[route]) : null;
        const finishedSuccess = cut !== null && next?.type === "terminal" && next.outcome === "succeeded" && inTime;
        const status = pending || (routed && parallel.status === "pending") ? "running"
            : late ? "succeeded after the time limit" : succeeded ? "succeeded"
                : cancelledBy ?? (cut === null ? "failed" : FINISHED_BEFORE[cut].status);
        if (status === "succeeded" || finishedSuccess) counted.add(index);
        const why = status === "running" || status === "succeeded" ? null
            : late ? "It succeeded after the time limit, so it did not count"
                : terminal ? `It ended at '${last.stateId}' (${state.outcome})`
                    : cut !== null ? `Its step '${last.stateId}' finished ('${last.outcome}'), but ${FINISHED_BEFORE[cut].why}`
                        + `${finishedSuccess ? "; its success counts" : ""}`
                        : VISIT_WINNERS[last.winner] ?? (last.resultKind === "runtime_error"
                            ? `A runtime error (${last.outcome ?? text(error?.code) ?? "not recorded"})${because(error?.message)}`
                            : `It stopped at step '${last.stateId}'`);
        const preview = typeof last.outputPreview === "string" && last.outputPreview && last.outputPreview !== "null" ? clipped(last.outputPreview, 160) : null;
        rows.push({ index, status, step: last.stateId, outcome: last.outcome ?? null,
            result: preview, why, deadline: pending && typeof pending.deadline === "string" && pending.deadline ? pending.deadline : null,
            // Its agent chat, once created (as the step's Agent session opens it).
            agent: isRecord(last.agent) && last.agent.spawned === true && typeof last.agent.childSessionId === "string" && last.agent.childSessionId
                ? last.agent.childSessionId : null });
    }
    const blocked = parallel.status === "completed" && parallel.outcome === "blocked";
    const count = status => rows.filter(row => row.status === status).length;
    const first = workflowV2JoinFirst(node);
    return {
        total: parallel.branches, needed: first ?? parallel.branches, succeeded: counted.size, running: count("running"), queued: count("queued"),
        // The time limit ended it: timed_out, or blocked once k could no longer happen by then (J1b, Q3).
        blocked, timedOut: parallel.status === "completed" && (parallel.outcome === "timed_out" || (blocked && limitPassed)),
        // It joined after its time limit passed: the successes saved before it still joined (J1b, Q1).
        joinedAfterLimit: parallel.status === "completed" && parallel.outcome === "joined" && limitPassed,
        blocking: blocked ? rows.filter(row => !counted.has(row.index)).map(row => row.index) : [], rows,
    };
}
