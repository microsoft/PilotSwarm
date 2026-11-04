import React from "react";
import { Background, BackgroundVariant, Handle, MarkerType, Panel, Position, ReactFlow, getViewportForBounds, useReactFlow, useStore } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { WorkflowEdgeShape, WorkflowStepCard } from "./workflow-graph.js";
import { WorkflowToolButton } from "./workflow-tool-button.js";

const h = React.createElement;

/**
 * The workflow graph drawn by React Flow (owner batch 5, g-02, g-04, g-05), loaded on first use by WorkflowGraph. Read
 * only: steps cannot be dragged, connected, selected by React Flow or deleted, and edges cannot be changed; a step is
 * selected by its own button (WorkflowStepCard), as before. Steps sit where layoutWorkflowGraphTB put them and edges are
 * its curves, so React Flow only draws, zooms and moves the view.
 *
 * Controls (bottom left): Zoom in, Zoom out, Fit to screen, and Move the graph (the hand). With the hand on (the
 * default) dragging the background moves the graph and pinching or the wheel zooms it; with it off the graph stays still
 * and the wheel and a finger scroll the page. A drag that starts on a step never moves the graph.
 *
 * The view is fitted from the layout's own bounds (getViewportForBounds + setViewport), not by React Flow's fitView,
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
const MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16 };
/** A step node's wrapper takes the pointer: React Flow would set pointer-events none on a node it may not select or drag. */
const NODE_STYLE = Object.freeze({ pointerEvents: "all" });

/** The view that shows the whole graph (`layout` from layoutWorkflowGraphTB) centred in an area of `area` pixels. */
export function workflowFitViewport(layout, area) {
    return getViewportForBounds({ x: 0, y: 0, width: layout.width, height: layout.height }, area.width, area.height, MIN_ZOOM, FIT_MAX_ZOOM, FIT_PADDING);
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

function StepEdge({ data, markerEnd }) {
    return h(WorkflowEdgeShape, { edge: data.edge, markerEnd });
}

// Stable for React Flow: new objects on each render would make it re-create every step and edge.
const NODE_TYPES = { workflowStep: StepNode };
const EDGE_TYPES = { workflowEdge: StepEdge };
const panZoomReady = state => Boolean(state.panZoom);

/** A remembered view React Flow can start from: finite x and y, and a zoom it allows. */
export function workflowViewportOf(value) {
    if (!value || typeof value !== "object") return null;
    const { x, y, zoom } = value;
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM ? { x, y, zoom } : null;
}

/** The controls, and the one automatic fit: `fitted` is true once the view was fitted or started from a remembered one. */
function GraphView({ layout, area, fitted, hand, onHand }) {
    const flow = useReactFlow();
    const ready = useStore(panZoomReady);
    const fit = React.useCallback(options => {
        if (!area) return;
        flow.setViewport(workflowFitViewport(layout, area), options);
    }, [flow, layout, area]);
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
            onClick: () => onHand(!hand) }));
}

/**
 * `layout` from layoutWorkflowGraphTB; `nodes` the step views; `select(id)` selects a step (and may open its details);
 * `viewport` the remembered view this flow starts from (read when it mounts), `onViewport(view)` told each view once it
 * settles.
 */
export function WorkflowFlow({ layout, nodes, selected, select, viewport = null, onViewport = null }) {
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
    // The same step objects while nothing about the steps changed, so React Flow keeps what it measured; the selection
    // handler is read through a ref, as the pane hands a new one on every render.
    const selectRef = React.useRef(select);
    selectRef.current = select;
    const onSelect = React.useCallback(id => selectRef.current(id), []);
    const selectedId = selected?.id ?? null;
    const flowNodes = React.useMemo(() => nodes.flatMap(node => {
        const box = layout.positions.get(node.id);
        if (!box) return [];
        return [{
            id: node.id, type: "workflowStep", position: { x: box.x, y: box.y }, width: box.width, height: box.height,
            data: { node, selected: node.id === selectedId, onSelect },
            draggable: false, connectable: false, selectable: false, deletable: false, focusable: false,
            // A click on a step is the step's own (its card's button); a drag that starts on it does not move the graph.
            className: "nopan", style: NODE_STYLE,
            // Where its edges meet it, given as well as measured, so edges draw before the steps are measured and stay
            // drawn when a run's progress hands React Flow new step objects.
            handles: [
                { id: null, type: "target", position: Position.Top, x: box.width / 2, y: 0, width: 1, height: 1 },
                { id: null, type: "source", position: Position.Bottom, x: box.width / 2, y: box.height, width: 1, height: 1 },
            ],
        }];
    }), [layout, nodes, selectedId, onSelect]);
    const flowEdges = React.useMemo(() => layout.edges.map((edge, index) => ({
        id: `e${index}`, source: edge.from, target: edge.to, type: "workflowEdge", data: { edge }, markerEnd: MARKER,
        selectable: false, deletable: false, focusable: false, reconnectable: false,
    })), [layout]);
    return h(ReactFlow, {
        ref: hostRef,
        nodes: flowNodes, edges: flowEdges, nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES,
        nodesDraggable: false, nodesConnectable: false, nodesFocusable: false, edgesFocusable: false, elementsSelectable: false,
        edgesReconnectable: false, deleteKeyCode: null, selectionKeyCode: null, multiSelectionKeyCode: null, selectionOnDrag: false,
        panActivationKeyCode: null, zoomActivationKeyCode: null, disableKeyboardA11y: true, autoPanOnNodeFocus: false,
        panOnDrag: hand, zoomOnScroll: hand, zoomOnPinch: hand, panOnScroll: false, zoomOnDoubleClick: false, preventScrolling: hand,
        minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
        ...(start ? { defaultViewport: start } : {}),
        // Every settled view, the person's or a button's, so it can be restored exactly.
        onMoveEnd: (_event, view) => { onViewport?.({ x: view.x, y: view.y, zoom: view.zoom }); },
        defaultMarkerColor: null,
        className: `ps-workflow-flow${hand ? " is-hand" : " is-still"}`,
    },
    h(Background, { variant: BackgroundVariant.Dots, gap: 18, size: 1 }),
    h(GraphView, { layout, area, fitted, hand, onHand: setHand }));
}
