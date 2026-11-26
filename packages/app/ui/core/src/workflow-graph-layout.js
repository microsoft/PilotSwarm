import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import { annotateWorkflowEdges, workflowRouteKind } from "./workflow-view.js";

/**
 * The portal's workflow graph layout (owner batch 5, g-01): top to bottom, laid out by dagre, with smooth curved edges.
 *
 * Dagre ranks the steps (a loop no longer collapses onto one row: it breaks each cycle by turning one edge around, so
 * the steps of a loop stack downwards and the edge that closes the loop curves back up beside them), orders each row to
 * cut crossings, and routes every edge through the gaps between the rows, with room reserved for its label. The edge is
 * drawn as a smooth B-spline through dagre's points, which stays inside the corridor dagre kept clear of other steps.
 *
 * The result keeps the edge contract the web graph and annotateWorkflowEdges use: one edge per pair of steps (several
 * outcomes to one target share it, their labels joined with " / "), a parallel state's "each branch" edge to its body's
 * first state, and for a graph each edge's kind (outcome, error, mixed or branch). Pure and deterministic: the
 * same definition gives the same layout. The terminal's graph order keeps its own layout (layoutWorkflowGraph).
 *
 * Owner batch 7 (H2): a parallel step's body is drawn as a branch box under it (fork, branch box, join bar). Its steps
 * are laid out on their own and the box takes their place in the graph as one box (a dagre cluster cannot take the one
 * edge from the parallel step into the box), so nothing else is ever drawn inside it. Every branch end leads to the
 * join bar under the box, and the parallel step's own routes (joined, blocked, its runtime-error routes) leave from that
 * bar. A graph without a parallel step is laid out exactly as before.
 *
 * Named branches (owner decision 2026-11-08): a parallel step with named branches has the same box and bar, but
 * no stack behind the box: its branches are lanes side by side in it, in their declared order, and the parallel step
 * leads into each lane by its own edge, labelled with the branch's name, to the lane's first step.
 */

export const WORKFLOW_GRAPH_NODE_WIDTH = 202;
export const WORKFLOW_GRAPH_NODE_HEIGHT = 66;
/** Labels reserve two lines, row gaps and font-load slack without moving the graph after rendering. */
export function workflowGraphNodeHeight(node) {
    const labeled = typeof node?.about?.description === "string" && node.about.description.trim().length > 0;
    return labeled ? node.type === "terminal" ? 120 : 100 : WORKFLOW_GRAPH_NODE_HEIGHT;
}
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

/** The glyph an error route takes on a line or a chip (R3). */
export const WORKFLOW_ERROR_GLYPH = "✕";
/** The glyph a visit limit (`exhausted`, a state's maxVisits) takes on a line or a chip (R3). */
export const WORKFLOW_LIMIT_GLYPH = "⟳";
/** The outcome a state with maxVisits takes once its visits are used up. */
const EXHAUSTED = "exhausted";
/** The arrival route of a visit the root catchAll took (the runtime's CATCH_ALL_ROUTE). */
export const WORKFLOW_CATCH_ALL_ROUTE = "@catchAll";
/** How hard dagre keeps an edge of the happy path short and straight (R4); every other edge has 1. */
export const WORKFLOW_SPINE_WEIGHT = 8;
/** An end chip's height, and the room between a step and its chips (R2). */
export const WORKFLOW_GRAPH_CHIP_HEIGHT = 18;
export const WORKFLOW_GRAPH_CHIP_GAP = 14;
/** Business words on a line are cut after this many characters (the glyphs after them never are). */
const WORDS_LIMIT = 32;

/** An outcome id in plain words: "ready_for_review" -> "ready for review". */
export function workflowOutcomePlain(label) {
    return String(label ?? "").replace(/_/g, " ");
}

/** How a route of `node` is drawn (R3): "outcome" a business outcome, "limit" its visit limit, "error" a runtime-error route. */
export function workflowRouteMark(node, label) {
    if (label === EXHAUSTED && node?.type !== "decision") return "limit";
    return workflowRouteKind(node, label) === "error" ? "error" : "outcome";
}

/** A state's business outcomes, its visit limit left out: what a line must carry to need no label (R3). Pure. */
function businessOutcomes(node) {
    if (!node || node.type === "terminal") return [];
    const listed = node.type === "decision" ? Object.keys(node.next ?? {}) : Array.isArray(node.outcomes) ? node.outcomes : [];
    return listed.filter(label => workflowRouteMark(node, label) === "outcome");
}

