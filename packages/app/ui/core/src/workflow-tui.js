import { shortRunId, shortSessionId } from "./formatting.js";
import { layoutWorkflowGraph, workflowNodeViews, workflowReadModelView } from "./workflow-view.js";
import { workflowV2RunPickerModel } from "./workflow-v2-run-picker.js";
import {
    compactWorkflowV2Executions, formatSeconds, projectWorkflowV2, workflowV2AgentBindingRows, workflowV2AgentTask, workflowV2ExecutionResult,
    workflowV2ExecutionValue, workflowV2KvApplied, workflowV2KvCompare, workflowV2KvSnapshot, workflowV2RouteKind, workflowV2RunRows, workflowV2ShownExecution,
    workflowV2Activity, workflowV2SessionSubtree, workflowV2VisitEnding, workflowV2WholeValue, workflowV2BranchList, workflowV2BranchNumber,
    workflowV2JoinWords,
} from "./workflow-v2-view.js";
import {
    WORKFLOW_V2_TEST_NOTICE_TEXT, WORKFLOW_V2_TEST_NEEDS_DRAFT_TEXT, WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT, WORKFLOW_V2_VARIABLES_HELP_TEXT, workflowV2DefinitionControls, workflowV2DraftEdit, workflowV2DraftEditor, workflowV2DraftMarks,
    workflowV2PublicationEvidenceRows, workflowV2RestrictionText, workflowV2RunCommandNotice, workflowV2RunControls, workflowV2RunVariables, workflowV2TestControls,
    workflowV2TestResponder, workflowV2VariableBatchDraft, workflowV2VariableEditBehind, workflowV2RevisionCompare, workflowV2AnswerSourceText,
} from "./workflow-v2-commands.js";

/**
 * R2-UI-1: a variables form's edit that started at an older revision than the view shows (null otherwise, and while
 * nothing is typed, or for an update whose answer never came: Enter sends it again as itself), with what to do about it.
 */
function variablesBehind(modal, variables, dirty, notice) {
    if (!dirty || (notice?.retry === true)) return null;
    const behind = workflowV2VariableEditBehind(modal.baseRevision, variables?.revision);
    return behind ? { ...behind, help: `${behind.text} ctrl-l loads the new values; ctrl-k keeps your edit to save it over them.` } : null;
}

/**
 * The TUI's read-only workflow view (design 02 "Portal/TUI: graph, observed
 * state, read-only child chats"; T115): the graph the portal's workflow pane
 * draws, as text. States in graph order with their observed state, the
 * selected state's details and transitions (a transition inside a loop is
 * marked as one), and, for an agent state, the child session of each of its
 * occurrences, which the person opens to read its actual chat.
 *
 * It reads only what the shared controller has loaded for the session
 * (ensureWorkflowDefinition, ensureWorkflowReadModel: the same reads the
 * portal makes), through the same projection (projectWorkflowV2, or the
 * legacy node views), for the run the person chose (the portal's run picker
 * model: the live run, or any run in the workflow's run list).
 *
 * The only commands it sends are a person's run controls for the run it
 * shows (design 04, 07, mocks M04, M16; R17, R26; INACTIVE: only a deployment
 * that takes a person's workflow commands offers any): p pause, r resume,
 * s stop, c cancel, the portal's controls (workflowV2RunControls) sent as the
 * portal sends them (the controller's sendWorkflowRunCommand: stop and cancel
 * ask first, one command at a time, the same command again after an answer
 * that never came), and its variables (v opens a form: set a name to a JSON
 * value, or remove a name after the confirm dialog, each as one set_vars
 * update at the revision the view shows; V opens a form for several in one
 * set_vars update: a JSON object to set and a JSON list to remove, a
 * removal after the confirm dialog; the portal's workflowV2RunVariables
 * and drafts), and a draft's YAML (e opens an editor: ctrl-o saves it as a
 * new revision after the one the edit started from, replace_definition, the
 * portal's workflowV2DraftEditor and workflowV2DraftEdit; a draft someone
 * else saved meanwhile is refused, never overwritten, and the edit is kept),
 * and the definition's publication (P opens a review of the exact revision
 * and definition hash shown: publish only, publish and start its live run,
 * or start a published definition's live run, with the run's inputs and
 * initial variables, each after the confirm dialog; the portal's
 * workflowV2DefinitionControls), and a test run of the exact current
 * revision (t opens its review: the test notice, mocked or real agents with
 * the real-agent notice, the run's inputs, initial variables and scenario
 * name, started after the confirm dialog; the portal's
 * workflowV2TestControls), and the shown test run's answers and clock (a
 * opens an answer form bound to the run and one held call that
 * waits; + opens its virtual clock; the portal's workflowV2TestResponder). A
 * workflow in an agent state's subtree takes only pause, stop and cancel
 * from people. The server decides every command again, and keeps refusing
 * human input to an agent state's subtree.
 *
 * For an agent state it also shows the agent, the workflow interface the
 * state names and what the shown run pins it to (the package revision and
 * the interface's digest; design 04, 09, mock M17), as the portal does.
 *
 * The TUI's composer for a session in an agent state's subtree (design 03
 * human-input denial; T115, T116) is read-only, as the portal's is: what a
 * person may send comes from the server's lineage read
 * (getWorkflowInputPolicy, or the session access the Web API reports), never
 * from the client, and the server refuses such input whatever the client
 * shows.
 */

const EMPTY_EVENTS = Object.freeze([]);
const STATE_GLYPHS = { running: "●", done: "✓", failed: "✗", cancelled: "⊘", idle: "○" };
const STATE_COLORS = { running: "yellow", done: "green", failed: "red", cancelled: "gray", idle: "gray" };
const VALUE_LIMIT = 240;
const HISTORY_ROW_LIMIT = 12;
const EFFECT_LIMIT = 20;

const bounded = (value, limit) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
/** One line of text, its indentation kept, cut at `limit`. */
const clip = (value, limit) => {
    const text = String(value ?? "").replace(/[\r\n\t]+/g, " ");
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

function valueText(value) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * What the portal's workflow pane shows for one session, from the state the controller loaded: its definition, node
 * views (v2 projection or legacy), status and read problems. Pure; never throws.
 */
export function workflowSessionProjection({ session = null, events = EMPTY_EVENTS, view = {}, live = null } = {}) {
    const safeView = view && typeof view === "object" ? view : {};
    const list = Array.isArray(events) ? events : EMPTY_EVENTS;
    const { readModel, readModelAfterSeq, workflowModel, error, selectedRunId } = workflowReadModelView(safeView);
    let v2 = null;
    if (safeView.definition?.shape === "v2" || readModel || workflowModel) {
        const projected = projectWorkflowV2({ definition: safeView.definition, readModel, workflowModel, selectedRunId, events: list, readModelAfterSeq,
            olderHistory: safeView.olderHistory ?? null });
        v2 = !projected.definition && safeView.definition && safeView.definition.shape !== "v2" ? null : projected;
    }
    const definition = v2 ? v2.definition : safeView.definition ?? null;
    let nodes = [];
    if (v2) nodes = v2.nodes;
    else if (definition) {
        try { nodes = workflowNodeViews(definition, list, live); } catch { nodes = []; }
    }
    const terminal = list.findLast(event => ["workflow.completed", "workflow.failed", "workflow.cancelled"].includes(event?.eventType));
    const status = v2 ? v2.status.label : terminal?.eventType.slice("workflow.".length)
        || (["completed", "failed", "cancelled"].includes(session?.status) ? session.status : live?.status || session?.status || "Starting");
    // The runs a person can choose (v2): the portal's run picker model, from the workflow's last read model.
    const runPicker = v2 ? workflowV2RunPickerModel({ workflowModel, selectedRunId, ownModelLoaded: readModel != null, error }) : null;
    // A person's run controls for the shown run, and the notice about the last one: the portal's, from the selection's own
    // read model only (its run is the one shown), and only when it says which commands the workflow takes from people.
    const runCommand = safeView.runCommand ?? null;
    const runControls = v2 ? workflowV2RunControls(readModel, runCommand) : null;
    const runNotice = v2 ? workflowV2RunCommandNotice(runCommand) : null;
    // The shown run's variables as the portal's panel lists them and a person changes them (set_vars), from the same model.
    const runVariables = v2 ? workflowV2RunVariables(readModel, runCommand) : null;
    // The draft's YAML as the portal's editor edits it (the definition is the workflow's, whichever run is shown), the
    // person's edit of it (kept in the view, so closing the editor loses nothing) and what that edit is: against the
    // revision it started from, which is one this person just saved when the read model does not show it yet.
    const draftEditor = v2 ? workflowV2DraftEditor(readModel ?? workflowModel, runCommand) : null;
    const draftBuffer = workflowDraftBuffer(safeView.draftEdit, draftEditor);
    const draftEdit = draftBuffer ? workflowV2DraftEdit(draftBuffer.base, draftBuffer.text,
        draftBuffer.base.revision > draftEditor.revision ? { ...draftEditor, revision: draftBuffer.base.revision } : draftEditor) : null;
    // The definition's publication as the portal's publication panel offers it (publish, publish and start, start), and a
    // test of its current revision as the portal's test review offers it.
    const publication = v2 ? workflowV2DefinitionControls(readModel ?? workflowModel, runCommand) : null;
    const testControls = v2 ? workflowV2TestControls(readModel ?? workflowModel, runCommand) : null;
    // The shown test run's answers and clock, from that run's own read model only, as the portal's answer form and clock.
    const testResponder = v2 ? workflowV2TestResponder(readModel, runCommand) : null;
    return {
        definition, nodes, v2, status, live, runPicker, runControls, runNotice, runVariables, runReadModel: v2 ? readModel ?? null : null,
        draftEditor, draftBuffer, draftEdit, publication, testControls, testResponder, definitionModel: v2 ? readModel ?? workflowModel ?? null : null,
        // The execution whose own result a person chose ({ runId, stateId, executionId }; it applies only to that run and state).
        selectedExecution: isPlainRecord(safeView.selectedExecution) ? safeView.selectedExecution : null,
        // The whole values read (by run and execution; workflowV2ExecutionValue picks exactly one).
        executionValues: isPlainRecord(safeView.executionValues) ? safeView.executionValues : null,
        // The KV revisions read and the comparison asked for (mock M15; workflowV2KvSnapshot, workflowV2KvCompare).
        kvRevisions: isPlainRecord(safeView.kvRevisions) ? safeView.kvRevisions : null,
        kvCompare: isPlainRecord(safeView.kvCompare) ? safeView.kvCompare : null,
        // The draft's two versions compared (owner decision q4; TUI C) and the revisions read for it.
        revisionCompare: isPlainRecord(safeView.revisionCompare) ? safeView.revisionCompare : null,
        definitionRevisions: isPlainRecord(safeView.definitionRevisions) ? safeView.definitionRevisions : null,
        name: definition?.name || String(session?.title || "").replace(/^Workflow: /, "") || "Workflow",
        banners: v2?.banners || [],
        readError: error,
        loading: Boolean(safeView.loading) && !definition,
        error: typeof safeView.error === "string" && safeView.error ? safeView.error : null,
        noGraph: Boolean(v2 && !v2.definition),
        // The workflow's events as loaded: the activity of a run and of one visit (owner decision q14).
        events: list,
    };
}

/**
 * The states in graph order: by layer, as the portal lays the graph out (a loop is one layer), then by position in a
 * layer, each with its layer. Pure; an empty list without a definition.
 */
export function workflowGraphOrder(definition) {
    const states = Array.isArray(definition?.states) ? definition.states : [];
    if (!states.length) return [];
    let positions;
    try { positions = layoutWorkflowGraph(definition, 640).positions; } catch { positions = null; }
    if (!positions) return states.map((node, index) => ({ id: node.id, layer: index }));
    const rows = [...new Set(states.map(node => positions.get(node.id)?.y ?? 0))].sort((a, b) => a - b);
    return states
        .map((node, index) => ({ id: node.id, index, box: positions.get(node.id) || { x: 0, y: 0 } }))
        .sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x) || (a.index - b.index))
        .map(item => ({ id: item.id, layer: rows.indexOf(item.box.y) }));
}

/** A state's routes: its outcomes and runtime-error routes, and for a parallel state where each branch starts. */
function transitionsOf(node, layers) {
    const routes = Object.entries(node.next || {}).map(([label, target]) => ({
        label, target, kind: node.shape === "v2" ? workflowV2RouteKind(node, label) : "outcome",
        // Layers collapse a cycle into one layer, so a route to the same or an earlier layer stays inside a loop.
        loop: layers.has(target) && layers.has(node.id) && layers.get(target) <= layers.get(node.id),
    }));
    if (node.type === "parallel" && typeof node.body?.initial === "string") {
        routes.push({ label: "each branch", target: node.body.initial, kind: "branch", loop: false });
    }
    return routes;
}

/** An agent state's occurrences that have a child session, newest first (the node's own execution order). */
function occurrencesOf(node) {
    if (node.shape !== "v2" || node.kind !== "agent" || !Array.isArray(node.executions)) return [];
    return node.executions
        .filter(execution => typeof execution?.agent?.childSessionId === "string" && execution.agent.childSessionId)
        .map(execution => ({
            ordinal: execution.ordinal ?? null,
            status: execution.status ?? null,
            outcome: execution.outcome ?? null,
            childSessionId: execution.agent.childSessionId,
        }));
}

/**
 * The states grouped as the portal draws a parallel step (owner batch 7, H2; review UI7-4): each parallel step, then
 * its branch steps in graph order, then everything else in graph order, so its continuations come after its branch
 * steps (and after the join line the list draws after them). `entries` are in graph order. Pure.
 */
function groupedOrder(entries) {
    const ids = new Set(entries.map(entry => entry.id));
    const bodies = new Map();
    for (const entry of entries) {
        const parallel = entry.node?.parallel;
        if (typeof parallel !== "string" || parallel === entry.id || !ids.has(parallel)) continue;
        if (!bodies.has(parallel)) bodies.set(parallel, []);
        bodies.get(parallel).push(entry);
    }
    if (!bodies.size) return entries;
    const out = [];
    for (const entry of entries) {
        if (typeof entry.node?.parallel === "string" && bodies.has(entry.node.parallel)) continue;
        out.push(entry);
        if (bodies.has(entry.id)) out.push(...bodies.get(entry.id));
    }
    return out;
}

