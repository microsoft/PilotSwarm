export const MOTD_REFRESH_MS = 30_000;
export function createMotdState(generation = 0) {
    return { generation, current: null, preview: null, previewMobile: false, images: {}, dismissed: [],
        pendingDismissals: [], reading: false, readAt: null, error: null };
}
export function createMotdAdminState() {
    return { history: [], today: null, loading: false, saving: false, error: null, notice: null,
        fetchedAt: null, hasMore: false, draft: { fromAt: "", toAt: "", bodyMd: "", mobileBodyMd: "", imagePlacement: "above" } };
}
export function selectMotd(state) {
    const motd = state.motd || createMotdState();
    const role = state.auth?.authorization?.role;
    const canPreview = state.admin?.profile?.isAdmin === true && (!role || role === "admin" || role === "anonymous");
    const preview = canPreview ? motd.preview : null;
    const current = motd.current && !motd.dismissed.includes(motd.current.motdId) ? motd.current : null;
    return { message: preview || current, preview: Boolean(preview), mobile: preview ? motd.previewMobile : false,
        images: motd.images, error: motd.error };
}
