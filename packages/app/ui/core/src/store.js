export function createStore(reducer, initialState) {
    let state = initialState;
    const listeners = new Set();

    return {
        getState() {
            return state;
        },
        dispatch(action) {
            const nextState = reducer(state, action);
            if (Object.is(nextState, state)) {
                return action;
            }
            state = nextState;
            // One failing listener must not starve the rest (outbox
            // reconciliation, renderers); its error is still reported.
            for (const listener of listeners) {
                try {
                    listener(state, action);
                } catch (error) {
                    console.error("[store] listener failed", error);
                }
            }
            return action;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
