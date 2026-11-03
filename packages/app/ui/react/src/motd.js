import React from "react";
import { selectMotd, motdDraftWindow, formatMotdWindow, motdScheduleSummary } from "../../core/src/motd.js";
import { useControllerSelector } from "./use-controller-state.js";
import { renderMarkdown } from "./workspace-markdown.js";
import { IMAGE_PROMPT_ATTACHMENT_TYPES } from "../../core/src/controller.js";
import { imageFiles, handleImagePaste, handleImageDrop, hasFileDrag } from "./image-transfer.js";

const IMAGE_TYPES = [...IMAGE_PROMPT_ATTACHMENT_TYPES];
const PICTURE_ERROR = "Choose PNG, JPEG, WebP or GIF, at most 2 MB per picture.";
function pictureUrl(image) {
    return image && IMAGE_TYPES.includes(image.contentType) && typeof image.base64 === "string"
        ? `data:${image.contentType};base64,${image.base64}` : null;
}
export function MotdSchedulePicker({ controller, draft, busy }) {
    const choices = (label, field, values) => React.createElement("fieldset", { className: "ps-motd-schedule-group", disabled: busy },
        React.createElement("legend", null, label),
        React.createElement("div", { className: "ps-motd-segments" }, values.map(([value, name]) =>
            React.createElement("label", { key: value, className: draft[field] === value ? "is-selected" : "" },
                React.createElement("input", { type: "radio", className: "ps-sr-only", name: `motd-${field}`, value, checked: draft[field] === value,
                    onChange: () => controller.setMotdDraft({ [field]: value }) }), name))));
    const atTime = (label, prefix) => {
        const times = Array.from({ length: 96 }, (_, index) => {
            const value = `${String(Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}`;
            return [value, new Date(`2000-01-01T${value}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })];
        });
        if (!times.some(([value]) => value === draft[`${prefix}Time`]))
            times.push([draft[`${prefix}Time`], `${draft[`${prefix}Time`]} (copied)`]);
        return React.createElement("div", { className: "ps-motd-at-time" },
            React.createElement("label", { className: "ps-motd-field" }, `${label} date`,
                React.createElement("input", { type: "date", "aria-label": `${label} date`, required: true, disabled: busy,
                    value: draft[`${prefix}Date`], onChange: event => controller.setMotdDraft({ [`${prefix}Date`]: event.target.value }) })),
            React.createElement("label", { className: "ps-motd-field" }, `${label} time`,
                React.createElement("select", { "aria-label": `${label} time`, disabled: busy, value: draft[`${prefix}Time`],
                    onChange: event => controller.setMotdDraft({ [`${prefix}Time`]: event.target.value }) },
                    times.map(([value, name]) => React.createElement("option", { key: value, value }, name)))));
    };
    return React.createElement("div", { className: "ps-motd-schedule" },
        choices("Starts", "startMode", [["now", "Now"], ["custom", "At a time..."]]),
        draft.startMode === "custom" ? atTime("Start", "start") : null,
        choices("Ends", "endMode", [["never", "Never - until replaced or deleted"], ["hour", "1 hour"], ["day", "1 day"],
            ["week", "1 week"], ["custom", "At a time..."]]),
        draft.endMode === "custom" ? atTime("End", "end") : null,
        React.createElement("p", { className: "ps-motd-meta" }, `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`),
        React.createElement("p", { className: "ps-motd-schedule-summary" }, motdScheduleSummary(draft)));
}
export function MotdMarkdown({ body }) {
    // Keep unchanged markdown nodes attached across unrelated portal updates:
    // a fresh { __html } object on every render makes React rewrite innerHTML.
    const markup = React.useMemo(() => typeof document === "undefined" ? null
        : { __html: renderMarkdown(body, { images: {}, escapeRawHtml: true, allowInlineImages: false, externalLinksOnly: true, stripFrontMatter: false }).html }, [body]);
    return markup === null ? React.createElement("pre", { className: "ps-motd-markdown" }, body)
        : React.createElement("div", { className: "ps-motd-markdown", dangerouslySetInnerHTML: markup });
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
                React.createElement("span", { className: "ps-motd-window" }, formatMotdWindow(message)),
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
    const window = motdDraftWindow(draft);
    return { motdId: "draft", bodyMd: draft.bodyMd, mobileBodyMd: draft.mobileBodyMd || null,
        fromAt: Number.isFinite(window.from) ? new Date(window.from).toISOString() : new Date().toISOString(),
        toAt: window.to === null ? null : Number.isFinite(window.to) ? new Date(window.to).toISOString() : new Date().toISOString(),
        imagePlacement: draft.imagePlacement, pictures: { desktop: draft.image, mobile: draft.mobileImage } };
}
export function MotdAdminPanel({ controller, state, images = {}, isAdmin, canRead = isAdmin, mobile = false }) {
    const [pictureError, setPictureError] = React.useState(null);
    const [reading, setReading] = React.useState(false);
    const [dragOver, setDragOver] = React.useState(false);
    const editorRef = React.useRef(null);
    const bodyRef = React.useRef(null);
    const mobileRef = React.useRef(null);
    const handledFocusVersion = React.useRef(state.draftFocusVersion);
    React.useLayoutEffect(() => {
        if (state.draftFocusVersion < handledFocusVersion.current) handledFocusVersion.current = state.draftFocusVersion;
        if (!isAdmin || state.draftFocusVersion <= handledFocusVersion.current || state.duplicatingId) return;
        handledFocusVersion.current = state.draftFocusVersion;
        setPictureError(null);
        if (mobileRef.current) mobileRef.current.open = Boolean(state.draft.mobileBodyMd || state.draft.mobileImage);
        bodyRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
        bodyRef.current?.focus({ preventScroll: true });
    }, [state.draftFocusVersion, state.duplicatingId, isAdmin]);
    if (!canRead) return null;
    const draft = state.draft;
    const busy = state.saving || state.loading || Boolean(state.duplicatingId) || reading;
    const body = (label, field) => React.createElement("label", { className: "ps-motd-field" }, label,
        React.createElement("textarea", { ref: field === "bodyMd" ? bodyRef : undefined, "aria-label": label, value: draft[field] || "", rows: field === "bodyMd" ? 12 : 4,
            disabled: busy, onChange: event => controller.setMotdDraft({ [field]: event.target.value }) }));
    const readPicture = async (file, field) => {
        if (!file || busy || !isAdmin) return;
        if (!IMAGE_TYPES.includes(file.type) || !file.size || file.size > 2 * 1024 * 1024) {
            setPictureError(PICTURE_ERROR); return;
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
            if (context === controller._motdContext() && controller._featureIsAdmin())
                controller.setMotdDraft({ [field]: { base64, contentType: file.type, alt: String(file.name || "").slice(0, 1024) } });
        } catch (error) { setPictureError(error.message); }
        finally { setReading(false); }
    };
    const pictureField = event => mobileRef.current?.open
        && (mobileRef.current.contains(event.target) || mobileRef.current.contains(document.activeElement)) ? "mobileImage" : "image";
    const stagePictureFiles = (files, field) => {
        const selected = imageFiles(files);
        if (!selected.length) {
            if (files?.length) setPictureError(PICTURE_ERROR);
            return 0;
        }
        if (busy) {
            setPictureError("Wait for the current message action before adding a picture.");
            return 0;
        }
        if (selected.length > 1) {
            setPictureError("Paste or drop one picture at a time.");
            return 0;
        }
        const file = selected[0];
        void readPicture(file, field);
        return IMAGE_TYPES.includes(file.type) && file.size > 0 && file.size <= 2 * 1024 * 1024 ? 1 : 0;
    };
    const picture = (label, field) => React.createElement("div", { className: "ps-motd-field" },
        React.createElement("label", null, `${label} (2 MB maximum)`,
            React.createElement("input", { type: "file", accept: IMAGE_TYPES.join(","), disabled: busy,
                onChange: event => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void readPicture(file, field);
                } })),
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
        React.createElement("div", { className: `ps-motd-admin-grid${isAdmin && !mobile ? "" : " is-read-only"}` },
            React.createElement("section", { className: "ps-motd-admin-card" },
                React.createElement("h4", null, "Today"),
                state.today ? React.createElement(React.Fragment, null,
                    React.createElement("p", { className: "ps-motd-meta" }, isAdmin
                        ? `${formatMotdWindow(state.today)} · by ${state.today.createdBy?.subject || "admin"} · ${state.today.dismissalCount || 0} people dismissed it`
                        : formatMotdWindow(state.today)),
                    React.createElement("div", { className: "ps-motd-mini" }, React.createElement(MotdContent, { message: state.today, pictures: images[state.today.motdId], mobile })),
                    React.createElement("div", { className: "ps-motd-actions" },
                        React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(state.today, { mobile }) }, "Show splash again"),
                        !mobile ? React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(state.today, { mobile: true }) }, "Phone view") : null,
                        isAdmin && !mobile ? React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy,
                            "aria-label": "Duplicate current message", onClick: () => { void controller.duplicateAdminMotd(state.today.motdId); } }, "Duplicate") : null,
                        isAdmin ? React.createElement("button", { type: "button", className: "ps-mini-button is-danger", disabled: busy, onClick: () => remove(state.today), "aria-label": "Delete current message" }, "Delete") : null),
                    React.createElement("p", { className: "ps-motd-meta" }, "Show splash again is a preview. It does not record a dismissal."))
                    : React.createElement("p", { className: "ps-motd-meta" }, state.loading ? "Loading messages..." : "No message is active today.")),
            isAdmin && !mobile ? React.createElement("form", { ref: editorRef, className: `ps-motd-admin-card ps-motd-editor${dragOver ? " is-drag-over" : ""}`,
                onPaste: event => handleImagePaste(event, files => stagePictureFiles(files, pictureField(event)), { consumeRejected: true, preferText: true }),
                onDragOver: event => { if (hasFileDrag(event.dataTransfer)) { event.preventDefault(); setDragOver(true); } },
                onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false); },
                onDrop: event => { setDragOver(false); handleImageDrop(event, files => stagePictureFiles(files, pictureField(event))); },
                onSubmit: event => { event.preventDefault(); void controller.createAdminMotd(); } },
                React.createElement("h4", null, "New message"),
                React.createElement("p", { className: "ps-motd-meta" }, "The newest message takes over. Dates and times use your time zone."),
                React.createElement(MotdSchedulePicker, { controller, draft, busy }),
                state.copyNotice ? React.createElement("p", { role: "status", className: "ps-motd-meta" }, state.copyNotice) : null,
                body("Body (markdown)", "bodyMd"),
                picture("Picture", "image"),
                React.createElement("label", { className: "ps-motd-field" }, "Picture placement",
                    React.createElement("select", { "aria-label": "Picture placement", value: draft.imagePlacement, disabled: busy, onChange: event => controller.setMotdDraft({ imagePlacement: event.target.value }) },
                        ["above", "beside", "background"].map(value => React.createElement("option", { key: value, value }, value[0].toUpperCase() + value.slice(1))))),
                React.createElement("details", { ref: mobileRef, className: "ps-motd-mobile-editor" },
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
                    React.createElement("span", { className: "ps-motd-meta" }, formatMotdWindow(row)),
                    React.createElement("span", { className: "ps-motd-history-title", title: row.bodyMd }, row.bodyMd.replace(/^#+\s*/, "").split("\n")[0]),
                    React.createElement("span", { className: `ps-motd-status is-${row.status}` }, { live: "Live", hidden: "Hidden by later message", scheduled: "Scheduled", ended: "Ended" }[row.status]),
                    isAdmin ? React.createElement("span", { className: "ps-motd-history-actions" },
                        !mobile ? React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy,
                            "aria-label": `Duplicate message ${row.motdId}`, onClick: event => {
                                event.preventDefault(); event.stopPropagation(); void controller.duplicateAdminMotd(row.motdId);
                            } }, "Duplicate") : null,
                        React.createElement("button", { type: "button", className: "ps-mini-button is-danger", disabled: busy,
                            "aria-label": `Delete message ${row.motdId}`, onClick: event => { event.preventDefault(); event.stopPropagation(); remove(row); } }, "Delete")) : null),
                    React.createElement("div", { className: "ps-motd-history-body" },
                        React.createElement("div", { className: "ps-motd-mini" }, React.createElement(MotdContent, { message: row, pictures: images[row.motdId], mobile })),
                        React.createElement("div", { className: "ps-motd-actions" },
                            React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(row, { mobile }) }, "Show splash again"),
                            !mobile ? React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.previewMotd(row, { mobile: true }) }, "Phone view") : null))))),
            state.hasMore ? React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy || state.loading,
                onClick: () => { void controller.refreshAdminMotds({ older: true }); } }, "Load older messages") : null));
}
