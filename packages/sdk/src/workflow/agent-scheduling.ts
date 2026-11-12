import { computeCronAtNextFire, type CronAtSchedule } from "../cron-at.js";
import type { TurnOptions } from "../types.js";

export const WORKFLOW_AGENT_SLEEP_WORDS = "wait, wait_on_worker, cron and cron_at must fit this visit's deadline; "
    + "for a longer delay, complete with the task's sleep outcome so the Workflow can wait between visits. ";

/** Check after reading the captured visit, before a tool queues any delay or schedule. */
export async function workflowScheduleRefusal(
    readDeadline: NonNullable<TurnOptions["controlToolBridge"]>["workflowScheduleDeadline"],
    request: { seconds: number } | { schedule: CronAtSchedule },
): Promise<string | null> {
    if (!readDeadline) return null;
    const { deadlineAt } = await readDeadline();
    const deadline = Date.parse(deadlineAt);
    if (!Number.isFinite(deadline)) throw new Error("The Workflow visit has an invalid scheduling deadline.");
    const now = Date.now();
    const next = "seconds" in request ? now + request.seconds * 1000 : computeCronAtNextFire(request.schedule, now).nextFireAtMs;
    if (!Number.isFinite(next)) throw new Error("The requested Workflow wake time is invalid.");
    return next >= deadline
        ? `Error: this wake would reach or exceed the Workflow visit deadline ${deadlineAt}. Use a shorter wait or schedule, or complete with the task's sleep outcome so the Workflow can wait between visits.`
        : null;
}
