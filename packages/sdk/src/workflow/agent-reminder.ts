import { COMPLETE_WORKFLOW_NODE_TOOL } from "./agent-node-service.js";

/**
 * Workflow agent states: the reminder a step's child gets when a turn of it would end with nothing pending and its
 * step still open (owner decision Q2, "remind when nothing is pending"). A model that answers its task in prose and never
 * calls complete_workflow_node used to wait silently until the deadline and fail timed_out.
 *
 * The reminder is a corrective run inside the same turn (ManagedSession, as the required-tool correction is): after the
 * turn's own run settles, with nothing pending, the activity's gate (TurnOptions.stepReminder, store.recordAgentReminder)
 * checks the step and records the reminder (raced with the turn's guards and its Stop), and the model gets this text
 * once, with the same tool-call check as its first answer. Nothing is queued: a reminder never reaches the child after
 * its turn. The store's record is the decision to remind; the child's runtime event is recorded only when the reminder
 * is sent.
 *
 * "Nothing pending", as the turn sees it:
 * - the turn would end "completed" after a natural, quiet end of its run: no control tool scheduled a turn end (wait,
 *   cron, cron_at, a question, wait_for_agents, a sub-agent call), no error, no Stop, interrupt or expired guard, and
 *   no steer in flight, unconfirmed or held;
 * - complete_workflow_node was not called in the turn;
 * - the turn did not ask another session a question (send_session_message with expects_response: true) (a1), and its
 *   answer is not a question to its parent ("QUESTION FOR PARENT:", which the orchestration turns into a wait);
 * - no cron or cron_at schedule is active after the turn: the turn's own queued set or cancel, else the session's
 *   published cronActive (read by the gate);
 * - the step is open, the child has no sub-agent at work, and fewer than WORKFLOW_AGENT_MAX_REMINDERS were recorded
 *   (the gate, in the store).
 *
 * Not seen (limits): a message queued for the child while its turn runs (the orchestration takes it after the turn), a
 * wait that a message interrupted (resumed after the turn), and an open question asked in an earlier turn (a2). The soft
 * wording and the limit of reminders per step bound them.
 */

/**
 * The text of a reminder (soft: a model that is still working continues). `cycle` is the open visit's node execution id
 * when the session continues across the state's visits (owner decision agent-node-continue-20261106): its completion must
 * name it.
 */
export function workflowAgentReminderText(stateId: string, cycle?: string): string {
    return `Reminder from the workflow: step '${stateId}' is still open. If you have finished, call ${COMPLETE_WORKFLOW_NODE_TOOL} now `
        + `with your outcome and output${cycle ? ` and node_execution_id ${cycle} (this cycle's)` : ""}. If you are still working, continue.`;
}

/** Whether a turn's events show a question to another session that expects an answer (send_session_message, expects_response). */
export function turnAskedForAnswer(events: unknown): boolean {
    if (!Array.isArray(events)) return false;
    return events.some(event => {
        if (!event || typeof event !== "object") return false;
        const { eventType, data } = event as { eventType?: unknown; data?: unknown };
        if (eventType !== "tool.execution_start" && eventType !== "tool.execution_complete") return false;
        const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
        const name = record.toolName ?? record.name;
        const args = record.arguments ?? record.args;
        return name === "send_session_message" && !!args && typeof args === "object" && (args as Record<string, unknown>).expects_response === true;
    });
}

/**
 * Whether a turn's answer asks its parent a question: a child's answer that begins "QUESTION FOR PARENT:" is a wait for
 * the parent's answer (the orchestration turns it into one).
 */
export function answerAsksParent(content: unknown): boolean {
    return typeof content === "string" && /^QUESTION FOR PARENT:/i.test(content.trim());
}

/**
 * What a turn's queued schedule actions leave: the cron and cron_at tools queue their set or cancel, which the
 * orchestration applies in order after the turn; one schedule slot holds either kind, and a cancel of either kind
 * clears it. "set" or "cancel" for the last of them; null when the turn queued none.
 */
export function turnScheduleEffect(queuedActions: unknown): "set" | "cancel" | null {
    let effect: "set" | "cancel" | null = null;
    if (!Array.isArray(queuedActions)) return effect;
    for (const action of queuedActions) {
        if (!action || typeof action !== "object") continue;
        const { type, action: verb } = action as { type?: unknown; action?: unknown };
        if (type !== "cron" && type !== "cron_at") continue;
        if (verb === "set") effect = "set";
        else if (verb === "cancel") effect = "cancel";
    }
    return effect;
}

/** Whether a session orchestration's published status says a cron or cron_at schedule is active. */
export function publishedScheduleActive(status: unknown): boolean {
    const custom = (status as { customStatus?: unknown } | null | undefined)?.customStatus;
    let parsed: unknown = custom;
    if (typeof custom === "string") {
        try { parsed = JSON.parse(custom); } catch { return false; }
    }
    return !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).cronActive === true;
}
