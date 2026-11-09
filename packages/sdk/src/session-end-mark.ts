/**
 * A person's, a parent's or a Workflow's request to end a session (done or cancel), recorded on that session before the
 * command is sent (TLA+ case limit.cc-g1-end-during-turn). The command waits in the session's queue while one of its turns
 * runs, and the session's orchestration reads Running until that turn ends; this mark says the end was asked meanwhile.
 * A Workflow step that continues its agent session reads it (WorkflowStore.sessionEndRequested): such a session gets no
 * further visit, the next visit starting a new agent session or failing unavailable at once (runtime.ts chatEndedOnItsOwn).
 *
 * It is a catalog session event (session_events), not durable orchestration history: recording it changes no replay. The
 * transcript and activity views show no row for it (ui/core history.js): the end itself already shows there.
 */
export const SESSION_END_REQUESTED_EVENT = "session.end_requested";

/** Record the mark on `sessionId` for the end command `command`; a failure is the caller's (no command without the mark). */
export async function recordSessionEndRequested(
    catalog: { recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void> },
    sessionId: string,
    command: { cmd: string; id: string },
    requestedBy: string | null = null,
): Promise<void> {
    await catalog.recordEvents(sessionId, [{ eventType: SESSION_END_REQUESTED_EVENT,
        data: { cmd: command.cmd, id: command.id, ...(requestedBy ? { requestedBy } : {}) } }]);
}
