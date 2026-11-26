/**
 * Owner 2026-11-09T03:37Z (the timeline as a viewing mode): "as a workflow is executing, the last four transitions need to
 * be visually lit up. if the transitions are already lit up then they need to be double lit". One model for both graph
 * renderers (React Flow and the plain picture); the terminal UI draws no graph, so it has none of this.
 *
 * workflowTransitions: how each loaded visit was entered, in the timeline's order (workflowReplayFrames).
 * workflowLitTransitions: the last four of them up to the visit shown, by edge and by step, each with how often it was
 * taken among the four and how long ago (0 the newest).
 *
 * Owner 2026-11-26 (the simpler graph): an error handler or an end chip has no line; a transition through it has the
 * handler's or chip's key ("handler:<step>:<target>", "chip:<step>:<end>"), so the viewer draws its dashed arrow to the
 * target (or a ghost of the end) while it is lit. A branch's first visit has its lane's key ("lane:<parallel>:<name>").
 */
import {
    WORKFLOW_CATCH_ALL_ROUTE, WORKFLOW_ERROR_GLYPH, workflowGraphEdgeKey, workflowGraphModel, workflowGroupId, workflowJoinId,
    workflowOutcomePlain, workflowRouteMark,
} from "./workflow-graph-layout.js";
import { workflowReplayFrames, workflowVisitScope } from "./workflow-view.js";
import { workflowErrorRouteWords } from "./workflow-words.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** How many transitions are lit, the newest ones (owner: "the last four transitions"). */
export const WORKFLOW_LIT_TRANSITIONS = 4;

/** The parallel visit a branch scope belongs to ("<parallel visit>#<index>", or the visit's own branch); null for the root. */
function parallelVisitOf(execution, scope) {
    if (isRecord(execution?.branch) && typeof execution.branch.parallelNodeExecutionId === "string") return execution.branch.parallelNodeExecutionId;
    const at = typeof scope === "string" ? scope.lastIndexOf("#") : -1;
    return scope !== "root" && at > 0 ? scope.slice(0, at) : null;
}

/**
 * Each loaded visit's entry, in the timeline's order (entry time, then visit number, then id: workflowReplayFrames):
 * { nodeExecutionId, fromStateId, toStateId, edgeKey, route, words, error }. The step it came from: its predecessor
 * (`predecessorId`, which read_workflow gives a branch's visits) when that visit is loaded; else the visit before it in
 * its own scope (the root's chain; each branch its own), also for a catch-all's arrival (`catchAll`: the step whose error
 * the catch-all took); a branch's first visit came from its parallel visit; the run's first visit from none. `route` is
 * the route the step's visit took (its outcome, an error's failure route, or "@catchAll"), `words` it in plain words
 * ("changes required", "✕ script failed"), `error` whether it was an error. `edgeKey` is what the graph draws for that
 * route (workflowGraphModel's routeKeys: a line, a branch's line into its join bar, an error handler or a chip), the lane's pill
 * for a branch's first visit, or null where it draws nothing. `definition`: the graph it is drawn from. Pure.
 */
export function workflowTransitions(executions, definition) {
    const list = (Array.isArray(executions) ? executions : []).filter(item => isRecord(item) && typeof item.id === "string");
    const byId = new Map(list.map(item => [item.id, item]));
    const model = workflowGraphModel(definition);
    const keys = new Set(model.edges.map(edge => workflowGraphEdgeKey(edge.from, edge.to)));
    const { bodies } = model.parts;
    // The line between two steps when the route taken is not known (its step's visit is not loaded).
    const lineOf = (from, to) => {
        const body = bodies.get(from);
        const target = bodies.has(to) ? workflowGroupId(to) : to;
        const candidates = body ? [[workflowJoinId(from), target], [from, target]] : [[from, target]];
        if (model.joinEnds.has(to)) candidates.unshift([from, workflowJoinId(model.joinEnds.get(to))]);
        for (const [a, b] of candidates) {
            const key = workflowGraphEdgeKey(a, b);
            if (keys.has(key)) return key;
        }
        const chip = (model.chips.get(from) ?? []).find(item => item.end === to);
        if (chip) return chip.key;
        const handler = (model.handlers.get(from) ?? []).find(item => item.target === to);
        return handler ? handler.key : null;
    };
    const lastInScope = new Map();
    return workflowReplayFrames(list).map(frame => {
        const execution = byId.get(frame.nodeExecutionId);
        const scope = workflowVisitScope(execution);
        // The visit it came from: its predecessor when loaded, else the visit before it in its scope. A catch-all
        // arrival came from that one too: the step whose error the catch-all took.
        let from = null;
        if (execution.catchAll !== true && typeof execution.predecessorId === "string" && byId.has(execution.predecessorId)) from = byId.get(execution.predecessorId);
        else if (lastInScope.has(scope)) from = lastInScope.get(scope);
        let fromStateId = from?.stateId ?? null;
        let laneEntry = false;
        if (fromStateId === null && scope !== "root") {
            fromStateId = byId.get(parallelVisitOf(execution, scope))?.stateId ?? null;
            laneEntry = fromStateId !== null;
        }
        lastInScope.set(scope, execution);
        const base = { nodeExecutionId: frame.nodeExecutionId, fromStateId, toStateId: frame.stateId };
        if (fromStateId === null) return { ...base, edgeKey: null, route: null, words: null, error: false };
        // A branch's first visit, entered from its parallel step: its lane's pill (B1: no line into a lane).
        if (laneEntry) return { ...base, edgeKey: model.laneKeys.get(frame.stateId) ?? null, route: null, words: null, error: false };
        const node = model.byId.get(fromStateId);
        const route = execution.catchAll === true ? WORKFLOW_CATCH_ALL_ROUTE : routeTaken(node, from);
        const error = route === WORKFLOW_CATCH_ALL_ROUTE || from?.resultKind === "runtime_error";
        const edgeKey = route !== null && model.routeKeys.has(`${fromStateId}\u0000${route}`)
            ? model.routeKeys.get(`${fromStateId}\u0000${route}`) : lineOf(fromStateId, frame.stateId);
        return { ...base, edgeKey, route, words: transitionWords(node, route, from), error };
    });
}

