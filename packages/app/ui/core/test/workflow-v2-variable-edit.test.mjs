// Adversarial review R2-UI-1: the portal's variables panel keeps the KV revision its edit started from. A refresh of the
// same run to a newer revision keeps the edit and says the variables changed since editing began; Set and Remove wait
// until the person loads the new values or keeps the edit (then it is saved over the newer values, at their revision).
// The panel's state is workflowV2VariableEdit (its reducer) and workflowV2VariableEditState (what it may send). Re-check
// RC-1: Load takes only what it can read (workflowV2VariableLoad) and never acts as Keep.
//
// Run: node --test packages/app/ui/core/test/workflow-v2-variable-edit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_V2_VARIABLE_EARLIER_SAVED, WORKFLOW_V2_VARIABLE_EDIT_EMPTY, workflowV2RunVariables, workflowV2VariableDraft, workflowV2VariableEdit,
    workflowV2VariableEditBehind, workflowV2VariableEditState, workflowV2VariableListed, workflowV2VariableLoad,
} from "../src/workflow-v2-commands.js";

const entries = rev => [{ key: "cfg", valueText: JSON.stringify({ limit: rev }) }, { key: "mode", valueText: '"fast"' }];
/** The list as the panel shows it (workflowV2RunVariables): whole, at `revision`. */
const shown = (revision, list = entries(revision)) => ({ entries: list, complete: true, preview: null, revision });
const run = (actions, start = WORKFLOW_V2_VARIABLE_EDIT_EMPTY) => actions.reduce(workflowV2VariableEdit, start);
/** An edit without its generation (re-check UI-RC2-6), for comparing what it holds. */
const held = edit => { const { generation: _generation, ...rest } = edit; return rest; };

test("an edit keeps the revision it started from across a refresh, and is sent at it; a clean form follows the shown one", () => {
    // Nothing typed: the update would go at the shown revision, and nothing is behind.
    assert.deepEqual(workflowV2VariableEditState(WORKFLOW_V2_VARIABLE_EDIT_EMPTY, 3), { dirty: false, expectedKvRevision: 3, behind: null, notice: null });
    // Edit copies a listed object at revision 3 and changes it.
    const edit = run([
        { type: "copy", key: "cfg", value: '{"limit":3}', revision: 3 },
        { type: "type", field: "value", text: '{"limit":3,"extra":true}', ...shown(3) },
    ]);
    assert.deepEqual(held(edit), { key: "cfg", value: '{"limit":3,"extra":true}', base: 3, listed: true, notice: null });
    assert.deepEqual(workflowV2VariableEditState(edit, 3), { dirty: true, expectedKvRevision: 3, behind: null, notice: null });
    // Another person updated cfg (revision 4) and the workflow was read again: the edit stays, and is behind.
    const typedAfter = workflowV2VariableEdit(edit, { type: "type", field: "value", text: '{"limit":3,"extra":false}', ...shown(4) });
    assert.equal(typedAfter.base, 3, "typing more does not move the edit to the new revision");
    const state = workflowV2VariableEditState(typedAfter, 4);
    assert.equal(state.expectedKvRevision, 3, "it would be refused, never written over revision 4");
    assert.deepEqual(state.behind, { base: 3, revision: 4, text: "The variables changed since you started editing (revision 3, now 4)." });
    // Keep: the edit stays and is saved over revision 4.
    const kept = workflowV2VariableEdit(typedAfter, { type: "keep", ...shown(4) });
    assert.deepEqual(held(kept), { key: "cfg", value: '{"limit":3,"extra":false}', base: 4, listed: true, notice: null });
    assert.deepEqual(workflowV2VariableEditState(kept, 4), { dirty: true, expectedKvRevision: 4, behind: null, notice: null });
    // Load: the named variable's value now, at revision 4.
    const reloaded = workflowV2VariableEdit(typedAfter, { type: "reload", ...shown(4) });
    assert.deepEqual(held(reloaded), { key: "cfg", value: '{"limit":4}', base: 4, listed: true, notice: null });
});

