/**
 * Adversarial review UI-7: the confirm dialog keeps Tab inside itself and lets Enter or Space press the focused button,
 * marking those keys handled so the portal's modal key handler (which turned Tab into a pane move and Enter into
 * confirm) leaves them alone.
 *
 * Run: node --test test/workflow-dialog-keys.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dialogKey } from "../../react/src/modal-dialog.js";

function fixture() {
    const focused = [];
    const clicked = [];
    const button = name => ({ name, tagName: "BUTTON", hidden: false, focus() { focused.push(name); }, click() { clicked.push(name); } });
    const buttons = [button("Close"), button("Cancel"), button("Stop Run")];
    const dialog = {
        tagName: "DIV",
        querySelectorAll: () => buttons,
        contains: element => buttons.includes(element),
        focus() { focused.push("dialog"); },
    };
    const key = (key, target, extra = {}) => {
        const event = { key, target, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, ...extra,
            preventDefault() { this.defaultPrevented = true; } };
        dialogKey(event, dialog);
        return event;
    };
    return { dialog, buttons, focused, clicked, key };
}

test("Tab from the dialog goes to its first control, then cycles; Shift+Tab goes back; both are marked handled", () => {
    const f = fixture();
    assert.equal(f.key("Tab", f.dialog).defaultPrevented, true);
    assert.deepEqual(f.focused, ["Close"]);
    f.key("Tab", f.buttons[0]);
    f.key("Tab", f.buttons[1]);
    f.key("Tab", f.buttons[2]);
    assert.deepEqual(f.focused, ["Close", "Cancel", "Stop Run", "Close"]);
    assert.equal(f.key("Tab", f.buttons[0], { shiftKey: true }).defaultPrevented, true);
    assert.equal(f.focused.at(-1), "Stop Run");
    f.key("Tab", f.dialog, { shiftKey: true });
    assert.equal(f.focused.at(-1), "Stop Run");
});

test("Enter or Space on a button presses that button (Enter on Cancel cancels, not confirms)", () => {
    const f = fixture();
    assert.equal(f.key("Enter", f.buttons[1]).defaultPrevented, true);
    assert.equal(f.key(" ", f.buttons[2]).defaultPrevented, true);
    assert.deepEqual(f.clicked, ["Cancel", "Stop Run"]);
});

test("other keys, Enter on the dialog itself, and modified keys are left to the portal's handler", () => {
    const f = fixture();
    for (const event of [f.key("Escape", f.buttons[0]), f.key("Enter", f.dialog), f.key("y", f.buttons[0]), f.key("Tab", f.buttons[0], { ctrlKey: true })]) {
        assert.equal(event.defaultPrevented, false, event.key);
    }
    assert.deepEqual(f.clicked, []);
    // A key some other handler took first is left alone.
    assert.equal(f.key("Tab", f.dialog, { defaultPrevented: true }).defaultPrevented, true);
    assert.deepEqual(f.focused, []);
});
