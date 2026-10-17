import { test, expect } from "@playwright/test";
import express from "express";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createPortalPaths } from "../../portal-paths.js";
import { startStubServer } from "./stub-server.mjs";

const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const savedEnv = new Map();
let installPortalBoundary;
let installPortalStatic;
let installPortalDiscoveryRoutes;
let attachWebSockets;
const digest = value => createHash("sha256").update(value).digest("hex");

test.beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("PORTAL_AUTH") || key === "PORTAL_BASE_PATH" || key === "PLUGIN_DIRS") {
            savedEnv.set(key, process.env[key]);
            delete process.env[key];
        }
    }
    Object.assign(process.env, {
        PORTAL_AUTH_PROVIDER: "dev", PORTAL_AUTH_DEV_ALLOW: "true",
        PLUGIN_DIRS: fileURLToPath(new URL("../fixtures/no-auth-plugin", import.meta.url)),
    });
    ({ installPortalBoundary, installPortalStatic, installPortalDiscoveryRoutes } = await import("../../server.js"));
    ({ attachWebSockets } = await import("../../api/ws.js"));
    const shell = await readFile(`${dist}index.html`, "utf8");
    expect(shell).toContain('name="pilotswarm-base-path"');
});

test.afterAll(() => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("PORTAL_AUTH") || key === "PORTAL_BASE_PATH" || key === "PLUGIN_DIRS") delete process.env[key];
    }
    for (const [key, value] of savedEnv) process.env[key] = value;
});

