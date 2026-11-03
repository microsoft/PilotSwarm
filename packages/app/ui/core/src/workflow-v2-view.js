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
 * run.pages): node executions, inbox, outbox and a test run's intercepted effects. A read model without run.pages is an
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
    return new Error(`State '${node.id}' is not a valid workflow v2 ${node.type} state: ${why}.`);
}

function checkState(node) {
    if (node.type === "terminal") {
        if (!TERMINAL_OUTCOMES.has(node.outcome)) throw invalidState(node, "its outcome is unknown");
        return;
    }
    if (!isRecord(node.next)) throw invalidState(node, "it has no transitions");
    for (const target of Object.values(node.next)) if (typeof target !== "string") throw invalidState(node, "a transition is not a state id");
    if (!Array.isArray(node.outcomes) || node.outcomes.some(outcome => typeof outcome !== "string")) throw invalidState(node, "it lists no outcomes");
    if (node.type === "wait" && typeof node.seconds !== "number" && typeof node.seconds !== "string") throw invalidState(node, "it has no duration");
    if (node.type === "messaging" && (!MESSAGING_MODES.has(node.mode) || typeof node.contract !== "string")) {
        throw invalidState(node, "its messaging mode or contract is unknown");
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
    if (!isRecord(data) || !Array.isArray(data.states) || !data.states.length) throw new Error("The workflow definition has no states.");
    const ids = new Set();
    for (const node of data.states) {
        if (!isRecord(node) || typeof node.id !== "string" || !node.id || !STATE_TYPES.has(node.type)) {
            throw new Error("The workflow definition contains an invalid or unsupported state.");
        }
        if (ids.has(node.id)) throw new Error(`The workflow definition repeats state '${node.id}'.`);
        ids.add(node.id);
        checkState(node);
    }
    const initial = data.initial || data.states[0].id;
    if (!ids.has(initial)) throw new Error("The workflow's initial state is not defined.");
    for (const node of data.states) {
        for (const target of Object.values(node.next || {})) {
            if (!ids.has(target)) throw new Error(`State '${node.id}' has a transition to an undefined state.`);
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
const shortHash = value => `${value.slice(0, 12)}…`;

/**
 * What a named agent state is bound to (design 03, 04, 09; R09, R18; mock
 * M17 "Inspect package pin"): the workflow interface the state names (its
 * graph's `invoke.interface`, `<name>@<version>`), and its pin in `source`,
 * the shown run's pins (projectWorkflowV2): `{ by: "publication" | "test",
 * pins }` (migration 0099's publication pins, or a real-agent test run's,
 * migration 0101), or `{ by: "mocked" }` for a mocked test run, whose
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
    if (binding.mocked) rows.push(["Agent in this test", "Mocked: the parent or a fixture gives its typed result"]);
    const pin = binding.pin;
    if (pin) {
        const what = pin.package
            ? `${pin.package}${pin.version ? ` ${pin.version}` : ""}${pin.revision ? ` · revision ${shortHash(pin.revision)}` : " · by version"}`
            : `${pin.name ?? "agent"} · a deployment agent, by name`;
        rows.push([binding.pinnedBy === "test" ? "Pinned for this test" : "Pinned by publication", what]);
        if (pin.interface) rows.push(["Interface digest", `${pin.interface.ref} · ${shortHash(pin.interface.digest)}`]);
        else if (binding.interface) rows.push(["Interface digest", "Not pinned"]);
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
        case "terminal": return `ends · ${node.outcome}`;
        default: return String(node?.type || "state");
    }
}

/** A business outcome of the state, or a runtime-error route (failure and error codes). */
export function workflowV2RouteKind(node, label) {
    if (!node || node.type === "terminal") return "outcome";
    return Array.isArray(node.outcomes) && node.outcomes.includes(label) ? "outcome" : "error";
}

/** Mark each laid-out edge as an outcome route, a runtime-error route, or both (labels merged onto one edge). */
export function annotateWorkflowV2Edges(definition, layout) {
    const byId = new Map(definition.states.map(node => [node.id, node]));
    for (const edge of layout.edges) {
        // A parallel state's edge to its body's first state is how each branch starts, not a route.
        if (edge.branch) { edge.kind = "branch"; continue; }
        const kinds = new Set(edge.outcomes.map(label => workflowV2RouteKind(byId.get(edge.from), label)));
        edge.kind = kinds.size > 1 ? "mixed" : [...kinds][0];
    }
    return layout;
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

/**
 * Project the object `readWorkflowV2View` returns. `status` is one of ready,
 * draft, invalid (no graph can be shown), unavailable (valid but no graph),
 * invalid-graph or unrecognized. `older` is the view's olderHistory: the older
 * pages a person loaded, merged into the model's run only when they are for
 * that run (workflowV2RunRows).
 */
export function projectWorkflowV2ReadModel(model, { older = null } = {}) {
    if (!isRecord(model) || typeof model.workflowId !== "string" || !isRecord(model.definition)
        || !isRecord(model.revision) || typeof model.revision.valid !== "boolean" || !Array.isArray(model.runs)) {
        return unrecognized("This payload is not a workflow v2 read model, so it was not shown.");
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
        banners.push({ level: "error", text: `Revision ${revision.revision} has ${errors || "unlisted"} error${errors === 1 ? "" : "s"} and cannot run.`
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
        banners.push({ level: "warning", text: "This run's revision is not listed, so node status is not overlaid." });
    } else if (run && graph && runRevision !== graph.revision) {
        overlay = false;
        banners.push({ level: "warning", text: `This run used revision ${runRevision}; the graph shows revision ${graph.revision}, so node status is not overlaid.` });
    }
    if (model.run !== null && model.run !== undefined && !run) {
        banners.push({ level: "warning", text: "The run in this read model has an unknown shape, so it was not shown." });
    } else if (!run) {
        banners.push({ level: "info", text: model.runs.length
            ? `No live run is selected; ${model.runs.length === 1 ? "1 other run exists" : `${model.runs.length} other runs exist`}.` : "No run yet." });
    }
    // A test run (design 05; INACTIVE outside controller 1.9.0's tests): its notice stays visible, with the revision it tested,
    // its virtual clock and what still waits for the parent's answer. Never shown as a production result.
    if (run?.test) {
        const test = run.test;
        banners.push({ level: "warning", text: typeof test.notice === "string" && test.notice
            ? test.notice : "TEST — scripts run normally; framework tools are mocked." });
        // Agent mode real: its agent states run real agent sessions (they spend model tokens), whose framework tools are mocked.
        if (test.agentMode === "real") {
            banners.push({ level: "warning", text: typeof test.agentNotice === "string" && test.agentNotice
                ? test.agentNotice : "Agent states run real agent sessions; their framework tool calls are mocked." });
        }
        if (test.stale === true) {
            banners.push({ level: "warning", text: `This test ran revision ${test.testedRevision}; the definition is now at revision ${lifecycle.currentRevision}, so its result is stale.` });
        }
        if (isRecord(test.virtualClock) && Number.isSafeInteger(test.virtualClock.elapsedSeconds)) {
            banners.push({ level: "info", text: `Virtual clock: ${formatSeconds(test.virtualClock.elapsedSeconds)} after the test began. Script clocks are real.` });
        }
        const open = Array.isArray(test.coverage?.unanswered) ? test.coverage.unanswered.length : 0;
        if (open) banners.push({ level: "info", text: `${open} intercepted effect${open === 1 ? " waits" : "s wait"} for the parent's answer.` });
    }
    // How much of the run's history is loaded: the read pages a run newest first and lists its open rows apart, so its
    // current states are read however long its history is; older history is loaded on request (loadOlderWorkflowHistory).
    const history = run?.history;
    if (history && !history.paged && !history.complete) {
        banners.push({ level: "info", text: `Only the first ${LEGACY_EXECUTION_LIMIT} node executions are listed, so counts may be incomplete.` });
    } else if (history?.next?.executions) {
        banners.push({ level: "info", text: "Older node executions of this run are not loaded, so counts may be incomplete." });
    }
    if (history?.paged && !history.openComplete) {
        banners.push({ level: "warning", text: "This run has more open states, inputs, deliveries or waiting effects than a read lists (500 of each), so some of them are not shown." });
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
        ok: true, status, workflowId: model.workflowId, definition: graph, diagnostics, banners, workflowBanners, run, overlay, runRevision,
        lifecycle: lifecycle.state, semver: lifecycle.semver ?? null, currentRevision: lifecycle.currentRevision,
        publishedRevision: lifecycle.publishedRevision ?? null, validRevision: revision.valid, runs: model.runs,
        // What publication pinned each named agent state to (migration 0099; only a definition with any has them).
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
                kvRevision: row.kvRevision ?? undefined, deadline: text(row.deadline), receive: isRecord(row.receive) ? row.receive : undefined,
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
            : end.status === "stopped" ? "Stopped · no new state was started after the stop"
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
            label: `${mode}Status unverified · read model says ${modelSays}, latest event says ${control.kind === "paused" ? "paused" : "resumed"}` };
    }
    const status = run?.status ?? (control?.kind ?? (begun ? "running" : null));
    switch (status) {
        case "admitted": return { phase: "admitted", ended: false, label: `${mode}Admitted · not started` };
        case "paused": {
            const label = run?.pausedFrom === "admitted" ? "Paused before it started"
                : run?.pauseSettled === false ? "Pausing · waiting for running states to settle" : "Paused";
            return { phase: run?.pauseSettled === false ? "pausing" : "paused", ended: false, label: mode + label };
        }
        case "running": return run?.stop
            ? { phase: "stopping", ended: false, label: `${mode}Stopping · admitted work may settle until ${run.stop.deadline ?? "its deadline"}` }
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
        if (pending) lines.push(execution.deadline ? `Waiting until ${execution.deadline}.` : `Waiting ${typeof node.seconds === "number" ? formatSeconds(node.seconds) : "for its bound duration"}.`);
        else if (execution.outcome === "elapsed") lines.push("The wait elapsed.");
    } else if (kind === "receive") {
        const wanted = execution.receive ? { contract: execution.receive.contract, from: execution.receive.from } : { contract: node.contract, from: node.from };
        if (pending) {
            lines.push(`Waiting for ${wanted.contract} from ${party(wanted.from)}.`);
            if (execution.deadline) lines.push(`If none arrives, the state routes on 'elapsed' after ${execution.deadline}.`);
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
        if (execution.agent?.childSessionId) lines.push(`Its agent works in child session ${execution.agent.childSessionId}; open it to read the actual chat.`);
        if (pending) lines.push("Only the agent's typed result completes this state; its chat messages do not.");
    } else if (kind === "parallel") {
        if (Number.isSafeInteger(execution.branches)) lines.push(`${execution.branches} branch${execution.branches === 1 ? "" : "es"} from its manifest.`);
        if (pending) lines.push(`Branches start at '${node.body?.initial}', ${node.concurrency === 1 ? "one at a time" : `up to ${node.concurrency} at a time`}.`);
    }
    if (execution.branch && Number.isSafeInteger(execution.branch.index)) lines.push(`In branch ${execution.branch.index} of its parallel state.`);
    if (execution.catchAll) lines.push("Entered as the workflow's catch-all state after an unhandled runtime error.");
    return lines;
}

function nodeView(node, executions, context) {
    const kind = workflowV2Kind(node);
    const list = executions.filter(item => item.stateId === node.id).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const latestDone = list.findLast(item => item.status === "completed");
    // A pending execution older than a completed one lost its completion from the loaded history.
    const pending = list.findLast(item => item.status === "pending" && (!latestDone || (item.ordinal ?? 0) >= (latestDone.ordinal ?? 0)));
    const stalePending = list.some(item => item.status === "pending" && item !== pending);
    const reachedByRun = node.type === "terminal" && context.terminalState === node.id;
    const runs = Math.max(list.length, ...list.map(item => item.ordinal ?? 0), reachedByRun ? 1 : 0);
    let state = "idle", phase = "not-reached", stateLabel = context.stateless ?? (context.hasRun ? "Not reached" : "No run");
    const result = latestDone || null;
    let outcome = result?.outcome, resultKind = result?.resultKind;
    if (pending && !(node.type === "terminal" && context.run.ended)) {
        if (context.run.ended) {
            state = "cancelled"; phase = "ended-early"; stateLabel = "Run ended first";
        } else if (context.run.phase === "unverified") {
            state = "idle"; phase = "unverified"; stateLabel = "Pending · run status unverified";
        } else if (context.run.phase === "paused") {
            state = "idle"; phase = "paused"; stateLabel = "Pending · run paused";
        } else {
            state = "running"; phase = kind === "script" ? "running" : "waiting"; stateLabel = pendingText(kind, pending);
        }
    } else if (result) {
        if (result.resultKind === "runtime_error") {
            state = "failed"; phase = "error";
            stateLabel = `Runtime error${result.outcome ? ` · ${result.outcome}` : result.effectStatus ? ` · effect ${result.effectStatus}` : ""}`;
        } else if (node.type === "terminal") {
            outcome = node.outcome;
            state = node.outcome === "failed" ? "failed" : node.outcome === "cancelled" ? "cancelled" : "done";
            phase = "done"; stateLabel = `Ended · ${node.outcome}`;
        } else if (result.resultKind === "business") {
            state = "done"; phase = "done"; stateLabel = outcomeText(kind, result.outcome);
        } else {
            state = "done"; phase = "unclassified"; stateLabel = "Completed · result kind not recorded";
        }
    } else if (reachedByRun) {
        state = node.outcome === "failed" ? "failed" : node.outcome === "cancelled" ? "cancelled" : "done";
        phase = "done"; outcome = node.outcome; resultKind = "business"; stateLabel = `Ended · ${node.outcome}`;
    }
    // Every loaded visit, newest first: older history a person loaded reaches any visit of the state.
    const history = [...list].reverse();
    const binding = workflowV2AgentBinding(node, context.pins);
    return {
        ...node, shape: "v2", kind, label: workflowV2NodeLabel(node), state, phase, stateLabel, runs,
        ...(binding ? { binding } : {}),
        partial: !context.complete || stalePending || runs > list.length,
        outcome: outcome ?? (node.type === "terminal" ? node.outcome : undefined), resultKind,
        result, pending: pending || null, current: pending || latestDone || null, executions: history,
        description: [...describeWorkflowV2Execution(node, pending || latestDone), ...branchProgressLines(node, pending || latestDone, context)],
    };
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
 * they join the selection's own model only for the run it shows.
 */
export function projectWorkflowV2({ definition = null, readModel = null, workflowModel = null, selectedRunId = null, events = [], readModelAfterSeq = null,
    olderHistory = null } = {}) {
    const model = readModel ? projectWorkflowV2ReadModel(readModel, { older: olderHistory }) : null;
    const wide = model || !workflowModel ? null : projectWorkflowV2ReadModel(workflowModel);
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
            banners.push({ level: "warning", text: `This run used revision ${revision}; the graph shows revision ${active.revision}, so node status is not overlaid.` });
        }
    }
    const { executions, ignoredEvents, ignoredRows } = bound
        ? collectExecutions(events, runId, run, true) : { executions: [], ignoredEvents: 0, ignoredRows: 0 };
    let status = !bound && modelOk && !run
        ? { phase: "none", ended: false, label: model.runs.length ? "No live run selected" : "No run yet" }
        : workflowV2RunStatus({ run, events: bound || !modelOk ? events : [], runId, readModelAfterSeq });
    // A selected run whose own read model is not here (yet), and none of whose events are loaded.
    if (!modelOk && selection !== null && status.phase === "none") status = { ...status, label: "Selected run not loaded" };
    if (!bound && runId) status = { ...status, terminalState: null, label: `${unboundRevision === null ? "Unbound" : `Revision ${unboundRevision}`} run · ${status.label}` };
    if (status.phase === "unverified") {
        banners.push({ level: "warning", text: `Run status is not verified: the read model says ${status.conflict.readModel} but the latest durable event says ${status.conflict.events}. Refresh the read model.` });
    }
    if (ignoredEvents) banners.push({ level: "warning", text: `${ignoredEvents} workflow event${ignoredEvents === 1 ? "" : "s"} did not have the v2 shape and ${ignoredEvents === 1 ? "was" : "were"} ignored.` });
    if (ignoredRows) banners.push({ level: "warning", text: `${ignoredRows} node execution row${ignoredRows === 1 ? "" : "s"} did not have the v2 shape and ${ignoredRows === 1 ? "was" : "were"} ignored.` });
    const known = new Set((active?.states || []).map(node => node.id));
    const unknown = executions.filter(item => !known.has(item.stateId)).length;
    if (unknown) banners.push({ level: "warning", text: `${unknown} execution${unknown === 1 ? "" : "s"} belong to states that are not in this graph.` });
    const context = { run: status, hasRun: status.phase !== "none", terminalState: bound ? status.terminalState ?? run?.terminalState ?? null : null,
        complete: Boolean(run && bound && run.history.complete), stateless: !bound && runId ? "Run not overlaid" : undefined,
        pins: agentPinSource(shared, run, bound, active) };
    // Each parallel state's branches as the loaded executions show them (mock M21 active and queued counts, M22 a blocked join).
    context.branchProgress = workflowV2BranchProgress(executions, active?.states || []);
    const nodes = (active?.states || []).map(node => nodeView(node, executions, context));
    return {
        shape: "v2", status, definition: active, nodes, banners, readModel: model, runId, bound,
        diagnostics: shared?.diagnostics || [], inbox: bound ? run?.inbox || [] : [], outbox: bound ? run?.outbox || [] : [],
        output: bound ? run?.output ?? null : null, error: bound ? run?.error ?? null : null, modelStatus: shared?.status ?? null,
    };
}

/** Collapse neighbouring executions that ended the same way, with the same output, into one row. The raw list stays available to the caller. */
export function compactWorkflowV2Executions(executions) {
    const rows = [];
    for (const execution of executions) {
        const key = JSON.stringify([execution.status, execution.outcome, execution.resultKind, execution.outputPreview ?? null, execution.errorPreview ?? null]);
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
export function workflowV2ShownExecution(node, runId, selection) {
    const executions = Array.isArray(node?.executions) ? node.executions : [];
    const chosen = isRecord(selection) && typeof selection.executionId === "string" && selection.executionId !== ""
        && selection.stateId === node?.id && (selection.runId ?? null) === (runId ?? null);
    if (!chosen) {
        const execution = isRecord(node?.result) ? node.result : null;
        return { chosen: false, missing: false, execution, executionId: execution?.id ?? null,
            index: execution ? executions.findIndex(item => item?.id === execution.id) : -1 };
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
        const queued = Math.max(0, execution.branches - progress.started);
        return [`Branches now${note}: ${progress.active} active, ${queued} queued, ${progress.started - progress.active} ended.`];
    }
    if (execution.outcome === "blocked") return [`Join blocked${note}: ${progress.succeeded} of ${execution.branches} branches succeeded.`];
    return [];
}
