/**
 * The side channel between a worker and a compute host
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * What these hold it to: frames are whole however the bytes arrive, both
 * ends can carry several conversations at once without one waiting for
 * another, and nothing about a frame's size or a stream's number is taken
 * on trust from the other end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ComputeChannel } from "../../dist/compute-channel.js";

/** Two connected sockets, closed when the test ends. */
function pair(t) {
    return new Promise((resolve) => {
        const server = net.createServer((incoming) => {
            incoming.on("error", () => { /* the test closes these */ });
            resolve({ host: incoming, worker, server });
        });
        let worker;
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            worker = net.connect({ host: "127.0.0.1", port: server.address().port });
            worker.on("error", () => { /* the test closes these */ });
        });
        t.after(() => {
            try { worker?.destroy(); } catch { /* already gone */ }
            server.close();
        });
    });
}

function channels(t, options = {}) {
    return pair(t).then(({ worker, host }) => {
        const workerSide = new ComputeChannel(worker, { side: "worker", ...options });
        const hostSide = new ComputeChannel(host, { side: "host", ...options });
        t.after(() => { workerSide.close(); hostSide.close(); });
        return { workerSide, hostSide, worker, host };
    });
}

function once(emitter, event) {
    return new Promise((resolve) => emitter.once(event, (...args) => resolve(args.length > 1 ? args : args[0])));
}

test("a notice sent one way arrives whole at the other", async (t) => {
    const { workerSide, hostSide } = await channels(t);
    const arrived = once(hostSide, "notice");
    hostSide.start();
    workerSide.start();
    await workerSide.notice({ t: "hello", of: "the worker" });
    assert.deepEqual(await arrived, { t: "hello", of: "the worker" });
});

test("a stream carries bytes both ways, and finishing one way leaves the other open", async (t) => {
    const { workerSide, hostSide } = await channels(t);
    const opened = once(hostSide, "stream");
    hostSide.start();
    workerSide.start();
    const sending = workerSide.open("blob", { digest: "abc" });
    const received = await opened;
    assert.equal(received.kind, "blob");
    assert.deepEqual(received.meta, { digest: "abc" });

    const chunks = [];
    received.on("data", (chunk) => chunks.push(chunk));
    const ended = once(received, "end");
    await sending.write(Buffer.from("one"));
    await sending.write(Buffer.from("two"));
    await sending.end();
    await ended;
    assert.equal(Buffer.concat(chunks).toString(), "onetwo");

    // The other direction still works after the first side has finished.
    const back = once(sending, "data");
    await received.write(Buffer.from("thanks"));
    assert.equal((await back).toString(), "thanks");
});

test("bytes split across arrivals still make whole frames", async (t) => {
    const { workerSide, hostSide, worker } = await channels(t);
    const opened = once(hostSide, "stream");
    hostSide.start();
    workerSide.start();
    const sending = workerSide.open("blob", { digest: "d" });
    const received = await opened;
    const chunks = [];
    received.on("data", (chunk) => chunks.push(chunk));
    const ended = once(received, "end");
    // Write a frame by hand, one byte at a time, so the reader has to
    // hold on to a part of a header and a part of a body.
    const body = Buffer.from("a frame delivered in pieces");
    const header = Buffer.alloc(9);
    header.writeUInt8(3, 0);
    header.writeUInt32BE(sending.id, 1);
    header.writeUInt32BE(body.length, 5);
    for (const byte of Buffer.concat([header, body])) worker.write(Buffer.from([byte]));
    await sending.end();
    await ended;
    assert.equal(Buffer.concat(chunks).toString(), "a frame delivered in pieces");
});

test("a frame larger than this build reads ends the channel rather than being buffered", { timeout: 10_000 }, async (t) => {
    const { workerSide, hostSide, worker } = await channels(t, { maxFrameBytes: 1024 });
    const closed = once(hostSide, "close");
    hostSide.start();
    workerSide.start();
    const header = Buffer.alloc(9);
    header.writeUInt8(3, 0);
    header.writeUInt32BE(2, 1);
    header.writeUInt32BE(1024 * 1024, 5);
    worker.write(header);
    assert.match(String(await closed), /this build reads at most 1024/);
    assert.equal(hostSide.isClosed, true);
});

test("a stream number that is not the other end's to give is refused", { timeout: 10_000 }, async (t) => {
    const { workerSide, hostSide, worker } = await channels(t);
    const closed = once(hostSide, "close");
    hostSide.start();
    workerSide.start();
    // The worker's own numbers are the even ones; opening an odd one is
    // claiming a number the host hands out.
    const body = Buffer.from(JSON.stringify({ kind: "blob", meta: {} }), "utf8");
    const header = Buffer.alloc(9);
    header.writeUInt8(2, 0);
    header.writeUInt32BE(7, 1);
    header.writeUInt32BE(body.length, 5);
    worker.write(Buffer.concat([header, body]));
    assert.match(String(await closed), /not its own to give/);
});

test("a channel carries no more streams than it says it will, at either end", async (t) => {
    const { workerSide, hostSide } = await channels(t, { maxStreams: 2 });
    const refusals = [];
    hostSide.on("stream", (stream) => refusals.push(stream));
    hostSide.start();
    workerSide.start();
    workerSide.open("blob", {});
    workerSide.open("blob", {});
    assert.throws(() => workerSide.open("blob", {}), /as many streams as it will/);
});

test("closing the connection closes every stream on it, with the reason", async (t) => {
    const { workerSide, hostSide, worker } = await channels(t);
    hostSide.start();
    workerSide.start();
    const stream = workerSide.open("blob", {});
    const closed = once(stream, "close");
    worker.destroy();
    assert.ok(String(await closed).length > 0);
    assert.equal(workerSide.isClosed, true);
});
