import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket } from "ws";
import { createPortalPaths } from "../portal-paths.js";

const savedEnv = new Map();
let installPortalBoundary, installPortalStatic, installPortalDiscoveryRoutes, installJsonBodyLimits;
let createApiRouter, attachWebSockets, distDir;
const shell = '<!doctype html><html><head><meta name="pilotswarm-base-path" content="/" /><base href="/" /></head><body>portal-shell<script src="./assets/fixture-a1b2.js"></script></body></html>';

before(async () => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("PORTAL_AUTH") || key === "PORTAL_BASE_PATH" || key === "PLUGIN_DIRS") {
            savedEnv.set(key, process.env[key]);
            delete process.env[key];
        }
    }
    Object.assign(process.env, {
        PORTAL_AUTH_PROVIDER: "entra",
        PORTAL_AUTH_ENTRA_TENANT_ID: "fixture-tenant",
        PORTAL_AUTH_ENTRA_CLIENT_ID: "fixture-client",
        PLUGIN_DIRS: fileURLToPath(new URL("./fixtures/no-auth-plugin", import.meta.url)),
    });
    ({ installPortalBoundary, installPortalStatic, installPortalDiscoveryRoutes, installJsonBodyLimits } = await import("../server.js"));
    ({ createApiRouter } = await import("../api/router.js"));
    ({ attachWebSockets } = await import("../api/ws.js"));
    distDir = await mkdtemp(path.join(tmpdir(), "portal-paths-"));
    await mkdir(path.join(distDir, "assets"));
    await mkdir(path.join(distDir, "public"));
    await writeFile(path.join(distDir, "index.html"), shell);
    await writeFile(path.join(distDir, "assets/fixture-a1b2.js"), "export const fixture = true;");
    await writeFile(path.join(distDir, "app.js"), "throw new Error('obsolete client must not execute');");
    await writeFile(path.join(distDir, "public/index.html"), "obsolete public shell");
});

after(async () => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("PORTAL_AUTH") || key === "PORTAL_BASE_PATH" || key === "PLUGIN_DIRS") delete process.env[key];
    }
    for (const [key, value] of savedEnv) process.env[key] = value;
    if (distDir) await rm(distDir, { recursive: true });
});

async function harness(t, base, { bodyOnly = false } = {}) {
    process.env.PORTAL_BASE_PATH = base;
    const paths = createPortalPaths(base);
    const host = express();
    host.set("trust proxy", true);
    const app = installPortalBoundary(host, paths);
    installJsonBodyLimits(app, { workspaceFileMb: 3 });
    const calls = [];
    const runtime = {
        started: true,
        mode: "local",
        getAuthorizationPolicy: () => ({ enforce: true }),
        call: async (name, params) => { calls.push({ name, params }); return { name }; },
        downloadArtifactBinary: async (sessionId, filename) => ({
            contentType: "text/plain", body: Buffer.from(`${sessionId}:${filename}`),
        }),
        resolveCanvasShareToken: async (value) => value === "fixture-share" ? { sessionId: "fixture-session", slot: 1 } : null,
    };
    if (bodyOnly) {
        app.use((_req, res) => res.json({ ok: true }));
    } else {
        installPortalDiscoveryRoutes(app, { runtime, mode: "local", portalConfig: { basePath: paths.basePath } });
        app.use("/api/v1", createApiRouter({
            runtime,
            // This fixture checks router dispatch, not Entra token verification.
            requireAuth(req, _res, next) {
                req.auth = { principal: { provider: "none", subject: "fixture" },
                    authorization: { allowed: true, role: "user", matchedGroups: [] } };
                next();
            },
        }));
        installPortalStatic(app, paths, distDir);
    }
    host.use((_req, res) => res.status(404).type("text/plain").send("Not found"));
    host.use((error, _req, res, _next) => res.status(error.status || 500).json({ type: error.type }));
    const server = http.createServer(host);
    const sockets = attachWebSockets(server, runtime, [
        { path: paths.path("/portal-ws"), allowThemeMessages: true },
        { path: paths.path("/api/v1/ws") },
    ]);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(async () => {
        for (const wss of sockets) {
            for (const client of wss.clients) client.terminate();
            await new Promise((resolve) => wss.close(resolve));
        }
        await new Promise((resolve) => server.close(resolve));
    });
    return { paths, server, calls, origin: `http://127.0.0.1:${server.address().port}` };
}

