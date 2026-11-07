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
 *
 * Owner batch 7 (H2): a parallel step's body is drawn as a branch box under it (fork, branch box, join bar). Its steps
 * are laid out on their own and the box takes their place in the graph as one box (a dagre cluster cannot take the one
 * edge from the parallel step into the box), so nothing else is ever drawn inside it. Every branch end leads to the
 * join bar under the box, and the parallel step's own routes (joined, blocked, its runtime-error routes) leave from that
 * bar. A graph without a parallel step is laid out exactly as before.
 */

export const WORKFLOW_GRAPH_NODE_WIDTH = 202;
export const WORKFLOW_GRAPH_NODE_HEIGHT = 66;
/** The height of an edge's label box; its width follows the text drawn. */
export const WORKFLOW_GRAPH_LABEL_HEIGHT = 20;
/** A parallel step's join bar (H2): the bar and, under it, its rule and state, and a line for its own time limit when it has one. */
export const WORKFLOW_GRAPH_JOIN_WIDTH = 280;
export const WORKFLOW_GRAPH_JOIN_HEIGHT = 26;
export const WORKFLOW_GRAPH_JOIN_LIMIT_HEIGHT = 40;
/** A branch box (H2): the room at its sides and bottom, the room for its label above its steps, and the stack drawn behind it. */
export const WORKFLOW_GRAPH_GROUP_PADDING = 20;
export const WORKFLOW_GRAPH_GROUP_HEADER = 44;
export const WORKFLOW_GRAPH_GROUP_STACK = 8;
const LABEL_LIMIT = 20;
const MARGIN = 32;
const SPACING = { rankdir: "TB", nodesep: 56, edgesep: 20, ranksep: 64 };
/** Where a line into the join bar meets it: at least this far inside its ends. */
const JOIN_INSET = 16;

const round = value => Math.round(value * 10) / 10;
const finite = point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);

/** The id of a parallel step's branch box on the graph (H2). Step ids never hold ':' (the compiler's id pattern). */
export function workflowGroupId(parallelId) {
    return `group:${parallelId}`;
}

/** The id of a parallel step's join bar on the graph (H2). */
export function workflowJoinId(parallelId) {
    return `join:${parallelId}`;
}

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
 * Each parallel step's body (H2): `bodies`, parallel id -> its body's steps that are steps of the graph, in body order;
 * `memberOf`, each such step -> its parallel id. A step two bodies list belongs to the first; a parallel step is never a
 * body step (the compiler allows no nesting). A parallel step with no such step has no branch box. Pure.
 */
export function workflowGraphBodies(states) {
    const list = Array.isArray(states) ? states.filter(node => node && typeof node.id === "string") : [];
    const byId = new Map(list.map(node => [node.id, node]));
    const bodies = new Map();
    const memberOf = new Map();
    for (const node of list) {
        if (node.type !== "parallel" || !Array.isArray(node.body?.states)) continue;
        const members = [...new Set(node.body.states)].filter(id => typeof id === "string" && byId.has(id) && byId.get(id).type !== "parallel" && !memberOf.has(id));
        if (!members.length) continue;
        for (const id of members) memberOf.set(id, node.id);
        bodies.set(node.id, members);
    }
    return { bodies, memberOf };
}

/**
 * The graph's edges in definition order: one per pair of steps with its outcomes, and a parallel state's edge to the first
 * state of its body ("each branch"). Targets that are not steps of the graph are left out. A parallel step with a branch
 * box (H2) leads into the box by one edge without a label (`branch`, `start` its first step), and its own routes leave
 * from its join bar (`owner` the parallel step); a route into or out of a branch box is not drawn (the compiler allows
 * none).
 */
