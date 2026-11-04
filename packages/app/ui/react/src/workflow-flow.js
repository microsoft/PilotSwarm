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
 * Flow new step objects, which drops what it measured, so a queued fitView could wait for ever (batch 5 T8). The view
 * follows the graph's area (fitted when it first has a size, and again when the area changes size) until the person
 * moves or zooms it; Fit to screen fits it and follows again. A new graph (definition or revision) mounts a new flow,
 * fitted again; a run's progress never moves the view.
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

/** The controls, and the fitting: `follow` is true while the view keeps fitted to the graph's area. */
function GraphView({ layout, area, follow, hand, onHand }) {
    const flow = useReactFlow();
    const ready = useStore(panZoomReady);
    const fit = React.useCallback(options => {
        if (!area) return;
        flow.setViewport(workflowFitViewport(layout, area), options);
    }, [flow, layout, area]);
    React.useEffect(() => {
        if (ready && follow.current) fit();
    }, [ready, fit, follow]);
    const zoom = by => {
        follow.current = false;
        if (by > 0) flow.zoomIn({ duration: ZOOM_DURATION_MS });
        else flow.zoomOut({ duration: ZOOM_DURATION_MS });
    };
    return h(Panel, { position: "bottom-left", className: "ps-workflow-graph-controls", role: "group", "aria-label": "Graph view" },
        h(WorkflowToolButton, { label: "Zoom in", glyph: "zoom-in", onClick: () => zoom(1) }),
        h(WorkflowToolButton, { label: "Zoom out", glyph: "zoom-out", onClick: () => zoom(-1) }),
        h(WorkflowToolButton, { label: "Fit to screen", glyph: "fit",
            onClick: () => { follow.current = true; fit({ duration: FIT_DURATION_MS }); } }),
        h(WorkflowToolButton, { label: "Move the graph", glyph: "hand", "aria-pressed": hand,
            title: hand ? "Drag the background to move the graph; pinch or scroll to zoom. Turn it off to keep the graph still."
                : "The graph stays still. Turn it on to move it by dragging and to zoom by pinching or scrolling.",
            onClick: () => onHand(!hand) }));
}

/** `layout` from layoutWorkflowGraphTB; `nodes` the step views; `select(id)` selects a step (and may open its details). */
export function WorkflowFlow({ layout, nodes, selected, select }) {
    const [hand, setHand] = React.useState(true);
    const hostRef = React.useRef(null);
    const follow = React.useRef(true);
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
        // The person moved or zoomed the view (a programmatic change has no event): it stops following the area's size.
        onMove: event => { if (event) follow.current = false; },
        defaultMarkerColor: null,
        className: `ps-workflow-flow${hand ? " is-hand" : " is-still"}`,
    },
    h(Background, { variant: BackgroundVariant.Dots, gap: 18, size: 1 }),
    h(GraphView, { layout, area, follow, hand, onHand: setHand }));
}
