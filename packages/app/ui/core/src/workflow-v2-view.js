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

function normalizeRun(raw) {
    if (!isRecord(raw) || typeof raw.runId !== "string" || !RUN_STATUSES.has(raw.status)) return null;
    const list = value => Array.isArray(value) ? value.filter(isRecord) : [];
    const nodeExecutions = list(raw.nodeExecutions), inbox = list(raw.inbox), outbox = list(raw.outbox);
    return {
        runId: raw.runId, mode: raw.mode, status: raw.status, outcome: raw.outcome ?? null,
        pausedFrom: raw.pausedFrom ?? null, pauseSettled: typeof raw.pauseSettled === "boolean" ? raw.pauseSettled : null,
        // A graceful stop (controller 1.9.0) and a test run's evidence (notice, virtual clock, interceptions, coverage).
        stop: isRecord(raw.stop) ? raw.stop : null, test: isRecord(raw.test) ? raw.test : null,
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
    // Everything above is the workflow's (its definition, revision and graph), whichever run was asked for; what follows is the run's.
    const workflowBanners = [...banners];
    const run = normalizeRun(model.run);
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
    if (run?.executionsTruncated) banners.push({ level: "info", text: `Only the first ${WORKFLOW_V2_READ_LIMITS.nodeExecutions} node executions are listed, so counts may be incomplete.` });
    return {
        ok: true, status, workflowId: model.workflowId, definition: graph, diagnostics, banners, workflowBanners, run, overlay, runRevision,
        lifecycle: lifecycle.state, semver: lifecycle.semver ?? null, currentRevision: lifecycle.currentRevision,
        publishedRevision: lifecycle.publishedRevision ?? null, validRevision: revision.valid, runs: model.runs,
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
 */
export function projectWorkflowV2({ definition = null, readModel = null, workflowModel = null, selectedRunId = null, events = [], readModelAfterSeq = null } = {}) {
    const model = readModel ? projectWorkflowV2ReadModel(readModel) : null;
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
        complete: Boolean(run && bound && !run.executionsTruncated), stateless: !bound && runId ? "Run not overlaid" : undefined };
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
