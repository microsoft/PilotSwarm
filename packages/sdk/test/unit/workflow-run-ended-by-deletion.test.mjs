/**
 * Review DRR-5: whether a run's stored end is its workflow's deletion. The stored command decides first; the deletion
 * trigger's end (migrations 0090 and 0091) is recognised only in its exact shape, never from a person's reason text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runEndedByDeletion, WORKFLOW_V2_SESSION_DELETED_MESSAGE } from "../../dist/workflow/v2/store.js";

const cancelled = terminalError => ({ status: "cancelled", terminalError });

test("the deletion trigger's own end is a deletion; a delete command's is too", () => {
    assert.equal(runEndedByDeletion(cancelled({ code: "cancelled", message: WORKFLOW_V2_SESSION_DELETED_MESSAGE })), true);
    assert.equal(runEndedByDeletion(cancelled({ code: "cancelled", message: "deleted by the operator",
        details: { command: "delete", requestedBy: null, accepted: true } })), true);
});

test("a cancel, a done or an end before begin whose reason is the deletion's words is not a deletion", () => {
    for (const details of [
        { command: "cancel", requestedBy: null, accepted: true, operationId: "op-1" },
        { command: "done", requestedBy: "parent-1", accepted: true, operationId: "op-2" },
        { command: "cancel", requestedBy: null, beforeBegin: true, operationId: "op-3" },
    ]) {
        assert.equal(runEndedByDeletion(cancelled({ code: "cancelled", message: WORKFLOW_V2_SESSION_DELETED_MESSAGE, details })), false,
            JSON.stringify(details));
    }
});

test("any other shape, or a run that was not cancelled, is not a deletion", () => {
    assert.equal(runEndedByDeletion(cancelled({ code: "cancelled", message: WORKFLOW_V2_SESSION_DELETED_MESSAGE, details: null })), false);
    assert.equal(runEndedByDeletion(cancelled({ code: "cancelled", message: WORKFLOW_V2_SESSION_DELETED_MESSAGE, extra: 1 })), false);
    assert.equal(runEndedByDeletion(cancelled({ code: "timed_out", message: WORKFLOW_V2_SESSION_DELETED_MESSAGE })), false);
    assert.equal(runEndedByDeletion({ status: "failed", terminalError: { code: "cancelled", message: WORKFLOW_V2_SESSION_DELETED_MESSAGE } }), false);
    assert.equal(runEndedByDeletion(cancelled(null)), false);
});
