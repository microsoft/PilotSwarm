import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { pathToFileURL } from "node:url";

// The same server tests can run against the installed tarball, with no
// workspace resolution. Only transport I/O is replaced; the real auth and
// runtime ownership gates remain on the request path.
const web = process.env.PS_CORS_PACKED_WEB
    ? pathToFileURL(`${process.env.PS_CORS_PACKED_WEB}/`)
    : new URL("../", import.meta.url);
const { parseApiCorsAllowedOrigins, installApiCors } = await import(new URL("api/cors.js", web));
const ORIGIN = "https://client.example.com";
const PORT_ORIGIN = "https://client.example.com:8443";
const SETTING = "PORTAL_API_CORS_ALLOWED_ORIGINS";

for (const raw of [undefined, "", " \t\n", "__PS_UNSET__", " __PS_UNSET__ ", "[]", " [ ] "]) {
    test(`disabled CORS: ${JSON.stringify(raw)}`, () => {
        const original = process.env[SETTING];
        try {
            delete process.env[SETTING];
            assert.deepEqual(parseApiCorsAllowedOrigins(raw), []);
        } finally {
            if (original === undefined) delete process.env[SETTING]; else process.env[SETTING] = original;
        }
    });
}
const invalid = [
    "{", "null", "{}", '"https://client.example.com"', "true", "1", "[null]", "[1]", "[{}]", "[[]]",
    ...["http://client.example.com", "https://CLIENT.example.com", "https://client.example.com:443",
        "https://client.example.com/", "https://client.example.com/path", "https://client.example.com?",
        "https://client.example.com#fragment", "https://user@client.example.com", "https://user:pass@client.example.com",
        "*", "https://*.example.com", "/https:.*/", "null", "data:text/plain,x", " https://client.example.com",
        "https://client.example.com:08443", "https://client.example.com\\", "https://client.example.com#",
    ].map(origin => JSON.stringify([origin])),
    JSON.stringify([ORIGIN, ORIGIN]),
];
for (const raw of invalid) {
    test(`reject invalid config: ${raw}`, () => assert.throws(() => parseApiCorsAllowedOrigins(raw), new RegExp(SETTING)));
}
test("canonical HTTPS host, scheme and nondefault port are preserved exactly", () => {
    const origins = [ORIGIN, PORT_ORIGIN, "https://127.0.0.1:8443", "https://[::1]:8443"];
    assert.deepEqual(parseApiCorsAllowedOrigins(JSON.stringify(origins)), origins);
});

