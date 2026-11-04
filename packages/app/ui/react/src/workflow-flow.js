import React from "react";
import {
    Background, BackgroundVariant, Handle, MarkerType, Panel, Position, ReactFlow, getBezierPath, getViewportForBounds, useReactFlow, useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { WorkflowEdgeShape, WorkflowStepCard } from "./workflow-graph.js";
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
 */

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
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

/** The box around every step at its place (`moved`: Map id -> { x, y } for the boxes moved), or the layout's own box. */
export function workflowGraphBounds(layout, moved = null) {
    if (!moved?.size) return { x: 0, y: 0, width: layout.width, height: layout.height };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [id, box] of layout.positions) {
        const at = moved.get(id) ?? box;
        left = Math.min(left, at.x);
        top = Math.min(top, at.y);
        right = Math.max(right, at.x + box.width + (moved.has(id) ? LOOP_REACH_PX / 2 : 0));
        bottom = Math.max(bottom, at.y + box.height);
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

/** The saved places of the steps this layout has, as Map id -> { x, y }. */
function placesOf(places, layout) {
    const moved = new Map();
    if (!places || typeof places !== "object") return moved;
    for (const [id, place] of Object.entries(places)) {
        if (!layout.positions.has(id) || !Array.isArray(place) || place.length !== 2) continue;
        const [x, y] = place;
        if (Number.isFinite(x) && Number.isFinite(y)) moved.set(id, { x, y });
    }
    return moved;
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

/**
 * One edge: the automatic route while neither box it joins has moved; otherwise a smooth curve from the source's bottom
 * to the target's top as React Flow places them now (f-03), or, for a step's own loop, a curve out beside its right edge.
 */
function StepEdge({ data, markerEnd, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
    const edge = data.edge;
    if (!data.moved) return h(WorkflowEdgeShape, { edge, markerEnd });
    if (edge.from === edge.to) {
        const path = `M${sourceX},${sourceY} C${sourceX + LOOP_REACH_PX},${sourceY + 60} ${targetX + LOOP_REACH_PX},${targetY - 60} ${targetX},${targetY}`;
        return h(WorkflowEdgeShape, { edge: { ...edge, path, labelX: sourceX + LOOP_REACH_PX * 0.75, labelY: (sourceY + targetY) / 2 }, markerEnd });
    }
    const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
    return h(WorkflowEdgeShape, { edge: { ...edge, path, labelX, labelY }, markerEnd });
}

// Stable for React Flow: new objects on each render would make it re-create every step and edge.
const NODE_TYPES = { workflowStep: StepNode };
const EDGE_TYPES = { workflowEdge: StepEdge };
const panZoomReady = state => Boolean(state.panZoom);

/** The controls, and the one automatic fit: `fitted` is true once the view was fitted or started from a remembered one. */
function GraphView({ bounds, area, fitted, hand, onHand, onReset }) {
    const flow = useReactFlow();
    const ready = useStore(panZoomReady);
    const fit = React.useCallback(options => {
        if (!area) return;
        flow.setViewport(workflowFitViewport(bounds, area), options);
    }, [flow, bounds, area]);
    React.useEffect(() => {
        if (!ready || !area || fitted.current) return;
        fitted.current = true;
        fit();
    }, [ready, area, fit, fitted]);
    const zoom = by => {
        if (by > 0) flow.zoomIn({ duration: ZOOM_DURATION_MS });
        else flow.zoomOut({ duration: ZOOM_DURATION_MS });
    };
    return h(Panel, { position: "bottom-left", className: "ps-workflow-graph-controls", role: "group", "aria-label": "Graph view" },
        h(WorkflowToolButton, { label: "Zoom in", glyph: "zoom-in", onClick: () => zoom(1) }),
        h(WorkflowToolButton, { label: "Zoom out", glyph: "zoom-out", onClick: () => zoom(-1) }),
        h(WorkflowToolButton, { label: "Fit to screen", glyph: "fit", onClick: () => fit({ duration: FIT_DURATION_MS }) }),
        h(WorkflowToolButton, { label: "Move the graph", glyph: "hand", "aria-pressed": hand,
            title: hand ? "Drag the background to move the graph; pinch or scroll to zoom. Turn it off to keep the graph still."
                : "The graph stays still. Turn it on to move it by dragging and to zoom by pinching or scrolling.",
            onClick: () => onHand(!hand) }),
        onReset ? h(WorkflowToolButton, { label: "Reset layout", glyph: "reset", title: "Put every step back in its automatic place.", onClick: onReset }) : null);
}

/**
 * `layout` from layoutWorkflowGraphTB; `nodes` the step views; `select(id)` selects a step (and may open its details);
 * `viewport` the remembered view this flow starts from (read when it mounts), `onViewport(view)` told each view once it
 * settles; `places` the person's saved step places and `onPlaces(places | null)` told them at the end of each drag.
 */
export function WorkflowFlow({ layout, nodes, selected, select, viewport = null, onViewport = null, places = null, onPlaces = null }) {
    const [hand, setHand] = React.useState(true);
    const hostRef = React.useRef(null);
    const [start] = React.useState(() => workflowViewportOf(viewport));
    const fitted = React.useRef(start !== null);
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
    React.useEffect(() => {
        if (firstSaved.current) { firstSaved.current = false; return; }
        setMoved(placesOf(places, layout));
    }, [savedKey, layout]);
    const latest = React.useRef({ moved, layout, onPlaces });
    latest.current = { moved, layout, onPlaces };
    // The selection handler is read through a ref, as the pane hands a new one on every render.
    const selectRef = React.useRef(select);
    selectRef.current = select;
    const onSelect = React.useCallback(id => selectRef.current(id), []);
    const selectedId = selected?.id ?? null;
    // The same step objects while nothing about a step changed, so React Flow keeps what it measured and a drag re-creates
    // only the box that moves.
    const made = React.useRef(new Map());
    const flowNodes = React.useMemo(() => {
        const next = new Map();
        const list = nodes.flatMap(node => {
            const box = layout.positions.get(node.id);
            if (!box) return [];
            const at = moved.get(node.id) ?? box;
            const isSelected = node.id === selectedId;
            const prior = made.current.get(node.id);
            if (prior && prior.data.node === node && prior.data.selected === isSelected && prior.data.onSelect === onSelect
                && prior.position.x === at.x && prior.position.y === at.y && prior.width === box.width && prior.height === box.height) {
                next.set(node.id, prior);
                return [prior];
            }
            const flowNode = {
                id: node.id, type: "workflowStep", position: { x: at.x, y: at.y }, width: box.width, height: box.height,
                data: { node, selected: isSelected, onSelect },
                draggable: true, connectable: false, selectable: false, deletable: false, focusable: false,
                // A press on a step is the step's own (a click selects it, a drag moves it); it never moves the graph.
                className: "nopan", style: NODE_STYLE,
                // Where its edges meet it, given as well as measured, so edges draw before the steps are measured and stay
                // drawn when a run's progress hands React Flow new step objects.
                handles: [
                    { id: null, type: "target", position: Position.Top, x: box.width / 2, y: 0, width: 1, height: 1 },
                    { id: null, type: "source", position: Position.Bottom, x: box.width / 2, y: box.height, width: 1, height: 1 },
                ],
            };
            next.set(node.id, flowNode);
            return [flowNode];
        });
        made.current = next;
        return list;
    }, [layout, nodes, selectedId, onSelect, moved]);
    // An edge is redrawn as a curve once a box it joins has moved; which ones have is all that changes it.
    const movedIds = [...moved.keys()].sort().join("\u0000");
    const flowEdges = React.useMemo(() => layout.edges.map((edge, index) => ({
        id: `e${index}`, source: edge.from, target: edge.to, type: "workflowEdge", data: { edge, moved: moved.has(edge.from) || moved.has(edge.to) },
        markerEnd: MARKER, selectable: false, deletable: false, focusable: false, reconnectable: false,
    })), [layout, movedIds]);
    // A box follows the pointer while it is dragged (the flow is controlled: React Flow says where, this keeps it).
    const onNodesChange = React.useCallback(changes => {
        const placed = changes.filter(change => change?.type === "position" && change.position);
        if (!placed.length) return;
        setMoved(current => {
            const next = new Map(current);
            for (const change of placed) next.set(change.id, { x: Math.round(change.position.x), y: Math.round(change.position.y) });
            return next;
        });
    }, []);
    // Saved once, at the end of a drag: every moved box this graph has, the one just dropped where it was dropped.
    const onNodeDragStop = React.useCallback((_event, _node, dropped) => {
        const { moved: current, layout: shown, onPlaces: tell } = latest.current;
        const steps = {};
        for (const [id, at] of current) steps[id] = [at.x, at.y];
        for (const item of Array.isArray(dropped) ? dropped : []) {
            if (item?.id && item.position) steps[item.id] = [Math.round(item.position.x), Math.round(item.position.y)];
        }
        const kept = Object.fromEntries(Object.entries(steps).filter(([id]) => shown.positions.has(id)));
        tell?.(Object.keys(kept).length ? kept : null);
    }, []);
    const reset = React.useCallback(() => {
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
        // Every settled view, the person's or a button's, so it can be restored exactly.
        onMoveEnd: (_event, view) => { onViewport?.({ x: view.x, y: view.y, zoom: view.zoom }); },
        defaultMarkerColor: null,
        className: `ps-workflow-flow${hand ? " is-hand" : " is-still"}`,
    },
    h(Background, { variant: BackgroundVariant.Dots, gap: 18, size: 1 }),
    h(GraphView, { bounds, area, fitted, hand, onHand: setHand, onReset: moved.size ? reset : null }));
}