/**
 * The view's states in graph order, a parallel step's branch steps right after it (groupedOrder), each with what the
 * TUI shows: its line label, state label, transitions and agent occurrences. Pure.
 */
export function workflowViewNodes(projection) {
    const order = workflowGraphOrder(projection?.definition);
    const layers = new Map(order.map(item => [item.id, item.layer]));
    const byId = new Map((projection?.nodes || []).map(node => [node.id, node]));
    const nodes = [];
    for (const { id, layer } of order) {
        const node = byId.get(id);
        if (!node) continue;
        const v2 = node.shape === "v2";
        nodes.push({
            id, layer, node,
            initial: id === projection.definition?.initial,
            label: v2 ? node.label : node.type === "terminal" ? `ends · ${node.outcome || "terminal"}` : `${node.runtime || "script"}`,
            stateLabel: v2 ? node.stateLabel : `${node.state}${node.outcome && node.type !== "terminal" ? ` · ${node.outcome}` : ""}`,
            state: STATE_GLYPHS[node.state] ? node.state : "idle",
            runs: Number(node.runs) || 0,
            partial: Boolean(node.partial),
            transitions: transitionsOf(node, layers),
            occurrences: occurrencesOf(node),
        });
    }
    return groupedOrder(nodes);
}

/** The state shown first: the modal's selection, else the pending state (v2) or the live current state, the initial state, the first. */
export function workflowViewDefaultNode(projection, nodes) {
    const ids = new Set(nodes.map(entry => entry.id));
    const pending = projection?.v2 ? nodes.find(entry => entry.node.pending) : nodes.find(entry => entry.id === projection?.live?.current);
    return (pending && pending.id) || (ids.has(projection?.definition?.initial) ? projection.definition.initial : nodes[0]?.id ?? null);
}

/** The session's projection from the state the controller loaded (its events, workflow view and canvas data). */
export function workflowViewProjectionFor(state, sessionId) {
    const session = sessionId ? state?.sessions?.byId?.[sessionId] || null : null;
    const history = sessionId ? state?.history?.bySessionId?.get?.(sessionId) || null : null;
    return workflowSessionProjection({
        session,
        events: history?.events || EMPTY_EVENTS,
        view: state?.ui?.workflowViews?.[sessionId] || {},
        live: state?.canvas?.bySessionId?.[sessionId]?.dataPayload ?? null,
    });
}

/**
 * Where the open workflow view stands: its session's projection, the states in order, the selected state and the
 * chosen occurrence of an agent state (its child session). Null unless the workflow view is open. Pure.
 */
export function selectWorkflowViewSelection(state) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowView") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const nodes = workflowViewNodes(projection);
    const selectedId = nodes.some(entry => entry.id === modal.selectedNodeId) ? modal.selectedNodeId : workflowViewDefaultNode(projection, nodes);
    const selectedIndex = Math.max(0, nodes.findIndex(entry => entry.id === selectedId));
    const selected = nodes[selectedIndex] || null;
    const occurrences = selected?.occurrences || [];
    const occurrenceIndex = occurrences.length ? Math.max(0, Math.min(Number(modal.occurrenceIndex) || 0, occurrences.length - 1)) : 0;
    return { modal, projection, nodes, selectedIndex, selected, occurrences, occurrenceIndex, occurrence: occurrences[occurrenceIndex] || null,
        // The session rows loaded: the sessions under an agent step (owner decision q14).
        sessionsById: state?.sessions?.byId ?? null };
}

/** The keys of a person's run controls in the workflow view. */
export const WORKFLOW_VIEW_RUN_CONTROL_KEYS = Object.freeze({ pause: "p", resume: "r", stop: "s", cancel: "c" });
const RUN_CONTROL_LABELS = { pause: "Pause", resume: "Resume", stop: "Stop", cancel: "Cancel" };
const ENDED_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "stopped"]);
const isPlainRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Why the shown run does not take a run control the view does not list, as a sentence. */
function runControlAbsentReason(model, controls, operation) {
    if (!isPlainRecord(model)) return "The shown run is not loaded yet.";
    if (!isPlainRecord(model.run)) return "No run is shown.";
    if (!isPlainRecord(model.personCommands)) return "This deployment takes no workflow commands from people.";
    const offered = Array.isArray(model.personCommands.operations) && model.personCommands.operations.includes(operation);
    if (!offered) return controls?.restriction ?? "This workflow does not take it from people.";
    const status = typeof model.run.status === "string" ? model.run.status : "unknown";
    if (ENDED_RUN_STATUSES.has(status)) return `The run has ended (${status}).`;
    if (isPlainRecord(model.run.stop)) return "The run is stopping; only cancel applies.";
    if (operation === "resume") return "The run is not paused.";
    if (operation === "pause" && status === "paused") return "The run is already paused.";
    return `The run is ${status}.`;
}

/**
 * Whether the open workflow view sends a person's run control `operation` for the run it shows, and why not:
 * `{ ok: true, operation, runId }` when the portal's run controls (workflowV2RunControls) offer it enabled, otherwise
 * `{ ok: false, reason }`, a sentence for the status line. The server decides every command again. Pure.
 */
export function workflowViewRunControlFor(selection, operation) {
    const label = Object.hasOwn(RUN_CONTROL_LABELS, operation) ? RUN_CONTROL_LABELS[operation] : null;
    if (!label) return { ok: false, reason: "That is not a run control." };
    const projection = selection?.projection ?? null;
    const controls = projection?.runControls ?? null;
    const control = controls?.controls.find(item => item.operation === operation) ?? null;
    if (control?.enabled) return { ok: true, operation, runId: controls.runId };
    if (control) return { ok: false, reason: `${label} is not available now. ${control.title}` };
    return { ok: false, reason: `${label} is not available for this run. ${runControlAbsentReason(projection?.runReadModel ?? null, controls, operation)}` };
}

/**
 * The shown run's controls and the notice about the last one, as detail entries ({ text, color, indent }, wrapped by
 * the caller): each control the run takes now with its key (one being sent says so), why one is not available now, the
 * subtree rule when it applies, and a refusal or an answer that never came, with what to press. None without a
 * person's commands: the view stays read-only.
 */
function runControlLines(projection) {
    const lines = [];
    const controls = projection.runControls;
    if (controls) {
        if (controls.controls.length) {
            const parts = controls.controls.map(control => `${WORKFLOW_VIEW_RUN_CONTROL_KEYS[control.operation]} ${control.label.toLowerCase()}`
                + (control.enabled || control.pending ? "" : " (not now)"));
            lines.push({ text: `Run controls: ${parts.join(" · ")} — stop and cancel ask first`, color: controls.busy ? "yellow" : "cyan", indent: "" });
            for (const reason of new Set(controls.controls.filter(control => !control.enabled).map(control => control.title))) {
                lines.push({ text: reason, color: "gray", indent: "  " });
            }
        } else {
            const status = projection.runReadModel?.run?.status;
            lines.push({ text: `Run controls: none for this run${typeof status === "string" ? ` (${status})` : ""}.`, color: "gray", indent: "" });
        }
        if (controls.restriction) lines.push({ text: controls.restriction, color: "gray", indent: "  " });
    }
    const notice = projection.runNotice;
    if (notice) {
        lines.push({ text: `! ${notice.text}`, color: notice.level === "error" ? "red" : "yellow", indent: "" });
        const key = Object.hasOwn(WORKFLOW_VIEW_RUN_CONTROL_KEYS, notice.operation) ? WORKFLOW_VIEW_RUN_CONTROL_KEYS[notice.operation] : null;
        lines.push({ text: `${notice.retry && key ? `${key} sends the same command again (the server applies it once) · ` : ""}d dismisses this notice`,
            color: "gray", indent: "  " });
    }
    return lines;
}

/** At most this many of the shown run's variables are listed in the view's details; the variables form lists them all. */
const VARIABLE_ROWS = 8;

/**
 * The shown run's variables as detail entries: its revision, its variables (name = value, cut to one line), the note
 * or the start of a preview too long to list, and why a person cannot change them when they cannot. None without a
 * person's commands. `clip` entries are cut to one line, the others wrapped.
 */
function runVariableLines(projection) {
    const variables = projection.runVariables;
    if (!variables) return [];
    const lines = [{ text: `Variables${variables.revision === null ? "" : ` · revision ${variables.revision}`}`
        + (variables.editable ? " — v sets or removes one · V updates several at once" : ""), color: "cyan", indent: "" }];
    for (const entry of variables.entries.slice(0, VARIABLE_ROWS)) lines.push({ text: `${entry.key} = ${entry.displayText}`, color: "white", indent: "  ", clip: true });
    if (variables.entries.length > VARIABLE_ROWS) {
        lines.push({ text: `… ${variables.entries.length - VARIABLE_ROWS} more; the variables form (v) lists them all`, color: "gray", indent: "  " });
    }
    if (variables.note) lines.push({ text: variables.note, color: "gray", indent: "  " });
    if (variables.preview) lines.push({ text: variables.preview, color: "gray", indent: "  ", clip: true });
    if (!variables.editable && variables.reason) lines.push({ text: variables.reason, color: "gray", indent: "  " });
    return lines;
}

/**
 * Whether the open workflow view can open the variables form for the run it shows, and why not: `{ ok: true, runId }`
 * when the portal's variables panel (workflowV2RunVariables) would let a person change them, otherwise `{ ok: false,
 * reason }`, a sentence for the status line. The server decides every update again. Pure.
 */
export function workflowViewVariablesFor(selection) {
    const projection = selection?.projection ?? null;
    const variables = projection?.runVariables ?? null;
    if (!variables) {
        const model = projection?.runReadModel ?? null;
        const why = !isPlainRecord(model) ? "The shown run is not loaded yet." : !isPlainRecord(model.run) ? "No run is shown."
            : !isPlainRecord(model.personCommands) ? "This deployment takes no workflow commands from people." : "The shown run's status is not known.";
        return { ok: false, reason: `The variables cannot be changed here. ${why}` };
    }
    if (!variables.editable) return { ok: false, reason: `The variables cannot be changed here. ${variables.reason}` };
    if (variables.busy) return { ok: false, reason: "The variables cannot be changed now. Another command for this workflow is being sent." };
    return { ok: true, runId: variables.runId };
}


/**
 * The variables form (TUI modal "workflowVariable"; the portal's variables panel as a form): the run it was opened for,
 * its variables now (the one ↑↓ copied into the fields marked), why they cannot be changed when they cannot, an update
 * being sent, the last update's refusal or lost answer, the form's own check of what was typed, and its two fields
 * (name, JSON value) with the focused one. Null unless the form is open. Pure.
 */
export function selectWorkflowVariableModal(state, maxWidth = 100, viewportHeight = null) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowVariable") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const variables = projection.runVariables;
    const sameRun = Boolean(variables) && variables.runId === modal.runId;
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const lines = [];
    const add = (text, color = "white", extra = {}) => lines.push({ text: clip(text, contentWidth), color, ...extra });
    const addWrapped = (text, color, indent = "") => { for (const piece of wrapped(text, contentWidth, indent)) add(piece, color); };
    addWrapped(WORKFLOW_V2_VARIABLES_HELP_TEXT, "gray");
    let pickLine = -1;
    if (!sameRun) {
        addWrapped("The workflow view no longer shows the run this form was opened for, so it sends nothing. Esc goes back.", "yellow");
    } else {
        variables.entries.forEach((entry, index) => {
            const picked = index === modal.pick;
            if (picked) pickLine = lines.length;
            add(`${picked ? "▸" : " "} ${entry.key} = ${entry.displayText}`, picked ? "white" : "gray", picked ? { bold: true } : {});
        });
        if (variables.note) addWrapped(variables.note, "gray", "  ");
        if (variables.preview) add(`  ${variables.preview}`, "gray");
        if (!variables.editable && variables.reason) addWrapped(variables.reason, "yellow");
        if (variables.pending) add("Saving…", "yellow");
    }
    const notice = projection.runNotice?.operation === "set_vars" ? projection.runNotice : null;
    if (notice) {
        addWrapped(`! ${notice.text}`, notice.level === "error" ? "red" : "yellow");
        if (notice.retry) addWrapped("Enter (or ctrl-r) sends the same update again; the server applies it once.", "gray", "  ");
    }
    const behind = sameRun ? variablesBehind(modal, variables, Boolean(String(modal.name ?? "") || String(modal.value ?? "")), notice) : null;
    if (behind) addWrapped(behind.help, "yellow");
    // What the last ctrl-l did when it could not simply load the value (re-check RC-1).
    if (sameRun && typeof modal.loadNotice === "string" && modal.loadNotice) addWrapped(modal.loadNotice, "yellow");
    if (typeof modal.error === "string" && modal.error) addWrapped(modal.error, "red");
    const listHeight = Math.max(6, Math.min(lines.length + 2, Math.max(6, (Number(viewportHeight ?? state?.ui?.layout?.viewportHeight) || 40) - 16)));
    const rows = Math.max(1, listHeight - 2);
    const scrollOffset = pickLine < 0 ? 0 : Math.max(0, Math.min(pickLine - Math.floor(rows / 2), Math.max(0, lines.length - rows)));
    return {
        title: `Variables · run ${shortRunId(modal.runId)}${sameRun && variables.revision !== null ? ` · revision ${variables.revision}` : ""}`,
        lines, listHeight, scrollOffset,
        field: modal.field === "value" ? "value" : "name",
        name: String(modal.name ?? ""), nameCursor: Number(modal.nameCursor) || 0,
        value: String(modal.value ?? ""), valueCursor: Number(modal.valueCursor) || 0,
        busy: Boolean(variables?.busy),
        hint: behind ? "ctrl-l load the new values · ctrl-k keep your edit · Esc back to the view"
            : "Tab name/value · ↑↓ copy a listed variable · Enter set · ctrl-r remove (asks first) · Esc back to the view",
        idealWidth: width,
    };
}

/** At most this many names are listed in the several-variables form's review; the update sends them all. */
const BATCH_REVIEW_ROWS = 12;

