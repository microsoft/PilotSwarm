import React from "react";
import {
    Background, BackgroundVariant, Handle, MarkerType, Panel, Position, ReactFlow, getBezierPath, getViewportForBounds, useReactFlow, useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { WorkflowEdgeShape, WorkflowGroupBox, WorkflowJoinBar, WorkflowStepCard } from "./workflow-graph.js";
import { workflowGraphPlaces, workflowPlaceKey } from "../../core/src/workflow-graph-layout.js";
import { WorkflowToolButton } from "./workflow-tool-button.js";

const h = React.createElement;

/**
 * The workflow graph drawn by React Flow (owner batch 5, g-02, g-04, g-05), loaded on first use by WorkflowGraph. Steps
 * cannot be connected, selected by React Flow or deleted, and edges cannot be changed; a step is selected by its own
 * button (WorkflowStepCard), as before. Steps start where layoutWorkflowGraphTB put them and edges are its curves.
 *
 * Batch 6 (f-03): a step box can be dragged to a new place, with the hand on or off (the hand only moves and zooms the
 * view). A press that moves less than DRAG_THRESHOLD_PX is a click and selects the step; a longer drag moves the box and
 * does not select it (d3-drag swallows the click that ends a drag). While a box moves, the edges that touch it follow
 * it as smooth curves between the boxes' bottom and top (getBezierPath), their label at the curve's middle, and its own
 * loop beside it; edges between boxes that never moved keep the automatic route. The places are given by `places`
 * ({ stepId: [x, y] }, the person's saved ones) and told once, at the end of each drag, to `onPlaces` (null once Reset
 * layout puts every box back); a step the graph no longer has is left out, a new step takes its automatic place.
 *
 * Controls (bottom left): Zoom in, Zoom out, Fit to screen, Move the graph (the hand) and, once a box has moved, Reset
 * layout. With the hand on (the default) dragging the background moves the graph and pinching or the wheel zooms it;
 * with it off the graph stays still and the wheel and a finger scroll the page.
 *
 * The view is fitted from the boxes' own bounds (getViewportForBounds + setViewport), not by React Flow's fitView,
 * which waits for every step to be measured: our steps are given with their sizes, and a run's progress hands React
 * Flow new step objects, which drops what it measured, so a queued fitView could wait for ever (batch 5 T8).
 *
 * Batch 6 (f-06): the view is fitted once, when the graph is first shown with a size and there is no remembered view.
 * After that a change of the area's size (the side pane opened, closed or resized, the window resized, the tab shown
 * again) keeps the zoom and keeps the graph's top-left where it was; only Fit to screen fits again. Each change of the
 * view (x, y, zoom), the person's or a button's, is reported once it ends (`onViewport`), and the remembered view
 * (`viewport`) is where a new flow starts, so switching tabs, panels or sessions and back restores it exactly. A new
 * graph (definition or revision) mounts a new flow; without a remembered view of its own it is fitted once. A run's
 * progress never moves the view.
 *
 * Owner, 2026-11-06T19:40Z (F8): a change of display mode (normal, zen, full screen: `mode`) fits the view again, while
 * the person has not panned or zoomed it since it was last fitted (by the first fit, Fit to screen or a mode change). The
 * remembered view says whether it was still the fitted one and in which mode, so a flow mounted in another mode from a
 * fitted view is fitted again too. A view the person moved is kept, as f-06 keeps it.
 *
 * Owner batch 7 (H2): a parallel step's branch box is a React Flow parent node; its steps and its join bar are its
 * children, placed relative to it, so dragging the box by its label row moves them all. A step inside it can still be
 * dragged on its own; its place is saved relative to its box ('<parallel id>/<step id>', workflowPlaceKey) and the box's
 * as it is. The join bar moves only with its box; a click on it selects the parallel step. An edge between two boxes of
 * one branch box that moved only as a whole keeps its route, moved with the box.
 */

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
/** F8: how long after a change of display mode the area's new size (measured as it settles) fits the view again. */
const MODE_REFIT_MS = 1000;
/** The fitted view never enlarges the steps past their own size, and leaves this share of the area around the graph. */
const FIT_MAX_ZOOM = 1;
const FIT_PADDING = 0.06;
const FIT_DURATION_MS = 200;
const ZOOM_DURATION_MS = 150;
/** A press on a step that moves less than this is a click; a longer one drags the box (f-03). */
const DRAG_THRESHOLD_PX = 4;
/** How far a moved step's own loop reaches out beside it, and the room it needs inside the fitted view. */
const LOOP_REACH_PX = 150;
const MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16 };
/** A step node's wrapper takes the pointer: React Flow would set pointer-events none on a node it may not select. */
const NODE_STYLE = Object.freeze({ pointerEvents: "all" });
/** A branch box takes the pointer only on its label row (CSS), so the graph is still moved by dragging inside it (H2). */
const GROUP_STYLE = Object.freeze({ pointerEvents: "none" });

