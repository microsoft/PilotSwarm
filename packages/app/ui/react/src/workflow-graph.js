import React from "react";
import { PHONE_MEDIA_QUERY, useMediaQuery } from "./use-media-query.js";
import {
    layoutWorkflowGraphTB, workflowGraphNodeHeight, workflowHandlerArrows, workflowJoinBarBox, workflowJoinBarSpan, WORKFLOW_BOUNDARY_EVENT_INSET,
    WORKFLOW_GRAPH_LABEL_HEIGHT,
} from "../../core/src/workflow-graph-layout.js";
import { workflowEdgeShown, workflowJoinShown, workflowLanePill, workflowStepMarks } from "../../core/src/workflow-transitions.js";
import { workflowJoinShort } from "../../core/src/workflow-view.js";

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
    approval: () => glyph(h("rect", { x: "5", y: "4", width: "14", height: "17", rx: "2" }),
        h("path", { d: "M9 4V2h6v2M8 13l3 3 5-6" })),
    request: () => glyph(h("path", { d: "M4 5h16v11h-9l-5 4v-4H4z" }), h("path", { d: "M10 8.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4" }), h("path", { d: "M12 14v.2" })),
    send: () => glyph(h("path", { d: "M21 3L10 14" }), h("path", { d: "M21 3l-7 18-4-7-7-4z" })),
    receive: () => glyph(h("path", { d: "M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" }), h("path", { d: "M12 4v10" }), h("path", { d: "M8 10l4 4 4-4" })),
    parallel: () => glyph(h("rect", { x: "3", y: "8", width: "13", height: "11", rx: "2" }), h("path", { d: "M7 8V5h13v11h-4" })),
    // A flowchart decision: a diamond with a fork inside (one way in, two ways out).
    decision: () => glyph(h("path", { d: "M12 2l10 10-10 10L2 12z" }), h("path", { d: "M12 16.5V13l-2.5-3.5M12 13l2.5-3.5" })),
    // A child workflow spawn: parent node branching out to a launched child diamond.
    spawn: () => glyph(h("circle", { cx: "6", cy: "6", r: "2.5" }), h("path", { d: "M6 8.5v7a2 2 0 0 0 2 2h4" }), h("path", { d: "M16 12.5l4.5 4.5-4.5 4.5-4.5-4.5z" })),
};

/**
 * One node: a button named "Inspect <id>" that selects it. Owner, 2026-11-07T17:47Z (OF-S2-2: crisp): a node has two
 * rows: its type's icon and its name, with how often it ran as a badge ("↻ 126", "↻ 126+" when older visits are
 * not loaded); then its state as a mark (✓ ● ✕ ⊘) and its one key fact (node.card, workflowNodeCardWords). Its type and
 * the full sentence are its title (its tooltip, and its description for screen readers). The node a Workflow starts at
 * carries the Start marker (F4); an end is a ring, filled once the Workflow reached it, in its outcome's colour; a node
 * the Workflow did not reach is dimmed (W7). Owner 2026-11-09 (the timeline): `litCount` and `litAge`, how often the last
 * four transitions entered it and how long ago (workflowLitTransitions), and `current`, the step of the visit shown; the
 * stylesheet draws them (data-lit, data-lit-age, data-current) apart from the selection.
 */
export function WorkflowStepCard({ marks = null, ...props }) {
    const card = h(WorkflowStepCardFace, props);
    const events = marks?.marks ?? [];
    const chips = marks?.chips ?? [];
    if (!events.length && !chips.length) return card;
    // R1, R2: the boundary events on its bottom edge and the end chips beside it, outside the card so it keeps its box.
    return h("div", { className: `ps-workflow-step${props.selected ? " is-selected" : ""}` }, card,
        events.map(mark => h(WorkflowHandlerMark, { key: mark.key, mark })),
        chips.length ? h(WorkflowChips, { chips }) : null);
}

/**
 * R1 (2026-11-26 12:05 PST): one error route into an end, drawn as a BPMN error boundary event: a small neutral double
 * circle with a lightning bolt on the step's bottom edge, 22 px in from its right corner, each next one 22 px further left
 * (workflowBoundaryEventAt). Selecting the step shows its dashed arrow to a ghost of the end. The one place this mark is
 * drawn, so another style (an n8n "error" port) can replace it here.
 */