async function serve(base, { workspace = false, stale = false } = {}) {
    process.env.PORTAL_BASE_PATH = base;
    const paths = createPortalPaths(base);
    const host = express();
    const app = installPortalBoundary(host, paths);
    const subscriptions = new Set();
    const kvReads = [];
    const upgrades = [];
    const runtime = {
        started: true,
        getAuthorizationPolicy: () => ({ enforce: true }),
        resolveCanvasShareToken: async token => token === "fixture-share" ? { sessionId: "fixture", slot: 1 } : null,
        canvasPlane: {
            available: true,
            subscribe: (_id, listener) => {
                subscriptions.add(listener);
                return () => subscriptions.delete(listener);
            },
        },
    };
    installPortalDiscoveryRoutes(app, {
        mode: "local",
        runtime,
        portalConfig: { basePath: base, branding: {
            title: "Fixture Portal", logoUrl: paths.path("/test-logo.svg"), faviconUrl: paths.path("/test-logo.svg"),
        } },
    });
    // API data and admission are fixtures; the built UI, routing and socket
    // handlers are real. This is path/UX coverage, not deployed auth proof.
    app.get("/api/auth/me", (_req, res) => workspace ? res.json({
        principal: { provider: "dev", subject: "fixture", displayName: "Fixture User", email: null },
        authorization: { allowed: true, role: "user", matchedGroups: [] },
    }) : res.status(401).json({ error: "Fixture requires sign-in" }));
    app.get("/test-logo.svg", (_req, res) => res.type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>'));
    app.use("/api/canvas-share", (req, res, next) => {
        if (req.query.t !== "fixture-share") return res.status(403).json({ error: "Invalid fixture capability" });
        res.set("cache-control", "no-store");
        next();
    });
    app.get("/api/canvas-share/live", (_req, res) => res.json({ live: { seq: 1, docRev: 1, payload: { greeting: "hello" } } }));
    app.get("/api/canvas-share/doc", (_req, res) => res.type("html").send(`<!doctype html>
        <html><body><button id="read">Read state</button><output id="results"></output><output id="state"></output>
        <script>
        const results = {};
        addEventListener("message", event => {
            if (event.data.type === "canvas-data") document.getElementById("state").textContent = JSON.stringify(event.data.data);
            if (event.data.type === "canvas-kv-ready" || event.data.type === "canvas-kv-result") {
                results[event.data.id] = event.data.ok;
                document.getElementById("results").textContent = JSON.stringify(results);
            }
        });
        document.getElementById("read").onclick = () => {
            for (const op of ["ready", "get", "list", "put", "delete"]) {
                parent.postMessage({ type: "canvas-kv", id: op, op, key: "app/greeting" }, "*");
            }
        };
        </script></body></html>`));
    app.get("/api/canvas-share/kv", (req, res) => {
        kvReads.push({ key: req.query.key || null, method: req.method });
        res.json({ entries: [{ key: "app/greeting", rev: 1, v: "hello" }], canWrite: false });
    });
    const apiStub = workspace ? await startStubServer(0, { sessionCount: 1 }) : null;
    if (apiStub) {
        app.use("/api/v1", (req, res, next) => {
            const request = http.request({
                hostname: "127.0.0.1", port: apiStub.port,
                path: `/api/v1${req.url}`, method: req.method, headers: req.headers,
            }, response => {
                res.writeHead(response.statusCode, response.headers);
                response.pipe(res);
            });
            request.on("error", next);
            req.pipe(request);
        });
    }
    if (stale) app.get("/", (req, res, next) => {
        if (req.get("accept") !== "text/html") return next();
        res.type("html").send('<script src="./assets/index-different-build.js"></script>');
    });
    installPortalStatic(app, paths, dist);
    host.use((_req, res) => res.status(404).send("Unrelated host path"));
    const server = http.createServer(host);
    server.on("upgrade", req => upgrades.push({ url: req.url, headers: req.headers }));
    const sockets = attachWebSockets(server, runtime, [
        { path: paths.path("/portal-ws"), allowThemeMessages: true },
        { path: paths.path("/api/v1/ws") },
    ]);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return { paths, kvReads, upgrades, origin: `http://127.0.0.1:${server.address().port}`,
        subscriberCount: () => subscriptions.size,
        emitCanvas: update => { for (const listener of subscriptions) listener({ slot: 1, ...update }); },
        close: async () => {
            for (const socket of sockets) {
                for (const client of socket.clients) client.terminate();
                await new Promise(resolve => socket.close(resolve));
            }
            if (apiStub) {
                apiStub.server.closeAllConnections();
                await new Promise(resolve => apiStub.server.close(resolve));
            }
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } };
}

for (const base of ["/", "/portal", "/tools/agents"]) {
    test(`the same production bundle loads and reloads beneath ${base}`, async ({ page }) => {
        const fixture = await serve(base);
        const requests = [];
        const failures = [];
        page.on("request", request => requests.push(new URL(request.url())));
        page.on("pageerror", error => failures.push(error.message));
        try {
            await page.goto(`${fixture.origin}${base}`);
            await expect(page.locator(".portal-gate-title")).toHaveText("Sign in to Fixture Portal");
            await expect(page.locator(".portal-dev-persona-button").first()).toBeVisible();
            await expect(page.locator(".portal-gate-brand img")).toBeVisible();
            await expect(page.locator('meta[name="pilotswarm-base-path"]')).toHaveAttribute("content", fixture.paths.entryPath);
            expect(new URL(page.url()).pathname).toBe(fixture.paths.entryPath);
            await page.goto(`${fixture.origin}${fixture.paths.path("/sessions/fixture?session=fixture#section")}`);
            await expect(page.locator(".portal-dev-persona-button").first()).toBeVisible();
            await page.reload();
            await expect(page.locator(".portal-dev-persona-button").first()).toBeVisible();
            expect(failures).toEqual([]);
            const portalRequests = requests.filter(url => url.origin === fixture.origin && url.pathname !== base);
            expect(portalRequests.every(url => fixture.paths.contains(url.pathname))).toBe(true);
            const assetPaths = [...new Set(portalRequests.map(url => fixture.paths.localPath(url.pathname)).filter(path => path?.startsWith("/assets/")))];
            expect(assetPaths.some(path => path.endsWith(".js"))).toBe(true);
            expect(assetPaths.some(path => path.endsWith(".css"))).toBe(true);
            for (const path of assetPaths) {
                const response = await page.request.get(`${fixture.origin}${fixture.paths.path(path)}`);
                expect(response.status()).toBe(200);
                expect(digest(await response.body())).toBe(digest(await readFile(`${dist}${path.slice(1)}`)));
            }
            expect(portalRequests.some(url => url.pathname === fixture.paths.path("/api/portal-config"))).toBe(true);
            expect(portalRequests.some(url => url.pathname === fixture.paths.path("/test-logo.svg"))).toBe(true);
        } finally {
            await fixture.close();
        }
    });

    test(`built dev workspace and freshness use the canonical entry beneath ${base}`, async ({ page }) => {
        const fixture = await serve(base, { workspace: true, stale: true });
        const requests = [];
        page.on("request", request => requests.push({ url: new URL(request.url()), type: request.resourceType() }));
        try {
            await page.goto(`${fixture.origin}${fixture.paths.path("/sessions/fixture")}`);
            await page.locator(".portal-dev-persona-button").first().click();
            await expect(page.locator(".portal-header")).toBeVisible();
            await expect(page.locator(".portal-header-refresh")).toBeVisible();
            await expect.poll(() => requests.some(request => request.url.pathname.startsWith(fixture.paths.path("/api/v1/")))).toBe(true);
            expect(requests.some(request => request.type === "fetch" && request.url.pathname === fixture.paths.entryPath)).toBe(true);
            expect(requests.filter(request => request.url.pathname === fixture.paths.path("/api/portal-config"))).toHaveLength(1);
            expect(requests.filter(request => request.url.protocol === "http:" && request.url.origin === fixture.origin).every(request => fixture.paths.contains(request.url.pathname))).toBe(true);
        } finally {
            await fixture.close();
        }
    });

    test(`built canvas share preserves its prefixed HTTP, socket and read-only KV paths beneath ${base}`, async ({ page }) => {
        const fixture = await serve(base);
        const requests = [];
        page.on("request", request => requests.push(new URL(request.url())));
        try {
            await page.goto(`${fixture.origin}${fixture.paths.entryPath}?canvasShare=fixture-share`);
            const iframe = page.locator('iframe[title="Shared canvas"]');
            await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
            const frame = page.frameLocator('iframe[title="Shared canvas"]');
            await expect(frame.locator("#state")).toHaveText('{"greeting":"hello"}');
            await frame.locator("#read").click();
            await expect.poll(() => frame.locator("#results").textContent().then(text => text ? JSON.parse(text) : null))
                .toEqual({ ready: true, get: true, list: true, put: false, delete: false });
            await expect.poll(() => fixture.upgrades.length).toBe(1);
            await expect.poll(() => fixture.subscriberCount()).toBe(1);
            expect(fixture.upgrades[0].url).toBe(`${fixture.paths.path("/api/v1/ws")}?canvasShare=fixture-share`);
            expect(fixture.upgrades[0].headers.authorization).toBeUndefined();
            expect(fixture.upgrades[0].headers["sec-websocket-protocol"]).toBeUndefined();
            const before = fixture.kvReads.length;
            fixture.emitCanvas({ kind: "kv", op: "put", key: "app/greeting", rev: 2 });
            await expect.poll(() => fixture.kvReads.length).toBe(before + 1);
            expect(fixture.kvReads.every(read => read.method === "GET")).toBe(true);
            for (const endpoint of ["/live", "/doc", "/kv"]) {
                expect(requests.some(url => url.pathname === fixture.paths.path(`/api/canvas-share${endpoint}`))).toBe(true);
            }
            expect(requests.filter(url => url.protocol === "http:" && url.origin === fixture.origin).every(url => fixture.paths.contains(url.pathname))).toBe(true);
        } finally {
            await fixture.close();
        }
    });
}