/**
 * The box around every box at its place (`moved`: Map place key -> { x, y } for the boxes moved; workflowGraphPlaces),
 * or the layout's own box. A branch box counts its stack; a step moved on its own, room for its loop beside it.
 */
export function workflowGraphBounds(layout, moved = null) {
    if (!moved?.size) return { x: 0, y: 0, width: layout.width, height: layout.height };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const box of workflowGraphPlaces(layout, moved).values()) {
        const stack = box.stack ?? 0;
        left = Math.min(left, box.x);
        top = Math.min(top, box.y);
        right = Math.max(right, box.x + box.width + stack + (box.self && box.stack === undefined ? LOOP_REACH_PX / 2 : 0));
        bottom = Math.max(bottom, box.y + box.height + stack);
    }
    return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, width: layout.width, height: layout.height };
}

/** The view that shows the whole graph (`bounds`, from workflowGraphBounds) centred in an area of `area` pixels. */
export function workflowFitViewport(bounds, area) {
    return getViewportForBounds(bounds, area.width, area.height, MIN_ZOOM, FIT_MAX_ZOOM, FIT_PADDING);
}

/** A remembered view React Flow can start from: finite x and y, and a zoom it allows. */
export function workflowViewportOf(value) {
    if (!value || typeof value !== "object") return null;
    const { x, y, zoom } = value;
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM ? { x, y, zoom } : null;
}

/** The place keys of every box this layout lets a person move: its steps (workflowPlaceKey) and its branch boxes (H2). */
function placeKeysOf(layout) {
    const keys = new Set([...(layout.groups?.values() ?? [])].map(group => group.id));
    for (const id of layout.positions.keys()) keys.add(workflowPlaceKey(layout, id));
    return keys;
}

/** The saved places of the boxes this layout has, as Map place key -> { x, y }. */
function placesOf(places, layout) {
    const moved = new Map();
    if (!places || typeof places !== "object") return moved;
    const keys = placeKeysOf(layout);
    for (const [key, place] of Object.entries(places)) {
        if (!keys.has(key) || !Array.isArray(place) || place.length !== 2) continue;
        const [x, y] = place;
        if (Number.isFinite(x) && Number.isFinite(y)) moved.set(key, { x, y });
    }
    return moved;
}

/**
 * How an edge is drawn now (H2): null, its automatic route; `{ offset }`, that route moved with the branch box both its
 * boxes sit in, when only the box moved; `{ curve: true }`, a curve between the boxes where they are.
 */
function edgeMotion(edge, shown) {
    const from = shown.get(edge.from), to = shown.get(edge.to);
    if (!from?.moved && !to?.moved) return null;
    if (from && to && from.parent && from.parent === to.parent && !from.self && !to.self) {
        const group = shown.get(from.parent);
        return { offset: [group.dx, group.dy] };
    }
    return { curve: true };
}

/** Whether React Flow can keep a node object it made: the same kind, parent, place, size and data. */
function sameNode(prior, next) {
    return Boolean(prior) && prior.type === next.type && prior.parentId === next.parentId && prior.position.x === next.position.x
        && prior.position.y === next.position.y && prior.width === next.width && prior.height === next.height
        && Object.keys(next.data).every(key => prior.data[key] === next.data[key]);
}

