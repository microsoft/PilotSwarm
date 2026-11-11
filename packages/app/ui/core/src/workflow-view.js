/**
 * Read-only projection of Workflow data for the workflow graph and node
 * details. It reads two sources and never calls anything:
 *
 *  - durable session events (`workflow.started`, `workflow.state_*`, ...), whose
 *    shapes are written in packages/sdk/src/workflow/runtime.ts and store.ts;
 *  - an optional read model, the object `readWorkflowView` returns
 *    (packages/sdk/src/workflow/tools.ts). The caller supplies it; this module
 *    has no endpoint of its own.
 *
 * A payload that does not have this shape is refused with a reason. Canvas
 * ticks are not read at all: a Workflow does not draw a workflow canvas.
 */
import { formatLocalTime } from "./formatting.js";
import { WORKFLOW_RUN_STATE_WORDS, workflowAgentModel, workflowSpawnedModels, workflowErrorRouteWords, workflowAskAnswerWords, workflowReasonShown,
    workflowDuration, workflowFailureDetail, workflowNodeCardWords, workflowOutcomeWord, workflowRunStateWord, workflowShortTime, workflowTimeTitle, workflowVisitBadge,
} from "./workflow-words.js";

// Agent and parallel states and stopped runs are read here as every other state and status is.
const STATE_TYPES = new Set(["script", "wait", "messaging", "agent", "parallel", "terminal"]);
const MESSAGING_MODES = new Set(["receive", "send", "request"]);
const TERMINAL_OUTCOMES = new Set(["succeeded", "blocked", "failed", "cancelled"]);
const RUN_STATUSES = new Set(["admitted", "running", "paused", "completed", "failed", "cancelled", "stopped"]);
const STATE_EVENTS = new Set(["workflow.state_started", "workflow.state_completed", "workflow.state_failed", "workflow.state_cancelled"]);
const END_EVENTS = { "workflow.completed": "completed", "workflow.failed": "failed", "workflow.cancelled": "cancelled", "workflow.stopped": "stopped" };

/**
 * The sections of a run that the read pages (design 04 read_workflow "Bounded history pagination"; readWorkflowView
 * run.pages): node executions, inbox, outbox and a test run's held calls.
 */
export const WORKFLOW_READ_SECTIONS = Object.freeze(["executions", "inbox", "outbox", "interceptions"]);
const ROW_KEYS = { executions: "nodeExecutionId", inbox: "messageId", outbox: "exchangeId", interceptions: "interceptionId" };

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const definedOnly = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
const text = value => typeof value === "string" && value ? value : undefined;

/** The state's kind: script, wait, receive, send, request or terminal. */
export function workflowKind(node) {
    return node?.type === "messaging" ? node.mode : node?.type;
}

function invalidState(node, why) {
    return new Error(`Node '${node.id}' is not a valid ${node.type} node: ${why}.`);
}

