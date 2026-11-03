/**
 * Multi-origin portal links.
 *
 * A deployment can be reachable through several entry points at once — a
 * public edge and a private/VPN hostname, say — and a link built from the
 * sender's window.location.origin only works for recipients on the SAME
 * network path. When the portal is configured with named link origins,
 * every link-producing surface offers one variant per origin, labeled.
 *
 * This replaces waldemort's deploy-time monkey patch
 * (patch-pilotswarm-dual-session-links.mjs), which anchor-matched the
 * minified bundle and broke on every release. The plug-in surface is one
 * env var on the portal server: PORTAL_LINK_ORIGINS.
 */

/**
 * Rebase one produced URL onto each configured origin.
 * @param {string} url - a full URL produced against the current origin
 * @param {Array<{label: string, origin: string}>} linkOrigins
 * @returns {Array<{label: string|null, url: string}>} one entry per origin;
 *   with no (or one) configured origin, a single unlabeled entry with the
 *   original URL — zero behavior change for plain deployments.
 */
export function buildPortalLinks(url, linkOrigins) {
    const origins = Array.isArray(linkOrigins) ? linkOrigins.filter((o) => o?.origin && o?.label) : [];
    if (origins.length < 2) return [{ label: null, url: String(url || "") }];
    let suffix;
    try {
        const parsed = new URL(String(url || ""));
        suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return [{ label: null, url: String(url || "") }];
    }
    return origins.map((o) => ({ label: String(o.label), url: `${o.origin}${suffix}` }));
}

/**
 * Point a session link at one of the session's canvases:
 * `?session=<id>` becomes `?session=<id>&view=canvas&slot=<n>`.
 *
 * The recipient lands on the session with that canvas open beside the chat —
 * not `max=1`, which covers the chat and is the canvas Share dialog's link.
 * A slot outside 1..5 (or none) returns the link unchanged, so "include
 * canvas" with nothing to include can never produce a link to slot 1 by
 * accident.
 */
export function withCanvasTarget(url, slot) {
    const text = String(url || "");
    const n = Number(slot);
    if (!text || !Number.isInteger(n) || n < 1 || n > 5) return text;
    try {
        // set(), not append(): a link that already names a view or slot is
        // re-pointed, never given a second, conflicting copy.
        const parsed = new URL(text);
        parsed.searchParams.set("view", "canvas");
        parsed.searchParams.set("slot", String(n));
        return parsed.toString();
    } catch {
        return text;
    }
}

/**
 * The canvases a session link can point at, from the canvas view the portal
 * already holds (`selectCanvasView`): every drawn slot of `sessionId`, and
 * the one to preselect — the slot on screen when it is drawn, else the
 * first. Empty when the view is for another session or has no drawn canvas.
 */
export function canvasLinkChoices(canvasView, sessionId) {
    const view = canvasView || {};
    if (!sessionId || view.sessionId !== sessionId || !Array.isArray(view.slots)) {
        return { slots: [], slot: null };
    }
    const slots = view.slots
        .filter((s) => Number.isInteger(s?.slot) && s.slot >= 1 && s.slot <= 5)
        .map((s) => ({ slot: s.slot, name: typeof s.name === "string" ? s.name : "" }));
    const slot = slots.some((s) => s.slot === view.slot) ? view.slot : (slots[0]?.slot ?? null);
    return { slots, slot };
}

/**
 * Clipboard shape: a bare URL for the single-origin case; one labeled line
 * per origin otherwise, so the sender pastes both and the recipient picks
 * the one their network can reach.
 */
export function formatPortalLinksForCopy(links) {
    const list = Array.isArray(links) ? links : [];
    if (list.length <= 1) return String(list[0]?.url || "");
    return list.map((l) => `${l.label}: ${l.url}`).join("\n");
}