/**
 * The several-variables form (TUI modal "workflowVariableBatch"; design 02 open KV, set_vars as one batch): what one
 * update of the run it was opened for sends, from what is typed now (workflowV2VariableBatchDraft): each name under Set
 * added, or replacing the value it has (whole), each name under Remove removed, at the revision the view shows; every
 * other variable stays as it is, and the server applies all of it or none. Before it: why the variables cannot be
 * changed, an update being sent, the last update's refusal or lost answer and the form's own check of what was typed;
 * after it, the run's variables now. Its two fields: Set (a JSON object of names and values) and Remove (a JSON list of
 * names). Null unless the form is open. Pure.
 */
export function selectWorkflowVariableBatchModal(state, maxWidth = 100, viewportHeight = null) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowVariableBatch") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const variables = projection.runVariables;
    const sameRun = Boolean(variables) && variables.runId === modal.runId;
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const lines = [];
    const add = (text, color = "white", extra = {}) => lines.push({ text: clip(text, contentWidth), color, ...extra });
    const addWrapped = (text, color, indent = "") => { for (const piece of wrapped(text, contentWidth, indent)) add(piece, color); };
    const setText = String(modal.set ?? "");
    const removeText = String(modal.remove ?? "");
    addWrapped("One update of several variables: each name under Set gets its JSON value (a new name is added; a value it has is "
        + "replaced whole, not merged), each name under Remove is removed, and every other variable stays as it is. The server "
        + "applies all of it at the revision shown, or none of it.", "gray");
    if (!sameRun) {
        addWrapped("The workflow view no longer shows the run this form was opened for, so it sends nothing. Esc goes back.", "yellow");
    } else {
        if (!variables.editable && variables.reason) addWrapped(variables.reason, "yellow");
        if (variables.pending) add("Saving…", "yellow");
    }
    const notice = projection.runNotice?.operation === "set_vars" ? projection.runNotice : null;
    if (notice) {
        addWrapped(`! ${notice.text}`, notice.level === "error" ? "red" : "yellow");
        if (notice.retry) addWrapped("Enter sends the same update again; the server applies it once.", "gray", "  ");
    }
    const behind = sameRun ? variablesBehind(modal, variables, Boolean(setText.trim() || removeText.trim()), notice) : null;
    if (behind) addWrapped(behind.help.replace("ctrl-l loads the new values", "ctrl-l starts over at the new revision"), "yellow");
    if (typeof modal.error === "string" && modal.error) addWrapped(modal.error, "red");
    // The revision Enter sends at: the edit's own (R2-UI-1).
    const sendRevision = Number.isSafeInteger(modal.baseRevision) ? modal.baseRevision : variables?.revision ?? null;
    // What Enter sends, only where it may send anything (the reason above says why not).
    if (sameRun && variables.editable) {
        if (!setText.trim() && !removeText.trim()) {
            addWrapped("Set: a JSON object of names and values, for example {\"limit\": 5, \"mode\": \"fast\"}. Remove: a JSON list of "
                + "names, for example [\"old\", \"stale key\"]. Either may be empty, not both.", "gray");
        } else {
            const draft = workflowV2VariableBatchDraft(setText, removeText);
            if (!draft.ok) {
                addWrapped(`Nothing to send yet: ${draft.error}`, "gray");
            } else {
                // Whether a name has a value now is known only from a whole list (a preview cut short lists none).
                const listed = variables.complete ? new Set(variables.entries.map(entry => entry.key)) : null;
                add(`${behind ? "Kept edit" : "Enter sends one update"}${sendRevision === null ? "" : ` at revision ${sendRevision}`}:`, "cyan");
                const rows = [
                    ...Object.keys(draft.set).map(name => `${listed === null ? "set" : listed.has(name) ? "replace" : "add"} '${name}' = `
                        + JSON.stringify(draft.set[name])),
                    ...draft.delete.map(name => `remove '${name}'${listed !== null && !listed.has(name) ? " (not set now)" : ""}`),
                ];
                for (const row of rows.slice(0, BATCH_REVIEW_ROWS)) add(`  ${row}`);
                if (rows.length > BATCH_REVIEW_ROWS) add(`  … ${rows.length - BATCH_REVIEW_ROWS} more, sent with the rest`, "gray");
                if (draft.delete.length) add("It removes variables, so it asks first.", "gray");
            }
        }
    }
    if (sameRun) {
        add(`Variables now${variables.revision === null ? "" : ` · revision ${variables.revision}`}:`, "cyan");
        for (const entry of variables.entries) add(`  ${entry.key} = ${entry.displayText}`, "gray");
        if (variables.note) addWrapped(variables.note, "gray", "  ");
        if (variables.preview) add(`  ${variables.preview}`, "gray");
    }
    const listHeight = Math.max(6, Math.min(lines.length + 2, Math.max(6, (Number(viewportHeight ?? state?.ui?.layout?.viewportHeight) || 40) - 16)));
    return {
        title: `Several variables · run ${shortRunId(modal.runId)}${sameRun && variables.revision !== null ? ` · revision ${variables.revision}` : ""}`,
        lines, listHeight, scrollOffset: 0,
        field: modal.field === "remove" ? "remove" : "set",
        set: setText, setCursor: Number(modal.setCursor) || 0,
        remove: removeText, removeCursor: Number(modal.removeCursor) || 0,
        busy: Boolean(variables?.busy),
        hint: behind ? "ctrl-l start over at the new revision · ctrl-k keep your edit · Esc back to the view"
            : "Tab set/remove · Enter send as one update (a removal asks first) · Esc back to the view",
        idealWidth: width,
    };
}

/**
 * A person's edit of the draft's YAML as the editor shows it: the view's kept edit (`draftEdit`: `base`, the revision
 * it started from and that revision's YAML, its `text` and its `cursor`), or the current revision untouched. As the
 * portal's editor does, a newer revision read while nothing was edited (or one that is exactly this edit, once saved)
 * is taken as it is; an edit that starts from a revision the read model does not show yet (one this person just saved)
 * is kept. Null without an editor (no draft a person may change). Pure.
 */
export function workflowDraftBuffer(edit, editor) {
    if (!editor) return null;
    const fresh = cursor => ({ base: { revision: editor.revision, yaml: editor.yaml }, text: editor.yaml,
        cursor: Math.max(0, Math.min(Number(cursor) || 0, editor.yaml.length)) });
    if (!isPlainRecord(edit) || !isPlainRecord(edit.base) || !Number.isSafeInteger(edit.base.revision) || typeof edit.base.yaml !== "string"
        || typeof edit.text !== "string") return fresh(0);
    const cursor = Math.max(0, Math.min(Number(edit.cursor) || 0, edit.text.length));
    if (edit.base.revision < editor.revision && (edit.text === edit.base.yaml || edit.text === editor.yaml)) return fresh(cursor);
    return { base: { revision: edit.base.revision, yaml: edit.base.yaml }, text: edit.text, cursor };
}

/**
 * Why the open workflow view has no draft editor, as a sentence; null when it has one (a draft whose YAML the read model
 * gives a person who may change it: the portal's workflowV2DraftEditor). Pure.
 */
export function workflowViewDraftRefusal(selection) {
    const projection = selection?.projection ?? null;
    if (projection?.draftEditor) return null;
    const model = projection?.definitionModel ?? null;
    const commands = isPlainRecord(model?.personCommands) ? model.personCommands : null;
    const offered = Array.isArray(commands?.operations) && commands.operations.includes("replace_definition");
    const viewer = isPlainRecord(commands?.viewer) ? commands.viewer : null;
    const why = !isPlainRecord(model) ? "The workflow is not loaded yet."
        : !commands ? "This deployment takes no workflow commands from people."
            : model.definition?.state === "published" ? "The definition is published; it no longer changes. A new version needs a new workflow."
                : model.definition?.state !== "draft" ? "The workflow has no draft."
                    : !offered ? workflowV2RestrictionText(commands) ?? "This workflow takes no draft changes from people."
                        : viewer?.allowed === false ? (typeof viewer.reason === "string" && viewer.reason ? viewer.reason : "You cannot command this workflow.")
                            : "Its YAML is not given to you.";
    return `The draft cannot be edited here. ${why}`;
}

/** The draft's place in the view's details: its revision and how to edit it, and an edit kept unsaved. */
function draftLines(projection) {
    const editor = projection.draftEditor;
    if (!editor) return [];
    const lines = [{ text: `Draft · revision ${editor.revision}${editor.semver ? ` · version ${editor.semver}` : ""} — e edits its YAML`
        + `${editor.revision > 1 ? " · C compares versions" : ""}`, color: "cyan", indent: "" }];
    if (projection.draftEdit?.changed) {
        lines.push({ text: `Unsaved edits, started from revision ${projection.draftBuffer.base.revision}: e shows them`, color: "yellow", indent: "  " });
    }
    return [...lines, ...revisionCompareLines(projection)];
}

const REVISION_COMPARE_CONTEXT = 2;
const REVISION_COMPARE_ROWS = 200;

/**
 * The draft's two versions compared (owner decision q4; the portal's "Compare versions" as + and - lines), after C: the
 * summary, then each changed line with the line numbers it has in each version and two unchanged lines around it,
 * "…" where unchanged lines are left out; at most 200 rows (the portal shows them all). Each side is its revision's
 * YAML properly formatted (as saved when it does not parse). Only while the comparison is of the latest revision.
 */
function revisionCompareLines(projection) {
    const open = projection.revisionCompare;
    const latest = projection.draftEditor?.revision;
    if (!open || open.to !== latest || !Number.isSafeInteger(open.from) || open.from < 1 || open.from >= latest) return [];
    const compare = workflowV2RevisionCompare(projection.definitionRevisions, open.from, open.to);
    const lines = [{ text: `Compare versions: ${compare.summary}`, color: compare.failed ? "red" : compare.ready ? "white" : "yellow", indent: "  " }];
    if (compare.failed) return [...lines, { text: "C closes; C once more reads it again", color: "gray", indent: "    " }];
    if (!compare.ready) return lines;
    const notes = [compare.before, compare.after].filter(side => !side.formatted).map(side => side.revision);
    if (notes.length) lines.push({ text: `Revision ${notes.join(" and ")} is shown as saved: it is not valid YAML`, color: "yellow", indent: "    " });
    if (compare.diff.approximate) lines.push({ text: "Large change: the changed lines are listed as removed, then added", color: "gray", indent: "    " });
    const rows = compare.diff.rows;
    const near = new Set();
    rows.forEach((row, index) => {
        if (row.kind === "same") return;
        for (let k = index - REVISION_COMPARE_CONTEXT; k <= index + REVISION_COMPARE_CONTEXT; k++) near.add(k);
    });
    const number = value => (value === null ? "" : String(value)).padStart(4);
    let shown = 0;
    let skipped = false;
    for (let index = 0; index < rows.length; index++) {
        if (!near.has(index)) { skipped = true; continue; }
        if (shown >= REVISION_COMPARE_ROWS) {
            lines.push({ text: "… more changes (the portal shows them all)", color: "gray", indent: "    " });
            break;
        }
        if (skipped) { lines.push({ text: "…", color: "gray", indent: "    " }); skipped = false; }
        const row = rows[index];
        const mark = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
        lines.push({ text: `${number(row.before)} ${number(row.after)} ${mark} ${row.text}`, clip: true,
            color: row.kind === "added" ? "green" : row.kind === "removed" ? "red" : "gray", indent: "    " });
        shown += 1;
    }
    lines.push({ text: ", compares an older first version · . a newer one · C closes", color: "gray", indent: "    " });
    return lines;
}

/** The draft editor's line and column of character `cursor` of `text`. */
function lineAndColumn(text, cursor) {
    const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
    const line = before.split("\n").length - 1;
    return { line, column: before.length - (before.lastIndexOf("\n") + 1) };
}

/**
 * One editor row of at most `width` characters (the panel never wraps it, so a row is a line): the line, cut with "…"
 * where it goes on; the cursor's line (`column`) is shown around the cursor, a cursor after its end being a blank cell,
 * so a long line never hides it. A tab is one space.
 */
function editorRow(line, width, column = null) {
    const text = line.replace(/\t/g, " ");
    if (column === null) return text.length > width ? [{ text: text.slice(0, width - 1), color: "white" }, { text: "…", color: "gray" }] : [{ text, color: "white" }];
    const cells = column < text.length ? text : `${text} `;
    let start = 0;
    let end = cells.length;
    if (cells.length > width) {
        // Room for "…" at either end; the cursor stays three quarters of the way across where the line goes on.
        const room = width - 2;
        start = Math.min(Math.max(0, column - Math.floor(room * 3 / 4)), cells.length - room);
        end = start + room;
    }
    return [
        ...(start > 0 ? [{ text: "…", color: "gray" }] : []),
        { text: cells.slice(start, column), color: "white" },
        { text: cells[column], color: "promptCursorForeground", backgroundColor: "promptCursorBackground" },
        { text: cells.slice(column + 1, end), color: "white" },
        ...(end < cells.length ? [{ text: "…", color: "gray" }] : []),
    ];
}

/**
 * The draft editor (TUI modal "workflowDraft"; the portal's draft editor as a terminal editor): the revision the edit
 * started from, the version that cannot change, the YAML with line numbers and the cursor, and below it what the edit
 * is (no unsaved edits, unsaved, in conflict with a newer revision, or why it cannot be saved), a save being sent or
 * another command, the last save's refusal or lost answer, a just-saved revision the view has not read yet, and the
 * current revision's compile diagnostics. Null unless the editor is open. Pure.
 */