/** Routes as words (R3): the business outcomes in plain words, then ⟳ for the visit limit and ✕ for errors. */
function routeWords(node, labels, { limitWord = "" } = {}) {
    const words = [];
    let limit = false, error = false;
    for (const label of labels) {
        const mark = workflowRouteMark(node, label);
        if (mark === "outcome") words.push(workflowOutcomePlain(label));
        else if (mark === "limit") limit = true;
        else error = true;
    }
    const text = words.join(" · ");
    return [...(text ? [text.length > WORDS_LIMIT ? `${text.slice(0, WORDS_LIMIT - 1)}…` : text] : []),
        ...(limit ? [`${WORKFLOW_LIMIT_GLYPH}${limitWord}`] : []), ...(error ? [WORKFLOW_ERROR_GLYPH] : [])].join(" · ");
}

/**
 * An edge's label as drawn (R3): none on a line that carries every business outcome of its step; else its business
 * outcomes in plain words, then ⟳ for a visit limit and ✕ for error routes ("not created · ⟳ · ✕"). The edge's title
 * still lists every route.
 */
function workflowEdgeLabelTextOf(edge, byId) {
    const node = byId.get(edge.step ?? edge.owner ?? edge.from);
    if (!node) return workflowEdgeLabelText(edge.outcome);
    const business = businessOutcomes(node);
    if (business.length && business.every(label => edge.outcomes.includes(label))) return "";
    return routeWords(node, edge.outcomes);
}

/** An end chip's words (R2): "not open → ⏹ rejected", "⟳ limit → ⏹ no_env", "✕ → not started", or "⏹ declined" for its own name. */
function chipText(node, routes, end) {
    if (routes.length === 1 && routes[0] === end) return `⏹ ${end}`;
    return `${routeWords(node, routes, { limitWord: " limit" })} → ⏹ ${end}`;
}

/**
 * The success end of one scope (the root, a For each body, or one named branch): of its terminals with outcome
 * `succeeded`, the one farthest from its first step (breadth first over its routes), then one reached by a business
 * outcome, then the first declared. Null when it has none. Pure.
 */
function successEndOf(ids, initial, byId) {
    const inScope = new Set(ids);
    const depth = new Map();
    const byBusiness = new Set();
    if (inScope.has(initial)) {
        depth.set(initial, 0);
        const queue = [initial];
        while (queue.length) {
            const id = queue.shift();
            const node = byId.get(id);
            for (const [label, target] of Object.entries(node?.next ?? {})) {
                if (!inScope.has(target)) continue;
                if (workflowRouteMark(node, label) === "outcome") byBusiness.add(target);
                if (depth.has(target)) continue;
                depth.set(target, depth.get(id) + 1);
                queue.push(target);
            }
        }
    }
    let best = null;
    for (const id of ids) {
        const node = byId.get(id);
        if (node?.type !== "terminal" || node.outcome !== "succeeded") continue;
        const rank = [depth.get(id) ?? -1, byBusiness.has(id) ? 1 : 0];
        if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { id, rank };
    }
    return best?.id ?? null;
}

/**
 * What the graph draws, before any geometry (owner 2026-11-26, the simpler graph): drawing only, a Workflow means the
 * same. Pure and deterministic.
 *
 * - `edges`: the lines, one per pair of drawn boxes (several routes to one target share it), each with `outcomes`; a
 *   parallel step drawn as a box (B1) is entered at its box (`group:<id>`) and left from its join bar (`owner`); a
 *   branch's line into its join bar (B2) is `join` with `step`, the step it leaves, and `parallel`.
 * - `badges` (R1): step -> its ✕ badge: `routes` (its error routes to an end with outcome failed), `end`, and
 *   `catchAll` when the root catchAll covers it (a root step without a failure route); `key` "badge:<step>".
 * - `chips` (R2): step -> its end chips, one per end: `end`, `routes`, `text`, `tone` ("red" for an error route or a
 *   failed end, else "amber"), `key` "chip:<step>:<end>".
 * - `hidden`: the ends not drawn as boxes: the root's blocked, failed and canceled ends, and every end inside a branch
 *   box (its success end is its line into the join bar, the others chips).
 * - `ends` (R2): the root's ends, each once: `id`, `outcome`, `box` (drawn as a box), and `keys`, every way in.
 * - `routeKeys`: "<step>\u0000<route>" -> the key of what that route draws (a line, a badge, a chip); `laneKeys`:
 *   lane first step -> "lane:<parallel>:<name>".
 * - `spine` (R4): the keys of the lines on the happy path, from the first step to the root's success end.
 */
