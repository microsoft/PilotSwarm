import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createProxyAuthProvider } from "../auth/providers/proxy.js";
import { createProxyAuthExample } from "../../../../examples/proxy-auth/proxy.mjs";
import { COOKIE, cookieValue } from "../../../../examples/proxy-auth/security.mjs";
import { createProxyExampleFixture } from "./e2e/fixtures/proxy-example-server.mjs";

function request(origin, path, { method = "GET", headers = {}, body = "" } = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(origin);
        const req = http.request({ hostname: target.hostname, port: target.port, path, method, headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.once("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("Fixture request timeout")));
        req.end(body);
    });
}

function cookie(response) {
    return response.headers["set-cookie"]?.[0]?.split(";")[0];
}

async function form(fixture, action = "login", existingCookie) {
    const response = await request(fixture.origin, `/example-auth/${action}`, {
        headers: existingCookie ? { cookie: existingCookie } : {},
    });
    assert.equal(response.status, 200);
    const csrf = response.body.match(/name="csrf" value="([^"]+)"/u)?.[1];
    assert.ok(csrf);
    return { csrf, cookie: cookie(response) || existingCookie, response };
}

function post(fixture, action, session, values = {}, headers = {}) {
    const body = new URLSearchParams({ csrf: session.csrf, ...values }).toString();
    return request(fixture.origin, `/example-auth/${action}`, {
        method: "POST", body,
        headers: { cookie: session.cookie, origin: fixture.origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    });
}

async function login(fixture, persona = "alice", target = fixture.proxy.paths.entryPath) {
    const start = await form(fixture);
    const response = await post(fixture, "login", start, { persona, returnTo: target });
    assert.equal(response.status, 303);
    assert.notEqual(cookie(response), start.cookie, "login rotates the pre-session identifier");
    return { cookie: cookie(response), response, preSession: start };
}

async function connect(fixture, session, path) {
    const ws = new WebSocket(`${fixture.origin.replace("http:", "ws:")}${path}`, {
        origin: fixture.origin, headers: { cookie: session.cookie }, handshakeTimeout: 5000,
    });
    const [message] = await once(ws, "message", { signal: AbortSignal.timeout(10_000) });
    const ready = JSON.parse(message.toString());
    assert.equal(ready.type, "ready");
    assert.equal(ready.hasAuthorization, false);
    return { ws, ready };
}

function upgradeStatus(fixture, session, path, additional = {}) {
    return new Promise((resolve, reject) => {
        const origin = new URL(fixture.origin);
        const headers = {
            cookie: session.cookie, origin: fixture.origin,
            connection: "Upgrade", upgrade: "websocket",
            "sec-websocket-key": Buffer.alloc(16, 0x72).toString("base64"), "sec-websocket-version": "13",
            ...additional,
        };
        for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
        const req = http.request({ hostname: origin.hostname, port: origin.port, path, headers }, (res) => {
            res.resume();
            res.once("end", () => resolve(res.statusCode));
        });
        req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        req.once("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("Upgrade fixture timed out")));
        req.end();
    });
}

async function fixture(t, options) {
    const result = await createProxyExampleFixture(options);
    t.after(() => result.close());
    return result;
}

for (const basePath of ["/", "/portal", "/tools/agents"]) {
    test(`demo forwards encoded API parameters without weakening request guards under ${basePath}`, async (t) => {
        const f = await fixture(t, { basePath });
        const session = await login(f);
        const target = `${f.proxy.paths.mountPath}/api/v1/graph/namespaces/corpus%2Facme`;
        for (const method of ["GET", "DELETE"]) {
            const response = await request(f.origin, target, { method, headers: { cookie: session.cookie, origin: f.origin } });
            assert.equal(response.status, 200);
            assert.equal(f.calls.at(-1).url, target, "encoded bytes reach the upstream unchanged");
            assert.equal(f.calls.at(-1).principal, "demo-alice");
        }
        const calls = f.calls.length;
        assert.equal((await request(f.origin, target, { method: "DELETE", headers: { cookie: session.cookie } })).status, 403);
        for (const suffix of [
            "/a%2fb", "/api/v1/graph/namespaces/%2e%2e", "/api/v1/graph/namespaces/..%2F..",
            "/api/v1/graph/namespaces/corpus%252Facme", "/api/v1/graph/namespaces/corpus%5Cacme",
        ]) assert.equal((await request(f.origin, `${f.proxy.paths.mountPath}${suffix}`, { headers: { cookie: session.cookie } })).status, 400, suffix);
        assert.equal(f.calls.length, calls);
        assert.equal(await upgradeStatus(f, session, target), 400, "socket upgrade paths retain strict canonicalization");
    });

    test(`signed demo HTTP and both sockets work beneath ${basePath}`, { timeout: 15_000 }, async (t) => {
        const f = await fixture(t, { basePath });
        const session = await login(f);
        const response = await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: session.cookie } });
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).principal.subject, "demo-alice");
        assert.equal(JSON.parse(response.body).authorization.allowed, true);
        assert.ok(f.calls.at(-1).hasAssertion);
        assert.equal(f.calls.at(-1).hasAuthorization, false);
        assert.equal(f.calls.at(-1).hasCookie, false);
        for (const path of ["/portal-ws", "/api/v1/ws"]) {
            const { ws, ready } = await connect(f, session, f.proxy.paths.path(path));
            assert.equal(ready.subject, "demo-alice");
            const closed = once(ws, "close");
            ws.close();
            await closed;
        }
        const jwks = JSON.parse((await request(f.origin, "/example-auth/jwks")).body);
        assert.equal(jwks.keys[0].alg, "RS256");
        assert.equal(jwks.keys[0].use, "sig");
        assert.equal(jwks.keys[0].kty, "RSA");
        assert.equal(Object.hasOwn(jwks.keys[0], "d"), false);
    });

    test(`safe returns, public landing and exact boundary at ${basePath}`, async (t) => {
        const f = await fixture(t, { basePath });
        const target = `${f.proxy.paths.entryPath}?session=a%2Fb%20c#panel=one`;
        assert.equal((await login(f, "alice", target)).response.headers.location, target);
        for (const malicious of ["//evil.invalid/", "/%2e%2e/escape", `${f.proxy.paths.entryPath}?canvasShare=secret`, `${f.proxy.paths.entryPath}#canvasShare=secret`]) {
            assert.equal((await login(f, "bob", malicious)).response.headers.location, f.proxy.paths.entryPath);
        }
        if (basePath !== "/") {
            assert.match((await request(f.origin, "/")).body, /Local persona demo/u);
            assert.equal((await request(f.origin, `${basePath}evil/`)).status, 404);
            assert.equal((await request(f.origin, "/api/auth/me")).status, 404);
        }
        for (const alias of ["/a//b", "/%252e%252e/b", "/%2fapi/auth/me", "/a\\b"]) {
            assert.equal((await request(f.origin, alias)).status, 400);
        }
    });
}