export function selectWorkflowDraftModal(state, maxWidth = 100, viewportHeight = null) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowDraft") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const editor = projection.draftEditor;
    const buffer = projection.draftBuffer;
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const height = Number(viewportHeight ?? state?.ui?.layout?.viewportHeight) || 40;
    const status = [];
    const add = (text, color = "white", indent = "") => { for (const piece of wrapped(text, contentWidth, indent)) status.push({ text: piece, color }); };
    const keys = hint => {
        const hintLines = wrapped(hint, contentWidth).map(text => ({ text, color: "gray" }));
        return { hint, hintLines, hintHeight: hintLines.length + 2 };
    };
    if (!editor || !buffer) {
        add(workflowViewDraftRefusal({ projection }) ?? "The draft cannot be edited here.", "yellow");
        return { title: "Draft", lines: [], editorHeight: 3, scrollOffset: 0, statusLines: status, statusHeight: Math.min(8, status.length + 2),
            ...keys("Esc close"), idealWidth: width, changed: false };
    }
    const edit = projection.draftEdit;
    const textLines = buffer.text.split("\n");
    const gutter = String(textLines.length).length + 1;
    const at = lineAndColumn(buffer.text, buffer.cursor);
    // A revision this person just saved, which the read model does not show yet.
    const unread = buffer.base.revision > editor.revision;
    // The saved revision's errors on their lines (owner decision q5): the line number in red (a warning in yellow) with "!".
    const marks = new Map(editor.current && !unread ? workflowV2DraftMarks(editor.diagnostics).lines.map(mark => [mark.line, mark]) : []);
    const lines = textLines.map((line, index) => {
        const mark = marks.get(index + 1);
        return [{ text: `${String(index + 1).padStart(gutter - 1)}${mark ? "!" : " "}`, color: mark ? (mark.severity === "error" ? "red" : "yellow") : "gray" },
            ...editorRow(line, Math.max(10, contentWidth - gutter), index === at.line ? at.column : null)];
    });
    const editorHeight = Math.max(8, height - 16);
    const rows = Math.max(1, editorHeight - 2);
    const scrollOffset = Math.max(0, Math.min(at.line - Math.floor(rows / 2), Math.max(0, lines.length - rows)));
    if (edit.conflict) add(edit.reason, "yellow");
    else if (edit.changed) add(edit.reason ?? `Unsaved edits. ctrl-o saves them as a new revision after revision ${buffer.base.revision}.`, edit.reason ? "red" : "yellow");
    else add("No unsaved edits.", "gray");
    if (editor.pending) add("Saving…", "yellow");
    else if (editor.busy) add("Another command for this workflow is being sent; a save waits for its answer.", "gray");
    const notice = projection.runNotice?.operation === "replace_definition" ? projection.runNotice : null;
    if (notice) {
        add(`! ${notice.text}`, notice.level === "error" ? "red" : "yellow");
        if (notice.retry) add("ctrl-o sends the same save again; the server applies it once.", "gray");
    }
    if (unread) add(`Saved as revision ${buffer.base.revision}; the view has not read it yet.`, "gray");
    const diagnostics = (projection.v2?.diagnostics || []).filter(item => item && typeof item === "object");
    if (diagnostics.length && editor.current && !unread) {
        const errors = diagnostics.filter(item => item.severity !== "warning").length;
        add(`Revision ${editor.revision}: ${errors} error${errors === 1 ? "" : "s"}${diagnostics.length > errors ? `, ${diagnostics.length - errors} warning${diagnostics.length - errors === 1 ? "" : "s"}` : ""}.`,
            errors ? "red" : "yellow");
        for (const item of diagnostics.slice(0, 5)) {
            add(`${item.severity} ${item.code}${item.path ? ` · ${item.path}` : ""}${Number.isSafeInteger(item.line) ? ` · line ${item.line}` : ""}: ${item.message}`,
                item.severity === "warning" ? "yellow" : "red", "  ");
        }
        if (diagnostics.length > 5) add(`… ${diagnostics.length - 5} more`, "gray", "  ");
    }
    return {
        title: `Draft · editing revision ${buffer.base.revision}${editor.semver ? ` · version ${editor.semver} (it cannot change)` : ""} · line ${at.line + 1}, column ${at.column + 1}`,
        lines, editorHeight, scrollOffset, statusLines: status, statusHeight: Math.max(3, Math.min(10, status.length + 2)),
        ...keys(edit.conflict
            ? `ctrl-r load revision ${editor.revision} (asks first) · ctrl-k keep my edits on revision ${editor.revision} · Esc close (edits kept)`
            : "ctrl-o save · ctrl-r discard edits (asks first) · Enter new line · Tab two spaces · Esc close (edits kept)"),
        idealWidth: width, changed: Boolean(edit.changed),
    };
}

/** The keys of a publication review's actions; each asks first. */
export const WORKFLOW_PUBLICATION_KEYS = Object.freeze({ publish: "ctrl-p", publish_and_start: "ctrl-r", start: "ctrl-r" });
const PUBLICATION_OPERATIONS = new Set(Object.keys(WORKFLOW_PUBLICATION_KEYS));

/**
 * What a publication review is of (its `pin`): a draft's current revision and that revision's definition hash, or a
 * published definition's revision and hash, from the portal's publication model (workflowV2DefinitionControls). Null
 * without one. Pure.
 */
export function workflowPublicationPin(publication) {
    if (!isPlainRecord(publication)) return null;
    return publication.state === "draft"
        ? { state: "draft", revision: publication.revision ?? null, definitionHash: publication.definitionHash ?? null }
        : { state: "published", revision: publication.publishedRevision ?? null, definitionHash: publication.publishedDefinitionHash ?? null };
}

/** Whether two publication pins name the same definition state, revision and definition hash. */
function samePin(a, b) {
    return isPlainRecord(a) && isPlainRecord(b) && a.state === b.state && a.revision === b.revision && a.definitionHash === b.definitionHash;
}

/** A definition hash as a confirm dialog quotes it (the review shows it whole). */
const shortHash = hash => (typeof hash === "string" && hash ? (hash.length > 16 ? `${hash.slice(0, 12)}…` : hash) : "not known");

/** At most this many characters of a run's inputs or initial variables are quoted in a confirm dialog; the review shows them whole. */
const CONFIRM_JSON_LIMIT = 160;

function jsonPreview(value) {
    let text;
    try { text = JSON.stringify(value); } catch { text = String(value); }
    text = typeof text === "string" ? text : String(value);
    return text.length > CONFIRM_JSON_LIMIT ? `${text.slice(0, CONFIRM_JSON_LIMIT - 1)}…` : text;
}

/**
 * Why a publication review of `pin` sends nothing now that the workflow shows `publication`, as a sentence: the
 * workflow it was opened for moved on (a newer draft revision, or published meanwhile), or can no longer be published
 * or started here; null while the workflow still shows exactly what the review is of. Pure.
 */
export function workflowPublicationChange(pin, publication) {
    const current = workflowPublicationPin(publication);
    return samePin(pin, current) ? null : publicationChange(pin, current);
}

/** The sentence of workflowPublicationChange for a review of `pin` whose workflow now shows `current` (a pin, or null). */
function publicationChange(pin, current) {
    const was = `revision ${pin?.revision ?? "not known"}`;
    if (!current) return "The workflow can no longer be published or started here, so nothing is sent. Esc goes back.";
    if (pin?.state === "draft" && current.state === "published") {
        return `The workflow was published meanwhile (revision ${current.revision ?? "not known"}); this review is of draft ${was}, so nothing is sent for it. ctrl-l reviews the workflow as it is now.`;
    }
    return `The workflow now shows revision ${current.revision ?? "not known"} (definition hash ${shortHash(current.definitionHash)}); this review is of ${was}, so nothing is sent for it. ctrl-l reviews revision ${current.revision ?? "not known"}.`;
}

/**
 * The confirm dialog of a publication review's action: what exactly is published or started (the pinned revision of
 * the named definition and its definition hash), with which inputs and initial variables, and what it does: publishing
 * freezes the revision and starts no run (it approves no repository write and grants no tool); a live run's effects are
 * real, and a workflow has one live run. Pure.
 */
export function workflowPublicationConfirm(operation, pin, publication, args = {}) {
    const name = [publication?.name, publication?.semver].filter(Boolean).join(" ") || "this workflow";
    const what = `revision ${pin?.revision ?? "not known"} of ${name} (definition hash ${shortHash(pin?.definitionHash)})`;
    const given = ` with inputs ${jsonPreview(args?.inputs ?? {})}${args?.vars !== undefined ? ` and initial variables ${jsonPreview(args.vars)}` : ""}`;
    if (operation === "publish") {
        return { title: `Publish Revision ${pin?.revision ?? ""}`.trim(), confirmLabel: "Publish",
            message: `Publish ${what}? It no longer changes afterwards, and no run starts. Publication approves no repository write and grants no tool.` };
    }
    if (operation === "publish_and_start") {
        return { title: `Publish and Start Revision ${pin?.revision ?? ""}`.trim(), confirmLabel: "Publish and Start",
            message: `Publish ${what} and start its live run${given}? It no longer changes afterwards, and the live run's effects are real.` };
    }
    return { title: "Start the Live Run", confirmLabel: "Start",
        message: `Start the live run of published ${what}${given}? Its effects are real, and a workflow has one live run.` };
}

/**
 * Why the open workflow view has no publication review, as a sentence; null when it has one (the portal's publication
 * controls offer publish, publish and start, or start). Pure.
 */
export function workflowViewPublicationRefusal(selection) {
    const projection = selection?.projection ?? null;
    const publication = projection?.publication ?? null;
    if (publication?.controls?.length) return null;
    const model = projection?.definitionModel ?? null;
    const why = !isPlainRecord(model) ? "The workflow is not loaded yet."
        : !isPlainRecord(model.personCommands) ? "This deployment takes no workflow commands from people."
            : !publication ? `The definition is ${typeof model.definition?.state === "string" && model.definition.state ? model.definition.state : "in no known state"}.`
                : publication.note ?? "This workflow takes no publication commands from people.";
    return `Publication cannot be reviewed here. ${why}`;
}

/** The definition's publication in the view's details: what P reviews, when the workflow takes any of it from people. */
function publicationLines(projection) {
    const publication = projection.publication;
    if (!publication?.controls?.length) return [];
    const subject = publication.state === "draft"
        ? `draft revision ${publication.revision ?? "not known"}${publication.valid ? "" : " (it has errors)"}`
        : `published revision ${publication.publishedRevision ?? "not known"}, no live run yet`;
    const actions = publication.controls.map(control => control.label.toLowerCase()).join(" or ");
    return [{ text: `Publication: ${subject} — P reviews: ${actions}`, color: publication.busy ? "yellow" : "cyan", indent: "" }];
}

/**
 * The publication review (TUI modal "workflowPublish"; the portal's publication panel, mocks M01 and M03): exactly what
 * is published or started (the definition, the revision and full definition hash the review was opened for, its
 * validity), what has live effects, that publication approves no repository write and grants no tool, the actions with
 * their keys (each asks first) or why one is not available now, a review whose workflow changed meanwhile (nothing is
 * sent for it until it is reviewed again), the last publication command's refusal or lost answer, the review's own
 * check of what was typed, and, where a live run can start, its inputs and initial variables (JSON objects). Null
 * unless the review is open. Pure.
 */
export function selectWorkflowPublicationModal(state, maxWidth = 100, viewportHeight = null) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowPublish") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const publication = projection.publication;
    const pin = isPlainRecord(modal.pin) ? modal.pin : null;
    const change = workflowPublicationChange(pin, publication);
    const changed = change !== null;
    const draft = pin?.state === "draft";
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const lines = [];
    const add = (text, color = "white", indent = "") => { for (const piece of wrapped(text, contentWidth, indent)) lines.push({ text: piece, color }); };
    const controls = changed ? [] : publication?.controls ?? [];
    const runs = Boolean(publication?.controls?.some(control => control.operation !== "publish"));
    add(`Definition: ${[publication?.name, publication?.semver].filter(Boolean).join(" ") || "Not named"}`);
    add(`${draft ? "Revision" : "Published revision"}: ${pin?.revision ?? "Not known"}`);
    add(`Definition hash: ${pin?.definitionHash ?? "Not known"}`);
    if (draft && !changed && publication) {
        add(`Validity: ${publication.valid ? "Valid" : `${publication.errors || "Unlisted"} error${publication.errors === 1 ? "" : "s"}: it cannot be published`}`,
            publication.valid ? "white" : "red");
    }
    add(`Live effects: ${runs ? "Only when its live run starts" : "None until a live run starts"}`);
    // What publication pins for each named agent, and the tests of exactly this revision (as the portal's review says them).
    const versionsNow = state.ui?.workflowViews?.[modal.sessionId]?.agentVersions ?? null;
    if (!changed && publication) for (const [label, value] of workflowV2PublicationEvidenceRows(publication, versionsNow)) add(`${label.trim()}: ${value}`, "white", label.startsWith(" ") ? "  " : "");
    add(draft
        ? "Publishing freezes this exact revision: it no longer changes, and a new version needs a new workflow. Publication starts no run, approves no repository write and grants no tool."
        : "Starting runs the published revision with real effects. A workflow has one live run.", "gray");
    if (changed) add(change, "yellow");
    for (const control of controls) {
        add(`${WORKFLOW_PUBLICATION_KEYS[control.operation]} ${control.label}${control.enabled || control.pending ? "" : ` — not now: ${control.title}`}`,
            control.enabled ? "cyan" : "gray");
    }
    if (!changed && publication && !publication.controls.length && publication.note) add(publication.note, "yellow");
    const notice = projection.runNotice && PUBLICATION_OPERATIONS.has(projection.runNotice.operation) ? projection.runNotice : null;
    if (notice) {
        add(`! ${notice.text}`, notice.level === "error" ? "red" : "yellow");
        if (notice.retry) add("The same key sends the same command again once you confirm it; the server applies it once.", "gray", "  ");
    }
    if (typeof modal.error === "string" && modal.error) add(modal.error, "red");
    const fields = runs && !changed;
    const height = Number(viewportHeight ?? state?.ui?.layout?.viewportHeight) || 40;
    const listHeight = Math.max(6, Math.min(lines.length + 2, Math.max(6, height - (fields ? 18 : 10))));
    const keys = changed ? ["ctrl-l review it as it is now"] : controls.map(control => `${WORKFLOW_PUBLICATION_KEYS[control.operation]} ${control.label.toLowerCase()}`);
    const hint = `${[...keys, ...(fields ? ["Tab inputs/variables"] : []), "Esc back"].join(" · ")}${!changed && controls.length ? " — each asks first" : ""}`;
    const hintLines = wrapped(hint, contentWidth).map(text => ({ text, color: "gray" }));
    return {
        title: draft ? `Publish review · revision ${pin?.revision ?? "not known"}` : `Start the live run · published revision ${pin?.revision ?? "not known"}`,
        lines, listHeight, scrollOffset: 0, changed, fields,
        field: modal.field === "vars" ? "vars" : "inputs",
        inputs: String(modal.inputs ?? ""), inputsCursor: Number(modal.inputsCursor) || 0,
        vars: String(modal.vars ?? ""), varsCursor: Number(modal.varsCursor) || 0,
        busy: Boolean(publication?.busy),
        hint, hintLines, hintHeight: hintLines.length + 2, idealWidth: width,
    };
}