/**
 * One step: its card, and an invisible handle at its top (where edges arrive) and at its bottom (where they leave).
 * React Flow measures a node's handles from its DOM; a node with none is measured as having none, and its edges stop
 * being drawn (batch 5 T8). The handles cannot be connected or reached by the pointer.
 */
function StepNode({ data }) {
    return h(React.Fragment, null,
        h(Handle, { type: "target", position: Position.Top, isConnectable: false, className: "ps-workflow-handle" }),
        h(WorkflowStepCard, data),
        h(Handle, { type: "source", position: Position.Bottom, isConnectable: false, className: "ps-workflow-handle" }));
}

/** A parallel step's branch box (H2), with a handle at its top where the edge from the parallel step arrives. */
function GroupNode({ data }) {
    return h(React.Fragment, null,
        h(Handle, { type: "target", position: Position.Top, isConnectable: false, className: "ps-workflow-handle" }),
        h(WorkflowGroupBox, data));
}

/** A parallel step's join bar (H2): the branch ends arrive at its top, the parallel step's routes leave from its bottom. */
function JoinNode({ data }) {
    return h(React.Fragment, null,
        h(Handle, { type: "target", position: Position.Top, isConnectable: false, className: "ps-workflow-handle" }),
        h(WorkflowJoinBar, data),
        h(Handle, { type: "source", position: Position.Bottom, isConnectable: false, className: "ps-workflow-handle" }));
}

/**
 * One edge: the automatic route while neither box it joins has moved, or that route moved with the branch box both its
 * boxes are in (H2); otherwise a smooth curve from the source's bottom to the target's top as React Flow places them now
 * (f-03), or, for a step's own loop, a curve out beside its right edge.
 */
