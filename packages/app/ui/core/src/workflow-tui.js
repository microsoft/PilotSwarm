import { layoutWorkflowGraph, workflowNodeViews, workflowReadModelView } from "./workflow-view.js";
import { projectWorkflowV2, workflowV2RouteKind } from "./workflow-v2-view.js";

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
 * legacy node views). It sends nothing and changes nothing: a person's
 * commands, the draft editor and test controls are not part of it, and the
 * server keeps refusing human input to an agent state's subtree.
 */

const EMPTY_EVENTS = Object.freeze([]);
const STATE_GLYPHS = { running: "●", done: "✓", failed: "✗", cancelled: "⊘", idle: "○" };
const STATE_COLORS = { running: "yellow", done: "green", failed: "red", cancelled: "gray", idle: "gray" };
const VALUE_LIMIT = 240;

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
    return {
        definition, nodes, v2, status, live,
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

function detailLines(selection, width) {
    const { projection, selected, occurrences, occurrenceIndex } = selection;
    const lines = [];
    const add = (text, color = "white", extra = {}) => lines.push({ text: clip(text, Math.max(20, width)), color, ...extra });
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
    return lines;
}

/**
 * The workflow view's presentation (TUI modal): the title (workflow name and status), one row per state in graph order
 * with the selected row, and the selected state's detail lines. Null unless the workflow view is open. Pure.
 */
export function selectWorkflowViewModal(state, maxWidth = 100) {
    const selection = selectWorkflowViewSelection(state);
    if (!selection) return null;
    const width = Math.max(40, Number(maxWidth) || 100);
    const contentWidth = width - 4;
    const idWidth = Math.min(20, Math.max(4, ...selection.nodes.map(entry => entry.id.length)));
    const labelWidth = Math.min(24, Math.max(6, ...selection.nodes.map(entry => entry.label.length)));
    const rows = selection.nodes.map((entry, index) => nodeRow(entry, index === selection.selectedIndex, idWidth, labelWidth, contentWidth));
    return {
        title: bounded(`Workflow: ${selection.projection.name} · ${selection.projection.status}`, contentWidth),
        rows: rows.length ? rows : [[{ text: selection.projection.loading ? "Loading workflow graph…" : "No states to show.", color: "gray" }]],
        selectedRowIndex: selection.selectedIndex,
        detailsTitle: selection.selected ? `State ${bounded(selection.selected.id, 30)} — ↑↓ state · Tab agent chat · Enter open · Esc close` : "Workflow",
        detailsLines: detailLines(selection, contentWidth),
        idealWidth: width,
        childSessionId: selection.occurrence?.childSessionId ?? null,
    };
}