/** At most this many characters of a scenario name are quoted in a confirm dialog; the review shows it whole. */
const CONFIRM_SCENARIO_LIMIT = 60;

/**
 * What a test review is of (its `pin`): the definition's current revision (a draft's, or a published one's) and that
 * revision's definition hash, from the portal's test model (workflowV2TestControls). Null without one. Pure.
 */
export function workflowTestPin(tests) {
    if (!isPlainRecord(tests)) return null;
    return { state: tests.state, revision: tests.revision ?? null, definitionHash: tests.definitionHash ?? null };
}

/**
 * Why a test review of `pin` sends nothing now that the workflow shows `tests`, as a sentence: its current revision or
 * hash moved on (publishing the same revision does not change what is tested), or it can no longer be tested here;
 * null while the workflow still shows exactly the revision and hash the review is of. Pure.
 */
export function workflowTestChange(pin, tests) {
    const current = workflowTestPin(tests);
    if (current && isPlainRecord(pin) && current.revision === pin.revision && current.definitionHash === pin.definitionHash) return null;
    if (!current) return "The workflow can no longer be tested here, so nothing is sent. Esc goes back.";
    return `The workflow now shows revision ${current.revision ?? "not known"} (definition hash ${shortHash(current.definitionHash)}); this review is of `
        + `revision ${pin?.revision ?? "not known"}, so nothing is sent for it. ctrl-l reviews revision ${current.revision ?? "not known"}.`;
}

/**
 * The confirm dialog of a test review's start: exactly what is tested (the pinned revision of the named definition and
 * its definition hash), with mocked or real agents, which inputs, initial variables and scenario name, and the test
 * notices (scripts run normally and their direct effects are real; framework tools are mocked; real agents spend model
 * tokens), and that the live run is not changed. Pure.
 */
export function workflowTestConfirm(pin, tests, args = {}) {
    const name = [tests?.name, tests?.semver].filter(Boolean).join(" ") || "this workflow";
    const real = args?.agentMode === "real";
    const what = `${pin?.state === "draft" ? "draft " : ""}revision ${pin?.revision ?? "not known"} of ${name} (definition hash ${shortHash(pin?.definitionHash)})`;
    const scenario = typeof args?.scenario === "string"
        ? `, scenario '${args.scenario.length > CONFIRM_SCENARIO_LIMIT ? `${args.scenario.slice(0, CONFIRM_SCENARIO_LIMIT - 1)}…` : args.scenario}'` : "";
    const given = `inputs ${jsonPreview(args?.inputs ?? {})}${args?.vars !== undefined ? `, initial variables ${jsonPreview(args.vars)}` : ""}${scenario}`;
    return { title: "Start Test Run", confirmLabel: "Start Test",
        message: `Start a test run of ${what} with ${real ? "real agents, which spend model tokens" : "mocked agents (the parent answers for each agent step)"}; `
            + `${given}? ${WORKFLOW_V2_TEST_NOTICE_TEXT}${real ? ` ${WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT}` : ""} The live run is not changed.` };
}

/**
 * Why the open workflow view has no test review, as a sentence; null when it has one (the portal's test review would
 * offer a test of the current revision). Pure.
 */
export function workflowViewTestRefusal(selection) {
    const projection = selection?.projection ?? null;
    if (projection?.testControls) return null;
    const model = projection?.definitionModel ?? null;
    const commands = isPlainRecord(model?.personCommands) ? model.personCommands : null;
    const offered = Array.isArray(commands?.operations) && commands.operations.includes("test");
    const why = !isPlainRecord(model) ? "The workflow is not loaded yet."
        : !commands ? "This deployment takes no workflow commands from people."
            // of-06: only a draft is tested.
            : model.definition?.state === "published" ? WORKFLOW_V2_TEST_NEEDS_DRAFT_TEXT
                : !offered ? workflowV2RestrictionText(commands) ?? "This workflow takes no test from people."
                    : `The definition is ${typeof model.definition?.state === "string" && model.definition.state ? model.definition.state : "in no known state"}.`;
    return `A test cannot be started here. ${why}`;
}

/** A test of the definition in the view's details: what t reviews, when the workflow takes a test from people. */
function testLines(projection) {
    const tests = projection.testControls;
    if (!tests) return [];
    return [{ text: `Test: ${tests.state === "draft" ? "draft " : ""}revision ${tests.revision ?? "not known"}${tests.valid ? "" : " (it has errors)"}`
        + " — t reviews a test run", color: tests.busy ? "yellow" : "cyan", indent: "" }];
}

/**
 * The test review (TUI modal "workflowTest"; the portal's test review, mocks M18 to M20): the test notice (scripts run
 * normally and their direct effects are real; framework tools are mocked; a test result is not evidence that the
 * definition is safe to run live), exactly what is tested (the definition, the revision and full definition hash the
 * review was opened for, its validity), whether agent states are mocked or real (with the real-agent notice), the start
 * with its key or why not now, a review whose workflow changed meanwhile (nothing is sent for it until it is reviewed
 * again), the last test start's refusal or lost answer, the review's own check of what was typed, and three fields: the
 * run's inputs and initial variables (JSON objects) and a scenario name. Null unless the review is open. Pure.
 */
export function selectWorkflowTestModal(state, maxWidth = 100, viewportHeight = null) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowTest") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const tests = projection.testControls;
    const pin = isPlainRecord(modal.pin) ? modal.pin : null;
    const change = workflowTestChange(pin, tests);
    const changed = change !== null;
    // Publishing the revision under review changes its state, not what is tested.
    const draft = (changed ? pin?.state : tests?.state) === "draft";
    const real = modal.agentMode === "real";
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const lines = [];
    const add = (text, color = "white", indent = "") => { for (const piece of wrapped(text, contentWidth, indent)) lines.push({ text: piece, color }); };
    add(WORKFLOW_V2_TEST_NOTICE_TEXT, "yellow");
    add(`Definition: ${[tests?.name, tests?.semver].filter(Boolean).join(" ") || "Not named"}`);
    add(`${draft ? "Draft revision" : "Revision"}: ${pin?.revision ?? "Not known"}`);
    add(`Definition hash: ${pin?.definitionHash ?? "Not known"}`);
    if (!changed && tests) {
        add(`Validity: ${tests.valid ? "Valid" : `${tests.errors || "Unlisted"} error${tests.errors === 1 ? "" : "s"}: it cannot be tested`}`, tests.valid ? "white" : "red");
    }
    add(real ? "Agent steps: real agents, which spend model tokens (ctrl-a: mocked)" : "Agent steps: mocked; the parent answers for each agent step (ctrl-a: real agents)",
        real ? "yellow" : "cyan");
    if (real) add(WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT, "yellow");
    if (changed) add(change, "yellow");
    else if (tests) {
        add(`ctrl-t ${tests.control.label}${tests.control.enabled || tests.control.pending ? "" : ` — not now: ${tests.control.title}`}`,
            tests.control.enabled ? "cyan" : "gray");
    }
    const notice = projection.runNotice?.operation === "test" ? projection.runNotice : null;
    if (notice) {
        add(`! ${notice.text}`, notice.level === "error" ? "red" : "yellow");
        if (notice.retry) add("ctrl-t sends the same test again once you confirm it; the server starts it once.", "gray", "  ");
    }
    if (typeof modal.error === "string" && modal.error) add(modal.error, "red");
    const fields = !changed && Boolean(tests);
    const height = Number(viewportHeight ?? state?.ui?.layout?.viewportHeight) || 40;
    const listHeight = Math.max(6, Math.min(lines.length + 2, Math.max(6, height - (fields ? 22 : 10))));
    const hint = changed ? "ctrl-l review it as it is now · Esc back"
        : "ctrl-t start the test (asks first) · ctrl-a agents mocked/real · Tab inputs/variables/scenario · Esc back";
    const hintLines = wrapped(hint, contentWidth).map(text => ({ text, color: "gray" }));
    return {
        title: `Test review · ${draft ? "draft " : ""}revision ${pin?.revision ?? "not known"}`,
        lines, listHeight, scrollOffset: 0, changed, fields, agentMode: real ? "real" : "mocked",
        field: ["vars", "scenario"].includes(modal.field) ? modal.field : "inputs",
        inputs: String(modal.inputs ?? ""), inputsCursor: Number(modal.inputsCursor) || 0,
        vars: String(modal.vars ?? ""), varsCursor: Number(modal.varsCursor) || 0,
        scenario: String(modal.scenario ?? ""), scenarioCursor: Number(modal.scenarioCursor) || 0,
        busy: Boolean(tests?.busy),
        hint, hintLines, hintHeight: hintLines.length + 2, idealWidth: width,
    };
}

/** The kinds of a test answer, in the order Tab goes through them (test-mode.ts parseTestResponse). */
export const WORKFLOW_TEST_ANSWER_KINDS = Object.freeze(["success", "error", "cancel"]);
/** At most this many characters of what an effect reached, or of the schema its answer must match, are shown. */
const TEST_VALUE_LIMIT = 400;

/** What an effect reached, the schema an answer must match or an answer's value, as one bounded line of text. */
function testValueText(value) {
    let text;
    if (typeof value === "string") text = value;
    else {
        try { text = JSON.stringify(value); } catch { text = String(value); }
    }
    text = String(text ?? "").replace(/\s+/g, " ").trim();
    return text.length > TEST_VALUE_LIMIT ? `${text.slice(0, TEST_VALUE_LIMIT - 1)}…` : text;
}

/** Why the shown run takes no test answer or clock advance from a person here (`what`: "answer" or "clock"), as a sentence. */
function testRunAbsentReason(projection, what) {
    const responder = projection?.testResponder ?? null;
    if (responder) {
        if (responder.reason) return responder.reason;
        if (what === "answer" && responder.respond) return "No call of this test run waits for an answer.";
        return what === "answer" ? "This workflow takes no test answers from people." : "This workflow takes no clock advances from people.";
    }
    const model = projection?.runReadModel ?? null;
    if (!isPlainRecord(model)) return "The shown run is not loaded yet.";
    if (!isPlainRecord(model.run)) return "No run is shown; ←→ chooses a test run.";
    if (model.run.mode !== "test") return "The shown run is not a test run; ←→ chooses a test run.";
    if (!isPlainRecord(model.personCommands)) return "This deployment takes no workflow commands from people.";
    return workflowV2RestrictionText(model.personCommands) ?? "This workflow takes no test answers or clock advances from people.";
}

/** Why the open workflow view does not open the answer form for the test run it shows, as a sentence; null when it does. Pure. */
export function workflowViewTestAnswerRefusal(selection) {
    const responder = selection?.projection?.testResponder ?? null;
    if (responder?.respond && responder.waiting.length) return null;
    return `No test answer can be given here. ${testRunAbsentReason(selection?.projection ?? null, "answer")}`;
}

/** Why the open workflow view does not open the virtual clock of the test run it shows, as a sentence; null when it does. Pure. */
export function workflowViewTestClockRefusal(selection) {
    const responder = selection?.projection?.testResponder ?? null;
    if (responder?.advance) return null;
    return `The virtual clock cannot be advanced here. ${testRunAbsentReason(selection?.projection ?? null, "clock")}`;
}

/** The shown test run's answers and clock in the view's details: what a and + do, or why a person cannot. */
function testRunLines(projection) {
    const responder = projection.testResponder;
    if (!responder) return [];
    const count = responder.waiting.length;
    const parts = [];
    if (responder.respond) parts.push(count > 1 ? `a answers one of its ${count} waiting calls` : count ? "a answers its waiting call" : "no call waits for an answer");
    if (responder.advance) parts.push("+ advances its virtual clock");
    const lines = [{ text: `Test run ${shortRunId(responder.runId)}${parts.length ? ` — ${parts.join(" · ")}` : ""}`, color: responder.busy ? "yellow" : "cyan",
        indent: "" }];
    if (responder.reason) lines.push({ text: responder.reason, color: "gray", indent: "  " });
    return lines;
}

/** The notices of the shown test run: a test, not a sandbox, and its agent states mocked or real (spending model tokens). */
function testRunNoticeLines(test) {
    const lines = [{ text: typeof test?.notice === "string" && test.notice ? test.notice : WORKFLOW_V2_TEST_NOTICE_TEXT, color: "yellow" }];
    lines.push(test?.agentMode === "real"
        ? { text: typeof test.agentNotice === "string" && test.agentNotice ? test.agentNotice : WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT, color: "yellow" }
        : { text: "Agent steps are mocked: the parent answers for each agent step.", color: "gray" });
    return lines;
}

/**
 * The answer form (TUI modal "workflowTestAnswer"; the portal's answer form, mock M18): bound to one test run and one
 * of its held calls (`runId`, `interceptionId`), it shows the run's notices, the effect, its actual state
 * (waiting, answered with what and by whom, or its state ended another way), what it reached, the schema the answer
 * must match and, for an agent state, its outcomes; the answer's kind (success, error or cancel) and its JSON value; an
 * answer being sent, the last answer's refusal or lost reply, why a person cannot answer, and the form's own check.
 * Null unless the form is open. Pure.
 */
