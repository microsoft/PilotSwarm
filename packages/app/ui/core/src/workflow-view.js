import { annotateWorkflowV2Edges, projectWorkflowV2, workflowShape, workflowV2Definition } from "./workflow-v2-view.js";

export * from "./workflow-v2-view.js";

/**
 * Read-only workflow view data. Execution and its durable events are unchanged.
 * A workflow v2 payload returns `{ shape: "v2", ... }`; a legacy payload keeps
 * its original result, which has no `shape`.
 */
export function workflowDefinition(data) {
    if (workflowShape(data) === "v2") return workflowV2Definition(data);
    if (!Array.isArray(data?.states)) throw new Error("The workflow definition has no steps.");
    const states = data.states;
    if (!states.length) throw new Error("The workflow definition has no steps.");
    const ids = new Set();
    for (const node of states) {
        if (!node || typeof node.id !== "string" || !node.id
            || (node.type !== "script" && node.type !== "terminal")) {
            throw new Error("The workflow definition contains an invalid or unsupported step.");
        }
        if (ids.has(node.id)) throw new Error(`The workflow definition repeats step '${node.id}'.`);
        ids.add(node.id);
    }
    const initial = data.initial || states[0].id;
    if (!ids.has(initial)) throw new Error("The workflow's first step is not defined.");
    for (const node of states) {
        if (node.next != null && (typeof node.next !== "object" || Array.isArray(node.next))) {
            throw new Error(`Step '${node.id}' has invalid next steps.`);
        }
        for (const target of Object.values(node.next || {})) {
            if (!ids.has(target)) throw new Error(`Step '${node.id}' leads to a step that is not defined.`);
        }
    }
    return { name: data.name, version: data.version, initial, states };
}

/**
 * Node views for the graph. `options.readModel` is the object that
 * `readWorkflowV2View` returns; only a v2 definition reads it.
 */
export function workflowNodeViews(definition, events = [], live = null, options = {}) {
    if (!definition) return [];
    if (definition.shape === "v2") return projectWorkflowV2({ definition, events, readModel: options?.readModel ?? null }).nodes;
    const terminal = events.findLast(event => ["workflow.completed", "workflow.failed", "workflow.cancelled"].includes(event?.eventType));
    return definition.states.map(node => {
        const history = events.filter(event => event?.data?.stateId === node.id
            && String(event.eventType).startsWith("workflow."));
        const latest = history.at(-1);
        const result = history.findLast(event => event.eventType !== "workflow.state_started");
        const snapshot = live?.nodes?.[node.id];
        const attempts = new Set(history.filter(event => Number.isSafeInteger(event.data.step))
            .map(event => event.data.step)).size || (node.type === "terminal" && latest ? 1 : 0);
        const eventState = latest?.eventType === "workflow.state_started" ? "running"
            : latest?.eventType === "workflow.state_completed"
                ? (latest.data.exitCode === 0 || ["reported", "stdout"].includes(latest.data.resultSource) ? "done" : "failed")
            : latest?.eventType?.endsWith("failed") ? "failed"
                : latest?.eventType?.endsWith("cancelled") ? "cancelled"
                    : latest ? "done" : "idle";
        // Canvas ticks are best-effort. A newer durable event must not leave
        // the graph displaying an older running state or result.
        const eventIsNewer = latest && (!snapshot
            || Number(latest.data.step ?? latest.data.steps) >= Number(live?.step || 0));
        const newAttempts = snapshot ? new Set(history.filter(event =>
            Number.isSafeInteger(event.data.step) && event.data.step > Number(live.step || 0))
            .map(event => event.data.step)).size : 0;
        let state = eventIsNewer ? eventState : snapshot?.state || eventState;
        if (state === "running" && terminal) state = terminal.eventType === "workflow.completed" ? "done" : "cancelled";
        const outcome = eventIsNewer
            ? result?.data?.outcome ?? snapshot?.lastOutcome
            : snapshot?.lastOutcome ?? result?.data?.outcome;
        const durationMs = eventIsNewer
            ? result?.data?.durationMs ?? snapshot?.lastDurationMs
            : snapshot?.lastDurationMs ?? result?.data?.durationMs;
        return {
            ...node,
            state,
            runs: node.type === "terminal" && latest ? 1 : snapshot ? snapshot.runs + newAttempts : attempts,
            partial: !snapshot,
            outcome: outcome ?? (node.type === "terminal" ? node.outcome : undefined),
            durationMs,
            result: result?.data || null,
            history: history.filter(event => event.eventType !== "workflow.state_started").slice(-40).reverse(),
        };
    });
}