function graphEdges(states, { bodies, memberOf }) {
    const byId = new Map(states.map(node => [node.id, node]));
    const edges = [];
    const pairs = new Map();
    for (const node of states) {
        const boxed = bodies.has(node.id);
        const from = boxed ? workflowJoinId(node.id) : node.id;
        const scope = memberOf.get(node.id) ?? null;
        for (const [outcome, target] of Object.entries(node.next || {})) {
            if (!byId.has(target) || (memberOf.get(target) ?? null) !== scope) continue;
            const pair = JSON.stringify([from, target]);
            if (pairs.has(pair)) {
                const edge = pairs.get(pair);
                edge.outcomes.push(outcome);
                edge.outcome = edge.outcomes.join(" / ");
                continue;
            }
            const edge = { from, to: target, outcome, outcomes: [outcome], ...(boxed ? { owner: node.id } : {}) };
            pairs.set(pair, edge);
            edges.push(edge);
        }
        if (node.type !== "parallel") continue;
        if (boxed) {
            edges.push({ from: node.id, to: workflowGroupId(node.id), outcome: "each branch", outcomes: [], branch: true,
                start: typeof node.body?.initial === "string" ? node.body.initial : null, labelText: "" });
            continue;
        }
        const start = typeof node.body?.initial === "string" && byId.has(node.body.initial) ? node.body.initial : null;
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

/** Dagre's layout of `boxes` ([key, { width, height }]) and `links` ({ v, w, width, height }: a label's size), in the order given. */
function runDagre(boxes, links, margin) {
    const graph = new Graph({ directed: true, multigraph: false, compound: false });
    graph.setGraph({ ...SPACING, marginx: margin, marginy: margin });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const [key, size] of boxes) graph.setNode(key, { width: size.width, height: size.height });
    for (const link of links) graph.setEdge(link.v, link.w, { width: link.width, height: link.height, labelpos: "c", minlen: 1, weight: 1 });
    dagreLayout(graph);
    return graph;
}

/** A box's top-left, width and height from the centre dagre gave it. */
function topLeft(laid, width, height) {
    return { x: laid.x - width / 2, y: laid.y - height / 2, width, height };
}

/**
 * An edge's points, label place and direction from dagre's edge (`laid`), between the boxes `from` and `to`; a step's own
 * loop is drawn out of its right side, around its label and back in.
 */
function shapeEdge(edge, laid, from, to) {
    edge.points = (Array.isArray(laid?.points) ? laid.points : []).map(point => [point.x, point.y]).filter(finite);
    if (edge.points.length < 2) {
        // Never expected from dagre; a straight line from box to box keeps the edge drawable.
        edge.points = [[from.x + from.width / 2, from.y + from.height], [to.x + to.width / 2, to.y]];
    }
    const mid = edge.points[Math.floor(edge.points.length / 2)];
    edge.labelX = Number.isFinite(laid?.x) ? laid.x : mid[0];
    edge.labelY = Number.isFinite(laid?.y) ? laid.y : mid[1];
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

/** The smallest box around boxes, edge points and edge labels (a label only when it is drawn). */
function extentOf(boxes, edges) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const box of boxes) { include(box.x, box.y); include(box.x + box.width, box.y + box.height); }
    for (const edge of edges) {
        for (const [x, y] of edge.points) include(x, y);
        if (!edge.labelWidth) continue;
        include(edge.labelX - edge.labelWidth / 2, edge.labelY - WORKFLOW_GRAPH_LABEL_HEIGHT / 2);
        include(edge.labelX + edge.labelWidth / 2, edge.labelY + WORKFLOW_GRAPH_LABEL_HEIGHT / 2);
    }
    return { minX, minY, maxX, maxY };
}

function moveBox(box, dx, dy) {
    box.x += dx;
    box.y += dy;
}

function moveEdge(edge, dx, dy) {
    edge.points = edge.points.map(([x, y]) => [x + dx, y + dy]);
    edge.labelX += dx;
    edge.labelY += dy;
}

/**
 * One branch box's steps laid out on their own (H2), from its first step down: its steps (`positions`), the routes
 * between them (shaped in place), and where each branch end leaves the box (`exits`: its line to the point `sink` on
 * the box's bottom edge, where the lines meet, so they never cross a step). Coordinates start at 0, 0; `width` and
 * `height` hold everything drawn.
 */
