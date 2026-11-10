/**
 * A person's, a parent's or a Workflow's request to end a session (done or cancel), recorded on that session before the
 * command is sent (TLA+ case limit.cc-g1-end-during-turn). The command waits in the session's queue while one of its turns
 * runs, and the session's orchestration reads Running until that turn ends; this mark says the end was asked meanwhile.
 * A Workflow step that continues its agent session reads it (WorkflowStore.sessionEndRequested): such a session gets no
 * further visit, the next visit starting a new agent session or failing unavailable at once (runtime.ts agentSessionEndedOnItsOwn).
 *
 * It is a catalog session event (session_events), not durable orchestration history: recording it changes no replay. The
 * transcript and activity views show no row for it (ui/core history.js): the end itself already shows there.
 *
 * The mark and the command are two writes (the catalog, then the session's queue). When the command is not queued (its
 * queue write throws, or the asker's process stops between the two), only the mark is left. Review DRR-2: a Workflow that
 * acts on a mark (runtime.ts agentSessionGone: it gives the next visit a new agent session, or decides a visit
 * unavailable) first queues the marked end itself (carryMarkedEnd: the mark's done or cancel, id
 * `workflow-mark-end:<mark id>`, as the session's parent), so an agent session a Workflow stops using always has an end on
 * its way and never stays live beside its replacement. A second end, when the asker's own command was queued too, is
 * never read: the session ends at the first. A mark on a session that no Workflow continues is not acted on and stays
 * inert; the asker saw the error and can ask again. A withdrawal of the mark would not close the gap: a check can read
 * the mark before the withdrawal lands.
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