function checkState(node) {
    if (node.type === "terminal") {
        if (!TERMINAL_OUTCOMES.has(node.outcome)) throw invalidState(node, "its outcome is unknown");
        return;
    }
    if (!isRecord(node.next)) throw invalidState(node, "it has no next nodes");
    for (const target of Object.values(node.next)) if (typeof target !== "string") throw invalidState(node, "a next node is not a node id");
    if (!Array.isArray(node.outcomes) || node.outcomes.some(outcome => typeof outcome !== "string")) throw invalidState(node, "it lists no outcomes");
    // Stage 2.4: a clock wait has its time (`at`) instead of seconds.
    if (node.type === "wait" && typeof node.seconds !== "number" && typeof node.seconds !== "string" && !isRecord(node.at)) {
        throw invalidState(node, "it has no duration");
    }
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
 * Validate a state list (`workflow.started.states`, or `graph` of the read
 * model). The states are kept as given, so every transition is preserved.
 */
export function workflowDefinition(data, meta = {}) {
    if (!isRecord(data) || !Array.isArray(data.states) || !data.states.length) throw new Error("The Workflow Definition has no nodes.");
    const ids = new Set();
    for (const node of data.states) {
        if (!isRecord(node) || typeof node.id !== "string" || !node.id || !STATE_TYPES.has(node.type)) {
            throw new Error("The Workflow Definition contains an invalid or unsupported node.");
        }
        if (ids.has(node.id)) throw new Error(`The Workflow Definition repeats node '${node.id}'.`);
        ids.add(node.id);
        checkState(node);
    }
    const initial = data.initial || data.states[0].id;
    if (!ids.has(initial)) throw new Error("The Workflow's start node is not defined.");
    for (const node of data.states) {
        for (const target of Object.values(node.next || {})) {
            if (!ids.has(target)) throw new Error(`Node '${node.id}' leads to a node that is not defined.`);
        }
    }
    // A parallel state's named branches (the graph's `branches`) are its `namedBranches` here: on a step's view,
    // `branches` is its branch picker's choices.
    const states = data.states.map(node => (node.type === "parallel" && Array.isArray(node.branches)
        ? (({ branches, ...rest }) => ({ ...rest, namedBranches: branches.filter(isRecord).map(item => ({ name: String(item.name ?? ""),
            initial: typeof item.initial === "string" ? item.initial : null, states: Array.isArray(item.states) ? item.states.filter(id => typeof id === "string") : [] })) }))(node)
        : node));
    return {
        name: data.name ?? meta.name ?? undefined, version: data.version ?? meta.version ?? undefined, initial, states,
        ...definedOnly({ revision: data.revision ?? meta.revision, definitionHash: data.definitionHash ?? meta.definitionHash,
            irSha256: data.irSha256 ?? meta.irSha256 }),
    };
}

const INTAKE_REFUSALS = { refused_full: "queue full", refused_size: "message too large" };

/**
 * The recipient's later intake refusal of a delivered outbox message, from the optional `intakeOutcome` and
 * `intakeOutcomeAt` that readWorkflowView adds only when set. It is read beside the delivery and never changes
 * it. Both fields absent (or null) is no annotation: null. A known outcome gives `{ kind, reason, at }`. Anything
 * else (an unrecognized outcome, a time with no outcome) is `kind: "unknown"`, never shown as success or refusal.
 */
export function workflowIntakeOutcome(message) {
    const outcome = message?.intakeOutcome, at = message?.intakeOutcomeAt;
    const hasOutcome = outcome !== undefined && outcome !== null, hasAt = at !== undefined && at !== null;
    if (!hasOutcome && !hasAt) return null;
    const when = typeof at === "string" && at ? at : null;
    if (typeof outcome === "string" && Object.hasOwn(INTAKE_REFUSALS, outcome)) return { kind: outcome, reason: INTAKE_REFUSALS[outcome], at: when };
    const raw = typeof outcome === "string" && outcome ? (outcome.length > 60 ? `${outcome.slice(0, 59)}…` : outcome) : null;
    return { kind: "unknown", reason: null, raw, at: when };
}

/** Stage 2.4: a clock wait's time, short (for a node's label): "until 09:00", "until Mon 09:00", "until day 1 09:00", "until :30". */
export function workflowClockWaitShort(at) {
    if (!isRecord(at) || !Number.isInteger(at.minute)) return null;
    const pad = n => String(n).padStart(2, "0");
    if (!Number.isInteger(at.hour)) return `until :${pad(at.minute)}`;
    const time = `${pad(at.hour)}:${pad(at.minute)}`;
    if (Number.isInteger(at.dayOfWeek)) return `until ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.dayOfWeek] ?? "?"} ${time}`;
    if (Number.isInteger(at.dayOfMonth)) return `until day ${at.dayOfMonth} ${time}`;
    return `until ${time}`;
}

/** A length in seconds, in the one duration form (D-W6): "30 s", "0.5 s", "2 min 30 s", "1 h 30 min". */
export function formatSeconds(seconds) {
    if (!Number.isFinite(seconds)) return String(seconds);
    if (seconds < 60) return `${seconds} s`;
    return workflowDuration(seconds * 1000);
}

const party = value => value === null || value === undefined ? "any permitted sender" : value === "parent" ? "the parent session" : String(value);

/**
 * Stage 3 (review 19:27Z): a session as people read it, by its name (`sessionName`, a function from a session id to its
 * title, or null where none is loaded); never its id. Null when the name is not known.
 */
const sessionNamed = (sessionName, id) => {
    if (typeof sessionName !== "function" || typeof id !== "string" || !id) return null;
    const name = sessionName(id);
    return typeof name === "string" && name.trim() ? name.trim() : null;
};

/** An agent state's task as one line: the agent it names, with the package and version it names, or an inline prompt. */
export function workflowAgentTask(node) {
    return node?.invoke?.source === "agent"
        ? `${node.invoke.name}${node.invoke.package ? ` · ${node.invoke.package}${node.invoke.version ? ` ${node.invoke.version}` : ""}` : ""}`
        : "Inline prompt";
}

/** An agent state's session mode in words (owner decision agent-node-continue-20261106), the same in the portal and the TUI. */
export function workflowAgentSessionMode(node) {
    return node?.session === "continue" ? "Same each visit" : "New each visit";
}

/**
 * FU-17: an agent state's tool limit in words, the same in the portal and the TUI: "None" (workflowAgentToolsTitle says
 * what that means), the tools listed, or null for a state that sets no limit (its agent has its session's tools).
 */
export function workflowAgentTools(node) {
    if (!Array.isArray(node?.tools)) return null;
    const names = node.tools.filter(name => typeof name === "string" && name);
    return names.length ? names.join(", ") : "None";
}

/** What an agent state's "None" tools means, for its tooltip; null otherwise. */
export function workflowAgentToolsTitle(node) {
    return workflowAgentTools(node) === "None" ? "It can only finish the node." : null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A long hash by its first 12 characters and "…" (a person reads the whole one on hover or in a copy). Pure. */
export function workflowShortHash(value) {
    return `${value.slice(0, 12)}…`;
}

/**
 * What a named agent state is bound to (design 03, 04, 09; R09, R18; mock
 * M17 "Inspect package pin"): the workflow interface the state names (its
 * graph's `invoke.interface`, `<name>@<version>`), and its pin in `source`,
 * the shown run's pins (projectWorkflow): `{ by: "publication" | "test",
 * pins }` (migration 0088's publication pins, or a real-agent test run's,
 * migration 0088), or `{ by: "mocked" }` for a mocked test run, whose
 * agents do not run. A pin is the package, version, exact revision and the
 * interface's digest publication matched. Null for any other state.
 */
export function workflowAgentBinding(node, source = null) {
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
export function workflowAgentBindingRows(binding) {
    if (!binding) return [];
    const rows = [];
    if (binding.interface) rows.push(["Interface", binding.interface]);
    if (binding.mocked) rows.push(["Agent", "Mocked", "The parent or the test's answers give its result"]);
    const pin = binding.pin;
    if (pin) {
        // Review 18:45Z: hashes are not shown in a value; the exact revision and digest are the row's tooltip (its third part).
        const what = pin.package ? `${pin.package}${pin.version ? ` ${pin.version}` : ""}` : `${pin.name ?? "agent"} · deployment agent`;
        rows.push([binding.pinnedBy === "test" ? "Pinned for this test" : "Pinned", what, ...(pin.revision ? [`revision ${pin.revision}`] : [])]);
        if (pin.interface) rows.push(["Interface fingerprint", pin.interface.ref, `digest ${pin.interface.digest}`]);
        else if (binding.interface) rows.push(["Interface fingerprint", "Not pinned"]);
    }
    return rows;
}

/** How many of a parallel step's named branches run at once: "all at once", "one at a time" or "up to N at a time". */
function namedBranchPace(node) {
    const count = Array.isArray(node?.namedBranches) ? node.namedBranches.length : 0;
    return node.concurrency >= count ? "all at once" : node.concurrency === 1 ? "one at a time" : `up to ${node.concurrency} at a time`;
}

/**
 * One short line that names what the node does (Workflow Simplified, 03 and 10: its type in a word, never the Node.js
 * runtime as "node"; an Ask node is a request; For each is a parallel node).
 */
export function workflowNodeLabel(node) {
    switch (workflowKind(node)) {
        case "script": return "Script";
        case "wait": return typeof node.seconds === "number" ? `Wait · ${formatSeconds(node.seconds)}`
            : workflowClockWaitShort(node.at) ? `Wait · ${workflowClockWaitShort(node.at)}` : "Wait";
        case "receive": return `Receive · ${node.contract}`;
        case "send": return `Send · ${node.contract}`;
        case "request": return `Ask · ${node.contract}`;
        case "agent": return node.invoke?.source === "agent" ? `Agent · ${node.invoke.name}` : "Agent";
        // A parallel step with named branches says "Branches" and how many run at once.
        case "parallel": return Array.isArray(node.namedBranches) ? `Branches · ${namedBranchPace(node)}`
            : `For each · ${node.concurrency === 1 ? "one item at a time" : `up to ${node.concurrency} at a time`}`;
        // An item's end is not the Workflow's (owner batch 7, H2); a named branch's end is its branch's.
        case "terminal": return `${typeof node.parallel === "string" ? (typeof node.branchName === "string" && node.branchName ? "Branch ends" : "Item ends")
            : "End"} · ${workflowOutcomeWord(node.outcome)}`;
        default: return String(node?.type || "node");
    }
}

/**
 * A node card's words (owner, 2026-11-07T17:47Z, OF-S2-2; workflowNodeCardWords): its mark, its one key fact and its visit
 * badge, and `title`, the full sentence its tooltip and screen readers have ("summarize · Agent · Done · ok · 3 runs").
 * Pure.
 */
function workflowNodeCard(view, node, context) {
    const kind = view.kind;
    const visit = view.pending || view.current || null;
    let items = view.itemCounts ? { ok: view.itemCounts.ok, total: view.itemCounts.total } : null;
    if (!items && kind === "parallel" && visit && Number.isSafeInteger(visit.branches)) {
        const progress = context.branchProgress?.get?.(visit.id) ?? null;
        // The items that succeeded, from its branches' visits when they are loaded; all of them for a join with none loaded.
        items = { ok: progress?.succeeded ?? (view.outcome === "joined" ? visit.branches : 0), total: visit.branches };
    }
    const words = workflowNodeCardWords({
        kind, state: view.state, phase: view.phase, outcome: view.outcome, terminalOutcome: node.type === "terminal" ? node.outcome : null,
        runs: view.runs, partial: view.partial, itemsShown: Boolean(view.itemCounts),
        seconds: typeof node.seconds === "number" ? node.seconds : undefined, secondsText: typeof node.seconds === "number" ? formatSeconds(node.seconds) : undefined,
        clock: kind === "wait" ? workflowClockWaitShort(node.at) : null, deadline: view.pending?.deadline ?? null,
        contract: node.contract, agentName: node.invoke?.source === "agent" ? node.invoke.name : null, items,
    });
    const badge = words.badge ?? (view.itemCounts ? null : workflowVisitBadge(view.runs, view.partial));
    // A For each at work says how many of its items succeeded, as its card does ("Running · 1/2 items").
    if (kind === "parallel" && view.stateLabel === "Running" && /^\d+\/\d+ ok$/.test(words.fact ?? "")) view.stateLabel = `Running · ${words.fact}`;
    const title = [node.id, view.label, view.stateLabel, badge ? badge.title : null, view.model ? view.model.text : null].filter(Boolean).join(" · ");
    return { ...words, badge, title };
}

/**
 * A For each node's items, counted with nouns (Workflow Simplified W5, usability finding 1): "2 ok · 1 failed", never the
 * last item's status. `counts` is { ok, failed, canceled, running }. Pure.
 */
export function workflowItemCountsText(counts) {
    if (!isRecord(counts)) return "";
    return [["ok", "ok"], ["failed", "failed"], ["canceled", "canceled"], ["running", "running"]]
        .filter(([key]) => Number.isSafeInteger(counts[key]) && counts[key] > 0)
        .map(([key, word]) => `${counts[key]} ${word}`).join(" · ");
}

/** The item cancellations of a For each node (a join that had what it needed, its time limit, a failure that stopped the others). */
const ITEM_CANCEL_WINNERS = new Set(["join", "join_timeout", "fail_fast"]);

/** How one item's visit of a node ended, for the node's counts (W5): ok, failed, canceled or running; null without a visit. */
function itemKind(node, visit, run) {
    if (!visit) return null;
    if (visit.status === "pending") return run?.ended ? "canceled" : "running";
    if (visit.outcome === "cancelled" || ITEM_CANCEL_WINNERS.has(visit.winner)) return "canceled";
    if (visit.resultKind === "runtime_error") return "failed";
    if (node?.type === "terminal") return node.outcome === "cancelled" ? "canceled" : node.outcome === "succeeded" ? "ok" : "failed";
    return "ok";
}

/** A business outcome of the state, or a runtime-error route (failure and error codes). */
export function workflowRouteKind(node, label) {
    if (!node || node.type === "terminal") return "outcome";
    return Array.isArray(node.outcomes) && node.outcomes.includes(label) ? "outcome" : "error";
}

/**
 * Mark each laid-out edge as an outcome route, a runtime-error route, or both (labels merged onto one edge). A route
 * that leaves a parallel step's join bar (owner batch 7, H2) is its parallel step's (`owner`); a branch end's line into
 * the join bar is "join".
 */
export function annotateWorkflowEdges(definition, layout) {
    const byId = new Map(definition.states.map(node => [node.id, node]));
    for (const edge of layout.edges) {
        // A parallel state's edge to its body's first state (or into its branch box) is how each branch starts, not a route.
        if (edge.branch) { edge.kind = "branch"; continue; }
        if (edge.join) { edge.kind = "join"; continue; }
        const owner = byId.get(edge.owner ?? edge.from);
        const kinds = new Set(edge.outcomes.map(label => workflowRouteKind(owner, label)));
        edge.kind = kinds.size > 1 ? "mixed" : [...kinds][0];
        // Review 18:45Z: an edge's title and screen-reader words name its error routes in the Next words ("✕ limit"),
        // never by their raw outcome ids.
        edge.outcomeWords = edge.outcomes.map(label => (workflowRouteKind(owner, label) === "error" ? workflowErrorRouteWords(label) : label));
    }
    return layout;
}

/**
 * The notices the portal lists behind its Notices button (owner batch 5, g-03): the projection's banners about the
 * definition and the shown run, each with a level and its text. "No run yet" is left out: the run's status says it
 * (g-07). Owner batch 7 (H1): while the parent agent is still writing the latest revision (`draftInProgress`,
 * workflowDraftInProgress), that revision's errors are said calmly, as information that is not counted (`quiet`).
 * Pure.
 */
export function workflowShownNotices(banners, { draftInProgress = null } = {}) {
    if (!Array.isArray(banners)) return [];
    return banners.filter(banner => isRecord(banner) && typeof banner.text === "string" && banner.text && banner.code !== "no-run")
        .map(banner => (draftInProgress && banner.code === "invalid-revision"
            ? { level: "info", code: "draft-in-progress", quiet: true, text: `The agent is still writing this Workflow. ${banner.text}` } : banner));
}

/** How many notices the Notices button counts: every shown notice but the quiet ones (H1). Pure. */
export function workflowNoticeCount(notices) {
    return Array.isArray(notices) ? notices.filter(notice => !notice?.quiet).length : 0;
}

/**
 * The Notices button (H1; review UI7-2): `shown` whenever there is a notice, quiet ones included, or a failed read, so a
 * quiet notice stays reachable; `count`, the counted notices and the failed read; `level`, its tint, from the counted
 * ones only (a failed read is an error). A button with only quiet notices has no count and no tint. Pure.
 */
export function workflowNoticeBadge(notices, readError = false) {
    const list = Array.isArray(notices) ? notices.filter(isRecord) : [];
    const counted = list.filter(notice => !notice.quiet);
    const count = counted.length + (readError ? 1 : 0);
    return { shown: list.length > 0 || Boolean(readError), count, level: readError ? "error" : counted.length ? workflowNoticeLevel(counted) : null };
}

/** The most serious level among notices, for the Notices button's tint: "error", "warning", "info", or null for none. */
export function workflowNoticeLevel(notices) {
    const levels = new Set((Array.isArray(notices) ? notices : []).map(notice => notice?.level));
    return levels.has("error") ? "error" : levels.has("warning") ? "warning" : levels.size ? "info" : null;
}

/**
 * How many of a test run's held calls wait for an answer (the Test calls button's count): its coverage's unanswered calls
 * when the read says them, otherwise the listed calls that wait for the parent. 0 without a test. Pure.
 */
export function workflowOpenCalls(test) {
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
export function workflowOlderSections(older, runId) {
    return isRecord(older) && typeof runId === "string" && older.runId === runId && isRecord(older.sections) ? older.sections : null;
}

/**
 * Whether a section's loaded older pages (`loaded`: { items, nextCursor }) still join the read model's page of it: the
 * page has no older row, or its oldest row is among the loaded ones. When newer rows pushed the page past every loaded
 * row, they do not: what lies between was never read, so the loaded rows are not shown with the page and older history
 * starts again from the page (workflowOlderStart). Pure.
 */
function joinsPage(run, section, loaded) {
    if (!isRecord(loaded) || !Array.isArray(loaded.items)) return false;
    const pageRows = workflowRunPageRows(run, section);
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
export function workflowOlderStart(run, older = null) {
    const pages = isRecord(run?.pages) ? run.pages : null;
    const loaded = isRecord(run) ? workflowOlderSections(older, run.runId) : null;
    const sections = {};
    for (const section of WORKFLOW_READ_SECTIONS) {
        if (!isRecord(pages?.[section])) continue;
        sections[section] = joinsPage(run, section, loaded?.[section]) && isRecord(loaded?.[section])
            ? loaded[section] : { items: workflowRunPageRows(run, section), nextCursor: isRecord(pages[section].nextCursor) ? pages[section].nextCursor : null };
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
 * changed since: it is left out and counted (`staleOlder`; of node executions, `staleExecutions`), never shown as it
 * was. Pure.
 */
export function workflowRunRows(run, older = null) {
    const list = value => Array.isArray(value) ? value.filter(isRecord) : [];
    const loaded = isRecord(run) ? workflowOlderSections(older, run.runId) : null;
    const pages = isRecord(run?.pages) ? run.pages : null;
    let staleOlder = 0;
    let staleExecutions = 0;
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
            if (stillOpen && stillOpen(row) && openComplete) {
                staleOlder++;
                if (section === "executions") staleExecutions++;
                continue;
            }
            before.push(row);
        }
        return [...before, ...fresh];
    };
    const test = isRecord(run?.test) ? run.test : null;
    const nodeExecutions = merge("executions", run?.nodeExecutions, run?.openExecutions, row => row.state === "pending");
    const inbox = merge("inbox", run?.inbox, run?.openInbox, null);
    const outbox = merge("outbox", run?.outbox, run?.openOutbox, row => row.state === "pending");
    const interceptions = test ? merge("interceptions", test.interceptions, test.openInterceptions, row => row.state === "awaiting_parent") : [];
    return { nodeExecutions, inbox, outbox, interceptions, staleOlder, staleExecutions, gaps };
}

/**
 * How much of a run's history is loaded (readWorkflowView run.pages, with the older pages a person loaded for exactly
 * this run): `next` names, per section, the cursor of the next older page (the last loaded older page's while it joins
 * the read model's page, else the read model's), absent once its oldest row is loaded; `complete` says every node
 * execution of the run is loaded (no older page, and every open one listed); `openComplete` that every open row of
 * every section is listed (at most 500 each); `loading` and `error` are the last older-page read's. Pure.
 */
export function workflowRunHistory(run, older = null) {
    const pages = isRecord(run?.pages) ? run.pages : null;
    const loaded = isRecord(run) ? workflowOlderSections(older, run.runId) : null;
    const next = {};
    for (const section of WORKFLOW_READ_SECTIONS) {
        const own = isRecord(loaded?.[section]) && joinsPage(run, section, loaded[section]) && Object.hasOwn(loaded[section], "nextCursor")
            ? loaded[section].nextCursor : undefined;
        const cursor = own !== undefined ? own : pages?.[section]?.nextCursor;
        if (isRecord(cursor)) next[section] = cursor;
    }
    const mine = isRecord(older) && isRecord(run) && older.runId === run.runId;
    return {
        next,
        more: Object.keys(next).length > 0,
        complete: !next.executions && pages?.executions?.openComplete !== false,
        openComplete: WORKFLOW_READ_SECTIONS.every(section => pages?.[section]?.openComplete !== false),
        loading: mine && older.loading === true,
        error: mine && typeof older.error === "string" && older.error ? older.error : null,
    };
}

function normalizeRun(raw, older = null) {
    if (!isRecord(raw) || typeof raw.runId !== "string" || !RUN_STATUSES.has(raw.status)) return null;
    const rows = workflowRunRows(raw, older);
    return {
        runId: raw.runId, mode: raw.mode, status: raw.status, outcome: raw.outcome ?? null,
        pausedFrom: raw.pausedFrom ?? null, pauseSettled: typeof raw.pauseSettled === "boolean" ? raw.pauseSettled : null,
        // A graceful stop and a test run's evidence (notice, virtual clock, interceptions, coverage); its
        // interceptions are its page, the waiting ones the page does not hold and any older pages loaded, as one list.
        stop: isRecord(raw.stop) ? raw.stop : null, test: isRecord(raw.test) ? { ...raw.test, interceptions: rows.interceptions } : null,
        terminalState: raw.terminalState ?? null, output: raw.output ?? null, error: raw.error ?? null,
        kvRevision: raw.kvRevision, kv: raw.kv, nodeExecutions: rows.nodeExecutions, inbox: rows.inbox, outbox: rows.outbox,
        history: runHistoryOf(raw, older, rows),
        // OF-S2-7: the agent node models its start chose, by state id (absent: every agent node uses its session's), and whether the
        // stored choices cannot be read (the read says so; its nodes then fail at spawn in words).
        agentModels: isRecord(raw.agentModels) ? raw.agentModels : null,
        agentModelsUnreadable: raw.agentModelsUnreadable === true,
    };
}

/**
 * A run's history (workflowRunHistory) with what its rows left out (re-check RC-9): a node execution loaded from older
 * history that changed since and was left out (`staleOlder`) is missing until older history is read again, so the
 * run's executions are not all loaded (`complete` false), and counts made from them say they are partial instead of
 * exact (a branch that ended there would be called queued). Pure.
 */
function runHistoryOf(raw, older, rows) {
    const history = workflowRunHistory(raw, older);
    return { ...history, complete: history.complete && rows.staleExecutions === 0, staleOlder: rows.staleOlder, gaps: rows.gaps };
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
export function workflowWaitingReplies(run, now) {
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
export function workflowWaitingRepliesNotice(run, count) {
    if (!Number.isSafeInteger(count) || count < 1 || !LIVE_RUN_STATUSES.has(run?.status) || isRecord(run.stop)) return null;
    const one = count === 1;
    const head = one ? "Reply waiting: 1 reply" : `Replies waiting: ${count} replies`;
    const it = one ? "it" : "them";
    if (run.status === "paused") return `${head} arrived while the Workflow is paused. It uses ${it} once it resumes.`;
    if (run.status === "admitted") return `${head} arrived before the Workflow started. It uses ${it} when it reaches the node that takes ${it}.`;
    return `${head} ${one ? "has" : "have"} arrived and ${one ? "waits" : "wait"} for the node that takes ${it}.`;
}

/** The words a run's status gains while replies wait in it (q15): " · 1 reply waiting", or "" for none. Pure. */
export function workflowWaitingRepliesLabel(count) {
    return Number.isSafeInteger(count) && count > 0 ? ` · ${count === 1 ? "1 reply" : `${count} replies`} waiting` : "";
}

/**
 * Project the object `readWorkflowView` returns. `status` is one of ready,
 * draft, invalid (no graph can be shown), unavailable (valid but no graph),
 * invalid-graph or unrecognized. `older` is the view's olderHistory: the older
 * pages a person loaded, merged into the model's run only when they are for
 * that run (workflowRunRows). `now` (epoch milliseconds, the current time
 * unless given) decides only whether a waiting reply has expired.
 */
export function projectWorkflowReadModel(model, { older = null, now = Date.now() } = {}) {
    if (!isRecord(model) || typeof model.workflowId !== "string" || !isRecord(model.definition)
        || !isRecord(model.revision) || typeof model.revision.valid !== "boolean" || !Array.isArray(model.runs)) {
        return unrecognized("This Workflow's data has an unknown format, so it was not shown.");
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
            graph = workflowDefinition(model.graph, { name: revision.name ?? undefined, version: lifecycle.semver ?? undefined,
                revision: model.graph.revision, definitionHash: revision.definitionHash });
        } catch (error) {
            return { ...unrecognized(`The Workflow's graph is not valid: ${error.message}`), status: "invalid-graph", workflowId: model.workflowId, diagnostics };
        }
    }
    let status = "ready";
    if (lifecycle.state === "deleted") banners.push({ level: "warning", text: "This Workflow was deleted." });
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
        banners.push({ level: "warning", text: "This Workflow's revision is not listed, so node states are not shown." });
    } else if (run && graph && runRevision !== graph.revision) {
        overlay = false;
        banners.push({ level: "warning", text: `This Workflow ran revision ${runRevision}; the graph shows revision ${graph.revision}, so node states are not shown.` });
    }
    if (model.run !== null && model.run !== undefined && !run) {
        banners.push({ level: "warning", text: "This Workflow's run data has an unknown format, so it was not shown." });
    } else if (!run && model.runs.length) {
        banners.push({ level: "info", text: `No Workflow selected · ${model.runs.length === 1 ? "1 other" : `${model.runs.length} others`}` });
    } else if (!run) {
        // The portal says this once, in the run's status (batch 5, g-07); the terminal lists it among its notices.
        banners.push({ level: "info", text: "Not started yet.", code: "no-run" });
    }
    // A test run (design 05;): its notice stays visible, with the revision it tested,
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
    const replies = run ? workflowWaitingReplies(model.run, now).length : 0;
    const repliesNotice = workflowWaitingRepliesNotice(run, replies);
    const waitingReplies = repliesNotice ? replies : 0;
    if (repliesNotice) banners.push({ level: "info", text: repliesNotice });
    // How much of the run's history is loaded: the read pages a run newest first and lists its open rows apart, so its
    // current states are read however long its history is; older history is loaded on request (loadOlderWorkflowHistory).
    const history = run?.history;
    if (history?.next?.executions) {
        banners.push({ level: "info", text: "Older visits are not loaded, so counts may be incomplete." });
    }
    if (history && !history.openComplete) {
        banners.push({ level: "warning", text: "This Workflow has more open nodes, inputs, deliveries or waiting calls than one read lists (500 of each), so some are not shown." });
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
        // What publication pinned each named agent state to (migration 0088; only a definition with any has them).
        publishedAgentPins: isRecord(lifecycle.publishedAgentPins) ? lifecycle.publishedAgentPins : null,
        // The server's word that its test runs are shown (review UI-5; workflowTestRunsShown).
        ...(model.testMode === true ? { testMode: true } : {}),
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

/**
 * A branch's scope ("<the parallel visit's node execution>#<index>", as the runtime names it) as the read model's `branch`
 * ({ parallelNodeExecutionId, index }); undefined for the root or anything else. Pure.
 */
function branchOfScope(scopeId) {
    if (typeof scopeId !== "string") return undefined;
    const at = scopeId.lastIndexOf("#");
    const digits = at > 0 ? scopeId.slice(at + 1) : "";
    if (!/^\d{1,6}$/.test(digits)) return undefined;
    return { parallelNodeExecutionId: scopeId.slice(0, at), index: Number(digits) };
}

/**
 * A visit as a state event tells it. Re-check RC-3: an event that names its scope keeps it, and a branch scope gives the
 * visit its branch as a read row would, so a visit known only from live events is grouped with its own branch; a
 * completion that names none takes its start's (they are one visit: collectExecutions merges them by node execution).
 */
function executionFromEvent(type, data, at = undefined) {
    const scopeId = text(data.scopeId);
    const base = { id: data.nodeExecutionId, stateId: data.stateId, ordinal: Number.isSafeInteger(data.step) ? data.step : undefined,
        scopeId, branch: branchOfScope(scopeId) };
    if (type === "workflow.state_started") {
        return { ...base, status: "pending", catchAll: data.catchAll === true ? true : undefined, immediateOutcome: text(data.immediateOutcome),
            enteredAt: text(at) };
    }
    // R3-UI-1 (S6-UI2): an end event carries its node's completed_at (the store's completion clock), so an end known only
    // from its event is ordered as a read row is. An event from before that has none; its own time is not the end's.
    // When it ended, for the Node panel (finding 7): the store's completion clock when the event carries it, else the event's.
    const common = { ...base, status: "completed", completedAt: text(data.completedAt), endedAt: text(data.completedAt) ?? text(at),
        outcome: text(data.outcome), messageId: text(data.messageId), contract: text(data.contract),
        senderSessionId: text(data.senderSessionId), exchangeId: text(data.exchangeId), recipientSessionId: text(data.recipientSessionId),
        recipientKind: text(data.recipientKind), responderSessionId: text(data.responderSessionId), inputMessageId: text(data.inputMessageId),
        attempts: Number.isSafeInteger(data.attempts) ? data.attempts : undefined };
    if (type === "workflow.state_failed") {
        return { ...common, resultKind: "runtime_error", errorPreview: data.error, errorWords: text(data.errorWords) ?? undefined, effectStatus: text(data.effectStatus),
            catchAll: data.catchAll === true ? true : undefined };
    }
    return { ...common, resultKind: data.resultKind === "business" || data.resultKind === "runtime_error" ? data.resultKind : undefined,
        outputPreview: data.outputPreview };
}

/**
 * One node execution row of a read (read_workflow's run.nodeExecutions, or an older page's) as a visit, or null when it is
 * not one (no id or step, or a state that is neither pending nor completed). Pure.
 */
export function workflowExecutionOfRow(row) {
    if (!isRecord(row) || typeof row.nodeExecutionId !== "string" || typeof row.stateId !== "string" || (row.state !== "pending" && row.state !== "completed")) {
        return null;
    }
    return { id: row.nodeExecutionId, stateId: row.stateId, ordinal: Number.isSafeInteger(row.ordinal) ? row.ordinal : undefined,
        status: row.state, outcome: text(row.outcome), resultKind: row.resultKind ?? undefined, outputPreview: row.outputPreview,
        errorPreview: row.errorPreview, errorWords: text(row.errorWords) ?? undefined, winner: text(row.winner),
        attempts: Number.isSafeInteger(row.attempts) ? row.attempts : undefined,
        kvRevision: row.kvRevision ?? undefined, deadline: text(row.deadline), completedAt: text(row.completedAt),
        enteredAt: text(row.enteredAt), endedAt: text(row.endedAt),
        predecessorId: text(row.predecessorId),
        receive: isRecord(row.receive) ? row.receive : undefined,
        agent: isRecord(row.agent) && typeof row.agent.childSessionId === "string" ? row.agent : undefined,
        scopeId: text(row.scopeId), branch: isRecord(row.branch) ? row.branch : undefined,
        branches: Number.isSafeInteger(row.branches) ? row.branches : undefined };
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
            const execution = workflowExecutionOfRow(row);
            if (!execution) {
                ignoredRows++;
                continue;
            }
            add(execution, "read");
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
            if (data.runId === runId) add(executionFromEvent(event.eventType, data, event.createdAt), "event");
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
                ...definedOnly({ intake: workflowIntakeOutcome(message) ?? undefined }) };
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
export function workflowRunStatus({ run = null, events = [], runId = null, readModelAfterSeq = null } = {}) {
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
    const mode = run?.mode === "test" ? "Test · " : "";
    if (end) {
        // A terminal state with an outcome is the workflow's own decision. A failure without one is a runtime or controller failure.
        const business = end.stateId !== null && end.outcome !== null;
        // Review 19:27Z (D-W13, row 3): one word; a failure's why is its own line (workflowFailure), never a raw code here.
        const label = end.status === "completed" ? (end.outcome && end.outcome !== "succeeded" ? `Completed · ${workflowOutcomeWord(end.outcome)}` : "Completed")
            : end.status === "cancelled" || end.status === "stopped" ? "Canceled" : "Failed";
        // Review 18:45Z (D-W1): a stop either way reads Canceled; how it was stopped is the tooltip, and the TUI's detail line.
        const title = end.status === "stopped" ? "Canceled after started nodes finished" : end.status === "cancelled" ? "Canceled at once" : null;
        return { phase: end.status, ended: true, label: mode + label, ...(title ? { title, detail: title } : {}), businessOutcome: business ? end.outcome : null,
            error: end.error, terminalState: end.stateId };
    }
    // A read model carries no sequence number. A pause or resume event it may not have seen can contradict it, and nothing
    // here can say which is newer, so the status is reported as unverified. `readModelAfterSeq` is supplied by the caller: the
    // highest event sequence it had loaded before it fetched the read model; events up to it are older than the snapshot.
    const guarded = Number.isSafeInteger(readModelAfterSeq);
    const contradicts = control && run && (run.status === "paused") !== (control.kind === "paused")
        && !(guarded && Number.isSafeInteger(control.seq) && control.seq <= readModelAfterSeq);
    if (contradicts) {
        const modelSays = run.status === "paused" ? "paused" : run.status;
        const eventsSay = control.kind === "paused" ? "paused" : "resumed";
        // Review 19:27Z (D-W13): one word; its reason is a detail line (the TUI) and the banner.
        return { phase: "unverified", ended: false, stale: true, conflict: { readModel: modelSays, events: eventsSay },
            label: `${mode}${WORKFLOW_RUN_STATE_WORDS.notCertain}`, detail: `Not certain · its data says ${modelSays}, its latest event says ${eventsSay}` };
    }
    const status = run?.status ?? (control?.kind ?? (begun ? "running" : null));
    switch (status) {
        case "admitted": return { phase: "admitted", ended: false, label: `${mode}Running` };
        case "paused": {
            if (run?.pausedFrom === "admitted") return { phase: "paused", ended: false, label: `${mode}Paused · not started` };
            return run?.pauseSettled === false
                ? { phase: "pausing", ended: false, label: `${mode}Pausing`, detail: "Pausing · waiting for started nodes to finish" }
                : { phase: "paused", ended: false, label: `${mode}Paused` };
        }
        // Review 19:27Z (C): the time the started nodes have, in the one time form.
        case "running": return run?.stop
            ? { phase: "stopping", ended: false, label: `${mode}Canceling · started nodes ${run.stop.deadline ? `finish by ${workflowShortTime(run.stop.deadline) ?? run.stop.deadline}` : "may finish"}` }
            : { phase: "running", ended: false, label: `${mode}Running` };
        default:
            return control?.kind === "paused" ? { phase: "paused", ended: false, label: "Paused" } : { phase: "none", ended: false, label: "Not started" };
    }
}

/**
 * A node's ended run in the Workflow's words (OF-S2-2 part 2): its state in one word, then what happened ("Done ·
 * received"). A sent message says it was queued at its recipient, never that it was read (accepted vs delivered).
 */
const outcomeText = (kind, outcome, named = false) => {
    if (kind === "receive" && outcome === "elapsed") return "Done · elapsed, no message";
    if (kind === "send" && outcome === "sent") return "Done · sent, queued at recipient";
    if (kind === "parallel" && outcome === "joined") return "Done · joined, all ok";
    // A parallel step with named branches says "branch" where a For each says "item".
    if (kind === "parallel" && outcome === "blocked") return named ? "Done · blocked, a branch failed" : "Done · blocked, an item failed";
    // Review 18:45Z: an Ask's answer in its own words ("✓ answered", "✕ declined").
    if (kind === "request" && workflowAskAnswerWords(outcome)) return workflowAskAnswerWords(outcome);
    return outcome ? `Done · ${workflowOutcomeWord(outcome)}` : "Done";
};

/**
 * A node's visit at work, in the Workflow's words: "Running", "Waiting · answer", "Sending". Review 18:45Z (R9): a message
 * already queued at its recipient is "Sent · queued at recipient" (accepted, not read); "Sending" is only before that.
 */
const pendingText = (kind, execution) => {
    if (kind === "wait") return "Waiting";
    if (kind === "receive") return "Waiting · for a message";
    if (kind === "send") return execution?.outbox?.state === "delivered" ? "Sent · queued at recipient" : "Sending";
    if (kind === "request") return workflowAskAnswerWords(null, true);
    if (kind === "agent") return "Running · until its result";
    return "Running";
};

/**
 * Human lines for one execution of a state. Values that must not be read as HTML are not touched here; React renders them
 * as text. Stage 3 (review 19:27Z rows 21 to 23): a session is named by its title (`sessionName`, a function from a session
 * id to its title), never by its id; a line leaves out a session whose name is not known.
 */
export function describeWorkflowExecution(node, execution, sessionName = null) {
    const kind = workflowKind(node);
    const lines = [];
    if (!execution) return lines;
    const pending = execution.status === "pending";
    // A recipient by its name, else "the parent session" for the parent, else "its recipient".
    const recipient = id => sessionNamed(sessionName, id) ?? (node.recipient === "parent" ? "the parent session" : "its recipient");
    if (kind === "wait") {
        if (pending) lines.push(execution.deadline ? `Waiting until ${workflowShortTime(execution.deadline) ?? execution.deadline}.`
            : typeof node.until === "string" ? `Waiting until ${node.until}.`
            : `Waiting ${typeof node.seconds === "number" ? formatSeconds(node.seconds) : "for its bound duration"}.`);
        else if (execution.outcome === "elapsed") lines.push("The wait elapsed.");
    } else if (kind === "receive") {
        const wanted = execution.receive ? { contract: execution.receive.contract, from: execution.receive.from } : { contract: node.contract, from: node.from };
        if (pending) {
            lines.push(`Waiting for ${wanted.contract} from ${party(wanted.from)}.`);
            if (execution.deadline) lines.push(`If none arrives by ${workflowShortTime(execution.deadline) ?? execution.deadline}, the node continues on elapsed.`);
        } else if (execution.outcome === "received") {
            const from = sessionNamed(sessionName, execution.senderSessionId ?? execution.inbox?.senderSessionId);
            lines.push(`Received ${execution.contract || wanted.contract}${from ? ` from ${from}` : ""}.`);
        } else if (execution.outcome === "elapsed") lines.push("The wait limit passed before a matching message arrived.");
    } else if (kind === "send") {
        const to = recipient(execution.recipientSessionId || execution.outbox?.recipientSessionId);
        if (pending && execution.outbox?.state !== "delivered") lines.push(`Sending ${node.contract} to ${to}.`);
        else if (execution.resultKind === "runtime_error" || execution.outbox?.state === "failed") lines.push(`Delivery to ${to} failed.`);
        else {
            lines.push(`${node.contract} was delivered to the queue of ${to}.`);
            lines.push("This does not show that the recipient read, answered or acted on it.");
        }
    } else if (kind === "request") {
        const to = recipient(execution.outbox?.recipientSessionId);
        const answerer = sessionNamed(sessionName, execution.responderSessionId) ?? to;
        const who = answerer.charAt(0).toUpperCase() + answerer.slice(1);
        if (pending) lines.push(`Waiting for an answer to ${node.contract} from ${to}.`);
        else if (execution.outcome === "responded") lines.push(`${who} answered.`);
        else if (execution.outcome === "declined") lines.push(`${who} declined the request.`);
    } else if (kind === "agent") {
        // Its agent session (open, who may write) is shown once, beside the node: the portal's Agent session, the terminal's Agent sessions.
        if (pending) lines.push("Only the agent's result completes this node; its messages in the agent session do not.");
    } else if (kind === "parallel" && Array.isArray(node.namedBranches)) {
        // Named branches, each from its own first node.
        lines.push(`Branches: ${node.namedBranches.map(item => item.name).join(", ")}.`);
        if (pending) lines.push(`Each branch starts at its own first node · ${namedBranchPace(node)}.`);
    } else if (kind === "parallel") {
        if (Number.isSafeInteger(execution.branches)) lines.push(`${plural(execution.branches, "item")}.`);
        if (pending) lines.push(`Each item starts at ${node.body?.initial} · ${node.concurrency === 1 ? "one at a time" : `up to ${node.concurrency} at a time`}.`);
    }
    if (execution.branch && Number.isSafeInteger(execution.branch.index)) {
        const of = typeof node.parallel === "string" && node.parallel ? ` of ${node.parallel}` : "";
        lines.push(typeof node.branchName === "string" && node.branchName ? `Branch ${node.branchName}${of}.`
            : `Item ${workflowBranchNumber(execution.branch.index)}${of}.`);
    }
    if (execution.catchAll) lines.push("Entered as the catch-all node after an unhandled error.");
    return lines;
}

/**
 * One visit's state as the graph says it (`run`, the shown run's status): a pending visit while the run runs, is paused,
 * is not certain or ended first; an ended visit by its result. { state, phase, stateLabel, outcome, resultKind }; a
 * pending visit has no outcome of its own. The step's node view says its shown visit this way; a branch step's picker
 * says each branch's visit this way (review UI7-3).
 */
function visitStatus(node, execution, run) {
    const kind = workflowKind(node);
    if (execution.status === "pending") {
        if (run.ended) return { state: "cancelled", phase: "ended-early", stateLabel: "Canceled · the Workflow ended first" };
        if (run.phase === "unverified") return { state: "idle", phase: "unverified", stateLabel: "Waiting · Workflow status not certain" };
        if (run.phase === "paused") return { state: "idle", phase: "paused", stateLabel: "Paused" };
        return { state: "running", phase: kind === "script" ? "running" : "waiting", stateLabel: pendingText(kind, execution) };
    }
    const ended = { outcome: execution.outcome, resultKind: execution.resultKind };
    // A parallel step's own time limit (owner decision join-k-of-n) passed before its join.
    if (kind === "parallel" && execution.resultKind === "runtime_error" && execution.outcome === "timed_out") {
        return { ...ended, state: "failed", phase: "error", stateLabel: "Failed · limit, before the join" };
    }
    // An item canceled as intended (its For each node had what it needed) is not a failure (usability finding 1).
    if (execution.resultKind === "runtime_error" && execution.outcome === "cancelled") {
        return { ...ended, state: "cancelled", phase: "done", stateLabel: "Canceled" };
    }
    if (execution.resultKind === "runtime_error") {
        return { ...ended, state: "failed", phase: "error",
            stateLabel: `Failed · ${!execution.outcome && execution.effectStatus ? `action ${execution.effectStatus}` : workflowFailureDetail(execution.outcome)}` };
    }
    if (node.type === "terminal") {
        return { ...ended, outcome: node.outcome, state: node.outcome === "failed" ? "failed" : node.outcome === "cancelled" ? "cancelled" : "done",
            phase: "done", stateLabel: `Reached · ${workflowOutcomeWord(node.outcome)}` };
    }
    // A join of the first k (owner decision join-k-of-n) says how many it took; a join blocked at its time limit says so
    // (J1b, Q3: k could no longer happen by then).
    const first = kind === "parallel" ? workflowJoinFirst(node) : null;
    const atLimit = kind === "parallel" && execution.outcome === "blocked" && workflowDecidedAtLimit(execution) ? ", limit" : "";
    if (execution.resultKind === "business" && first !== null && (execution.outcome === "joined" || execution.outcome === "blocked")) {
        return { ...ended, state: "done", phase: "done", stateLabel: execution.outcome === "joined"
            ? `Done · joined, first ${first} ok`
            : `Done · blocked, ${first === 1 ? "none" : `fewer than ${first}`} ok${atLimit}` };
    }
    const named = Array.isArray(node.namedBranches);
    if (atLimit && execution.resultKind === "business") {
        return { ...ended, state: "done", phase: "done", stateLabel: `${outcomeText(kind, execution.outcome, named)}${atLimit}` };
    }
    if (execution.resultKind === "business") return { ...ended, state: "done", phase: "done", stateLabel: outcomeText(kind, execution.outcome, named) };
    return { ...ended, state: "done", phase: "unclassified", stateLabel: "Done · outcome not recorded" };
}

/**
 * Where each visit of a branch step was (adversarial review R2-UI-5), by its execution id: its branch (`index`, and its
 * `number` as people read it), its parallel step's visit (`parallelVisit`, that visit's number, when known) and a `label`
 * ("branch 2", or "branch 2 · parallel visit 1"). Re-check UI-RC2-2: the parallel visit is named whenever it could be
 * mistaken: the step has visits in more than one parallel visit, the parallel step itself had more than one visit
 * (`parallelOrdinals`, its loaded visits by execution id), or a visit is not in the parallel step's current visit
 * (`currentParallelId`). Pure.
 */
export function workflowVisitPlaces(executions, parallelOrdinals = null, currentParallelId = null, branchName = null) {
    const list = (Array.isArray(executions) ? executions : []).filter(item => typeof item?.id === "string" && isRecord(item.branch)
        && typeof item.branch.parallelNodeExecutionId === "string" && Number.isSafeInteger(item.branch.index));
    const visits = new Set(list.map(item => item.branch.parallelNodeExecutionId));
    const parentVisits = parallelOrdinals instanceof Map ? parallelOrdinals.size : 0;
    const current = typeof currentParallelId === "string" && currentParallelId ? currentParallelId : null;
    return Object.fromEntries(list.map(item => {
        const ordinal = parallelOrdinals instanceof Map ? parallelOrdinals.get(item.branch.parallelNodeExecutionId) : undefined;
        const parallelVisit = Number.isSafeInteger(ordinal) ? ordinal : null;
        const number = workflowBranchNumber(item.branch.index);
        const named = visits.size > 1 || parentVisits > 1 || (current !== null && item.branch.parallelNodeExecutionId !== current);
        return [item.id, { index: item.branch.index, number, parallelExecutionId: item.branch.parallelNodeExecutionId, parallelVisit,
            // A named branch's step says its branch's name.
            label: `${typeof branchName === "string" && branchName ? `branch ${branchName}` : `item ${number}`}${named
                ? ` · ${branchName ? "parallel" : "For each"} visit ${parallelVisit ?? "not loaded"}` : ""}` }];
    }));
}

/**
 * The scope a visit's number counts in (adversarial review R2-UI-4): one branch of one parallel visit
 * ("<parallel visit>#<index>", as the runtime names the scope), else the scope the read model or event names, else the
 * root. Visits of a step in different branches, or in another visit of its parallel step, are never compared by number.
 */
export function workflowVisitScope(execution) {
    const branch = execution?.branch;
    if (isRecord(branch) && typeof branch.parallelNodeExecutionId === "string" && Number.isSafeInteger(branch.index)) {
        return `${branch.parallelNodeExecutionId}#${branch.index}`;
    }
    return text(execution?.scopeId) ?? "root";
}

/**
 * When a visit ended, to order ended visits across scopes: its completedAt, the store's completion clock, from its read
 * row or (R3-UI-1, S6-UI2) from its end event, which carries the same; -Infinity when neither gives it (an event from
 * before that). An event's own time is its transaction's start, never taken for the end.
 */
const endedAt = item => {
    const time = typeof item?.completedAt === "string" ? Date.parse(item.completedAt) : NaN;
    return Number.isFinite(time) ? time : -Infinity;
};

/**
 * Which of two ended visits ended later (> 0: `a`; 0 when their end times do not tell): by completedAt (endedAt), so two
 * visits with a recorded end are always ordered by it, whether it came from their rows or their events.
 */
function compareEnded(a, b) {
    const atA = endedAt(a);
    const atB = endedAt(b);
    return atA === atB ? 0 : atA > atB ? 1 : -1;
}

/**
 * The latest of ended visits (R3-UI-1: one end-time order for a step's result, which the graph, Output and the TUI's f
 * show, and for its branch picker's default ended branch): the one that ended last (compareEnded). Only when no end time
 * tells does each keep its own earlier rule: the step's result the higher visit number, then the one listed last
 * (`byNumber`); the branch picker the one listed last (its highest-numbered branch, review UI7-6). Null when none. Pure.
 */
function latestEnded(items, { byNumber = true } = {}) {
    return items.filter(Boolean).reduce((latest, item) => {
        if (!latest) return item;
        const order = compareEnded(item, latest);
        return order > 0 || (order === 0 && (!byNumber || (item.ordinal ?? 0) >= (latest.ordinal ?? 0))) ? item : latest;
    }, null);
}

/**
 * Re-check RC-5: what a branch step not reached yet in its parallel step's current visit says instead of a result:
 * `notReached` is a node view's ({ parallelStateId, parallelVisit }). Pure.
 */
export function workflowNotReachedText(notReached) {
    if (!isRecord(notReached)) return null;
    const visit = Number.isSafeInteger(notReached.parallelVisit) ? `visit ${notReached.parallelVisit}` : "the current visit";
    return `This node is not reached yet in ${visit} of ${notReached.parallelStateId}, so it has no state or result of its own there. `
        + `Its visits in earlier visits of ${notReached.parallelStateId} are in its history.`;
}

/**
 * A step's visits by the scope they count in (R2-UI-4), each scope's shown visit (shownVisit, within the scope), and the
 * scopes that are the step's now: a branch step's are the branches of its parallel step's shown visit (`parallelVisit`);
 * every other step's are all of them. Re-check RC-5: when that parallel visit is known and no branch of it reached the
 * step yet, none is (`notReached`), never an earlier parallel visit's in its place; those stay in the step's history.
 * Only visits that say their branch tell this; without any, all of them are the step's, as before.
 */
function visitScopes(list, parallelVisit) {
    const byScope = new Map();
    for (const item of list) {
        const key = workflowVisitScope(item);
        if (!byScope.has(key)) byScope.set(key, []);
        byScope.get(key).push(item);
    }
    const scopes = [...byScope].map(([key, items]) => ({ key, items, ...shownVisit(items),
        index: Number.isSafeInteger(items[0]?.branch?.index) ? items[0].branch.index : null }));
    const known = typeof parallelVisit?.id === "string";
    const current = known ? scopes.filter(scope => scope.items.some(item => item.branch?.parallelNodeExecutionId === parallelVisit.id)) : [];
    if (known && scopes.some(scope => scope.items.some(item => isRecord(item.branch)))) return { scopes, current, notReached: current.length === 0 };
    return { scopes, current: current.length ? current : scopes, notReached: false };
}

function nodeView(node, executions, context) {
    const kind = workflowKind(node);
    const list = executions.filter(item => item.stateId === node.id).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    // R2-UI-4: visit numbers count within a scope (the root, or one branch of one parallel visit). Each scope's pending
    // visit is stale only against an ended visit of the same scope, and a branch step says its branches' state in the
    // parallel step's shown visit: running while any of them runs, else its latest ended visit there.
    const parallelVisit = typeof node.parallel === "string" ? context.parallelVisits?.get(node.parallel) ?? null : null;
    const { scopes, current, notReached } = visitScopes(list, parallelVisit);
    const byBranch = (a, b) => (a.index ?? Infinity) - (b.index ?? Infinity);
    const running = current.filter(scope => scope.pending).sort(byBranch);
    const pending = running[0]?.pending;
    const latestDone = latestEnded(current.map(scope => scope.latestDone)) ?? undefined;
    // A pending execution older than a completed one of its own scope lost its completion from the loaded history.
    const stalePending = scopes.some(scope => scope.items.some(item => item.status === "pending" && item !== scope.pending));
    const reachedByRun = node.type === "terminal" && context.terminalState === node.id;
    // Each scope's visits count on their own: the visits a step had are the sum of its scopes'.
    const runs = Math.max(scopes.reduce((sum, scope) => sum + Math.max(scope.items.length, ...scope.items.map(item => item.ordinal ?? 0)), 0), reachedByRun ? 1 : 0);
    let state = "idle", phase = "not-reached", stateLabel = context.stateless ?? (context.hasRun ? "Not reached" : "Not started");
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
            stateLabel = `${stateLabel} · ${running.length}/${current.length} items`;
        }
    } else if (reachedByRun) {
        state = node.outcome === "failed" ? "failed" : node.outcome === "cancelled" ? "cancelled" : "done";
        phase = "done"; outcome = node.outcome; resultKind = "business"; stateLabel = `Reached · ${workflowOutcomeWord(node.outcome)}`;
    }
    // Workflow Simplified (W5, usability finding 1): a node several items reached says how its items went, with nouns, and is
    // red when any item failed; never the colour of whichever item ended last. An item canceled as intended (a join that
    // had what it needed) is not a failure.
    let itemCounts = null;
    if (typeof node.parallel === "string" && current.length > 1) {
        itemCounts = { ok: 0, failed: 0, canceled: 0, running: 0, total: current.length };
        for (const scope of current) {
            const kindOf = itemKind(node, scope.pending ?? scope.latestDone, context.run);
            if (kindOf) itemCounts[kindOf] += 1;
        }
        state = itemCounts.failed ? "failed" : itemCounts.running ? "running" : itemCounts.ok ? "done" : itemCounts.canceled ? "cancelled" : state;
        phase = itemCounts.failed ? "error" : itemCounts.running ? "running" : itemCounts.ok || itemCounts.canceled ? "done" : phase;
        stateLabel = workflowItemCountsText(itemCounts) || stateLabel;
    }
    // Re-check RC-5: not reached yet in the parallel step's current visit; an earlier visit's state and result are not its own.
    const parallelOrdinal = Number.isSafeInteger(parallelVisit?.ordinal) ? parallelVisit.ordinal : null;
    const notReachedView = notReached ? { parallelStateId: node.parallel, parallelVisit: parallelOrdinal } : null;
    if (notReachedView && !shown && !reachedByRun) {
        stateLabel = `Not reached in ${parallelOrdinal === null ? "this visit" : `visit ${parallelOrdinal}`} of ${node.parallel}`;
    }
    // Every loaded visit, newest first: older history a person loaded reaches any visit of the state.
    const history = [...list].reverse();
    const binding = workflowAgentBinding(node, context.pins);
    // OF-S2-7: an agent node's model (chosen at start, or from the session), for its Node panel, its tooltip and the TUI.
    const shownVisit = pending || latestDone;
    const model = kind === "agent" ? workflowAgentModel(isRecord(context.agentModels?.[node.id]) ? context.agentModels[node.id] : null, context.sessionModel,
        typeof shownVisit?.id === "string" ? context.spawnedModels?.get(shownVisit.id) ?? null : null,
        { unreadable: context.agentModelsUnreadable === true }) : null;
    const view = {
        ...node, kind, label: workflowNodeLabel(node), state, phase, stateLabel, runs,
        // Workflow Simplified (10, W7): whether the shown graph has a run (a node it did not reach is dimmed), and the
        // node's items when several reached it (W5).
        hasRun: Boolean(context.hasRun), ...(itemCounts ? { itemCounts } : {}),
        ...(binding ? { binding } : {}),
        ...(model ? { model } : {}),
        partial: !context.complete || stalePending || runs > list.length,
        outcome: outcome ?? (node.type === "terminal" ? node.outcome : undefined), resultKind,
        result, pending: pending || null, current: pending || latestDone || null, executions: history,
        ...(notReachedView ? { notReached: notReachedView } : {}),
        // Re-check UI-RC2-4: a branch step's parallel visit now, known also before a branch of it reaches the step.
        ...(typeof node.parallel === "string" ? { parallelVisitId: typeof parallelVisit?.id === "string" ? parallelVisit.id : null } : {}),
        description: [...describeWorkflowExecution(node, pending || latestDone, context.sessionName), ...branchProgressLines(node, pending || latestDone, context),
            ...(notReachedView ? [workflowNotReachedText(notReachedView)] : [])],
        ...(node.type === "parallel" ? { evidence: workflowBranchEvidence(context.executions, context.states, pending || latestDone, context.complete, node) } : {}),
    };
    view.card = workflowNodeCard(view, node, context);
    // Owner batch 7 (H2): a parallel step's branch box and join bar; a branch step's visit in each branch, for its picker.
    if (node.type === "parallel") view.joinBar = workflowJoinView(view, context);
    if (typeof node.parallel === "string") {
        view.branches = workflowBranchChoices(list, context.parallelVisits?.get(node.parallel) ?? null, { node, run: context.run });
        view.where = workflowVisitPlaces(list, context.parallelOrdinals?.get(node.parallel) ?? null, parallelVisit?.id ?? null, node.branchName ?? null);
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
 * Everything the graph, header and details need from a definition, durable
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
export function projectWorkflow({ definition = null, readModel = null, workflowModel = null, selectedRunId = null, events = [], readModelAfterSeq = null,
    olderHistory = null, now = Date.now(), asOf = null, sessionName = null, sessionModel = null } = {}) {
    const model = readModel ? projectWorkflowReadModel(readModel, { older: olderHistory, now }) : null;
    const wide = model || !workflowModel ? null : projectWorkflowReadModel(workflowModel, { now });
    // The workflow-wide source: the selection's own model, else another selection's model that projects.
    const shared = model ?? (wide?.ok ? wide : null);
    const banners = model ? [...model.banners] : shared ? [...shared.workflowBanners] : [];
    const modelOk = Boolean(model?.ok);
    // A read model that says there is no graph is not overridden by an older run's definition, whichever run it was read for.
    const active = shared?.ok ? shared.definition : definition ?? null;
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
            banners.push({ level: "warning", text: `This Workflow ran revision ${revision}; the graph shows revision ${active.revision}, so node states are not shown.` });
        }
    }
    const collected = bound
        ? collectExecutions(events, runId, run, true) : { executions: [], ignoredEvents: 0, ignoredRows: 0 };
    // A visit in a named branch carries its branch's name (its step's, on the graph), so every word that names its
    // branch can say it: why it ended, the replay, the places.
    const branchNames = new Map((active?.states ?? []).flatMap(node => (typeof node?.branchName === "string" && node.branchName
        && typeof node.parallel === "string" ? [[node.id, node.branchName]] : [])));
    if (branchNames.size) {
        collected.executions = collected.executions.map(item => (isRecord(item.branch) && branchNames.has(item.stateId)
            ? { ...item, branch: { ...item.branch, name: branchNames.get(item.stateId) } } : item));
    }
    const { ignoredEvents, ignoredRows } = collected;
    // Stage 2.4 (the replay): the visits as they stood at `asOf` (epoch milliseconds); every visit loaded stays in allExecutions.
    const replaying = Number.isFinite(asOf) && collected.executions.length > 0;
    const executions = replaying ? workflowExecutionsAt(collected.executions, asOf) : collected.executions;
    let status = !bound && modelOk && !run
        ? { phase: "none", ended: false, label: model.runs.length ? "No Workflow selected" : "Not started" }
        : workflowRunStatus({ run, events: bound || !modelOk ? events : [], runId, readModelAfterSeq });
    // A selected run whose own read model is not here (yet), and none of whose events are loaded.
    if (!modelOk && selection !== null && status.phase === "none") status = { ...status, label: "Not loaded" };
    if (!bound && runId) status = { ...status, terminalState: null, label: `${unboundRevision === null ? "Revision not known" : `Revision ${unboundRevision}`} · ${status.label}` };
    // Replies waiting in the shown run beside its status (q15, mock M16: "Paused · 1 reply waiting"); the banner says why.
    if (bound && modelOk && model.waitingReplies > 0 && !status.ended) {
        status = { ...status, label: `${status.label}${workflowWaitingRepliesLabel(model.waitingReplies)}` };
    }
    // A replay before the run's last visit ended shows the run as it was then: not ended, at that time.
    if (replaying && asOf < workflowLastMoment(collected.executions)) {
        status = { ...status, ended: false, terminalState: null, label: `Replay · ${workflowEventTime(new Date(asOf).toISOString()) ?? ""}`.trim() };
    }
    if (status.phase === "unverified") {
        // Review 19:27Z: the not-certain reason in the Workflow's words; the TUI prints it as its notice line.
        banners.push({ level: "warning", text: `Not certain: its data says ${status.conflict.readModel}, its latest event says ${status.conflict.events}. Refresh to read it again.` });
    }
    if (ignoredEvents) banners.push({ level: "warning", text: `${ignoredEvents} workflow event${ignoredEvents === 1 ? "" : "s"} had an unknown format and ${ignoredEvents === 1 ? "was" : "were"} ignored.` });
    if (ignoredRows) banners.push({ level: "warning", text: `${ignoredRows} visit${ignoredRows === 1 ? "" : "s"} had an unknown format and ${ignoredRows === 1 ? "was" : "were"} ignored.` });
    const known = new Set((active?.states || []).map(node => node.id));
    const unknown = executions.filter(item => !known.has(item.stateId)).length;
    if (unknown) banners.push({ level: "warning", text: `${unknown === 1 ? "1 visit belongs" : `${unknown} visits belong`} to nodes that are not in this graph.` });
    const context = { run: status, hasRun: status.phase !== "none",
        terminalState: bound && !(replaying && status.terminalState === null && asOf < workflowLastMoment(collected.executions))
            ? status.terminalState ?? run?.terminalState ?? null : null,
        complete: Boolean(run && bound && run.history.complete), stateless: !bound && runId ? "Not shown on the graph" : undefined, sessionName,
        // Every open row is listed (R2-UI-7): the branches running now are all known even when older history is not loaded.
        openComplete: Boolean(run && bound && run.history.openComplete),
        pins: agentPinSource(shared, run, bound, active),
        // OF-S2-7: what each agent node uses: the shown run's choice for it, else the model of the session that owns the Workflow.
        agentModels: bound && run && isRecord(run.agentModels) ? run.agentModels : null, sessionModel,
        agentModelsUnreadable: Boolean(bound && run?.agentModelsUnreadable),
        // OF7-R8: what each visit's session ran on, recorded with its spawn.
        spawnedModels: bound && runId ? workflowSpawnedModels(events, runId) : new Map() };
    // Each parallel state's branches as the loaded executions show them (mock M21 active and queued counts, M22 a blocked join).
    context.branchProgress = workflowBranchProgress(executions, active?.states || []);
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
    // Workflow Simplified (F4): the node a Workflow starts at carries the Start marker.
    const nodes = (active?.states || []).map(node => ({ ...nodeView(node, executions, context), initial: node.id === active.initial }));
    return {
        status, definition: active, nodes, banners, readModel: model, runId, bound,
        // Stage 2.4: every visit loaded (the replay's frames), and the replay's moment when one is shown.
        allExecutions: collected.executions, asOf: replaying ? asOf : null,
        historyComplete: Boolean(run && bound && run.history.complete), historyStale: Boolean(run && bound && run.history.staleOlder),
        diagnostics: shared?.diagnostics || [], inbox: bound ? run?.inbox || [] : [], outbox: bound ? run?.outbox || [] : [],
        output: bound ? run?.output ?? null : null, error: bound ? run?.error ?? null : null, modelStatus: shared?.status ?? null,
        // Why the shown run ended (owner decision q14), from its read and its end events; null while it runs.
        ending: bound && run && status.ended ? workflowRunEnding(run, events, sessionName) : null,
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
export function workflowDraftInProgress(projection, parentWorking) {
    const latest = projection?.latest;
    if (parentWorking !== true || !isRecord(latest) || latest.valid !== false) return null;
    return { revision: latest.revision, errors: latest.errors };
}

/** "Revision 3 has 2 errors" (or "unlisted errors" when the read lists none). Pure. */
export function workflowRevisionErrorsText(revision, errors) {
    return `Revision ${revision} has ${errors || "unlisted"} error${errors === 1 ? "" : "s"}`;
}

/** Collapse neighbouring executions that ended the same way, with the same output, into one row. The raw list stays available to the caller. */
export function compactWorkflowExecutions(executions) {
    const rows = [];
    for (const execution of executions) {
        // Only visits of one scope are combined: never two branches', or two parallel visits' (adversarial review R2-UI-5).
        const key = JSON.stringify([workflowVisitScope(execution), execution.status, execution.outcome, execution.resultKind,
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
 * Re-check UI-RC2-3: the History choice to keep when a person picks another branch of step `stateId` in Details: none, when
 * the choice was for that step (so going back to its branch shows the branch's latest result, not the old choice); the
 * same choice otherwise. Pure.
 */
export function workflowSelectionAfterBranchChange(selection, stateId) {
    return isRecord(selection) && selection.stateId === stateId ? null : selection ?? null;
}

/**
 * Re-check RC-6: whether a saved History choice (`selection`) still applies to a branch step as it is shown now. A choice
 * records the parallel step's visit that was current (`parallelExecutionId`, the node view's `parallelVisitId`, known
 * also while the step is not reached in it: re-check UI-RC2-4) and, in the portal, the branch chosen in Details
 * (`branchIndex`) when it was made: only one a person chose there, never the default branch (adversarial review R3-UI-3,
 * null then); a new parallel visit, or another branch chosen in Details since, ends it, and the step
 * shows that branch's latest result again. A branch change in Details also clears the choice (re-check UI-RC2-3), so a
 * round trip back to its branch does not bring it back. A choice without these fields (made before them) is kept. A
 * choice made while no branch was chosen in Details (`branchIndex` null: the default branch was shown, or the step was not
 * reached yet in that parallel visit) is not ended when the default branch moves (re-check UI-RC3-1, R3-UI-3); only a
 * branch chosen in Details, which clears it, or another parallel visit ends it. Pure.
 */
function selectionStillApplies(node, selection, branch) {
    // Re-check UI-RC2-4: compared with the parallel step's visit now, also while no branch of it has reached the step.
    const parallelNow = node?.parallelVisitId !== undefined ? node.parallelVisitId : node?.branches?.parallelExecutionId ?? null;
    if (Object.hasOwn(selection, "parallelExecutionId") && (selection.parallelExecutionId ?? null) !== (parallelNow ?? null)) return false;
    if (Number.isSafeInteger(selection.branchIndex) && isRecord(branch) && Number.isSafeInteger(branch.index)
        && selection.branchIndex !== branch.index) return false;
    return true;
}

/**
 * Which execution of a state a person reads (R01 history; design 02 node occurrences), by its exact identity: the one `selection` names
 * ({ runId, stateId, executionId }) when it is for exactly this run (`runId`, the run the projection overlays) and this
 * state (`node`, a node view), and, for a branch step, the same parallel visit and branch as when it was chosen
 * (selectionStillApplies, re-check RC-6); otherwise the state's latest completed execution, as before. A chosen
 * execution that is not among the state's loaded executions is `missing`, and the latest result is never shown in its
 * place. `index` is its place in `node.executions` (newest first), -1 when there is none. Pure.
 */
export function workflowShownExecution(node, runId, selection, branch = null) {
    const executions = Array.isArray(node?.executions) ? node.executions : [];
    const chosen = isRecord(selection) && typeof selection.executionId === "string" && selection.executionId !== ""
        && selection.stateId === node?.id && (selection.runId ?? null) === (runId ?? null) && selectionStillApplies(node, selection, branch);
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
export function workflowExecutionResult(execution) {
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
export function workflowRunPageRows(run, section) {
    const value = section === "executions" ? run?.nodeExecutions : section === "inbox" ? run?.inbox : section === "outbox" ? run?.outbox
        : section === "interceptions" ? run?.test?.interceptions : null;
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The key of one execution's whole value in the view's `executionValues`: its run, then the execution. */
export function workflowExecutionValueKey(runId, executionId) {
    return JSON.stringify([runId ?? null, executionId]);
}

/**
 * One execution's whole value as the view read it (`executionValues`, which the controller's loadWorkflowExecutionValue
 * writes: { runId, executionId, phase: loading, loaded or failed, result, error }), for exactly that run and execution;
 * null when it was not read. Pure.
 */
export function workflowExecutionValue(values, runId, executionId) {
    if (!isRecord(values) || typeof executionId !== "string" || !executionId) return null;
    const entry = values[workflowExecutionValueKey(runId, executionId)];
    return isRecord(entry) && entry.executionId === executionId && (entry.runId ?? null) === (runId ?? null) ? entry : null;
}

/**
 * What one execution's whole value shows (design 04 read_workflow execution_id; mock M10 "Inspect typed output"; D07):
 * `loading`; `failed` with its error; `none` (it has no result: it has not ended); `value`, the whole output or runtime
 * error (`label`) as read, a string as it is and any other JSON indented, with its size in bytes; or `preview`, a stored
 * value larger than a read returns (none is written), its bounded preview with its size and the limit. Null without an
 * entry. Never another execution's value. Pure.
 */
export function workflowWholeValue(entry) {
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
export function workflowKvRevisionKey(runId, revision) {
    return JSON.stringify([runId ?? null, revision]);
}

/**
 * One KV revision's snapshot as the view read it (`kvRevisions`, which the controller's loadWorkflowKvRevision writes:
 * { runId, revision, phase: loading, loaded or failed, kv, error }), for exactly that run and revision; null when it
 * was not read. Pure.
 */
export function workflowKvSnapshot(snapshots, runId, revision) {
    if (!isRecord(snapshots) || !Number.isSafeInteger(revision)) return null;
    const entry = snapshots[workflowKvRevisionKey(runId, revision)];
    return isRecord(entry) && entry.revision === revision && (entry.runId ?? null) === (runId ?? null) ? entry : null;
}

/**
 * The variables a state's visit applied and the run's accepted ones now (design 02 open KV: a state reads the revision
 * pinned when it was admitted; mock M15 "Accepted 9 / applied 8"): { applied, accepted, same }, or null when the visit
 * names no revision. Pure.
 */
export function workflowKvApplied(execution, run) {
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
export function workflowKvCompare(before, after) {
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
 * (`started`), those still at work (`active`), and those that reached a terminal state that succeeded (`succeeded`).
 * Re-check RC-8: a branch is ended only by a recorded end, as its evidence row says (workflowBranchEvidence): its last
 * step (the end of its chain, branchLast) is a terminal, was cancelled (the join, the time limit, failFast), or ended
 * with a result no route takes. A step whose result takes a route (a loop's next check, an error with a recovery route)
 * leaves its branch between two steps: still at work, not ended, while its next step is not admitted yet. Re-check
 * UI-RC2-5: `pending` counts the branches with a step at work now (definite: an open row), `between` those inferred at
 * work from a routed result, and `active` both. From the executions loaded only: older history not loaded may hold more
 * (the caller says so). Pure.
 */
export function workflowBranchProgress(executions, states = []) {
    const byId = new Map((Array.isArray(states) ? states : []).filter(isRecord).map(state => [state.id, state]));
    const byParallel = new Map();
    for (const execution of Array.isArray(executions) ? executions : []) {
        const branch = execution?.branch;
        if (!isRecord(branch) || typeof branch.parallelNodeExecutionId !== "string" || !Number.isSafeInteger(branch.index)) continue;
        const branches = byParallel.get(branch.parallelNodeExecutionId) ?? new Map();
        if (!branches.has(branch.index)) branches.set(branch.index, []);
        branches.get(branch.index).push(execution);
        byParallel.set(branch.parallelNodeExecutionId, branches);
    }
    const progress = new Map();
    for (const [id, branches] of byParallel) {
        let pending = 0, between = 0, succeeded = 0;
        for (const list of branches.values()) {
            const sorted = list.slice().sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
            if (sorted.some(item => item.status === "pending")) { pending++; continue; }
            const last = branchLast(sorted);
            const state = byId.get(last.stateId);
            if (state?.type === "terminal") {
                if (state.outcome === "succeeded") succeeded++;
                continue;
            }
            if (typeof last.winner === "string" && Object.hasOwn(BRANCH_CANCELS, last.winner)) continue;
            const next = isRecord(state?.next) ? state.next : null;
            const routed = next !== null && typeof last.outcome === "string"
                && (Object.hasOwn(next, last.outcome) || (last.resultKind === "runtime_error" && Object.hasOwn(next, "failure")));
            if (routed) between++;
        }
        progress.set(id, { started: branches.size, active: pending + between, pending, between, succeeded });
    }
    return progress;
}

/** A parallel state's branches now, as lines of its description: active, queued and ended while it runs; a blocked join's k of n. */
function branchProgressLines(node, execution, context) {
    if (node?.type !== "parallel" || !execution || !Number.isSafeInteger(execution.branches)) return [];
    const progress = context.branchProgress?.get(execution.id) ?? { started: 0, active: 0, succeeded: 0 };
    // Review 19:27Z (rows 24, 25; C): its items in the Workflow's words; "+" where older visits are not loaded.
    const more = context.complete ? "" : "+";
    if (execution.status === "pending") {
        const counts = workflowBranchCounts(execution.branches, progress, context);
        return [counts.partial
            ? `Items now: ${counts.running}${counts.runningExact ? "" : "+"} running · ${counts.done}+ ended · ${counts.unknown} not loaded`
            : `Items now: ${counts.running} running · ${counts.queued} waiting · ${counts.done} ended`];
    }
    if (execution.outcome === "blocked") {
        // A join of the first k (owner decision join-k-of-n) says how many it needs; J1b: that its limit passed.
        const first = workflowJoinFirst(node);
        return [`Join blocked: ${progress.succeeded}${more}/${execution.branches} ok${first !== null ? ` · needs ${first}` : ""}`
            + `${workflowDecidedAtLimit(execution) ? " · limit passed" : ""}`];
    }
    return [];
}

// ── A parallel step's branch box, join bar and branch picker (owner batch 7, H2) ─────────────────────────────────────

/** An item's visit of a node in the item picker: its mark and its outcome ("● running", "✓ ok", "✕ limit", "⊘ canceled"). */
function branchChoiceState(execution) {
    if (execution.status === "pending") return "● running";
    if (execution.resultKind === "runtime_error") return execution.outcome === "cancelled" ? "⊘ canceled" : `✕ ${workflowFailureDetail(execution.outcome)}`;
    return execution.outcome ? `✓ ${workflowOutcomeWord(execution.outcome)}` : "✓ done";
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * A branch's number as people read it: its index plus one, so the first branch is "branch 1" (owner batch 7, H2). The
 * data (events, the read model, the parent agent's messages) keep the index from 0. Pure.
 */
export function workflowBranchNumber(index) {
    return Number.isSafeInteger(index) ? index + 1 : index;
}

/** "branches 2, 3" or "branch 2" for the branch indexes given (from 0), as people read them. Pure. */
export function workflowBranchList(indexes) {
    const list = Array.isArray(indexes) ? indexes : [];
    return `${list.length === 1 ? "branch" : "branches"} ${list.map(workflowBranchNumber).join(", ")}`;
}

/**
 * "items 2, 3" or "item 2" for the item indexes given (from 0), as people read them (D-W4); with a named-branch
 * state's `names` (by index), "branches quick, careful". Pure.
 */
export function workflowItemList(indexes, names = null) {
    const list = Array.isArray(indexes) ? indexes : [];
    if (Array.isArray(names)) return `${list.length === 1 ? "branch" : "branches"} ${list.map(index => names[index] ?? workflowBranchNumber(index)).join(", ")}`;
    return `${list.length === 1 ? "item" : "items"} ${list.map(workflowBranchNumber).join(", ")}`;
}

/** The binding's own name ("input.items") for a binding, "3 items" for a literal list (never its values: SF-3). Pure. */
export function workflowForEachText(forEach) {
    if (typeof forEach === "string" && forEach) return forEach;
    if (isRecord(forEach) && Number.isSafeInteger(forEach.count)) return `${plural(forEach.count, "item")}, in the definition`;
    return "not shown";
}

/**
 * A parallel step's branch steps in the order a branch meets them (owner batch 7, H2): from its first step along its
 * routes, breadth first, then any step no route reaches, in body order. Only steps of `states`. Pure.
 */
export function workflowBranchSteps(parallel, states) {
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

// Review 18:45Z: a join its limit ended reads "✕ limit" ("Time limit" in its tooltip).
const JOIN_WORDS = { waiting: "waiting", joined: "joined", blocked: "blocked", failed: "failed", cancelled: "canceled", timed_out: "✕ limit" };

/** When a For each node continues, in words (W6): "Joins when all succeed", "Joins at the first 2 of 5". Pure. */
export function workflowContinueWords(node, visit = null) {
    const first = workflowJoinFirst(node);
    if (first === null) return "Joins when all succeed";
    if (first === 1) return "Joins at the first success";
    const items = joinItems(node, visit);
    return `Joins at the first ${first}${items === null ? "" : ` of ${items}`}`;
}

/** The k of a parallel step's join of the first k (owner decision join-k-of-n); null for a join of every branch. Pure. */
export function workflowJoinFirst(node) {
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
export function workflowJoinRule(node, visit = null) {
    const first = workflowJoinFirst(node);
    if (first === null) return "all required";
    if (first === 1) return "first success";
    const items = joinItems(node, visit);
    return items === null ? `first ${first}` : `first ${first} of ${items}`;
}

/**
 * The join rule in words, for a parallel step's details (owner decision join-k-of-n): who must succeed, what happens to
 * the others, and failFast. Pure.
 */
export function workflowJoinWords(node) {
    const first = workflowJoinFirst(node);
    const rule = first === null ? "All must succeed"
        : first === 1 ? "First to succeed · the rest are canceled"
            : `First ${first} to succeed · the rest are canceled`;
    if (!node?.failFast) return rule;
    return `${rule} · ${first === null ? "the first failure cancels the rest" : "also once the join cannot succeed"}`;
}

/**
 * A parallel step's own time limit (owner decision join-k-of-n; the engine enforces it), as people read it: null
 * without one; else `{ text, title }`. It says "time limit 30 s" (or "time limit from the input" for a binding), and
 * "time limit until <time>" while the shown visit waits with a deadline; once it timed out, the title says when it passed
 * (the join's own words say that it did). Pure.
 */
export function workflowJoinLimit(node, visit = null, { running = false, timedOut = false } = {}) {
    const seconds = node?.timeoutSeconds;
    if (seconds === undefined || seconds === null) return null;
    const length = typeof seconds === "number" ? formatSeconds(seconds) : null;
    const from = length === null ? `from ${String(seconds)}, set when the node starts` : `${length} from the node's start`;
    const deadline = typeof visit?.deadline === "string" ? workflowEventTime(visit.deadline) : null;
    const text = length === null ? "limit from input" : `limit ${length}`;
    if (timedOut) return { text, title: `Time limit ${from}. It passed before the join${deadline ? `, at ${deadline}` : ""}.` };
    if (running && deadline) return { text: `limit ${workflowShortTime(visit.deadline)}`, title: `Time limit ${from}; it passes at ${deadline}.` };
    return { text, title: `Time limit ${from}.` };
}

/**
 * Whether a parallel step's visit was decided at or after its own time limit (owner decision join-k-of-n, J1b): its
 * deadline and the time it ended, as the read model gives them (to the millisecond). A join decided then counted only
 * the successes saved by the deadline. Pure.
 */
export function workflowDecidedAtLimit(execution) {
    if (!isRecord(execution) || execution.status !== "completed") return false;
    const deadline = typeof execution.deadline === "string" ? Date.parse(execution.deadline) : NaN;
    const completed = typeof execution.completedAt === "string" ? Date.parse(execution.completedAt) : NaN;
    return Number.isFinite(deadline) && Number.isFinite(completed) && completed >= deadline;
}

/**
 * What a parallel step's branch box and join bar show (owner batch 7, H2; owner decision join-k-of-n): the join's
 * `state` (idle, waiting, joined, blocked, done, failed, timed_out or cancelled, from the step's own state and outcome),
 * its `rule` ("all required", "first success", "first 2 of 5") and `label` ("join · <rule>"), its `stateText`, its own
 * time limit (`limit`: { text, title } from workflowJoinLimit; null without one), and the box's label ("Each branch")
 * with, while the step runs, its branches now: `counts` { running, queued, done } and their `text`. `view` is the
 * parallel step's node view. Pure.
 */
export function workflowJoinView(view, context) {
    const visit = view.pending || view.result || null;
    const running = view.state === "running";
    const timedOut = !running && view.result?.outcome === "timed_out" && view.result?.resultKind === "runtime_error";
    // J1b (Q3): blocked at its time limit, because k could no longer happen by then.
    const blockedAtLimit = !running && view.result?.outcome === "blocked" && workflowDecidedAtLimit(view.result);
    const state = running ? "waiting" : timedOut ? "timed_out"
        : view.state === "done" ? (view.outcome === "joined" || view.outcome === "blocked" ? view.outcome : "done")
            : view.state === "failed" || view.state === "cancelled" ? view.state : "idle";
    const progress = running && visit ? context.branchProgress?.get(visit.id) ?? { started: 0, active: 0 } : null;
    const counts = progress && Number.isSafeInteger(visit.branches) ? workflowBranchCounts(visit.branches, progress, context) : null;
    const rule = workflowJoinRule(view, visit);
    // Workflow Simplified (W5, W6): the box says "For each item" and how its items go, with nouns; its continue rule is
    // said under it in words, not as a separate bar.
    // An ended visit says how many of its items succeeded ("2 of 3 succeeded"), when its items are known.
    const ended = !running && visit && Number.isSafeInteger(visit.branches) && visit.branches > 0 ? context.branchProgress?.get(visit.id) ?? null : null;
    const groupText = counts === null
        ? (ended ? `${Math.min(ended.succeeded ?? 0, visit.branches)}/${visit.branches} ok` : null)
        : counts.partial
            // History not all loaded: done is a lower bound, and running is one too unless every open row is listed.
            ? `${counts.running}${counts.runningExact ? "" : "+"} running · ${counts.done}+ ended · ${counts.unknown} not loaded`
            : [`${counts.running} running`, counts.queued ? `${counts.queued} waiting` : null, `${counts.done} ended`].filter(Boolean).join(" · ");
    return {
        id: `join:${view.id}`, state, rule, label: workflowContinueWords(view, visit), stateText: blockedAtLimit ? "blocked · limit" : JOIN_WORDS[state] ?? null,
        limit: workflowJoinLimit(view, visit, { running, timedOut: timedOut || blockedAtLimit }),
        // Named branches are "Branches".
        group: { label: Array.isArray(view.namedBranches) ? "Branches" : "For each item", counts, text: groupText },
    };
}

/**
 * A running parallel visit's branches now (adversarial review R2-UI-7), from the loaded executions (`progress`,
 * workflowBranchProgress) and its `total`. With every execution of the run loaded the counts are exact: { running,
 * queued, done }, a branch between two steps counted running. Without (re-check UI-RC2-5): running counts only branches
 * with a step at work now (an open row), exact while every open row is listed (the read lists them all); done counts the
 * recorded ends loaded (at least); every other branch is unknown, since it may be queued, between two steps or ended in
 * history not loaded: { running, done, unknown, partial: true, runningExact } and no queued count. Pure.
 */
export function workflowBranchCounts(total, progress, context) {
    const started = Math.max(0, progress?.started ?? 0);
    const active = Math.max(0, progress?.active ?? 0);
    const done = Math.max(0, started - active);
    if (context?.complete) return { running: active, queued: Math.max(0, total - started), done };
    const running = Math.max(0, progress?.pending ?? active);
    return { running, done, unknown: Math.max(0, total - running - done), partial: true, runningExact: context?.openComplete === true };
}

/**
 * A branch step's visits in the shown visit of its parallel step, for its details' branch picker (owner batch 7, H2):
 * `{ parallelExecutionId, choices, defaultIndex }`, a choice per branch that reached the step, by branch: { index,
 * execution (its latest visit of the step in that branch, by the visit numbers within the branch), label } and, given
 * the step (`node`) and the run's status (`run`), `status` (that visit's state, as the step's own is said) and
 * `lastOutcome` (the latest ended visit in that branch: its outcome and result kind), so the details say the chosen
 * branch's status and outcome, never another branch's (review UI7-3). The default is the first branch where the step
 * runs; else the branch whose visit ended last, by the end time its read row or its event gives (R3-UI-1, the order
 * of the step's own result); when none tells (visit numbers count within a branch, not across branches), the
 * highest-numbered branch where it ended (review UI7-6). Null when the parallel step has no shown visit or no branch
 * reached the step. Pure.
 */
export function workflowBranchChoices(executions, parallelVisit, { node = null, run = null } = {}) {
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
            label: `${typeof node?.branchName === "string" && node.branchName ? `Branch ${node.branchName}` : `Item ${workflowBranchNumber(index)}`} · ${branchChoiceState(execution)}`,
            ...(isRecord(node) && isRecord(run) ? {
                status: visitStatus(node, execution, run),
                // A branch's end has its terminal's outcome, as the step's own Last outcome does.
                lastOutcome: done ? { outcome: (node.type === "terminal" && done.resultKind !== "runtime_error" ? node.outcome : done.outcome) ?? null,
                    resultKind: done.resultKind ?? null } : null,
            } : {}),
        };
    });
    const running = choices.find(choice => choice.execution.status === "pending");
    // R3-UI-1: the branch whose visit ended last, in the step's own end-time order (latestEnded); the highest-numbered
    // when no end time tells.
    const last = latestEnded(choices.filter(choice => choice.execution.status === "completed").map(choice => choice.execution), { byNumber: false });
    const ended = last ? choices.find(choice => choice.execution === last) : undefined;
    return { parallelExecutionId: parallelVisit.id, choices, defaultIndex: (running ?? ended ?? choices[0]).index };
}

/**
 * What a person's branch choice is kept for: the workflow session, the shown run, the parallel step's visit and the
 * step. Another workflow, run or visit of the parallel step starts again from the default branch. Pure.
 */
export function workflowBranchPickKey(sessionId, runId, node) {
    return JSON.stringify([sessionId ?? null, runId ?? null, node?.branches?.parallelExecutionId ?? null, node?.id ?? null]);
}

/** The choice a branch picker shows: the one for `index` when the step has it, else the default. Null without choices. Pure. */
export function workflowBranchChoice(branches, index = null) {
    if (!isRecord(branches) || !Array.isArray(branches.choices) || !branches.choices.length) return null;
    return branches.choices.find(choice => choice.index === index) ?? branches.choices.find(choice => choice.index === branches.defaultIndex) ?? branches.choices[0];
}

/**
 * One line, its whitespace collapsed, cut to `max` characters with "…" (the activity list, the reasons and results it
 * shows, and the question to the parent agent). Pure.
 */
export function workflowClipped(value, max = 200) {
    const one = String(value ?? "").replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ── Activity, why a run or a step ended, and the sessions under a step (owner decision q14; mocks M09, M14) ──────────

const ACTIVITY_LIMIT = 50;
const clipped = workflowClipped;
const parsedJson = value => {
    if (isRecord(value)) return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return isRecord(parsed) ? parsed : null; } catch { return null; }
};

/** Who acted, from an event's actor record, in plain words; null when the event names nobody. Pure. */
export function workflowActorText(actor) {
    if (!isRecord(actor)) return null;
    if (actor.kind === "user") return text(actor.displayName) ?? text(actor.email) ?? text(actor.subject) ?? "a person";
    // Review 18:45Z: no raw session id where a person reads it.
    if (actor.kind === "agent") return "an agent";
    if (actor.kind === "system") return text(actor.name) ?? "the system";
    return null;
}

/**
 * An event's or a deadline's time as people read it (owner decision local-time-20261104): "YYYY-MM-DD HH:MM:SS <zone>"
 * in the reader's own time zone, the browser's (the terminal machine's in the TUI), with the zone's short name
 * (formatLocalTime); null for no time. `timeZone` (an IANA name) fixes the zone, for tests. Stored data stays ISO UTC.
 */
export function workflowEventTime(value, timeZone = undefined) {
    return formatLocalTime(value, { timeZone });
}


const names = value => {
    const keys = Array.isArray(value) ? value.filter(key => typeof key === "string" && key) : [];
    return keys.length > 5 ? `${keys.slice(0, 5).join(", ")} and ${keys.length - 5} more` : keys.join(", ");
};
/** ": <reason>", or "" when there is none or it is only a state word (review 19:27Z: never "Canceled at once: Stopped"). */
const because = value => (workflowReasonShown(text(value)) ? `: ${clipped(value)}` : "");
/** A skipped run-end notice after an attempt that may have queued it (D-R1). */
const EARLIER_ATTEMPT = " An earlier attempt may have told the parent.";

/**
 * " · 1 started node canceled when the time to finish ended" for a stop whose time to finish ended with nodes still
 * running (`graceExpired`, `cancelledCount`); "" otherwise (review 19:27Z rows 19, 31). Why the Workflow ended and the
 * step log's line say it the same way.
 */
function stoppedLimitText(data) {
    const count = Number.isSafeInteger(data?.cancelledCount) ? data.cancelledCount : 0;
    if (data?.graceExpired !== true || !count) return "";
    return ` · ${count === 1 ? "1 started node" : `${count} started nodes`} canceled when the time to finish ended`;
}

// The log's long forms are Markdown: a value an event carries is one inline code span, so it cannot become markup.
const filled = value => typeof value === "string" && value.trim() !== "";
/** A reason worth a line: filled, and more than a state word (review 19:27Z). */
const reasoned = value => filled(value) && workflowReasonShown(value) !== null;
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
    const who = workflowActorText(actor);
    return who ? ` by ${NOBODY_NAMED.has(who) ? who : span(who, 60)}` : "";
};
const stepOf = data => (text(data.stateId) ? `node ${data.stateId}` : "a node");
/** A Log line's node: its id, or "A node" (OF-S2-2 part 2: the id leads the line). */
const nodeOf = data => text(data.stateId) ?? "A node";
/** A Log line's time as people read it (D-W7): the clock on the same day; a time it cannot read stays as it is. */
const logTime = value => workflowShortTime(value) ?? value;
/** The Log's short form of a stop that ended with nodes still running: " · 1 started node canceled". */
function stoppedShort(data) {
    const count = Number.isSafeInteger(data?.cancelledCount) ? data.cancelledCount : 0;
    return data?.graceExpired === true && count ? ` · ${count === 1 ? "1 started node" : `${count} started nodes`} canceled` : "";
}

/** Its tooltip: how it was stopped, and why nodes were canceled ("… when the time to finish ended"). */
function stoppedTitle(data) {
    const count = Number.isSafeInteger(data?.cancelledCount) ? data.cancelledCount : 0;
    return `Canceled after started nodes finished${data?.graceExpired === true && count
        ? `; ${count === 1 ? "1 was" : `${count} were`} still running when the time to finish ended` : ""}`;
}

/**
 * One sentence table for the workflow's events (ui-05). `short` is the event's line in the activity list
 * ({ text, level }); `long` is its line in the session's step log ({ text, summary, color }, Markdown) for the run's
 * control events. An event without a form is not shown on that screen. Add an event once, here. The log's step, start
 * and end lines, which also write the definition table, stay in workflow-sessions.js.
 */
const WORKFLOW_EVENT_TEXT = {
    "workflow.started": { short: data => ({ text: `● ${data.mode === "test" ? "Test started" : "Started"}${Number.isSafeInteger(data.revision) ? ` · revision ${data.revision}` : ""}` }) },
    "workflow.paused": {
        short: data => ({ text: `Paused${because(data.reason)}`, level: "warning" }),
        long: data => ({ text: `⏸ Workflow paused${byWho(data.actor)}${reasoned(data.reason) ? `: ${span(data.reason, 200)}` : "."}`, summary: "paused", color: "yellow" }),
    },
    "workflow.resumed": {
        short: data => ({ text: `Resumed${because(data.reason)}` }),
        long: data => ({ text: `▶ Workflow resumed${byWho(data.actor)}${reasoned(data.reason) ? `: ${span(data.reason, 200)}` : "."}`, summary: "resumed", color: "gray" }),
    },
    "workflow.vars_set": {
        short: data => {
            const parts = [names(data.set) ? `set ${names(data.set)}` : "", names(data.deleted) ? `removed ${names(data.deleted)}` : ""].filter(Boolean);
            return { text: `Variables${parts.length ? ` · ${parts.join(" · ")}` : " changed"}` };
        },
        long: data => {
            const set = spanKeys(data.set), removed = spanKeys(data.deleted);
            const parts = [set ? `set ${set}` : "", removed ? `removed ${removed}` : ""].filter(Boolean);
            const revision = Number.isSafeInteger(data.kvRevision) ? ` · revision ${data.kvRevision}` : "";
            return { text: `✎ Variables updated${byWho(data.actor)}${revision}${parts.length ? `: ${parts.join(" · ")}` : ""}.`, summary: "variables updated", color: "gray" };
        },
    },
    "workflow.stop_requested": {
        short: data => ({ text: `Stop asked · started nodes may finish${text(data.deadlineAt) ? ` until ${logTime(data.deadlineAt)}` : ""}${because(data.reason)}`, level: "warning" }),
        // The step log's line (adversarial review R2-UI-6).
        long: data => ({ text: `⏹ Stop asked${byWho(data.actor)}: started nodes may finish${text(data.deadlineAt) ? ` until ${span(logTime(data.deadlineAt), 40)}` : ""}`
            + `${reasoned(data.reason) ? `. Reason: ${span(data.reason, 200)}` : "."}`, summary: "stop asked", color: "yellow" }),
    },
    "workflow.stopped": {
        // Review 18:45Z (D-W1): a stop reads Canceled; how it was stopped is the line's tooltip.
        short: data => ({ text: `⊘ Canceled${because(data.reason)}${stoppedShort(data)}`, title: stoppedTitle(data), level: "warning" }),
        // Review 19:27Z (row 31): no "stopped"; the kind of cancel, and the started nodes the time to finish canceled.
        long: data => ({ text: `⊘ Workflow canceled after started nodes finished${reasoned(data.reason) ? `: ${span(data.reason, 200)}` : ""}${stoppedLimitText(data)}.`,
            summary: "canceled", color: "yellow" }),
    },
    "workflow.cancel_requested": {
        short: data => {
            const count = Array.isArray(data.effects) ? data.effects.length : 0;
            return { text: `Cancel asked · ${count === 1 ? "1 running action" : `${count} running actions`}`, level: "warning" };
        },
        long: data => {
            const count = Array.isArray(data.effects) ? data.effects.length : 0;
            return { text: `⏹ Asked ${count} running action${count === 1 ? "" : "s"} to stop. They may take a moment to end.`,
                summary: `${count} action${count === 1 ? "" : "s"} asked to stop`, color: "yellow" };
        },
    },
    "workflow.cancelled": {
        short: data => ({ text: `⊘ Canceled${data.deleted === true || data.command === "delete" ? " · deleted" : ""}${because(data.reason)}`,
            title: "Canceled at once", level: "warning" }),
    },
    "workflow.completed": { short: data => ({ text: `✓ Completed${text(data.outcome) && data.outcome !== "succeeded" ? ` · ${data.outcome}` : ""}${text(data.stateId) ? ` at ${data.stateId}` : ""}` }) },
    "workflow.failed": { short: data => ({ text: `✕ Failed${text(data.stateId) ? ` at ${data.stateId}` : ""}${because(data.error)}`, level: "error" }) },
    "workflow.input_accepted": {
        // Review 18:45Z: no raw session id where a person reads it.
        short: data => ({ text: `Input${text(data.contract) ? ` ${data.contract}` : ""} accepted` }),
        // Review 19:27Z (row 32): the sender by its name, never its id.
        long: (data, options) => {
            const name = sessionNamed(options?.sessionName, data.senderSessionId);
            const from = name ? ` from ${span(name, 60)}` : "";
            const contract = filled(data.contract) ? ` ${span(data.contract, 80)}` : "";
            const claimed = filled(data.claimedBy);
            return { text: `✉ Input${contract}${from} accepted by the Workflow; ${claimed ? "a waiting receive node took it" : "it waits for a receive node"}.`,
                summary: claimed ? "input accepted and taken" : "input accepted", color: "gray" };
        },
    },
    "workflow.recovered": {
        short: () => ({ text: "Restart asked", level: "warning" }),
        // Review 19:27Z (row 32): "restart", not "recovery"; ↻ is the visit badge, so no mark; who asked by name, never an id.
        long: (data, options) => {
            const action = filled(data.action) ? data.action : null;
            // The event and its receipt are stored before the controller is started (service.ts), so it records a request, not a start.
            const what = action === "dispatched" ? "a restart was recorded; this does not show that it has started"
                : action ? `action ${span(action, 60)} recorded` : "it was recorded";
            const name = sessionNamed(options?.sessionName, data.requestedBy);
            return { text: `Restart asked${name ? ` by ${span(name, 60)}` : ""}: ${what}.`, summary: "restart asked", color: "yellow" };
        },
    },
    "workflow.parent_notified": {
        long: () => ({ text: "✉ Parent told the Workflow ended.", summary: "parent told the Workflow ended", color: "gray" }),
    },
    "workflow.parent_notification_skipped": {
        // Batch 7 (n-2): a live run's end the parent agent was not told of, and why ("notifications are off", "parent is gone").
        // After an earlier attempt that may have queued the notice (D-R1, earlierAttempt), it says so.
        short: data => ({ text: `Parent not told${because(data.reason)}.${data.earlierAttempt === true ? " An earlier attempt may have told it." : ""}`, level: "warning" }),
        long: data => {
            const reason = filled(data.reason) ? `: ${span(data.reason, 200)}` : "";
            const earlier = data.earlierAttempt === true ? `${reason ? "." : ""}${EARLIER_ATTEMPT}` : "";
            return { text: `✉ Parent not told the Workflow ended${reason || "."}${earlier}`, summary: "parent not told", color: "yellow" };
        },
    },
    "workflow.state_started": { short: data => ({ text: `● ${nodeOf(data)} started${Number.isSafeInteger(data.ordinal) && data.ordinal > 1 ? ` · visit ${data.ordinal}` : ""}` }) },
    "workflow.state_completed": { short: data => ({ text: `✓ ${nodeOf(data)}${text(data.outcome) ? ` · ${workflowOutcomeWord(data.outcome)}` : " done"}` }) },
    "workflow.state_failed": {
        short: data => {
            const error = parsedJson(data.error);
            // With no error text, what happened to its action, as the step log says it.
            const reason = error?.message ?? (error ? null : data.error) ?? (text(data.effectStatus) ? `the action ${data.effectStatus}` : null);
            if (data.outcome === "cancelled") return { text: `⊘ ${nodeOf(data)} canceled${because(reason)}`, level: "warning" };
            return { text: `✕ ${nodeOf(data)} · ${workflowFailureDetail(data.outcome)}${because(reason)}`, level: "error" };
        },
    },
    "workflow.state_cancelled": { short: data => ({ text: `⊘ ${nodeOf(data)} canceled`, level: "warning" }) },
    "workflow.agent_spawned": {
        // session: continue (owner decision agent-node-continue-20261106): a later visit's prompt goes to the same session.
        // Review 18:45Z: the agent node Log's own words, with the node first; no raw session id.
        short: data => ({ text: (data.session === "continue" && Number.isSafeInteger(data.cycle) && data.cycle > 1
            ? `${nodeOf(data)} · visit ${data.cycle} · same agent session` : `${nodeOf(data)} · agent session started`)
            + `${text(data.deadline) ? ` · limit ${logTime(data.deadline)}` : ""}` }),
    },
    "workflow.agent_ended": {
        short: data => ({ text: `${nodeOf(data)} · agent session ended${workflowAgentEndText(data.end) ? ` · ${workflowAgentEndText(data.end)}` : ""}`
            + (data.session === "continue" ? " · no more visits" : "") }),
    },
    "workflow.agent_cycle_ended": {
        short: data => ({ text: `${nodeOf(data)} · visit ended · agent session kept for the next visit`
            + (data.turnStopped === true ? " · turn stopped" : "") }),
    },
    "workflow.agent_session_restarted": {
        // Review 18:45Z: the same words as the agent node Log's line, after the node.
        short: data => ({ text: `${nodeOf(data)} · ${Number.isSafeInteger(data.cycle) ? `visit ${data.cycle}` : "this visit"} · new agent session`
            + " · the earlier one had ended", level: "warning" }),
    },
    // A continued session's owed end (formal t3): its last look found the session never seen, or another look holding its end (O2).
    "workflow.agent_end_failed": {
        short: data => (data.reason === "held_elsewhere"
            ? { text: `${nodeOf(data)} · agent session ending` }
            : data.reason === "not_visible"
                ? { text: `${nodeOf(data)} · agent session not found, so it was not ended · checked again later`, level: "warning" }
                : { text: `${nodeOf(data)} · ending the agent session failed · trying again`, level: "warning" }),
    },
    // Owner decision Q2: the agent session ended its turn without finishing its step, and was reminded to finish it.
    "workflow.agent_reminded": {
        short: data => ({ text: `${nodeOf(data)} · reminded to finish`
            + `${Number.isSafeInteger(data.n) && Number.isSafeInteger(data.max) ? ` · ${data.n}/${data.max}` : ""}` }),
    },
    "workflow.request_delivered": {
        short: data => ({ text: `Ask${text(data.contract) ? ` ${data.contract}` : ""} sent`
            + `${text(data.deadlineAt) ? ` · answer by ${logTime(data.deadlineAt)}` : ""}` }),
    },
    // FU-25 (stage 2.4): a script's tool call on the shared tool session, its real run window.
    "workflow.tool_call_started": {
        short: data => ({ text: `${`${nodeOf(data)} · tool ${Number.isSafeInteger(data.call) ? `${data.call} ` : ""}${text(data.tool) ?? ""}`.trimEnd()} started` }),
    },
    "workflow.tool_call_ended": {
        short: data => {
            const took = Number.isSafeInteger(data.durationMs) ? ` · ${workflowDuration(data.durationMs)}` : "";
            const what = `${nodeOf(data)} · tool ${Number.isSafeInteger(data.call) ? `${data.call} ` : ""}${text(data.tool) ?? ""}`.trimEnd();
            return data.ok === false
                ? { text: `${what} failed${took}${text(data.error) ? `: ${data.error}` : ""}`, level: "warning" }
                : { text: `${what} done${took}` };
        },
    },
    "workflow.response_wake_abandoned": {
        // Review 18:45Z: no engine words; an answer that arrived is not yet used.
        short: () => ({ text: "Answer arrived · the Workflow takes it next", level: "warning" }),
    },
    "workflow.branches_cancelled": {
        // Why, when it is not failFast: the join had its successes, or the parallel step's own time limit passed.
        // Named branches by their names.
        short: data => {
            const names = Array.isArray(data.branches) ? data.branches.filter(name => typeof name === "string" && name) : [];
            if (names.length) {
                const which = `${names.length === 1 ? "branch" : "branches"} ${names.join(", ")}`;
                return { text: data.reason === "join" ? `⊘ Canceled ${which} · the join had enough`
                    : data.reason === "timeout" ? `⊘ Canceled ${which} · the parallel node's limit passed`
                        : `⊘ Canceled ${which} · another branch failed`, level: "warning" };
            }
            return { text: data.reason === "join" ? "⊘ Other items canceled · the join had enough"
                : data.reason === "timeout" ? "⊘ Running items canceled · For each limit passed"
                    : "⊘ Other items canceled", level: "warning" };
        },
    },
    "workflow.test_intercepted": {
        short: data => ({ text: `Call${text(data.operation) ? ` ${data.operation}` : ""}${text(data.tool) ? ` · ${data.tool}` : ""}${text(data.stateId) ? ` in ${stepOf(data)}` : ""}` }),
    },
    "workflow.test_clock_advanced": { short: data => ({ text: `Test clock advanced${Number.isSafeInteger(data.seconds) ? ` by ${formatSeconds(data.seconds)}` : ""}` }) },
};

/**
 * One workflow event in one of the table's forms: "short" for the activity list ({ text, level }), "long" for the step
 * log ({ text, summary, color }); null when the event has no such form, so that screen does not show it. `options.sessionName`
 * (a function from a session id to its title) names a session a line mentions; without a name the line leaves it out.
 * Never throws for a malformed record. Pure.
 */
export function workflowEventText(type, data, form = "short", options = {}) {
    const row = typeof type === "string" && Object.hasOwn(WORKFLOW_EVENT_TEXT, type) ? WORKFLOW_EVENT_TEXT[type] : null;
    const write = row && (form === "short" || form === "long") ? row[form] : null;
    return write ? write(isRecord(data) ? data : {}, isRecord(options) ? options : {}) : null;
}

// ─── Stage 2.4: the replay (spec "Andrew's feedback": a read view over the stored visits; no new storage) ────────────────

const visitMs = value => { const ms = Date.parse(value ?? ""); return Number.isFinite(ms) ? ms : null; };

/**
 * The moments a run can be replayed at: each loaded visit's entry, in the order they ran (entry time, then visit
 * number, then id), with its step and visit number, and its branch when it ran in one. Pure.
 */
export function workflowReplayFrames(executions) {
    return (Array.isArray(executions) ? executions : [])
        .filter(item => isRecord(item) && typeof item.id === "string" && typeof item.stateId === "string" && visitMs(item.enteredAt) !== null)
        .map(item => ({ atMs: visitMs(item.enteredAt), nodeExecutionId: item.id, stateId: item.stateId,
            ordinal: Number.isSafeInteger(item.ordinal) ? item.ordinal : null,
            branchIndex: isRecord(item.branch) && Number.isSafeInteger(item.branch.index) ? item.branch.index : null,
            // A visit in a named branch, its branch's name.
            branchName: isRecord(item.branch) && typeof item.branch.name === "string" && item.branch.name ? item.branch.name : null }))
        .sort((a, b) => a.atMs - b.atMs || (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.nodeExecutionId.localeCompare(b.nodeExecutionId));
}

/**
 * A visit's delivery and intake as they stood at `atMs` (review S2UI-F6). A delivery shown as done needs a delivery time by
 * then, or a visit that had ended by then (a send ends on its delivery); otherwise it was still being delivered. A failure
 * has no time of its own, so a visit still running then shows it still being delivered. The recipient's later check is
 * shown only from its recorded time; one with no time is not shown. A message taken by a visit still running then had not
 * been taken. Pure.
 */
function deliveryAt(item, atMs, ended) {
    let changed = null;
    const outbox = isRecord(item.outbox) ? item.outbox : null;
    if (outbox) {
        let next = outbox;
        const delivered = visitMs(outbox.deliveredAt);
        const settled = outbox.state === "delivered" ? (delivered !== null ? delivered <= atMs : ended)
            : outbox.state === "failed" ? ended : true;
        if (!settled) next = { ...next, state: "pending", deliveredAt: null };
        if (next.intake) {
            const checked = visitMs(next.intake.at);
            if (checked === null || checked > atMs || !settled) { next = { ...next }; delete next.intake; }
        }
        if (next !== outbox) changed = { ...(changed ?? item), outbox: next };
    }
    if (!ended && isRecord(item.inbox)) {
        const taken = visitMs(item.inbox.claimedAt);
        if (taken === null || taken > atMs) { changed = { ...(changed ?? item) }; delete changed.inbox; }
    }
    return changed ?? item;
}

/**
 * The loaded visits as they stood at `atMs`: the ones entered by then, a visit that ended later shown still running, and
 * a send's delivery (and the recipient's check) only from when it happened. Pure.
 */
export function workflowExecutionsAt(executions, atMs) {
    return (Array.isArray(executions) ? executions : []).flatMap(item => {
        const entered = visitMs(item?.enteredAt);
        if (entered === null || entered > atMs) return [];
        const ended = visitMs(item.endedAt ?? item.completedAt);
        if (item.status !== "completed" || (ended !== null && ended <= atMs)) return [deliveryAt(item, atMs, item.status === "completed")];
        return [deliveryAt({ ...item, status: "pending", outcome: undefined, resultKind: undefined, outputPreview: undefined, errorPreview: undefined,
            errorWords: undefined, winner: undefined, endedAt: undefined, completedAt: undefined }, atMs, false)];
    });
}

/**
 * Review S2UI-F5: the branch whose visit a replay shows, for that step's Node details: the branch whose visit then is the
 * replayed visit, else the replayed visit's branch number when that branch is listed. Null for another step, a step with
 * no branches, or no replay. Pure.
 */
export function workflowReplayBranchIndex(node, frame) {
    if (!isRecord(node) || !isRecord(frame) || node.id !== frame.stateId) return null;
    const choices = isRecord(node.branches) && Array.isArray(node.branches.choices) ? node.branches.choices : [];
    const visit = choices.find(choice => choice?.execution?.id === frame.nodeExecutionId);
    if (visit) return visit.index;
    return Number.isSafeInteger(frame.branchIndex) && choices.some(choice => choice?.index === frame.branchIndex) ? frame.branchIndex : null;
}

/** The last moment of the loaded visits (the latest entry or end), or -Infinity. */
export function workflowLastMoment(executions) {
    let last = -Infinity;
    for (const item of Array.isArray(executions) ? executions : []) {
        for (const value of [item?.enteredAt, item?.endedAt, item?.completedAt]) {
            const ms = visitMs(value);
            if (ms !== null && ms > last) last = ms;
        }
    }
    return last;
}

/**
 * A replay frame in words (OF-S2-2 part 2): its local time (the clock on the same day), then the node's run ("poll run 2")
 * and, in a For each, its item ("item 3"). Its full time is workflowTimeTitle(frame.atMs).
 */
export function workflowReplayLabel(frame) {
    if (!frame) return "";
    const at = workflowShortTime(frame.atMs);
    const visit = frame.ordinal !== null ? `${frame.stateId} visit ${frame.ordinal}` : frame.stateId;
    const branch = typeof frame.branchName === "string" && frame.branchName ? `branch ${frame.branchName}`
        : frame.branchIndex !== null ? `item ${frame.branchIndex + 1}` : null;
    return [at, visit, branch].filter(Boolean).join(" · ");
}

/**
 * Who did what and when in a workflow (owner decision q14; mock M09 "Inspect audit"): the workflow session's own events,
 * newest first, as plain lines { seq, at, what, who, level }, for one run (`runId`) and, when given, one visit of a step
 * (`nodeExecutionId`); at most `limit`. Only what the events record is shown: who acted is named where the event names
 * them (a pause, a resume, a variables change, a stop). Pure.
 */
export function workflowActivity(events, { runId = null, nodeExecutionId = null, limit = ACTIVITY_LIMIT } = {}) {
    const rows = [];
    for (const event of Array.isArray(events) ? events : []) {
        if (!isRecord(event) || typeof event.eventType !== "string") continue;
        const data = isRecord(event.data) ? event.data : {};
        if (runId !== null && data.runId !== runId) continue;
        if (nodeExecutionId !== null && data.nodeExecutionId !== nodeExecutionId) continue;
        const line = workflowEventText(event.eventType, data, "short");
        if (!line) continue;
        rows.push({ seq: Number.isSafeInteger(event.seq) ? event.seq : null, at: workflowShortTime(event.createdAt), atTitle: workflowTimeTitle(event.createdAt), what: line.text,
            who: workflowActorText(data.actor), level: line.level ?? "info", ...(line.title ? { title: line.title } : {}),
            // Stage 2.4: the visit a line is about (the replay moves to it, and it to the replay's visit).
            eventType: event.eventType, nodeExecutionId: typeof data.nodeExecutionId === "string" ? data.nodeExecutionId : null });
    }
    return rows.reverse().slice(0, Math.max(0, limit));
}

/** Review S2UI-F7: the most lines the Workflow Log lists at once. */
export const WORKFLOW_LOG_LIMIT = 200;

/**
 * Review S2UI-F7: the Workflow Log's lines to list, from all its loaded lines (`rows`, newest first, workflowActivity):
 * the newest `limit`, or, while a replayed visit's (`current`) started line is older than those, the `limit` lines around
 * it. { rows, found, around }: `found` when that visit's line is among the loaded lines, `around` when the lines listed
 * are not the newest. Pure.
 */
export function workflowLogWindow(rows, current, limit = WORKFLOW_LOG_LIMIT) {
    const list = Array.isArray(rows) ? rows : [];
    const at = current ? list.findIndex(row => row?.eventType === "workflow.state_started" && row.nodeExecutionId === current) : -1;
    if (at < limit) return { rows: list.slice(0, limit), found: at >= 0, around: false };
    const start = Math.max(0, Math.min(at - Math.floor(limit / 2), list.length - limit));
    return { rows: list.slice(start, start + limit), found: true, around: true };
}

/**
 * The events the Workflow Log panel lists (W10; review SF-D5): the Workflow's own notices (no run id) and, of its runs,
 * the shown run's (`runId`, when there is one). A run's events show only when the server's read model lists that run
 * as live (`runs`, each with its `mode`; with test mode off the server lists no test run), so a test run's events stay
 * hidden even when its workflow.started is not in the loaded window. Before the read model is loaded (`runs` not a
 * list): only the shown run's events, never a run a loaded workflow.started marks as a test. Pure.
 */
export function workflowLogEvents(events, { runId = null, runs = null } = {}) {
    const list = Array.isArray(events) ? events : [];
    const live = Array.isArray(runs)
        ? new Set(runs.filter(run => isRecord(run) && run.mode === "live" && typeof run.runId === "string").map(run => run.runId))
        : null;
    const tests = new Set(list.filter(event => event?.eventType === "workflow.started" && isRecord(event.data) && event.data.mode
        && event.data.mode !== "live").map(event => event.data.runId));
    return list.filter(event => {
        const id = isRecord(event) && isRecord(event.data) ? event.data.runId ?? null : null;
        if (id === null) return true;
        if (runId !== null && id !== runId) return false;
        return live !== null ? live.has(id) : runId !== null && !tests.has(id);
    });
}

const ENDED_STATUSES = new Set(["completed", "failed", "cancelled", "stopped"]);

/**
 * Why a run ended (owner decision q14; mock M14 "Inspect cancellation"): from the run as the read shows it and its end
 * events: completed at its last step; failed at a step or by a runtime error (its message); cancelled, with the reason
 * and who asked when the record names them, or because the workflow was deleted; stopped, with the reason, who asked
 * and what was still running when the time to finish ended. { status, why, who, at, text }, or null while it runs. Pure.
 */
export function workflowRunEnding(run, events = [], sessionName = null) {
    if (!isRecord(run) || !ENDED_STATUSES.has(run.status)) return null;
    const mine = (Array.isArray(events) ? events : []).filter(event => isRecord(event) && isRecord(event.data) && event.data.runId === run.runId);
    const last = type => mine.findLast(event => event.eventType === type) ?? null;
    const envelope = parsedJson(run.error);
    const details = isRecord(envelope?.details) ? envelope.details : {};
    // Review 19:27Z (rows 18 to 20): the kind of cancel is in the line, a reason that is only a state word is left out, who
    // asked is named by name (never an id), and the time is the one short form.
    let why, who = null, end = null;
    if (run.status === "completed") {
        end = last("workflow.completed");
        why = `Reached ${run.terminalState ?? "the end"}${text(run.outcome) ? ` · ${workflowOutcomeWord(run.outcome)}` : ""}`;
    } else if (run.status === "failed") {
        end = last("workflow.failed");
        why = text(run.terminalState) ? `Reached ${run.terminalState} · ${workflowOutcomeWord(run.outcome ?? "failed")}`
            : `Error${text(envelope?.code) ? ` · ${workflowFailureDetail(envelope.code)}` : ""}${because(envelope?.message)}`;
    } else if (run.status === "cancelled") {
        end = last("workflow.cancelled");
        const deleted = end?.data.deleted === true || end?.data.command === "delete" || details.command === "delete";
        why = `${deleted ? "Canceled · deleted" : "Canceled at once"}${because(end?.data.reason ?? envelope?.message)}`;
        who = sessionNamed(sessionName, details.requestedBy);
    } else {
        end = last("workflow.stopped");
        const asked = last("workflow.stop_requested");
        why = `Canceled after started nodes finished${because(end?.data.reason ?? asked?.data.reason ?? run.stop?.reason)}${stoppedLimitText(end?.data)}`;
        who = workflowActorText(asked?.data.actor);
    }
    const at = workflowShortTime(end?.createdAt);
    return { status: run.status, why, who, at, text: `Why it ended: ${why}${who ? ` · by ${who}` : ""}${at ? ` · ${at}` : ""}` };
}

/** How a branch cancelled by a branch-cancelling decision stands, by its step's winner (owner decision join-k-of-n). */
const BRANCH_CANCELS = { join_timeout: "canceled · limit", join: "canceled · join met", fail_fast: "canceled" };
/**
 * A branch whose last step finished but whose next step never started (J1b "finished"; its result is kept): how it
 * stands and why, by what came first: the time limit, the join, the join's block (failFast), or the run's own end ("").
 */
const FINISHED_BEFORE = {
    join_timeout: { status: "ok · limit passed", why: "the limit passed before its next node started" },
    join: { status: "ok · join met", why: "the join already had the successes it needs, so its next node did not start" },
    fail_fast: { status: "ok · join blocked", why: "the join was blocked, so its next node did not start" },
    "": { status: "ok · Workflow ended", why: "the Workflow ended before its next node started" },
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

/**
 * A visit canceled by what came first, in the Workflow's words (no "stopped"; a time limit is "limit"). Review 21:15Z gave
 * the stop's sentence.
 */
const VISIT_WINNERS = {
    cancel: "The Workflow was canceled while it ran",
    stop: "The Workflow was canceled after started nodes finished; this node had not finished when the time to finish ended",
    deadline: "The Workflow's limit passed",
    fail_fast: "Another item failed, so this one was canceled",
    // Owner decision join-k-of-n: a join of the first k that had its successes, and a parallel node's own limit.
    join: "The join already had the successes it needs, so this item was canceled",
    join_timeout: "The For each node's limit passed, so this item was canceled",
};
/** The same, for a visit in a named branch ("branch" where a For each says "item"). */
const NAMED_VISIT_WINNERS = {
    ...VISIT_WINNERS,
    fail_fast: "Another branch failed, so this one was canceled",
    join: "The join already had the successes it needs, so this branch was canceled",
    join_timeout: "The parallel node's limit passed, so this branch was canceled",
};

/**
 * Why one visit of a step ended (owner decision q14; mock M14): its time limit, the run's cancellation, stop or time
 * limit, another branch's failure, its outcome, or a runtime error with its message; for an agent step, how its session was
 * ended. { why, detail, agent, text }, or null for a visit that has not ended. Pure.
 */
export function workflowVisitEnding(execution) {
    if (!isRecord(execution) || execution.status !== "completed") return null;
    const error = parsedJson(execution.errorPreview);
    let why;
    const winners = typeof execution.branch?.name === "string" && execution.branch.name ? NAMED_VISIT_WINNERS : VISIT_WINNERS;
    const byWinner = execution.outcome !== "timed_out" && Boolean(winners[execution.winner]);
    // Review 19:27Z: in the Workflow's words: "Its limit passed", "Done · accepted", "Error · crashed".
    if (execution.outcome === "timed_out") why = "Its limit passed";
    else if (byWinner) why = winners[execution.winner];
    else if (execution.resultKind === "business") why = `Done · ${workflowOutcomeWord(execution.outcome)}`;
    else if (execution.resultKind === "runtime_error") why = `Error · ${workflowFailureDetail(execution.outcome ?? text(error?.code))}`;
    else why = "Outcome not recorded";
    const detail = !byWinner && execution.resultKind === "runtime_error" && text(error?.message) ? clipped(error.message) : null;
    const end = isRecord(execution.agent) ? workflowAgentEndText(execution.agent.end) : null;
    const agent = end ? `Agent session ended · ${end}.` : null;
    const said = `${why}${detail ? `: ${detail}` : ""}`;
    return { why, detail, agent, text: `${/[.!?]$/.test(said) ? said : `${said}.`}${agent ? ` ${agent}` : ""}` };
}

/** How an agent step's session ended, in the words every screen uses: "cancelled" or "its result was taken"; null for none. Pure. */
export function workflowAgentEndText(end) {
    return end === "cancel" ? "canceled" : end === "done" ? "result taken" : null;
}

/**
 * The sessions under a step (owner decision q14; mock M14 "View owned subtree"): its agent session (`rootId`) and every
 * session started under it, from the session rows loaded (`byId`), each with its title, status and depth (the session 0),
 * in tree order; at most `limit`. Sessions not loaded here are not shown. Pure.
 */
export function workflowSessionSubtree(byId, rootId, limit = 50) {
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
 * step, its agent session (`agent`, the session id). Owner decision join-k-of-n: how it stands is running, queued,
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
 * `index` and `blocking` count from 0 (the data's); people read them through workflowBranchNumber. Pure.
 */
export function workflowBranchEvidence(executions, states, parallel, complete = true, node = null) {
    if (!isRecord(parallel) || !Number.isSafeInteger(parallel.branches) || parallel.branches < 0) return null;
    const names = Array.isArray(node?.namedBranches) ? node.namedBranches.map(item => item.name) : null;
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
            rows.push({ index, status: !complete ? "not loaded" : parallel.status === "pending" ? "waiting" : "not started",
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
        // A cancellation is a recorded end even when its error has a recovery route (re-check RC-8: as the branch counts say).
        const status = pending || (routed && cancelledBy === null && parallel.status === "pending") ? "running"
            : late ? "ok · after the limit" : succeeded ? "ok"
                : cancelledBy ?? (cut === null ? "failed" : FINISHED_BEFORE[cut].status);
        if (status === "ok" || finishedSuccess) counted.add(index);
        const why = status === "running" || status === "ok" ? null
            : late ? "It succeeded after the limit, so it did not count"
                : terminal ? `Ended at ${last.stateId} · ${workflowOutcomeWord(state.outcome)}`
                    : cut !== null ? `Node ${last.stateId} finished · ${workflowOutcomeWord(last.outcome)}, but ${FINISHED_BEFORE[cut].why}`
                        + `${finishedSuccess ? "; its success counts" : ""}`
                        // Review NB-R7: a named branch's rows say "branch", as its visits' endings do.
                        : (names ? NAMED_VISIT_WINNERS : VISIT_WINNERS)[last.winner] ?? (last.resultKind === "runtime_error"
                            ? `Error · ${workflowFailureDetail(last.outcome ?? text(error?.code))}${because(error?.message)}`
                            : `It stopped at node ${last.stateId}`);
        const preview = typeof last.outputPreview === "string" && last.outputPreview && last.outputPreview !== "null" ? clipped(last.outputPreview, 160) : null;
        rows.push({ index, status, step: last.stateId, outcome: last.outcome ?? null,
            result: preview, why, deadline: pending && typeof pending.deadline === "string" && pending.deadline ? pending.deadline : null,
            // Its agent session, once created (as the step's Agent session opens it).
            agent: isRecord(last.agent) && last.agent.spawned === true && typeof last.agent.childSessionId === "string" && last.agent.childSessionId
                ? last.agent.childSessionId : null });
    }
    const blocked = parallel.status === "completed" && parallel.outcome === "blocked";
    const count = status => rows.filter(row => row.status === status).length;
    const first = workflowJoinFirst(node);
    return {
        total: parallel.branches, needed: first ?? parallel.branches, succeeded: counted.size, running: count("running"), queued: count("waiting"),
        // The time limit ended it: timed_out, or blocked once k could no longer happen by then (J1b, Q3).
        blocked, timedOut: parallel.status === "completed" && (parallel.outcome === "timed_out" || (blocked && limitPassed)),
        // It joined after its time limit passed: the successes saved before it still joined (J1b, Q1).
        joinedAfterLimit: parallel.status === "completed" && parallel.outcome === "joined" && limitPassed,
        blocking: blocked ? rows.filter(row => !counted.has(row.index)).map(row => row.index) : [],
        // A named-branch state's branch names (by index), and each row's.
        ...(names ? { names } : {}), rows: names ? rows.map(row => ({ ...row, name: names[row.index] ?? null })) : rows,
    };
}

/** Keep graph topology independent of the viewport; narrow views pan or zoom. */
export function layoutWorkflowGraph(definition, availableWidth = 640) {
    const nodes = definition?.states || [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    // A parallel state (workflow) also leads to its body's first state: each branch starts there.
    const branchStart = node => node?.type === "parallel" && typeof node.body?.initial === "string" && byId.has(node.body.initial) ? node.body.initial : null;
    const successors = id => [...new Set([...Object.values(byId.get(id)?.next || {}), ...(branchStart(byId.get(id)) ? [branchStart(byId.get(id))] : [])])]
        .filter(target => byId.has(target));
    const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), component = new Map();
    let nextIndex = 0, componentCount = 0;
    // Collapse cycles before ranking so reconverging DAG paths retain their
    // depth, without iterating forever on loops.
    const visit = id => {
        indices.set(id, nextIndex); low.set(id, nextIndex++);
        stack.push(id); onStack.add(id);
        for (const target of successors(id)) {
            if (!indices.has(target)) {
                visit(target);
                low.set(id, Math.min(low.get(id), low.get(target)));
            } else if (onStack.has(target)) {
                low.set(id, Math.min(low.get(id), indices.get(target)));
            }
        }
        if (low.get(id) === indices.get(id)) {
            let member;
            do {
                member = stack.pop(); onStack.delete(member); component.set(member, componentCount);
            } while (member !== id);
            componentCount++;
        }
    };
    for (const node of nodes) if (!indices.has(node.id)) visit(node.id);
    const outgoing = Array.from({ length: componentCount }, () => new Set());
    const indegree = Array(componentCount).fill(0), componentRank = Array(componentCount).fill(0);
    for (const node of nodes) for (const target of successors(node.id)) {
        const from = component.get(node.id), to = component.get(target);
        if (from !== to && !outgoing[from].has(to)) { outgoing[from].add(to); indegree[to]++; }
    }
    const queue = indegree.flatMap((degree, id) => degree === 0 ? [id] : []);
    for (let i = 0; i < queue.length; i++) for (const to of outgoing[queue[i]]) {
        componentRank[to] = Math.max(componentRank[to], componentRank[queue[i]] + 1);
        if (--indegree[to] === 0) queue.push(to);
    }
    const ranks = new Map(nodes.map(node => [node.id, componentRank[component.get(node.id)]]));
    const edges = [];
    const pairs = new Map();
    for (const node of nodes) {
        for (const [outcome, target] of Object.entries(node.next || {})) {
            if (!byId.has(target)) continue;
            const pair = JSON.stringify([node.id, target]);
            if (pairs.has(pair)) {
                const edge = pairs.get(pair);
                edge.outcomes.push(outcome);
                edge.outcome = edge.outcomes.join(" / ");
                continue;
            }
            const edge = { from: node.id, to: target, outcome, outcomes: [outcome] };
            pairs.set(pair, edge);
            edges.push(edge);
        }
        const start = branchStart(node);
        if (start && !pairs.has(JSON.stringify([node.id, start]))) {
            const edge = { from: node.id, to: start, outcome: "each branch", outcomes: [], branch: true };
            pairs.set(JSON.stringify([node.id, start]), edge);
            edges.push(edge);
        }
    }
    const nodeWidth = 202, nodeHeight = 66, gap = 100, margin = 40;
    const rows = Array.from({ length: Math.max(0, ...ranks.values()) + 1 },
        (_, rank) => nodes.filter(node => ranks.get(node.id) === rank));
    const rowEdges = rows.map((_, rank) => edges.filter(edge => ranks.get(edge.from) === rank));
    const outerEdges = edges.filter(edge => ranks.get(edge.to) !== ranks.get(edge.from) + 1);
    const arrivals = rows.map((_, rank) => outerEdges.filter(edge => ranks.get(edge.to) === rank));
    const contentWidth = Math.max(300, availableWidth,
        Math.max(1, ...rows.map(row => row.length)) * (nodeWidth + gap) - gap + margin * 2);
    const width = contentWidth + (outerEdges.length ? outerEdges.length * 22 + 60 : 0);
    const positions = new Map();
    let y = 40 + arrivals[0].length * 20;
    rows.forEach((row, rank) => {
        const left = (contentWidth - (row.length * nodeWidth + Math.max(0, row.length - 1) * gap)) / 2;
        row.forEach((node, index) => positions.set(node.id, {
            x: left + index * (nodeWidth + gap), y, width: nodeWidth, height: nodeHeight,
        }));
        y += nodeHeight + Math.max(100, (rowEdges[rank].length + (arrivals[rank + 1]?.length || 0)) * 20 + 48);
    });
    for (const edge of edges) {
        const from = positions.get(edge.from), to = positions.get(edge.to);
        const siblings = edges.filter(item => item.from === edge.from);
        const incoming = edges.filter(item => item.to === edge.to);
        const sx = from.x + nodeWidth * (siblings.indexOf(edge) + 1) / (siblings.length + 1);
        const tx = to.x + nodeWidth * (incoming.indexOf(edge) + 1) / (incoming.length + 1);
        const track = from.y + nodeHeight + 24 + rowEdges[ranks.get(edge.from)].indexOf(edge) * 20;
        const outside = outerEdges.indexOf(edge);
        const arrival = to.y - 24 - arrivals[ranks.get(edge.to)].indexOf(edge) * 20;
        // Skip/back edges travel outside every node column. Their segments
        // cannot masquerade as an outgoing edge from an intervening terminal.
        const points = outside < 0
            ? [[sx, from.y + nodeHeight], [sx, track], [tx, track], [tx, to.y]]
            : [[sx, from.y + nodeHeight], [sx, track], [contentWidth + 22 + outside * 22, track],
                [contentWidth + 22 + outside * 22, arrival], [tx, arrival], [tx, to.y]];
        edge.points = points;
        edge.path = points.map(([x, yy], i) => `${i ? "L" : "M"}${x},${yy}`).join(" ");
        edge.labelX = outside < 0 ? (sx + tx) / 2 : (sx + points[2][0]) / 2;
        edge.labelY = track - 5;
    }
    const layout = { width, height: Math.max(150, y), positions, edges };
    return Array.isArray(definition?.states) ? annotateWorkflowEdges(definition, layout) : layout;
}

/**
 * The workflow view's read models for its current run selection
 * (`selectedRunId`, null for the live run), shaped as projectWorkflow
 * takes them: `readModel` and its watermark only when they were read for
 * that selection (a model read for another run is never overlaid), and
 * `workflowModel`, the last model read for any selection, whose
 * workflow-wide parts (the graph or that there is none, the definition, the
 * revision, the runs) stay authoritative while the selection's own model is
 * loading or failed; and the failure of that selection's last request, if
 * any.
 */
export function workflowReadModelView(view = {}) {
    const selection = view.selectedRunId ?? null;
    const own = view.readModel != null && (view.readModelRunId ?? null) === selection;
    const attempted = view.readModelAttempt != null && (view.readModelAttempt.runId ?? null) === selection;
    return {
        selectedRunId: selection,
        readModel: own ? view.readModel : null,
        readModelAfterSeq: own && Number.isSafeInteger(view.readModelAfterSeq) ? view.readModelAfterSeq : null,
        workflowModel: view.readModel != null ? view.readModel : null,
        error: attempted && typeof view.readModelError === "string" && view.readModelError ? view.readModelError : null,
    };
}

const detailText = value => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * What the session details box shows for a workflow session (batch 8, d-1) instead of a session's model, context, cron and
 * agent rows: from what the portal already holds, the session row and, once the workflow screen has read them, the
 * workflow's view (its last read model, else its definition). Nothing is fetched for it. Each value is a string, or null
 * when it is not loaded (the box shows "—"):
 * - `workflow`: its name and version (the read model's revision name and semver, else the definition's), else the title
 *   without its "Workflow: " prefix;
 * - `revision`: "N · draft" or "N · published" (the published revision of a published workflow);
 * - `run`: the Workflow's state in its one word and its outcome ("Completed · succeeded"), "Not started" before any run, "Not
 *   started · tests only" when only test runs exist (review 19:27Z: never the raw status);
 * - `steps`: how many steps its graph has;
 * - `startedBy`: { sessionId, title } of the parent session (title null when its row is not loaded), or null for a
 *   workflow a person started.
 * Pure.
 */
export function workflowSessionDetails(state, session) {
    const sessionId = typeof session?.sessionId === "string" ? session.sessionId : null;
    const view = sessionId ? state?.ui?.workflowViews?.[sessionId] ?? null : null;
    const model = view ? workflowReadModelView(view).workflowModel : null;
    const definition = view?.definition ?? null;
    const name = detailText(model?.revision?.name) ?? detailText(definition?.name)
        ?? detailText(String(session?.title ?? "").replace(/^Workflow:\s*/u, ""));
    const version = detailText(model?.definition?.semver) ?? detailText(definition?.version);
    const lifecycle = model?.definition?.state;
    const number = lifecycle === "published" ? model.definition.publishedRevision : model?.definition?.currentRevision;
    const revision = (lifecycle === "draft" || lifecycle === "published") && Number.isSafeInteger(number) ? `${number} · ${lifecycle}`
        : lifecycle === "deleted" ? "deleted" : null;
    const runs = Array.isArray(model?.runs) ? model.runs.filter(run => run && typeof run === "object") : null;
    const live = runs ? runs.find(run => run.mode === "live") ?? null : null;
    const run = live ? [workflowRunStateWord(detailText(live.status)) ?? "Not certain", detailText(live.outcome) ? workflowOutcomeWord(live.outcome) : null]
        .filter(Boolean).join(" · ")
        : runs ? (runs.length ? "Not started · tests only" : "Not started") : null;
    const states = Array.isArray(model?.graph?.states) ? model.graph.states : Array.isArray(definition?.states) ? definition.states : null;
    const parentId = typeof session?.parentSessionId === "string" && session.parentSessionId ? session.parentSessionId : null;
    const parent = parentId ? state?.sessions?.byId?.[parentId] ?? null : null;
    return {
        workflow: name ? (version ? `${name} ${version}` : name) : null,
        revision,
        run,
        steps: states ? String(states.length) : null,
        startedBy: parentId ? { sessionId: parentId, title: detailText(parent?.title) } : null,
    };
}

/**
 * The workflow an agent session runs a step of (batch 8, d-1: a "Workflow step" session's details say "Step of"): its
 * direct parent, when that is a workflow session, as { sessionId, title }; else null. Pure.
 */
export function workflowStepParent(state, session) {
    const parentId = typeof session?.parentSessionId === "string" && session.parentSessionId ? session.parentSessionId : null;
    if (!parentId || session?.sessionKind === "workflow" || session?.isGroup) return null;
    const parent = state?.sessions?.byId?.[parentId] ?? null;
    return parent?.sessionKind === "workflow" ? { sessionId: parentId, title: detailText(parent.title) } : null;
}

/** The view of a workflow the portal has not read anything for yet: one object, so selections of it compare equal. */
export const EMPTY_WORKFLOW_VIEW = Object.freeze({});

/**
 * Whether a workflow's parent agent is working (owner batch 7, H1): its session row (`parent`) is "running", as the
 * session list steadies it (5 s hold): its steadied status (`rowVisualStatus`) when it has one, else its status. The
 * hold is kept on purpose (review UI7-1): between two turns of the parent close together the screen does not flash the
 * invalid state, and the calm state may stay up to 5 s after the parent stops. A wait, a schedule or an idle session
 * is not working. Pure.
 */
export function workflowParentWorking(parent) {
    return (parent?.rowVisualStatus || parent?.status) === "running";
}

/**
 * Everything the workflow screen shows for the active session, read from one state in one selector (adversarial review
 * UI-1): the session's id and its row, history, workflow view and saved step places, and whether its parent
 * agent is working (H1). Each part is derived from the same id, so a render never pairs one session's id with another's
 * view (separate selectors, each closing over the id of the last render, did: a newly selected workflow's YAML editor
 * could start with the previous one's YAML). Pure.
 */
export function selectWorkflowViewSnapshot(state) {
    return selectWorkflowViewSnapshotFor(state, state?.sessions?.activeSessionId ?? null);
}

/**
 * The same parts for one workflow session, active or not (Workflow Simplified: a session's Workflow tab shows its
 * Workflows while the session's own session is the active session). Pure.
 */
export function selectWorkflowViewSnapshotFor(state, workflowSessionId) {
    const sessionId = typeof workflowSessionId === "string" && workflowSessionId ? workflowSessionId : null;
    const session = sessionId ? state?.sessions?.byId?.[sessionId] : undefined;
    const parentId = typeof session?.parentSessionId === "string" && session.parentSessionId ? session.parentSessionId : null;
    return {
        sessionId,
        session,
        history: sessionId ? state.history?.bySessionId?.get?.(sessionId) : undefined,
        view: (sessionId ? state.ui?.workflowViews?.[sessionId] : null) || EMPTY_WORKFLOW_VIEW,
        places: (sessionId ? state.ui?.workflowLayouts?.[`session:${sessionId}`]?.steps : null) ?? null,
        parentWorking: parentId ? workflowParentWorking(state.sessions.byId?.[parentId]) : false,
    };
}

/** Whether two snapshots (selectWorkflowViewSnapshot) hold the same parts. */
export function workflowViewSnapshotEqual(a, b) {
    return a === b || (Boolean(a) && Boolean(b) && a.sessionId === b.sessionId && a.session === b.session && a.history === b.history
        && a.view === b.view && a.places === b.places && a.parentWorking === b.parentWorking);
}

/**
 * Which entries a workflow's step log shows (adversarial reviews UI-8 and R2-UI-3), from the same selection-bound read
 * the graph uses (workflowReadModelView), never a read of another selection:
 * - `run`: the run the person chose, else the live run the read of that selection names (`runId`);
 * - `loading`: the live run was chosen and its read has not come back (a read of another run may still be held);
 * - `none`: the read came back, and there is no live run, but test runs exist (a draft with only test runs);
 * - `empty`: the read came back, and the workflow has no run at all (its runs list is empty): there is no run to choose;
 * - `failed`: the read failed (`error`);
 * - `all`: nothing at all known yet about the workflow (its log is not filtered).
 * A known definition makes the log a run's from the first open (re-check RC-2): before its first read comes back it is
 * `loading`, never `all`. In `loading`, `none`, `empty` and `failed` the log shows only the session's own notices,
 * never any run's entries; `empty` adds no line of its own, so a log with no notices says "No step output yet." (g-06). Pure.
 */
export function workflowStepLogScope(view) {
    if (!view || typeof view !== "object") return { kind: "all" };
    if (typeof view.selectedRunId === "string" && view.selectedRunId) return { kind: "run", runId: view.selectedRunId };
    const known = view.definition != null || view.readModel != null || view.readModelAttempt != null || Object.hasOwn(view, "selectedRunId");
    if (!known) return { kind: "all" };
    const read = workflowReadModelView(view);
    if (read.readModel) {
        const runId = read.readModel.run?.runId;
        if (typeof runId === "string" && runId) return { kind: "run", runId };
        const runs = Array.isArray(read.readModel.runs) ? read.readModel.runs.filter(run => run && typeof run === "object") : [];
        return runs.length ? { kind: "none" } : { kind: "empty" };
    }
    if (read.error) return { kind: "failed", error: read.error };
    return { kind: "loading" };
}

/** The run a workflow's step log shows (workflowStepLogScope), or null when it shows no one run. Pure. */
export function workflowStepLogRunId(view) {
    const scope = workflowStepLogScope(view);
    return scope.kind === "run" ? scope.runId : null;
}

/**
 * The line a step log shows in place of a run's entries, for a scope that has none (R2-UI-3). None for `empty`: with no
 * run at all there is nothing to choose, and the empty log's own words say there is no output (S8-UI).
 */
export function workflowStepLogNotice(scope) {
    if (scope?.kind === "loading") return "Loading the live run's log…";
    if (scope?.kind === "none") return "No live run yet. Choose a test run to see its log.";
    if (scope?.kind === "failed") return `The live run could not be read, so its log is not shown: ${scope.error}`;
    return null;
}

/**
 * A workflow session's history for its step log (UI-8, R2-UI-3), for `scope` (workflowStepLogScope; a run id, or null
 * for every entry, as before): a run's entries and every entry that names no run (the session's own notices); for a
 * scope with no run, only those notices and a line that says why (workflowStepLogNotice). The same history object when
 * nothing is left out or added. Pure.
 */
export function workflowStepLogHistory(history, scope) {
    const resolved = typeof scope === "string" ? (scope ? { kind: "run", runId: scope } : { kind: "all" })
        : scope && typeof scope === "object" ? scope : { kind: "all" };
    if (resolved.kind === "all" || !history || !Array.isArray(history.chat)) return history;
    const runId = resolved.kind === "run" ? resolved.runId : null;
    const chat = history.chat.filter(item => !item?.workflowRunId || (runId !== null && item.workflowRunId === runId));
    const notice = workflowStepLogNotice(resolved);
    if (notice) {
        chat.push({ id: `workflow-step-log:${resolved.kind}`, role: "system", text: notice, time: "", workflowStepLogNotice: resolved.kind });
        return { ...history, chat };
    }
    return chat.length === history.chat.length ? history : { ...history, chat };
}
