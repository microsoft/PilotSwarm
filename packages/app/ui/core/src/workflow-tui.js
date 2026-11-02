import { layoutWorkflowGraph, workflowNodeViews, workflowReadModelView } from "./workflow-view.js";
import { workflowV2RunPickerModel } from "./workflow-v2-run-picker.js";
import { compactWorkflowV2Executions, projectWorkflowV2, workflowV2RouteKind } from "./workflow-v2-view.js";

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
 * model: the live run, or any run in the workflow's run list). It sends
 * nothing and changes nothing: a person's commands, the draft editor and test
 * controls are not part of it, and the server keeps refusing human input to
 * an agent state's subtree.
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
    return {
        definition, nodes, v2, status, live, runPicker,
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