export function selectWorkflowTestAnswerModal(state, maxWidth = 100, viewportHeight = null) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowTestAnswer") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const responder = projection.testResponder;
    const run = projection.runReadModel?.run ?? null;
    const test = isPlainRecord(run?.test) ? run.test : null;
    const sameRun = Boolean(responder) && responder.runId === modal.runId;
    // The run's interceptions and node executions as one list each: its newest page and the open ones the page does not hold.
    const rows = workflowV2RunRows(run);
    const items = sameRun && test ? rows.interceptions : [];
    const item = items.find(entry => entry.interceptionId === modal.interceptionId) ?? null;
    const at = sameRun ? responder.waiting.findIndex(entry => entry.interceptionId === modal.interceptionId) : -1;
    const waiting = at >= 0 ? responder.waiting[at] : null;
    const node = item ? rows.nodeExecutions.find(entry => entry?.nodeExecutionId === item.nodeExecutionId) ?? null : null;
    const kind = WORKFLOW_TEST_ANSWER_KINDS.includes(modal.kind) ? modal.kind : "success";
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const lines = [];
    const add = (text, color = "white", indent = "") => { for (const piece of wrapped(text, contentWidth, indent)) lines.push({ text: piece, color }); };
    for (const line of testRunNoticeLines(test)) add(line.text, line.color);
    if (!sameRun) add(`The workflow view no longer shows test run ${shortRunId(modal.runId)}, so this form sends nothing. Esc goes back.`, "yellow");
    else if (!item) add(`Call ${modal.interceptionId} is not one of this test run's calls, so this form sends nothing. Esc goes back.`, "yellow");
    else {
        add(`Call: ${item.operation ?? "call"}${item.tool ? ` · ${item.tool}` : ""}${item.stateId ? ` in step '${item.stateId}'` : ""}`, "cyan");
        // The terminal lists calls without their ids, so the form keeps it.
        add(`Call id: ${item.interceptionId}`);
        if (isPlainRecord(item.response)) {
            const value = item.response.value === undefined || item.response.value === null ? "" : `: ${testValueText(item.response.value)}`;
            add(`Answered: ${item.response.kind ?? "an answer"} · ${workflowV2AnswerSourceText(item.response.disposition)}${value}. Another answer is refused; the same answer again is the same answer.`);
        } else if (isPlainRecord(node) && node.state !== "pending") {
            add(`Its step already ended${typeof node.outcome === "string" && node.outcome ? ` '${node.outcome}'` : ""}; an answer is refused.`, "yellow");
        } else {
            add(`Waits for an answer${typeof item.virtualAt === "string" && item.virtualAt ? ` (reached at virtual time ${item.virtualAt})` : ""}.`, "yellow");
        }
        if (item.arguments !== null && item.arguments !== undefined) add(`What it reached: ${testValueText(item.arguments)}`);
        if (item.responseSchema !== null && item.responseSchema !== undefined) add(`The answer must match: ${testValueText(item.responseSchema)}`);
        if (waiting?.outcomes?.length) add(`Its step's outcomes: ${waiting.outcomes.join(", ")}`);
        add(`Answer: ${WORKFLOW_TEST_ANSWER_KINDS.map(entry => (entry === kind ? `[${entry}]` : entry)).join(" · ")} (Tab changes it)`, "cyan");
        if (kind === "cancel") add("The call ends as cancelled; a cancel has no value.", "gray");
        if (kind === "error") add('An error answer is { "code", "message", "details"? } with a message of 1 to 4,000 characters.', "gray");
        if (responder.waiting.length > 1 || at < 0) {
            add(`${at >= 0 ? `${at + 1} of ${responder.waiting.length}` : responder.waiting.length} call${responder.waiting.length === 1 ? "" : "s"} wait`
                + `${responder.waiting.length === 1 ? "s" : ""} for an answer${responder.waiting.length ? " · ↑↓ another" : ""}`, "gray");
        }
    }
    if (sameRun && responder.reason) add(responder.reason, "yellow");
    if (responder?.pending === "test_respond") add("Sending…", "yellow");
    else if (responder?.busy) add("Another command for this workflow is being sent.", "gray");
    const notice = projection.runNotice?.operation === "test_respond" ? projection.runNotice : null;
    if (notice) {
        add(`! ${notice.text}`, notice.level === "error" ? "red" : "yellow");
        if (notice.retry) add("Enter sends the same answer again; the server records it once.", "gray", "  ");
    }
    if (typeof modal.error === "string" && modal.error) add(modal.error, "red");
    const valueShown = sameRun && Boolean(item) && kind !== "cancel";
    const height = Number(viewportHeight ?? state?.ui?.layout?.viewportHeight) || 40;
    const listHeight = Math.max(6, Math.min(lines.length + 2, Math.max(6, height - (valueShown ? 14 : 10))));
    const hint = "Enter send · ctrl-p to the parent agent · Tab success/error/cancel · ↑↓ another waiting call · Esc back";
    const hintLines = wrapped(hint, contentWidth).map(text => ({ text, color: "gray" }));
    return {
        title: `Answer · test run ${shortRunId(modal.runId)}${item ? ` · ${item.operation ?? "call"}${item.stateId ? ` in '${item.stateId}'` : ""}` : ""}`,
        lines, listHeight, scrollOffset: 0, kind, valueShown,
        value: String(modal.value ?? ""), valueCursor: Number(modal.valueCursor) || 0,
        busy: Boolean(responder?.busy),
        hint, hintLines, hintHeight: hintLines.length + 2, idealWidth: width,
    };
}

/**
 * The virtual clock form (TUI modal "workflowTestClock"; the portal's clock, mock M19): bound to one test run
 * (`runId`), it shows the run's notices, how far its virtual clock is from the test's start, what an advance decides
 * (what came due: a wait or a receive's wait elapses, a held request or agent times out; a result that won first
 * stands; script clocks are real), the effects that wait, an advance being sent, the last advance's refusal or lost
 * reply, why a person cannot advance it, and the form's own check of the seconds. Null unless the form is open. Pure.
 */
export function selectWorkflowTestClockModal(state, maxWidth = 100, viewportHeight = null) {
    const modal = state?.ui?.modal;
    if (!modal || modal.type !== "workflowTestClock") return null;
    const projection = workflowViewProjectionFor(state, modal.sessionId);
    const responder = projection.testResponder;
    const run = projection.runReadModel?.run ?? null;
    const test = isPlainRecord(run?.test) ? run.test : null;
    const sameRun = Boolean(responder) && responder.runId === modal.runId;
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const lines = [];
    const add = (text, color = "white", indent = "") => { for (const piece of wrapped(text, contentWidth, indent)) lines.push({ text: piece, color }); };
    for (const line of testRunNoticeLines(test)) add(line.text, line.color);
    if (!sameRun) add(`The workflow view no longer shows test run ${shortRunId(modal.runId)}, so this form sends nothing. Esc goes back.`, "yellow");
    else {
        add(`Virtual clock: ${responder.elapsedSeconds === null ? "not known" : `${formatSeconds(responder.elapsedSeconds)} after the test began`}`, "cyan");
        add("An advance by whole seconds (1 to 30 days) decides what came due: a wait or a receive's wait elapses, a held request or agent "
            + "times out; a result that won first stands. Script clocks are real.", "gray");
        const count = responder.waiting.length;
        if (count) add(`${count} call${count === 1 ? " waits" : "s wait"} for an answer.`);
        if (responder.reason) add(responder.reason, "yellow");
    }
    if (responder?.pending === "test_advance") add("Advancing…", "yellow");
    else if (responder?.busy) add("Another command for this workflow is being sent.", "gray");
    const notice = projection.runNotice?.operation === "test_advance" ? projection.runNotice : null;
    if (notice) {
        add(`! ${notice.text}`, notice.level === "error" ? "red" : "yellow");
        if (notice.retry) add("Enter sends the same advance again; the server applies it once.", "gray", "  ");
    }
    if (typeof modal.error === "string" && modal.error) add(modal.error, "red");
    const height = Number(viewportHeight ?? state?.ui?.layout?.viewportHeight) || 40;
    const listHeight = Math.max(6, Math.min(lines.length + 2, Math.max(6, height - 12)));
    const hint = "Enter advance · Esc back";
    const hintLines = wrapped(hint, contentWidth).map(text => ({ text, color: "gray" }));
    return {
        title: `Virtual clock · test run ${shortRunId(modal.runId)}`,
        lines, listHeight, scrollOffset: 0, fieldShown: sameRun,
        seconds: String(modal.seconds ?? ""), secondsCursor: Number(modal.secondsCursor) || 0,
        busy: Boolean(responder?.busy),
        hint, hintLines, hintHeight: hintLines.length + 2, idealWidth: width,
    };
}

/** `text` in lines of at most `limit` characters, broken at spaces; each starts with `indent`, a continuation with two more. */
function wrapped(text, limit, indent = "") {
    const out = [];
    let rest = String(text ?? "").replace(/\s+/g, " ").trim();
    for (let first = true; rest.length; first = false) {
        const prefix = first ? indent : `${indent}  `;
        const room = Math.max(10, limit - prefix.length);
        if (rest.length <= room) { out.push(prefix + rest); break; }
        let cut = rest.lastIndexOf(" ", room);
        if (cut <= 0) cut = room;
        out.push(prefix + rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
    }
    return out;
}

function nodeRow(entry, selected, idWidth, labelWidth, width) {
    const marker = selected ? "▶ " : "  ";
    const id = bounded(entry.id, idWidth).padEnd(idWidth);
    const label = bounded(entry.label, labelWidth).padEnd(labelWidth);
    const runs = entry.runs ? ` ×${entry.runs}${entry.partial ? " loaded" : ""}` : "";
    const used = marker.length + 2 + idWidth + 1 + labelWidth + 1 + runs.length;
    const stateLabel = bounded(entry.stateLabel, Math.max(8, width - used));
    return [
        { text: marker, color: selected ? "cyan" : "gray", bold: selected },
        { text: `${STATE_GLYPHS[entry.state]} `, color: STATE_COLORS[entry.state] },
        { text: `${id} `, color: "white", bold: selected },
        { text: `${label} `, color: "gray" },
        { text: stateLabel, color: STATE_COLORS[entry.state] === "gray" ? "white" : STATE_COLORS[entry.state] },
        { text: runs, color: "gray" },
    ];
}

const JOIN_COLORS = { waiting: "yellow", joined: "green", done: "green", blocked: "red", failed: "red", timed_out: "red", cancelled: "gray", idle: "gray" };

/**
 * A parallel step's join line in the list (owner batch 7, H2): after its branch steps, where every branch meets, with
 * its rule and its state. It is not a state: ↑↓ pass over it.
 */
function joinRow(join, width) {
    const text = `  ⋯ ${join.label}${join.stateText ? ` · ${join.stateText}` : ""}${join.limit ? ` · ${join.limit.text}` : ""}`;
    return [{ text: bounded(text, Math.max(20, width)), color: JOIN_COLORS[join.state] ?? "gray" }];
}

/**
 * The list's rows: one per state, in the order workflowViewNodes gives, and after the branch steps of each parallel
 * step its join line (H2). The join line is not a state: `rowOf` maps a state's index to its row, so the selection and
 * ↑↓ skip it.
 */
function listRows(nodes, selectedIndex, idWidth, labelWidth, width) {
    const lastMember = new Map();
    nodes.forEach((entry, index) => { if (typeof entry.node?.parallel === "string") lastMember.set(entry.node.parallel, index); });
    const joinAfter = new Map();
    for (const entry of nodes) {
        const at = lastMember.get(entry.id);
        if (entry.node?.joinBar && at !== undefined) joinAfter.set(at, entry.node.joinBar);
    }
    const rows = [];
    const rowOf = [];
    nodes.forEach((entry, index) => {
        rowOf.push(rows.length);
        rows.push(nodeRow(entry, index === selectedIndex, idWidth, labelWidth, width));
        if (joinAfter.has(index)) rows.push(joinRow(joinAfter.get(index), width));
    });
    return { rows, rowOf };
}

/** The portal's history wording (its Result column). */
const resultWord = execution => execution.status === "pending" ? "Pending"
    : execution.resultKind === "business" ? "Outcome"
        : execution.resultKind === "runtime_error" ? "Runtime error" : "How it ended was not recorded";

const durationText = ms => typeof ms === "number" && Number.isFinite(ms)
    ? (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`) : "not recorded";

/** The most characters of a whole value the TUI's details show (the portal's Output tab shows it all). */
const WHOLE_VALUE_CHAR_LIMIT = 40_000;
const withThousands = value => Number(value).toLocaleString("en-US");

/**
 * The whole value of the visit shown, as f read it (workflowV2WholeValue): being read, its failure, that it had no value,
 * or the value itself line by line with its indentation, up to WHOLE_VALUE_CHAR_LIMIT characters (the rest is counted).
 * Entries { text, color, indent }; none until f reads it.
 */
function wholeValueLines(entry) {
    const whole = workflowV2WholeValue(entry);
    if (!whole) return [];
    if (whole.kind === "loading") return [{ text: "Reading its whole value…", color: "yellow", indent: "  " }];
    if (whole.kind === "failed") return [{ text: `Its whole value could not be read: ${whole.error} (f reads it again)`, color: "red", indent: "  " }];
    if (whole.kind === "none") return [{ text: "It had no value when it was read: it had not ended (f reads it again).", color: "gray", indent: "  " }];
    const what = whole.label === "Runtime error" ? "runtime error" : "output";
    const size = whole.bytes === null ? "" : ` (${withThousands(whole.bytes)} bytes)`;
    const lines = [whole.kind === "preview"
        ? { text: `Its stored ${what}${size} is more than a read returns${whole.limitBytes === null ? "" : ` (${withThousands(whole.limitBytes)} bytes)`}; only its start is shown:`,
            color: "yellow", indent: "  " }
        : { text: `Whole ${what}${size}:`, color: "cyan", indent: "  " }];
    const shown = whole.text.length > WHOLE_VALUE_CHAR_LIMIT ? whole.text.slice(0, WHOLE_VALUE_CHAR_LIMIT) : whole.text;
    for (const line of shown.split("\n")) {
        const lead = line.length - line.trimStart().length;
        if (line.trim()) lines.push({ text: line.trim(), color: "white", indent: `    ${" ".repeat(Math.min(lead, 24))}` });
    }
    if (whole.text.length > WHOLE_VALUE_CHAR_LIMIT) {
        lines.push({ text: `… ${withThousands(whole.text.length - WHOLE_VALUE_CHAR_LIMIT)} more characters are not shown here; the portal's Output tab shows the whole value.`,
            color: "gray", indent: "  " });
    }
    return lines;
}