// Re-check RC-1: Load never acts as Keep. It takes only what it can read: a removed variable's old value is cleared, and a
// list it cannot read whole loads nothing and leaves the edit behind; only Keep moves an edit over values it did not load.
test("RC-1: Load clears a variable removed since the edit began; a new name stays new; a list too long or unreadable loads nothing", () => {
    const editAt3 = run([
        { type: "copy", key: "cfg", value: '{"limit":3}', revision: 3 },
        { type: "type", field: "value", text: '{"limit":9}', ...shown(3) },
    ]);
    // Someone removed cfg at revision 4: Load clears the old value (no resurrection), says why, and the edit is at 4.
    const removed = workflowV2VariableEdit(editAt3, { type: "reload", ...shown(4, [{ key: "mode", valueText: '"fast"' }]) });
    assert.deepEqual(held(removed), { key: "cfg", value: "", base: 4, listed: false,
        notice: "'cfg' was removed at revision 4, after you started editing. Its old value is cleared; type a value to set it again." });
    const afterRemoval = workflowV2VariableEditState(removed, 4);
    assert.equal(afterRemoval.behind, null);
    assert.equal(afterRemoval.notice, removed.notice);
    assert.equal(workflowV2VariableDraft(removed.key, removed.value).ok, false, "nothing to set until a value is typed");
    // Typing clears the notice.
    assert.equal(workflowV2VariableEdit(removed, { type: "type", field: "value", text: "1", ...shown(4) }).notice, null);

    // A name typed while the whole list showed it was not set: still not set at 4, so the new value stays.
    const fresh = run([
        { type: "type", field: "key", text: "new", ...shown(3) },
        { type: "type", field: "value", text: "1", ...shown(3) },
    ]);
    assert.equal(fresh.listed, false);
    assert.deepEqual(held(workflowV2VariableEdit(fresh, { type: "reload", ...shown(4) })),
        { key: "new", value: "1", base: 4, listed: false, notice: "'new' is still not set at revision 4, so your new value stays." });
    // A name typed while the list could not be read whole, and not set now: not known whether it was removed, so cleared.
    const unknown = run([
        { type: "type", field: "key", text: "cfg", entries: [], complete: false, preview: '{"cfg":{"limit":3},"big":"xxxx…', revision: 3 },
        { type: "type", field: "value", text: "7", entries: [], complete: false, revision: 3 },
    ]);
    assert.equal(unknown.listed, null);
    assert.deepEqual(held(workflowV2VariableEdit(unknown, { type: "reload", ...shown(4, []) })), { key: "cfg", value: "", base: 4, listed: false,
        notice: "'cfg' is not set at revision 4; it may have been removed. The value is cleared; type a value to set it again." });

    // The map at revision 4 is longer than the view: nothing is loaded, the edit keeps its own revision (3) and stays behind.
    const truncated = { entries: [], complete: false, preview: '{"cfg":{"limit":4},"big":"xxxx…', revision: 4 };
    const blocked = workflowV2VariableEdit(editAt3, { type: "reload", ...truncated });
    assert.deepEqual(held(blocked), { key: "cfg", value: '{"limit":9}', base: 3, listed: true,
        notice: "The new values cannot be loaded here: the variables are longer than this view. Your edit stays at revision 3. "
            + "Keep it to save it over the new values, or clear the form." });
    const stillBehind = workflowV2VariableEditState(blocked, 4);
    assert.equal(stillBehind.expectedKvRevision, 3, "never sent at 4 with values it did not load");
    assert.ok(stillBehind.behind);
    // An unreadable map: the same, with why.
    assert.match(workflowV2VariableEdit(editAt3, { type: "reload", entries: [], complete: false, preview: null, revision: 4 }).notice,
        /^The new values cannot be loaded here: the variables could not be read\. Your edit stays at revision 3\./);
    // Only Keep moves it over them, on purpose.
    assert.equal(workflowV2VariableEdit(blocked, { type: "keep", ...truncated }).base, 4);
});

test("RC-1: the list the panel shows says whether a name is listed only when it is whole; Load reads it the same way", () => {
    const kv = (text, revision = 4) => workflowV2RunVariables({ personCommands: { operations: ["set_vars"] },
        run: { runId: "r", status: "running", kv: text, kvRevision: revision } });
    const whole = kv(JSON.stringify({ cfg: { limit: 4 } }));
    assert.equal(workflowV2VariableListed(whole, "cfg"), true);
    assert.equal(workflowV2VariableListed(whole, "gone"), false);
    const cut = kv('{"cfg":{"limit":4},"big":"xxxx…');
    assert.equal(cut.complete, false);
    assert.equal(workflowV2VariableListed(cut, "cfg"), null);
    assert.equal(workflowV2VariableLoad({ key: "cfg", value: "1", base: 3, listed: true }, cut).kind, "blocked");
    assert.equal(workflowV2VariableLoad({ key: "cfg", value: "1", base: 3, listed: true }, kv("not json")).kind, "blocked");
    assert.deepEqual(workflowV2VariableLoad({ key: "cfg", value: "1", base: 3, listed: true }, whole),
        { kind: "loaded", value: '{"limit":4}', base: 4, listed: true, notice: null });
});

