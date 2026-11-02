import { layoutWorkflowGraph, workflowNodeViews, workflowReadModelView } from "./workflow-view.js";
import { workflowV2RunPickerModel } from "./workflow-v2-run-picker.js";
import {
    compactWorkflowV2Executions, projectWorkflowV2, workflowV2AgentBindingRows, workflowV2AgentTask, workflowV2RouteKind,
} from "./workflow-v2-view.js";
import {
    workflowV2DraftEdit, workflowV2DraftEditor, workflowV2RestrictionText, workflowV2RunCommandNotice, workflowV2RunControls,
    workflowV2RunVariables,
} from "./workflow-v2-commands.js";

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
 * update at the revision the view shows; the portal's workflowV2RunVariables
 * and drafts), and a draft's YAML (e opens an editor: ctrl-o saves it as a
 * new revision after the one the edit started from, replace_definition, the
 * portal's workflowV2DraftEditor and workflowV2DraftEdit; a draft someone
 * else saved meanwhile is refused, never overwritten, and the edit is kept).
 * A workflow in an agent state's subtree takes only pause, stop and cancel
 * from people. The server decides every command again. Publication, tests
 * and their answers are not part of it, and the server keeps refusing human
 * input to an agent state's subtree.
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
        const projected = projectWorkflowV2({ definition: safeView.definition, readModel, workflowModel, selectedRunId, events: list, readModelAfterSeq });
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
    return {
        definition, nodes, v2, status, live, runPicker, runControls, runNotice, runVariables, runReadModel: v2 ? readModel ?? null : null,
        draftEditor, draftBuffer, draftEdit, definitionModel: v2 ? readModel ?? workflowModel ?? null : null,
        name: definition?.name || String(session?.title || "").replace(/^Workflow: /, "") || "Workflow",
        banners: v2?.banners || [],
        readError: error,
        loading: Boolean(safeView.loading) && !definition,
        error: typeof safeView.error === "string" && safeView.error ? safeView.error : null,
        noGraph: Boolean(v2 && !v2.definition),
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
 * The view's states in graph order, each with what the TUI shows: its line label, state label, transitions and
 * agent occurrences. Pure.
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
    return nodes;
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
    return { modal, projection, nodes, selectedIndex, selected, occurrences, occurrenceIndex, occurrence: occurrences[occurrenceIndex] || null };
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
        + (variables.editable ? " — v sets or removes one" : ""), color: "cyan", indent: "" }];
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
            : !isPlainRecord(model.personCommands) ? "This deployment takes no workflow commands from people." : "The shown run's state is not known.";
        return { ok: false, reason: `The variables cannot be changed here. ${why}` };
    }
    if (!variables.editable) return { ok: false, reason: `The variables cannot be changed here. ${variables.reason}` };
    if (variables.busy) return { ok: false, reason: "The variables cannot be changed now. Another command for this workflow is being sent." };
    return { ok: true, runId: variables.runId };
}

const shortRunId = id => (typeof id === "string" && id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : String(id ?? ""));

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
    addWrapped("An open map: a new name needs no declaration. A state reads the variables as they are when it starts; work already "
        + "running keeps the values it started with. They cannot change the published definition, permissions, join receipts or request winners.", "gray");
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
        hint: "Tab name/value · ↑↓ copy a listed variable · Enter set · ctrl-r remove (asks first) · Esc back to the view",
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
    const lines = [{ text: `Draft · revision ${editor.revision}${editor.semver ? ` · version ${editor.semver}` : ""} — e edits its YAML`, color: "cyan", indent: "" }];
    if (projection.draftEdit?.changed) {
        lines.push({ text: `Unsaved edits, started from revision ${projection.draftBuffer.base.revision}: e shows them`, color: "yellow", indent: "  " });
    }
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
    const lines = textLines.map((line, index) => [{ text: `${String(index + 1).padStart(gutter - 1)} `, color: "gray" },
        ...editorRow(line, Math.max(10, contentWidth - gutter), index === at.line ? at.column : null)]);
    const editorHeight = Math.max(8, height - 16);
    const rows = Math.max(1, editorHeight - 2);
    const scrollOffset = Math.max(0, Math.min(at.line - Math.floor(rows / 2), Math.max(0, lines.length - rows)));
    // A revision this person just saved, which the read model does not show yet.
    const unread = buffer.base.revision > editor.revision;
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