/** Keep graph topology independent of the viewport; narrow views pan or zoom. */
export function layoutWorkflowGraph(definition, availableWidth = 640) {
    const nodes = definition?.states || [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    // A parallel state (workflow v2, IR 8) also leads to its body's first state: each branch starts there.
    const branchStart = node => node?.type === "parallel" && typeof node.body?.initial === "string" && byId.has(node.body.initial) ? node.body.initial : null;
    const successors = id => [...new Set([...Object.values(byId.get(id)?.next || {}), ...(branchStart(byId.get(id)) ? [branchStart(byId.get(id))] : [])])]
        .filter(target => byId.has(target));
    const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), component = new Map();
    let nextIndex = 0, componentCount = 0;
    // Collapse cycles before ranking so reconverging DAG paths retain their
    // depth, without iterating forever on loops.
    const visit = id => {
        indices.set(id, nextIndex); low.set(id, nextIndex++);
        stack.push(id); onStack.add(id);
        for (const target of successors(id)) {
            if (!indices.has(target)) {
                visit(target);
                low.set(id, Math.min(low.get(id), low.get(target)));
            } else if (onStack.has(target)) {
                low.set(id, Math.min(low.get(id), indices.get(target)));
            }
        }
        if (low.get(id) === indices.get(id)) {
            let member;
            do {
                member = stack.pop(); onStack.delete(member); component.set(member, componentCount);
            } while (member !== id);
            componentCount++;
        }
    };
    for (const node of nodes) if (!indices.has(node.id)) visit(node.id);
    const outgoing = Array.from({ length: componentCount }, () => new Set());
    const indegree = Array(componentCount).fill(0), componentRank = Array(componentCount).fill(0);
    for (const node of nodes) for (const target of successors(node.id)) {
        const from = component.get(node.id), to = component.get(target);
        if (from !== to && !outgoing[from].has(to)) { outgoing[from].add(to); indegree[to]++; }
    }
    const queue = indegree.flatMap((degree, id) => degree === 0 ? [id] : []);
    for (let i = 0; i < queue.length; i++) for (const to of outgoing[queue[i]]) {
        componentRank[to] = Math.max(componentRank[to], componentRank[queue[i]] + 1);
        if (--indegree[to] === 0) queue.push(to);
    }
    const ranks = new Map(nodes.map(node => [node.id, componentRank[component.get(node.id)]]));
    const edges = [];
    const pairs = new Map();
    for (const node of nodes) {
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
        const start = branchStart(node);
        if (start && !pairs.has(JSON.stringify([node.id, start]))) {
            const edge = { from: node.id, to: start, outcome: "each branch", outcomes: [], branch: true };
            pairs.set(JSON.stringify([node.id, start]), edge);
            edges.push(edge);
        }
    }
    const nodeWidth = 202, nodeHeight = 66, gap = 100, margin = 40;
    const rows = Array.from({ length: Math.max(0, ...ranks.values()) + 1 },
        (_, rank) => nodes.filter(node => ranks.get(node.id) === rank));
    const rowEdges = rows.map((_, rank) => edges.filter(edge => ranks.get(edge.from) === rank));
    const outerEdges = edges.filter(edge => ranks.get(edge.to) !== ranks.get(edge.from) + 1);
    const arrivals = rows.map((_, rank) => outerEdges.filter(edge => ranks.get(edge.to) === rank));
    const contentWidth = Math.max(300, availableWidth,
        Math.max(1, ...rows.map(row => row.length)) * (nodeWidth + gap) - gap + margin * 2);
    const width = contentWidth + (outerEdges.length ? outerEdges.length * 22 + 60 : 0);
    const positions = new Map();
    let y = 40 + arrivals[0].length * 20;
    rows.forEach((row, rank) => {
        const left = (contentWidth - (row.length * nodeWidth + Math.max(0, row.length - 1) * gap)) / 2;
        row.forEach((node, index) => positions.set(node.id, {
            x: left + index * (nodeWidth + gap), y, width: nodeWidth, height: nodeHeight,
        }));
        y += nodeHeight + Math.max(100, (rowEdges[rank].length + (arrivals[rank + 1]?.length || 0)) * 20 + 48);
    });
    for (const edge of edges) {
        const from = positions.get(edge.from), to = positions.get(edge.to);
        const siblings = edges.filter(item => item.from === edge.from);
        const incoming = edges.filter(item => item.to === edge.to);
        const sx = from.x + nodeWidth * (siblings.indexOf(edge) + 1) / (siblings.length + 1);
        const tx = to.x + nodeWidth * (incoming.indexOf(edge) + 1) / (incoming.length + 1);
        const track = from.y + nodeHeight + 24 + rowEdges[ranks.get(edge.from)].indexOf(edge) * 20;
        const outside = outerEdges.indexOf(edge);
        const arrival = to.y - 24 - arrivals[ranks.get(edge.to)].indexOf(edge) * 20;
        // Skip/back edges travel outside every node column. Their segments
        // cannot masquerade as an outgoing edge from an intervening terminal.
        const points = outside < 0
            ? [[sx, from.y + nodeHeight], [sx, track], [tx, track], [tx, to.y]]
            : [[sx, from.y + nodeHeight], [sx, track], [contentWidth + 22 + outside * 22, track],
                [contentWidth + 22 + outside * 22, arrival], [tx, arrival], [tx, to.y]];
        edge.points = points;
        edge.path = points.map(([x, yy], i) => `${i ? "L" : "M"}${x},${yy}`).join(" ");
        edge.labelX = outside < 0 ? (sx + tx) / 2 : (sx + points[2][0]) / 2;
        edge.labelY = track - 5;
    }
    const layout = { width, height: Math.max(150, y), positions, edges };
    return definition?.shape === "v2" ? annotateWorkflowV2Edges(definition, layout) : layout;
}

