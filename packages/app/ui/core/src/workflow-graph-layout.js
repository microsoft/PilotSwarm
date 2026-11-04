import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import { annotateWorkflowV2Edges } from "./workflow-v2-view.js";

/**
 * The portal's workflow graph layout (owner batch 5, g-01): top to bottom, laid out by dagre, with smooth curved edges.
 *
 * Dagre ranks the steps (a loop no longer collapses onto one row: it breaks each cycle by turning one edge around, so
 * the steps of a loop stack downwards and the edge that closes the loop curves back up beside them), orders each row to
 * cut crossings, and routes every edge through the gaps between the rows, with room reserved for its label. The edge is
 * drawn as a smooth B-spline through dagre's points, which stays inside the corridor dagre kept clear of other steps.
 *
 * The result keeps the edge contract the web graph and annotateWorkflowV2Edges use: one edge per pair of steps (several
 * outcomes to one target share it, their labels joined with " / "), a parallel state's "each branch" edge to its body's
 * first state, and for a version 2 graph each edge's kind (outcome, error, mixed or branch). Pure and deterministic: the
 * same definition gives the same layout. The terminal's graph order keeps its own layout (layoutWorkflowGraph).
 */

export const WORKFLOW_GRAPH_NODE_WIDTH = 202;
export const WORKFLOW_GRAPH_NODE_HEIGHT = 66;
/** The height of an edge's label box; its width follows the text drawn. */
export const WORKFLOW_GRAPH_LABEL_HEIGHT = 20;
const LABEL_LIMIT = 20;
const MARGIN = 32;

const round = value => Math.round(value * 10) / 10;
const finite = point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);

