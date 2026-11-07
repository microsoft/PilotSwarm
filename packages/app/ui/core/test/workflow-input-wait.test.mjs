// The portal composer of a session that may be in a workflow agent state's subtree waits for the server's word before
// it shows the message box (owner decision q18): "checking" until the access read answers, "failed" with Retry when it
// could not be read; a session known to be outside every workflow, a deployment that cannot tell, and an answered read
// keep today's behaviour. The TUI's side is in workflow-tui-runs-input.test.mjs and tui/test/workflow-input-composer.
//
// Run: node --test packages/app/ui/core/test/workflow-input-wait.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowInputWait, workflowInputWait } from "../../react/src/workflow-input-wait.js";
import { WORKFLOW_INPUT_CHECKING_TEXT, WORKFLOW_INPUT_CHECK_FAILED_TEXT } from "../src/index.js";

const portal = { transport: { getSessionAccess: async () => null } };
const older = { transport: {} };
const ALLOWED = { canWrite: true };

test("only a session that may be a workflow step waits, and only until its own access read answers", () => {
    const cases = [
        [portal, true, { access: null, answered: false, failed: false }, "checking"],
        [portal, true, { access: null, answered: true, failed: true }, "failed"],
        [portal, true, { access: ALLOWED, answered: true, failed: false }, null],
        [portal, true, { access: { canSendPrompt: false }, answered: true, failed: false }, null],
        [portal, true, { access: null, answered: true, failed: false }, null],
        [portal, false, { access: null, answered: false, failed: false }, null],
        [portal, false, { access: null, answered: true, failed: true }, null],
        [older, true, { access: null, answered: false, failed: false }, null],
        [null, true, { access: null, answered: false, failed: false }, null],
    ];
    for (const [controller, mayBe, read, expected] of cases) {
        assert.equal(workflowInputWait(controller, mayBe, read), expected, JSON.stringify({ mayBe, read, controller: Boolean(controller?.transport?.getSessionAccess) }));
    }
});

test("what the composer shows while it waits: the check, then its failure with Retry", () => {
    assert.equal(WORKFLOW_INPUT_CHECKING_TEXT, "Checking whether you can send messages here…");
    assert.equal(WORKFLOW_INPUT_CHECK_FAILED_TEXT, "Could not check whether you can send messages here.");
    assert.equal(renderToStaticMarkup(React.createElement(WorkflowInputWait, { wait: "checking", onRetry() {} })),
        `<div class="ps-composer-readonly" role="status" aria-live="polite">${WORKFLOW_INPUT_CHECKING_TEXT}</div>`);
    assert.equal(renderToStaticMarkup(React.createElement(WorkflowInputWait, { wait: "failed", onRetry() {} })),
        `<div class="ps-composer-readonly" role="alert">${WORKFLOW_INPUT_CHECK_FAILED_TEXT} <button type="button" class="ps-mini-button">Retry</button></div>`);
    // Retry asks again.
    let retried = 0;
    const element = WorkflowInputWait({ wait: "failed", onRetry: () => { retried += 1; } });
    const button = React.Children.toArray(element.props.children).find(child => child?.type === "button");
    button.props.onClick();
    assert.equal(retried, 1);
});
