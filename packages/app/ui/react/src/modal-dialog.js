import React from "react";

const h = React.createElement;

/**
 * A modal dialog that assistive technology recognises (owner decision q17; the confirm box): role `dialog`, marked
 * modal, named by its title and described by its message (`titleId`, `messageId`: the ids of those elements inside it).
 * It takes focus when it opens, so a screen reader announces it, and gives focus back to what had it when it closes.
 * Keys stay with the portal's modal key handler (Enter confirms, Escape cancels); a click inside does not reach the
 * backdrop behind it.
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
    }, children);
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
