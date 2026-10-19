/**
 * Per-viewer Admin Console tree state in the TUI config file (issue 181 R24).
 *
 * One config key, `adminCollapsed`, maps a viewer to the tree nodes that
 * viewer collapsed. A TUI can sign in as different people against the same
 * config file, so the key is the signed-in principal ("provider:subject");
 * an unauthenticated local TUI uses "local". One person's choice never
 * changes another's.
 */

import { normalizeStoredAdminCollapsed } from "pilotswarm/ui-core";

export const ADMIN_COLLAPSED_CONFIG_KEY = "adminCollapsed";
const MAX_VIEWERS = 32;

export function adminTreeViewerKey(principal) {
    const provider = String(principal?.provider ?? "").trim();
    const subject = String(principal?.subject ?? "").trim();
    return provider && subject ? `${provider}:${subject}` : "local";
}

function viewerMap(config) {
    const raw = config?.[ADMIN_COLLAPSED_CONFIG_KEY];
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/** The collapsed node ids this viewer saved, or [] when none. */
export function readAdminCollapsedForViewer(config, principal) {
    return normalizeStoredAdminCollapsed(viewerMap(config)[adminTreeViewerKey(principal)]);
}

/**
 * The config patch that stores `collapsed` for this viewer and keeps every
 * other viewer's entry as it is.
 */
export function adminCollapsedConfigPatch(config, principal, collapsed) {
    const key = adminTreeViewerKey(principal);
    const others = Object.entries(viewerMap(config)).filter(([viewer]) => viewer !== key).slice(-(MAX_VIEWERS - 1));
    return {
        [ADMIN_COLLAPSED_CONFIG_KEY]: {
            ...Object.fromEntries(others),
            [key]: normalizeStoredAdminCollapsed(collapsed),
        },
    };
}
