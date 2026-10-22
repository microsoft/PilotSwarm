export async function waitFor(predicate, timeoutMs, stepMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    return predicate();
}

export function waitForStoppedTurn(mgmt, sessionId, turnIndex, timeoutMs) {
    // Activity writeback can be idle before the orchestration persists its
    // stopped event. Both observations share the existing deadline.
    return waitFor(async () => {
        const row = await mgmt._catalog.getSession(sessionId);
        if (row?.state !== "idle") return false;
        const events = await mgmt.getSessionEvents(sessionId);
        return events.some((event) => event.eventType === "session.turn_stopped"
            && event.data?.turnIndex === turnIndex);
    }, timeoutMs);
}
