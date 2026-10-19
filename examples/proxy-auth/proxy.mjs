import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createProxyAuthProvider } from "../../packages/app/web/auth/providers/proxy.js";
import { createPortalPaths, isPortalNavigationPath } from "../../packages/app/web/portal-paths.js";
import {
    ASSERTION_HEADER, AUTH_PATH, PERSONAS, RequestError, boundedInteger, checkRequest,
    cookieValue, equalSecret, escapeHtml, loopbackOrigin, rawHeader, readBody, returnTarget, secret, sessionCookie,
} from "./security.mjs";

// Reuse the repository's installed dependency; never install a separate copy.
const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(appRequire.resolve("jose")).href);
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const REQUEST_HEADERS = ["accept", "accept-encoding", "accept-language", "content-type", "content-length",
    "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "if-range", "range", "cache-control"];

function reply(res, status, body, headers = {}) {
    res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        ...headers,
    });
    res.end(body);
}

function page(res, title, content) {
    reply(res, 200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body><h1>${escapeHtml(title)}</h1><p>Local persona demo only. Anyone on this machine can select a demo user. This is not a production identity service.</p>${content}</body></html>`, {
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "same-origin",
        "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
}

function responseHeaders(headers) {
    const blocked = new Set([...HOP_HEADERS, "set-cookie", ...(headers.connection || "").split(",").map((part) => part.trim().toLowerCase())]);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}

/**
 * One trusted loopback origin, an in-memory RS256 key and bounded cookie sessions.
 * The real portal remains responsible for assertion verification and authorization.
 */
export async function createProxyAuthExample({
    demo = false, publicOrigin, upstreamOrigin, basePath = "/portal",
    sessionTtlSeconds = 900, maxSessions = 100, maxSocketsPerSession = 8,
    maxBodyBytes = 32 * 1024 * 1024, tls,
} = {}) {
    if (demo !== true) throw new Error("Explicit demo: true is required.");
    const origin = loopbackOrigin(publicOrigin, { https: true });
    const upstream = loopbackOrigin(upstreamOrigin);
    if (origin.host === upstream.host) throw new Error("The proxy and portal must use distinct ports.");
    if ((origin.protocol === "https:") !== Boolean(tls?.key && tls?.cert)) throw new Error("HTTPS needs explicit in-memory key and certificate.");
    const paths = createPortalPaths(basePath);
    if (paths.mountPath === AUTH_PATH || paths.mountPath.startsWith(`${AUTH_PATH}/`)) throw new Error("Portal base overlaps example auth routes.");
    boundedInteger(sessionTtlSeconds, 1, 3600, "sessionTtlSeconds");
    boundedInteger(maxSessions, 1, 1000, "maxSessions");
    boundedInteger(maxSocketsPerSession, 1, 32, "maxSocketsPerSession");
    boundedInteger(maxBodyBytes, 1024, 64 * 1024 * 1024, "maxBodyBytes");
    const secure = origin.protocol === "https:";
    const issuer = `${origin.origin}${AUTH_PATH}`;
    const audience = "pilotswarm-local-proxy-demo";
    const kid = secret();
    let { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const jwks = { keys: [{ ...await exportJWK(publicKey), alg: "RS256", use: "sig", kid }] };
    const portalEnv = Object.freeze({
        PORT: upstream.port,
        PORTAL_HOST: "127.0.0.1",
        PORTAL_BASE_PATH: paths.basePath,
        PORTAL_AUTH_PROVIDER: "proxy",
        PORTAL_AUTH_PROXY_MODE: "jwt",
        PORTAL_AUTH_PROXY_JWT_HEADER: ASSERTION_HEADER,
        PORTAL_AUTH_PROXY_JWKS_URL: `${origin.origin}${AUTH_PATH}/jwks`,
        PORTAL_AUTH_PROXY_ISSUER: issuer,
        PORTAL_AUTH_PROXY_AUDIENCE: audience,
        PORTAL_AUTH_PROXY_SIGN_IN_URL: `${AUTH_PATH}/login?returnTo={returnTo}`,
        PORTAL_AUTH_PROXY_SIGN_OUT_URL: `${AUTH_PATH}/logout`,
        PORTAL_AUTH_PROXY_SUBJECT_CLAIM: "sub",
        PORTAL_AUTH_PROXY_EMAIL_CLAIM: "email",
        PORTAL_AUTH_PROXY_NAME_CLAIM: "name",
        PORTAL_AUTH_PROXY_ROLES_CLAIM: "roles",
        PORTAL_AUTH_PROXY_GROUPS_CLAIM: "groups",
        PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
        PORTAL_AUTHZ_DEFAULT_ROLE: "none",
        AUTHZ_ENFORCE_OWNERSHIP: "true",
        PORTAL_AUTH_PROXY_TRUST_HEADERS: "false",
    });
    if (!createProxyAuthProvider({ env: portalEnv }).enabled) throw new Error("Demo proxy verifier is disabled.");
    const sessions = new Map();
    const connections = new Set();
    let ready = false;
    let stopped = false;

    function revoke(id) {
        const session = sessions.get(id);
        if (!session) return;
        sessions.delete(id);
        clearTimeout(session.timer);
        for (const request of session.pending) request.destroy();
        for (const socket of session.sockets) socket.destroy();
    }

    function findSession(req, { authenticated = true } = {}) {
        const id = sessionCookie(req);
        const session = sessions.get(id);
        if (session && session.expiresAt <= Date.now()) revoke(id);
        return sessions.has(id) && (!authenticated || session.persona) ? { id, session } : null;
    }

    function issueSession(res, persona = null) {
        if (sessions.size >= maxSessions) throw new RequestError(503, "Demo session capacity reached.");
        const id = secret();
        const ttl = persona ? sessionTtlSeconds : Math.min(sessionTtlSeconds, 300);
        const session = {
            persona, csrf: secret(), expiresAt: Date.now() + ttl * 1000,
            sockets: new Set(), pending: new Set(), operations: 0, timer: null,
        };
        session.timer = setTimeout(() => revoke(id), ttl * 1000);
        session.timer.unref();
        sessions.set(id, session);
        res.setHeader("set-cookie", cookieValue(id, ttl, secure));
        return { id, session };
    }

    function stillValid(current) {
        return !stopped && sessions.get(current.id) === current.session && current.session.expiresAt > Date.now();
    }

    function reserveOperation(current, responseOrSocket) {
        if (current.session.operations >= maxSocketsPerSession) throw new RequestError(429, "Demo connection capacity reached.");
        current.session.operations++;
        responseOrSocket.once("close", () => current.session.operations--);
    }

    async function assertion(persona, expiresAt) {
        if (!privateKey) throw new RequestError(503, "Demo has stopped.");
        return new SignJWT({ ...persona, groups: [] })
            .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
            .setIssuer(issuer).setAudience(audience).setIssuedAt()
            .setExpirationTime(Math.min(Math.floor(Date.now() / 1000) + 30, Math.ceil(expiresAt / 1000)))
            .sign(privateKey);
    }

    async function headersFor(req, current, upgrade = false) {
        const headers = Object.fromEntries(REQUEST_HEADERS.filter((name) => req.headers[name] !== undefined).map((name) => [name, req.headers[name]]));
        Object.assign(headers, {
            host: upstream.host, "x-forwarded-host": origin.host, "x-forwarded-proto": origin.protocol.slice(0, -1),
            [ASSERTION_HEADER]: await assertion(current.session.persona, current.session.expiresAt),
        });
        if (req.headers.origin === origin.origin) headers.origin = origin.origin;
        if (upgrade) {
            const protocols = rawHeader(req, "sec-websocket-protocol");
            if (protocols?.split(",").some((protocol) => /^access_token(?:[. ]|$)/iu.test(protocol.trim()))) {
                throw new RequestError(400, "Browser access tokens are not used by this demo.");
            }
            headers.connection = "Upgrade";
            headers.upgrade = "websocket";
            for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"]) {
                const value = rawHeader(req, name);
                if (value !== undefined) headers[name] = value;
            }
        }
        if (!stillValid(current)) throw new RequestError(401, "Session expired.");
        return headers;
    }

    async function authPage(req, res, pathname) {
        if (pathname === `${AUTH_PATH}/jwks`) {
            if (req.method !== "GET" && req.method !== "HEAD") throw new RequestError(405, "Method not supported.");
            return reply(res, 200, JSON.stringify(jwks), { "content-type": "application/json" });
        }
        if (!ready) throw new RequestError(503, "The demo portal is not ready.");
        if (pathname === `${AUTH_PATH}/health`) {
            if (!["GET", "HEAD"].includes(req.method)) throw new RequestError(405, "Method not supported.");
            return reply(res, 200, '{"ok":true}', { "content-type": "application/json" });
        }
        const action = pathname === `${AUTH_PATH}/login` ? "login" : pathname === `${AUTH_PATH}/logout` ? "logout" : null;
        if (!action) throw new RequestError(404, "Not found.");
        if (req.method === "HEAD") return reply(res, 200, "");
        if (req.method === "GET") {
            const current = findSession(req, { authenticated: false }) || issueSession(res);
            const target = returnTarget(new URL(req.url, origin).searchParams.get("returnTo"), paths.basePath);
            const personas = action === "login" ? `<label>Demo user <select name="persona">${Object.entries(PERSONAS).map(([id, value]) => `<option value="${id}">${escapeHtml(value.name)}</option>`).join("")}</select></label>` : "";
            return page(res, action === "login" ? "Demo sign-in" : "Demo sign-out",
                `<form method="post" action="${AUTH_PATH}/${action}"><input type="hidden" name="csrf" value="${current.session.csrf}"><input type="hidden" name="returnTo" value="${escapeHtml(target)}">${personas}<button type="submit">${action === "login" ? "Sign in" : "Sign out"}</button></form>`);
        }
        if (req.method !== "POST") throw new RequestError(405, "Only POST changes demo sessions.");
        if (req.headers["content-type"]?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
            throw new RequestError(415, "Expected a form body.");
        }
        const form = new URLSearchParams((await readBody(req, 8192)).toString("utf8"));
        if ([...new Set(form.keys())].some((key) => form.getAll(key).length !== 1)) throw new RequestError(400, "Duplicate form field.");
        const current = findSession(req, { authenticated: false });
        if (!current) res.setHeader("set-cookie", cookieValue(null, 0, secure));
        if (!current || !equalSecret(form.get("csrf"), current.session.csrf)) throw new RequestError(403, "Invalid session CSRF token.");
        const persona = action === "login" ? PERSONAS[form.get("persona")] : null;
        if (action === "login" && !Object.hasOwn(PERSONAS, form.get("persona"))) throw new RequestError(400, "Unknown demo user.");
        revoke(current.id);
        if (persona) issueSession(res, persona);
        else res.setHeader("set-cookie", cookieValue(null, 0, secure));
        return reply(res, 303, "", { location: persona ? returnTarget(form.get("returnTo"), paths.basePath) : `${AUTH_PATH}/signed-out` });
    }

    async function handle(req, res) {
        checkRequest(req, origin);
        const pathname = req.url.split("?", 1)[0];
        if (pathname === `${AUTH_PATH}/signed-out` || (pathname === "/" && paths.mountPath)) {
            if (!["GET", "HEAD"].includes(req.method)) throw new RequestError(405, "Method not supported.");
            return page(res, "PilotSwarm proxy-auth demo", `<a href="${AUTH_PATH}/login">Sign in to the demo</a> <a href="${paths.entryPath}">Open portal</a>`);
        }
        if (pathname.startsWith(`${AUTH_PATH}/`)) return authPage(req, res, pathname);
        if (!paths.contains(req.url)) throw new RequestError(404, "Not found.");
        if (!ready) throw new RequestError(503, "The demo portal is not ready.");
        const current = findSession(req);
        if (!current) {
            res.setHeader("set-cookie", cookieValue(null, 0, secure));
            if (req.method === "GET" && req.headers.accept?.includes("text/html") && isPortalNavigationPath(paths.localPath(req.url))) {
                return reply(res, 303, "", { location: `${AUTH_PATH}/login?returnTo=${encodeURIComponent(returnTarget(req.url, paths.basePath))}` });
            }
            throw new RequestError(401, "Demo sign-in required.");
        }
        reserveOperation(current, res);
        const body = await readBody(req, maxBodyBytes);
        const headers = await headersFor(req, current);
        // Buffer before forwarding: an over-limit mutation never reaches the portal.
        if (body.length && ["GET", "HEAD"].includes(req.method)) throw new RequestError(400, "Safe methods cannot carry a body.");
        if (body.length || req.headers["content-length"] !== undefined) headers["content-length"] = String(body.length);
        const request = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, (response) => {
            res.writeHead(response.statusCode, responseHeaders(response.headers));
            response.pipe(res);
            response.on("error", () => res.destroy());
        });
        current.session.pending.add(request);
        request.setTimeout(30_000, () => request.destroy(new Error("Upstream timeout")));
        request.on("close", () => current.session.pending.delete(request));
        request.on("error", () => {
            if (!res.headersSent) reply(res, 502, "Portal request failed.");
            else res.destroy();
        });
        res.on("close", () => { if (!res.writableFinished) request.destroy(); });
        request.end(body);
    }

    function requestFailure(error, res) {
        if (!(error instanceof RequestError)) console.error("[proxy-auth-demo] Internal request failure.");
        if (!res.headersSent) reply(res, error instanceof RequestError ? error.status : 500,
            error instanceof RequestError ? error.message : "Demo request failed.");
        else res.destroy();
    }

    const options = { maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000, ...tls };
    const server = (secure ? https : http).createServer(options, (req, res) => {
        handle(req, res).catch((error) => requestFailure(error, res));
    });
    server.maxConnections = maxSessions * (maxSocketsPerSession + 2);
    server.on("connection", (socket) => {
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
    });
    server.on("upgrade", (req, socket, head) => {
        async function upgrade() {
            checkRequest(req, origin, { upgrade: true });
            if (!ready) throw new RequestError(503, "The demo portal is not ready.");
            if (req.method !== "GET" || rawHeader(req, "upgrade")?.toLowerCase() !== "websocket"
                || ![paths.path("/portal-ws"), paths.path("/api/v1/ws")].includes(req.url.split("?", 1)[0])
                || head.length > 16 * 1024) throw new RequestError(400, "Invalid WebSocket upgrade.");
            const current = findSession(req);
            if (!current) throw new RequestError(401, "Demo sign-in required.");
            reserveOperation(current, socket);
            const headers = await headersFor(req, current, true);
            if (socket.destroyed) return;
            const request = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, headers });
            current.session.pending.add(request);
            current.session.sockets.add(socket);
            request.setTimeout(10_000, () => request.destroy(new Error("Upgrade timeout")));
            request.on("close", () => current.session.pending.delete(request));
            socket.once("close", () => { current.session.sockets.delete(socket); request.destroy(); });
            request.on("error", () => socket.destroy());
            request.on("response", (response) => { response.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
            request.on("upgrade", (response, backend, backendHead) => {
                if (!stillValid(current) || socket.destroyed) { backend.destroy(); socket.destroy(); return; }
                backend.setTimeout(0);
                current.session.sockets.add(backend);
                backend.on("error", () => socket.destroy());
                socket.on("error", () => backend.destroy());
                backend.once("close", () => { current.session.sockets.delete(backend); socket.destroy(); });
                socket.once("close", () => backend.destroy());
                const fields = responseHeaders(response.headers);
                fields.connection = "Upgrade";
                fields.upgrade = "websocket";
                const lines = Object.entries(fields).flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map((value) => `${name}: ${value}\r\n`));
                socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("")}\r\n`);
                if (backendHead.length) socket.write(backendHead);
                if (head.length) backend.write(head);
                socket.pipe(backend).pipe(socket);
            });
            request.end();
        }
        upgrade().catch((error) => {
            if (!(error instanceof RequestError)) console.error("[proxy-auth-demo] Internal upgrade failure.");
            const status = error instanceof RequestError ? error.status : 500;
            socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        });
    });

    return {
        portalEnv, paths, server,
        async listen() {
            if (stopped) throw new Error("The demo is closed.");
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(Number(origin.port), "127.0.0.1", () => { server.off("error", reject); resolve(); });
            });
        },
        async activate() {
            if (!server.listening || stopped) throw new Error("The proxy must be listening before activation.");
            const health = await fetch(`${upstream.origin}${paths.path("/api/health")}`, {
                redirect: "error", signal: AbortSignal.timeout(10_000),
            });
            if (!health.ok || (await health.json())?.ok !== true) throw new Error("The real demo portal did not report healthy.");
            // This proves the real configured portal verifies our assertion, not just public metadata.
            const token = await assertion(PERSONAS.ada, Date.now() + 30_000);
            const response = await fetch(`${upstream.origin}${paths.path("/api/auth/me")}`, {
                headers: { [ASSERTION_HEADER]: token }, redirect: "error", signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error(`Demo portal admission failed (${response.status}).`);
            const body = await response.json();
            if (body?.authorization?.allowed !== true || body?.principal?.provider !== "proxy" || body?.principal?.subject !== PERSONAS.ada.sub) {
                throw new Error("Demo portal did not verify the expected proxy identity.");
            }
            const absent = await fetch(`${upstream.origin}${paths.path("/api/auth/me")}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
            if (absent.status !== 401) throw new Error("Demo portal must reject requests without an assertion.");
            ready = true;
        },
        async close() {
            stopped = true;
            ready = false;
            for (const id of sessions.keys()) revoke(id);
            privateKey = null;
            publicKey = null;
            for (const socket of connections) socket.destroy();
            if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}