/** The route a step's visit took, as the runtime picks it (selectRoute): its outcome's route, else an error's failure route. */
function routeTaken(node, visit) {
    const next = isRecord(node?.next) ? node.next : {};
    const outcome = typeof visit?.outcome === "string" ? visit.outcome : null;
    if (outcome === null) return null;
    if (Object.hasOwn(next, outcome)) return outcome;
    return visit.resultKind === "runtime_error" && Object.hasOwn(next, "failure") ? "failure" : null;
}

/** An error's few words for a temporary tag ("✕ script failed"); the visit's own error words when they are short. */
function errorTag(visit) {
    const words = typeof visit?.errorWords === "string" ? visit.errorWords.trim() : "";
    if (/^the script (stopped|exited)/.test(words)) return `${WORKFLOW_ERROR_GLYPH} script failed`;
    if (words && words.length <= 36) return `${WORKFLOW_ERROR_GLYPH} ${words}`;
    const outcome = typeof visit?.outcome === "string" ? visit.outcome : "failure";
    return workflowErrorRouteWords(outcome === "failure" ? "failure" : outcome);
}

/** A transition's outcome in words (replay): "changes required", "visit limit reached", "✕ script failed". */
function transitionWords(node, route, from) {
    if (route === null) return null;
    if (route === WORKFLOW_CATCH_ALL_ROUTE) return errorTag(from);
    const mark = workflowRouteMark(node, route);
    if (mark === "limit") return "visit limit reached";
    if (mark === "error" || from?.resultKind === "runtime_error") return errorTag(from);
    return workflowOutcomePlain(route);
}

/**
 * The last `limit` transitions (WORKFLOW_LIT_TRANSITIONS) up to and including the one at `uptoIndex` (null: the newest),
 * counted across every branch in the timeline's order: `edges` (edge key) and `nodes` (step id), each -> { count, age }
 * where `count` is how often it was taken among them and `age` how many transitions ago it was last taken (0 the newest);
 * `current`, the step of the transition shown (null when there is none). Pure.
 */
export function workflowLitTransitions(transitions, uptoIndex = null, limit = WORKFLOW_LIT_TRANSITIONS) {
    const list = Array.isArray(transitions) ? transitions : [];
    const edges = new Map();
    const nodes = new Map();
    const upto = Number.isSafeInteger(uptoIndex) ? Math.min(uptoIndex, list.length - 1) : list.length - 1;
    if (upto < 0) return { edges, nodes, current: null };
    const mark = (map, key, age) => {
        const prior = map.get(key);
        map.set(key, prior ? { count: prior.count + 1, age: prior.age } : { count: 1, age });
    };
    for (let index = upto; index >= Math.max(0, upto - Math.max(1, limit) + 1); index -= 1) {
        const transition = list[index];
        mark(nodes, transition.toStateId, upto - index);
        if (transition.edgeKey) mark(edges, transition.edgeKey, upto - index);
    }
    // R5: everything taken up to the transition shown (the rest is faded); the shown transition itself (its temporary
    // outcome tag, its ghost end glowing).
    const visited = new Set();
    for (let index = 0; index <= upto; index += 1) if (list[index].edgeKey) visited.add(list[index].edgeKey);
    return { edges, nodes, current: list[upto].toStateId, transition: list[upto], visited };
}

/**
 * The run's end reached by the transition at `uptoIndex` (null: the newest) or before it: the last transition into one of
 * `ends` (the root's end ids), or null. Pure.
 */
export function workflowEndReached(transitions, ends, uptoIndex = null) {
    const list = Array.isArray(transitions) ? transitions : [];
    const ids = new Set(Array.isArray(ends) ? ends.map(end => (typeof end === "string" ? end : end?.id)) : []);
    const upto = Number.isSafeInteger(uptoIndex) ? Math.min(uptoIndex, list.length - 1) : list.length - 1;
    for (let index = upto; index >= 0; index -= 1) if (ids.has(list[index].toStateId)) return list[index].toStateId;
    return null;
}

