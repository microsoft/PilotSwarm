/**
 * The lifecycle commands a Workflow's controller reads from its session's command queue, and the cause of an activity
 * failure as a person reads it.
 */

/** The command queue every session listens on; management and parents send `{ type: "cmd" }` here. */
export const WORKFLOW_COMMAND_QUEUE = "messages";

/** duroxide-node prefixes activity errors; the person reading the result needs only the cause. */
const ACTIVITY_ERROR_PREFIX = /^Activity '[^']+' JS execution failed: [A-Za-z]+, (?:[A-Za-z]*Error: )?/;

export function workflowErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(ACTIVITY_ERROR_PREFIX, "");
}

/** A lifecycle command read from the command queue, or null for anything else. */
export function parseWorkflowCommand(raw: unknown): { cmd: "cancel" | "done" | "delete"; reason?: string; requestedBy?: string } | null {
    let message: any = raw;
    if (typeof message === "string") {
        try { message = JSON.parse(message); } catch { return null; }
    }
    if (!message || typeof message !== "object" || message.type !== "cmd") return null;
    if (message.cmd !== "cancel" && message.cmd !== "done" && message.cmd !== "delete") return null;
    const reason = typeof message.args?.reason === "string" && message.args.reason.trim() ? message.args.reason.trim() : undefined;
    const requestedBy = typeof message.requestedBy === "string" && message.requestedBy ? message.requestedBy : undefined;
    return { cmd: message.cmd, ...(reason ? { reason } : {}), ...(requestedBy ? { requestedBy } : {}) };
}
