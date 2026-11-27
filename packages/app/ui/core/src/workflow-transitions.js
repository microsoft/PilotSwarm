/**
 * Owner 2026-11-09T03:37Z (the timeline as a viewing mode): "as a workflow is executing, the last four transitions need to
 * be visually lit up. if the transitions are already lit up then they need to be double lit". One model for both graph
 * renderers (React Flow and the plain picture); the terminal UI draws no graph, so it has none of this.
 *
 * workflowTransitions: how each loaded visit was entered, in the timeline's order (workflowReplayFrames).
 * workflowLitTransitions: the last four of them up to the visit shown, by edge and by step, each with how often it was
 * taken among the four and how long ago (0 the newest).
 *
 * Owner 2026-11-26 (the simpler graph): an error route into an end (a handler) or an end chip has no line; a transition
 * through it has the handler's or chip's key ("handler:<step>:<end>", "chip:<step>:<end>"), so the viewer draws its dashed
 * arrow to a ghost of the end while it is lit. An error route between steps is a dashed line of its own (its key
 * workflowGraphErrorEdgeKey). A branch's first visit has its lane's key ("lane:<parallel>:<name>").
 */
import {
    WORKFLOW_CATCH_ALL_ROUTE, WORKFLOW_ERROR_GLYPH, workflowGraphEdgeKey, workflowGraphErrorEdgeKey, workflowGraphModel, workflowGroupId, workflowJoinId,
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
    return sourcedTransitions(executions, definition).map(item => item.transition);
}