/** The timeline's error transitions (a route taken on an error, or the catch-all's), by index, for its red marks. Pure. */
export function workflowErrorTransitions(transitions) {
    return (Array.isArray(transitions) ? transitions : []).flatMap((transition, index) => (transition?.error ? [index] : []));
}

/** How a key is lit now: { count, age } among the last four, or null. */
function litOf(lit, key) {
    const item = lit?.edges?.get?.(key) ?? null;
    return item ? { count: item.count, age: item.age } : null;
}

/**
 * A step's quiet error-handler mark (R1) and its end chips (R2) as drawn now: the mark lit while one of its handlers'
 * transitions is among the last four (replay) or one of them leads into the Ends row's hovered end; each chip with how
 * it is lit (`litCount`, `litAge`), whether the run took it by the moment shown (`visited`, null outside a run), whether
 * its end is hovered (`hover`), and, while it is among the last four transitions, its `ghost`: the end, and the
 * transition's words and `current` when it is the transition shown. `layout` from layoutWorkflowGraphTB, `lit` from
 * workflowLitTransitions. Pure.
 */
export function workflowStepMarks(layout, stepId, lit = null, hoverEnd = null) {
    const run = lit?.visited instanceof Set;
    const shown = lit?.transition ?? null;
    const of = item => {
        const on = litOf(lit, item.key);
        const current = Boolean(on && shown?.edgeKey === item.key && on.age === 0);
        return { ...item, litCount: on?.count ?? 0, litAge: on?.age ?? null, visited: run ? lit.visited.has(item.key) : null,
            hover: hoverEnd !== null && item.end === hoverEnd,
            ghost: on ? { end: item.end, tone: item.tone, words: current ? shown.words ?? null : null, current } : null };
    };
    const mark = layout?.marks?.get?.(stepId) ?? null;
    const handlers = layout?.handlers?.get?.(stepId) ?? [];
    const on = handlers.map(handler => litOf(lit, handler.key)).filter(Boolean).sort((a, b) => a.age - b.age)[0] ?? null;
    const chips = layout?.chips?.get?.(stepId) ?? [];
    return {
        mark: mark ? { ...mark, litCount: on?.count ?? 0, litAge: on?.age ?? null, visited: run ? handlers.some(handler => lit.visited.has(handler.key)) || null : null,
            hover: hoverEnd !== null && handlers.some(handler => handler.target === hoverEnd) } : null,
        chips: chips.map(of),
    };
}

/**
 * How a line is drawn now (replay, R5): `litCount`, `litAge`, `visited` (null outside a run), `hover` (it leads into the
 * Ends row's hovered end) and `tag`, the shown transition's words when it took this line and the line has no label of its
 * own. Pure.
 */
export function workflowEdgeShown(edge, lit = null, hoverEnd = null) {
    const key = JSON.stringify([edge.from, edge.to]);
    const on = litOf(lit, key);
    const shown = lit?.transition ?? null;
    return { litCount: on?.count ?? 0, litAge: on?.age ?? null, visited: lit?.visited instanceof Set ? lit.visited.has(key) : null,
        hover: hoverEnd !== null && edge.to === hoverEnd,
        tag: shown?.edgeKey === key && !edge.labelText && typeof shown.words === "string" && shown.words ? shown.words : null };
}

/**
 * A lane's pill as it stands (B3): its name and, from its steps' views (`byId`, as of the moment shown), its state:
 * the end it reached ("ended", "not started": the end's name without the lane's prefix), "running" while one of its
 * steps runs, else nothing. `lit` lights it while its first visit is among the last four. Pure.
 */
export function workflowLanePill(parallelId, pill, members, byId, lit = null) {
    const views = (Array.isArray(members) ? members : []).map(id => byId.get(id)).filter(Boolean);
    const words = id => workflowOutcomePlain(id.startsWith(`${pill.name}_`) ? id.slice(pill.name.length + 1) : id);
    const ended = views.find(view => view.type === "terminal" && ["done", "failed", "cancelled"].includes(view.state));
    const running = views.find(view => view.type !== "terminal" && view.state === "running");
    const status = ended ? words(ended.id) : running ? "running" : null;
    const tone = ended ? (ended.outcome === "failed" || ended.state === "failed" ? "red" : ended.outcome === "succeeded" ? "green" : "amber") : running ? "blue" : null;
    const on = litOf(lit, `lane:${parallelId}:${pill.name}`);
    return { ...pill, text: status ? `${pill.name} · ${status}` : pill.name, status, tone,
        title: ended ? `Branch ${pill.name} ended at ${ended.id}` : running ? `Branch ${pill.name}: ${running.id} is running` : `Branch ${pill.name}`,
        litCount: on?.count ?? 0, litAge: on?.age ?? null };
}

/** A lit part's level as drawn: "1" taken once among the four, "2" twice or more (two levels only). */
export function workflowLitLevel(lit) {
    return lit && lit.count >= 2 ? "2" : lit ? "1" : null;
}
