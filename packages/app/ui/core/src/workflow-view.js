/** Read-only workflow view data. Execution and its durable events are unchanged. */
export function workflowDefinition(data) {
    if (!Array.isArray(data?.states)) throw new Error("The workflow definition has no states.");
    const states = data.states;
    if (!states.length) throw new Error("The workflow definition has no states.");
    const ids = new Set();
    for (const node of states) {
        if (!node || typeof node.id !== "string" || !node.id
            || (node.type !== "script" && node.type !== "terminal")) {
            throw new Error("The workflow definition contains an invalid or unsupported state.");
        }
        if (ids.has(node.id)) throw new Error(`The workflow definition repeats state '${node.id}'.`);
        ids.add(node.id);
    }
    const initial = data.initial || states[0].id;
    if (!ids.has(initial)) throw new Error("The workflow's initial state is not defined.");
    for (const node of states) {
        if (node.next != null && (typeof node.next !== "object" || Array.isArray(node.next))) {
            throw new Error(`State '${node.id}' has invalid transitions.`);
        }
        for (const target of Object.values(node.next || {})) {
            if (!ids.has(target)) throw new Error(`State '${node.id}' has a transition to an undefined state.`);
        }
    }
    return { name: data.name, version: data.version, initial, states };
}

export function workflowNodeViews(definition, events = [], live = null) {
    if (!definition) return [];
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
    const successors = id => [...new Set(Object.values(byId.get(id)?.next || {}))].filter(target => byId.has(target));
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
    return { width, height: Math.max(150, y), positions, edges };
}

export function workflowLogBounds(availableHeight, requested = 210) {
    const min = 100;
    const max = Math.max(min, Math.floor(availableHeight) - 162);
    return { min, max, height: Math.max(min, Math.min(max, requested)) };
}
