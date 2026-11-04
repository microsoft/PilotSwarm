// Adversarial review R2-UI-1: the portal's variables panel keeps the KV revision its edit started from. A refresh of the
// same run to a newer revision keeps the edit and says the variables changed since editing began; Set and Remove wait
// until the person loads the new values or keeps the edit (then it is saved over the newer values, at their revision).
// The panel's state is workflowV2VariableEdit (its reducer) and workflowV2VariableEditState (what it may send).
//
// Run: node --test packages/app/ui/core/test/workflow-v2-variable-edit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_V2_VARIABLE_EDIT_EMPTY, workflowV2VariableEdit, workflowV2VariableEditBehind, workflowV2VariableEditState,
} from "../src/workflow-v2-commands.js";

const entries = rev => [{ key: "cfg", valueText: JSON.stringify({ limit: rev }) }, { key: "mode", valueText: '"fast"' }];
const run = (actions, start = WORKFLOW_V2_VARIABLE_EDIT_EMPTY) => actions.reduce(workflowV2VariableEdit, start);

test("an edit keeps the revision it started from across a refresh, and is sent at it; a clean form follows the shown one", () => {
    // Nothing typed: the update would go at the shown revision, and nothing is behind.
    assert.deepEqual(workflowV2VariableEditState(WORKFLOW_V2_VARIABLE_EDIT_EMPTY, 3), { dirty: false, expectedKvRevision: 3, behind: null });
    // Edit copies a listed object at revision 3 and changes it.
    const edit = run([
        { type: "copy", key: "cfg", value: '{"limit":3}', revision: 3 },
        { type: "type", field: "value", text: '{"limit":3,"extra":true}', revision: 3 },
    ]);
    assert.deepEqual(edit, { key: "cfg", value: '{"limit":3,"extra":true}', base: 3 });
    assert.deepEqual(workflowV2VariableEditState(edit, 3), { dirty: true, expectedKvRevision: 3, behind: null });
    // Another person updated cfg (revision 4) and the workflow was read again: the edit stays, and is behind.
    const typedAfter = workflowV2VariableEdit(edit, { type: "type", field: "value", text: '{"limit":3,"extra":false}', revision: 4 });
    assert.equal(typedAfter.base, 3, "typing more does not move the edit to the new revision");
    const state = workflowV2VariableEditState(typedAfter, 4);
    assert.equal(state.expectedKvRevision, 3, "it would be refused, never written over revision 4");
    assert.deepEqual(state.behind, { base: 3, revision: 4, text: "The variables changed since you started editing (revision 3, now 4)." });
    // Keep: the edit stays and is saved over revision 4.
    const kept = workflowV2VariableEdit(typedAfter, { type: "keep", revision: 4 });
    assert.deepEqual(kept, { key: "cfg", value: '{"limit":3,"extra":false}', base: 4 });
    assert.deepEqual(workflowV2VariableEditState(kept, 4), { dirty: true, expectedKvRevision: 4, behind: null });
    // Load: the named variable's value now, at revision 4.
    const reloaded = workflowV2VariableEdit(typedAfter, { type: "reload", entries: entries(4), revision: 4 });
    assert.deepEqual(reloaded, { key: "cfg", value: '{"limit":4}', base: 4 });
    // A name that is not listed keeps what was typed.
    assert.deepEqual(workflowV2VariableEdit({ key: "new", value: "1", base: 3 }, { type: "reload", entries: entries(4), revision: 4 }),
        { key: "new", value: "1", base: 4 });
});

test("typing into a clean form takes the shown revision; emptying it drops the revision; clear empties it", () => {
    const started = run([{ type: "type", field: "key", text: "n", revision: 5 }]);
    assert.deepEqual(started, { key: "n", value: "", base: 5 });
    const emptied = workflowV2VariableEdit(started, { type: "type", field: "key", text: "", revision: 6 });
    assert.deepEqual(emptied, { key: "", value: "", base: null });
    const again = workflowV2VariableEdit(emptied, { type: "type", field: "value", text: "1", revision: 6 });
    assert.equal(again.base, 6);
    assert.deepEqual(workflowV2VariableEdit(again, { type: "clear" }), WORKFLOW_V2_VARIABLE_EDIT_EMPTY);
    // An unknown action, and a refresh (no action at all), change nothing.
    assert.deepEqual(workflowV2VariableEdit(again, { type: "refresh", revision: 9 }), again);
});

test("behind only when both revisions are known and differ", () => {
    assert.equal(workflowV2VariableEditBehind(3, 3), null);
    assert.equal(workflowV2VariableEditBehind(null, 4), null);
    assert.equal(workflowV2VariableEditBehind(3, null), null);
    assert.equal(workflowV2VariableEditBehind(4, 3)?.text, "The variables changed since you started editing (revision 4, now 3).");
});