export function workflowLogBounds(availableHeight, requested = 210) {
    const min = 100;
    const max = Math.max(min, Math.floor(availableHeight) - 162);
    return { min, max, height: Math.max(min, Math.min(max, requested)) };
}

/**
 * The workflow view's v2 read models for its current run selection
 * (`selectedRunId`, null for the live run), shaped as projectWorkflowV2
 * takes them: `readModel` and its watermark only when they were read for
 * that selection (a model read for another run is never overlaid), and
 * `workflowModel`, the last model read for any selection, whose
 * workflow-wide parts (the graph or that there is none, the definition, the
 * revision, the runs) stay authoritative while the selection's own model is
 * loading or failed; and the failure of that selection's last request, if
 * any. A legacy (version 1) definition has no read model, so no failure is
 * shown for it.
 */
export function workflowReadModelView(view = {}) {
    const selection = view.selectedRunId ?? null;
    const own = view.readModel != null && (view.readModelRunId ?? null) === selection;
    const legacy = view.definition != null && view.definition.shape !== "v2";
    const attempted = view.readModelAttempt != null && (view.readModelAttempt.runId ?? null) === selection;
    return {
        selectedRunId: selection,
        readModel: own ? view.readModel : null,
        readModelAfterSeq: own && Number.isSafeInteger(view.readModelAfterSeq) ? view.readModelAfterSeq : null,
        workflowModel: !legacy && view.readModel != null ? view.readModel : null,
        error: !legacy && attempted && typeof view.readModelError === "string" && view.readModelError ? view.readModelError : null,
    };
}

const detailText = value => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * What the session details box shows for a workflow session (batch 8, d-1) instead of a chat's model, context, cron and
 * agent rows: from what the portal already holds, the session row and, once the workflow screen has read them, the
 * workflow's view (its last read model, else its definition). Nothing is fetched for it. Each value is a string, or null
 * when it is not loaded (the box shows "—"):
 * - `workflow`: its name and version (the read model's revision name and semver, else the definition's), else the title
 *   without its "Workflow: " prefix;
 * - `revision`: "N · draft" or "N · published" (the published revision of a published workflow);
 * - `run`: the live run's status and outcome, "No run yet" before any run, "No live run yet" when only test runs exist;
 * - `steps`: how many steps its graph has;
 * - `startedBy`: { sessionId, title } of the parent session (title null when its row is not loaded), or null for a
 *   workflow a person started.
 * Pure.
 */
export function workflowSessionDetails(state, session) {
    const sessionId = typeof session?.sessionId === "string" ? session.sessionId : null;
    const view = sessionId ? state?.ui?.workflowViews?.[sessionId] ?? null : null;
    const model = view ? workflowReadModelView(view).workflowModel : null;
    const definition = view?.definition ?? null;
    const name = detailText(model?.revision?.name) ?? detailText(definition?.name)
        ?? detailText(String(session?.title ?? "").replace(/^Workflow:\s*/u, ""));
    const version = detailText(model?.definition?.semver) ?? detailText(definition?.version);
    const lifecycle = model?.definition?.state;
    const number = lifecycle === "published" ? model.definition.publishedRevision : model?.definition?.currentRevision;
    const revision = (lifecycle === "draft" || lifecycle === "published") && Number.isSafeInteger(number) ? `${number} · ${lifecycle}`
        : lifecycle === "deleted" ? "deleted" : null;
    const runs = Array.isArray(model?.runs) ? model.runs.filter(run => run && typeof run === "object") : null;
    const live = runs ? runs.find(run => run.mode === "live") ?? null : null;
    const run = live ? [detailText(live.status) ?? "unknown", detailText(live.outcome)].filter(Boolean).join(" · ")
        : runs ? (runs.length ? "No live run yet" : "No run yet") : null;
    const states = Array.isArray(model?.graph?.states) ? model.graph.states : Array.isArray(definition?.states) ? definition.states : null;
    const parentId = typeof session?.parentSessionId === "string" && session.parentSessionId ? session.parentSessionId : null;
    const parent = parentId ? state?.sessions?.byId?.[parentId] ?? null : null;
    return {
        workflow: name ? (version ? `${name} ${version}` : name) : null,
        revision,
        run,
        steps: states ? String(states.length) : null,
        startedBy: parentId ? { sessionId: parentId, title: detailText(parent?.title) } : null,
    };
}

