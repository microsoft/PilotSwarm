import React from "react";
import { layoutWorkflowGraphTB, workflowGraphEdgeKey, WORKFLOW_GRAPH_LABEL_HEIGHT } from "../../core/src/workflow-graph-layout.js";
import { workflowV1NodeCard } from "../../core/src/workflow-words.js";

const h = React.createElement;

/**
 * The workflow graph (owner batch 5, g-02): laid out top to bottom (layoutWorkflowGraphTB) and drawn by React Flow, with
 * zoom, fit and a hand to move it (workflow-flow.js, loaded on first use so the portal's first load stays the same size).
 * Until React Flow has loaded, on a server render, or if it cannot load, the same steps and edges are drawn as a plain,
 * scrollable picture of the same layout. Both draw each step with WorkflowStepCard and each edge with WorkflowEdgeShape,
 * so a step keeps its button semantics, classes and texts whichever draws it.
 */

const glyph = (...children) => h("svg", { className: "ps-workflow-node-glyph", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2,
    strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" }, ...children);

/** Workflow Simplified (10, F5): an icon for each node type. */
const NODE_GLYPHS = {
    script: () => glyph(h("path", { d: "M8 8l-4 4 4 4" }), h("path", { d: "M16 8l4 4-4 4" }), h("path", { d: "M13.5 5l-3 14" })),
    agent: () => glyph(h("path", { d: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" }), h("circle", { cx: "19", cy: "19", r: "1.2" })),
    wait: () => glyph(h("circle", { cx: "12", cy: "12", r: "8" }), h("path", { d: "M12 8v4l3 2" })),
    request: () => glyph(h("path", { d: "M4 5h16v11h-9l-5 4v-4H4z" }), h("path", { d: "M10 8.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4" }), h("path", { d: "M12 14v.2" })),
    send: () => glyph(h("path", { d: "M21 3L10 14" }), h("path", { d: "M21 3l-7 18-4-7-7-4z" })),
    receive: () => glyph(h("path", { d: "M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" }), h("path", { d: "M12 4v10" }), h("path", { d: "M8 10l4 4 4-4" })),
    parallel: () => glyph(h("rect", { x: "3", y: "8", width: "13", height: "11", rx: "2" }), h("path", { d: "M7 8V5h13v11h-4" })),
};

/**
 * One node: a button named "Inspect <id>" that selects it. Owner, 2026-11-07T17:47Z (OF-S2-2: crisp): a version 2 node
 * has two rows: its type's icon and its name, with how often it ran as a badge ("↻ 126", "↻ 126+" when older visits are
 * not loaded); then its state as a mark (✓ ● ✕ ⊘) and its one key fact (node.card, workflowNodeCardWords). Its type and
 * the full sentence are its title (its tooltip, and its description for screen readers). The node a Workflow starts at
 * carries the Start marker (F4); an end is a ring, filled once the Workflow reached it, in its outcome's colour; a node
 * the Workflow did not reach is dimmed (W7). Owner 2026-11-09 (the timeline): `litCount` and `litAge`, how often the last
 * four transitions entered it and how long ago (workflowV2LitTransitions), and `current`, the step of the visit shown; the
 * stylesheet draws them (data-lit, data-lit-age, data-current) apart from the selection.
 */
export function WorkflowStepCard({ node, selected = false, onSelect, litCount = 0, litAge = null, current = false }) {
    const v2 = node.shape === "v2";
    const terminal = node.type === "terminal";
    const kind = v2 ? node.kind : terminal ? "terminal" : "script";
    const Glyph = NODE_GLYPHS[kind] ?? null;
    const reached = terminal && (node.state === "done" || node.state === "failed" || node.state === "cancelled");
    const notReached = v2 && node.hasRun && node.phase === "not-reached";
    // Review 18:45Z: a version 1 node has the same crisp card (workflowV1NodeCard).
    const card = v2 ? node.card ?? null : workflowV1NodeCard(node);
    const text = h("span", { className: "ps-workflow-node-text" },
        h("span", { className: "ps-workflow-node-row" },
            h("span", { className: "ps-workflow-node-name" }, node.id),
            card?.badge ? h("span", { className: "ps-workflow-node-visits", title: card.badge.title, "aria-hidden": "true" }, card.badge.text) : null),
        card?.row2 ? h("span", { className: "ps-workflow-node-meta is-state", "data-state-mark": card.mark?.word ?? "none" },
            card.mark ? h("span", { className: "ps-workflow-node-mark", "aria-hidden": "true" }, card.mark.glyph) : null,
            card.fact ? h("span", { className: "ps-workflow-node-fact" }, card.fact) : null) : null);
    return h("div", {
        className: `ps-workflow-node is-${node.state}${selected ? " is-selected" : ""}${terminal ? " is-terminal" : ""} is-kind-${kind}`
            + `${reached ? " is-reached" : ""}${notReached ? " is-not-reached" : ""}${node.initial ? " is-initial" : ""}`,
        "data-phase": node.phase, "data-kind": kind, ...(terminal ? { "data-outcome": node.outcome ?? "" } : {}), "data-node-id": node.id,
        ...litAttributes(litCount, litAge), ...(current ? { "data-current": "true" } : {}),
        role: "button", tabIndex: 0,
        "aria-label": `Inspect ${node.id}`, "aria-pressed": selected,
        title: card?.title ?? `${node.id} · ${node.label} · ${node.stateLabel}`,
        onClick: () => onSelect(node.id),
        onKeyDown: event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node.id); }
        },
    },
    node.initial ? h("span", { className: "ps-workflow-node-start", "aria-hidden": "true" }, h("span", null, "Start")) : null,
    terminal ? h("span", { className: "ps-workflow-node-ring", "aria-hidden": "true" }) : Glyph ? h("span", { className: "ps-workflow-node-icon" }, h(Glyph)) : null,
    text);
}

/** A lit part's attributes (owner 2026-11-09): data-lit "1" (taken once among the last four) or "2", and its age (0 the newest). */
function litAttributes(count, age) {
    if (!(count > 0)) return {};
    return { "data-lit": count >= 2 ? "2" : "1", "data-lit-age": String(Math.min(3, Math.max(0, Number.isSafeInteger(age) ? age : 0))) };
}

/** What an edge says to a screen reader: its route, or (owner batch 7, H2) the way into a branch box or into a join bar. */
function edgeAria(edge, error) {
    // IR 11: a named branch's lane starts at its first step, and ends at the join.
    if (edge.branch && typeof edge.lane === "string") return `${edge.from}: branch ${edge.lane} starts at ${edge.start}`;
    if (edge.branch && edge.start !== undefined) return `${edge.from}: each item starts${edge.start ? ` at ${edge.start}` : ""}`;
    if (edge.join && typeof edge.lane === "string") return `${edge.from}: branch ${edge.lane} ends at the join of ${edge.owner}`;
    if (edge.join) return `${edge.from}: the item ends at the join of ${edge.owner}`;
    return `${edge.owner ? `${edge.owner} after its join` : edge.from}: ${edgeWords(edge)} → ${edge.to}`;
}

/** An edge's outcomes in words: its outcomes by name, its error routes in the Next words ("✕ limit · ✕ agent failed"). */
function edgeWords(edge) {
    return Array.isArray(edge.outcomeWords) && edge.outcomeWords.length ? edge.outcomeWords.join(" · ") : edge.outcome;
}

/** An edge label's title: its whole outcome; OF-S2-2: an error route's says it is one, with every outcome it takes. */
function edgeTitle(edge, error) {
    if (edge.branch && typeof edge.lane === "string") return `Branch ${edge.lane} starts here`;
    return error ? `Error routes: ${edgeWords(edge)}` : edgeWords(edge);
}

/**
 * One edge: its curve with an arrowhead (dashed for a runtime-error route) and its label, the whole outcome as its title.
 * An edge without a label (into a branch box or a join bar, H2) draws none. Owner 2026-11-09 (the timeline): a lit edge
 * (`litCount` taken among the last four transitions, `litAge` how long ago) has its own arrowhead in the lit colour.
 */
export function WorkflowEdgeShape({ edge, markerEnd, litCount = 0, litAge = null }) {
    const error = edge.kind === "error";
    const width = edge.labelWidth ?? 60;
    const markerId = `wf-lit-${React.useId().replace(/:/g, "")}`;
    const lit = litAttributes(litCount, litAge);
    return h("g", {
        className: "ps-workflow-edge", "data-from": edge.from, "data-to": edge.to, "data-kind": edge.kind, "aria-label": edgeAria(edge, error), ...lit,
    },
    lit["data-lit"] ? h("defs", null, h("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto",
        markerUnits: "userSpaceOnUse" }, h("path", { className: "ps-workflow-edge-lit-arrow", d: "M0 0L10 5L0 10z" }))) : null,
    h("path", { className: "ps-workflow-edge-path", d: edge.path, fill: "none", markerEnd: lit["data-lit"] ? `url(#${markerId})` : markerEnd,
        strokeDasharray: error ? "5 4" : undefined }),
    width > 0 ? h("g", { className: "ps-workflow-edge-label", transform: `translate(${edge.labelX},${edge.labelY})` },
        h("rect", { x: -width / 2, y: -WORKFLOW_GRAPH_LABEL_HEIGHT / 2, width, height: WORKFLOW_GRAPH_LABEL_HEIGHT, rx: 4 }),
        h("text", { textAnchor: "middle", dominantBaseline: "central" }, edge.labelText ?? edge.outcome, h("title", null, edgeTitle(edge, error)))) : null);
}

/**
 * A parallel step's branch box (owner batch 7, H2): a dashed box drawn as a stack (one branch per item), labelled "Each
 * branch" and, while the step runs, how many branches run, wait and are done. `node` is the parallel step's view. Its
 * label row is where it is dragged (React Flow's drag handle). IR 11: a box of named branches (`group.lanes`) is
 * "Branches", with no stack: its lanes stand side by side in it.
 */
export function WorkflowGroupBox({ group, node = null }) {
    const view = node?.joinBar ?? null;
    const named = Array.isArray(group.lanes) && group.lanes.length > 0;
    return h("div", { className: `ps-workflow-group is-${view?.state ?? "idle"}${named ? " is-named" : ""}`, "data-group": group.parallel, role: "group",
        "aria-label": `${named ? `Branches of ${group.parallel} (${group.lanes.join(", ")})` : `For each item of ${group.parallel}`}${view?.group.text ? `: ${view.group.text}` : ""}` },
    h("div", { className: "ps-workflow-group-head", title: named
        ? `Each branch of ${group.parallel} runs its own nodes: ${group.lanes.join(", ")}.` : `The nodes ${group.parallel} runs once for each item.` },
        h("span", { className: "ps-workflow-group-label" }, view?.group.label ?? (named ? "Branches" : "For each item")),
        view?.group.text ? h("span", { className: "ps-workflow-group-counts" }, view.group.text) : null));
}

/**
 * A parallel step's join bar (owner batch 7, H2): where every branch meets, with its rule and its state, and (owner
 * decision join-k-of-n) its own time limit. It is not a step of its own: a click, Enter or Space selects the parallel
 * step. `node` is the parallel step's view.
 */
export function WorkflowJoinBar({ join, node = null, selected = false, onSelect }) {
    const view = node?.joinBar ?? null;
    const rule = `${view?.label ?? "Joins when all succeed"}${view?.stateText ? ` · ${view.stateText}` : ""}`;
    // Owner decision join-k-of-n: its own time limit, which the engine enforces, on a line of its own.
    const limit = view?.limit ?? null;
    return h("div", {
        className: `ps-workflow-join is-${view?.state ?? "idle"}${selected ? " is-selected" : ""}`, "data-join": join.parallel, role: "button", tabIndex: 0,
        "aria-label": `${join.parallel}: ${rule}${limit ? ` · ${limit.text}` : ""}. Inspect ${join.parallel}`, "aria-pressed": selected,
        title: `${rule}. The nodes after ${join.parallel} start from here.${limit ? ` ${limit.title}` : ""}`,
        onClick: () => onSelect(join.parallel),
        onKeyDown: event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(join.parallel); }
        },
    },
    h("span", { className: "ps-workflow-join-bar", "aria-hidden": true }),
    h("span", { className: "ps-workflow-join-rule" }, rule),
    limit ? h("span", { className: "ps-workflow-join-limit" }, limit.text) : null);
}

