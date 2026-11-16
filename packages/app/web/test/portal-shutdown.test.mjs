// FU-12: the portal process did not exit within 120 s of TERM (2026-11-06 07:51Z): it stopped listening, but a connection
// stayed open and nothing ended the process. The shutdown now has one deadline: it stops accepting, sends WebSocket
// clients a close frame, stops its relays and runtime (each bounded), and cuts whatever is still open at the deadline;
// the portal process then exits.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import {
    createPortalShutdown, exitOnSignals, portalHasEmbeddedWorkers, portalShutdownTimeoutMs, PORTAL_SHUTDOWN_TIMEOUT_DEFAULT_MS,
    PORTAL_SHUTDOWN_WORKER_MARGIN_MS,
} from "../api/shutdown.js";

const SHUTDOWN_URL = new URL("../api/shutdown.js", import.meta.url).href;

/** A portal-shaped server: one route that never answers (a request in flight), and a WebSocket path. */
async function portalLike() {
    const server = http.createServer((req, res) => {
        if (req.url === "/hang") return; // never answers
        res.end("ok");
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, wss, port: server.address().port };
}

/** A raw connection that holds a request open (no answer comes). */
function holdRequest(port) {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.write("GET /hang HTTP/1.1\r\nHost: x\r\n\r\n");
    return socket;
}

/** A WebSocket peer that completes the handshake and then answers nothing, not even a close frame. */
async function deafWebSocket(port) {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    await new Promise((resolve) => socket.once("data", resolve));
    return socket;
}

const closed = (socket) => new Promise((resolve) => (socket.destroyed ? resolve() : socket.once("close", resolve)));

test("the shutdown cuts a request in flight and a WebSocket that never answers at its deadline, and says so once", async () => {
    const { server, wss, port } = await portalLike();
    const held = holdRequest(port);
    const deaf = await deafWebSocket(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(wss.clients.size, 1);
    const lines = [];
    const order = [];
    const shutdown = createPortalShutdown({
        server, socketServers: [wss], timeoutMs: 300,
        log: { error: (line) => lines.push(line), warn: (line) => lines.push(line) },
        steps: [
            { name: "the relay", stop: async () => { order.push("relay"); } },
            { name: "the runtime", stop: async () => { order.push("runtime"); throw new Error("database not reachable"); } },
        ],
    });
    const started = Date.now();
    assert.equal(await shutdown(), true, "the deadline cut what was open");
    const took = Date.now() - started;
    assert.ok(took >= 250 && took < 1_500, `took ${took} ms`);
    assert.equal(shutdown(), shutdown(), "one shutdown");
    await Promise.all([closed(held), closed(deaf)]);
    assert.equal(server.listening, false);
    assert.deepEqual(order, ["relay", "runtime"], "a step that fails does not stop the others");
    assert.ok(lines.some((line) => line.includes("the runtime failed: database not reachable")));
    assert.deepEqual(lines.filter((line) => line.includes("did not finish within 300 ms")),
        ["[portal] shutdown: open connections did not finish within 300 ms; closing 1 WebSocket(s) and every open connection, and exiting"]);
    // A new connection is refused: the server stopped accepting first.
    await assert.rejects(new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(); });
        socket.on("error", reject);
    }));
});

test("with nothing held open the shutdown ends at once, closing WebSocket clients that answer, and reports nothing", async () => {
    const { server, wss, port } = await portalLike();
    const { WebSocket } = await import("ws");
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve) => client.once("open", resolve));
    const closedWith = new Promise((resolve) => client.once("close", (code) => resolve(code)));
    const lines = [];
    const shutdown = createPortalShutdown({ server, socketServers: [wss], timeoutMs: 5_000, log: { error: (l) => lines.push(l), warn: (l) => lines.push(l) } });
    const started = Date.now();
    assert.equal(await shutdown(), false);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(await closedWith, 1001, "the client was told the portal is going away");
    assert.deepEqual(lines, []);
});

test("the deadline comes from PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS, else 20 s", () => {
    assert.equal(PORTAL_SHUTDOWN_TIMEOUT_DEFAULT_MS, 20_000);
    assert.equal(portalShutdownTimeoutMs({}), 20_000);
    assert.equal(portalShutdownTimeoutMs({ PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS: "1500" }), 1_500);
    assert.equal(portalShutdownTimeoutMs({ PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS: "soon" }), 20_000);
});

