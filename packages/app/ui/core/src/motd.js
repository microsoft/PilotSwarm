export const MOTD_REFRESH_MS = 30_000;
export function createMotdState(generation = 0, portalEnabled = false) {
    return { generation, portalEnabled, current: null, preview: null, previewMobile: false, images: {}, dismissed: [],
        pendingDismissals: [], reading: false, readAt: null, error: null };
}
export function createMotdAdminState() {
    return { history: [], today: null, expandedIds: [], loading: false, saving: false, duplicatingId: null,
        draftFocusVersion: 0, copyNotice: null, error: null, notice: null,
        fetchedAt: null, hasMore: false, draft: { fromAt: "", toAt: "", bodyMd: "", mobileBodyMd: "", imagePlacement: "above" } };
}
export function duplicateMotdDraft(message, pictures, now) {
    const duration = Date.parse(message.toAt) - Date.parse(message.fromAt);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(now)) throw new Error("The source message has an invalid time window.");
    const from = (Math.floor(now / 60_000) + 1) * 60_000;
    const localInput = time => {
        const date = new Date(time);
        return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
    };
    const image = (variant, alt) => {
        const picture = pictures[variant];
        if (!picture?.base64 || !picture.contentType) throw new Error("The source picture could not be loaded. Refresh the message and retry Duplicate.");
        return { base64: picture.base64, contentType: picture.contentType, alt: alt ?? picture.alt ?? "" };
    };
    return { fromAt: localInput(from), toAt: localInput(from + duration), bodyMd: message.bodyMd,
        mobileBodyMd: message.mobileBodyMd || "", imagePlacement: message.imagePlacement || "above",
        ...(message.hasImage ? { image: image("desktop", message.imageAlt) } : {}),
        ...(message.hasMobileImage ? { mobileImage: image("mobile", message.mobileImageAlt) } : {}) };
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
