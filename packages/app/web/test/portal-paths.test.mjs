import test from "node:test";
import assert from "node:assert/strict";
import {
    canonicalRequestPath, composePortalAuthConfig, composePortalBranding, createPortalPaths, getBrowserPortalPaths,
    isLegacyPortalPath, isPortalNavigationPath, normalizePortalBasePath, renderPortalShell,
} from "../portal-paths.js";

test("base configuration has one canonical root, mount and slash-terminated entry", () => {
    assert.equal(normalizePortalBasePath(), "/");
    assert.equal(normalizePortalBasePath(""), "/");
    for (const [input, base, entry] of [
        ["/", "/", "/"], ["/portal", "/portal", "/portal/"],
        ["/portal/", "/portal", "/portal/"], ["/tools/agents/", "/tools/agents", "/tools/agents/"],
        ["/a-._~0/z", "/a-._~0/z", "/a-._~0/z/"],
    ]) {
        const paths = createPortalPaths(input);
        assert.equal(paths.basePath, base);
        assert.equal(paths.entryPath, entry);
        assert.equal(paths.path("/api/health"), `${entry}api/health`);
        assert.equal(paths.path("/"), entry);
    }
});

test("malformed base paths fail rather than being silently normalized", () => {
    for (const input of [
        "portal", "//portal", "/portal//", "/portal//child", "/.", "/..", "/a/../b",
        "/%70ortal", "/portal?x=1", "/portal#x", "/a\\b", "/a b", " /portal",
        "/portal\n", "/portal\u0000", "/\uff0f", "https://example.invalid/portal",
    ]) assert.throws(() => normalizePortalBasePath(input), /PORTAL_BASE_PATH/u);
    assert.throws(() => normalizePortalBasePath(null), TypeError);
});

test("membership is exact and bare-base redirects preserve opaque queries", () => {
    for (const base of ["/", "/portal", "/tools/agents"]) {
        const paths = createPortalPaths(base);
        assert.equal(paths.contains(paths.path("/api/health?opaque=%2F%252e%0A")), true);
        assert.equal(paths.localPath(paths.path("/api/health?x=1")), "/api/health");
        if (base === "/") {
            assert.equal(paths.redirect("/?x=1"), null);
        } else {
            assert.equal(paths.redirect(`${base}?x=%2F&y=%E2%9C%93`), `${base}/?x=%2F&y=%E2%9C%93`);
            assert.equal(paths.redirect(`${base}/?x=1`), null);
            for (const miss of ["/", `${base}ish/`, `${base.toUpperCase()}/`, "/elsewhere/"]) {
                assert.equal(paths.contains(miss), false);
                assert.equal(paths.localPath(miss), null);
            }
        }
    }
});

test("raw and multiply encoded structural aliases never become routable paths", () => {
    assert.equal(canonicalRequestPath("/portal/api/health"), "/portal/api/health");
    for (const target of [
        "/portal//api", "/portal/./api", "/portal/a/../api", "/portal/%2e/api",
        "/portal/%2E%2e/api", "/portal/%252e%252e/api", "/portal/%25%32%65%25%32%65/api",
        "/portal/a%2fb", "/portal/a%5Cb", "/portal/a%252fb", "/portal/a\\b",
        "/portal/%00", "/portal/%250d", "/portal/%7f", "/portal/%zz", "/portal/%ff",
        "/portal/raw space", "/portal/api#fragment", "https://example.invalid/portal/",
    ]) assert.equal(canonicalRequestPath(target), null, target);
});

test("Unicode lookalikes are data, never normalized separators or dot segments", () => {
    const paths = createPortalPaths("/portal");
    for (const value of ["\uff0f", "\uff3c", "\uff0e"]) {
        for (const spelling of [value, encodeURIComponent(value)]) {
            const local = `/portal/${spelling}/report`;
            assert.equal(canonicalRequestPath(local), local);
            assert.equal(paths.contains(local), true);
            assert.equal(paths.contains(`/portal${spelling}api/health`), false);
        }
    }
    assert.equal(paths.path("/reports/caf%C3%A9?opaque=%2f#section"), "/portal/reports/caf%C3%A9?opaque=%2f#section");
    assert.equal(canonicalRequestPath("/portal/100%25.txt"), "/portal/100%25.txt");
});

test("only navigation-shaped paths can fall through to the portal shell", () => {
    for (const target of ["/", "/sessions/abc", "/tools/agents?session=abc"]) {
        assert.equal(isPortalNavigationPath(target), true);
    }
    for (const target of ["/api", "/API/missing", "/assets/missing", "/src/main.jsx", "/app.js", "/public", "/%70ublic/session", "/favicon.ico", "/.env", "/nested/missing.pdf"]) {
        assert.equal(isPortalNavigationPath(target), false, target);
    }
});