/**
 * The workflow an agent session runs a step of (batch 8, d-1: a "Workflow step" session's details say "Step of"): its
 * direct parent, when that is a workflow session, as { sessionId, title }; else null. Pure.
 */
export function workflowStepParent(state, session) {
    const parentId = typeof session?.parentSessionId === "string" && session.parentSessionId ? session.parentSessionId : null;
    if (!parentId || session?.sessionKind === "workflow" || session?.isGroup) return null;
    const parent = state?.sessions?.byId?.[parentId] ?? null;
    return parent?.sessionKind === "workflow" ? { sessionId: parentId, title: detailText(parent.title) } : null;
}

/** The view of a workflow the portal has not read anything for yet: one object, so selections of it compare equal. */
export const EMPTY_WORKFLOW_VIEW = Object.freeze({});

/**
 * Whether a workflow's parent agent is working (owner batch 7, H1): its session row (`parent`) is in a turn, as the
 * session list shows it (its steadied status, else its status, is "running"). A wait, a schedule or an idle session
 * is not working. Pure.
 */
export function workflowParentWorking(parent) {
    return (parent?.rowVisualStatus || parent?.status) === "running";
}

/**
 * Everything the workflow screen shows for the active session, read from one state in one selector (adversarial review
 * UI-1): the session's id and its row, history, canvas, workflow view and saved step places, and whether its parent
 * agent is working (H1). Each part is derived from the same id, so a render never pairs one session's id with another's
 * view (separate selectors, each closing over the id of the last render, did: a newly selected workflow's YAML editor
 * could start with the previous one's YAML). Pure.
 */
export function selectWorkflowViewSnapshot(state) {
    const sessionId = state?.sessions?.activeSessionId ?? null;
    const session = sessionId ? state.sessions.byId?.[sessionId] : undefined;
    const parentId = typeof session?.parentSessionId === "string" && session.parentSessionId ? session.parentSessionId : null;
    return {
        sessionId,
        session,
        history: sessionId ? state.history?.bySessionId?.get?.(sessionId) : undefined,
        canvas: sessionId ? state.canvas?.bySessionId?.[sessionId] : undefined,
        view: (sessionId ? state.ui?.workflowViews?.[sessionId] : null) || EMPTY_WORKFLOW_VIEW,
        places: (sessionId ? state.ui?.workflowLayouts?.[`session:${sessionId}`]?.steps : null) ?? null,
        parentWorking: parentId ? workflowParentWorking(state.sessions.byId?.[parentId]) : false,
    };
}

/** Whether two snapshots (selectWorkflowViewSnapshot) hold the same parts. */
export function workflowViewSnapshotEqual(a, b) {
    return a === b || (Boolean(a) && Boolean(b) && a.sessionId === b.sessionId && a.session === b.session && a.history === b.history
        && a.canvas === b.canvas && a.view === b.view && a.places === b.places && a.parentWorking === b.parentWorking);
}

/**
 * The run a workflow's step log shows (adversarial review UI-8): the run the person chose, else the run the workflow's
 * last read model shows (its live run); null for a workflow with no runs read (a version 1 workflow's log is not
 * filtered). Pure.
 */
export function workflowStepLogRunId(view) {
    if (!view || typeof view !== "object") return null;
    if (typeof view.selectedRunId === "string" && view.selectedRunId) return view.selectedRunId;
    const model = workflowReadModelView(view).workflowModel;
    const runId = model?.run?.runId;
    return typeof runId === "string" && runId ? runId : null;
}

/**
 * A workflow session's history for its step log (UI-8): only the entries of `runId`, and every entry that names no run
 * (the session's own notices). The same history object when nothing is left out, or no run is chosen. Pure.
 */
export function workflowStepLogHistory(history, runId) {
    if (!runId || !history || !Array.isArray(history.chat)) return history;
    const chat = history.chat.filter(item => !item?.workflowRunId || item.workflowRunId === runId);
    return chat.length === history.chat.length ? history : { ...history, chat };
}