function WorkflowHandlerMark({ mark }) {
    return h("span", { className: "ps-workflow-mark", role: "img", "aria-label": mark.title, title: mark.title, "data-end": mark.end,
        style: { right: WORKFLOW_BOUNDARY_EVENT_INSET * (mark.index + 1) - 9 }, ...markAttributes(mark) },
    h("svg", { viewBox: "0 0 18 18", "aria-hidden": "true", focusable: "false" },
        h("circle", { className: "ps-workflow-mark-ring", cx: 9, cy: 9, r: 8.5 }),
        h("circle", { className: "ps-workflow-mark-ring", cx: 9, cy: 9, r: 6.3 }),
        h("path", { className: "ps-workflow-mark-bolt", d: "M10.6 4.4L6.4 9.6H8.8L7.4 13.6L11.6 8.2H9.2Z" })));
}

/** A step's end chips (R2), beside it; each says its routes and its end, lit and with its ghost end while replay shows it. */
function WorkflowChips({ chips }) {
    return h("span", { className: "ps-workflow-chips" },
        chips.map(chip => h("span", { key: chip.key, className: `ps-workflow-chip is-${chip.tone}`, "data-end": chip.end, ...markAttributes(chip),
            title: `${chip.routes.map(route => route.replace(/_/g, " ")).join(", ")} → end ${chip.end} (${chip.outcome})` },
        h("span", { className: "ps-workflow-chip-text" }, chip.text), chip.ghost ? h(WorkflowGhost, { ghost: chip.ghost }) : null)));
}

/**
 * R1 (12:05 PST): the dashed, moving arrows of error routes into ends (workflowHandlerArrows), drawn over the graph in
 * its coordinates: each from its boundary event to a dashed ghost of its end, labelled "on error", "on limit" or "on
 * error · limit". In a replay a taken one is lit at its age; its ghost glows, with the transition's words, at the moment shown.
 */
export function WorkflowHandlerArrows({ arrows }) {
    if (!Array.isArray(arrows) || !arrows.length) return null;
    return h("svg", { className: "ps-workflow-handlers", width: 1, height: 1, "aria-hidden": "true", focusable: "false" },
        h("defs", null, h("marker", { id: "ps-wf-handler-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" },
            h("path", { className: "ps-workflow-handler-arrowhead", d: "M0 0L10 5L0 10z" }))),
        arrows.map(arrow => {
            const width = Math.ceil(arrow.words.length * 6.2) + 12;
            const tagWidth = arrow.tag ? Math.ceil(arrow.tag.length * 6.2) + 12 : 0;
            return h("g", { key: arrow.key, className: "ps-workflow-handler", "data-handler": arrow.key, ...litAttributes(arrow.litCount, arrow.litAge),
                ...(arrow.current ? { "data-current": "true" } : {}) },
            h("path", { className: "ps-workflow-handler-path", d: arrow.path, fill: "none", markerEnd: "url(#ps-wf-handler-arrow)" }),
            h("g", { className: "ps-workflow-handler-label", transform: `translate(${arrow.labelX},${arrow.labelY})` },
                h("rect", { x: -width / 2, y: -9, width, height: 18, rx: 3 }),
                h("text", { textAnchor: "middle", dominantBaseline: "central" }, arrow.words)),
            arrow.ghost ? h("g", { className: `ps-workflow-handler-ghost is-${arrow.ghost.outcome ?? "end"}`, transform: `translate(${arrow.ghost.x},${arrow.ghost.y})` },
                h("circle", { r: 11 }),
                h("text", { x: 16, dominantBaseline: "central" }, arrow.ghost.end)) : null,
            arrow.tag ? h("g", { className: "ps-workflow-handler-tag", transform: `translate(${arrow.labelX},${arrow.labelY + 42})` },
                h("rect", { x: -tagWidth / 2, y: -9, width: tagWidth, height: 18, rx: 3 }),
                h("text", { textAnchor: "middle", dominantBaseline: "central" }, arrow.tag)) : null);
        }));
}

/** A mark's or chip's state as attributes: lit (replay), not taken by the moment shown (R5), its end hovered in the Ends row. */
function markAttributes(item) {
    return { ...litAttributes(item.litCount, item.litAge), ...(item.visited === false ? { "data-visited": "false" } : {}),
        ...(item.hover ? { "data-hover": "true" } : {}) };
}

/**
 * Replay only: the temporary dashed line from a chip to a ghost of its end, while its transition is among the last four;
 * the ghost glows when it is the moment shown, with the transition's words ("not open").
 */