test("obsolete public clients are excluded using the static server's decoded filename", () => {
    for (const target of ["/app.js", "/%61pp.js?x=1", "/app%2ejs", "/public", "/%70ublic/index.html", "/public/%61pp.js"]) {
        assert.equal(isLegacyPortalPath(target), true, target);
    }
    for (const target of ["/application.js", "/publications", "/publications/intro", "/sessions/public", "/%2570ublic/index.html"]) {
        assert.equal(isLegacyPortalPath(target), false, target);
    }
});

test("shell bootstrap is fixed configuration, not request or canvas content", () => {
    const shell = '<head><meta name="pilotswarm-base-path" content="/" /><base href="/" /><script src="./assets/main.js"></script></head>';
    assert.equal(renderPortalShell(shell, createPortalPaths("/")), shell);
    const nested = renderPortalShell(shell, createPortalPaths("/tools/agents"));
    assert.ok(nested.includes('<base href="/tools/agents/" />'));
    assert.ok(nested.indexOf('<base ') < nested.indexOf("<script"));
    assert.ok(nested.includes('src="./assets/main.js"'));
    assert.throws(() => renderPortalShell("<html>canvas document</html>", createPortalPaths("/portal")), /bootstrap markers/u);
    assert.throws(() => renderPortalShell(shell + shell, createPortalPaths("/portal")), /bootstrap markers/u);
});

test("root auth payloads keep their exact callback strings and object identity", () => {
    const config = Object.freeze({ provider: "entra", enabled: true, client: Object.freeze({
        clientId: "fixture-client", authority: "https://login.example.invalid",
        redirectUri: "https://portal.example.invalid",
    }) });
    assert.equal(composePortalAuthConfig(config, "/"), config);
    assert.equal(composePortalAuthConfig(config, "/portal").client.redirectUri, "https://portal.example.invalid/portal/");
    assert.equal(composePortalAuthConfig(config, "/tools/agents").client.redirectUri, "https://portal.example.invalid/tools/agents/");
    assert.equal(config.client.redirectUri, "https://portal.example.invalid");
    for (const provider of ["none", "dev", "proxy"]) {
        const withoutCallback = Object.freeze({ provider, client: null });
        assert.equal(composePortalAuthConfig(withoutCallback, "/portal"), withoutCallback);
    }
});

test("callback relocation changes only a declared root path", () => {
    for (const original of ["https://PORTAL.example.invalid", "https://PORTAL.example.invalid/"]) {
        const config = { client: { redirectUri: `${original}?x=%2F#finish` } };
        assert.equal(composePortalAuthConfig(config, "/portal").client.redirectUri,
            "https://PORTAL.example.invalid/portal/?x=%2F#finish");
    }
    const nonRoot = { client: { redirectUri: "https://portal.example.invalid/callback" } };
    assert.equal(composePortalAuthConfig(nonRoot, "/portal"), nonRoot);
});

test("browser startup uses only the trusted document marker, never the current deep-link path", () => {
    assert.throws(() => getBrowserPortalPaths({ querySelector: () => null }), /missing its base-path bootstrap/u);
    for (const base of ["/", "/portal/", "/tools/agents/"]) {
        assert.equal(getBrowserPortalPaths({
            querySelector: selector => {
                assert.equal(selector, 'meta[name="pilotswarm-base-path"]');
                return { getAttribute: name => { assert.equal(name, "content"); return base; } };
            },
        }).entryPath, base);
    }
    assert.throws(() => getBrowserPortalPaths({
        querySelector: () => ({ getAttribute: () => "//elsewhere.invalid" }),
    }), /PORTAL_BASE_PATH/u);
});

test("portal composition prefixes generated branding without changing cached/native or explicit URLs", () => {
    const branding = Object.freeze({ title: "Fixture", logoUrl: "/api/portal-assets/logo", faviconUrl: "/api/portal-assets/favicon" });
    const files = { logo: "fixture-logo.svg", favicon: "fixture-icon.svg" };
    for (const base of ["/", "/portal", "/tools/agents"]) {
        const composed = composePortalBranding(branding, files, base);
        assert.equal(composed.logoUrl, createPortalPaths(base).path("/api/portal-assets/logo"));
        assert.equal(composed.faviconUrl, createPortalPaths(base).path("/api/portal-assets/favicon"));
        assert.equal(branding.logoUrl, "/api/portal-assets/logo");
        assert.notEqual(composed, branding);
    }
    for (const value of ["https://images.example.invalid/logo.svg", "data:image/svg+xml,fixture", "/operator-managed-logo.svg"]) {
        assert.equal(composePortalBranding({ logoUrl: value }, files, "/portal").logoUrl, value);
    }
    assert.equal(composePortalBranding(branding, {}, "/portal").logoUrl, branding.logoUrl);
});
