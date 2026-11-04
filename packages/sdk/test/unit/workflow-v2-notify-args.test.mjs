import test from "node:test";
import assert from "node:assert/strict";
import { parseRunCommandArgs, parseUpdateWorkflowArgs } from "../../dist/workflow/v2/tools.js";

// Batch 7 (n-1): a live start (publish_and_start, start) tells the parent the run's result unless notify_on_completion
// is false; any other operation that names notify_on_completion is refused, never ignored.

const BASE = { workflow_id: "wf-1", operation_id: "op-1" };
const refused = (fn, pattern) => assert.throws(fn, error => error?.code === "WORKFLOW_COMMAND_INVALID" && pattern.test(error.message));

test("a live start tells the parent unless notify_on_completion is false", () => {
    const start = args => parseUpdateWorkflowArgs({ ...BASE, operation: "start", definition_hash: "h", inputs: {}, ...args }).command;
    assert.equal(start({}).notifyParent, true);
    assert.equal(start({ notify_on_completion: null }).notifyParent, true);
    assert.equal(start({ notify_on_completion: true }).notifyParent, true);
    assert.equal(start({ notify_on_completion: false }).notifyParent, false);
    const both = args => parseUpdateWorkflowArgs({ ...BASE, operation: "publish_and_start", expected_revision: 1, definition_hash: "h", inputs: {}, ...args }).command;
    assert.equal(both({}).notifyParent, true);
    assert.equal(both({ notify_on_completion: false }).notifyParent, false);
});

test("notify_on_completion must be true or false", () => {
    for (const value of ["false", 0, 1, {}, []]) {
        refused(() => parseUpdateWorkflowArgs({ ...BASE, operation: "start", definition_hash: "h", inputs: {}, notify_on_completion: value }),
            /^notify_on_completion must be true or false\.$/);
    }
});

test("notify_on_completion on publish, replace_definition or a run command is refused", () => {
    refused(() => parseUpdateWorkflowArgs({ ...BASE, operation: "publish", expected_revision: 1, definition_hash: "h", notify_on_completion: false }),
        /applies to publish_and_start and start only/);
    refused(() => parseUpdateWorkflowArgs({ ...BASE, operation: "replace_definition", expected_revision: 1, yaml: "x", notify_on_completion: true }),
        /applies to publish_and_start and start only/);
    for (const args of [
        { operation: "set_vars", set: { a: 1 }, expected_kv_revision: 1 },
        { operation: "pause" }, { operation: "resume" }, { operation: "cancel" },
    ]) {
        for (const value of [false, true]) {
            refused(() => parseRunCommandArgs({ ...BASE, ...args, notify_on_completion: value }), /applies to publish_and_start and start only/);
        }
        // Without it the command is as before.
        assert.equal(parseRunCommandArgs({ ...BASE, ...args }).command.operation, args.operation);
    }
    refused(() => parseRunCommandArgs({ ...BASE, operation: "stop", notify_on_completion: false }, { stop: true }), /applies to publish_and_start and start only/);
});