test("with embedded workers (local mode) the default deadline covers their own shutdown budget; remote mode keeps 20 s", () => {
    // Which portals run workers in their own process: local mode, WORKERS 4 by default; remote mode none.
    assert.equal(portalHasEmbeddedWorkers("local", {}), true);
    assert.equal(portalHasEmbeddedWorkers("local", { WORKERS: "2" }), true);
    assert.equal(portalHasEmbeddedWorkers("local", { WORKERS: "0" }), false);
    assert.equal(portalHasEmbeddedWorkers("remote", { WORKERS: "4" }), false);
    const embedded = (env) => portalShutdownTimeoutMs(env, { embeddedWorkers: true });
    assert.equal(PORTAL_SHUTDOWN_WORKER_MARGIN_MS, 5_000);
    // The workers' drain (60 s) and grace (15 s) by default, plus the margin.
    assert.equal(embedded({}), 80_000);
    assert.equal(embedded({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "10000", PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS: "2000" }), 17_000);
    assert.equal(embedded({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "0", PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS: "0" }), 5_000);
    // An explicit portal deadline wins, with or without embedded workers.
    assert.equal(embedded({ PILOTSWARM_PORTAL_SHUTDOWN_TIMEOUT_MS: "3000", PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "60000" }), 3_000);
    assert.equal(portalShutdownTimeoutMs({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "60000" }, { embeddedWorkers: false }), 20_000);
    // The signal handler's backstop follows the shutdown's own deadline.
    const shutdown = createPortalShutdown({ server: { close: (cb) => cb() }, timeoutMs: embedded({}) });
    assert.equal(shutdown.timeoutMs, 80_000);
});

test("a TERM exits the process within its deadline while a stream is held open", async () => {
    // A portal-shaped process that holds a request open against itself, exits on signals after its shutdown (300 ms).
    const fixture = `
        import http from "node:http";
        import net from "node:net";
        import { createPortalShutdown, exitOnSignals } from ${JSON.stringify(SHUTDOWN_URL)};
        const server = http.createServer((req, res) => { if (req.url === "/stream") { res.writeHead(200); res.write("first chunk"); } });
        server.listen(0, "127.0.0.1", () => {
            const socket = net.connect(server.address().port, "127.0.0.1");
            socket.write("GET /stream HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n");
            socket.once("data", () => {
                exitOnSignals(createPortalShutdown({ server, timeoutMs: 300 }), { timeoutMs: 300 });
                console.log("ready");
            });
        });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", fixture], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); });
        child.once("exit", (code) => reject(new Error(`exited early (${code}): ${stderr}`)));
    });
    const sent = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
    const took = Date.now() - sent;
    assert.equal(code, 0);
    assert.ok(took < 2_000, `exited ${took} ms after TERM`);
    assert.match(stderr, /\[portal\] shutdown: open connections did not finish within 300 ms/);
});

test("exitOnSignals exits once the shutdown ends, and by its backstop if the shutdown were stuck", async () => {
    const { EventEmitter } = await import("node:events");
    const target = new EventEmitter();
    const exits = [];
    exitOnSignals(async () => {}, { timeoutMs: 10, exit: (code) => exits.push(code), target });
    target.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(exits, [0]);
    const stuckTarget = new EventEmitter();
    const stuckExits = [];
    exitOnSignals(() => new Promise(() => {}), { timeoutMs: 10, exit: (code) => stuckExits.push(code), target: stuckTarget });
    stuckTarget.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.deepEqual(stuckExits, [1]);
});

// Review SF-D3: an upgrade still delivered after the shutdown began (on a connection accepted before) gets HTTP 503 and
// no WebSocket; a new TCP connection after the listener closed is refused, not answered.
test("an upgrade delivered after the shutdown began gets 503 and no WebSocket; the shutdown marks the server closing", async () => {
    const { attachWebSockets } = await import("../api/ws.js");
    const server = http.createServer((_req, res) => res.end("ok"));
    const [wss] = attachWebSockets(server, {}, [{ path: "/ws" }]);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        // Before: the upgrade is accepted.
        const before = await deafWebSocket(port);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(wss.clients.size, 1);
        before.destroy();
        // The shutdown marks the server closing as it begins; an upgrade delivered then is refused with 503.
        server.portalClosing = true;
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
        let answer = "";
        socket.on("data", (chunk) => { answer += chunk; });
        await closed(socket);
        assert.match(answer, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
        assert.match(answer, /The portal is shutting down$/);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(wss.clients.size, 0, "no WebSocket was made");
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
    // createPortalShutdown marks it as it begins.
    const marked = http.createServer();
    await new Promise((resolve) => marked.listen(0, "127.0.0.1", resolve));
    await createPortalShutdown({ server: marked, timeoutMs: 100, log: { error() {}, warn() {} } })();
    assert.equal(marked.portalClosing, true);
});