function layoutBody(parallel, members, byId, edges) {
    const first = members.includes(parallel.body?.initial) ? parallel.body.initial : members[0];
    const order = [first, ...members.filter(id => id !== first)];
    const keyOf = new Map(order.map((id, index) => [id, `b${index}`]));
    const ends = order.filter(id => byId.get(id).type === "terminal");
    const boxes = order.map(id => [keyOf.get(id), { width: WORKFLOW_GRAPH_NODE_WIDTH, height: WORKFLOW_GRAPH_NODE_HEIGHT }]);
    if (ends.length) boxes.push(["x", { width: 1, height: 1 }]);
    const links = edges.map(edge => ({ v: keyOf.get(edge.from), w: keyOf.get(edge.to), width: edge.labelWidth, height: WORKFLOW_GRAPH_LABEL_HEIGHT }));
    for (const id of ends) links.push({ v: keyOf.get(id), w: "x", width: 0, height: 0 });
    const graph = runDagre(boxes, links, 0);
    const positions = new Map(order.map(id => [id, topLeft(graph.node(keyOf.get(id)), WORKFLOW_GRAPH_NODE_WIDTH, WORKFLOW_GRAPH_NODE_HEIGHT)]));
    for (const edge of edges) shapeEdge(edge, graph.edge(keyOf.get(edge.from), keyOf.get(edge.to)), positions.get(edge.from), positions.get(edge.to));
    const sinkNode = ends.length ? graph.node("x") : null;
    const sink = sinkNode ? [sinkNode.x, sinkNode.y + 0.5] : null;
    const exits = ends.map(id => {
        const laid = graph.edge(keyOf.get(id), "x");
        const points = (Array.isArray(laid?.points) ? laid.points : []).map(point => [point.x, point.y]).filter(finite);
        const box = positions.get(id);
        return { id, points: points.length >= 2 ? points : [[box.x + box.width / 2, box.y + box.height], sink] };
    });
    const extent = extentOf([...positions.values(), ...(sink ? [{ x: sink[0], y: sink[1], width: 0, height: 0 }] : [])],
        [...edges, ...exits.map(exit => ({ points: exit.points }))]);
    for (const box of positions.values()) moveBox(box, -extent.minX, -extent.minY);
    for (const edge of edges) moveEdge(edge, -extent.minX, -extent.minY);
    for (const exit of exits) exit.points = exit.points.map(([x, y]) => [x - extent.minX, y - extent.minY]);
    return { positions, exits, sink: sink ? [sink[0] - extent.minX, sink[1] - extent.minY] : null,
        width: extent.maxX - extent.minX, height: extent.maxY - extent.minY };
}

/**
 * The layout of a workflow definition (`{ initial, states }`, version 1 or 2): `positions` (step id -> its box's top-left
 * x, y, width and height), `edges` (from, to, outcome, outcomes, branch, kind for version 2, points, path, labelX and
 * labelY at the label's centre, labelText, labelWidth, and back when the edge goes up or loops), and the drawing's width
 * and height, every box, point and label inside it. H2: `groups` (parallel id -> its branch box: id, parallel, x, y,
 * width, height, the `stack` drawn behind it to its right and below, and its `members`) and `joins` (parallel id -> its
 * join bar: id, parallel, x, y, width, height); a branch end's edge to the join bar has `join` and `owner`, and an edge
 * without a label has labelText "" and labelWidth 0.
 */
