/** Tablet hardware arrows work even when the portal uses its touch layout. */
export function supportsPromptHistoryKeyboard(mobile, screen = globalThis.screen) {
    return !mobile || Math.min(screen?.width || 0, screen?.height || 0) >= 600;
}

/** Match the textarea's soft-wrapped visual lines, not only newline offsets. */
export function isTextareaHistoryBoundary(textarea, direction) {
    if (!textarea.value) return true;
    const style = getComputedStyle(textarea);
    const mirror = document.createElement("div");
    Object.assign(mirror.style, {
        position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
        width: `${textarea.clientWidth}px`, boxSizing: "border-box",
        whiteSpace: "pre-wrap", overflowWrap: "break-word",
        font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
        padding: style.padding, tabSize: style.tabSize,
    });
    const caret = document.createElement("span");
    const end = document.createElement("span");
    caret.textContent = end.textContent = "\u200b";
    mirror.append(document.createTextNode(textarea.value.slice(0, textarea.selectionStart)), caret,
        document.createTextNode(textarea.value.slice(textarea.selectionStart)), end);
    document.body.append(mirror);
    try {
        const top = caret.getBoundingClientRect().top;
        return direction < 0
            ? top - mirror.getBoundingClientRect().top - parseFloat(style.paddingTop) < parseFloat(style.lineHeight) / 2
            : Math.abs(top - end.getBoundingClientRect().top) < parseFloat(style.lineHeight) / 2;
    } finally {
        mirror.remove();
    }
}