/**
 * The selected state's result in the view's details, of exactly one visit (R01 history; design 02 node occurrences): the visit chosen
 * with [ ] for exactly the shown run and this state, else its latest result, as before. It is that visit's own output or
 * runtime error as read (wrapped, not cut), or that it has not ended or recorded no output; a chosen visit that is no
 * longer loaded says so and shows nothing in its place; and the read's cut is named. f reads that visit's whole value
 * (mock M10), shown below it for exactly that run and visit. Entries { text, color, indent }.
 */
function executionResultLines(node, projection) {
    const executions = Array.isArray(node.executions) ? node.executions : [];
    const runId = projection.v2?.runId ?? null;
    const shown = workflowV2ShownExecution(node, runId, projection.selectedExecution);
    if (!shown.chosen && !shown.execution) return [];
    const keys = executions.length > 1 ? "; [ older · ] newer" : "";
    if (shown.missing) {
        return [{ text: `Result of the chosen visit (${shown.executionId}): not in the loaded history of this run${keys}`, color: "cyan", indent: "" },
            { text: "Its result is not shown, and no other visit's result is shown in its place.", color: "yellow", indent: "  " }];
    }
    const execution = shown.execution;
    // Re-check RC-7: a branch step's visit names its branch and, with more than one, its parallel visit; [ ] go through the
    // visits of every branch.
    const visit = `${Number.isSafeInteger(execution.ordinal) ? `visit ${execution.ordinal}` : "a visit"}${visitPlace(node, execution)}`;
    const lines = [{ text: `Result of ${visit} (${shown.chosen ? "chosen" : "latest"}${keys}${keys && node.where ? ", all branches" : ""})`, color: "cyan", indent: "" }];
    const result = workflowV2ExecutionResult(execution);
    const shownText = value => (typeof value === "string" ? value : valueText(value)).replace(/\s+/g, " ").trim();
    if (result.kind === "pending") lines.push({ text: "Not ended yet: it has no result.", color: "yellow", indent: "  " });
    else if (result.kind === "error") {
        const detail = [result.code, result.effectStatus ? `effect ${result.effectStatus}` : null].filter(Boolean).join(" · ");
        lines.push({ text: `Runtime error${detail ? ` · ${detail}` : ""}: ${result.value === null ? "no error text was recorded" : shownText(result.value)}`,
            color: "red", indent: "  " });
    } else if (result.kind === "output") lines.push({ text: `Output: ${shownText(result.value)}`, color: "white", indent: "  " });
    else lines.push({ text: "It recorded no output.", color: "gray", indent: "  " });
    const whole = typeof execution.id === "string" ? workflowV2ExecutionValue(projection.executionValues, runId, execution.id) : null;
    if (result.truncated && !whole) lines.push({ text: "The read keeps only the start of this value; f reads the whole value.", color: "gray", indent: "  " });
    return [...lines, ...wholeValueLines(whole), ...kvLines(execution, projection)];
}

/** At most this many variables of a comparison are listed in the TUI's details (the rest are counted). */
const KV_COMPARE_ROWS = 12;
const SUBTREE_ROWS = 8;
const EVIDENCE_ROWS = 12;
const ACTIVITY_ROWS = 6;

/**
 * The variables of the visit shown (mock M15 "Accepted 9 / applied 8", "Inspect update", "Compare snapshots"): the
 * revision it applied and the run's accepted one now, and, after i, the two compared key by key for exactly that run:
 * + added, - removed, ~ changed (values as read: whole up to 256 KiB in all, else previews), unchanged ones counted.
 */
function kvLines(execution, projection) {
    const run = projection.v2?.readModel?.run ?? null;
    const runId = projection.v2?.runId ?? null;
    const kv = workflowV2KvApplied(execution, run);
    if (!kv) return [];
    const lines = [{ text: `Variables applied: revision ${kv.applied}${kv.accepted === null ? "" : kv.same ? " (the accepted revision)" : ` · accepted now: revision ${kv.accepted}`} — i compares them`,
        color: "cyan", indent: "" }];
    const asked = projection.kvCompare;
    if (!asked || asked.runId !== runId || asked.from !== kv.applied || asked.to !== kv.accepted) return lines;
    const before = workflowV2KvSnapshot(projection.kvRevisions, runId, kv.applied);
    const after = workflowV2KvSnapshot(projection.kvRevisions, runId, kv.accepted);
    const failed = [before, after].find(entry => entry?.phase === "failed");
    if (failed) return [...lines, { text: `The variables of revision ${failed.revision} could not be read: ${failed.error} (i reads them again)`, color: "red", indent: "  " }];
    if (before?.phase !== "loaded" || after?.phase !== "loaded") return [...lines, { text: "Reading the variables…", color: "yellow", indent: "  " }];
    const compared = workflowV2KvCompare(before, after);
    if (!compared) return lines;
    const { added, removed, changed, same } = compared.counts;
    lines.push({ text: `Revision ${compared.from} → ${compared.to}: ${added} added, ${removed} removed, ${changed} changed, ${same} unchanged`
        + `${compared.whole ? "" : " (values over 256 KiB in all are shown by their start)"}`, color: "white", indent: "  " });
    const differing = compared.rows.filter(row => row.change !== "same");
    for (const row of differing.slice(0, KV_COMPARE_ROWS)) {
        const text = row.change === "added" ? `+ ${row.key}: ${row.after}` : row.change === "removed" ? `- ${row.key}: ${row.before}`
            : `~ ${row.key}: ${row.before} → ${row.after}`;
        lines.push({ text: bounded(text, VALUE_LIMIT), color: row.change === "removed" ? "red" : row.change === "added" ? "green" : "yellow", indent: "    " });
    }
    if (differing.length > KV_COMPARE_ROWS) lines.push({ text: `… ${differing.length - KV_COMPARE_ROWS} more changed variables (the portal lists them all)`, color: "gray", indent: "    " });
    return lines;
}

/**
 * The TUI's workflow view: which visit of the selected state the details show after [ (`delta` 1, an older visit) or ]
 * (-1, a newer one; past the newest chosen visit, the latest result again), among that state's loaded executions of
 * exactly the shown run: { ok, selection, status }, `selection` the view's next selectedExecution ({ runId, stateId,
 * executionId }, null for the latest) and `status` the status line. Nothing is read or sent. Pure.
 */
export function workflowViewExecutionStep(selection, delta) {
    const node = selection?.selected?.node ?? null;
    if (!node || node.shape !== "v2") return { ok: false, selection: null, status: "This step's visits have no results of their own here" };
    const executions = Array.isArray(node.executions) ? node.executions : [];
    if (!executions.length) return { ok: false, selection: null, status: "No visit of this step is in the loaded history of this run" };
    const runId = selection.projection.v2?.runId ?? null;
    const shown = workflowV2ShownExecution(node, runId, selection.projection.selectedExecution);
    const target = shown.index + (delta > 0 ? 1 : -1);
    if (delta < 0 && target < 0) {
        return shown.chosen ? { ok: true, selection: null, status: "Showing the latest result again" } : { ok: false, selection: null, status: "There is no newer visit" };
    }
    if (target >= executions.length) return { ok: false, selection: null, status: "No older visit in the loaded history of this run" };
    const execution = executions[target];
    if (typeof execution?.id !== "string" || !execution.id) return { ok: false, selection: null, status: "That visit has no identity in the loaded history" };
    // Re-check RC-6: a branch step's choice keeps the parallel visit current now; a new one ends it. RC-7: the status names
    // the visit's branch and parallel visit.
    const bound = node.branches || node.where ? { parallelExecutionId: node.branches?.parallelExecutionId ?? null } : {};
    return { ok: true, selection: { runId, stateId: node.id, executionId: execution.id, ...bound },
        status: `Showing the result of visit ${Number.isSafeInteger(execution.ordinal) ? execution.ordinal : "—"}${visitPlace(node, execution)}` };
}

/** Re-check RC-7: " in branch 2 · parallel visit 1" for a branch step's visit (its place, workflowV2VisitPlaces), else "". */
function visitPlace(node, execution) {
    const place = typeof execution?.id === "string" ? node?.where?.[execution.id] : null;
    return place && typeof place.label === "string" ? ` in ${place.label}` : "";
}

/**
 * The selected state's executions in the loaded history, newest first, as the portal's History tab lists them: a v2
 * state's visits with neighbouring unchanged repeats combined (compactWorkflowV2Executions), a legacy state's steps.
 */
function historyLines(node) {
    if (node.shape === "v2") {
        const rows = compactWorkflowV2Executions(Array.isArray(node.executions) ? node.executions : []);
        // A branch step's visit says its branch and, with more than one, its parallel visit (adversarial review R2-UI-5).
        const where = execution => (execution?.id && node.where?.[execution.id] ? `${node.where[execution.id].label} · ` : "");
        const lines = rows.slice(0, HISTORY_ROW_LIMIT).map(({ execution, count, from, to }) =>
            `  ${where(execution)}${count > 1 ? `visits ${from}–${to} (×${count})` : `visit ${execution.ordinal ?? "—"}`} · ${resultWord(execution)} · ${execution.outcome || "—"}`);
        if (rows.length > HISTORY_ROW_LIMIT) lines.push(`  … ${rows.length - HISTORY_ROW_LIMIT} more rows in the loaded history`);
        return { title: "History (newest first; unchanged repeats combined):", lines };
    }
    const history = Array.isArray(node.history) ? node.history : [];
    const lines = history.slice(0, HISTORY_ROW_LIMIT).map(event => {
        const data = event?.data && typeof event.data === "object" ? event.data : {};
        return `  step ${data.step ?? data.steps ?? "—"} · ${data.outcome || String(event?.eventType || "").split(".").at(-1)} · ${durationText(data.durationMs)}`;
    });
    if (history.length > HISTORY_ROW_LIMIT) lines.push(`  … ${history.length - HISTORY_ROW_LIMIT} more in the loaded history`);
    return { title: "History (newest first):", lines };
}

/**
 * A test run's held calls (design 05), as the portal's table lists them: the effect, its state and its answer,
 * from the shown run's own read model only. The TUI shows them; the run's parent agent, a fixture or a person in the
 * portal answers them. Null when the shown run has none.
 */
function testEffectLines(projection, selectedId) {
    const test = projection.v2?.readModel?.run?.test;
    const items = Array.isArray(test?.interceptions) ? test.interceptions.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
    if (!items.length) return null;
    const waiting = items.filter(item => !item.response).length;
    const lines = items.slice(0, EFFECT_LIMIT).map(item => {
        const effect = `${item.operation ?? "effect"}${item.tool ? ` · ${item.tool}` : ""}`;
        const answered = Boolean(item.response && typeof item.response === "object");
        const answer = answered ? `${item.response.kind ?? "answered"} · ${workflowV2AnswerSourceText(item.response.disposition, "—")}` : "waiting for the parent";
        return { text: `  ${effect} · step ${item.stateId ?? "—"} · ${answer}${item.stateId && item.stateId === selectedId ? " ◂ this step" : ""}`,
            color: answered ? "white" : "yellow" };
    });
    if (items.length > EFFECT_LIMIT) lines.push({ text: `  … ${items.length - EFFECT_LIMIT} more`, color: "gray" });
    return {
        title: `Calls of this test run (${items.length}${waiting ? `; ${waiting} wait${waiting === 1 ? "s" : ""} for the parent` : ""}):`,
        lines,
        note: projection.testResponder?.respond
            ? "a answers one that waits; the parent agent or a prepared answer may answer first, and the first answer stands."
            : "The TUI shows them; the run's parent agent, a prepared answer or a person in the portal answers them.",
    };
}