function StepEdge({ data, markerEnd, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
    const edge = data.edge;
    if (!data.motion) return h(WorkflowEdgeShape, { edge, markerEnd });
    if (data.motion.offset) {
        return h("g", { transform: `translate(${data.motion.offset[0]},${data.motion.offset[1]})` }, h(WorkflowEdgeShape, { edge, markerEnd }));
    }
    if (edge.from === edge.to) {
        const path = `M${sourceX},${sourceY} C${sourceX + LOOP_REACH_PX},${sourceY + 60} ${targetX + LOOP_REACH_PX},${targetY - 60} ${targetX},${targetY}`;
        return h(WorkflowEdgeShape, { edge: { ...edge, path, labelX: sourceX + LOOP_REACH_PX * 0.75, labelY: (sourceY + targetY) / 2 }, markerEnd });
    }
    const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
    return h(WorkflowEdgeShape, { edge: { ...edge, path, labelX, labelY }, markerEnd });
}

// Stable for React Flow: new objects on each render would make it re-create every step and edge.
const NODE_TYPES = { workflowStep: StepNode, workflowGroup: GroupNode, workflowJoin: JoinNode };
const EDGE_TYPES = { workflowEdge: StepEdge };
const panZoomReady = state => Boolean(state.panZoom);

/**
 * The controls, and the automatic fits: `fitted` is true once the view was fitted or started from a remembered one;
 * `touched` is true while the person has panned or zoomed since the last fit; `modeChanged` is when the display mode last
 * changed (F8): until MODE_REFIT_MS after it, the area's new size fits the view again unless it was touched.
 */
function GraphView({ bounds, area, fitted, touched, modeChanged, hand, onHand, onReset, refit = 0, onInteract = null }) {
    const flow = useReactFlow();
    const ready = useStore(panZoomReady);
    const fit = React.useCallback(options => {
        if (!area) return;
        touched.current = false;
        flow.setViewport(workflowFitViewport(bounds, area), options);
    }, [flow, bounds, area, touched]);
    React.useEffect(() => {
        if (!ready || !area || fitted.current) return;
        fitted.current = true;
        fit();
    }, [ready, area, fit, fitted]);
    // F8: the area's size after a change of display mode.
    React.useEffect(() => {
        if (!ready || !area || !fitted.current || touched.current) return;
        if (Date.now() - modeChanged.current < MODE_REFIT_MS) fit();
    }, [ready, area]);
    // UI-6: the one hydration fit, when the person's saved places arrived after the first fit (see WorkflowFlow).
    React.useEffect(() => {
        if (refit > 0 && ready && area) fit();
    }, [refit]);
    const zoom = by => {
        onInteract?.();
        touched.current = true;
        if (by > 0) flow.zoomIn({ duration: ZOOM_DURATION_MS });
        else flow.zoomOut({ duration: ZOOM_DURATION_MS });
    };
    return h(Panel, { position: "bottom-left", className: "ps-workflow-graph-controls", role: "group", "aria-label": "Graph view" },
        h(WorkflowToolButton, { label: "Zoom in", glyph: "zoom-in", onClick: () => zoom(1) }),
        h(WorkflowToolButton, { label: "Zoom out", glyph: "zoom-out", onClick: () => zoom(-1) }),
        h(WorkflowToolButton, { label: "Fit to screen", glyph: "fit", onClick: () => { onInteract?.(); fit({ duration: FIT_DURATION_MS }); } }),
        h(WorkflowToolButton, { label: "Move the graph", glyph: "hand", "aria-pressed": hand,
            title: hand ? "Drag the background to move the graph; pinch or scroll to zoom. Turn it off to keep the graph still."
                : "The graph stays still. Turn it on to move it by dragging and to zoom by pinching or scrolling.",
            onClick: () => onHand(!hand) }),
        onReset ? h(WorkflowToolButton, { label: "Reset layout", glyph: "reset", title: "Put every step back in its automatic place.", onClick: onReset }) : null);
}

/**
 * `layout` from layoutWorkflowGraphTB; `nodes` the step views; `select(id)` selects a step (and may open its details);
 * `viewport` the remembered view this flow starts from (read when it mounts), `onViewport(view)` told each view once it
 * settles; `places` the person's saved step places and `onPlaces(places | null)` told them at the end of each drag;
 * `mode` the display mode the graph is shown in ("normal", "zen" or "full"; F8).
 */
export function WorkflowFlow({ layout, nodes, selected, select, viewport = null, onViewport = null, places = null, onPlaces = null, mode = "normal" }) {
    const [hand, setHand] = React.useState(true);
    const hostRef = React.useRef(null);
    const [start] = React.useState(() => workflowViewportOf(viewport));
    // F8: a remembered view that was still the fitted one, taken in another display mode, is fitted again at once. A view
    // remembered without the word (taken before F8) counts as the person's.
    const [startFitted] = React.useState(() => start !== null && viewport?.fitted === true);
    const [startStale] = React.useState(() => startFitted && typeof viewport?.mode === "string" && viewport.mode !== mode);
    const fitted = React.useRef(start !== null && !startStale);
    const touched = React.useRef(start !== null && !startFitted);
    const modeNow = React.useRef(mode);
    const modeChanged = React.useRef(0);
    React.useLayoutEffect(() => {
        if (modeNow.current === mode) return;
        modeNow.current = mode;
        modeChanged.current = Date.now();
    }, [mode]);
    const [area, setArea] = React.useState(null);
    React.useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        const measure = () => {
            const { width, height } = host.getBoundingClientRect();
            if (width > 0 && height > 0) setArea(previous => previous && previous.width === width && previous.height === height ? previous : { width, height });
        };
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(host);
        return () => observer.disconnect();
    }, []);
    // The boxes' places: the saved ones, then each drag's. Saved places that change from elsewhere (Reset layout, the
    // profile read on another device) are taken as they are.
    const [moved, setMoved] = React.useState(() => placesOf(places, layout));
    const savedKey = JSON.stringify(places ?? null);
    const firstSaved = React.useRef(true);
    // UI-6: the person's saved places can arrive after the first fit (the profile read after the workflow's). Then, once,
    // while the person has not touched the view and none was remembered, the graph is fitted again to where the boxes are.
    const interacted = React.useRef(false);
    const hydrationFit = React.useRef(start === null);
    const [refit, setRefit] = React.useState(0);
    const onInteract = React.useCallback(() => { interacted.current = true; }, []);
    React.useEffect(() => {
        if (firstSaved.current) { firstSaved.current = false; return; }
        setMoved(placesOf(places, layout));
        if (hydrationFit.current && !interacted.current) {
            hydrationFit.current = false;
            setRefit(count => count + 1);
        }
    }, [savedKey, layout]);
    const latest = React.useRef({ moved, layout, onPlaces });
    latest.current = { moved, layout, onPlaces };
    // The selection handler is read through a ref, as the pane hands a new one on every render.
    const selectRef = React.useRef(select);
    selectRef.current = select;
    const onSelect = React.useCallback(id => selectRef.current(id), []);
    const selectedId = selected?.id ?? null;
    // Where every box is drawn now: the saved places, each drag's, and a branch box's steps and join bar with it (H2).
    const shown = React.useMemo(() => workflowGraphPlaces(layout, moved), [layout, moved]);
    // The same node objects while nothing about a box changed, so React Flow keeps what it measured and a drag re-creates
    // only the box that moves. A branch box comes before the boxes in it, as React Flow needs a parent first.
    const made = React.useRef(new Map());
    const flowNodes = React.useMemo(() => {
        const next = new Map();
        const byId = new Map(nodes.map(node => [node.id, node]));
        const keep = flowNode => {
            const prior = made.current.get(flowNode.id);
            const kept = sameNode(prior, flowNode) ? prior : flowNode;
            next.set(flowNode.id, kept);
            return kept;
        };
        const fixed = { connectable: false, selectable: false, deletable: false, focusable: false };
        const handles = (width, height, top = true, bottom = true) => [
            ...(top ? [{ id: null, type: "target", position: Position.Top, x: width / 2, y: 0, width: 1, height: 1 }] : []),
            ...(bottom ? [{ id: null, type: "source", position: Position.Bottom, x: width / 2, y: height, width: 1, height: 1 }] : []),
        ];
        const groups = [...(layout.groups?.values() ?? [])].flatMap(group => {
            const place = shown.get(group.id);
            if (!place) return [];
            return [keep({ id: group.id, type: "workflowGroup", position: { x: place.at.x, y: place.at.y }, width: group.width, height: group.height,
                data: { group, node: byId.get(group.parallel) ?? null }, ...fixed, draggable: true,
                // Dragged by its label row only; the rest of the box lets a press reach the graph.
                dragHandle: ".ps-workflow-group-head", className: "nopan", style: GROUP_STYLE, handles: handles(group.width, group.height, true, false) })];
        });
        const steps = nodes.flatMap(node => {
            const box = layout.positions.get(node.id);
            const place = shown.get(node.id);
            if (!box || !place) return [];
            return [keep({
                id: node.id, type: "workflowStep", position: { x: place.at.x, y: place.at.y }, width: box.width, height: box.height,
                ...(place.parent ? { parentId: place.parent } : {}),
                data: { node, selected: node.id === selectedId, onSelect },
                ...fixed, draggable: true,
                // A press on a step is the step's own (a click selects it, a drag moves it); it never moves the graph.
                className: "nopan", style: NODE_STYLE,
                // Where its edges meet it, given as well as measured, so edges draw before the steps are measured and stay
                // drawn when a run's progress hands React Flow new step objects.
                handles: handles(box.width, box.height),
            })];
        });
        const joins = [...(layout.joins?.values() ?? [])].flatMap(join => {
            const place = shown.get(join.id);
            if (!place) return [];
            return [keep({ id: join.id, type: "workflowJoin", position: { x: place.at.x, y: place.at.y }, width: join.width, height: join.height,
                ...(place.parent ? { parentId: place.parent } : {}),
                data: { join, node: byId.get(join.parallel) ?? null, selected: join.parallel === selectedId, onSelect },
                ...fixed, draggable: false, className: "nopan", style: NODE_STYLE, handles: handles(join.width, join.height) })];
        });
        made.current = next;
        return [...groups, ...steps, ...joins];
    }, [layout, nodes, selectedId, onSelect, shown]);
    // An edge keeps its route until a box it joins moves; how each edge is drawn is all that changes it.
    const motions = layout.edges.map(edge => edgeMotion(edge, shown));
    const motionKey = JSON.stringify(motions);
    const flowEdges = React.useMemo(() => layout.edges.map((edge, index) => ({
        id: `e${index}`, source: edge.from, target: edge.to, type: "workflowEdge", data: { edge, motion: motions[index] },
        markerEnd: MARKER, selectable: false, deletable: false, focusable: false, reconnectable: false,
    })), [layout, motionKey]);
    // A box follows the pointer while it is dragged (the flow is controlled: React Flow says where, this keeps it). A box
    // inside a branch box is told relative to it, and kept so (H2).
    const onNodesChange = React.useCallback(changes => {
        const placed = changes.filter(change => change?.type === "position" && change.position);
        if (!placed.length) return;
        const shownLayout = latest.current.layout;
        setMoved(current => {
            const next = new Map(current);
            for (const change of placed) {
                const key = workflowPlaceKey(shownLayout, change.id);
                if (key) next.set(key, { x: Math.round(change.position.x), y: Math.round(change.position.y) });
            }
            return next;
        });
    }, []);
    // Saved once, at the end of a drag: every moved box this graph has, the one just dropped where it was dropped.
    const onNodeDragStop = React.useCallback((_event, _node, dropped) => {
        const { moved: current, layout: shownLayout, onPlaces: tell } = latest.current;
        const steps = {};
        for (const [key, at] of current) steps[key] = [at.x, at.y];
        for (const item of Array.isArray(dropped) ? dropped : []) {
            const key = item?.id ? workflowPlaceKey(shownLayout, item.id) : null;
            if (key && item.position) steps[key] = [Math.round(item.position.x), Math.round(item.position.y)];
        }
        const keys = placeKeysOf(shownLayout);
        const kept = Object.fromEntries(Object.entries(steps).filter(([key]) => keys.has(key)));
        tell?.(Object.keys(kept).length ? kept : null);
    }, []);
    const reset = React.useCallback(() => {
        interacted.current = true;
        setMoved(new Map());
        latest.current.onPlaces?.(null);
    }, []);
    const bounds = React.useMemo(() => workflowGraphBounds(layout, moved), [layout, moved]);
    return h(ReactFlow, {
        ref: hostRef,
        nodes: flowNodes, edges: flowEdges, nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES,
        onNodesChange, onNodeDragStop,
        nodesDraggable: true, nodesConnectable: false, nodesFocusable: false, edgesFocusable: false, elementsSelectable: false,
        edgesReconnectable: false, deleteKeyCode: null, selectionKeyCode: null, multiSelectionKeyCode: null, selectionOnDrag: false,
        panActivationKeyCode: null, zoomActivationKeyCode: null, disableKeyboardA11y: true, autoPanOnNodeFocus: false,
        // A short press is a click (it selects the step and is not swallowed); past this distance it drags the box.
        nodeDragThreshold: DRAG_THRESHOLD_PX, nodeClickDistance: DRAG_THRESHOLD_PX,
        panOnDrag: hand, zoomOnScroll: hand, zoomOnPinch: hand, panOnScroll: false, zoomOnDoubleClick: false, preventScrolling: hand,
        minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
        ...(start ? { defaultViewport: start } : {}),
        // Every settled view, the person's or a button's, so it can be restored exactly. A move the person starts (it has
        // an event) or a box they drag counts as touching the view (UI-6).
        onMoveStart: event => { if (event) { interacted.current = true; touched.current = true; } },
        onNodeDragStart: () => { interacted.current = true; },
        // F8: with it, whether it is still the fitted view and the display mode it was taken in.
        onMoveEnd: (_event, view) => { onViewport?.({ x: view.x, y: view.y, zoom: view.zoom, fitted: !touched.current, mode: modeNow.current }); },
        defaultMarkerColor: null,
        className: `ps-workflow-flow${hand ? " is-hand" : " is-still"}`,
    },
    h(Background, { variant: BackgroundVariant.Dots, gap: 18, size: 1 }),
    h(GraphView, { bounds, area, fitted, touched, modeChanged, hand, onHand: setHand, onReset: moved.size ? reset : null, refit, onInteract }));
}