/** workflowTransitions, each with the visit it came from (`from`, null for none). */
function sourcedTransitions(executions, definition) {
    const list = (Array.isArray(executions) ? executions : []).filter(item => isRecord(item) && typeof item.id === "string");
    const byId = new Map(list.map(item => [item.id, item]));
    const model = workflowGraphModel(definition);
    const keys = new Set(model.edges.map(edge => edge.key));
    const { bodies } = model.parts;
    // The line between two steps when the route taken is not known (its step's visit is not loaded): its business line,
    // else its line of error routes, a chip or a handler into that end; an error visit tries the error routes first.
    const lineOf = (from, to, error) => {
        const body = bodies.get(from);
        const target = bodies.has(to) ? workflowGroupId(to) : to;
        const pairs = body ? [[workflowJoinId(from), target], [from, target]] : [[from, target]];
        if (model.joinEnds.has(to)) pairs.unshift([from, workflowJoinId(model.joinEnds.get(to))]);
        const business = pairs.map(([a, b]) => workflowGraphEdgeKey(a, b)).filter(key => keys.has(key));
        const errorLines = pairs.map(([a, b]) => workflowGraphErrorEdgeKey(a, b)).filter(key => keys.has(key));
        const chip = (model.chips.get(from) ?? []).find(item => item.end === to)?.key ?? null;
        const handler = (model.handlers.get(from) ?? []).find(item => item.end === to)?.key ?? null;
        const order = error ? [...errorLines, handler, ...business, chip] : [...business, chip, ...errorLines, handler];
        return order.find(key => key !== null) ?? null;
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
        // A branch's first visit: the runtime stores its parallel visit as its predecessor (or none is loaded).
        const parallelVisit = scope !== "root" ? parallelVisitOf(execution, scope) : null;
        let laneEntry = parallelVisit !== null && from !== null && from.id === parallelVisit;
        let fromStateId = from?.stateId ?? null;
        if (fromStateId === null && parallelVisit !== null) {
            fromStateId = byId.get(parallelVisit)?.stateId ?? null;
            laneEntry = fromStateId !== null;
        }
        lastInScope.set(scope, execution);
        const base = { nodeExecutionId: frame.nodeExecutionId, fromStateId, toStateId: frame.stateId };
        const sourced = transition => ({ transition, from: from ?? null });
        if (fromStateId === null) return sourced({ ...base, edgeKey: null, route: null, words: null, error: false });
        // A branch's first visit, entered from its parallel step: its lane's pill (B1: no line into a lane).
        if (laneEntry) return sourced({ ...base, edgeKey: model.laneKeys.get(frame.stateId) ?? null, route: null, words: null, error: false });
        const node = model.byId.get(fromStateId);
        const route = execution.catchAll === true ? WORKFLOW_CATCH_ALL_ROUTE : routeTaken(node, from);
        const error = route === WORKFLOW_CATCH_ALL_ROUTE || from?.resultKind === "runtime_error";
        const edgeKey = route !== null && model.routeKeys.has(`${fromStateId}\u0000${route}`)
            ? model.routeKeys.get(`${fromStateId}\u0000${route}`) : lineOf(fromStateId, frame.stateId, error);
        return sourced({ ...base, edgeKey, route, words: transitionWords(node, route, from), error });
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

/**
 * UX round 1 (R3): the timeline's error marks, each at the visit that threw, not at the visit of the step that took the
 * error: { at, step, handler, handlerStep, handled, words }, in the timeline's order (indexes into workflowReplayFrames of
 * the same visits). `at` is the throwing visit (the handler's own visit when the throwing one is not loaded), `handler`
 * the visit of the step or end the error went to; `handled` is false when that is an end that fails or cancels (the run,
 * or the branch, ended on the error), else true: a step, or an end with another outcome, took it. Pure.
 */
export function workflowErrorMarks(executions, definition) {
    const sourced = sourcedTransitions(executions, definition);
    const index = new Map(sourced.map((item, at) => [item.transition.nodeExecutionId, at]));
    const model = workflowGraphModel(definition);
    return sourced.flatMap(({ transition, from }, handler) => {
        if (!transition.error) return [];
        const target = model.byId.get(transition.toStateId);
        const ends = target?.type === "terminal" && (target.outcome === "failed" || target.outcome === "cancelled");
        const at = from && index.has(from.id) ? index.get(from.id) : handler;
        return [{ at, step: transition.fromStateId, handler, handlerStep: transition.toStateId, handled: !ends, words: transition.words ?? null }];
    });
}

/** How a key is lit now: { count, age } among the last four, or null. */
function litOf(lit, key) {
    const item = lit?.edges?.get?.(key) ?? null;
    return item ? { count: item.count, age: item.age } : null;
}

/**
 * A step's boundary events (R1, 12:05 PST: one per error route into an end) and its end chips (R2) as drawn now, each
 * with how it is lit (`litCount`, `litAge`: its transition among the last four), whether the run took it by the moment
 * shown (`visited`, null outside a run) and whether its end is hovered in the Ends row (`hover`); each chip, while it is
 * among the last four transitions, also its `ghost`: the end, and the transition's words and `current` when it is the
 * transition shown. `layout` from layoutWorkflowGraphTB, `lit` from workflowLitTransitions. Pure.
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
    const marks = layout?.marks?.get?.(stepId) ?? [];
    const chips = layout?.chips?.get?.(stepId) ?? [];
    return {
        // R1 (12:05 PST): each boundary event lit while its handler's transition is among the last four.
        marks: marks.map(mark => {
            const on = litOf(lit, mark.key);
            return { ...mark, litCount: on?.count ?? 0, litAge: on?.age ?? null, visited: run ? lit.visited.has(mark.key) : null,
                hover: hoverEnd !== null && mark.end === hoverEnd };
        }),
        chips: chips.map(of),
    };
}

/**
 * How a line is drawn now (replay, R5): `litCount`, `litAge`, `visited` (null outside a run), `hover` (it leads into the
 * Ends row's hovered end) and `tag`, the shown transition's words when it took this line and the line has no label of its
 * own. Pure.
 */
export function workflowEdgeShown(edge, lit = null, hoverEnd = null) {
    const key = edge.key ?? workflowGraphEdgeKey(edge.from, edge.to);
    const on = litOf(lit, key);
    const shown = lit?.transition ?? null;
    return { litCount: on?.count ?? 0, litAge: on?.age ?? null, visited: lit?.visited instanceof Set ? lit.visited.has(key) : null,
        hover: hoverEnd !== null && edge.to === hoverEnd,
        tag: shown?.edgeKey === key && !edge.labelText && typeof shown.words === "string" && shown.words ? shown.words : null };
}

/**
 * A parallel step's join bar as drawn now (replay): lit while a transition that left the parallel step (a line from its
 * bar, one of its error handlers or end chips) is among the last four, at the newest one's age; `current` when the
 * transition shown left it. Pure.
 */
export function workflowJoinShown(layout, parallelId, lit = null) {
    const bar = workflowJoinId(parallelId);
    const keys = [...(layout?.edges ?? []).filter(edge => edge.from === bar).map(edge => edge.key ?? workflowGraphEdgeKey(edge.from, edge.to)),
        ...(layout?.handlers?.get?.(parallelId) ?? []).map(handler => handler.key), ...(layout?.chips?.get?.(parallelId) ?? []).map(chip => chip.key)];
    let litCount = 0;
    let litAge = null;
    for (const key of keys) {
        const on = litOf(lit, key);
        if (!on) continue;
        litCount += on.count;
        litAge = litAge === null ? on.age : Math.min(litAge, on.age);
    }
    const shown = lit?.transition ?? null;
    return { litCount, litAge, current: Boolean(shown && shown.fromStateId === parallelId && keys.includes(shown.edgeKey)) };
}

/**
 * A lane's pill as it stands (B3): its name and, from its steps' views (`byId`, as of the moment shown), its state:
 * the end it reached ("ended", "not started": the end's name without the lane's prefix), "running" while one of its
 * steps runs, "failed" when a step failed with no route on (the branch ended there), "cancelled" when it was stopped,
 * else nothing (not started yet). `lit` lights it while its first visit is among the last four. Pure.
 */
export function workflowLanePill(parallelId, pill, members, byId, lit = null) {
    const views = (Array.isArray(members) ? members : []).map(id => byId.get(id)).filter(Boolean);
    const words = id => workflowOutcomePlain(id.startsWith(`${pill.name}_`) ? id.slice(pill.name.length + 1) : id);
    const ended = views.find(view => view.type === "terminal" && ["done", "failed", "cancelled"].includes(view.state));
    const running = views.find(view => view.type !== "terminal" && view.state === "running");
    const stopped = ended || running ? null : views.find(view => view.type !== "terminal" && (view.state === "failed" || view.state === "cancelled"));
    const status = ended ? words(ended.id) : running ? "running" : stopped ? stopped.state : null;
    const tone = ended ? (ended.outcome === "failed" || ended.state === "failed" ? "red" : ended.outcome === "succeeded" ? "green" : "amber")
        : running ? "blue" : stopped ? (stopped.state === "failed" ? "red" : "amber") : null;
    const on = litOf(lit, `lane:${parallelId}:${pill.name}`);
    return { ...pill, text: status ? `${pill.name} · ${status}` : pill.name, status, tone,
        title: ended ? `Branch ${pill.name} ended at ${ended.id}` : running ? `Branch ${pill.name}: ${running.id} is running`
            : stopped ? (stopped.state === "failed" ? `Branch ${pill.name} ended unsuccessfully: ${stopped.id} failed and has no route on`
                : `Branch ${pill.name} was cancelled at ${stopped.id}`) : `Branch ${pill.name}`,
        litCount: on?.count ?? 0, litAge: on?.age ?? null };
}

/** A lit part's level as drawn: "1" taken once among the four, "2" twice or more (two levels only). */
export function workflowLitLevel(lit) {
    return lit && lit.count >= 2 ? "2" : lit ? "1" : null;
}