test("demo forms preserve same-origin Origin while other replies retain no-referrer", async (t) => {
    const f = await fixture(t);
    const signIn = await form(f);
    assert.equal(signIn.response.headers["referrer-policy"], "same-origin");
    const signed = await post(f, "login", signIn, { persona: "alice" });
    assert.equal(signed.status, 303);
    assert.equal(signed.headers["referrer-policy"], "no-referrer");
    const signOut = await form(f, "logout", cookie(signed));
    assert.equal(signOut.response.headers["referrer-policy"], "same-origin");
    const jwks = await request(f.origin, "/example-auth/jwks");
    assert.equal(jwks.status, 200);
    assert.equal(jwks.headers["referrer-policy"], "no-referrer");
});

test("demo opt-in, loopback, bounds and cookie attributes are explicit", async () => {
    await assert.rejects(createProxyAuthExample(), /demo: true/u);
    for (const publicOrigin of ["http://localhost:3001", "http://0.0.0.0:3001", "https://example.invalid:3001", "http://127.0.0.1:3001/path"]) {
        await assert.rejects(createProxyAuthExample({ demo: true, publicOrigin, upstreamOrigin: "http://127.0.0.1:3002" }), /origins/u);
    }
    await assert.rejects(createProxyAuthExample({ demo: true, publicOrigin: "http://127.0.0.1:3001", upstreamOrigin: "http://127.0.0.1:3002", sessionTtlSeconds: 0 }), /sessionTtlSeconds/u);
    assert.equal(cookieValue("opaque", 900, false), `${COOKIE}=opaque; Path=/; HttpOnly; SameSite=Strict; Max-Age=900`);
    assert.equal(cookieValue(null, 0, true), `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`);
});

