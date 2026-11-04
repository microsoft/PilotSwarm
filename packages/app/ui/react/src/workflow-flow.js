import React from "react";
import { Background, BackgroundVariant, MarkerType, Panel, Position, ReactFlow, useReactFlow } from "@xyflow/react";
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
 * and the wheel and a finger scroll the page. The view fits the graph when it is first drawn; a run's progress redraws
 * the steps but never moves the view.
 */

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const FIT = { padding: 0.12, minZoom: MIN_ZOOM, maxZoom: 1 };
const MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16 };

function StepNode({ data }) {
    return h(WorkflowStepCard, data);
}

function StepEdge({ data, markerEnd }) {
    return h(WorkflowEdgeShape, { edge: data.edge, markerEnd });
}

// Stable for React Flow: new objects on each render would make it re-create every step and edge.
const NODE_TYPES = { workflowStep: StepNode };
const EDGE_TYPES = { workflowEdge: StepEdge };

function GraphControls({ hand, onHand }) {
    const flow = useReactFlow();
    return h(Panel, { position: "bottom-left", className: "ps-workflow-graph-controls", role: "group", "aria-label": "Graph view" },
        h(WorkflowToolButton, { label: "Zoom in", glyph: "zoom-in", onClick: () => { flow.zoomIn({ duration: 150 }); } }),
        h(WorkflowToolButton, { label: "Zoom out", glyph: "zoom-out", onClick: () => { flow.zoomOut({ duration: 150 }); } }),
        h(WorkflowToolButton, { label: "Fit to screen", glyph: "fit", onClick: () => { flow.fitView({ ...FIT, duration: 200 }); } }),
        h(WorkflowToolButton, { label: "Move the graph", glyph: "hand", "aria-pressed": hand,
            title: hand ? "Drag the background to move the graph; pinch or scroll to zoom. Turn it off to keep the graph still."
                : "The graph stays still. Turn it on to move it by dragging and to zoom by pinching or scrolling.",
            onClick: () => onHand(!hand) }));
}

/** `layout` from layoutWorkflowGraphTB; `nodes` the step views; `select(id)` selects a step (and may open its details). */
export function WorkflowFlow({ layout, nodes, selected, select }) {
    const [hand, setHand] = React.useState(true);
    const selectedId = selected?.id ?? null;
    const flowNodes = nodes.flatMap(node => {
        const box = layout.positions.get(node.id);
        if (!box) return [];
        return [{
            id: node.id, type: "workflowStep", position: { x: box.x, y: box.y }, width: box.width, height: box.height,
            data: { node, selected: node.id === selectedId, onSelect: select },
            draggable: false, connectable: false, selectable: false, deletable: false, focusable: false,
            // A click on a step is the step's own; dragging starts on the background.
            className: "nopan",
            // Where its edges meet it, given rather than measured, so edges draw at once (and on a server render).
            handles: [
                { id: null, type: "target", position: Position.Top, x: box.width / 2, y: 0, width: 1, height: 1 },
                { id: null, type: "source", position: Position.Bottom, x: box.width / 2, y: box.height, width: 1, height: 1 },
            ],
        }];
    });
    const flowEdges = React.useMemo(() => layout.edges.map((edge, index) => ({
        id: `e${index}`, source: edge.from, target: edge.to, type: "workflowEdge", data: { edge }, markerEnd: MARKER,
        selectable: false, deletable: false, focusable: false, reconnectable: false,
    })), [layout]);
    return h(ReactFlow, {
        nodes: flowNodes, edges: flowEdges, nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES,
        nodesDraggable: false, nodesConnectable: false, nodesFocusable: false, edgesFocusable: false, elementsSelectable: false,
        edgesReconnectable: false, deleteKeyCode: null, selectionKeyCode: null, multiSelectionKeyCode: null, selectionOnDrag: false,
        panActivationKeyCode: null, zoomActivationKeyCode: null, disableKeyboardA11y: true, autoPanOnNodeFocus: false,
        panOnDrag: hand, zoomOnScroll: hand, zoomOnPinch: hand, panOnScroll: false, zoomOnDoubleClick: false, preventScrolling: hand,
        minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, fitView: true, fitViewOptions: FIT,
        defaultMarkerColor: null,
        className: `ps-workflow-flow${hand ? " is-hand" : " is-still"}`,
    },
    h(Background, { variant: BackgroundVariant.Dots, gap: 18, size: 1 }),
    h(GraphControls, { hand, onHand: setHand }));
}
