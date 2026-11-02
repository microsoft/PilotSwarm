/**
 * The transport contract (docs/proposals/compute-providers.md).
 *
 * Every host is reached at an address, and PilotSwarm opens the connection
 * itself, through a bridge on this machine. These tests hold the bridge to
 * what PilotSwarm promises: it stays on this machine, it carries bytes
 * both ways in order, a connection that cannot be opened fails where it
 * can be seen rather than hanging, a broken connection is replaced rather
 * than reused, and closing it closes everything it was carrying.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough, Duplex } from "node:stream";
import { ComputeBridgeRegistry, ComputeRuntimeBridge } from "../../dist/compute-bridge.js";
import { ComputeProviderRegistry, checkRemoteEndpoint } from "../../dist/compute.js";

/** A stand-in for a host's runtime: an echo server with a prefix. */
function echoHost(t, prefix = "") {
    const seen = [];
    const server = net.createServer((socket) => {
        seen.push(socket);
        socket.on("error", () => { /* the test closes these */ });
        socket.on("data", (chunk) => socket.write(prefix + chunk.toString()));
    });
    t.after(() => {
        for (const socket of seen) socket.destroy();
        server.close();
    });
    return new Promise((resolve) => {
        server.listen({ host: "127.0.0.1", port: 0 }, () => resolve({ server, port: server.address().port, connections: seen }));
    });
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
        socket.once("error", reject);
    });
}

/** The first chunk the socket produces. */
function firstChunk(socket) {
    return new Promise((resolve, reject) => {
        socket.once("data", (chunk) => resolve(chunk.toString()));
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("closed before answering")));
    });
}

/**
 * Resolves when a socket ends, with the error it ended with if there was
 * one. A connection that is cut carries no message across to the other
 * side — only the fact that it is gone — so a test that wants the reason
 * reads it from the bridge, and a test that wants "it failed visibly"
 * only needs this to resolve at all.
 */
function deathOf(socket) {
    return new Promise((resolve, reject) => {
        let error = null;
        socket.on("error", (e) => { error = e; });
        socket.once("close", () => resolve(error));
        setTimeout(() => reject(new Error("the connection neither answered nor ended")), 10_000).unref();
    });
}

test("the bridge listens on this machine only", async (t) => {
    const host = await echoHost(t);
    const bridge = new ComputeRuntimeBridge(() => connect(host.port));
    t.after(() => bridge.close());
    await bridge.start();
    assert.match(bridge.address, /^127\.0\.0\.1:\d+$/);
    assert.notEqual(bridge.address, "127.0.0.1:0", "the operating system picks a real port");
});

test("bytes cross the bridge both ways, and each connection gets its own pipe", async (t) => {
    const host = await echoHost(t, "echo:");
    let opened = 0;
    const bridge = new ComputeRuntimeBridge(() => { opened++; return connect(host.port); });
    t.after(() => bridge.close());
    await bridge.start();

    const [, port] = bridge.address.split(":");
    const a = await connect(Number(port));
    t.after(() => a.destroy());
    a.write("one");
    assert.equal(await firstChunk(a), "echo:one");

    const b = await connect(Number(port));
    t.after(() => b.destroy());
    b.write("two");
    assert.equal(await firstChunk(b), "echo:two");

    assert.equal(opened, 2, "a pipe per connection, never shared");
    assert.equal(bridge.openConnections, 2);
});

test("a connection the provider cannot open fails visibly instead of hanging", async (t) => {
    const bridge = new ComputeRuntimeBridge(async () => { throw new Error("the host is not reachable"); });
    t.after(() => bridge.close());
    await bridge.start();
    const port = Number(bridge.address.split(":")[1]);

    const socket = await connect(port);
    await deathOf(socket);
    assert.match(String(bridge.lastOpenError?.message), /not reachable/,
        "and the bridge keeps the reason, for the error the turn shows");
    assert.equal(bridge.openConnections, 0);
});

test("a provider that returns something that is not a two-way stream is refused", async (t) => {
    const bridge = new ComputeRuntimeBridge(async () => ({ nothing: true }));
    t.after(() => bridge.close());
    await bridge.start();
    const socket = await connect(Number(bridge.address.split(":")[1]));
    await deathOf(socket);
    assert.match(String(bridge.lastOpenError?.message), /two-way stream/);
});

