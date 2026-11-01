import React from "react";
import { selectMotd } from "../../core/src/motd.js";
import { useControllerSelector } from "./use-controller-state.js";
import { renderMarkdown } from "./workspace-markdown.js";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
function pictureUrl(image) {
    return image && IMAGE_TYPES.includes(image.contentType) && typeof image.base64 === "string"
        ? `data:${image.contentType};base64,${image.base64}` : null;
}
function windowText(message) {
    const format = value => new Date(value).toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    return `${format(message.fromAt)} to ${format(message.toAt)} UTC`;
}
export function MotdMarkdown({ body }) {
    const html = React.useMemo(() => typeof document === "undefined" ? null
        : renderMarkdown(body, { images: {}, escapeRawHtml: true, allowInlineImages: false, externalLinksOnly: true, stripFrontMatter: false }).html, [body]);
    return html === null ? React.createElement("pre", { className: "ps-motd-markdown" }, body)
        : React.createElement("div", { className: "ps-motd-markdown", dangerouslySetInnerHTML: { __html: html } });
}
export function MotdContent({ message, pictures = {}, mobile = false }) {
    const body = mobile && message.mobileBodyMd ? message.mobileBodyMd : message.bodyMd;
    const picture = mobile ? pictures.mobile || pictures.desktop : pictures.desktop;
    const src = pictureUrl(picture);
    const placement = mobile ? "above" : message.imagePlacement || "above";
    return React.createElement("div", { className: `ps-motd-content is-${placement}` },
        src ? React.createElement("img", { className: "ps-motd-picture", src, alt: picture.alt || "", draggable: false }) : null,
        React.createElement("div", { className: "ps-motd-copy" },
            React.createElement("div", { className: "ps-motd-kicker" }, "Message of the day"),
            pictures.failures?.[mobile ? "mobile" : "desktop"]
                ? React.createElement("p", { role: "status", className: "ps-motd-picture-notice" }, "The picture could not be loaded. The message is still available.") : null,
            React.createElement(MotdMarkdown, { body })));
}
export function MotdSplash({ message, pictures, mobile = false, preview = false, onDismiss }) {
    const dialogRef = React.useRef(null);
    React.useEffect(() => {
        const dialog = dialogRef.current;
        const previous = document.activeElement;
        dialog.showModal();
        return () => { dialog.close(); if (previous?.isConnected) previous.focus?.(); };
    }, [message.motdId]);
    const dismissCard = event => {
        if (event.target.closest("a, button, input, textarea, select") || window.getSelection()?.toString()) return;
        onDismiss();
    };
    return React.createElement("dialog", { ref: dialogRef, className: `ps-motd-dialog${mobile ? " is-phone-preview" : ""}`,
        "aria-label": preview ? "Message of the day preview" : "Message of the day", onCancel: event => event.preventDefault() },
        React.createElement("article", { className: "ps-motd-splash", onClick: dismissCard },
            React.createElement("div", { className: "ps-motd-scroll" }, React.createElement(MotdContent, { message, pictures, mobile })),
            React.createElement("footer", { className: "ps-motd-footer" },
                React.createElement("span", { className: "ps-motd-window" }, windowText(message)),
                React.createElement("button", { type: "button", autoFocus: true, className: "ps-motd-button", onClick: onDismiss }, preview ? "Close preview" : "Got it"))));
}
export function MotdOverlay({ controller, mobile = false }) {
    const state = useControllerSelector(controller, root => root.motd);
    const auth = useControllerSelector(controller, root => root.auth);
    const profile = useControllerSelector(controller, root => root.admin.profile);
    const view = selectMotd({ motd: state, auth, admin: { profile } });
    if (!view.message) return null;
    const message = view.message;
    return React.createElement(MotdSplash, { key: `${view.preview ? "preview" : "current"}:${message.motdId}`,
        message, pictures: message.pictures || view.images[message.motdId] || {}, mobile: mobile || view.mobile,
        preview: view.preview, onDismiss: () => { void controller.dismissCurrentMotd(); } });
}
function draftMessage(draft) {
    return { motdId: "draft", bodyMd: draft.bodyMd, mobileBodyMd: draft.mobileBodyMd || null,
        fromAt: Number.isFinite(Date.parse(draft.fromAt)) ? new Date(draft.fromAt).toISOString() : new Date().toISOString(),
        toAt: Number.isFinite(Date.parse(draft.toAt)) ? new Date(draft.toAt).toISOString() : new Date().toISOString(),
        imagePlacement: draft.imagePlacement, pictures: { desktop: draft.image, mobile: draft.mobileImage } };
}
export function MotdAdminPanel({ controller, state, images = {}, isAdmin, canRead = isAdmin, mobile = false }) {
    const [pictureError, setPictureError] = React.useState(null);
    const [reading, setReading] = React.useState(false);
    if (!canRead) return null;
    const draft = state.draft;
    const busy = state.saving || state.loading || reading;
    const input = (label, field, type = "text") => React.createElement("label", { className: "ps-motd-field" }, label,
        React.createElement("input", { type, value: draft[field] || "", disabled: busy,
            onChange: event => controller.setMotdDraft({ [field]: event.target.value }) }));
    const body = (label, field) => React.createElement("label", { className: "ps-motd-field" }, label,
        React.createElement("textarea", { value: draft[field] || "", rows: field === "bodyMd" ? 12 : 4,
            disabled: busy, onChange: event => controller.setMotdDraft({ [field]: event.target.value }) }));
    const readPicture = async (event, field) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        if (!IMAGE_TYPES.includes(file.type) || !file.size || file.size > 2 * 1024 * 1024) {
            setPictureError("Choose PNG, JPEG, WebP or GIF, at most 2 MB per picture."); return;
        }
        setReading(true); setPictureError(null);
        const context = controller._motdContext();
        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error("Could not read the selected picture."));
                reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
                reader.readAsDataURL(file);
            });
            if (context === controller._motdContext()) controller.setMotdDraft({ [field]: { base64, contentType: file.type, alt: "" } });
        } catch (error) { setPictureError(error.message); }
        finally { setReading(false); }
    };
    const picture = (label, field) => React.createElement("div", { className: "ps-motd-field" },
        React.createElement("label", null, `${label} (2 MB maximum)`,
            React.createElement("input", { type: "file", accept: IMAGE_TYPES.join(","), disabled: busy,
                onChange: event => { void readPicture(event, field); } })),
        draft[field] ? React.createElement(React.Fragment, null,
            React.createElement("img", { className: "ps-motd-editor-thumb", src: pictureUrl(draft[field]), alt: draft[field].alt || "Selected picture" }),
            React.createElement("label", null, `${label} alt text`,
                React.createElement("input", { type: "text", required: true, maxLength: 1024, value: draft[field].alt, disabled: busy,
                    onChange: event => controller.setMotdDraft({ [field]: { ...draft[field], alt: event.target.value } }) })),
            React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy,
                onClick: () => controller.setMotdDraft({ [field]: undefined }) }, `Remove ${label.toLowerCase()}`)) : null);
    const remove = row => { if (window.confirm("Delete this message and its pictures? This cannot be undone.")) void controller.deleteAdminMotd(row.motdId); };
    return React.createElement("section", { className: "ps-admin-detail ps-motd-admin", "aria-label": "Message of the day settings" },
        React.createElement("header", { className: "ps-motd-admin-heading" },
            React.createElement("h3", null, "Message of the day"),
            React.createElement("button", { type: "button", className: "ps-mini-button", disabled: state.loading || busy,
                onClick: () => { void controller.refreshAdminMotds(); } }, "Refresh messages")),
        state.error || pictureError ? React.createElement("div", { role: "alert", className: "ps-admin-console__error" }, pictureError || state.error) : null,
        state.notice ? React.createElement("p", { role: "status" }, state.notice) : null,
        React.createElement("div", { className: `ps-motd-admin-grid${isAdmin ? "" : " is-read-only"}` },
            React.createElement("section", { className: "ps-motd-admin-card" },
                React.createElement("h4", null, "Today"),
                state.today ? React.createElement(React.Fragment, null,
                    React.createElement("p", { className: "ps-motd-meta" }, isAdmin
                        ? `${windowText(state.today)} · by ${state.today.createdBy?.subject || "admin"} · ${state.today.dismissalCount || 0} people dismissed it`
                        : windowText(state.today)),
                    React.createElement("div", { className: "ps-motd-mini" }, React.createElement(MotdContent, { message: state.today, pictures: images[state.today.motdId], mobile })),
                    React.createElement("div", { className: "ps-motd-actions" },
                        React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(state.today, { mobile }) }, "Show splash again"),
                        React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(state.today, { mobile: true }) }, "Phone view"),
                        isAdmin ? React.createElement("button", { type: "button", className: "ps-mini-button is-danger", disabled: busy, onClick: () => remove(state.today), "aria-label": "Delete current message" }, "Delete") : null),
                    React.createElement("p", { className: "ps-motd-meta" }, "Show splash again is a preview. It does not record a dismissal."))
                    : React.createElement("p", { className: "ps-motd-meta" }, state.loading ? "Loading messages..." : "No message is active today.")),
            isAdmin ? React.createElement("form", { className: "ps-motd-admin-card ps-motd-editor", onSubmit: event => { event.preventDefault(); void controller.createAdminMotd(); } },
                React.createElement("h4", null, "New message"),
                React.createElement("p", { className: "ps-motd-meta" }, "Enter times in your local time. They are stored in UTC. A later start time takes over."),
                React.createElement("div", { className: "ps-motd-time-fields" }, input("From", "fromAt", "datetime-local"), input("To", "toAt", "datetime-local")),
                body("Body (markdown)", "bodyMd"),
                picture("Picture", "image"),
                React.createElement("label", { className: "ps-motd-field" }, "Picture placement",
                    React.createElement("select", { value: draft.imagePlacement, disabled: busy, onChange: event => controller.setMotdDraft({ imagePlacement: event.target.value }) },
                        ["above", "beside", "background"].map(value => React.createElement("option", { key: value, value }, value[0].toUpperCase() + value.slice(1))))),
                React.createElement("details", { className: "ps-motd-mobile-editor" },
                    React.createElement("summary", null, "Mobile version (optional)"), body("Mobile body (markdown)", "mobileBodyMd"), picture("Mobile picture", "mobileImage")),
                React.createElement("div", { className: "ps-motd-actions" },
                    React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy || !draft.bodyMd.trim(),
                        onClick: () => controller.previewMotd(draftMessage(draft), { mobile }) }, "Preview"),
                    React.createElement("button", { type: "submit", className: "ps-primary-button", disabled: busy }, busy ? "Publishing..." : "Publish"))) : null),
        React.createElement("section", { className: "ps-motd-admin-card ps-motd-history" },
            React.createElement("h4", null, "Previous messages"),
            React.createElement("p", { className: "ps-motd-meta" }, isAdmin
                ? "Newest first. Delete removes the message and its pictures. Dismissals stay."
                : "Newest first. Open a previous message to read it and see its picture."),
            React.createElement("div", { className: "ps-motd-history-scroll" }, state.history.map(row =>
                React.createElement("details", { key: row.motdId, className: "ps-motd-history-entry",
                    open: state.expandedIds?.includes(row.motdId) === true,
                    onToggle: event => controller.setMotdHistoryExpanded(row.motdId, event.currentTarget.open) },
                    React.createElement("summary", { className: `ps-motd-history-row${isAdmin ? "" : " is-read-only"}` },
                    React.createElement("span", { className: "ps-motd-meta" }, windowText(row)),
                    React.createElement("span", { className: "ps-motd-history-title", title: row.bodyMd }, row.bodyMd.replace(/^#+\s*/, "").split("\n")[0]),
                    React.createElement("span", { className: `ps-motd-status is-${row.status}` }, { live: "Live", hidden: "Hidden by later message", scheduled: "Scheduled", ended: "Ended" }[row.status]),
                    isAdmin ? React.createElement("button", { type: "button", className: "ps-mini-button is-danger", disabled: busy,
                        "aria-label": `Delete message ${row.motdId}`, onClick: event => { event.preventDefault(); event.stopPropagation(); remove(row); } }, "Delete") : null),
                    React.createElement("div", { className: "ps-motd-history-body" },
                        React.createElement("div", { className: "ps-motd-mini" }, React.createElement(MotdContent, { message: row, pictures: images[row.motdId], mobile })),
                        React.createElement("div", { className: "ps-motd-actions" },
                            React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(row, { mobile }) }, "Show splash again"),
                            React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(row, { mobile: true }) }, "Phone view")))))),
            state.hasMore ? React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy || state.loading,
                onClick: () => { void controller.refreshAdminMotds({ older: true }); } }, "Load older messages") : null));
}