/** An edge's label as drawn: at most 20 characters, the rest behind an ellipsis (the whole label is its title). */
export function workflowEdgeLabelText(outcome) {
    const text = String(outcome ?? "");
    return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1)}…` : text;
}

/** The width reserved for a label: about the width of its characters at the label's 10px size, plus padding. */
function labelWidth(text) {
    return Math.ceil(text.length * 6.2) + 14;
}

/**
 * The graph's edges in definition order: one per pair of steps with its outcomes, and a parallel state's edge to the first
 * state of its body ("each branch"). Targets that are not steps of the graph are left out.
 */
function graphEdges(states) {
    const byId = new Map(states.map(node => [node.id, node]));
    const edges = [];
    const pairs = new Map();
    for (const node of states) {
        for (const [outcome, target] of Object.entries(node.next || {})) {
            if (!byId.has(target)) continue;
            const pair = JSON.stringify([node.id, target]);
            if (pairs.has(pair)) {
                const edge = pairs.get(pair);
                edge.outcomes.push(outcome);
                edge.outcome = edge.outcomes.join(" / ");
                continue;
            }
            const edge = { from: node.id, to: target, outcome, outcomes: [outcome] };
            pairs.set(pair, edge);
            edges.push(edge);
        }
        const start = node.type === "parallel" && typeof node.body?.initial === "string" && byId.has(node.body.initial) ? node.body.initial : null;
        if (start && !pairs.has(JSON.stringify([node.id, start]))) {
            const edge = { from: node.id, to: start, outcome: "each branch", outcomes: [], branch: true };
            pairs.set(JSON.stringify([node.id, start]), edge);
            edges.push(edge);
        }
    }
    return edges;
}

/**
 * A smooth curve through an edge's points: the uniform cubic B-spline d3's curveBasis draws (straight from the first
 * point, then cubic segments, straight into the last point, so an arrowhead follows the last routed segment). It passes
 * through the first and last points and stays within the hull of each run of four points, so it never leaves the
 * corridor dagre routed. Two points are one straight line. `segments` are the drawn pieces ({ type: "line" | "cubic",
 * from, c1?, c2?, to }), for measuring; `path` is the SVG path.
 */
export function workflowEdgeCurve(points) {
    const list = (Array.isArray(points) ? points : []).filter(finite).map(([x, y]) => [x, y]);
    const segments = [];
    if (list.length < 2) return { path: "", segments };
    const at = point => `${round(point[0])},${round(point[1])}`;
    let path = `M${at(list[0])}`;
    let cursor = list[0];
    const lineTo = point => {
        segments.push({ type: "line", from: cursor, to: point });
        path += ` L${at(point)}`;
        cursor = point;
    };
    const cubicTo = (c1, c2, point) => {
        segments.push({ type: "cubic", from: cursor, c1, c2, to: point });
        path += ` C${at(c1)} ${at(c2)} ${at(point)}`;
        cursor = point;
    };
    let phase = 0;
    let x0 = NaN, y0 = NaN, x1 = NaN, y1 = NaN;
    const basis = (x, y) => cubicTo([(2 * x0 + x1) / 3, (2 * y0 + y1) / 3], [(x0 + 2 * x1) / 3, (y0 + 2 * y1) / 3],
        [(x0 + 4 * x1 + x) / 6, (y0 + 4 * y1 + y) / 6]);
    for (const [x, y] of list) {
        if (phase === 0) phase = 1;
        else if (phase === 1) phase = 2;
        else if (phase === 2) {
            phase = 3;
            lineTo([(5 * x0 + x1) / 6, (5 * y0 + y1) / 6]);
            basis(x, y);
        } else basis(x, y);
        x0 = x1; x1 = x;
        y0 = y1; y1 = y;
    }
    if (phase === 3) basis(x1, y1);
    lineTo([x1, y1]);
    return { path, segments };
}

/**
 * The layout of a workflow definition (`{ initial, states }`, version 1 or 2): `positions` (step id -> its box's top-left
 * x, y, width and height), `edges` (from, to, outcome, outcomes, branch, kind for version 2, points, path, labelX and
 * labelY at the label's centre, labelText, labelWidth, and back when the edge goes up or loops), and the drawing's width
 * and height, every box, point and label inside it.
 */
export function layoutWorkflowGraphTB(definition) {
    const states = Array.isArray(definition?.states) ? definition.states.filter(node => node && typeof node.id === "string") : [];
    const edges = graphEdges(states);
    if (!states.length) return finish(definition, { width: 300, height: 150, positions: new Map(), edges });
    // The first step leads the order dagre breaks cycles in, so the loop's closing edge is the one that goes back to it.
    const initial = states.find(node => node.id === definition.initial);
    const order = initial ? [initial, ...states.filter(node => node !== initial)] : states;
    // Dagre keys its own maps by node name; step ids such as "__proto__" stay data, never keys.
    const keyOf = new Map(order.map((node, index) => [node.id, `n${index}`]));
    const graph = new Graph({ directed: true, multigraph: false, compound: false });
    graph.setGraph({ rankdir: "TB", nodesep: 56, edgesep: 20, ranksep: 64, marginx: MARGIN, marginy: MARGIN });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of order) graph.setNode(keyOf.get(node.id), { width: WORKFLOW_GRAPH_NODE_WIDTH, height: WORKFLOW_GRAPH_NODE_HEIGHT });
    for (const edge of edges) {
        edge.labelText = workflowEdgeLabelText(edge.outcome);
        edge.labelWidth = labelWidth(edge.labelText);
        graph.setEdge(keyOf.get(edge.from), keyOf.get(edge.to),
            { width: edge.labelWidth, height: WORKFLOW_GRAPH_LABEL_HEIGHT, labelpos: "c", minlen: 1, weight: 1 });
    }
    dagreLayout(graph);
    const positions = new Map();
    for (const node of states) {
        const laid = graph.node(keyOf.get(node.id));
        positions.set(node.id, { x: laid.x - WORKFLOW_GRAPH_NODE_WIDTH / 2, y: laid.y - WORKFLOW_GRAPH_NODE_HEIGHT / 2,
            width: WORKFLOW_GRAPH_NODE_WIDTH, height: WORKFLOW_GRAPH_NODE_HEIGHT });
    }
    for (const edge of edges) {
        const laid = graph.edge(keyOf.get(edge.from), keyOf.get(edge.to)) || {};
        edge.points = (Array.isArray(laid.points) ? laid.points : []).map(point => [point.x, point.y]).filter(finite);
        const from = positions.get(edge.from), to = positions.get(edge.to);
        if (edge.points.length < 2) {
            // Never expected from dagre; a straight line from box to box keeps the edge drawable.
            edge.points = [[from.x + from.width / 2, from.y + from.height], [to.x + to.width / 2, to.y]];
        }
        const mid = edge.points[Math.floor(edge.points.length / 2)];
        edge.labelX = Number.isFinite(laid.x) ? laid.x : mid[0];
        edge.labelY = Number.isFinite(laid.y) ? laid.y : mid[1];
        edge.back = to.y <= from.y;
        if (edge.from === edge.to) {
            // A step that loops on itself: dagre keeps room for the label to the right of the step, but its own points
            // zigzag back across the step. Draw the loop out of the step's right side, around its label and back in.
            const right = from.x + from.width;
            const upper = from.y + from.height * 0.25, lower = from.y + from.height * 0.75;
            edge.labelX = Math.max(edge.labelX, right + 16 + edge.labelWidth / 2);
            edge.labelY = from.y + from.height / 2;
            const outer = edge.labelX + edge.labelWidth / 2 + 8;
            edge.points = [[right, upper], [edge.labelX, upper - 10], [outer, edge.labelY], [edge.labelX, lower + 10], [right, lower]];
        }
    }
    // Dagre sizes the drawing by its boxes and labels, not by the bends of long edges: measure everything, then move it
    // all so the smallest coordinate sits at the margin.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const box of positions.values()) { include(box.x, box.y); include(box.x + box.width, box.y + box.height); }
    for (const edge of edges) {
        for (const [x, y] of edge.points) include(x, y);
        include(edge.labelX - edge.labelWidth / 2, edge.labelY - WORKFLOW_GRAPH_LABEL_HEIGHT / 2);
        include(edge.labelX + edge.labelWidth / 2, edge.labelY + WORKFLOW_GRAPH_LABEL_HEIGHT / 2);
    }
    const dx = MARGIN - minX, dy = MARGIN - minY;
    for (const box of positions.values()) { box.x = round(box.x + dx); box.y = round(box.y + dy); }
    for (const edge of edges) {
        edge.points = edge.points.map(([x, y]) => [round(x + dx), round(y + dy)]);
        edge.labelX = round(edge.labelX + dx);
        edge.labelY = round(edge.labelY + dy);
        edge.path = workflowEdgeCurve(edge.points).path;
    }
    return finish(definition, {
        width: Math.max(300, Math.ceil(maxX - minX + MARGIN * 2)),
        height: Math.max(150, Math.ceil(maxY - minY + MARGIN * 2)),
        positions, edges,
    });
}

function finish(definition, layout) {
    return definition?.shape === "v2" ? annotateWorkflowV2Edges(definition, layout) : layout;
}