function WorkflowGhost({ ghost }) {
    return h("span", { className: `ps-workflow-ghost is-${ghost.tone}`, ...(ghost.current ? { "data-current": "true" } : {}), "aria-hidden": "true" },
        h("span", { className: "ps-workflow-ghost-line" }),
        h("span", { className: "ps-workflow-ghost-end" }, `⏹ ${ghost.end}`),
        ghost.words ? h("span", { className: "ps-workflow-ghost-tag" }, ghost.words) : null);
}

function WorkflowStepCardFace({ node, selected = false, onSelect, litCount = 0, litAge = null, current = false }) {
    const terminal = node.type === "terminal";
    const kind = node.kind;
    const Glyph = NODE_GLYPHS[kind] ?? null;
    const reached = terminal && (node.state === "done" || node.state === "failed" || node.state === "cancelled");
    const notReached = node.hasRun && node.phase === "not-reached";
    const card = node.card ?? null;
    const label = typeof node.about?.description === "string" ? node.about.description.trim() : "";
    const notes = typeof node.about?.notes === "string" ? node.about.notes : null;
    const badges = [
        notes ? h("span", { key: "notes", className: "ps-workflow-node-notes", title: notes, "aria-label": "Notes; open Node to read" }, "Notes") : null,
        card?.badge ? h("span", { key: "visits", className: "ps-workflow-node-visits", title: card.badge.title, "aria-hidden": "true" }, card.badge.text) : null,
    ];
    const text = h("span", { className: "ps-workflow-node-text" },
        h("span", { className: "ps-workflow-node-row" },
            h("span", { className: "ps-workflow-node-name", ...(label ? { title: label } : {}) }, label || node.id),
            ...(label ? [] : badges)),
        label ? h("span", { className: "ps-workflow-node-row" }, h("span", { className: "ps-workflow-node-id", title: node.id }, node.id), ...badges) : null,
        card?.row2 ? h("span", { className: "ps-workflow-node-meta is-state", "data-state-mark": card.mark?.word ?? "none" },
            card.mark ? h("span", { className: "ps-workflow-node-mark", "aria-hidden": "true" }, card.mark.glyph) : null,
            card.fact ? h("span", { className: "ps-workflow-node-fact" }, card.fact) : null) : null);
    return h("div", {
        className: `ps-workflow-node is-${node.state}${selected ? " is-selected" : ""}${terminal ? " is-terminal" : ""} is-kind-${kind}`
            + `${reached ? " is-reached" : ""}${notReached ? " is-not-reached" : ""}${node.initial ? " is-initial" : ""}${label ? " has-label" : ""}`,
        "data-phase": node.phase, "data-kind": kind, ...(terminal ? { "data-outcome": node.outcome ?? "" } : {}), "data-node-id": node.id,
        ...litAttributes(litCount, litAge), ...(current ? { "data-current": "true" } : {}),
        role: "button", tabIndex: 0,
        "aria-label": `Inspect ${node.id}${label ? `: ${label}` : ""}`, "aria-pressed": selected,
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
    // A named branch's lane starts at its first step, and ends at the join.
    if (edge.branch && typeof edge.lane === "string") return `${edge.from}: branch ${edge.lane} starts at ${edge.start}`;
    if (edge.branch && edge.start !== undefined) return `${edge.from}: each item starts${edge.start ? ` at ${edge.start}` : ""}`;
    if (edge.join && typeof edge.lane === "string") return `${edge.from}: branch ${edge.lane} ends at the join of ${edge.parallel ?? edge.owner}`;
    if (edge.join) return `${edge.from}: the item ends at the join of ${edge.parallel ?? edge.owner}`;
    return `${edge.owner ? `${edge.owner} after its join` : edge.from}: ${edgeWords(edge)} → ${edge.to}`;
}

/** An edge's outcomes in words: its outcomes by name, its error routes in the Next words ("✕ limit · ✕ agent failed"). */
function edgeWords(edge) {
    return Array.isArray(edge.outcomeWords) && edge.outcomeWords.length ? edge.outcomeWords.join(" · ") : edge.outcome;
}

/** An edge label's title: its whole outcome; OF-S2-2: an error route's says it is one, with every outcome it takes. */
function edgeTitle(edge, error) {
    if (edge.branch && typeof edge.lane === "string") return `Branch ${edge.lane} starts here`;
    const words = error ? `Error routes: ${edgeWords(edge)}` : edgeWords(edge);
    return edge.notes ? `${words}\n${edge.notes}` : words;
}

/**
 * One edge: its curve with an arrowhead (dashed for a runtime-error route) and its label, the whole outcome as its title.
 * An edge without a label (into a branch box or a join bar, H2) draws none. Owner 2026-11-09 (the timeline): a lit edge
 * (`litCount` taken among the last four transitions, `litAge` how long ago) has its own arrowhead in the lit colour.
 */
export function WorkflowEdgeShape({ edge, markerEnd, litCount = 0, litAge = null, flowing = false, visited = null, hover = false, tag = null }) {
    const error = edge.kind === "error";
    const width = edge.labelWidth ?? 60;
    const markerId = `wf-lit-${React.useId().replace(/:/g, "")}`;
    const lit = litAttributes(litCount, litAge);
    // Replay: the shown transition's outcome beside a line that has no label of its own (R3), for that moment only.
    const tagWidth = tag ? Math.ceil(tag.length * 6.2) + 14 : 0;
    return h("g", {
        className: "ps-workflow-edge", "data-from": edge.from, "data-to": edge.to, "data-kind": edge.kind, "aria-label": edgeAria(edge, error), ...lit,
        ...(visited === false ? { "data-visited": "false" } : {}), ...(hover ? { "data-hover": "true" } : {}), ...(edge.spine ? { "data-spine": "true" } : {}),
    },
    lit["data-lit"] ? h("defs", null, h("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto",
        markerUnits: "userSpaceOnUse" }, h("path", { className: "ps-workflow-edge-lit-arrow", d: "M0 0L10 5L0 10z" }))) : null,
    h("path", { className: "ps-workflow-edge-path", d: edge.path, fill: "none", markerEnd: lit["data-lit"] ? `url(#${markerId})` : markerEnd,
        strokeDasharray: error ? "5 4" : undefined }),
    // Owner 2026-11-09T06:40Z: a lit edge of an active run carries a soft light from its source to its target (the stylesheet
    // moves it; pathLength 1 makes a pass take as long on every edge). Always in this place, so it keeps running.
    lit["data-lit"] && flowing ? h("path", { className: "ps-workflow-edge-flow", d: edge.path, fill: "none", pathLength: 1, "aria-hidden": "true" }) : null,
    width > 0 ? h("g", { className: "ps-workflow-edge-label", transform: `translate(${edge.labelX},${edge.labelY})` },
        h("rect", { x: -width / 2, y: -WORKFLOW_GRAPH_LABEL_HEIGHT / 2, width, height: WORKFLOW_GRAPH_LABEL_HEIGHT, rx: 4 }),
        h("text", { textAnchor: "middle", dominantBaseline: "central" }, edge.labelText ?? edge.outcome, h("title", null, edgeTitle(edge, error)))) : null,
    // A line without a label still names its routes on hover.
    width === 0 && Array.isArray(edge.outcomes) && edge.outcomes.length
        ? h("path", { className: "ps-workflow-edge-hit", d: edge.path, fill: "none" }, h("title", null, edgeTitle(edge, error))) : null,
    tag ? h("g", { className: "ps-workflow-edge-tag", transform: `translate(${edge.labelX},${edge.labelY})`, "aria-hidden": "true" },
        h("rect", { x: -tagWidth / 2, y: -WORKFLOW_GRAPH_LABEL_HEIGHT / 2, width: tagWidth, height: WORKFLOW_GRAPH_LABEL_HEIGHT, rx: 4 }),
        h("text", { textAnchor: "middle", dominantBaseline: "central" }, tag)) : null);
}

/**
 * A parallel step's branch box (owner batch 7, H2): a dashed box drawn as a stack (one branch per item), labelled "Each
 * branch" and, while the step runs, how many branches run, wait and are done. `node` is the parallel step's view. Its
 * label row is where it is dragged (React Flow's drag handle). A box of named branches (`group.lanes`) is
 * "Branches", with no stack: its lanes stand side by side in it.
 */
export function WorkflowGroupBox({ group, node = null, selected = false, onSelect = null, litCount = 0, litAge = null, current = false, pills = [] }) {
    const view = node?.joinBar ?? null;
    const named = Array.isArray(group.lanes) && group.lanes.length > 0;
    const description = typeof node?.about?.description === "string" ? node.about.description.trim() : "";
    const name = description || group.parallel;
    const notReached = node?.hasRun && node.phase === "not-reached";
    const Glyph = NODE_GLYPHS.parallel;
    // B1: the parallel step is its box's title, with its progress and its own time limit; a click selects the step.
    const meta = [view?.group.text ?? null, view?.limit?.text ?? null].filter(Boolean).join(" · ");
    const select = () => onSelect?.(group.parallel);
    return h("div", { className: `ps-workflow-group is-${view?.state ?? "idle"}${named ? " is-named" : ""}${notReached ? " is-not-reached" : ""}`,
        "data-group": group.parallel, role: "group",
        "aria-label": `${named ? `Branches of ${group.parallel} (${group.lanes.join(", ")})` : `For each item of ${group.parallel}`}${view?.group.text ? `: ${view.group.text}` : ""}` },
    h("div", { className: `ps-workflow-group-head${selected ? " is-selected" : ""}`, role: "button", tabIndex: 0, "aria-pressed": selected,
        "aria-label": `Inspect ${group.parallel}${description ? `: ${description}` : ""}`, "data-node-id": group.parallel,
        ...litAttributes(litCount, litAge), ...(current ? { "data-current": "true" } : {}),
        title: [`${group.parallel} · ${node?.label ?? (named ? "Branches" : "For each item")}`, description || null, node?.stateLabel ?? null,
            view?.limit?.title ?? null, named ? `Each branch runs its own nodes: ${group.lanes.join(", ")}.` : "The nodes in the box run once for each item."]
            .filter(Boolean).join("\n"),
        onClick: select,
        onKeyDown: event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
        } },
        h("span", { className: "ps-workflow-group-icon", "aria-hidden": "true" }, h(Glyph)),
        h("span", { className: "ps-workflow-group-label" }, name),
        meta ? h("span", { className: "ps-workflow-group-counts" }, meta) : null),
    // B3: each lane's pill, with its branch's state at the moment shown.
    pills.map(pill => h("span", { key: pill.name, className: `ps-workflow-lane-pill${pill.tone ? ` is-${pill.tone}` : ""}`, title: pill.title,
        ...litAttributes(pill.litCount, pill.litAge),
        style: { left: pill.x - pill.width / 2, top: pill.y - WORKFLOW_GRAPH_LABEL_HEIGHT / 2, width: pill.width } }, pill.text)));
}