export function layoutWorkflowGraphTB(definition) {
    const states = Array.isArray(definition?.states) ? definition.states.filter(node => node && typeof node.id === "string") : [];
    const parts = workflowGraphBodies(states);
    const edges = graphEdges(states, parts);
    for (const edge of edges) {
        // The edge into a branch box has no label (H2); every other edge's label is drawn.
        edge.labelText ??= workflowEdgeLabelText(edge.outcome);
        edge.labelWidth = edge.branch && edge.labelText === "" ? 0 : labelWidth(edge.labelText);
    }
    if (!states.length) return finish(definition, { width: 300, height: 150, positions: new Map(), edges, groups: new Map(), joins: new Map() });
    const byId = new Map(states.map(node => [node.id, node]));
    // The first step leads the order dagre breaks cycles in, so the loop's closing edge is the one that goes back to it.
    const initial = states.find(node => node.id === definition.initial);
    const order = initial ? [initial, ...states.filter(node => node !== initial)] : states;
    const outer = order.filter(node => !parts.memberOf.has(node.id));
    // Each branch box's own routes are laid out with its steps; every other edge is the graph's.
    const bodyEdges = new Map([...parts.bodies.keys()].map(id => [id, []]));
    const mainEdges = [];
    for (const edge of edges) {
        const scope = parts.memberOf.get(edge.from);
        if (scope === undefined) mainEdges.push(edge);
        else bodyEdges.get(scope).push(edge);
    }
    const bodies = new Map([...parts.bodies].map(([id, members]) => [id, layoutBody(byId.get(id), members, byId, bodyEdges.get(id))]));
    // Dagre keys its own maps by node name; step ids such as "__proto__" stay data, never keys.
    const keyOf = new Map(outer.map((node, index) => [node.id, `n${index}`]));
    const sizes = new Map(outer.map(node => [node.id, { width: WORKFLOW_GRAPH_NODE_WIDTH, height: WORKFLOW_GRAPH_NODE_HEIGHT }]));
    const boxSize = new Map();
    [...bodies].forEach(([id, body], index) => {
        const width = Math.ceil(Math.max(body.width, WORKFLOW_GRAPH_NODE_WIDTH) + 2 * WORKFLOW_GRAPH_GROUP_PADDING);
        // With branch ends, the box's bottom edge is where their lines meet (the body's sink); else padding.
        const height = Math.ceil(WORKFLOW_GRAPH_GROUP_HEADER + body.height + (body.sink ? 0 : WORKFLOW_GRAPH_GROUP_PADDING));
        boxSize.set(id, { width, height });
        // The box takes its stack's room too, so nothing is drawn under the stack.
        keyOf.set(workflowGroupId(id), `g${index}`);
        sizes.set(workflowGroupId(id), { width: width + WORKFLOW_GRAPH_GROUP_STACK, height: height + WORKFLOW_GRAPH_GROUP_STACK });
        keyOf.set(workflowJoinId(id), `j${index}`);
        sizes.set(workflowJoinId(id), { width: WORKFLOW_GRAPH_JOIN_WIDTH,
            height: byId.get(id).timeoutSeconds !== undefined ? WORKFLOW_GRAPH_JOIN_LIMIT_HEIGHT : WORKFLOW_GRAPH_JOIN_HEIGHT });
    });
    const links = mainEdges.map(edge => ({ v: keyOf.get(edge.from), w: keyOf.get(edge.to), width: edge.labelWidth,
        height: edge.labelWidth ? WORKFLOW_GRAPH_LABEL_HEIGHT : 0 }));
    // Each join bar sits under its branch box.
    for (const id of bodies.keys()) links.push({ v: keyOf.get(workflowGroupId(id)), w: keyOf.get(workflowJoinId(id)), width: 0, height: 0 });
    const graph = runDagre([...keyOf].map(([id, key]) => [key, sizes.get(id)]), links, MARGIN);
    const placed = id => topLeft(graph.node(keyOf.get(id)), sizes.get(id).width, sizes.get(id).height);
    const groups = new Map();
    const joins = new Map();
    const boxes = new Map();
    for (const [id, body] of bodies) {
        const slot = placed(workflowGroupId(id));
        const { width, height } = boxSize.get(id);
        const group = { id: workflowGroupId(id), parallel: id, x: slot.x, y: slot.y, width, height, stack: WORKFLOW_GRAPH_GROUP_STACK,
            members: parts.bodies.get(id) };
        groups.set(id, group);
        joins.set(id, { id: workflowJoinId(id), parallel: id, ...placed(workflowJoinId(id)) });
        boxes.set(group.id, group);
        boxes.set(workflowJoinId(id), joins.get(id));
        // The box's steps are centred in it, under its label.
        body.dx = group.x + (width - body.width) / 2;
        body.dy = group.y + WORKFLOW_GRAPH_GROUP_HEADER;
    }
    const positions = new Map();
    for (const node of states) {
        const parallel = parts.memberOf.get(node.id);
        if (parallel === undefined) {
            positions.set(node.id, placed(node.id));
            continue;
        }
        const body = bodies.get(parallel);
        const box = body.positions.get(node.id);
        positions.set(node.id, { x: box.x + body.dx, y: box.y + body.dy, width: box.width, height: box.height });
    }
    for (const [id, box] of positions) boxes.set(id, box);
    for (const edge of mainEdges) shapeEdge(edge, graph.edge(keyOf.get(edge.from), keyOf.get(edge.to)), boxes.get(edge.from), boxes.get(edge.to));
    // Every branch end leads to its join bar: down to the box's bottom edge, where the lines meet, then into the bar.
    const joinEdges = [];
    for (const [id, body] of bodies) {
        for (const edge of bodyEdges.get(id)) moveEdge(edge, body.dx, body.dy);
        const join = joins.get(id);
        for (const exit of body.exits) {
            const points = exit.points.map(([x, y]) => [x + body.dx, y + body.dy]);
            const [x, y] = points.at(-1);
            points.push([Math.min(Math.max(x, join.x + JOIN_INSET), join.x + join.width - JOIN_INSET), join.y]);
            joinEdges.push({ from: exit.id, to: join.id, outcome: "", outcomes: [], join: true, owner: id, labelText: "", labelWidth: 0,
                points, labelX: x, labelY: y, back: false });
        }
    }
    const all = [...edges, ...joinEdges];
    // Dagre sizes the drawing by its boxes and labels, not by the bends of long edges: measure everything, then move it
    // all so the smallest coordinate sits at the margin.
    const drawn = [...positions.values(), ...joins.values(),
        ...[...groups.values()].map(group => ({ x: group.x, y: group.y, width: group.width + group.stack, height: group.height + group.stack }))];
    const { minX, minY, maxX, maxY } = extentOf(drawn, all);
    const dx = MARGIN - minX, dy = MARGIN - minY;
    for (const box of [...positions.values(), ...groups.values(), ...joins.values()]) { box.x = round(box.x + dx); box.y = round(box.y + dy); }
    for (const edge of all) {
        edge.points = edge.points.map(([x, y]) => [round(x + dx), round(y + dy)]);
        edge.labelX = round(edge.labelX + dx);
        edge.labelY = round(edge.labelY + dy);
        edge.path = workflowEdgeCurve(edge.points).path;
    }
    return finish(definition, {
        width: Math.max(300, Math.ceil(maxX - minX + MARGIN * 2)),
        height: Math.max(150, Math.ceil(maxY - minY + MARGIN * 2)),
        positions, edges: all, groups, joins,
    });
}

