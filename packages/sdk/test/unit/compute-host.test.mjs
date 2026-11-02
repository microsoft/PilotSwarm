/**
 * The host component (docs/proposals/compute-providers.md, "The handshake
 * and host component").
 *
 * The small PilotSwarm program that sits on a host in front of the agent
 * runtime. What these hold it to: nothing reaches the runtime until both
 * ends have proved they hold the binding's secret; once they have, it
 * carries bytes and nothing else; it serves one binding and refuses any
 * other; and closing it drops what it was carrying.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { newComputeHandshakeSecret, runWorkerHandshake } from "../../dist/compute-handshake.js";
import { startComputeHost } from "../../dist/compute-host.js";
import { ComputeRuntimeBridge, openTcpPipe } from "../../dist/compute-bridge.js";

/** A stand-in for the agent runtime: an echo server that counts connections. */
function echoRuntime(t) {
    const sockets = [];
    const server = net.createServer((socket) => {
        sockets.push(socket);
        socket.on("error", () => { /* the test closes these */ });
        socket.on("data", (chunk) => socket.write(`runtime:${chunk.toString()}`));
    });
    t.after(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
    });
    return new Promise((resolve) => {
        server.listen({ host: "127.0.0.1", port: 0 }, () =>
            resolve({ port: server.address().port, connections: () => sockets.length }));
    });
}

function connect(t, address) {
    const [host, port] = address.split(":");
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port: Number(port) }, () => resolve(socket));
        socket.once("error", reject);
        t.after(() => socket.destroy());
    });
}

/**
 * The handshake leaves the stream paused with anything it read past the
 * last frame put back, so a reader resumes it — which is what the bridge
 * and the host component do by piping it.
 */
function once(stream) {
    return new Promise((resolve) => {
        stream.once("data", (chunk) => resolve(chunk.toString()));
        stream.resume();
    });
}

test("the host component carries bytes to the runtime once both ends have proved themselves", async (t) => {
    const runtime = await echoRuntime(t);
    const credential = { bindingId: "binding-forward", secret: newComputeHandshakeSecret() };
    const component = await startComputeHost({
        ...credential,
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.port}`,
    });
    t.after(() => component.close());

    assert.equal(runtime.connections(), 0, "nothing reaches the runtime before a connection is made");
    const socket = await connect(t, component.address);
    await runWorkerHandshake(socket, credential, { timeoutMs: 5_000 });
    socket.write("hello");
    assert.equal(await once(socket), "runtime:hello");
    assert.equal(runtime.connections(), 1);

    // And it goes on being a plain byte stream.
    socket.write("again");
    assert.equal(await once(socket), "runtime:again");
});

test("a connection that cannot prove itself never reaches the runtime", async (t) => {
    const runtime = await echoRuntime(t);
    const component = await startComputeHost({
        bindingId: "binding-refuse",
        secret: newComputeHandshakeSecret(),
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.port}`,
        handshakeTimeoutMs: 500,
    });
    t.after(() => component.close());

    const socket = await connect(t, component.address);
    await assert.rejects(
        runWorkerHandshake(socket, { bindingId: "binding-refuse", secret: newComputeHandshakeSecret() }, { timeoutMs: 5_000 }));
    assert.equal(runtime.connections(), 0, "the runtime was never connected to");
    // The host's own side gives up on its deadline and counts the refusal.
    for (let i = 0; i < 40 && component.refused === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(component.refused, 1);
});

test("the host component serves one binding and refuses any other", async (t) => {
    const runtime = await echoRuntime(t);
    const secret = newComputeHandshakeSecret();
    const component = await startComputeHost({
        bindingId: "binding-one", secret,
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.port}`,
    });
    t.after(() => component.close());

    const socket = await connect(t, component.address);
    await assert.rejects(runWorkerHandshake(socket, { bindingId: "binding-two", secret }, { timeoutMs: 5_000 }));
    assert.equal(runtime.connections(), 0);
});

test("a bridge in front of the host component carries a whole turn's worth of bytes", async (t) => {
    const runtime = await echoRuntime(t);
    const credential = { bindingId: "binding-bridged", secret: newComputeHandshakeSecret() };
    const component = await startComputeHost({
        ...credential,
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.port}`,
    });
    t.after(() => component.close());

    // This is exactly what the worker does: one bridge per binding, every
    // pipe through it proved before it is joined to anything.
    const bridge = new ComputeRuntimeBridge(
        (signal) => openTcpPipe(component.address, signal),
        { handshake: credential });
    t.after(() => bridge.close());
    await bridge.start();
    await bridge.verify();

    const socket = await connect(t, bridge.address);
    socket.write("through the bridge");
    assert.equal(await once(socket), "runtime:through the bridge");
});

test("a bridge with the wrong secret fails before any of the turn crosses", async (t) => {
    const runtime = await echoRuntime(t);
    const component = await startComputeHost({
        bindingId: "binding-wrong", secret: newComputeHandshakeSecret(),
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.port}`,
    });
    t.after(() => component.close());

    const bridge = new ComputeRuntimeBridge(
        (signal) => openTcpPipe(component.address, signal),
        { handshake: { bindingId: "binding-wrong", secret: newComputeHandshakeSecret() } });
    t.after(() => bridge.close());
    await bridge.start();
    await assert.rejects(bridge.verify(), (error) => error.code === "COMPUTE_HANDSHAKE_FAILED");
    assert.equal(runtime.connections(), 0);
});

test("a host component nobody connects to ends itself, so a host nobody came back to is freed", async (t) => {
    const runtime = await echoRuntime(t);
    let idle = 0;
    const component = await startComputeHost({
        bindingId: "binding-idle",
        secret: newComputeHandshakeSecret(),
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.port}`,
        idleTimeoutMs: 120,
        onIdle: () => { idle++; },
    });
    t.after(() => component.close());

    // Waiting on the callback rather than on a clock: the point is that it
    // happens, not when to the millisecond.
    await new Promise((resolve) => {
        const poll = setInterval(() => { if (idle > 0) { clearInterval(poll); resolve(); } }, 10);
    });
    assert.equal(component.isClosed, true, "it stops listening when it ends itself");
    await assert.rejects(connect(t, component.address), "and nothing can reach it afterwards");
});

test("an open connection keeps the host component alive, and the clock starts again when it ends", async (t) => {
    const runtime = await echoRuntime(t);
    const credential = { bindingId: "binding-busy", secret: newComputeHandshakeSecret() };
    let idle = 0;
    const component = await startComputeHost({
        ...credential,
        listen: { host: "127.0.0.1", port: 0 },
        runtimeAddress: `127.0.0.1:${runtime.port}`,
        idleTimeoutMs: 100,
        onIdle: () => { idle++; },
    });
    t.after(() => component.close());

    const socket = await connect(t, component.address);
    await runWorkerHandshake(socket, credential);
    // Several times the idle timeout, with the connection held open.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(idle, 0, "a session that is warm holds its connection, so its host is never taken away");
    assert.equal(component.isClosed, false);

    socket.destroy();
    await new Promise((resolve) => {
        const poll = setInterval(() => { if (idle > 0) { clearInterval(poll); resolve(); } }, 10);
    });
    assert.equal(component.isClosed, true, "once the last connection has gone, the clock runs again");
});