/**
 * A parallel step's join bar (owner batch 7, H2): where every branch meets, with its rule and its state, and (owner
 * decision join-k-of-n) its own time limit. It is not a step of its own: a click, Enter or Space selects the parallel
 * step. `node` is the parallel step's view.
 */
export function WorkflowJoinBar({ join, node = null, selected = false, onSelect, marks = null, litCount = 0, litAge = null, current = false, bar = null }) {
    const events = marks?.marks ?? [];
    const chips = marks?.chips ?? [];
    // The bar alone is the bar's own element (no wrapper), as before.
    const face = WorkflowJoinBarFace({ join, node, selected, onSelect, litCount, litAge, current, bar });
    if (!events.length && !chips.length) return face;
    // R1, R2: the parallel step's routes leave its join bar, so its boundary events and end chips sit on and beside the bar.
    // Owner, 2026-11-26 20:03 PST: at the bar's right end (`--ps-join-bar-inset`: from the box's right edge to it).
    const inset = bar && Number.isFinite(join?.width) ? join.width - bar.left - bar.width : null;
    return h("div", { className: `ps-workflow-step is-join${selected ? " is-selected" : ""}`,
        ...(inset !== null ? { style: { "--ps-join-bar-inset": `${inset}px` } } : {}) }, face,
        events.map(mark => h(WorkflowHandlerMark, { key: mark.key, mark })),
        chips.length ? h(WorkflowChips, { chips }) : null);
}

