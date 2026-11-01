export const MOTD_REFRESH_MS = 30_000;
export function createMotdState(generation = 0, portalEnabled = false) {
    return { generation, portalEnabled, current: null, preview: null, previewMobile: false, images: {}, dismissed: [],
        pendingDismissals: [], reading: false, readAt: null, error: null };
}
export function createMotdAdminState() {
    return { history: [], today: null, expandedIds: [], loading: false, saving: false, error: null, notice: null,
        fetchedAt: null, hasMore: false, draft: { fromAt: "", toAt: "", bodyMd: "", mobileBodyMd: "", imagePlacement: "above" } };
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
