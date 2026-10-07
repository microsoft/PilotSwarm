/**
 * Main chat owns per-session steering intent. Panels mirror it, but an
 * in-flight result still writes to the owner after its panel is disposed.
 */
export function linkSessionSteering(parent, child, sessionId) {
    const dispatchChild = child.dispatch.bind(child);
    parent.steeringResends ??= new Set();
    parent.steeringWithdrawals ??= new Set();
    parent.steeringListLoads ??= new Map();
    child.steeringResends = parent.steeringResends;
    child.steeringWithdrawals = parent.steeringWithdrawals;
    child.steeringListLoads = parent.steeringListLoads;
    let current;
    const sync = () => {
        const entry = parent.getState().steering?.bySessionId?.[sessionId];
        if (entry === current) return;
        current = entry;
        dispatchChild({ type: "steering/sharedSession", sessionId, entry });
    };
    // Seed even an empty store so an old panel cache cannot win over main chat.
    dispatchChild({ type: "steering/sharedSession", sessionId,
        entry: parent.getState().steering?.bySessionId?.[sessionId] });
    current = parent.getState().steering?.bySessionId?.[sessionId];
    child.dispatch = action => {
        if (action.sessionId === sessionId && action.type.startsWith("steering/")) {
            const result = parent.dispatch(action);
            sync();
            return result;
        }
        return dispatchChild(action);
    };
    const unsubscribe = parent.subscribe(sync);
    // Keep the dispatch forwarding closure for already-issued async work.
    // It retains no parent subscription once the view is disposed.
    return () => unsubscribe();
}