export function workflowGraphModel(definition) {
    const states = Array.isArray(definition?.states) ? definition.states.filter(node => node && typeof node.id === "string") : [];
    const byId = new Map(states.map(node => [node.id, node]));
    const parts = workflowGraphBodies(states);
    const catchAll = typeof definition?.catchAll === "string" && byId.has(definition.catchAll) ? definition.catchAll : null;
    const hidden = new Set();
    // A branch's success end -> its parallel step: its ways in are lines into the join bar (B2).
    const joinEnds = new Map();
    const rootIds = states.filter(node => !parts.memberOf.has(node.id)).map(node => node.id);
    for (const id of rootIds) {
        const node = byId.get(id);
        if (node.type === "terminal" && node.outcome !== "succeeded") hidden.add(id);
    }
    const lanesOf = new Map();
    for (const [parallel, members] of parts.bodies) {
        const node = byId.get(parallel);
        for (const id of members) if (byId.get(id).type === "terminal") hidden.add(id);
        const lanes = workflowGraphLanes(node, members).map(lane => {
            const branch = node.namedBranches.find(item => item.name === lane.name);
            return { ...lane, members: branch.states.filter(id => members.includes(id)) };
        });
        lanesOf.set(parallel, lanes);
        const scopes = lanes.length ? lanes.map(lane => [lane.members, lane.initial])
            : [[members, members.includes(node.body?.initial) ? node.body.initial : members[0]]];
        for (const [ids, initial] of scopes) {
            const end = successEndOf(ids, initial, byId);
            if (end !== null) joinEnds.set(end, parallel);
        }
    }
    const boxOf = id => (parts.bodies.has(id) ? workflowGroupId(id) : id);
    const edges = [];
    const pairs = new Map();
    const badges = new Map();
    const chips = new Map();
    const routeKeys = new Map();
    const routeKey = (step, label) => `${step}\u0000${label}`;
    const addLine = (from, to, label, extra) => {
        const pair = workflowGraphEdgeKey(from, to);
        if (pairs.has(pair)) {
            const edge = pairs.get(pair);
            edge.outcomes.push(label);
            edge.outcome = edge.outcomes.join(" / ");
            return pair;
        }
        const edge = { from, to, outcome: label, outcomes: [label], ...extra };
        pairs.set(pair, edge);
        edges.push(edge);
        return pair;
    };
    for (const node of states) {
        if (node.type === "terminal") continue;
        const boxed = parts.bodies.has(node.id);
        const from = boxed ? workflowJoinId(node.id) : node.id;
        const scope = parts.memberOf.get(node.id) ?? null;
        for (const [label, target] of Object.entries(node.next || {})) {
            const end = byId.get(target);
            if (!end || (parts.memberOf.get(target) ?? null) !== scope) continue;
            const mark = workflowRouteMark(node, label);
            let key;
            if (hidden.has(target) && joinEnds.has(target)) {
                const parallel = joinEnds.get(target);
                key = addLine(node.id, workflowJoinId(parallel), label, { join: true, step: node.id, parallel });
            } else if (hidden.has(target) && mark === "error" && end.outcome === "failed") {
                const badge = badges.get(node.id) ?? { step: node.id, key: `badge:${node.id}`, routes: [], end: target, catchAll: false };
                badge.routes.push(label);
                badges.set(node.id, badge);
                key = badge.key;
            } else if (hidden.has(target)) {
                const list = chips.get(node.id) ?? [];
                let chip = list.find(item => item.end === target);
                if (!chip) {
                    chip = { step: node.id, end: target, outcome: end.outcome, routes: [], key: `chip:${node.id}:${target}` };
                    list.push(chip);
                    chips.set(node.id, list);
                }
                chip.routes.push(label);
                key = chip.key;
            } else {
                key = addLine(from, boxOf(target), label, boxed ? { owner: node.id } : {});
            }
            routeKeys.set(routeKey(node.id, label), key);
        }
        // A parallel step whose body has no box (none of its steps in the graph) still shows where each branch starts.
        const start = node.type === "parallel" && !boxed && typeof node.body?.initial === "string" && byId.has(node.body.initial) ? node.body.initial : null;
        if (start && !pairs.has(workflowGraphEdgeKey(node.id, start))) {
            const edge = { from: node.id, to: start, outcome: "each branch", outcomes: [], branch: true };
            pairs.set(workflowGraphEdgeKey(node.id, start), edge);
            edges.push(edge);
        }
    }
    for (const list of chips.values()) {
        for (const chip of list) {
            const node = byId.get(chip.step);
            chip.text = chipText(node, chip.routes, chip.end);
            chip.tone = chip.outcome === "failed" || chip.routes.some(label => workflowRouteMark(node, label) === "error") ? "red" : "amber";
        }
    }
    // R1: a root step with no failure route is covered by the root catchAll (the catch-all state itself is not).
    if (catchAll !== null) {
        for (const id of rootIds) {
            const node = byId.get(id);
            if (node.type === "terminal" || id === catchAll || Object.hasOwn(node.next ?? {}, "failure")) continue;
            const badge = badges.get(id) ?? { step: id, key: `badge:${id}`, routes: [], end: catchAll, catchAll: false };
            badge.catchAll = true;
            badges.set(id, badge);
            routeKeys.set(routeKey(id, WORKFLOW_CATCH_ALL_ROUTE), badge.key);
        }
    }
    for (const badge of badges.values()) {
        const end = byId.get(badge.end);
        const scope = parts.memberOf.has(badge.step) ? "branch" : "run";
        badge.title = end?.type === "terminal" ? `Any error here ends the ${scope}: ${badge.end}`
            : `Any error here goes to ${badge.end}`;
        if (badge.catchAll && badge.routes.length === 0 && end?.type === "terminal") badge.title += " (catchAll)";
    }
    const laneKeys = new Map();
    for (const [parallel, lanes] of lanesOf) for (const lane of lanes) laneKeys.set(lane.initial, `lane:${parallel}:${lane.name}`);
    const ends = rootIds.filter(id => byId.get(id).type === "terminal").map(id => {
        const keys = [...edges.filter(edge => edge.to === id).map(edge => workflowGraphEdgeKey(edge.from, edge.to)),
            ...[...chips.values()].flat().filter(chip => chip.end === id).map(chip => chip.key),
            ...[...badges.values()].filter(badge => badge.end === id).map(badge => badge.key)];
        return { id, outcome: byId.get(id).outcome, box: !hidden.has(id), keys };
    });
    const initial = byId.has(definition?.initial) ? definition.initial : states[0]?.id ?? null;
    const spine = initial === null ? new Set() : spineOf(edges, byId, parts, boxOf(initial), successEndOf(rootIds, initial, byId));
    return { states, byId, parts, catchAll, hidden, joinEnds, lanes: lanesOf, edges, badges, chips, ends, routeKeys, laneKeys, spine };
}