/**
 * Where each box of the graph is drawn now (H2): box id (a step, a branch box or a join bar) -> its absolute top-left
 * (x, y), width and height; `parent`, the branch box a body step or a join bar sits in (null otherwise); `at`, its place
 * as React Flow takes it (relative to that box, else absolute); `self`, the person moved this box; `moved`, it or its
 * branch box was moved; a branch box's `dx`, `dy`, how far it moved from its automatic place, and `stack`. `moved` holds
 * the person's places by place key (workflowPlaceKey). Pure.
 */
export function workflowGraphPlaces(layout, moved = new Map()) {
    const out = new Map();
    const groupOf = new Map();
    const placesMoved = moved instanceof Map ? moved : new Map();
    for (const group of layout?.groups?.values?.() ?? []) {
        const self = placesMoved.has(group.id);
        const at = self ? placesMoved.get(group.id) : { x: group.x, y: group.y };
        out.set(group.id, { x: at.x, y: at.y, width: group.width, height: group.height, stack: group.stack ?? 0, parent: null, at,
            self, moved: self, dx: at.x - group.x, dy: at.y - group.y });
        for (const id of group.members ?? []) groupOf.set(id, group);
    }
    for (const [id, box] of layout?.positions ?? []) {
        const group = groupOf.get(id);
        const key = workflowPlaceKey(layout, id);
        const self = placesMoved.has(key);
        if (!group) {
            const at = self ? placesMoved.get(key) : { x: box.x, y: box.y };
            out.set(id, { x: at.x, y: at.y, width: box.width, height: box.height, parent: null, at, self, moved: self });
            continue;
        }
        const shown = out.get(group.id);
        const at = self ? placesMoved.get(key) : { x: box.x - group.x, y: box.y - group.y };
        out.set(id, { x: shown.x + at.x, y: shown.y + at.y, width: box.width, height: box.height, parent: group.id, at, self, moved: self || shown.moved });
    }
    for (const join of layout?.joins?.values?.() ?? []) {
        const group = layout.groups.get(join.parallel);
        const shown = group ? out.get(group.id) : null;
        if (!shown) continue;
        const at = { x: join.x - group.x, y: join.y - group.y };
        out.set(join.id, { x: shown.x + at.x, y: shown.y + at.y, width: join.width, height: join.height, parent: group.id, at, self: false, moved: shown.moved });
    }
    return out;
}

/**
 * The key a box's place is saved under in the person's profile (batch 6, f-03): a step's id; a branch box's id; and for a
 * step inside a branch box (H2), '<parallel id>/<step id>', its place relative to its box, so a place saved before the
 * box existed is never read as one inside it. Null for anything else (a join bar moves with its box). Pure.
 */
export function workflowPlaceKey(layout, id) {
    for (const group of layout?.groups?.values?.() ?? []) {
        if (group.id === id) return id;
        if (Array.isArray(group.members) && group.members.includes(id)) return `${group.parallel}/${id}`;
    }
    return layout?.positions?.has?.(id) ? id : null;
}

function finish(definition, layout) {
    return definition?.shape === "v2" ? annotateWorkflowV2Edges(definition, layout) : layout;
}