test("a pipe that breaks takes its connection with it, and the next one is a fresh pipe", async (t) => {
    const pipes = [];
    const bridge = new ComputeRuntimeBridge(async () => {
        const pipe = new PassThrough();
        pipes.push(pipe);
        return pipe;
    });
    t.after(() => bridge.close());
    await bridge.start();
    const port = Number(bridge.address.split(":")[1]);

    const socket = await connect(port);
    socket.write("hello");
    assert.equal(await firstChunk(socket), "hello", "a PassThrough answers itself");

    pipes[0].destroy(new Error("the connection to the host was lost"));
    await deathOf(socket);
    assert.equal(bridge.openConnections, 0, "a broken pipe ends its connection rather than going quiet");

    // The next connection does not reuse the dead pipe.
    const again = await connect(port);
    t.after(() => again.destroy());
    again.write("still here");
    assert.equal(await firstChunk(again), "still here");
    assert.equal(pipes.length, 2);
    assert.notEqual(pipes[1], pipes[0]);
});

test("the opener is given a deadline it can see", async (t) => {
    let seen;
    const bridge = new ComputeRuntimeBridge((signal) => {
        seen = signal;
        return new Promise(() => { /* never opens */ });
    }, { openTimeoutMs: 50 });
    t.after(() => bridge.close());
    await bridge.start();
    const socket = await connect(Number(bridge.address.split(":")[1]));
    await deathOf(socket);
    assert.match(String(bridge.lastOpenError?.message), /did not open within/,
        "the bridge keeps its own deadline, whatever the opener does with the signal");
    assert.equal(seen.aborted, true, "and the opener is told the attempt is over");
});

test("closing the bridge closes what it was carrying, and it stops listening", async (t) => {
    const host = await echoHost(t);
    const pipes = [];
    const bridge = new ComputeRuntimeBridge(async (signal) => {
        const pipe = await connect(host.port);
        pipes.push(pipe);
        void signal;
        return pipe;
    });
    await bridge.start();
    const port = Number(bridge.address.split(":")[1]);
    const socket = await connect(port);
    socket.write("x");
    await firstChunk(socket);
    assert.equal(bridge.openConnections, 1);

    await bridge.close();
    assert.equal(bridge.isClosed, true);
    assert.equal(bridge.openConnections, 0);
    await deathOf(socket);
    assert.equal(pipes[0].destroyed, true, "the pipe goes with the bridge");

    await assert.rejects(connect(port), "nothing is listening any more");
});

test("the bridge will not carry more connections than it said", async (t) => {
    const host = await echoHost(t);
    const bridge = new ComputeRuntimeBridge(() => connect(host.port), { maxConnections: 1 });
    t.after(() => bridge.close());
    await bridge.start();
    const port = Number(bridge.address.split(":")[1]);

    const first = await connect(port);
    t.after(() => first.destroy());
    first.write("a");
    await firstChunk(first);

    const second = await connect(port);
    await deathOf(second);
    assert.match(String(bridge.lastOpenError?.message), /as many connections as it will/);
});

test("a provider that opens its own connections is refused, because every host is reached at an address", () => {
    const base = {
        capabilities: { files: "none" },
        async bind() { return { ok: true, host: { kind: "k", id: "h", incarnation: "1" } }; },
        async connect() { return { ok: true, endpoint: { transport: "uri", address: "127.0.0.1:1" }, workspace: {} }; },
    };
    const registry = new ComputeProviderRegistry();

    registry.register({ ...base, kind: "plain" });
    assert.equal(registry.get("plain").kind, "plain");

    // Written against the older interface, where a provider could open the
    // connection itself. Refused where it is registered, rather than
    // accepted and then never asked to open one.
    assert.throws(
        () => registry.register({ ...base, kind: "opens-its-own", openConnection: async () => new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }) }),
        /opens its own connections/,
    );
    assert.throws(
        () => registry.register({ ...base, kind: "declares-a-transport", transport: "direct" }),
        /opens its own connections/,
    );
});

