/**
 * The transport contract (docs/proposals/compute-providers.md).
 *
 * A provider is reached one way and one way only. Either its hosts are at
 * an address and PilotSwarm connects to them itself, or the provider opens
 * the connection in its own code and PilotSwarm puts a bridge on this
 * machine in front of it. These tests hold the bridge to what PilotSwarm
 * promises: it stays on this machine, it carries bytes both ways in order,
 * a connection that cannot be opened fails where it can be seen rather
 * than hanging, a broken connection is replaced rather than reused, and
 * closing it closes everything it was carrying.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough, Duplex } from "node:stream";
import { ComputeRuntimeBridge } from "../../dist/compute-bridge.js";
import { ComputeProviderRegistry } from "../../dist/compute.js";

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

test("the provider is given a deadline it can see", async (t) => {
    let seen;
    const bridge = new ComputeRuntimeBridge((signal) => {
        seen = signal;
        return new Promise(() => { /* never opens */ });
    }, { openTimeoutMs: 50 });
    t.after(() => bridge.close());
    await bridge.start();
    const socket = await connect(Number(bridge.address.split(":")[1]));
    await deathOf(socket);
    assert.match(String(bridge.lastOpenError?.message), /did not open a connection within/,
        "the bridge keeps its own deadline, whatever the provider does with the signal");
    assert.equal(seen.aborted, true, "and the provider is told the attempt is over");
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

test("a provider declares one transport, and the registry holds it to it", () => {
    const base = {
        capabilities: { files: "none" },
        async bind() { return { ok: true, host: { kind: "k", id: "h", incarnation: "1" } }; },
        async connect() { return { ok: true, endpoint: { transport: "pipe" }, workspace: {} }; },
    };
    const registry = new ComputeProviderRegistry();

    // Saying nothing means reached directly, which is what the built-ins do.
    registry.register({ ...base, kind: "plain", connect: async () => ({ ok: true, endpoint: { transport: "uri", address: "127.0.0.1:1" }, workspace: {} }) });
    assert.equal(registry.get("plain").transport, undefined);

    registry.register({ ...base, kind: "opens-its-own", transport: "pipe", openConnection: async () => new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }) });
    assert.equal(registry.get("opens-its-own").transport, "pipe");

    assert.throws(
        () => registry.register({ ...base, kind: "says-pipe-has-none", transport: "pipe" }),
        /says it opens its own connections but has no openConnection/,
    );
    assert.throws(
        () => registry.register({ ...base, kind: "says-direct-has-code", transport: "direct", openConnection: async () => null }),
        /reached directly, so it must not have openConnection/,
    );
    assert.throws(
        () => registry.register({ ...base, kind: "made-up", transport: "carrier-pigeon" }),
        /unknown transport/,
    );
});
