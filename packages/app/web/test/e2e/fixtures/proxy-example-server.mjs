import http from "node:http";
import { WebSocketServer } from "ws";
import { createProxyAuthProvider } from "../../../auth/providers/proxy.js";
import { authorizePrincipal, getPublicAuthContext } from "../../../auth/authz/engine.js";
import { createProxyAuthExample } from "../../../../../../examples/proxy-auth/proxy.mjs";

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    return `http://127.0.0.1:${server.address().port}`;
}

// This fixture exercises the real verifier and policy. Its API is synthetic;
// full portal/CMS ownership and UI proof use the separate real-runtime suite.
export async function createProxyExampleFixture(options = {}) {
    let provider;
    let proxy;
    const calls = [];
    const sockets = new WebSocketServer({ noServer: true });
    const upstream = http.createServer((req, res) => {
        async function handle() {
            if (req.url === proxy.paths.path("/api/health")) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end('{"ok":true}');
                return;
            }
            const principal = await provider.authenticateRequest(null, req);
            const authorization = authorizePrincipal(principal, { defaultRole: "none", allowUnauthenticated: false });
            calls.push({
                url: req.url, method: req.method, principal: principal?.subject,
                hasAuthorization: Boolean(req.headers.authorization), hasCookie: Boolean(req.headers.cookie),
                forwardedHost: req.headers["x-forwarded-host"], spoofedUser: req.headers["x-forwarded-user"],
                hasAssertion: Boolean(req.headers["x-pilotswarm-demo-assertion"]),
            });
            req.resume();
            res.writeHead(principal ? authorization.allowed ? 200 : 403 : 401, { "content-type": "application/json" });
            res.end(JSON.stringify(getPublicAuthContext({ principal, authorization })));
        }
        handle().catch(() => { res.writeHead(500); res.end("Fixture error"); });
    });
    upstream.on("upgrade", (req, socket, head) => {
        sockets.handleUpgrade(req, socket, head, async (ws) => {
            try {
                const principal = await provider.authenticateRequest(null, req);
                const authorization = authorizePrincipal(principal, { defaultRole: "none", allowUnauthenticated: false });
                if (!principal || !authorization.allowed) { ws.close(principal ? 4403 : 4401); return; }
                ws.send(JSON.stringify({ type: "ready", subject: principal.subject, hasAuthorization: Boolean(req.headers.authorization) }));
            } catch {
                ws.close(1011, "Fixture error");
            }
        });
    });
    try {
        const upstreamOrigin = await listen(upstream);
        const reservation = http.createServer();
        const publicOrigin = await listen(reservation);
        try {
            proxy = await createProxyAuthExample({ demo: true, publicOrigin, upstreamOrigin, ...options });
        } finally {
            await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
        }
        provider = createProxyAuthProvider({ env: proxy.portalEnv });
        await proxy.listen();
        await proxy.activate();
        calls.length = 0;
        return {
            proxy, origin: publicOrigin, upstreamOrigin, calls,
            async close() {
                await proxy.close();
                for (const client of sockets.clients) client.terminate();
                await new Promise((resolve) => sockets.close(resolve));
                upstream.closeAllConnections();
                await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
            },
        };
    } catch (error) {
        await proxy?.close();
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        upstream.closeAllConnections();
        if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
        throw error;
    }
}