test("connections that are still opening count against the cap, so nothing can make the bridge open pipes without end", async (t) => {
    // An opener that never answers: every connection stays in flight.
    const stuck = [];
    const bridge = new ComputeRuntimeBridge(
        () => new Promise((_, reject) => { stuck.push(reject); }),
        { maxConnections: 2, openTimeoutMs: 60_000 },
    );
    t.after(() => { for (const reject of stuck) reject(new Error("test over")); return bridge.close(); });
    await bridge.start();
    const { port } = new URL(`tcp://${bridge.address}`);

    const first = await connect(Number(port));
    const second = await connect(Number(port));
    // Give both time to reach the opener.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stuck.length, 2, "both are waiting on the opener");

    const third = await connect(Number(port));
    await deathOf(third);
    assert.match(String(bridge.lastOpenError?.message), /as many connections as it will/);
    assert.equal(stuck.length, 2, "and the third never asked for a pipe");
    first.destroy();
    second.destroy();
});

test("two turns of one tree starting together get one bridge, not two", async (t) => {
    const host = await echoHost(t);
    const registry = new ComputeBridgeRegistry();
    let made = 0;
    const slowMake = async () => {
        made++;
        // The real one awaits listening and then a handshake; what matters
        // is that there is an await at all.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const bridge = new ComputeRuntimeBridge(() => connect(host.port));
        await bridge.start();
        return bridge;
    };

    const [a, b] = await Promise.all([
        registry.acquire("host-1", "fp", "session-parent", slowMake),
        registry.acquire("host-1", "fp", "session-child", slowMake),
    ]);
    t.after(() => registry.retire("host-1"));

    assert.equal(made, 1, "the second turn waits for the first bridge instead of building another");
    assert.equal(a, b, "and both reach the host down one address");
    assert.equal(registry.size, 1);
    assert.deepEqual(registry.holdersOf("host-1").sort(), ["session-child", "session-parent"]);

    // One holder letting go leaves the bridge up for the other.
    await registry.release("host-1", a, "session-child");
    assert.equal(a.isClosed, false, "a sub-agent finishing does not take the parent's bridge away");
    await registry.release("host-1", b, "session-parent");
    assert.equal(a.isClosed, true, "the last one to let go closes it");
    assert.equal(registry.size, 0);
});

test("a session asking for its bridge every turn still lets go of it once", async (t) => {
    // A session asks at the start of every turn and lets go once, when it
    // leaves the host. Counting the asks meant the count never came back
    // to zero and the bridge was left listening with nobody on it.
    const host = await echoHost(t);
    const registry = new ComputeBridgeRegistry();
    t.after(() => registry.retire("host-1"));
    const make = async () => {
        const bridge = new ComputeRuntimeBridge(() => connect(host.port));
        await bridge.start();
        return bridge;
    };

    let bridge;
    for (let turn = 0; turn < 5; turn++) bridge = await registry.acquire("host-1", "fp", "session-1", make);
    assert.deepEqual(registry.holdersOf("host-1"), ["session-1"], "five turns, one holder");

    await registry.release("host-1", bridge, "session-1");
    assert.equal(bridge.isClosed, true, "and letting go once closes it");
    assert.equal(registry.size, 0);
});

test("every bridge a worker still holds is closed when the worker stops", async (t) => {
    const host = await echoHost(t);
    const registry = new ComputeBridgeRegistry();
    const make = async () => {
        const bridge = new ComputeRuntimeBridge(() => connect(host.port));
        await bridge.start();
        return bridge;
    };
    const one = await registry.acquire("host-1", "fp", "session-1", make);
    const two = await registry.acquire("host-2", "fp", "session-2", make);
    assert.equal(registry.size, 2);

    await registry.closeAll();
    assert.equal(one.isClosed, true);
    assert.equal(two.isClosed, true);
    assert.equal(registry.size, 0, "nothing of this worker's is left listening");
});

test("a bridge is rebuilt when what it was built for has changed", async (t) => {
    const host = await echoHost(t);
    const registry = new ComputeBridgeRegistry();
    t.after(() => registry.retire("host-1"));
    const make = async () => {
        const bridge = new ComputeRuntimeBridge(() => connect(host.port));
        await bridge.start();
        return bridge;
    };

    const first = await registry.acquire("host-1", "provider-a", "session-1", make);
    const second = await registry.acquire("host-1", "provider-b", "session-1", make);

    assert.notEqual(first, second, "a bridge built for one provider is never handed to another");
    assert.equal(first.isClosed, true, "and the one it replaces is closed rather than left listening");
    assert.notEqual(first.address, second.address);
});