function WorkflowJoinBarFace({ join, node = null, selected = false, onSelect, litCount = 0, litAge = null, current = false, bar = null }) {
    const view = node?.joinBar ?? null;
    const rule = `${view?.label ?? "Joins when all succeed"}${view?.stateText ? ` · ${view.stateText}` : ""}`;
    // Owner decision join-k-of-n: its own time limit, which the engine enforces; B5: said short on the bar ("⋈ all ended · 24 h").
    const limit = view?.limit ?? null;
    const short = workflowJoinShort(node, view);
    // In a run, a join the run did not reach is faded, as a step is.
    const notReached = node?.hasRun && node.phase === "not-reached";
    return h("div", {
        className: `ps-workflow-join is-${view?.state ?? "idle"}${notReached ? " is-not-reached" : ""}${selected ? " is-selected" : ""}`,
        "data-join": join.parallel, role: "button", tabIndex: 0,
        // Replay: lit while a transition that left the parallel step is among the last four (workflowJoinShown).
        ...litAttributes(litCount, litAge), ...(current ? { "data-current": "true" } : {}),
        "aria-label": `${join.parallel}: ${rule}${limit ? ` · ${limit.text}` : ""}. Inspect ${join.parallel}`, "aria-pressed": selected,
        title: `${rule}. The nodes after ${join.parallel} start from here.${limit ? ` ${limit.title}` : ""}`,
        onClick: () => onSelect(join.parallel),
        onKeyDown: event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(join.parallel); }
        },
    },
    // Owner, 2026-11-26 20:03 PST: the bar where the incoming lines end (`bar`: its place in the box), a stem from its middle
    // down to where the line after it leaves, and the words under the bar, left of the stem, where no line crosses them.
    h("span", { className: "ps-workflow-join-bar", "aria-hidden": true, ...(bar ? { style: { left: bar.left, width: bar.width } } : {}) }),
    h("span", { className: "ps-workflow-join-stem", "aria-hidden": true }),
    h("span", { className: "ps-workflow-join-rule" }, short));
}