let startServer, PortalRuntime, server, base;
const io = { starts: 0, notes: 0, reads: 0, audits: 0 };
const savedEnv = { ...process.env };
before(async () => {
    for (const key of Object.keys(process.env)) {
        if (/^(PORTAL_|AUTHZ_|SESSIONS_|TLS_|PLUGIN_|PILOTSWARM_|DATABASE_URL|KUBERNETES_)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, {
        PORTAL_TUI_MODE: "local", WORKERS: "0", DATABASE_URL: "sqlite::memory:",
        PORTAL_AUTH_PROVIDER: "dev", PORTAL_AUTH_DEV_ALLOW: "true", AUTHZ_ENFORCE_OWNERSHIP: "true",
        [SETTING]: JSON.stringify([ORIGIN, PORT_ORIGIN]),
    });
    ({ PortalRuntime } = await import(new URL("runtime.js", web)));
    mock.method(PortalRuntime.prototype, "start", async function () {
        io.starts++;
        this.started = true;
        this.transport = {
            getSessionAccess: async (sessionId, owner) => ({
                rootSessionId: sessionId, isSystem: false, visibility: sessionId === "shared" ? "shared_read" : "private",
                owner: { provider: "dev", subject: "alice", displayName: "Alice" },
                viewerIsOwner: owner.subject === "alice", viewerShareAccess: sessionId === "shared" ? "read" : null,
            }),
            mgmt: {
                getSession: async sessionId => {
                    io.reads++;
                    if (sessionId === "limited") throw Object.assign(new Error("Too many requests"), { status: 429 });
                    if (sessionId === "broken") throw new Error("Unexpected fixture failure");
                    return { sessionId };
                },
            },
        };
    });
    mock.method(PortalRuntime.prototype, "stop", async () => {});
    mock.method(PortalRuntime.prototype, "noteSignInRole", () => { io.notes++; });
    mock.method(PortalRuntime.prototype, "_recordAudit", () => { io.audits++; });
    const { getAuthProvider } = await import(new URL("auth.js", web));
    const provider = getAuthProvider();
    const authenticate = provider.authenticateRequest.bind(provider);
    // A provider-level no-role identity fixture exercises real authenticateToken
    // and authorizePrincipal rejection without an external identity service.
    mock.method(provider, "authenticateRequest", token => token === "test-no-role"
        ? { provider: "dev", subject: "unprivileged", roles: ["auditor"] } : authenticate(token));
    ({ startServer } = await import(new URL("server.js", web)));
    server = await startServer({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await server.stopPortal();
    if (server) {
        process.removeListener("SIGINT", server.stopPortal);
        process.removeListener("SIGTERM", server.stopPortal);
    }
    mock.restoreAll();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
});

async function request(path, { origin = ORIGIN, token, headers, ...opts } = {}) {
    const response = await fetch(`${base}${path}`, {
        ...opts,
        headers: { ...(origin == null ? {} : { Origin: origin }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    });
    await response.text();
    return response;
}
function allowed(response, origin = ORIGIN) {
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(response.headers.get("access-control-expose-headers"), "Retry-After");
    assert.ok(response.headers.get("vary").split(/,\s*/).includes("Origin"));
}
function denied(response) {
    for (const header of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
        "access-control-allow-credentials", "access-control-expose-headers"]) assert.equal(response.headers.get(header), null, header);
}

test("real startServer installation: OPTIONS precedes parsing, authentication and runtime operations", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const beforeIo = { ...io };
        const response = await request("/api/v1/sessions/private/messages", {
            method: "OPTIONS", body: "{invalid", headers: {
                "Content-Type": "application/json", "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "aUtHoRiZaTiOn, cOnTeNt-TyPe",
            },
        });
        assert.equal(response.status, 204);
        allowed(response);
        assert.deepEqual(response.headers.get("access-control-allow-methods").split(","), ["GET", "POST", "PUT", "PATCH", "DELETE"]);
        assert.deepEqual(response.headers.get("access-control-allow-headers").split(","), ["Authorization", "Content-Type"]);
        assert.equal(response.headers.get("cache-control"), "no-store");
        for (const name of ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]) {
            assert.ok(response.headers.get("vary").split(/,\s*/).includes(name));
        }
        assert.deepEqual(io, beforeIo, "preflight performs no runtime or sign-in operations");
    }
});
test("negative preflights grant no permission and perform no operations", async () => {
    for (const headers of [
        { "Access-Control-Request-Method": "HEAD" },
        { "Access-Control-Request-Method": "TRACE" },
        { "Access-Control-Request-Method": "post" },
        { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization, X-Unsafe" },
        { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type," },
        {},
    ]) {
        const beforeIo = { ...io };
        const response = await request("/api/v1/sessions/private/messages", { method: "OPTIONS", headers });
        assert.equal(response.status, 204);
        denied(response);
        assert.deepEqual(io, beforeIo);
    }
    denied(await request("/api/v1/health", { origin: "https://stranger.example.com", method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "GET" } }));
});
test("origins use exact matching, not normalization or suffix/port/scheme lookalikes", async () => {
    for (const origin of [ORIGIN, PORT_ORIGIN]) allowed(await request("/api/v1/health", { origin }), origin);
    for (const origin of ["http://client.example.com", "https://client.example.com:443", "https://client.example.com:9443",
        "https://CLIENT.example.com", "https://client.example.com/", "https://client.example.com.attacker.example",
        "https://sub.client.example.com", "https://evilclient.example.com", "null"]) {
        const response = await request("/api/v1/health", { origin });
        assert.equal(response.status, 200);
        denied(response);
        assert.ok(response.headers.get("vary").includes("Origin"));
    }
});
test("only the API segment is scoped; static, portal, legacy, websocket and lookalike paths are unchanged", async () => {
    for (const path of ["/", "/assets/missing.js", "/api/health", "/api/portal-config", "/api/rpc", "/portal-ws",
        "/api/v1/ws", "/api/v10/health", "/api/v1evil", "/API/V1/health"]) {
        denied(await request(path));
    }
    for (const path of ["/api/v1", "/api/v1/health", "/api/v1/not-a-route"]) allowed(await request(path, { token: "dev:alice" }));
    const legacy = await request("/api/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"method":"getSession"}' });
    assert.equal(legacy.status, 401);
    denied(legacy);
    const native = await request("/api/v1/auth/me", { origin: null });
    assert.equal(native.status, 401);
    denied(native);
    assert.equal(native.headers.get("vary"), "Origin", "native responses also vary to prevent origin-blind cache reuse");
    denied(await request("/api/v1/health", { method: "HEAD" }));
});
test("actual authentication and authorization remain mandatory on allowed and denied origins", async () => {
    for (const origin of [ORIGIN, "https://stranger.example.com", null]) {
        for (const [token, status] of [[undefined, 401], ["bad-token", 401], ["test-no-role", 403], ["dev:alice", 200]]) {
            const beforeIo = { ...io };
            const response = await request("/api/v1/auth/me", { origin, token });
            assert.equal(response.status, status);
            if (origin === ORIGIN) allowed(response); else denied(response);
            if (status !== 200) assert.deepEqual(io, beforeIo);
        }
    }
});
test("real runtime ownership denies cross-owner reads and read-grantee writes, with CORS intact", async () => {
    const beforeReads = io.reads;
    const privateRead = await request("/api/v1/sessions/private", { token: "dev:bob" });
    assert.equal(privateRead.status, 404);
    allowed(privateRead);
    const write = await request("/api/v1/sessions/shared/messages", {
        method: "POST", token: "dev:bob", headers: { "Content-Type": "application/json" }, body: '{"prompt":"no write"}',
    });
    assert.equal(write.status, 403);
    allowed(write);
    assert.equal(io.reads, beforeReads);
    assert.ok(io.audits > 0);
    const ownerRead = await request("/api/v1/sessions/private", { token: "dev:alice" });
    assert.equal(ownerRead.status, 200);
    allowed(ownerRead);
    assert.equal(io.reads, beforeReads + 1);
});
test("real parsers retain CORS on malformed and oversized bodies before any auth/business operation", async () => {
    for (const [body, status] of [["{invalid", 400], [JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) }), 413]]) {
        const beforeIo = { ...io };
        const response = await request("/api/v1/sessions/private/messages", {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
        });
        assert.equal(response.status, status);
        allowed(response);
        assert.deepEqual(io, beforeIo);
    }
});
test("API 429/404/500 errors and actual method requests retain the early CORS headers", async () => {
    for (const [path, status] of [["/api/v1/sessions/limited", 429], ["/api/v1/sessions/broken", 500], ["/api/v1/missing", 404]]) {
        const response = await request(path, { token: "dev:alice" });
        assert.equal(response.status, status);
        allowed(response);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await request("/api/v1/missing", { token: "dev:alice", method });
        assert.equal(response.status, 404);
        allowed(response);
    }
});
test("single Allow-Origin, Retry-After exposed, and existing Vary values are merged", async () => {
    const app = express();
    app.use((_req, res, next) => { res.vary("Accept-Encoding"); next(); });
    installApiCors(app, [ORIGIN]);
    app.get("/api/v1/limited", (_req, res) => res.set("Retry-After", "7").status(429).end());
    const local = http.createServer(app);
    await new Promise(resolve => local.listen(0, "127.0.0.1", resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${local.address().port}/api/v1/limited`, { headers: { Origin: ORIGIN } });
        allowed(response);
        assert.equal(response.headers.get("retry-after"), "7");
        assert.deepEqual(response.headers.get("vary").split(/,\s*/), ["Accept-Encoding", "Origin"]);
        const raw = await new Promise((resolve, reject) => http.get({
            hostname: "127.0.0.1", port: local.address().port, path: "/api/v1/limited", headers: { Origin: ORIGIN },
        }, res => { res.resume(); res.on("end", () => resolve(res.rawHeaders)); }).on("error", reject));
        assert.equal(raw.filter(value => value.toLowerCase() === "access-control-allow-origin").length, 1);
    } finally {
        await new Promise(resolve => local.close(resolve));
    }
});
test("startup validation is fail-loud before runtime creation, and disabled/sentinel startup grants nothing", async () => {
    const original = process.env[SETTING];
    try {
        process.env[SETTING] = '["http://invalid.example.com"]';
        await assert.rejects(startServer({ port: 0 }), new RegExp(SETTING));
        for (const raw of [undefined, "", "   ", "__PS_UNSET__", "[]"]) {
            if (raw === undefined) delete process.env[SETTING]; else process.env[SETTING] = raw;
            const disabled = await startServer({ port: 0, host: "127.0.0.1" });
            try {
                const response = await fetch(`http://127.0.0.1:${disabled.address().port}/api/v1/health`, { headers: { Origin: ORIGIN } });
                assert.equal(response.status, 200);
                denied(response);
                assert.equal(response.headers.get("vary"), null);
                if (raw === "__PS_UNSET__") assert.equal(process.env[SETTING], undefined);
            } finally {
                await disabled.stopPortal();
                process.removeListener("SIGINT", disabled.stopPortal);
                process.removeListener("SIGTERM", disabled.stopPortal);
            }
        }
    } finally {
        process.env[SETTING] = original;
    }
});
