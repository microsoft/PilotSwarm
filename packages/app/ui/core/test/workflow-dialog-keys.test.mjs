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

// Owner decision on UI-7's known limit: a control inside a hidden, inert or undisplayed parent never takes focus and is
// never pressed; nor is one that is invisible itself. (Computed styles come from the control's own window.)
test("a control in a hidden, inert or undisplayed parent, or invisible itself, is skipped by Tab and never pressed", () => {
    const focused = [];
    const clicked = [];
    const styles = new Map();
    const view = { getComputedStyle: node => ({ display: styles.get(node)?.display ?? "block", visibility: styles.get(node)?.visibility ?? "visible" }) };
    const dialog = { tagName: "DIV", focus() { focused.push("dialog"); } };
    const element = (name, parent, extra = {}) => ({ name, tagName: "BUTTON", hidden: false, parentElement: parent, ownerDocument: { defaultView: view },
        hasAttribute: () => false, focus() { focused.push(name); }, click() { clicked.push(name); }, ...extra });
    const box = (extra = {}) => ({ tagName: "DIV", hidden: false, parentElement: dialog, hasAttribute: () => false, ...extra });
    const hiddenParent = box({ hidden: true });
    const inertParent = box({ hasAttribute: name => name === "inert" });
    const undisplayed = box();
    styles.set(undisplayed, { display: "none" });
    const deep = box({ parentElement: undisplayed });
    const invisible = element("Invisible", dialog);
    styles.set(invisible, { visibility: "hidden" });
    const buttons = [
        element("Cancel", dialog),
        element("In hidden parent", hiddenParent),
        element("In inert parent", inertParent),
        element("In undisplayed grandparent", deep),
        invisible,
        element("Stop Run", dialog),
    ];
    dialog.querySelectorAll = () => buttons;
    dialog.contains = item => buttons.includes(item);
    const key = (name, target, extra = {}) => {
        const event = { key: name, target, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, ...extra,
            preventDefault() { this.defaultPrevented = true; } };
        dialogKey(event, dialog);
        return event;
    };
    key("Tab", dialog);
    key("Tab", buttons[0]);
    key("Tab", buttons[5]);
    key("Tab", buttons[0], { shiftKey: true });
    assert.deepEqual(focused, ["Cancel", "Stop Run", "Cancel", "Stop Run"]);
    // Enter or Space on one that is not usable presses nothing, and is still taken, so the portal does not confirm instead.
    for (const target of buttons.slice(1, 5)) {
        for (const name of ["Enter", " "]) assert.equal(key(name, target).defaultPrevented, true, `${target.name} ${name}`);
    }
    assert.deepEqual(clicked, []);
    assert.equal(key("Enter", buttons[5]).defaultPrevented, true);
    assert.deepEqual(clicked, ["Stop Run"]);
});
