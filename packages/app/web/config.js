import { getPluginDirsFromEnv, resolvePortalConfigBundleFromPluginDirs } from "pilotswarm/host";

let cachedPortalBundle = null;

function getPortalBundle() {
    if (!cachedPortalBundle) {
        cachedPortalBundle = resolvePortalConfigBundleFromPluginDirs(getPluginDirsFromEnv());
    }
    return cachedPortalBundle;
}

export function getPortalConfig() {
    return getPortalBundle().portalConfig;
}

export function getPortalAssetFile(assetName) {
    const key = String(assetName || "").trim();
    if (!key) return null;
    return getPortalBundle().assetFiles?.[key] || null;
}

/**
 * PORTAL_LINK_ORIGINS: named entry points for link generation.
 *
 * Format: comma-separated `Label=Origin` pairs, e.g.
 *   PORTAL_LINK_ORIGINS="Corporate=https://corp.example.com,Private/VPN=https://vpn.example.com"
 *
 * When two or more are configured, every link-producing surface (session
 * copy-link, artifact links, the canvas share dialog) offers one labeled
 * variant per origin — a sender on one network path can hand a recipient
 * on another a link that actually works. This is the platform version of
 * waldemort's dual-session-links deploy patch; deployments plug in with
 * this one env var and delete the patch.
 *
 * Validation is FAIL-LOUD at startup: a malformed value should stop the
 * portal visibly, not silently produce broken links. Rules: 2..6 entries
 * to activate (0 or absent = feature off; exactly 1 is refused as almost
 * certainly a mistake), labels nonempty/unique/<=40 chars, origins bare
 * (no path/query/hash), https required except localhost, all distinct.
 */
export function parsePortalLinkOrigins(raw = process.env.PORTAL_LINK_ORIGINS) {
    const value = String(raw || "").trim();
    if (!value) return [];
    const entries = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (entries.length === 1) {
        throw new Error("PORTAL_LINK_ORIGINS with a single entry is refused — one origin means the feature is off; unset the variable or configure at least two.");
    }

    if (entries.length > 6) {
        throw new Error("PORTAL_LINK_ORIGINS supports at most 6 entries.");
    }
    const seenLabels = new Set();
    const seenOrigins = new Set();
    return entries.map((entry) => {
        const eq = entry.indexOf("=");
        if (eq <= 0) throw new Error(`PORTAL_LINK_ORIGINS entry "${entry}" must be Label=Origin.`);
        const label = entry.slice(0, eq).trim();
        const originRaw = entry.slice(eq + 1).trim();
        if (!label || label.length > 40) throw new Error(`PORTAL_LINK_ORIGINS label "${label}" must be 1-40 characters.`);
        let url;
        try {
            url = new URL(originRaw);
        } catch {
            throw new Error(`PORTAL_LINK_ORIGINS origin "${originRaw}" is not a valid URL.`);
        }
        const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
            throw new Error(`PORTAL_LINK_ORIGINS origin "${originRaw}" must be https (http only for localhost).`);
        }
        if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
            throw new Error(`PORTAL_LINK_ORIGINS origin "${originRaw}" must be a bare origin — no path, query, hash, or credentials.`);
        }
        const origin = url.origin;
        const labelKey = label.toLowerCase();
        if (seenLabels.has(labelKey)) throw new Error(`PORTAL_LINK_ORIGINS label "${label}" is duplicated.`);
        if (seenOrigins.has(origin)) throw new Error(`PORTAL_LINK_ORIGINS origin "${origin}" is duplicated.`);
        seenLabels.add(labelKey);
        seenOrigins.add(origin);
        return { label, origin };
    });
}

export function parsePortalExternalViews(raw = process.env.PORTAL_EXTERNAL_VIEWS_JSON) {
    const value = String(raw || "").trim();
    if (!value) return [];
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error("PORTAL_EXTERNAL_VIEWS_JSON must be valid JSON.");
    }
    if (!Array.isArray(parsed)) {
        throw new Error("PORTAL_EXTERNAL_VIEWS_JSON must be a JSON array.");
    }
    if (parsed.length > 8) {
        throw new Error("PORTAL_EXTERNAL_VIEWS_JSON supports at most 8 views.");
    }
    const seenIds = new Set();
    const seenLabels = new Set();
    const seenUrls = new Set();
    return parsed.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON entry ${index} must be an object.`);
        }
        const id = String(entry.id || "").trim();
        const label = String(entry.label || "").trim();
        const urlValue = String(entry.url || "").trim();
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON entry ${index} id must be a lowercase identifier.`);
        }
        if (!label || label.length > 40) {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON entry ${index} label must be 1-40 characters.`);
        }
        const labelKey = label.toLowerCase();
        if (seenIds.has(id)) {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON id "${id}" is duplicated.`);
        }
        if (seenLabels.has(labelKey)) {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON label "${label}" is duplicated.`);
        }
        let url;
        try {
            url = new URL(urlValue, "https://portal.invalid");
        } catch {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON entry ${index} url is invalid.`);
        }
        const relative = urlValue.startsWith("/")
            && !urlValue.startsWith("//")
            && !urlValue.includes("\\")
            && url.origin === "https://portal.invalid";
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(urlValue);
        const localHttp = url.protocol === "http:"
            && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
        if (!relative && (!absolute || (url.protocol !== "https:" && !localHttp))) {
            throw new Error(
                `PORTAL_EXTERNAL_VIEWS_JSON entry ${index} url must be relative, https, or localhost http.`,
            );
        }
        if (url.username || url.password) {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON entry ${index} url must not contain credentials.`);
        }
        const normalizedUrl = relative ? urlValue : url.href;
        if (seenUrls.has(normalizedUrl)) {
            throw new Error(`PORTAL_EXTERNAL_VIEWS_JSON url "${normalizedUrl}" is duplicated.`);
        }
        seenIds.add(id);
        seenLabels.add(labelKey);
        seenUrls.add(normalizedUrl);
        return { id, label, url: normalizedUrl };
    });
}