/** The portal's history wording (its Result column). */
const resultWord = execution => execution.status === "pending" ? "Pending"
    : execution.resultKind === "business" ? "Business result"
        : execution.resultKind === "runtime_error" ? "Runtime error" : "Result kind not recorded";

const durationText = ms => typeof ms === "number" && Number.isFinite(ms)
    ? (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`) : "not recorded";

/**
 * The selected state's executions in the loaded history, newest first, as the portal's History tab lists them: a v2
 * state's visits with neighbouring unchanged repeats combined (compactWorkflowV2Executions), a legacy state's steps.
 */
function historyLines(node) {
    if (node.shape === "v2") {
        const rows = compactWorkflowV2Executions(Array.isArray(node.executions) ? node.executions : []);
        const lines = rows.slice(0, HISTORY_ROW_LIMIT).map(({ execution, count, from, to }) =>
            `  ${count > 1 ? `visits ${from}–${to} (×${count})` : `visit ${execution.ordinal ?? "—"}`} · ${resultWord(execution)} · ${execution.outcome || "—"}`);
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
 * A test run's intercepted effects (design 05), as the portal's table lists them: the effect, its state and its answer,
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
        const answer = answered ? `${item.response.kind ?? "answered"} · ${item.response.disposition ?? "—"}` : "waiting for the parent";
        return { text: `  ${effect} · state ${item.stateId ?? "—"} · ${answer}${item.stateId && item.stateId === selectedId ? " ◂ this state" : ""}`,
            color: answered ? "white" : "yellow" };
    });
    if (items.length > EFFECT_LIMIT) lines.push({ text: `  … ${items.length - EFFECT_LIMIT} more`, color: "gray" });
    return {
        title: `Intercepted effects of this test run (${items.length}${waiting ? `; ${waiting} wait${waiting === 1 ? "s" : ""} for the parent` : ""}):`,
        lines,
        note: "The TUI shows them; the run's parent agent, a fixture or a person in the portal answers them.",
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
    for (const line of [...runControlLines(projection), ...runVariableLines(projection), ...draftLines(projection)]) {
        if (line.clip) add(`${line.indent}${line.text}`, line.color);
        else for (const text of wrapped(line.text, Math.max(20, width), line.indent)) add(text, line.color);
    }
    for (const banner of projection.banners) add(`! ${banner.text}`, banner.level === "error" ? "red" : "yellow");
    if (projection.readError) add(`The workflow's current state could not be read: ${projection.readError}`, "red");
    if (!selected) {
        if (projection.noGraph) add("This workflow has no graph to show: its definition is not valid or not available.", "yellow");
        else if (projection.error) add(projection.error, "red");
        else add(projection.loading || !projection.definition ? "Loading workflow graph…" : "This workflow has no states.", "gray");
        return lines;
    }
    const node = selected.node;
    add(`${selected.id} · ${selected.label}${selected.initial ? " · initial state" : ""}`, "cyan", { bold: true });
    add(`State: ${selected.stateLabel}`);
    add(`Executions: ${selected.runs}${selected.partial ? " in loaded history" : ""}`);
    if (node.shape === "v2") {
        add(`Last outcome: ${node.outcome ? `${node.outcome} · ${node.resultKind === "runtime_error" ? "runtime error" : "business outcome"}` : "Not recorded"}`);
        // An agent state's task, the workflow interface it names and what the shown run pins it to, as the portal says them.
        if (node.kind === "agent") {
            add(`Agent: ${workflowV2AgentTask(node)}`);
            for (const [label, value] of workflowV2AgentBindingRows(node.binding)) add(`${label}: ${value}`);
        }
        for (const line of node.description || []) add(line, "gray");
    } else if (node.outcome) {
        add(`Last outcome: ${node.outcome}`);
    }
    if (selected.transitions.length) {
        add("Transitions:", "cyan");
        for (const route of selected.transitions) {
            const notes = [route.kind === "error" ? "runtime error route" : null, route.kind === "branch" ? "where each branch starts" : null,
                route.loop ? "↺ in a loop" : null].filter(Boolean);
            add(`  ${route.label} → ${route.target}${notes.length ? ` · ${notes.join(" · ")}` : ""}`);
        }
    } else if (node.type === "terminal") {
        add("The workflow ends at this state.", "gray");
    }
    if (occurrences.length) {
        add("Agent chats (Tab: choose · Enter: open):", "cyan");
        occurrences.forEach((occurrence, index) => {
            const chosen = index === occurrenceIndex;
            const visit = occurrence.ordinal === null ? "visit —" : `visit ${occurrence.ordinal}`;
            const result = occurrence.status === "pending" ? "working" : occurrence.outcome ? `${occurrence.status} · ${occurrence.outcome}` : occurrence.status || "—";
            add(`${chosen ? "▸" : " "} ${visit} · ${result} · ${occurrence.childSessionId}`, chosen ? "white" : "gray", chosen ? { bold: true } : {});
        });
        add("People can read these chats; the server refuses their prompts, answers and steers.", "gray");
    } else if (node.shape === "v2" && node.kind === "agent") {
        add("No child session is listed for it yet.", "gray");
    }
    const result = node.result;
    if (node.shape === "v2" && result) {
        if (result.resultKind === "runtime_error") {
            add(`Runtime error: ${bounded(valueText(result.errorPreview ?? result.outcome ?? (result.effectStatus ? `effect ${result.effectStatus}` : "")), VALUE_LIMIT)}`, "red");
        } else if (result.outputPreview !== undefined) {
            add(`Output: ${bounded(valueText(result.outputPreview), VALUE_LIMIT)}`);
        }
    } else if (node.shape !== "v2" && result) {
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
    else add("  No executions in the loaded history.", "gray");
    const effects = testEffectLines(projection, selected.id);
    if (effects) {
        add(effects.title, "cyan");
        for (const line of effects.lines) add(line.text, line.color);
        add(effects.note, "gray");
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
    const nodeRows = selection.nodes.map((entry, index) => nodeRow(entry, index === selection.selectedIndex, idWidth, labelWidth, contentWidth));
    const rows = nodeRows.length ? nodeRows : [[{ text: selection.projection.loading ? "Loading workflow graph…" : "No states to show.", color: "gray" }]];
    const detailsLines = detailLines(selection, contentWidth);
    // The details scroll (PgUp/PgDn) within what its panel can show: never past its last line.
    const { listHeight, detailsHeight } = panelHeights(viewportHeight ?? state?.ui?.layout?.viewportHeight ?? 40, rows.length);
    const detailsMaxScroll = Math.max(0, detailsLines.length - Math.max(1, detailsHeight - 2));
    return {
        title: bounded(`Workflow: ${selection.projection.name} · ${selection.projection.status}`, contentWidth),
        rows,
        selectedRowIndex: selection.selectedIndex,
        detailsTitle: selection.selected
            ? `State ${bounded(selection.selected.id, 30)} — ↑↓ state · ←→ run · Tab agent chat · Enter open · Esc close` : "Workflow",
        detailsLines,
        listHeight,
        detailsHeight,
        detailsScroll: Math.max(0, Math.min(Number(selection.modal.detailsScroll) || 0, detailsMaxScroll)),
        detailsMaxScroll,
        idealWidth: width,
        childSessionId: selection.occurrence?.childSessionId ?? null,
    };
}

/** The note a read-only composer shows when the session's input policy (normalizeWorkflowInputPolicy) refuses prompts. */
export const WORKFLOW_INPUT_DENIED_TEXT = "This session runs a workflow state. People cannot send it prompts, answers or steers.";

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
    const reason = policy.reason || WORKFLOW_INPUT_DENIED_TEXT;
    return policy.controllingSessionId ? `${reason} Its controlling agent is session ${policy.controllingSessionId}.` : reason;
}
