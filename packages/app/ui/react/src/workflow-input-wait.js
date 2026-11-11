import React from "react";
import { WORKFLOW_INPUT_CHECKING_TEXT, WORKFLOW_INPUT_CHECK_FAILED_TEXT } from "../../core/src/workflow-tui.js";

const h = React.createElement;

/**
 * Whether a portal composer waits for the server's word on people's input (owner decision q18): for a session that may
 * be in a workflow agent state's subtree (its loaded parents say it may: workflowInputPolicyApplies), on a deployment
 * that can tell (getSessionAccess), until the access read for that session answers: "checking", or "failed" when it
 * could not be read. Any other session keeps its message box at once, so ordinary sessions never flicker. `read` is
 * the composer's access read: `{ access, answered, failed }` for the session shown. Pure.
 */
export function workflowInputWait(controller, mayBeWorkflowStep, { access, answered, failed }) {
    if (!mayBeWorkflowStep || typeof controller?.transport?.getSessionAccess !== "function" || access) return null;
    return failed ? "failed" : answered ? null : "checking";
}

/** What the composer shows instead of the message box while it waits: the check, or its failure with Retry. */
export function WorkflowInputWait({ wait, onRetry }) {
    return wait === "failed"
        ? h("div", { className: "ps-composer-readonly", role: "alert" }, WORKFLOW_INPUT_CHECK_FAILED_TEXT, " ",
            h("button", { type: "button", className: "ps-mini-button", onClick: onRetry }, "Retry"))
        : h("div", { className: "ps-composer-readonly", role: "status", "aria-live": "polite" }, WORKFLOW_INPUT_CHECKING_TEXT);
}
