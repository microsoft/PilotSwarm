/**
 * Owner 2026-11-09T03:37Z (the timeline as a viewing mode): "as a workflow is executing, the last four transitions need to
 * be visually lit up. if the transitions are already lit up then they need to be double lit". One model for both graph
 * renderers (React Flow and the plain picture); the terminal UI draws no graph, so it has none of this.
 *
 * workflowV2Transitions: how each loaded visit was entered, in the timeline's order (workflowV2ReplayFrames).
 * workflowV2LitTransitions: the last four of them up to the visit shown, by edge and by step, each with how often it was
 * taken among the four and how long ago (0 the newest).
 */
import { workflowGraphBodies, workflowGraphEdgeKey, workflowGraphEdgeKeys, workflowGroupId, workflowJoinId } from "./workflow-graph-layout.js";
import { workflowV2ReplayFrames, workflowV2VisitScope } from "./workflow-v2-view.js";

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
 * Each loaded visit's entry, in the timeline's order (entry time, then visit number, then id: workflowV2ReplayFrames):
 * { nodeExecutionId, fromStateId, toStateId, edgeKey }. The step it came from: its predecessor (`predecessorId`, which
 * read_workflow gives a branch's visits) when that visit is loaded; none for a catch-all's arrival (`catchAll`: the step
 * only, no line); else the visit before it in its own scope (the root's chain; each branch its own); a branch's first visit
 * came from its parallel visit; the run's first visit from none. `edgeKey` is the graph's line it took
 * (workflowGraphEdgeKey), or null where the graph draws none: a route out of a parallel step drawn as a box leaves from
 * its join bar, and a branch's first visit is entered by the line into its lane or box; a line into a join bar is never
 * one (a join is not a visit). `definition`: the graph the lines are drawn from. Pure.
 */
export function workflowV2Transitions(executions, definition) {
    const list = (Array.isArray(executions) ? executions : []).filter(item => isRecord(item) && typeof item.id === "string");
    const byId = new Map(list.map(item => [item.id, item]));
    const states = Array.isArray(definition?.states) ? definition.states : [];
    const { bodies } = workflowGraphBodies(states);
    const keys = workflowGraphEdgeKeys(definition);
    const lineOf = (from, to) => {
        if (from === null) return null;
        const body = bodies.get(from);
        const intoBody = Array.isArray(body) && body.includes(to);
        const candidates = intoBody ? [[from, to], [from, workflowGroupId(from)]]
            : body ? [[workflowJoinId(from), to], [from, to]] : [[from, to]];
        for (const [a, b] of candidates) {
            const key = workflowGraphEdgeKey(a, b);
            if (keys.has(key)) return key;
        }
        return null;
    };
    const lastInScope = new Map();
    return workflowV2ReplayFrames(list).map(frame => {
        const execution = byId.get(frame.nodeExecutionId);
        const scope = workflowV2VisitScope(execution);
        let fromStateId = null;
        if (execution.catchAll === true) fromStateId = null;
        else if (typeof execution.predecessorId === "string" && byId.has(execution.predecessorId)) fromStateId = byId.get(execution.predecessorId).stateId;
        else if (lastInScope.has(scope)) fromStateId = lastInScope.get(scope);
        else if (scope !== "root") fromStateId = byId.get(parallelVisitOf(execution, scope))?.stateId ?? null;
        lastInScope.set(scope, frame.stateId);
        return { nodeExecutionId: frame.nodeExecutionId, fromStateId, toStateId: frame.stateId, edgeKey: lineOf(fromStateId, frame.stateId) };
    });
}

/**
 * The last `limit` transitions (WORKFLOW_LIT_TRANSITIONS) up to and including the one at `uptoIndex` (null: the newest),
 * counted across every branch in the timeline's order: `edges` (edge key) and `nodes` (step id), each -> { count, age }
 * where `count` is how often it was taken among them and `age` how many transitions ago it was last taken (0 the newest);
 * `current`, the step of the transition shown (null when there is none). Pure.
 */
export function workflowV2LitTransitions(transitions, uptoIndex = null, limit = WORKFLOW_LIT_TRANSITIONS) {
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
    return { edges, nodes, current: list[upto].toStateId };
}

/** A lit part's level as drawn: "1" taken once among the four, "2" twice or more (two levels only). */
export function workflowLitLevel(lit) {
    return lit && lit.count >= 2 ? "2" : lit ? "1" : null;
}