/**
 * What decides the graph's layout, as one string: the steps and their routes, the first step and the revision. A run's
 * progress changes the steps' states, never this, so the layout is computed (and a view without a remembered one fitted)
 * only when the graph itself changes.
 */
export function workflowGraphKey(definition) {
    const states = Array.isArray(definition?.states) ? definition.states : [];
    // A parallel step's body steps decide its branch box (owner batch 7, H2); every other step's entry is as before.
    return JSON.stringify([definition?.revision ?? null, definition?.initial ?? null, definition?.catchAll ?? null,
        states.map(node => [node?.id, node?.type, workflowGraphNodeHeight(node), node?.next ?? null, node?.outcomes ?? null, node?.routeNotes ?? null,
            node?.outcome ?? null, node?.namedBranches ?? null,
            node?.type === "parallel" && Array.isArray(node.body?.states) ? [node.body.initial ?? null, node.body.states] : node?.body?.initial ?? null])]);
}

/**
 * A parallel step's branch box as drawn now (B1, B3): its step's view, selection and lit state, and its lanes' pills
 * with each lane's state at the moment shown. Its error routes into ends are on its join bar. Pure but for building props.
 */
export function workflowGroupProps(layout, group, byId, { selected = null, lit = null } = {}) {
    const shown = lit?.nodes?.get(group.parallel) ?? null;
    const lanes = new Map((layout.lanes ?? new Map()).get?.(group.parallel)?.map?.(lane => [lane.name, lane.members]) ?? []);
    const members = name => lanes.get(name) ?? (group.members ?? []).filter(id => byId.get(id)?.branchName === name);
    return { group, node: byId.get(group.parallel) ?? null, selected: group.parallel === selected?.id,
        litCount: shown?.count ?? 0, litAge: shown?.age ?? null, current: lit?.current === group.parallel,
        pills: (group.lanePills ?? []).map(pill => workflowLanePill(group.parallel, pill, members(pill.name), byId, lit)) };
}

