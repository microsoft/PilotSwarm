import React from "react";

const h = React.createElement;

/**
 * A modal dialog that assistive technology recognises (owner decision q17; the confirm box): role `dialog`, marked
 * modal, named by its title and described by its message (`titleId`, `messageId`: the ids of those elements inside it).
 * It takes focus when it opens, so a screen reader announces it, and gives focus back to what had it when it closes.
 * Tab stays inside it and Enter or Space presses the focused button (dialogKey, UI-7); the other keys stay with the
 * portal's modal key handler (Enter confirms, Escape cancels); a click inside does not reach the backdrop behind it.
 */
export function ModalDialog({ className, titleId, messageId = null, children }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
        const previous = typeof document === "undefined" ? null : document.activeElement;
        ref.current?.focus?.({ preventScroll: true });
        return () => {
            if (previous && previous.isConnected && typeof previous.focus === "function") previous.focus({ preventScroll: true });
        };
    }, []);
    return h("div", {
        ref, className, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId,
        ...(messageId ? { "aria-describedby": messageId } : {}),
        tabIndex: -1, onClick: event => event.stopPropagation(),
        onKeyDown: event => dialogKey(event, ref.current),
    }, children);
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * The dialog's own keys (adversarial review UI-7). Tab and Shift+Tab move focus among its controls and stay inside it
 * (from the dialog itself, Tab goes to its first control). Enter or Space on one of its buttons presses that button,
 * as a native dialog does (Enter on Cancel cancels). Each key it takes is marked handled, so the portal's modal key
 * handler leaves it alone; every other key (Escape, Enter elsewhere, y and n) still goes there.
 */
export function dialogKey(event, dialog) {
    if (!dialog || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Tab") {
        const controls = [...dialog.querySelectorAll(FOCUSABLE)].filter(element => !element.hidden);
        event.preventDefault();
        if (controls.length === 0) { dialog.focus({ preventScroll: true }); return; }
        const at = controls.indexOf(event.target);
        const next = at < 0 ? (event.shiftKey ? controls.length - 1 : 0)
            : (at + (event.shiftKey ? controls.length - 1 : 1)) % controls.length;
        controls[next].focus({ preventScroll: true });
        return;
    }
    const target = event.target;
    if ((event.key === "Enter" || event.key === " ") && target && target !== dialog && target.tagName === "BUTTON" && dialog.contains(target)) {
        event.preventDefault();
        target.click();
    }
}

/**
 * Whether an effect that moves focus when a portal modal closes must leave it where it is: a modal closed since the
 * effect last ran (`modalClosed`) and focus is on an element, not on the page itself. ModalDialog gives focus back to the
 * control that opened it as it closes, before such an effect runs. A modal that gives nothing back leaves focus on the
 * page (its controls went with it), and the effect moves focus as before.
 */
export function focusGivenBack(modalClosed, doc = typeof document === "undefined" ? null : document) {
    const active = doc?.activeElement ?? null;
    return Boolean(modalClosed && active && active !== doc.body && active !== doc.documentElement);
}
