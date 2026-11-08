/**
 * Queueing a workflow's message for its parent session: a v1 child workflow's end and a v2 live run's end notice.
 *
 * The message is queued only while the parent's session orchestration runs (adversarial review WFO-3). For a parent
 * whose orchestration ended, or does not exist, nothing is queued and the caller is told that it was not delivered (a v2
 * notice then records the parent as not told). The parent can still end between the status read and the queueing:
 * duroxide then keeps the message for an instance that no longer runs, nobody reads it, and the caller records the
 * parent as told (a documented limit; verification D-T6).
 */

/** The duroxide client calls the delivery needs. */
export interface WorkflowParentQueue {
    getStatus(instanceId: string): Promise<{ status: string }>;
    enqueueEvent(instanceId: string, queueName: string, data: string): Promise<void>;
}

const ENDED_PARENT_STATUSES = ["Completed", "Failed", "Terminated"];

/**
 * The worker's parent delivery over `client` (the workflow activities' notifyParent). Deployed check DS-2: a parent with
 * no session orchestration (a chat made without a first message starts its orchestration only with that message) is not
 * delivered to, and says `notStarted`: the caller may keep the message for that chat's first turn (a version 2 run's end
 * notice keeps it as a chat note); an ended one is not delivered to.
 */
export function workflowParentNotifier(client: WorkflowParentQueue) {
    return async (parentSessionId: string, prompt: string, sender: { kind: "system"; display: string }, clientMessageId?: string)
        : Promise<{ delivered: boolean; notStarted?: boolean }> => {
        const instanceId = `session-${parentSessionId}`;
        const status = (await client.getStatus(instanceId)).status;
        if (status === "NotFound") return { delivered: false, notStarted: true };
        if (ENDED_PARENT_STATUSES.includes(status)) return { delivered: false };
        await client.enqueueEvent(
            instanceId,
            "messages",
            JSON.stringify({ prompt, sender, ...(clientMessageId ? { clientMessageIds: [clientMessageId] } : {}) }),
        );
        return { delivered: true };
    };
}