test("typing into a clean form takes the shown revision; emptying it drops the revision; clear empties it", () => {
    const started = run([{ type: "type", field: "key", text: "n", revision: 5 }]);
    assert.deepEqual(held(started), { key: "n", value: "", base: 5, listed: null, notice: null });
    const emptied = workflowV2VariableEdit(started, { type: "type", field: "key", text: "", revision: 6 });
    assert.deepEqual(held(emptied), { key: "", value: "", base: null, listed: null, notice: null });
    const again = workflowV2VariableEdit(emptied, { type: "type", field: "value", text: "1", revision: 6 });
    assert.equal(again.base, 6);
    assert.deepEqual(held(workflowV2VariableEdit(again, { type: "clear" })), held(WORKFLOW_V2_VARIABLE_EDIT_EMPTY));
    // An unknown action, and a refresh (no action at all), change nothing.
    assert.deepEqual(workflowV2VariableEdit(again, { type: "refresh", revision: 9 }), again);
});

// Re-check UI-RC2-6: a save's answer belongs to the edit it sent. Typing on while it is in flight keeps the newer edit, which
// is not saved, and the form says the earlier change was; only the edit that was sent is cleared.
test("UI-RC2-6: a late save answer empties only the edit it sent; a newer edit stays, with a notice; every change raises the generation", () => {
    const sent = run([{ type: "type", field: "key", text: "a", ...shown(3) }, { type: "type", field: "value", text: "1", ...shown(3) }]);
    const generation = sent.generation;
    assert.ok(Number.isSafeInteger(generation) && generation >= 2);
    // Answered with nothing typed since: the form empties.
    const cleared = workflowV2VariableEdit(sent, { type: "saved", generation });
    assert.deepEqual(held(cleared), held(WORKFLOW_V2_VARIABLE_EDIT_EMPTY));
    assert.ok(cleared.generation > generation, "a new edit after it is a new generation");
    // Typed on while it was in flight: the newer edit stays (not saved), and the form says what happened.
    const newer = workflowV2VariableEdit(sent, { type: "type", field: "value", text: "12", ...shown(3) });
    assert.notEqual(newer.generation, generation);
    const kept = workflowV2VariableEdit(newer, { type: "saved", generation });
    assert.deepEqual(held(kept), { key: "a", value: "12", base: 3, listed: false, notice: WORKFLOW_V2_VARIABLE_EARLIER_SAVED });
    assert.equal(workflowV2VariableEditState(kept, 4).notice, WORKFLOW_V2_VARIABLE_EARLIER_SAVED);
    assert.equal(workflowV2VariableEditState(kept, 4).dirty, true, "still to be saved");
    // The same after a copy, a Keep or a Load in between.
    for (const action of [{ type: "copy", key: "b", value: "2", revision: 3 }, { type: "keep", ...shown(4) }, { type: "reload", ...shown(4) }]) {
        const changed = workflowV2VariableEdit(sent, action);
        assert.notEqual(changed.generation, generation, action.type);
        const after = workflowV2VariableEdit(changed, { type: "saved", generation });
        assert.equal(after.notice, WORKFLOW_V2_VARIABLE_EARLIER_SAVED, action.type);
        assert.equal(after.key, changed.key, action.type);
        assert.equal(after.value, changed.value, action.type);
    }
    // A form cleared since (or a new run's, which the panel clears) has nothing newer to keep: it is left as it is.
    const cleared2 = workflowV2VariableEdit(sent, { type: "clear" });
    assert.deepEqual(workflowV2VariableEdit(cleared2, { type: "saved", generation }), cleared2);
    // Typing clears the notice.
    assert.equal(workflowV2VariableEdit(kept, { type: "type", field: "value", text: "123", ...shown(4) }).notice, null);
});

test("behind only when both revisions are known and differ", () => {
    assert.equal(workflowV2VariableEditBehind(3, 3), null);
    assert.equal(workflowV2VariableEditBehind(null, 4), null);
    assert.equal(workflowV2VariableEditBehind(3, null), null);
    assert.equal(workflowV2VariableEditBehind(4, 3)?.text, "The variables changed since you started editing (revision 4, now 3).");
});
