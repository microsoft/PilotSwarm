import { beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import { once, on } from "node:events";
import WebSocket from "ws";
import { ApiClient } from "pilotswarm-sdk/api";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { runProxyAuthDemo } from "../../../../examples/proxy-auth/run.mjs";

async function reservePort() {
    const server = http.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return { server, port: server.address().port };
}

async function demoLogin(origin, persona) {
    const response = await fetch(`${origin}/example-auth/login`);
    assert.equal(response.status, 200);
    const preCookie = response.headers.get("set-cookie").split(";")[0];
    const csrf = (await response.text()).match(/name="csrf" value="([^"]+)"/u)?.[1];
    assert.ok(csrf);
    const signed = await fetch(`${origin}/example-auth/login`, {
        method: "POST", redirect: "manual",
        headers: { origin, cookie: preCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, persona }),
    });
    assert.equal(signed.status, 303);
    return signed.headers.get("set-cookie").split(";")[0];
}

async function subscriptionReply(ws, sessionId) {
    const messages = on(ws, "message", { signal: AbortSignal.timeout(10_000), close: ["close"] });
    ws.send(JSON.stringify({ type: "subscribeSession", sessionId }));
    for await (const [raw] of messages) {
        const message = JSON.parse(raw.toString());
        if (message.sessionId === sessionId && ["subscribedSession", "error"].includes(message.type)) return message;
    }
    throw new Error("Socket closed before a subscription decision.");
}

describe.concurrent("real portal behind the signed local example", () => {
    beforeAll(preflightChecks, 30_000);

    for (const base of ["/", "/portal", "/tools/agents"]) {
        it(`preserves request identity, ownership and both sockets at ${base}`, { timeout: 180_000 }, async () => {
            const env = createTestEnv("proxy");
            let demo;
            let publicPort;
            let portalPort;
            try {
                publicPort = await reservePort();
                portalPort = await reservePort();
                await Promise.all([publicPort.server, portalPort.server].map(server => new Promise(resolve => server.close(resolve))));
                demo = await runProxyAuthDemo([
                    "--demo", "--port", String(publicPort.port), "--portal-port", String(portalPort.port), "--base-path", base,
                ], { env: {
                    ...process.env, DATABASE_URL: env.store,
                    PILOTSWARM_DUROXIDE_SCHEMA: env.duroxideSchema,
                    PILOTSWARM_CMS_SCHEMA: env.cmsSchema,
                    PILOTSWARM_FACTS_SCHEMA: env.factsSchema,
                    SESSION_STATE_DIR: env.sessionStateDir,
                    WORKERS: "2",
                } });
                const origin = `http://127.0.0.1:${publicPort.port}`;
                const cookies = { alice: await demoLogin(origin, "alice"), bob: await demoLogin(origin, "bob") };
                const wire = [];
                const apiFor = (name) => new ApiClient({
                    apiUrl: `${origin}${demo.proxy.paths.entryPath}`,
                    getAccessToken: async () => null,
                    fetchImpl: (url, options = {}) => {
                        assert.equal(options.headers?.authorization, undefined, "API transport remains tokenless");
                        wire.push(new URL(url).pathname);
                        return fetch(url, { ...options, headers: { ...options.headers, cookie: cookies[name], origin } });
                    },
                });
                const alice = apiFor("alice");
                const bob = apiFor("bob");
                assert.equal((await alice.getAuthContext()).principal.subject, "demo-alice");
                assert.equal((await bob.getAuthContext()).principal.subject, "demo-bob");
                const session = await alice.call("createSession");
                assert.ok(session.sessionId);
                try {
                    await alice.call("setSessionVisibility", { sessionId: session.sessionId, visibility: "private" });
                    assert.equal((await alice.call("getSession", { sessionId: session.sessionId })).sessionId, session.sessionId);
                    await alice.call("renameSession", { sessionId: session.sessionId, title: "Alice private session" });
                    await assert.rejects(bob.call("getSession", { sessionId: session.sessionId }), error => [403, 404].includes(error.status));
                    await assert.rejects(bob.call("renameSession", { sessionId: session.sessionId, title: "Must not change" }), error => [403, 404].includes(error.status));
                    assert.equal((await alice.call("getSession", { sessionId: session.sessionId })).title, "Alice private session");
                    for (const suffix of ["/portal-ws", "/api/v1/ws"]) {
                        const path = demo.proxy.paths.path(suffix);
                        for (const user of ["alice", "bob"]) {
                            const ws = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, {
                                origin, headers: { cookie: cookies[user] }, handshakeTimeout: 10_000,
                            });
                            try {
                                const [message] = await once(ws, "message", { signal: AbortSignal.timeout(10_000) });
                                assert.equal(JSON.parse(message.toString()).type, "ready");
                                const decision = await subscriptionReply(ws, session.sessionId);
                                if (user === "alice") {
                                    assert.equal(decision.type, "subscribedSession");
                                } else {
                                    assert.equal(decision.type, "error");
                                    assert.equal(decision.code, "ACCESS_REVOKED");
                                }
                            } finally {
                                ws.terminate();
                            }
                        }
                    }
                    assert.ok(wire.every(path => demo.proxy.paths.contains(path)));
                } finally {
                    await alice.call("deleteSession", { sessionId: session.sessionId });
                }
                console.log(`  Proxy ${base}: distinct cookie identities, private ownership and two real portal sockets.`);
            } finally {
                if (publicPort?.server.listening) await new Promise(resolve => publicPort.server.close(resolve));
                if (portalPort?.server.listening) await new Promise(resolve => portalPort.server.close(resolve));
                await demo?.close();
                await env.cleanup();
            }
        });
    }
});