test("a bridge whose handshake has failed is retired, so the next turn is told what happened", async (t) => {
    const host = await echoHost(t);
    const registry = new ComputeBridgeRegistry();
    t.after(() => registry.retire("host-1"));
    const make = async () => {
        const bridge = new ComputeRuntimeBridge(() => connect(host.port));
        await bridge.start();
        return bridge;
    };

    const first = await registry.acquire("host-1", "fp", "session-1", make);
    // What the bridge records when a connection cannot prove the host.
    first.lastHandshakeError = Object.assign(new Error("COMPUTE_HANDSHAKE_FAILED: the host did not prove it holds this binding's secret"),
        { code: "COMPUTE_HANDSHAKE_FAILED" });

    const second = await registry.acquire("host-1", "fp", "session-1", make);
    assert.notEqual(second, first, "it is not handed out again");
    assert.equal(first.isClosed, true);
});

test("a remote runtime with no connection token is refused, and so is one with no secret", () => {
    const handshake = { bindingId: "b", secret: "x".repeat(64) };

    assert.throws(
        () => checkRemoteEndpoint({ transport: "uri", address: "127.0.0.1:1", handshake }, "k"),
        (error) => error.code === "COMPUTE_ENDPOINT_REFUSED" && /no connection token/.test(error.message),
    );
    assert.throws(
        () => checkRemoteEndpoint({ transport: "uri", address: "127.0.0.1:1", connectionToken: "t" }, "k"),
        (error) => error.code === "COMPUTE_HANDSHAKE_FAILED",
    );
    // A session that runs on the worker is not reached over a connection
    // at all, so there is nothing to check.
    checkRemoteEndpoint({ transport: "local" }, "k");
    checkRemoteEndpoint({ transport: "uri", address: "127.0.0.1:1", connectionToken: "t", handshake }, "k");
});

test("the worker is told when the last connection to a host has gone", async (t) => {
    const host = await echoHost(t);
    let idle = 0;
    const bridge = new ComputeRuntimeBridge(() => connect(host.port), { onIdle: () => { idle += 1; } });
    t.after(() => bridge.close());
    await bridge.start();

    const bridgePort = Number(bridge.address.split(":")[1]);
    const first = await connect(bridgePort);
    const second = await connect(bridgePort);
    first.write("one");
    second.write("two");
    await firstChunk(first);
    await firstChunk(second);
    assert.equal(bridge.openConnections, 2);

    // One connection going is not the host going.
    first.destroy();
    await deathOf(first);
    assert.equal(idle, 0, "one connection of two is not an idle bridge");

    // The host itself goes: every connection through the bridge ends, and
    // the worker is told once so it can drop what it was reaching the host
    // with.
    for (const socket of host.connections) socket.destroy();
    await deathOf(second);
    assert.equal(idle, 1, "the worker is told the host connection has gone");

    // Closing the bridge is the worker letting go itself; it is not news.
    const third = await connect(bridgePort);
    third.write("three");
    await firstChunk(third);
    await bridge.close();
    assert.equal(idle, 1, "a bridge the worker closes tells it nothing");
});

test("the worker's side of a pipe to a host keeps the connection checked", async (t) => {
    const host = await echoHost(t);
    const { openTcpPipe, COMPUTE_PIPE_KEEPALIVE_MS } = await import("../../dist/compute-bridge.js");
    // A half-open pipe to a host that is gone would otherwise look open
    // until the next write times out, which can be a whole turn later.
    const calls = [];
    const original = net.Socket.prototype.setKeepAlive;
    net.Socket.prototype.setKeepAlive = function (...args) {
        calls.push(args);
        return original.apply(this, args);
    };
    t.after(() => { net.Socket.prototype.setKeepAlive = original; });

    const pipe = await openTcpPipe(`127.0.0.1:${host.port}`, AbortSignal.timeout(5_000));
    t.after(() => pipe.destroy());
    assert.deepEqual(calls, [[true, COMPUTE_PIPE_KEEPALIVE_MS]], "keepalive is set on the worker's side of the pipe");
    assert.ok(COMPUTE_PIPE_KEEPALIVE_MS > 0);
});
