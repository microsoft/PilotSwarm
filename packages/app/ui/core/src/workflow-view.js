/** Read-only workflow view data. Execution and its durable events are unchanged. */
export function workflowDefinition(data) {
    if (!Array.isArray(data?.states)) throw new Error("The workflow definition has no states.");
    const states = data.states.filter(node => node && typeof node.id === "string"
        && (node.type === "script" || node.type === "terminal"));
    if (!states.length) throw new Error("The workflow definition has no supported states.");
    return { name: data.name, version: data.version, initial: data.initial || states[0].id, states };
}

export function workflowNodeViews(definition, events = [], live = null) {
    if (!definition) return [];
    return definition.states.map(node => {
        const history = events.filter(event => event?.data?.stateId === node.id
            && String(event.eventType).startsWith("workflow."));
        const latest = history.at(-1);
        const result = history.findLast(event => event.eventType !== "workflow.state_started");
        const snapshot = live?.nodes?.[node.id];
        const attempts = new Set(history.filter(event => Number.isSafeInteger(event.data.step))
            .map(event => event.data.step)).size || (node.type === "terminal" && latest ? 1 : 0);
        const state = snapshot?.state || (latest?.eventType === "workflow.state_started" ? "running"
            : latest?.eventType?.endsWith("failed") ? "failed"
                : latest?.eventType?.endsWith("cancelled") ? "cancelled"
                    : latest ? "done" : "idle");
        return {
            ...node,
            state,
            runs: snapshot?.runs ?? attempts,
            partial: !snapshot,
            outcome: snapshot?.lastOutcome ?? result?.data?.outcome ?? (node.type === "terminal" ? node.outcome : undefined),
            durationMs: snapshot?.lastDurationMs ?? result?.data?.durationMs,
            result: result?.data || null,
            history: history.filter(event => event.eventType !== "workflow.state_started").slice(-40).reverse(),
        };
    });
}

/** Layer transitions, wrapping wide branches instead of shrinking phone labels. */
export function layoutWorkflowGraph(definition, availableWidth = 640) {
    const nodes = definition?.states || [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const ranks = new Map();
    const queue = byId.has(definition?.initial) ? [definition.initial] : [];
    if (queue.length) ranks.set(queue[0], 0);
    for (let i = 0; i < queue.length; i++) {
        for (const target of Object.values(byId.get(queue[i])?.next || {})) {
            if (byId.has(target) && !ranks.has(target)) {
                ranks.set(target, ranks.get(queue[i]) + 1);
                queue.push(target);
            }
        }
    }
    let lastRank = Math.max(0, ...ranks.values()) + 1;
    for (const node of nodes) if (!ranks.has(node.id)) ranks.set(node.id, lastRank);
    const width = Math.max(300, availableWidth);
    const nodeWidth = 202, nodeHeight = 66, gap = 48, margin = 44;
    const columns = Math.max(1, Math.floor((width - margin * 2 + gap) / (nodeWidth + gap)));
    const positions = new Map();
    let y = 28;
    for (let rank = 0; rank <= lastRank; rank++) {
        const row = nodes.filter(node => ranks.get(node.id) === rank);
        for (let offset = 0; offset < row.length; offset += columns) {
            const chunk = row.slice(offset, offset + columns);
            const left = (width - (chunk.length * nodeWidth + (chunk.length - 1) * gap)) / 2;
            chunk.forEach((node, index) => positions.set(node.id, {
                x: left + index * (nodeWidth + gap), y, width: nodeWidth, height: nodeHeight,
            }));
            y += nodeHeight + 78;
        }
    }
    const edges = [];
    for (const node of nodes) {
        const from = positions.get(node.id);
        for (const [outcome, target] of Object.entries(node.next || {})) {
            const to = positions.get(target);
            if (!to) continue;
            let path, labelX, labelY;
            if (target === node.id) {
                const right = from.x + nodeWidth;
                path = `M${right},${from.y + 44} C${right + 48},${from.y + 70} ${right + 48},${from.y - 20} ${right},${from.y + 16}`;
                labelX = from.x + nodeWidth / 2; labelY = from.y + 84;
            } else if (to.y > from.y) {
                const sx = from.x + nodeWidth / 2, sy = from.y + nodeHeight;
                const tx = to.x + nodeWidth / 2;
                const mid = (sy + to.y) / 2;
                path = `M${sx},${sy} C${sx},${mid} ${tx},${mid} ${tx},${to.y}`;
                labelX = (sx + tx) / 2; labelY = mid - 5;
            } else {
                const side = Math.max(from.x, to.x) + nodeWidth + 30;
                path = `M${from.x + nodeWidth},${from.y + 33} H${side} V${to.y + 33} H${to.x + nodeWidth}`;
                labelX = side; labelY = (from.y + to.y) / 2 + 23;
            }
            edges.push({ from: node.id, to: target, outcome, path, labelX, labelY });
        }
    }
    return { width, height: Math.max(150, y - 50), positions, edges };
}