test("all mutation verbs require the exact Origin and Host before forwarding", async (t) => {
    const f = await fixture(t);
    const session = await login(f);
    const path = f.proxy.paths.path("/api/fixture");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.equal((await request(f.origin, path, { method, headers: { cookie: session.cookie, origin: f.origin } })).status, 200);
        for (const origin of [undefined, "null", "http://evil.invalid", `${f.origin}/`, `${f.origin}.evil.invalid`]) {
            const before = f.calls.length;
            const headers = { cookie: session.cookie };
            if (origin !== undefined) headers.origin = origin;
            assert.equal((await request(f.origin, path, { method, headers })).status, 403);
            assert.equal(f.calls.length, before);
        }
    }
    for (const method of ["GET", "POST", "HEAD"]) {
        assert.equal((await request(f.origin, path, { method, headers: { cookie: session.cookie, origin: f.origin, host: "evil.invalid" } })).status, 421);
    }
    for (const method of ["OPTIONS", "TRACE", "PROPFIND"]) {
        const response = await request(f.origin, path, { method, headers: { cookie: session.cookie, origin: f.origin } });
        assert.equal(response.status, 405);
        assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
});

test("spoofed browser headers cannot select identity or reach the portal", async (t) => {
    const f = await fixture(t);
    const session = await login(f, "bob");
    const result = await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: {
        cookie: session.cookie, authorization: "Bearer attacker-input", "x-forwarded-user": "demo-ada",
        "x-forwarded-host": "evil.invalid", "x-forwarded-proto": "https",
        "cf-access-jwt-assertion": "attacker-input", "x-pilotswarm-demo-assertion": "attacker-input",
    } });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).principal.subject, "demo-bob");
    assert.equal(f.calls.at(-1).hasAuthorization, false);
    assert.equal(f.calls.at(-1).spoofedUser, undefined);
    assert.equal(f.calls.at(-1).forwardedHost, new URL(f.origin).host);
    assert.equal((await request(f.upstreamOrigin, f.proxy.paths.path("/api/auth/me"))).status, 401);
});

test("login and logout reject missing, wrong and other-session CSRF without mutation", async (t) => {
    const f = await fixture(t);
    const alice = await form(f);
    const bob = await form(f);
    for (const csrf of ["", "wrong", bob.csrf]) {
        assert.equal((await post(f, "login", alice, { persona: "ada", csrf })).status, 403);
    }
    assert.equal((await post(f, "login", alice, { persona: "alice" }, { origin: "null" })).status, 403);
    const signed = await post(f, "login", alice, { persona: "alice" });
    const session = { cookie: cookie(signed) };
    const logout = await form(f, "logout", session.cookie);
    assert.equal((await post(f, "logout", logout, { csrf: bob.csrf })).status, 403);
    const stillAllowed = await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: session.cookie } });
    assert.equal(stillAllowed.status, 200);
    assert.equal((await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: alice.cookie } })).status, 401);
    assert.equal((await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: `${session.cookie}; ${session.cookie}` } })).status, 400);
});

