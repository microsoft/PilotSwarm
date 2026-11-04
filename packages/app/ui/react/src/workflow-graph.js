import React from "react";
import { layoutWorkflowGraphTB, WORKFLOW_GRAPH_LABEL_HEIGHT } from "../../core/src/workflow-graph-layout.js";

const h = React.createElement;

/**
 * The workflow graph (owner batch 5, g-02): laid out top to bottom (layoutWorkflowGraphTB) and drawn by React Flow, with
 * zoom, fit and a hand to move it (workflow-flow.js, loaded on first use so the portal's first load stays the same size).
 * Until React Flow has loaded, on a server render, or if it cannot load, the same steps and edges are drawn as a plain,
 * scrollable picture of the same layout. Both draw each step with WorkflowStepCard and each edge with WorkflowEdgeShape,
 * so a step keeps its button semantics, classes and texts whichever draws it.
 */

/** One step: a button named "Inspect <id>" that selects it, with its name, what it does, its state and its visits. */
export function WorkflowStepCard({ node, selected = false, onSelect }) {
    const meta = node.shape === "v2" ? node.label
        : node.type === "terminal" ? `ends · ${node.outcome || "terminal"}` : `${node.runtime || "script"} · ${node.outcome || node.state}`;
    return h("div", {
        className: `ps-workflow-node is-${node.state}${selected ? " is-selected" : ""}${node.type === "terminal" ? " is-terminal" : ""}`,
        "data-phase": node.phase, "data-node-id": node.id, role: "button", tabIndex: 0,
        "aria-label": `Inspect ${node.id}`, "aria-pressed": selected,
        title: node.shape === "v2" ? `${node.id} · ${node.label} · ${node.stateLabel}` : node.id,
        onClick: () => onSelect(node.id),
        onKeyDown: event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node.id); }
        },
    },
    h("span", { className: "ps-workflow-node-name" }, node.id),
    h("span", { className: "ps-workflow-node-meta" }, meta),
    node.shape === "v2" ? h("span", { className: "ps-workflow-node-meta" }, node.stateLabel) : null,
    node.runs ? h("span", { className: "ps-workflow-node-runs" }, `×${node.runs}${node.partial ? " loaded" : ""}`) : null);
}

/** One edge: its curve with an arrowhead (dashed for a runtime-error route) and its label, the whole outcome as its title. */
export function WorkflowEdgeShape({ edge, markerEnd }) {
    const error = edge.kind === "error";
    const width = edge.labelWidth ?? 60;
    return h("g", {
        className: "ps-workflow-edge", "data-from": edge.from, "data-to": edge.to, "data-kind": edge.kind,
        "aria-label": `${edge.from}: ${edge.outcome} → ${edge.to}${error ? " (runtime error route)" : ""}`,
    },
    h("path", { className: "ps-workflow-edge-path", d: edge.path, fill: "none", markerEnd, strokeDasharray: error ? "5 4" : undefined }),
    h("g", { className: "ps-workflow-edge-label", transform: `translate(${edge.labelX},${edge.labelY})` },
        h("rect", { x: -width / 2, y: -WORKFLOW_GRAPH_LABEL_HEIGHT / 2, width, height: WORKFLOW_GRAPH_LABEL_HEIGHT, rx: 4 }),
        h("text", { textAnchor: "middle", dominantBaseline: "central" }, edge.labelText ?? edge.outcome, h("title", null, edge.outcome))));
}

/**
 * What decides the graph's layout, as one string: the steps and their routes, the first step and the revision. A run's
 * progress changes the steps' states, never this, so the layout is computed (and a view without a remembered one fitted)
 * only when the graph itself changes.
 */
export function workflowGraphKey(definition) {
    const states = Array.isArray(definition?.states) ? definition.states : [];
    return JSON.stringify([definition?.shape ?? "v1", definition?.revision ?? null, definition?.initial ?? null,
        states.map(node => [node?.id, node?.type, node?.next ?? null, node?.outcomes ?? null, node?.body?.initial ?? null])]);
}

/** The plain picture: the layout at its own size, scrolled when it is larger than the graph's area. */
function WorkflowGraphStatic({ layout, nodes, selected, select }) {
    const markerId = `wf-arrow-${React.useId().replace(/:/g, "")}`;
    return h("div", { className: "ps-workflow-graph-static" },
        h("div", { className: "ps-workflow-graph-canvas", style: { width: layout.width, height: layout.height } },
            h("svg", { className: "ps-workflow-graph-edges", width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}` },
                h("defs", null,
                    h("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" },
                        h("path", { d: "M0 0L10 5L0 10z", fill: "currentColor" }))),
                layout.edges.map(edge => h(WorkflowEdgeShape, { key: JSON.stringify([edge.from, edge.to]), edge, markerEnd: `url(#${markerId})` }))),
            nodes.map(node => {
                const box = layout.positions.get(node.id);
                return box ? h("div", { key: node.id, className: "ps-workflow-node-slot", style: { left: box.x, top: box.y, width: box.width, height: box.height } },
                    h(WorkflowStepCard, { node, selected: node.id === selected?.id, onSelect: select })) : null;
            })));
}

// React Flow, loaded once on first use and kept; a failed load is tried again by the next graph.
let flowModule = null;
let flowLoading = null;
function loadFlow() {
    flowLoading ??= import("./workflow-flow.js").then(module => { flowModule = module; return module; }, error => { flowLoading = null; throw error; });
    return flowLoading;
}

/**
 * The graph area's content: React Flow once it is loaded, the plain picture until then. The flow is keyed by `scope` (the
 * workflow's session) and the graph, so another workflow or a new definition or revision starts a new view while a run's
 * progress keeps the person's zoom and position. Batch 6 (f-06): `viewport` is the view remembered for this workflow
 * ({ key, x, y, zoom }); it is used only for the graph it was taken of (its `key`), and `onViewport` is given each new one
 * with that key.
 */
export function WorkflowGraph({ definition, nodes, selected, select, scope = null, viewport = null, onViewport = null }) {
    const key = workflowGraphKey(definition);
    // The key holds everything of the definition the layout reads.
    const layout = React.useMemo(() => layoutWorkflowGraphTB(definition), [key]);
    const remembered = viewport && viewport.key === key ? viewport : null;
    const report = React.useCallback(next => { onViewport?.({ key, ...next }); }, [key, onViewport]);
    const [Flow, setFlow] = React.useState(() => flowModule?.WorkflowFlow ?? null);
    React.useEffect(() => {
        if (Flow) return undefined;
        let live = true;
        loadFlow().then(module => { if (live) setFlow(() => module.WorkflowFlow); }, () => {});
        return () => { live = false; };
    }, [Flow]);
    return h("div", { className: "ps-workflow-graph", role: "group", "aria-label": "Workflow graph", "data-renderer": Flow ? "flow" : "static" },
        Flow ? h(Flow, { key: `${scope ?? ""}\u0000${key}`, layout, nodes, selected, select, viewport: remembered, onViewport: report })
            : h(WorkflowGraphStatic, { layout, nodes, selected, select }));
}