/**
 * The happy path's lines (R4), between the root's boxes: from the first step, each step's first business outcome on
 * (until a step comes round again), and the first path to the success end, business outcomes first. A parallel step's
 * box leads to its join bar. Pure.
 */
function spineOf(edges, byId, parts, start, success) {
    const outer = edges.filter(edge => !edge.join && !parts.memberOf.has(edge.from) && !parts.memberOf.has(edge.to));
    const order = edge => {
        const node = byId.get(edge.owner ?? edge.from);
        const labels = Object.keys(node?.next ?? {});
        const business = edge.outcomes.some(label => workflowRouteMark(node, label) === "outcome");
        return [business ? 0 : 1, Math.min(...edge.outcomes.map(label => labels.indexOf(label)))];
    };
    const ranked = [...outer].sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1] - y[1]; });
    const out = new Map();
    for (const edge of ranked) {
        if (!out.has(edge.from)) out.set(edge.from, []);
        out.get(edge.from).push(edge);
    }
    const next = id => (id.startsWith("group:") ? out.get(workflowJoinId(id.slice("group:".length))) ?? [] : out.get(id) ?? []);
    const spine = new Set();
    // The first business outcome of each step, until a step comes round again.
    const seen = new Set([start]);
    for (let at = start; ;) {
        const edge = next(at).find(item => order(item)[0] === 0);
        if (!edge) break;
        spine.add(workflowGraphEdgeKey(edge.from, edge.to));
        if (seen.has(edge.to)) break;
        seen.add(edge.to);
        at = edge.to;
    }
    if (success !== null) {
        const path = [];
        const visiting = new Set();
        const walk = at => {
            if (at === success) return true;
            visiting.add(at);
            for (const edge of next(at)) {
                if (visiting.has(edge.to)) continue;
                path.push(edge);
                if (walk(edge.to)) return true;
                path.pop();
            }
            return false;
        };
        if (walk(start)) for (const edge of path) spine.add(workflowGraphEdgeKey(edge.from, edge.to));
    }
    return spine;
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
 * A parallel step's named branches that are lanes of its branch box (`members`, its box's steps): each with its
 * name and its first step, in declared order. Empty for a For each, or when a branch's first step is not in the box. Pure.
 */
export function workflowGraphLanes(node, members) {
    if (!Array.isArray(node?.namedBranches) || !Array.isArray(members)) return [];
    const lanes = node.namedBranches.filter(item => typeof item?.name === "string" && item.name && members.includes(item.initial))
        .map(item => ({ name: item.name, initial: item.initial }));
    return lanes.length === node.namedBranches.length ? lanes : [];
}

/**
 * Owner 2026-11-09 (the timeline's lit transitions): an edge's key, as both renderers key the edge from `from` to `to`
 * (a step, a branch box "group:<id>" or a join bar "join:<id>"). Pure.
 */
export function workflowGraphEdgeKey(from, to) {
    return JSON.stringify([from, to]);
}

/** The keys of every line the graph draws (workflowGraphEdgeKey), a branch's lines into its join bar included (B2). Pure. */
export function workflowGraphEdgeKeys(definition) {
    return new Set(workflowGraphModel(definition).edges.map(edge => workflowGraphEdgeKey(edge.from, edge.to)));
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
 * Dagre's layout of `boxes` ([key, { width, height }]) and `links` ({ v, w, width, height }: a label's size; `weight`, how
 * hard dagre keeps it short, default 1), in the order given.
 */
