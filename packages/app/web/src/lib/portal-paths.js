import { getBrowserPortalPaths } from "../../portal-paths.js";

export function getPortalPaths() {
    return getBrowserPortalPaths();
}

export function getPortalEntryUrl() {
    return new URL(getPortalPaths().entryPath, window.location.origin).href;
}

export function getPortalSocketUrl(localUrl) {
    const url = new URL(getPortalPaths().path(localUrl), window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
}