test("logout revokes the session and both already-open sockets; cookie replay fails", { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const session = await login(f);
    const a = await connect(f, session, f.proxy.paths.path("/portal-ws"));
    const b = await connect(f, session, f.proxy.paths.path("/api/v1/ws"));
    const closed = Promise.all([once(a.ws, "close"), once(b.ws, "close")]);
    const logout = await form(f, "logout", session.cookie);
    const result = await post(f, "logout", logout);
    assert.equal(result.status, 303);
    assert.equal(result.headers["set-cookie"][0], `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    await closed;
    assert.equal((await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: session.cookie } })).status, 401);
});

test("expiry closes a live socket without a later HTTP request and clears replayed cookies", { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, { sessionTtlSeconds: 3 });
    const session = await login(f);
    const { ws } = await connect(f, session, f.proxy.paths.path("/portal-ws"));
    await once(ws, "close");
    const result = await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: session.cookie } });
    assert.equal(result.status, 401);
    assert.match(result.headers["set-cookie"][0], /Max-Age=0/u);
});

test("two cookie sessions keep separate identities and policy denial remains 403", async (t) => {
    const f = await fixture(t);
    const a = await login(f, "alice");
    const b = await login(f, "bob");
    for (const [session, subject] of [[a, "demo-alice"], [b, "demo-bob"]]) {
        const result = await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: session.cookie } });
        assert.equal(JSON.parse(result.body).principal.subject, subject);
    }
    const denied = await login(f, "denied");
    const result = await request(f.origin, f.proxy.paths.path("/api/auth/me"), { headers: { cookie: denied.cookie } });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.body).authorization.allowed, false);
});

test("body and session caps reject work before forwarding", async (t) => {
    const f = await fixture(t, { maxBodyBytes: 1024, maxSessions: 2 });
    const session = await login(f);
    await form(f);
    assert.equal((await request(f.origin, "/example-auth/login")).status, 503);
    const before = f.calls.length;
    assert.equal((await request(f.origin, f.proxy.paths.path("/api/fixture"), {
        method: "POST", headers: { cookie: session.cookie, origin: f.origin, "content-length": "1025" }, body: "x".repeat(1025),
    })).status, 413);
    assert.equal(f.calls.length, before);
});

test("both upgrades enforce Origin, Host, exact path and absent browser-token protocols", async (t) => {
    const f = await fixture(t);
    const session = await login(f);
    for (const suffix of ["/portal-ws", "/api/v1/ws"]) {
        const path = f.proxy.paths.path(suffix);
        assert.equal(await upgradeStatus(f, session, path), 101);
        for (const origin of [undefined, "null", "http://evil.invalid", `${f.origin}/`]) {
            assert.equal(await upgradeStatus(f, session, path, { origin }), 403);
        }
        assert.equal(await upgradeStatus(f, session, path, { host: "evil.invalid" }), 421);
        assert.equal(await upgradeStatus(f, session, path, { "sec-websocket-protocol": "access_token.attacker-input" }), 400);
        assert.equal(await upgradeStatus(f, { cookie: `${COOKIE}=invalid` }, path), 401);
        assert.equal(await upgradeStatus(f, session, `${path}/extra`), 400);
    }
});

test("open sockets occupy bounded slots before another handshake can start", async (t) => {
    const f = await fixture(t, { maxSocketsPerSession: 1 });
    const session = await login(f);
    const { ws } = await connect(f, session, f.proxy.paths.path("/portal-ws"));
    assert.equal(await upgradeStatus(f, session, f.proxy.paths.path("/api/v1/ws")), 429);
    const closed = once(ws, "close");
    ws.close();
    await closed;
});

test("header-mode fixture uses a private Unix socket and strips browser identity", {
    skip: process.platform === "win32" ? "This fixture verifies POSIX socket permissions." : false,
}, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pilotswarm-header-auth-"));
    const socketPath = join(directory, "backend.sock");
    const provider = createProxyAuthProvider({ env: {
        PORTAL_AUTH_PROXY_MODE: "header", PORTAL_AUTH_PROXY_TRUST_HEADERS: "true",
        PORTAL_AUTH_PROXY_SUBJECT_HEADER: "x-auth-request-user",
    } });
    const backend = http.createServer((req, res) => {
        provider.authenticateRequest(null, req).then((principal) => {
            res.writeHead(principal ? 200 : 401, { "content-type": "application/json" });
            res.end(JSON.stringify({ subject: principal?.subject ?? null }));
        }).catch(() => res.writeHead(500).end());
    });
    const edge = http.createServer((req, res) => {
        // The trusted test edge selects a fixed identity; browser headers are
        // never copied. This is an isolated header-mode fixture, not an IdP.
        const forwarded = http.request({
            socketPath, path: "/", method: "GET", headers: { "x-auth-request-user": "fixture-alice" },
        }, (response) => {
            res.writeHead(response.statusCode, { "content-type": "application/json" });
            response.pipe(res);
        });
        forwarded.once("error", () => res.writeHead(502).end());
        forwarded.end();
    });
    t.after(async () => {
        for (const server of [edge, backend]) {
            server.closeAllConnections();
            if (server.listening) await new Promise(resolve => server.close(resolve));
        }
        await rm(directory, { recursive: true, force: true });
    });
    await chmod(directory, 0o700);
    await new Promise((resolve, reject) => { backend.once("error", reject); backend.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    assert.equal(backend.address(), socketPath, "backend has no TCP address");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    await new Promise((resolve, reject) => { edge.once("error", reject); edge.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${edge.address().port}`;
    const valid = await request(origin, "/");
    assert.equal(valid.status, 200);
    assert.equal(JSON.parse(valid.body).subject, "fixture-alice");
    const forged = await request(origin, "/", { headers: {
        "x-auth-request-user": "attacker", "x-auth-request-email": "attacker@example.invalid",
        "x-forwarded-user": "attacker", authorization: "Bearer attacker-input",
    } });
    assert.equal(forged.status, 200);
    assert.equal(JSON.parse(forged.body).subject, "fixture-alice");
    // Socket permissions are a local-user boundary, not protection from other
    // processes with this UID. Production header mode still needs its own isolation.
});
