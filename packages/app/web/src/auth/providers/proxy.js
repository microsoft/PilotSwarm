import { createPortalPaths, resolvePortalActionUrl, validatePortalActionUrl } from "../../../portal-paths.js";

export function createProxyBrowserAuthProvider({ location = globalThis.location } = {}) {
    let client;
    let paths;

    function navigate(template, returnUrl) {
        const target = resolvePortalActionUrl(template, returnUrl, paths);
        if (target === null) return { redirected: false };
        location.assign(target);
        return { redirected: true };
    }

    return {
        authenticatesFromRequest: true,
        async initialize(config, basePath = "/") {
            if (config?.enabled !== true || config?.client?.authenticatesFromRequest !== true) {
                throw new Error("Proxy browser sign-in requires an enabled request-authentication capability.");
            }
            paths = createPortalPaths(basePath);
            client = {
                signInUrl: validatePortalActionUrl(config.client.signInUrl),
                signOutUrl: validatePortalActionUrl(config.client.signOutUrl),
            };
            return { account: null, accessToken: null };
        },
        async signIn() {
            if (!client) throw new Error("Proxy browser sign-in is not initialized.");
            return navigate(client.signInUrl, `${location.pathname}${location.search}${location.hash}`);
        },
        async signOut() {
            if (!client) throw new Error("Proxy browser sign-in is not initialized.");
            if (!client.signOutUrl) return { redirected: false, upstreamManaged: true };
            return navigate(client.signOutUrl, paths.entryPath);
        },
        async getAccessToken() {
            return null;
        },
        getAccount() {
            return null;
        },
    };
}