/** The plain picture: the layout at its own size, scrolled when it is larger than the graph's area. */
function WorkflowGraphStatic({ layout, nodes, selected, select, lit = null, hoverEnd = null, allHandlers = false, handlerStep }) {
    const markerId = `wf-arrow-${React.useId().replace(/:/g, "")}`;
    const byId = new Map(nodes.map(node => [node.id, node]));
    // Owner, 2026-11-26 20:03 PST: a join's error arrows leave its bar's right end, where its mark is drawn.
    const bars = new Map([...(layout.joins?.values() ?? [])].map(join => [join.id, workflowJoinBarSpan(layout, join)]));
    const boxes = new Map([...layout.positions, ...[...(layout.joins?.values() ?? [])].map(join => [join.id, workflowJoinBarBox(join, bars.get(join.id))]),
        ...[...(layout.groups?.values() ?? [])].map(group => [group.id, group])]);
    const arrows = workflowHandlerArrows(layout, boxes, { selectedId: handlerStep === undefined ? selected?.id ?? null : handlerStep,
        all: allHandlers, hoverEnd, lit });
    const slot = (box, className, child, key) => h("div", { key, className, style: { left: box.x, top: box.y, width: box.width, height: box.height } }, child);
    return h("div", { className: "ps-workflow-graph-static" },
        h("div", { className: "ps-workflow-graph-canvas", style: { width: layout.width, height: layout.height } },
            // Branch boxes under the edges and steps, join bars over them (owner batch 7, H2).
            [...(layout.groups?.values() ?? [])].map(group => slot(group, "ps-workflow-group-slot",
                h(WorkflowGroupBox, { ...workflowGroupProps(layout, group, byId, { selected, lit, hoverEnd }), onSelect: select }), group.id)),
            h("svg", { className: "ps-workflow-graph-edges", width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}` },
                h("defs", null,
                    h("marker", { id: markerId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" },
                        h("path", { d: "M0 0L10 5L0 10z", fill: "currentColor" }))),
                layout.edges.map(edge => h(WorkflowEdgeShape, { key: edge.key, edge, markerEnd: `url(#${markerId})`,
                    ...workflowEdgeShown(edge, lit, hoverEnd), flowing: lit?.flow === true }))),
            nodes.map(node => {
                const box = layout.positions.get(node.id);
                const shown = lit?.nodes?.get(node.id) ?? null;
                return box ? h("div", { key: node.id, className: "ps-workflow-node-slot", style: { left: box.x, top: box.y, width: box.width, height: box.height } },
                    h(WorkflowStepCard, { node, selected: node.id === selected?.id, onSelect: select, litCount: shown?.count ?? 0, litAge: shown?.age ?? null,
                        current: lit?.current === node.id, marks: workflowStepMarks(layout, node.id, lit, hoverEnd) })) : null;
            }),
            [...(layout.joins?.values() ?? [])].map(join => slot(join, "ps-workflow-join-slot",
                h(WorkflowJoinBar, { join, node: byId.get(join.parallel) ?? null, selected: join.parallel === selected?.id, onSelect: select,
                    marks: workflowStepMarks(layout, join.parallel, lit, hoverEnd), bar: bars.get(join.id),
                    ...workflowJoinShown(layout, join.parallel, lit) }), join.id)),
            h(WorkflowHandlerArrows, { arrows })));
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
 * shown and its step (workflowLitTransitions), drawn the same by both renderers. `mobile`: the tab's mobile layout; with
 * the phone query (PHONE_MEDIA_QUERY, as the tab's own) the flow is fitted clear of its controls (UXP-TL-02). UX round 1:
 * `reveal`, the id of the step the person chose, kept in view. On a phone React Flow's controls sit in a column beside the
 * graph, so they never cover a step.
 */
export function WorkflowGraph({ definition, nodes, selected, select, scope = null, viewport = null, onViewport = null, places = null, onPlaces = null,
    mode = "normal", lit = null, mobile = false, reveal = null, revealAt = 0, handlerStep }) {
    // UX round 1 (G4): the step whose error handlers' arrows show; when not given, the step selected (as before).
    const arrowsFor = handlerStep === undefined ? selected?.id ?? null : handlerStep;
    const key = workflowGraphKey(definition);
    const phone = useMediaQuery(PHONE_MEDIA_QUERY) && mobile;
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
    // R2: the end hovered (or focused) in the Ends row; every way into it lights. R1: Show all handlers.
    const [hoverEnd, setHoverEnd] = React.useState(null);
    const [allHandlers, setAllHandlers] = React.useState(false);
    const hasHandlers = (layout.handlers?.size ?? 0) > 0;
    // UX round 1 (P1): on a phone, React Flow's controls go to a column beside the graph (`dock`), never over a step. The
    // flow's parent is the same at every width, so crossing the phone width never mounts it again.
    const [dock, setDock] = React.useState(null);
    const flow = Flow ? h(Flow, { key: `${scope ?? ""}\u0000${key}`, layout, nodes, selected, select, viewport: remembered, onViewport: report, places, onPlaces,
        mode, lit, phone, hoverEnd, allHandlers, reveal, revealAt, dock: phone ? dock : null, handlerStep: arrowsFor }) : null;
    return h("div", { className: "ps-workflow-graph", role: "group", "aria-label": "Workflow graph", "data-renderer": Flow ? "flow" : "static" },
        definition.notes ? h("details", { className: "ps-workflow-definition-notes" },
            h("summary", null, "Definition notes"), h("div", { className: "ps-workflow-notes" }, definition.notes)) : null,
        h(WorkflowEndsRow, { ends: layout.ends, reached: lit?.endReached ?? null, run: Boolean(lit), hoverEnd, onHover: setHoverEnd, select,
            handlers: hasHandlers ? { all: allHandlers, onToggle: () => setAllHandlers(value => !value) } : null }),
        flow ? h("div", { className: "ps-workflow-graph-body" }, flow, phone ? h("div", { ref: setDock, className: "ps-workflow-graph-dock" }) : null)
            : h(WorkflowGraphStatic, { layout, nodes, selected, select, lit, hoverEnd, allHandlers, handlerStep: arrowsFor }));
}

/**
 * R2: the run's ends, each once, with how many ways lead in (lines, chips and error handlers). Hover or focus lights every
 * way in; a click inspects the end. In a run's view the end it reached (as of the moment shown) is lit, the others
 * dimmed. R1: `handlers`, the Show all handlers toggle ({ all, onToggle }), when the graph has any.
 */
export function WorkflowEndsRow({ ends, reached = null, run = false, hoverEnd = null, onHover = () => {}, select = () => {}, handlers = null }) {
    // UX round 1 (G2, P3): the row is one line that scrolls sideways; while ends are out of sight a "‹" or "+N ›" cue at its
    // edge says so and scrolls to them.
    const row = React.useRef(null);
    const [hidden, setHidden] = React.useState({ left: 0, right: 0 });
    React.useEffect(() => {
        const element = row.current;
        if (!element) return undefined;
        const check = () => {
            const from = element.scrollLeft, to = element.scrollLeft + element.clientWidth;
            let left = 0, right = 0;
            for (const chip of element.querySelectorAll("[data-end]")) {
                if (chip.offsetLeft < from - 1) left += 1;
                else if (chip.offsetLeft + chip.offsetWidth > to + 1) right += 1;
            }
            setHidden(current => (current.left === left && current.right === right ? current : { left, right }));
        };
        check();
        element.addEventListener("scroll", check, { passive: true });
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
        observer?.observe(element);
        return () => { element.removeEventListener("scroll", check); observer?.disconnect(); };
    // Measured again when the ends, or the one reached (drawn bolder), change, not only the row's own size.
    }, [Array.isArray(ends) ? ends.map(end => end?.id).join("\u0000") : "", reached, run, Boolean(handlers)]);
    if (!Array.isArray(ends) || !ends.length) return null;
    const scroll = by => row.current?.scrollBy?.({ left: by * row.current.clientWidth * 0.8, behavior: "smooth" });
    return h("div", { ref: row, className: `ps-workflow-ends${hidden.left || hidden.right ? " has-more" : ""}`, role: "group", "aria-label": "Ends" },
        hidden.left ? h("button", { type: "button", className: "ps-workflow-ends-more is-left", "data-action": "ends-back",
            "aria-label": `${hidden.left} more end${hidden.left === 1 ? "" : "s"} to the left`, title: "Show the ends to the left", onClick: () => scroll(-1) }, "‹")
            : null,
        handlers ? h("button", { type: "button", className: `ps-workflow-end is-toggle${handlers.all ? " is-on" : ""}`, "aria-pressed": handlers.all,
            "data-action": "show-handlers", title: "Show every error route into an end at once, each as a dashed arrow to a ghost of its end. Without it, select a step to see where its errors go.",
            onClick: handlers.onToggle }, "Show all handlers") : null,
        h("span", { className: "ps-workflow-ends-label" }, "Ends"),
        ends.map(end => {
            const ways = end.keys.length;
            const waysText = `${ways} way${ways === 1 ? "" : "s"} in`;
            return h("button", { type: "button", key: end.id, "data-end": end.id,
                className: `ps-workflow-end is-${end.outcome}${reached === end.id ? " is-reached" : run ? " is-dim" : ""}${hoverEnd === end.id ? " is-hover" : ""}`,
                title: `${end.id}: ends the run as ${end.outcome}; ${waysText}${reached === end.id ? "; the run ended here" : ""}. Point at it to light every way in.`,
                onMouseEnter: () => onHover(end.id), onMouseLeave: () => onHover(null), onFocus: () => onHover(end.id), onBlur: () => onHover(null),
                onClick: () => select(end.id) },
            h("span", { className: "ps-workflow-end-mark", "aria-hidden": "true" }, end.box ? "●" : "⏹"), ` ${end.id} · ${waysText}`);
        }),
        hidden.right ? h("button", { type: "button", className: "ps-workflow-ends-more is-right", "data-action": "ends-more",
            "aria-label": `${hidden.right} more end${hidden.right === 1 ? "" : "s"}`, title: "Show the other ends", onClick: () => scroll(1) }, `+${hidden.right} ›`)
            : null);
}
