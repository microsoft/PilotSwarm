export const MOTD_REFRESH_MS = 30_000;
export function createMotdState(generation = 0, portalEnabled = false) {
    return { generation, portalEnabled, current: null, preview: null, previewMobile: false, images: {}, dismissed: [],
        pendingDismissals: [], reading: false, readAt: null, error: null };
}
export function createMotdAdminState() {
    return { history: [], today: null, expandedIds: [], loading: false, saving: false, duplicatingId: null,
        draftFocusVersion: 0, copyNotice: null, error: null, notice: null,
        fetchedAt: null, hasMore: false, draft: createMotdDraft() };
}
export const MOTD_DURATIONS = Object.freeze({ hour: 3_600_000, day: 86_400_000, week: 604_800_000 });
export function createMotdDraft() {
    return { startMode: "now", endMode: "never", startDate: "", startTime: "09:00",
        endDate: "", endTime: "18:00", bodyMd: "", mobileBodyMd: "", imagePlacement: "above" };
}
export function motdLocalParts(time) {
    const date = new Date(time);
    const local = new Date(time - date.getTimezoneOffset() * 60_000).toISOString();
    return { date: local.slice(0, 10), time: local.slice(11, 16) };
}
export function motdStartsAt(message) { return message.startsAt ?? message.fromAt; }
export function motdEndsAt(message) { return message.endsAt !== undefined ? message.endsAt : message.toAt; }
export function duplicateMotdDraft(message, pictures, now) {
    const end = motdEndsAt(message);
    const duration = end == null ? null : Date.parse(end) - Date.parse(motdStartsAt(message));
    if (!Number.isFinite(now) || duration !== null && (!Number.isFinite(duration) || duration <= 0))
        throw new Error("The source message has an invalid time window.");
    // A Now preset's end is chosen before the server stamps creation time.
    const serverStart = Date.parse(motdStartsAt(message)) === Date.parse(message.createdAt);
    const preset = duration === null ? undefined
        : Object.keys(MOTD_DURATIONS).find(key => MOTD_DURATIONS[key] === duration
            || serverStart && Math.abs(MOTD_DURATIONS[key] - duration) < 60_000);
    const parts = duration === null ? {} : motdLocalParts(now + duration);
    const image = (variant, alt) => {
        const picture = pictures[variant];
        if (!picture?.base64 || !picture.contentType) throw new Error("The source picture could not be loaded. Refresh the message and retry Duplicate.");
        return { base64: picture.base64, contentType: picture.contentType, alt: alt ?? picture.alt ?? "" };
    };
    return { ...createMotdDraft(), startMode: "now", endMode: duration === null ? "never" : preset || "custom",
        ...(duration !== null ? { endDate: parts.date, endTime: parts.time } : {}),
        ...(duration !== null && !preset ? { copiedEnd: { date: parts.date, time: parts.time,
            instant: new Date(now + duration).toISOString() } } : {}),
        bodyMd: message.bodyMd,
        mobileBodyMd: message.mobileBodyMd || "", imagePlacement: message.imagePlacement || "above",
        ...(message.hasImage ? { image: image("desktop", message.imageAlt) } : {}),
        ...(message.hasMobileImage ? { mobileImage: image("mobile", message.mobileImageAlt) } : {}) };
}
export function motdDraftWindow(draft, now = Date.now()) {
    const localInstant = (date, time) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(time || "")) return NaN;
        const instant = Date.parse(`${date}T${time}`);
        if (!Number.isFinite(instant)) return NaN;
        const parts = motdLocalParts(instant);
        return parts.date === date && parts.time === time ? instant : NaN;
    };
    const from = draft.startMode === "now" ? now : localInstant(draft.startDate, draft.startTime);
    let to = null;
    if (MOTD_DURATIONS[draft.endMode]) to = from + MOTD_DURATIONS[draft.endMode];
    else if (draft.endMode === "custom") {
        const copied = draft.copiedEnd;
        to = copied && copied.date === draft.endDate && copied.time === draft.endTime
            ? Date.parse(copied.instant) : localInstant(draft.endDate, draft.endTime);
    }
    return { from, to };
}
export function motdScheduleSummary(draft, now = Date.now()) {
    const { from, to } = motdDraftWindow(draft, now);
    if (!Number.isFinite(from) || to !== null && !Number.isFinite(to)) return "Choose a valid date and time.";
    const format = value => new Date(value).toLocaleString("en-US", { weekday: "short", month: "short",
        day: "numeric", hour: "numeric", minute: "2-digit" });
    const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "long" }).formatToParts(new Date(from))
        .find(part => part.type === "timeZoneName")?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const starts = draft.startMode === "now" ? "now" : format(from);
    return to === null ? `Shows ${starts} until replaced or deleted${draft.startMode === "now" ? "." : ` (${zone}).`}`
        : `Shows ${starts} until ${format(to)} (${zone}).`;
}
export function motdPrincipal(state) {
    // Some transports provide identity only through the authenticated profile API.
    const auth = state.auth?.principal;
    return auth?.provider && auth?.subject ? auth : state.admin?.profile || null;
}
export function canReadMotd(state) {
    const principal = motdPrincipal(state);
    return state.motd?.portalEnabled === true && Boolean(principal?.provider && principal?.subject)
        && state.auth?.authorization?.allowed !== false;
}
export function selectMotd(state) {
    const motd = state.motd || createMotdState();
    const canPreview = canReadMotd(state);
    const preview = canPreview ? motd.preview : null;
    const current = canPreview && motd.current && !motd.dismissed.includes(motd.current.motdId) ? motd.current : null;
    return { message: preview || current, preview: Boolean(preview), mobile: preview ? motd.previewMobile : false,
        images: motd.images, error: motd.error };
}