/**
 * What decides the graph's layout, as one string: the steps and their routes, the first step and the revision. A run's
 * progress changes the steps' states, never this, so the layout is computed (and a view without a remembered one fitted)
 * only when the graph itself changes.
 */
export function workflowGraphKey(definition) {
    const states = Array.isArray(definition?.states) ? definition.states : [];
    // A parallel step's body steps decide its branch box (owner batch 7, H2); every other step's entry is as before.
    return JSON.stringify([definition?.shape ?? "v1", definition?.revision ?? null, definition?.initial ?? null,
        states.map(node => [node?.id, node?.type, node?.next ?? null, node?.outcomes ?? null,
            node?.type === "parallel" && Array.isArray(node.body?.states) ? [node.body.initial ?? null, node.body.states] : node?.body?.initial ?? null])]);
}

/** The plain picture: the layout at its own size, scrolled when it is larger than the graph's area. */
function WorkflowGraphStatic({ layout, nodes, selected, select, lit = null }) {
    const markerId = `wf-arrow-${React.useId().replace(/:/g, "")}`;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const slot = (box, className, child, key) => h("div", { key, className, style: { left: box.x, top: box.y, width: box.width, height: box.height } }, child);
    return h("div", { className: "ps-workflow-graph-static" },
        h("div", { className: "ps-workflow-graph-canvas", style: { width: layout.width, height: layout.height } },
            // Branch boxes under the edges and steps, join bars over them (owner batch 7, H2).
            [...(layout.groups?.values() ?? [])].map(group => slot(group, "ps-workflow-group-slot",
                h(WorkflowGroupBox, { group, node: byId.get(group.parallel) ?? null }), group.id)),
            h("svg", { className: "ps-workflow-graph-edges", width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}` },
                h("defs", null,
                    h("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" },
                        h("path", { d: "M0 0L10 5L0 10z", fill: "currentColor" }))),
                layout.edges.map(edge => {
                    const key = workflowGraphEdgeKey(edge.from, edge.to);
                    const shown = lit?.edges?.get(key) ?? null;
                    return h(WorkflowEdgeShape, { key, edge, markerEnd: `url(#${markerId})`, litCount: shown?.count ?? 0, litAge: shown?.age ?? null });
                })),
            nodes.map(node => {
                const box = layout.positions.get(node.id);
                const shown = lit?.nodes?.get(node.id) ?? null;
                return box ? h("div", { key: node.id, className: "ps-workflow-node-slot", style: { left: box.x, top: box.y, width: box.width, height: box.height } },
                    h(WorkflowStepCard, { node, selected: node.id === selected?.id, onSelect: select, litCount: shown?.count ?? 0, litAge: shown?.age ?? null,
                        current: lit?.current === node.id })) : null;
            }),
            [...(layout.joins?.values() ?? [])].map(join => slot(join, "ps-workflow-join-slot",
                h(WorkflowJoinBar, { join, node: byId.get(join.parallel) ?? null, selected: join.parallel === selected?.id, onSelect: select }), join.id))));
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
 * with that key. Batch 6 (f-03): `places` are where the person moved the step boxes ({ stepId: [x, y] }) and
 * `onPlaces` is told the new places at the end of each drag (null after Reset layout); the plain picture keeps the
 * automatic layout. `mode` is the display mode it is shown in ("normal", "zen", "full"): a change fits an untouched view
 * again (owner, 2026-11-06T19:40Z, F8). Owner 2026-11-09 (the timeline): `lit`, the last four transitions up to the visit
 * shown and its step (workflowV2LitTransitions), drawn the same by both renderers.
 */
export function WorkflowGraph({ definition, nodes, selected, select, scope = null, viewport = null, onViewport = null, places = null, onPlaces = null,
    mode = "normal", lit = null }) {
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
        Flow ? h(Flow, { key: `${scope ?? ""}\u0000${key}`, layout, nodes, selected, select, viewport: remembered, onViewport: report, places, onPlaces, mode, lit })
            : h(WorkflowGraphStatic, { layout, nodes, selected, select, lit }));
}
