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

const STATE_TYPES = new Set(["script", "wait", "messaging", "terminal"]);
const MESSAGING_MODES = new Set(["receive", "send", "request"]);
const TERMINAL_OUTCOMES = new Set(["succeeded", "blocked", "failed", "cancelled"]);
const RUN_STATUSES = new Set(["admitted", "running", "paused", "completed", "failed", "cancelled"]);
const STATE_EVENTS = new Set(["workflow.state_started", "workflow.state_completed", "workflow.state_failed", "workflow.state_cancelled"]);
const END_EVENTS = { "workflow.completed": "completed", "workflow.failed": "failed", "workflow.cancelled": "cancelled" };

/** The read view lists at most this many node executions, 50 inbox rows and 50 outbox rows (tools.ts). */
export const WORKFLOW_V2_READ_LIMITS = { nodeExecutions: 200, inbox: 50, outbox: 50 };

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

export function formatSeconds(seconds) {
    if (!Number.isFinite(seconds)) return String(seconds);
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${+(seconds / 60).toFixed(1)} min`;
    return `${+(seconds / 3600).toFixed(1)} h`;
}

const party = value => value === null || value === undefined ? "any permitted sender" : value === "parent" ? "the parent session" : String(value);

/** One short line that names what the state does. */
export function workflowV2NodeLabel(node) {
    switch (workflowV2Kind(node)) {
        case "script": return `script · ${node.runtime || "node"}`;
        case "wait": return typeof node.seconds === "number" ? `wait · ${formatSeconds(node.seconds)}` : "wait · bound duration";
        case "receive": return `receive · ${node.contract}`;
        case "send": return `send · ${node.contract}`;
        case "request": return `request · ${node.contract}`;
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

function normalizeRun(raw) {
    if (!isRecord(raw) || typeof raw.runId !== "string" || !RUN_STATUSES.has(raw.status)) return null;
    const list = value => Array.isArray(value) ? value.filter(isRecord) : [];
    const nodeExecutions = list(raw.nodeExecutions), inbox = list(raw.inbox), outbox = list(raw.outbox);
    return {
        runId: raw.runId, mode: raw.mode, status: raw.status, outcome: raw.outcome ?? null,
        pausedFrom: raw.pausedFrom ?? null, pauseSettled: typeof raw.pauseSettled === "boolean" ? raw.pauseSettled : null,
        terminalState: raw.terminalState ?? null, output: raw.output ?? null, error: raw.error ?? null,
        kvRevision: raw.kvRevision, kv: raw.kv, nodeExecutions, inbox, outbox,
        executionsTruncated: nodeExecutions.length >= WORKFLOW_V2_READ_LIMITS.nodeExecutions,
        inboxTruncated: inbox.length >= WORKFLOW_V2_READ_LIMITS.inbox,
        outboxTruncated: outbox.length >= WORKFLOW_V2_READ_LIMITS.outbox,
    };
}

const unrecognized = reason => ({ ok: false, status: "unrecognized", definition: null, diagnostics: [], run: null, overlay: false,
    banners: [{ level: "error", text: reason }] });

/**
 * Project the object `readWorkflowV2View` returns. `status` is one of ready,
 * draft, invalid (no graph can be shown), unavailable (valid but no graph),
 * invalid-graph or unrecognized.
 */
export function projectWorkflowV2ReadModel(model) {
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
    const run = normalizeRun(model.run);
    const runInfo = run ? model.runs.find(item => item?.runId === run.runId) : null;
    let overlay = Boolean(run && graph);
    if (run && graph && Number.isSafeInteger(runInfo?.revision) && runInfo.revision !== graph.revision) {
        overlay = false;
        banners.push({ level: "warning", text: `This run used revision ${runInfo.revision}; the graph shows revision ${graph.revision}, so node status is not overlaid.` });
    }
    if (model.run !== null && model.run !== undefined && !run) {
        banners.push({ level: "warning", text: "The run in this read model has an unknown shape, so it was not shown." });
    } else if (!run) {
        banners.push({ level: "info", text: model.runs.length
            ? `No live run is selected; ${model.runs.length} other run${model.runs.length === 1 ? "" : "s"} exist.` : "No run yet." });
    }
    if (run?.executionsTruncated) banners.push({ level: "info", text: `Only the first ${WORKFLOW_V2_READ_LIMITS.nodeExecutions} node executions are listed, so counts may be incomplete.` });
    return {
        ok: true, status, workflowId: model.workflowId, definition: graph, diagnostics, banners, run, overlay,
        lifecycle: lifecycle.state, semver: lifecycle.semver ?? null, currentRevision: lifecycle.currentRevision,
        publishedRevision: lifecycle.publishedRevision ?? null, validRevision: revision.valid, runs: model.runs,
    };
}

function latestRunId(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const type = events[i]?.eventType;
        const id = events[i]?.data?.runId;
        if (typeof id === "string" && (STATE_EVENTS.has(type) || Object.hasOwn(END_EVENTS, type) || type === "workflow.started"
            || type === "workflow.paused" || type === "workflow.resumed")) return id;
    }
    return null;
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
                kvRevision: row.kvRevision ?? undefined, deadline: text(row.deadline), receive: isRecord(row.receive) ? row.receive : undefined }, "read");
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
        ignoredEvents += events.filter(event => STATE_EVENTS.has(event?.eventType)).length;
    }
    if (run && overlay) {
        for (const message of run.outbox) {
            const found = executions.get(message.nodeExecutionId);
            if (found) found.outbox = { state: message.state, attempts: message.attempts, recipientSessionId: message.recipientSessionId,
                recipientKind: message.recipientKind, contract: message.contract, deliveredAt: message.deliveredAt ?? null,
                payloadPreview: message.payloadPreview, errorPreview: message.errorPreview, inputMessageId: message.inputMessageId ?? null };
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
export function workflowV2RunStatus({ run = null, events = [], runId = null } = {}) {
    let end = null;
    let control = null;
    let begun = false;
    for (const event of events) {
        const data = isRecord(event?.data) ? event.data : {};
        if (!runId || data.runId !== runId) continue;
        if (Object.hasOwn(END_EVENTS, event.eventType)) end = { status: END_EVENTS[event.eventType], outcome: data.outcome ?? null, stateId: data.stateId ?? null, error: data.error, code: text(data.code) };
        else if (event.eventType === "workflow.paused") control = "paused";
        else if (event.eventType === "workflow.resumed") control = "running";
        else if (event.eventType === "workflow.started" || STATE_EVENTS.has(event.eventType)) begun = true;
    }
    if (!end && run && ["completed", "failed", "cancelled"].includes(run.status)) {
        end = { status: run.status, outcome: run.outcome, stateId: run.terminalState, error: run.error ?? undefined, code: undefined };
    }
    const mode = run?.mode === "test" ? "Test run · " : "";
    if (end) {
        // A terminal state with an outcome is the workflow's own decision. A failure without one is a runtime or controller failure.
        const business = end.stateId !== null && end.outcome !== null;
        const label = end.status === "completed" ? `Completed · ${end.outcome ?? "ended"}`
            : end.status === "cancelled" ? "Cancelled"
                : business ? `Failed · ended at '${end.stateId}' (${end.outcome})` : `Failed · ${end.code || "runtime error"}`;
        return { phase: end.status, ended: true, label: mode + label, businessOutcome: business ? end.outcome : null, error: end.error,
            terminalState: end.stateId };
    }
    const status = run?.status ?? (control ?? (begun ? "running" : null));
    switch (status) {
        case "admitted": return { phase: "admitted", ended: false, label: `${mode}Admitted · not started` };
        case "paused": {
            const label = run?.pausedFrom === "admitted" ? "Paused before it started"
                : run?.pauseSettled === false ? "Pausing · waiting for running states to settle" : "Paused";
            return { phase: run?.pauseSettled === false ? "pausing" : "paused", ended: false, label: mode + label };
        }
        case "running": return { phase: "running", ended: false, label: `${mode}Running` };
        default:
            return control === "paused" ? { phase: "paused", ended: false, label: "Paused" } : { phase: "none", ended: false, label: "No run yet" };
    }
}

const outcomeText = (kind, outcome) => {
    if (kind === "receive") return outcome === "received" ? "Received" : outcome === "elapsed" ? "Wait elapsed · no message" : `Done · ${outcome}`;
    if (kind === "wait") return outcome === "elapsed" ? "Elapsed" : `Done · ${outcome}`;
    if (kind === "send") return outcome === "sent" ? "Sent · queued at recipient" : `Done · ${outcome}`;
    if (kind === "request") return outcome === "responded" ? "Responded" : outcome === "declined" ? "Declined" : `Done · ${outcome}`;
    return outcome ? `Done · ${outcome}` : "Done";
};

const pendingText = (kind, execution) => {
    if (kind === "wait") return "Waiting";
    if (kind === "receive") return "Waiting for message";
    if (kind === "send") return execution?.outbox?.state === "delivered" ? "Sent · queued at recipient" : "Delivering";
    if (kind === "request") return "Awaiting response";
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
    }
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
    let state = "idle", phase = "not-reached", stateLabel = context.hasRun ? "Not reached" : "No run";
    const result = latestDone || null;
    let outcome = result?.outcome, resultKind = result?.resultKind;
    if (pending && !(node.type === "terminal" && context.run.ended)) {
        if (context.run.ended) {
            state = "cancelled"; phase = "ended-early"; stateLabel = "Run ended first";
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
    const history = [...list].reverse().slice(0, 40);
    return {
        ...node, shape: "v2", kind, label: workflowV2NodeLabel(node), state, phase, stateLabel, runs,
        partial: !context.complete || stalePending || runs > list.length,
        outcome: outcome ?? (node.type === "terminal" ? node.outcome : undefined), resultKind,
        result, pending: pending || null, current: pending || latestDone || null, executions: history,
        description: describeWorkflowV2Execution(node, pending || latestDone),
    };
}

/**
 * Everything the V2 graph, header and details need from a definition, durable
 * events and an optional read model object. Always returns; it reports what it
 * ignored instead of throwing.
 */
export function projectWorkflowV2({ definition = null, readModel = null, events = [] } = {}) {
    const model = readModel ? projectWorkflowV2ReadModel(readModel) : null;
    const banners = model ? [...model.banners] : [];
    const modelUsable = Boolean(model?.ok && model.definition);
    // A read model that says there is no graph is not overridden by an older run's definition.
    const active = modelUsable ? model.definition : model?.ok ? null : definition?.shape === "v2" ? definition : null;
    const run = modelUsable ? model.run : null;
    const overlay = modelUsable ? model.overlay : true;
    const runId = run?.runId ?? latestRunId(events);
    const { executions, ignoredEvents, ignoredRows } = collectExecutions(events, runId, run, overlay);
    const status = workflowV2RunStatus({ run, events, runId });
    if (ignoredEvents) banners.push({ level: "warning", text: `${ignoredEvents} workflow event${ignoredEvents === 1 ? "" : "s"} did not have the v2 shape and ${ignoredEvents === 1 ? "was" : "were"} ignored.` });
    if (ignoredRows) banners.push({ level: "warning", text: `${ignoredRows} node execution row${ignoredRows === 1 ? "" : "s"} did not have the v2 shape and ${ignoredRows === 1 ? "was" : "were"} ignored.` });
    const known = new Set((active?.states || []).map(node => node.id));
    const unknown = executions.filter(item => !known.has(item.stateId)).length;
    if (unknown) banners.push({ level: "warning", text: `${unknown} execution${unknown === 1 ? "" : "s"} belong to states that are not in this graph.` });
    const context = { run: status, hasRun: status.phase !== "none", terminalState: status.terminalState ?? run?.terminalState ?? null,
        complete: Boolean(run && overlay && !run.executionsTruncated) };
    const nodes = (active?.states || []).map(node => nodeView(node, executions, context));
    return {
        shape: "v2", status, definition: active, nodes, banners, readModel: model, runId,
        diagnostics: model?.diagnostics || [], inbox: run?.inbox || [], outbox: run?.outbox || [],
        output: run?.output ?? null, error: run?.error ?? null, modelStatus: model?.status ?? null,
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