function rawRequest(server, target, { upgrade = false } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: "127.0.0.1", port: server.address().port, path: target,
            headers: upgrade ? {
                Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": Buffer.alloc(16, 0x61).toString("base64"),
            } : {},
        }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (data) => { body += data; });
            response.on("end", () => resolve({ status: response.statusCode, body }));
        });
        request.on("upgrade", (response, socket) => {
            // The first frame can arrive in the upgrade event's head buffer.
            // This helper checks the handshake; WebSocket clients below check readiness.
            socket.destroy();
            resolve({ status: response.statusCode });
        });
        request.on("error", (error) => {
            if (upgrade && error.code === "ECONNRESET") resolve({ status: 0 });
            else reject(error);
        });
        request.end();
    });
}

for (const base of ["/", "/portal", "/tools/agents"]) {
    test(`actual discovery routes and async Entra composition under ${base}`, async (t) => {
        const { paths, origin, calls } = await harness(t, base);
        const headers = { "x-forwarded-host": "PORTAL.example.invalid", "x-forwarded-proto": "https" };
        const config = await (await fetch(`${origin}${paths.path("/api/portal-config")}`, { headers })).json();
        const legacy = await (await fetch(`${origin}${paths.path("/api/auth-config")}`, { headers })).json();
        const versioned = await (await fetch(`${origin}${paths.path("/api/v1/auth/config")}`, { headers })).json();
        assert.deepEqual(config.auth, legacy);
        assert.deepEqual(versioned, legacy);
        assert.equal(config.portal.basePath, base);
        assert.equal(legacy.client.redirectUri, `https://PORTAL.example.invalid${base === "/" ? "" : paths.entryPath}`);
        assert.equal(legacy.provider, "entra");
        assert.equal(legacy.enabled, true);
        assert.deepEqual(calls, [], "public metadata invokes no protected operation");
        for (const suffix of ["/api/health", "/api/v1/health"]) {
            assert.equal((await fetch(`${origin}${paths.path(suffix)}`)).status, 200);
        }
        const download = await fetch(`${origin}${paths.path("/api/v1/sessions/fixture/artifacts/report.txt/download")}`);
        assert.equal(download.status, 200);
        assert.equal(await download.text(), "fixture:report.txt");
    });

    test(`shell, cache and exact HTTP boundaries under ${base}`, async (t) => {
        const { paths, origin, server } = await harness(t, base);
        for (const localPath of ["/", "/index.html", "/%69ndex.html", "/sessions/fixture"]) {
            const response = await fetch(`${origin}${paths.path(localPath)}`);
            assert.equal(response.status, 200, localPath);
            assert.match(response.headers.get("cache-control"), /no-store/u);
            assert.ok((await response.text()).includes(`<base href="${paths.entryPath}" />`));
        }
        const asset = await fetch(`${origin}${paths.path("/assets/fixture-a1b2.js")}`);
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get("cache-control"), /immutable/u);
        for (const localPath of [
            "/assets/missing.js", "/api/missing", "/favicon.ico", "/app.js", "/%61pp.js", "/app%2Ejs",
            "/public", "/public/index.html", "/%70ublic/index.html", "/public/session",
        ]) {
            const response = await fetch(`${origin}${paths.path(localPath)}`);
            assert.equal(response.status, 404, localPath);
            assert.doesNotMatch(await response.text(), /portal-shell|obsolete/u);
        }
        for (const suffix of ["/./api/health", "/%2e/api/health", "/%252e%252e/api/health", "//api/health", "/a%2fb", "/a%5Cb"]) {
            const response = await rawRequest(server, `${paths.mountPath}${suffix}`);
            assert.equal(response.status, 400, suffix);
            assert.doesNotMatch(response.body, /portal-shell/u);
        }
        if (base !== "/") {
            const redirect = await fetch(`${origin}${base}?x=%2F&y=%E2%9C%93`, { redirect: "manual" });
            assert.equal(redirect.status, 308);
            assert.equal(redirect.headers.get("location"), `${paths.entryPath}?x=%2F&y=%E2%9C%93`);
            for (const miss of ["/", "/api/health", `${base}ish/`, `${base.toUpperCase()}/`]) {
                const response = await fetch(`${origin}${miss}`);
                assert.equal(response.status, 404, miss);
                assert.doesNotMatch(await response.text(), /portal-shell/u);
            }
            for (const lookalike of ["\uff0f", "\uff3c", "\uff0e"]) {
                const encoded = encodeURIComponent(lookalike);
                const valid = await fetch(`${origin}${paths.path(`/${encoded}/report`)}`);
                assert.equal(valid.status, 200, "Unicode segment data is not compatibility-normalized");
                const miss = await fetch(`${origin}${base}${encoded}api/health`);
                assert.equal(miss.status, 404, "Unicode lookalike cannot extend the base boundary");
            }
        }
    });

    test(`actual parser limits keep their boundary at ${base}`, async (t) => {
        const { paths, origin } = await harness(t, base, { bodyOnly: true });
        for (const [localPath, mb] of [
            ["/api/v1/sessions/s1/artifacts/report.bin", 8],
            ["/api/v1/agent-packages/upload", 4],
            ["/api/v1/management/sessions/s1/workspace/files", 6],
            ["/api/v1/management/sessions/s1/canvas-workspace", 6],
            ["/api/v1/sessions/s1/messages", 2],
        ]) {
            for (const excess of [0, 1]) {
                const size = mb * 1024 * 1024 + excess;
                const body = JSON.stringify({ data: "x".repeat(size - Buffer.byteLength(JSON.stringify({ data: "" }))) });
                const response = await fetch(`${origin}${paths.path(localPath)}`, {
                    method: "POST", headers: { "content-type": "application/json" }, body,
                });
                assert.equal(response.status, excess ? 413 : 200, `${localPath}: ${size} bytes`);
                await response.arrayBuffer();
            }
        }
    });

    test(`both upgrade paths preserve share authentication and reject raw aliases at ${base}`, { timeout: 20_000 }, async (t) => {
        const { paths, origin, server } = await harness(t, base);
        for (const endpoint of ["/portal-ws", "/api/v1/ws"]) {
            const target = paths.path(endpoint);
            const wsOrigin = origin.replace("http:", "ws:");
            const client = new WebSocket(`${wsOrigin}${target}?canvasShare=fixture-share`);
            t.after(() => client.terminate());
            const ready = await new Promise((resolve, reject) => {
                client.once("message", (data) => resolve(JSON.parse(String(data))));
                client.once("error", reject);
            });
            assert.equal(ready.type, "ready", "real capability branch reaches readiness without Entra token");
            client.close();
            const unauthenticated = new WebSocket(`${wsOrigin}${target}`);
            t.after(() => unauthenticated.terminate());
            const closeCode = await new Promise((resolve, reject) => {
                unauthenticated.once("close", resolve);
                unauthenticated.once("error", reject);
            });
            assert.equal(closeCode, 4401, "existing missing-token semantics are preserved");
            assert.equal((await rawRequest(server, `${target}?canvasShare=fixture-share`, { upgrade: true })).status, 101);
            for (const invalid of [
                `${target}/suffix`, `${target}/`, `${paths.mountPath}/./${endpoint.slice(1)}`,
                `${paths.mountPath}/%2e/${endpoint.slice(1)}`, `${paths.mountPath}//${endpoint.slice(1)}`,
                ...(base === "/" ? [] : [endpoint, `${base}ish${endpoint}`]),
            ]) {
                assert.notEqual((await rawRequest(server, invalid, { upgrade: true })).status, 101, invalid);
            }
        }
    });
}