function runDagre(boxes, links, margin, align = undefined) {
    const graph = new Graph({ directed: true, multigraph: false, compound: false });
    graph.setGraph({ ...SPACING, marginx: margin, marginy: margin, ...(align ? { align } : {}) });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const [key, size] of boxes) graph.setNode(key, { width: size.width, height: size.height });
    for (const link of links) graph.setEdge(link.v, link.w, { width: link.width, height: link.height, labelpos: "c", minlen: 1, weight: link.weight ?? 1 });
    dagreLayout(graph);
    return graph;
}

/** Dagre's alignments, tried in this order: its balanced default first. */
const ALIGNMENTS = [undefined, "UR", "UL", "DR", "DL"];

/**
 * R4: dagre's layout (runDagre) whose happy path (`spine`, [from key, to key]) is straightest: the fewest downward
 * spine lines whose two boxes are not one above the other, then the narrowest drawing, then the first alignment tried.
 * Dagre's weights keep the path short; its alignment decides which child a box stands over.
 */
function straightestDagre(boxes, links, spine) {
    let best = null;
    for (const align of spine.length ? ALIGNMENTS : [undefined]) {
        const graph = runDagre(boxes, links, MARGIN, align);
        let bent = 0;
        for (const [from, to] of spine) {
            const a = graph.node(from), b = graph.node(to);
            if (a && b && b.y > a.y && Math.abs(a.x - b.x) > 1) bent += 1;
        }
        const width = graph.graph().width ?? 0;
        if (!best || bent < best.bent || (bent === best.bent && width < best.width - 1)) best = { graph, bent, width };
        if (bent === 0) break;
    }
    return best.graph;
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

/** The width of a lane pill's room (B3): its live words are cut to it. */
export const WORKFLOW_GRAPH_LANE_PILL_WIDTH = 168;

/**
 * The room a step's end chips take beside it (R2), on each side so its lines still meet the step's middle: the widest
 * chip and the gap before it; 0 without chips.
 */
function chipRoom(chips) {
    if (!Array.isArray(chips) || !chips.length) return 0;
    return WORKFLOW_GRAPH_CHIP_GAP + Math.max(...chips.map(chip => Math.ceil(chip.text.length * 6.4) + 18));
}

/** A step's size for dagre: its card, with its chips' room on both sides. */
function laidSize(node, reserve) {
    return { width: WORKFLOW_GRAPH_NODE_WIDTH + 2 * (reserve.get(node.id) ?? 0), height: workflowGraphNodeHeight(node) };
}

/** A step's card from the centre dagre gave its laid box. */
function cardAt(laid, node) {
    return topLeft(laid, WORKFLOW_GRAPH_NODE_WIDTH, workflowGraphNodeHeight(node));
}

/** A box with its chips' room (for measuring what is drawn). */
function withRoom(box, room) {
    return room ? { x: box.x - room, y: box.y, width: box.width + 2 * room, height: box.height } : box;
}

/**
 * One branch box's steps laid out on their own (H2), from its first step down: its steps (`positions`), the routes
 * between them and its lines into the join bar (B2, shaped in place, each down to the point `sink` on the box's bottom
 * edge, where the lines meet, so they never cross a step). Coordinates start at 0, 0; `width` and `height` hold
 * everything drawn. A box of named branches (`lanes`) lays each lane out on its own (layoutLanes).
 */
function layoutBody(parallel, members, byId, edges, lanes, reserve) {
    if (lanes.length) return layoutLanes(lanes, byId, edges, reserve);
    const first = members.includes(parallel.body?.initial) ? parallel.body.initial : members[0];
    return layoutSteps([first, ...members.filter(id => id !== first)], byId, edges, null, reserve);
}

/**
 * Steps (`order`, the first one first) laid out by dagre with their routes (`edges`, shaped in place) and their lines
 * into the join bar (`join` edges), which all end at one point under them (`sink`). With `lane`, a lane of named
 * branches: room above its first step for its pill (B3), placed at `pill`. Moved so its top-left is at 0, 0.
 */
function layoutSteps(order, byId, edges, lane, reserve) {
    const keyOf = new Map(order.map((id, index) => [id, `b${index}`]));
    const exits = edges.filter(edge => edge.join);
    const inner = edges.filter(edge => !edge.join && keyOf.has(edge.from) && keyOf.has(edge.to));
    const boxes = [...(lane ? [["s", { width: 1, height: 1 }]] : []), ...order.map(id => [keyOf.get(id), laidSize(byId.get(id), reserve)])];
    if (exits.length) boxes.push(["x", { width: 1, height: 1 }]);
    const links = lane ? [{ v: "s", w: keyOf.get(lane.initial), width: WORKFLOW_GRAPH_LANE_PILL_WIDTH, height: WORKFLOW_GRAPH_LABEL_HEIGHT }] : [];
    links.push(...inner.map(edge => ({ v: keyOf.get(edge.from), w: keyOf.get(edge.to), width: edge.labelWidth,
        height: edge.labelWidth ? WORKFLOW_GRAPH_LABEL_HEIGHT : 0 })));
    for (const edge of exits) links.push({ v: keyOf.get(edge.from), w: "x", width: edge.labelWidth, height: edge.labelWidth ? WORKFLOW_GRAPH_LABEL_HEIGHT : 0 });
    const graph = runDagre(boxes, links, 0);
    const positions = new Map(order.map(id => [id, cardAt(graph.node(keyOf.get(id)), byId.get(id))]));
    for (const edge of inner) shapeEdge(edge, graph.edge(keyOf.get(edge.from), keyOf.get(edge.to)), positions.get(edge.from), positions.get(edge.to));
    const sinkNode = exits.length ? graph.node("x") : null;
    const sink = sinkNode ? [sinkNode.x, sinkNode.y + 0.5] : null;
    for (const edge of exits) shapeEdge(edge, graph.edge(keyOf.get(edge.from), "x"), positions.get(edge.from), { x: sink[0], y: sink[1], width: 0, height: 0 });
    let pill = null;
    if (lane) {
        const laid = graph.edge("s", keyOf.get(lane.initial));
        const start = graph.node("s");
        pill = { x: Number.isFinite(laid?.x) ? laid.x : start.x, y: Number.isFinite(laid?.y) ? laid.y : start.y };
    }
    const shaped = [...inner, ...exits];
    const extent = extentOf([...[...positions].map(([id, box]) => withRoom(box, reserve.get(id) ?? 0)),
        ...(sink ? [{ x: sink[0], y: sink[1], width: 0, height: 0 }] : []),
        ...(pill ? [{ x: pill.x - WORKFLOW_GRAPH_LANE_PILL_WIDTH / 2, y: pill.y - WORKFLOW_GRAPH_LABEL_HEIGHT / 2,
            width: WORKFLOW_GRAPH_LANE_PILL_WIDTH, height: WORKFLOW_GRAPH_LABEL_HEIGHT }] : [])], shaped);
    for (const box of positions.values()) moveBox(box, -extent.minX, -extent.minY);
    for (const edge of shaped) moveEdge(edge, -extent.minX, -extent.minY);
    return { positions, exits, sink: sink ? [sink[0] - extent.minX, sink[1] - extent.minY] : null,
        pills: pill && lane ? [{ name: lane.name, initial: lane.initial, x: pill.x - extent.minX, y: pill.y - extent.minY }] : [],
        width: extent.maxX - extent.minX, height: extent.maxY - extent.minY };
}

/**
 * A box of named branches, each lane laid out on its own (layoutSteps) and the lanes set side by side in their
 * declared order, their tops on one line. Each lane's lines into the join bar lead straight down to the box's bottom
 * edge under the lane; `sink` is that edge's middle.
 */
function layoutLanes(lanes, byId, edges, reserve) {
    const gap = SPACING.nodesep;
    const laid = lanes.map(lane => {
        const own = new Set(lane.members.filter(id => !byId.get(id) || byId.get(id).type !== "terminal"));
        const first = lane.initial;
        return { own, ...layoutSteps([first, ...[...own].filter(id => id !== first)], byId,
            edges.filter(edge => own.has(edge.from) && (edge.join || own.has(edge.to))), lane, reserve) };
    });
    const bottom = Math.max(0, ...laid.map(lane => (lane.sink ? lane.sink[1] : lane.height)));
    const positions = new Map();
    const exits = [];
    const pills = [];
    let x = 0;
    for (const lane of laid) {
        for (const [id, box] of lane.positions) { moveBox(box, x, 0); positions.set(id, box); }
        // The lane's edges were shaped in place; move them with the lane.
        for (const edge of edges.filter(item => lane.own.has(item.from))) moveEdge(edge, x, 0);
        for (const edge of lane.exits) {
            const [lastX, lastY] = edge.points.at(-1);
            if (lastY < bottom) edge.points.push([lastX, bottom]);
            exits.push(edge);
        }
        for (const pill of lane.pills) pills.push({ ...pill, x: pill.x + x });
        x += lane.width + gap;
    }
    const width = Math.max(0, x - gap);
    return { positions, exits, pills, sink: exits.length ? [width / 2, bottom] : null, width, height: bottom };
}

/**
 * The layout of a workflow definition (`{ initial, states }`): `positions` (step id -> its box's top-left
 * x, y, width and height), `edges` (from, to, outcome, outcomes, branch, kind, points, path, labelX and
 * labelY at the label's centre, labelText, labelWidth, and back when the edge goes up or loops), and the drawing's width
 * and height, every box, point and label inside it. H2: `groups` (parallel id -> its branch box: id, parallel, x, y,
 * width, height, the `stack` drawn behind it to its right and below, and its `members`) and `joins` (parallel id -> its
 * join bar: id, parallel, x, y, width, height); a branch end's edge to the join bar has `join` and `owner`, and an edge
 * without a label has labelText "" and labelWidth 0.
 */
export function layoutWorkflowGraphTB(definition) {
    const model = workflowGraphModel(definition);
    const { states, byId, parts, edges, hidden, spine } = model;
    // The kinds are known before the labels' widths are reserved.
    if (Array.isArray(definition?.states)) annotateWorkflowEdges(definition, { edges });
    for (const edge of edges) {
        edge.labelText ??= workflowEdgeLabelTextOf(edge, byId);
        edge.labelWidth = edge.labelText ? labelWidth(edge.labelText) : 0;
        // R4: the happy path's lines are kept short and straight.
        if (spine.has(workflowGraphEdgeKey(edge.from, edge.to))) { edge.spine = true; edge.weight = WORKFLOW_SPINE_WEIGHT; }
    }
    const marks = { badges: model.badges, chips: model.chips, ends: model.ends, hidden, catchAll: model.catchAll, lanes: model.lanes };
    if (!states.length) return finish(definition, { width: 300, height: 150, positions: new Map(), edges, groups: new Map(), joins: new Map(), ...marks });
    const reserve = new Map([...model.chips].map(([id, list]) => [id, chipRoom(list)]));
    // The first step leads the order dagre breaks cycles in, so the loop's closing edge is the one that goes back to it.
    const initial = states.find(node => node.id === definition.initial);
    const order = initial ? [initial, ...states.filter(node => node !== initial)] : states;
    // R2, B1: ends drawn as chips or lines into a join bar, and parallel steps drawn as their box, have no box of their own.
    const outer = order.filter(node => !parts.memberOf.has(node.id) && !hidden.has(node.id) && !parts.bodies.has(node.id));
    // Each branch box's own routes (and its lines into its join bar) are laid out with its steps; every other edge is the graph's.
    const bodyEdges = new Map([...parts.bodies.keys()].map(id => [id, []]));
    const mainEdges = [];
    for (const edge of edges) {
        const scope = parts.memberOf.get(edge.from);
        if (scope === undefined) mainEdges.push(edge);
        else bodyEdges.get(scope).push(edge);
    }
    const bodies = new Map([...parts.bodies].map(([id, members]) => [id, layoutBody(byId.get(id), members.filter(member => !hidden.has(member)), byId,
        bodyEdges.get(id), model.lanes.get(id) ?? [], reserve)]));
    // Dagre keys its own maps by node name; step ids such as "__proto__" stay data, never keys.
    const keyOf = new Map(outer.map((node, index) => [node.id, `n${index}`]));
    const sizes = new Map(outer.map(node => [node.id, laidSize(node, reserve)]));
    const boxSize = new Map();
    [...bodies].forEach(([id, body], index) => {
        const width = Math.ceil(Math.max(body.width, WORKFLOW_GRAPH_NODE_WIDTH) + 2 * WORKFLOW_GRAPH_GROUP_PADDING);
        // With lines into the join bar, the box's bottom edge is where they meet (the body's sink); else padding.
        const height = Math.ceil(WORKFLOW_GRAPH_GROUP_HEADER + body.height + (body.sink ? 0 : WORKFLOW_GRAPH_GROUP_PADDING));
        boxSize.set(id, { width, height });
        // The box takes its stack's room too, so nothing is drawn under the stack. Named branches' lanes have none.
        const stack = (model.lanes.get(id) ?? []).length ? 0 : WORKFLOW_GRAPH_GROUP_STACK;
        keyOf.set(workflowGroupId(id), `g${index}`);
        sizes.set(workflowGroupId(id), { width: width + stack, height: height + stack });
        keyOf.set(workflowJoinId(id), `j${index}`);
        // A parallel step's routes leave its join bar: its end chips sit beside the bar, with room on both sides.
        sizes.set(workflowJoinId(id), { width: WORKFLOW_GRAPH_JOIN_WIDTH + 2 * (reserve.get(id) ?? 0),
            height: byId.get(id).timeoutSeconds !== undefined ? WORKFLOW_GRAPH_JOIN_LIMIT_HEIGHT : WORKFLOW_GRAPH_JOIN_HEIGHT });
    });
    const links = mainEdges.map(edge => ({ v: keyOf.get(edge.from), w: keyOf.get(edge.to), width: edge.labelWidth,
        height: edge.labelWidth ? WORKFLOW_GRAPH_LABEL_HEIGHT : 0, weight: edge.weight ?? 1 }));
    // Each join bar sits under its branch box, straight under it.
    for (const id of bodies.keys()) {
        links.push({ v: keyOf.get(workflowGroupId(id)), w: keyOf.get(workflowJoinId(id)), width: 0, height: 0, weight: WORKFLOW_SPINE_WEIGHT });
    }
    const graph = straightestDagre([...keyOf].map(([id, key]) => [key, sizes.get(id)]), links,
        mainEdges.filter(edge => edge.spine).map(edge => [keyOf.get(edge.from), keyOf.get(edge.to)]));
    const placed = id => topLeft(graph.node(keyOf.get(id)), sizes.get(id).width, sizes.get(id).height);
    const groups = new Map();
    const joins = new Map();
    const boxes = new Map();
    for (const [id, body] of bodies) {
        const slot = placed(workflowGroupId(id));
        const { width, height } = boxSize.get(id);
        const lanes = (model.lanes.get(id) ?? []).map(lane => lane.name);
        const group = { id: workflowGroupId(id), parallel: id, x: slot.x, y: slot.y, width, height, stack: lanes.length ? 0 : WORKFLOW_GRAPH_GROUP_STACK,
            members: parts.bodies.get(id), ...(lanes.length ? { lanes } : {}) };
        groups.set(id, group);
        const bar = placed(workflowJoinId(id));
        const room = reserve.get(id) ?? 0;
        joins.set(id, { id: workflowJoinId(id), parallel: id, ...bar, x: bar.x + room, width: bar.width - 2 * room });
        boxes.set(group.id, group);
        boxes.set(workflowJoinId(id), joins.get(id));
        // The box's steps are centred in it, under its label.
        body.dx = group.x + (width - body.width) / 2;
        body.dy = group.y + WORKFLOW_GRAPH_GROUP_HEADER;
        // B3: each lane's pill, relative to its box (it moves with the box).
        group.lanePills = (body.pills ?? []).map(pill => ({ name: pill.name, initial: pill.initial, width: WORKFLOW_GRAPH_LANE_PILL_WIDTH,
            x: round(pill.x + body.dx - group.x), y: round(pill.y + body.dy - group.y) }));
    }
    const positions = new Map();
    for (const node of states) {
        if (hidden.has(node.id) || parts.bodies.has(node.id)) continue;
        const parallel = parts.memberOf.get(node.id);
        if (parallel === undefined) {
            positions.set(node.id, cardAt(graph.node(keyOf.get(node.id)), node));
            continue;
        }
        const body = bodies.get(parallel);
        const box = body.positions.get(node.id);
        if (box) positions.set(node.id, { x: box.x + body.dx, y: box.y + body.dy, width: box.width, height: box.height });
    }
    for (const [id, box] of positions) boxes.set(id, box);
    for (const edge of mainEdges) shapeEdge(edge, graph.edge(keyOf.get(edge.from), keyOf.get(edge.to)), boxes.get(edge.from), boxes.get(edge.to));
    // B2: a branch's lines into its join bar come down to the box's bottom edge, where they meet, then into the bar.
    for (const [id, body] of bodies) {
        for (const edge of bodyEdges.get(id)) moveEdge(edge, body.dx, body.dy);
        const join = joins.get(id);
        for (const edge of body.exits) {
            const [x] = edge.points.at(-1);
            edge.points.push([Math.min(Math.max(x, join.x + JOIN_INSET), join.x + join.width - JOIN_INSET), join.y]);
            edge.back = false;
            // A named branch's line says its branch.
            if (typeof byId.get(edge.from)?.branchName === "string") edge.lane = byId.get(edge.from).branchName;
        }
    }
    // Dagre sizes the drawing by its boxes and labels, not by the bends of long edges: measure everything (a step's chips
    // too), then move it all so the smallest coordinate sits at the margin.
    const drawn = [...[...positions].map(([id, box]) => withRoom(box, reserve.get(id) ?? 0)),
        ...[...joins].map(([id, box]) => withRoom(box, reserve.get(id) ?? 0)),
        ...[...groups.values()].map(group => ({ x: group.x, y: group.y, width: group.width + group.stack, height: group.height + group.stack }))];
    const { minX, minY, maxX, maxY } = extentOf(drawn, edges);
    const dx = MARGIN - minX, dy = MARGIN - minY;
    for (const box of [...positions.values(), ...groups.values(), ...joins.values()]) { box.x = round(box.x + dx); box.y = round(box.y + dy); }
    for (const edge of edges) {
        edge.points = edge.points.map(([x, y]) => [round(x + dx), round(y + dy)]);
        edge.labelX = round(edge.labelX + dx);
        edge.labelY = round(edge.labelY + dy);
        edge.path = workflowEdgeCurve(edge.points).path;
    }
    return finish(definition, {
        width: Math.max(300, Math.ceil(maxX - minX + MARGIN * 2)),
        height: Math.max(150, Math.ceil(maxY - minY + MARGIN * 2)),
        positions, edges, groups, joins, ...marks,
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
    return Array.isArray(definition?.states) ? annotateWorkflowEdges(definition, layout) : layout;
}