function detailLines(selection, width) {
    const { projection, selected, occurrences, occurrenceIndex } = selection;
    const lines = [];
    const add = (text, color = "white", extra = {}) => lines.push({ text: clip(text, Math.max(20, width)), color, ...extra });
    const picker = projection.runPicker;
    if (picker) {
        const index = Math.max(0, picker.options.findIndex(option => option.value === picker.value));
        const option = picker.options[index];
        add(`Run: ${option?.label ?? "Live run"}${picker.options.length > 1 ? ` (${index + 1} of ${picker.options.length} · ←→ choose)` : ""}`, "cyan");
        for (const note of picker.notes) add(`  ${note.text}`, note.level === "error" ? "red" : note.level === "warning" ? "yellow" : "gray");
    }
    // The run controls, their notice and the variables are wrapped, not cut (a reason or a refusal is read whole); a
    // variable's value is cut to one line.
    for (const line of [...runControlLines(projection), ...runVariableLines(projection), ...draftLines(projection), ...publicationLines(projection),
        ...testLines(projection), ...testRunLines(projection)]) {
        if (line.clip) add(`${line.indent}${line.text}`, line.color);
        else for (const text of wrapped(line.text, Math.max(20, width), line.indent)) add(text, line.color);
    }
    for (const banner of projection.banners) add(`! ${banner.text}`, banner.level === "error" ? "red" : "yellow");
    // Why the shown run ended (owner decision q14), wrapped: it is read whole.
    if (projection.v2?.ending) for (const text of wrapped(projection.v2.ending.text, Math.max(20, width))) add(text, "yellow");
    if (projection.readError) add(`The workflow's current status could not be read: ${projection.readError}`, "red");
    if (!selected) {
        if (projection.noGraph) add("This workflow has no graph to show: its definition is not valid or not available.", "yellow");
        else if (projection.error) add(projection.error, "red");
        else add(projection.loading || !projection.definition ? "Loading workflow graph…" : "This workflow has no steps.", "gray");
        return lines;
    }
    const node = selected.node;
    add(`${selected.id} · ${selected.label}${selected.initial ? " · first step" : ""}`, "cyan", { bold: true });
    add(`Status: ${selected.stateLabel}`);
    add(`Visits: ${selected.runs}${selected.partial ? " in loaded history" : ""}`);
    if (node.shape === "v2") {
        add(`Last outcome: ${node.outcome ? `${node.outcome}${node.resultKind === "runtime_error" ? " · runtime error" : ""}` : "Not recorded"}`);
        // Why the visit the details show ended (owner decision q14; mock M14 "Inspect cancellation").
        const ending = workflowV2VisitEnding(workflowV2ShownExecution(node, projection.v2?.runId ?? null, projection.selectedExecution).execution);
        if (ending) for (const text of wrapped(`Why it ended: ${ending.text}`, Math.max(20, width))) add(text);
        // An agent state's task, the workflow interface it names and what the shown run pins it to, as the portal says them.
        if (node.kind === "agent") {
            add(`Agent: ${workflowV2AgentTask(node)}`);
            for (const [label, value] of workflowV2AgentBindingRows(node.binding)) add(`${label}: ${value}`);
        }
        for (const line of node.description || []) add(line, "gray");
        // Each branch's result for a parallel step (owner decision q16; mocks M22 to M24).
        if (node.evidence) {
            const evidence = node.evidence;
            add(`Branch results: ${evidence.succeeded} of ${evidence.total} succeeded${evidence.running ? `, ${evidence.running} running` : ""}`, "cyan");
            if (evidence.blocked && evidence.blocking.length) {
                add(`  The join is blocked by ${workflowV2BranchList(evidence.blocking)}.`, "yellow");
            }
            // Owner decision join-k-of-n (J1b): whether the time limit ended it, or passed after enough branches succeeded.
            if (evidence.timedOut) add("  The time limit passed before the join.", "yellow");
            if (evidence.joinedAfterLimit) add("  The time limit passed after enough branches succeeded; the join still used them.", "gray");
            for (const row of evidence.rows.slice(0, EVIDENCE_ROWS)) {
                add(`  branch ${workflowV2BranchNumber(row.index)} · ${row.status}${row.step ? ` · at '${row.step}'` : ""}${row.why ? ` · ${row.why}` : row.result ? ` · ${row.result}` : ""}`,
                    row.status === "failed" || row.status.startsWith("cancelled") ? "yellow" : "gray");
            }
            if (evidence.rows.length > EVIDENCE_ROWS) add(`  … ${evidence.rows.length - EVIDENCE_ROWS} more branches (the portal lists them all)`, "gray");
        }
        // A parallel step's join (owner batch 7, H2), as the portal's join bar says it, the rule in words and its own time
        // limit (owner decision join-k-of-n).
        if (node.joinBar) {
            add(`Join: ${node.joinBar.rule}${node.joinBar.stateText ? ` · ${node.joinBar.stateText}` : ""}`, "cyan");
            for (const text of wrapped(workflowV2JoinWords(node), Math.max(20, width), "  ")) add(text, "gray");
            if (node.joinBar.limit) for (const text of wrapped(node.joinBar.limit.title, Math.max(20, width), "  ")) add(text, "gray");
        }
    } else if (node.outcome) {
        add(`Last outcome: ${node.outcome}`);
    }
    if (selected.transitions.length) {
        add("Next steps:", "cyan");
        for (const route of selected.transitions) {
            const notes = [route.kind === "error" ? "runtime error route" : null, route.kind === "branch" ? "where each branch starts" : null,
                route.loop ? "↺ in a loop" : null].filter(Boolean);
            add(`  ${route.label} → ${route.target}${notes.length ? ` · ${notes.join(" · ")}` : ""}`);
        }
    } else if (node.type === "terminal") {
        add(typeof node.parallel === "string" ? "The branch ends at this step." : "The workflow ends at this step.", "gray");
    }
    if (occurrences.length) {
        add("Agent chats (Tab: choose · Enter: open):", "cyan");
        occurrences.forEach((occurrence, index) => {
            const chosen = index === occurrenceIndex;
            const visit = occurrence.ordinal === null ? "visit —" : `visit ${occurrence.ordinal}`;
            const result = occurrence.status === "pending" ? "working" : occurrence.outcome ? `${occurrence.status} · ${occurrence.outcome}` : occurrence.status || "—";
            add(`${chosen ? "▸" : " "} ${visit} · ${result} · ${occurrence.childSessionId}`, chosen ? "white" : "gray", chosen ? { bold: true } : {});
        });
        add("People can read these chats; the server refuses their prompts, answers and instructions.", "gray");
        // The sessions the chosen chat started (owner decision q14; mock M14 "View owned subtree"), as loaded here.
        const under = selection.occurrence?.childSessionId
            ? workflowV2SessionSubtree(selection.sessionsById, selection.occurrence.childSessionId).filter(entry => entry.depth > 0) : [];
        if (under.length) {
            add(`Sessions under this chat (${under.length}):`, "cyan");
            for (const entry of under.slice(0, SUBTREE_ROWS)) add(`${"  ".repeat(entry.depth)}${entry.title ?? entry.sessionId} · ${entry.status}`, "gray");
            if (under.length > SUBTREE_ROWS) add(`  … ${under.length - SUBTREE_ROWS} more (the portal lists them all)`, "gray");
        }
    } else if (node.shape === "v2" && node.kind === "agent") {
        add("No child session is listed for it yet.", "gray");
    }
    const result = node.result;
    if (node.shape === "v2") {
        // One visit's own result: the visit chosen with [ ] for exactly this run and state, else the latest.
        for (const line of executionResultLines(node, projection)) {
            for (const text of wrapped(line.text, Math.max(20, width), line.indent)) add(text, line.color);
        }
    } else if (result) {
        const text = result.error || result.reason || result.outputPreview || result.summary;
        if (text) add(`Output: ${bounded(valueText(text), VALUE_LIMIT)}`);
    }
    if (node.type === "terminal" && projection.v2?.status?.terminalState === selected.id) {
        const runValue = projection.v2.error ?? projection.v2.output;
        if (runValue !== null && runValue !== undefined) add(`Run ${projection.v2.error != null ? "error" : "output"}: ${bounded(valueText(runValue), VALUE_LIMIT)}`);
    }
    const history = historyLines(node);
    add(history.title, "cyan");
    if (history.lines.length) for (const line of history.lines) add(line);
    else add("  No visits in the loaded history.", "gray");
    // Who did what in the visit the details show, from the workflow's events (owner decision q14; mock M09 "Inspect audit").
    const shownVisit = node.shape === "v2" ? workflowV2ShownExecution(node, projection.v2?.runId ?? null, projection.selectedExecution).execution : null;
    const activity = shownVisit?.id && projection.v2?.bound
        ? workflowV2Activity(projection.events, { runId: projection.v2.runId, nodeExecutionId: shownVisit.id, limit: ACTIVITY_ROWS }) : [];
    if (activity.length) {
        add("Activity of this visit (newest first):", "cyan");
        for (const row of activity) {
            add(`  ${row.at ? `${row.at} · ` : ""}${row.what}${row.who ? ` · by ${row.who}` : ""}`, row.level === "error" ? "red" : row.level === "warning" ? "yellow" : "white");
        }
    }
    // The shown run's older history: o reads its next, older page (the read model holds its newest rows and open ones).
    const runHistory = node.shape === "v2" ? projection.v2?.readModel?.run?.history ?? null : null;
    if (runHistory?.loading) add("  Reading older history…", "yellow");
    else if (runHistory?.more) add("  Older history of this run is not loaded: o reads its next, older page.", "gray");
    const effects = testEffectLines(projection, selected.id);
    if (effects) {
        add(effects.title, "cyan");
        for (const line of effects.lines) add(line.text, line.color);
        // The note is read whole: it wraps, as the other notes do, instead of being cut at the panel's width.
        for (const text of wrapped(effects.note, Math.max(20, width))) add(text, "gray");
    }
    return lines;
}

/** The workflow view's panel width in a terminal `viewportWidth` columns wide. Pure. */
export function workflowViewPanelWidth(viewportWidth) {
    return Math.max(56, Math.min(110, (Number(viewportWidth) || 120) - 8));
}

/** The heights of the workflow view's two panels in a terminal `viewportHeight` rows high, for `rowCount` state rows. Pure. */
function panelHeights(viewportHeight, rowCount) {
    const available = Math.max(16, (Number(viewportHeight) || 40) - 6);
    const listHeight = Math.max(6, Math.min(Math.max(1, rowCount) + 2, Math.floor(available / 2)));
    return { listHeight, detailsHeight: Math.max(8, available - listHeight - 1) };
}

/**
 * The workflow view's presentation (TUI modal): the title (workflow name and status), one row per state in graph order
 * with the selected row, and the selected state's detail lines. Null unless the workflow view is open. Pure.
 */
export function selectWorkflowViewModal(state, maxWidth = 100, viewportHeight = null) {
    const selection = selectWorkflowViewSelection(state);
    if (!selection) return null;
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const idWidth = Math.min(20, Math.max(4, ...selection.nodes.map(entry => entry.id.length)));
    const labelWidth = Math.min(24, Math.max(6, ...selection.nodes.map(entry => entry.label.length)));
    const { rows: nodeRows, rowOf } = listRows(selection.nodes, selection.selectedIndex, idWidth, labelWidth, contentWidth);
    const rows = nodeRows.length ? nodeRows : [[{ text: selection.projection.loading ? "Loading workflow graph…" : "No steps to show.", color: "gray" }]];
    const detailsLines = detailLines(selection, contentWidth);
    // The details scroll (PgUp/PgDn) within what its panel can show: never past its last line.
    const { listHeight, detailsHeight } = panelHeights(viewportHeight ?? state?.ui?.layout?.viewportHeight ?? 40, rows.length);
    const detailsMaxScroll = Math.max(0, detailsLines.length - Math.max(1, detailsHeight - 2));
    return {
        title: bounded(`Workflow: ${selection.projection.name} · ${selection.projection.status}`, contentWidth),
        rows,
        selectedRowIndex: rowOf[selection.selectedIndex] ?? 0,
        detailsTitle: selection.selected
            ? `Step ${bounded(selection.selected.id, 30)} — ↑↓ step · ←→ run · Tab agent chat · Enter open · Esc close` : "Workflow",
        detailsLines,
        listHeight,
        detailsHeight,
        detailsScroll: Math.max(0, Math.min(Number(selection.modal.detailsScroll) || 0, detailsMaxScroll)),
        detailsMaxScroll,
        idealWidth: width,
        childSessionId: selection.occurrence?.childSessionId ?? null,
    };
}

/**
 * The note a read-only composer shows when the session's input policy (normalizeWorkflowInputPolicy) refuses prompts
 * and the server sent no reason. The portal and the terminal show the same words.
 */
export const WORKFLOW_INPUT_DENIED_TEXT = "This session runs a step of a workflow. People cannot send it prompts, answers or instructions. Message the parent agent instead.";

/**
 * The read-only composer's note, in the portal and the terminal alike: the server's reason (else
 * WORKFLOW_INPUT_DENIED_TEXT) and the controlling agent's session, by its short id. Pure.
 */
export function workflowInputNoteText(reason, controllingSessionId) {
    const note = typeof reason === "string" && reason ? reason : WORKFLOW_INPUT_DENIED_TEXT;
    return typeof controllingSessionId === "string" && controllingSessionId
        ? `${note} Its controlling agent is session ${shortSessionId(controllingSessionId)}.` : note;
}

/**
 * What a person may send to a session, as the server reports it: getWorkflowInputPolicy's answer (the TUI's direct
 * transport), or the session access the Web API reports (canSendPrompt, canAnswer, canSteer and workflowInput, present
 * only when refused). Anything else is null (unknown: the composer stays, and the server refuses what it must). Pure.
 */
export function normalizeWorkflowInputPolicy(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const detail = value.workflowInput && typeof value.workflowInput === "object" ? value.workflowInput : value;
    const text = field => typeof field === "string" && field ? field : null;
    return {
        canSendPrompt: value.canSendPrompt !== false,
        canAnswer: value.canAnswer !== false,
        canSteer: value.canSteer !== false,
        reason: text(detail.reason),
        workflowSessionId: text(detail.workflowSessionId),
        controllingSessionId: text(detail.controllingSessionId),
    };
}

/**
 * Whether a session may be in a workflow agent state's subtree, from the loaded session rows, so that the server is
 * asked only then: an agent state's child is created under its workflow session, so a session none of whose loaded
 * ancestors is a workflow session, up to a root, cannot be in one. A session with an ancestor that is not loaded, or a
 * cycle, is asked about. A root session, a group and a workflow session itself are not (a workflow session's composer
 * is read-only anyway). Pure.
 */
export function workflowInputPolicyApplies(state, sessionId) {
    const byId = state?.sessions?.byId || {};
    const session = sessionId ? byId[sessionId] : null;
    if (!session || session.isGroup || session.sessionKind === "workflow" || !session.parentSessionId) return false;
    const seen = new Set([sessionId]);
    let parentId = session.parentSessionId;
    for (let hops = 0; parentId && hops < 32; hops++) {
        if (seen.has(parentId)) return true;
        seen.add(parentId);
        const parent = byId[parentId];
        if (!parent) return true;
        if (parent.sessionKind === "workflow") return true;
        parentId = parent.parentSessionId || null;
    }
    return Boolean(parentId);
}

/** The read-only composer's note for a session whose recorded input policy refuses prompts, or null. Pure. */
export function selectWorkflowInputNote(state, sessionId) {
    const policy = sessionId ? state?.ui?.workflowInputPolicies?.[sessionId] : null;
    if (!policy || policy.canSendPrompt !== false) return null;
    return workflowInputNoteText(policy.reason, policy.controllingSessionId);
}

/**
 * What a composer shows instead of the message box while the server is asked whether a person may send input to a
 * session that may be in a workflow agent state's subtree (owner decision q18).
 */
export const WORKFLOW_INPUT_CHECKING_TEXT = "Checking whether you can send messages here…";
/** What it shows when that check failed: still no message box until the server answers (owner decision q18). */
export const WORKFLOW_INPUT_CHECK_FAILED_TEXT = "Could not check whether you can send messages here.";

/**
 * The check of a session's input policy (ensureWorkflowInputPolicy): "checking" while it is asked, "failed" when the
 * read failed or its answer was unreadable, else null (never asked, or the policy is recorded). Pure.
 */
export function selectWorkflowInputCheck(state, sessionId) {
    if (!sessionId || state?.ui?.workflowInputPolicies?.[sessionId]) return null;
    const phase = state?.ui?.workflowInputChecks?.[sessionId];
    return phase === "checking" || phase === "failed" ? phase : null;
}
