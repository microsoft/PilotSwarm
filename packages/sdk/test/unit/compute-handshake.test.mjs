/**
 * The mutual handshake every remote runtime connection starts with
 * (docs/proposals/compute-providers.md, "The handshake").
 *
 * What these hold it to: both ends really do have to hold the same
 * per-binding secret; a recorded exchange cannot be played back at a host;
 * a frame that is too big, cut short or unreadable ends the exchange
 * rather than being worked around; a silent far end does not hang the
 * worker; and the proofs are compared in constant time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import {
    COMPUTE_HANDSHAKE_MAX_FRAME_BYTES,
    COMPUTE_HANDSHAKE_SECRET_MIN_CHARS,
    ComputeHandshakeError,
    computeHandshakeProof,
    isPurposeNotServed,
    isUsableHandshakeSecret,
    newComputeHandshakeSecret,
    proofsMatch,
    runHostHandshake,
    runWorkerHandshake,
} from "../../dist/compute-handshake.js";

/** A Duplex whose writes go to `out` and whose reads come from `inp`. */
function joinedDuplex(inp, out) {
    const stream = new Duplex({
        read() { /* pushed from inp */ },
        write(chunk, _enc, done) { out.write(chunk); done(); },
        final(done) { out.end(); done(); },
    });
    inp.on("data", (chunk) => stream.push(chunk));
    inp.on("end", () => stream.push(null));
    return stream;
}

function twoEnds() {
    const toHost = new PassThrough();
    const toWorker = new PassThrough();
    return {
        worker: joinedDuplex(toWorker, toHost),
        host: joinedDuplex(toHost, toWorker),
    };
}

function frame(object) {
    const body = Buffer.from(JSON.stringify(object), "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

test("a worker and a host that hold the same secret recognize each other", async () => {
    const { worker, host } = twoEnds();
    const credential = { bindingId: "binding-1", secret: newComputeHandshakeSecret() };
    await Promise.all([
        runWorkerHandshake(worker, credential, { timeoutMs: 5_000 }),
        runHostHandshake(host, credential, { timeoutMs: 5_000, seenNonces: new Set() }),
    ]);
    // Past the handshake the stream is the runtime's and nothing else.
    // The reader leaves it paused, with anything it read past the last
    // frame put back, so whoever takes it over resumes it: the bridge and
    // the host component both do that by piping it.
    const read = new Promise((resolve) => host.once("data", (chunk) => resolve(chunk.toString())));
    host.resume();
    worker.write("a prompt");
    assert.equal(await read, "a prompt");
});

test("a host with the wrong secret cannot prove itself, and the worker refuses it", async () => {
    const { worker, host } = twoEnds();
    const bindingId = "binding-2";
    const workerSide = runWorkerHandshake(worker, { bindingId, secret: newComputeHandshakeSecret() }, { timeoutMs: 5_000 });
    const hostSide = runHostHandshake(host, { bindingId, secret: newComputeHandshakeSecret() }, { timeoutMs: 800 });
    await assert.rejects(workerSide, (error) => error instanceof ComputeHandshakeError
        && /did not prove it holds this binding's secret/.test(error.message));
    await assert.rejects(hostSide);
});

test("a worker with the wrong secret is refused by the host", async () => {
    const { worker, host } = twoEnds();
    const bindingId = "binding-3";
    const secret = newComputeHandshakeSecret();
    const workerNonce = "0123456789abcdef0123456789abcdef";
    // A worker that can read the host's proof but cannot make its own.
    const hostSide = runHostHandshake(host, { bindingId, secret }, { timeoutMs: 5_000 });
    worker.write(frame({ v: 1, t: "hello", bindingId, nonce: workerNonce }));
    const answer = await new Promise((resolve) => worker.once("data", (chunk) => resolve(chunk)));
    const hostFrame = JSON.parse(answer.subarray(4).toString("utf8"));
    assert.equal(hostFrame.proof, computeHandshakeProof(secret, "host", {
        bindingId, workerNonce, hostNonce: hostFrame.nonce,
    }));
    worker.write(frame({ v: 1, t: "worker", proof: "0".repeat(64) }));
    await assert.rejects(hostSide, (error) => /did not prove it holds this binding's secret/.test(error.message));
});

test("a hello the host has already answered is refused, so a recorded exchange is worthless", async () => {
    const bindingId = "binding-4";
    const secret = newComputeHandshakeSecret();
    const seenNonces = new Set();
    const first = twoEnds();
    await Promise.all([
        runWorkerHandshake(first.worker, { bindingId, secret }, { timeoutMs: 5_000 }),
        runHostHandshake(first.host, { bindingId, secret }, { timeoutMs: 5_000, seenNonces }),
    ]);
    assert.equal(seenNonces.size, 1);
    const usedNonce = [...seenNonces][0];

    const replay = twoEnds();
    const hostSide = runHostHandshake(replay.host, { bindingId, secret }, { timeoutMs: 5_000, seenNonces });
    replay.worker.write(frame({ v: 1, t: "hello", bindingId, nonce: usedNonce }));
    await assert.rejects(hostSide, (error) => /replayed a hello/.test(error.message));
});

test("a host that names another binding is refused", async () => {
    const { worker, host } = twoEnds();
    const secret = newComputeHandshakeSecret();
    const workerSide = runWorkerHandshake(worker, { bindingId: "binding-a", secret }, { timeoutMs: 800 });
    const hostSide = runHostHandshake(host, { bindingId: "binding-b", secret }, { timeoutMs: 800 });
    await assert.rejects(hostSide, (error) => /named a different binding/.test(error.message));
    await assert.rejects(workerSide);
});

test("an oversized frame ends the handshake instead of being buffered", async () => {
    const { worker, host } = twoEnds();
    const hostSide = runHostHandshake(host, { bindingId: "b", secret: newComputeHandshakeSecret() }, { timeoutMs: 5_000 });
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(COMPUTE_HANDSHAKE_MAX_FRAME_BYTES + 1, 0);
    worker.write(header);
    await assert.rejects(hostSide, (error) => /reads at most/.test(error.message));
});

test("a frame cut short ends the handshake when the connection closes", async () => {
    const { worker, host } = twoEnds();
    const hostSide = runHostHandshake(host, { bindingId: "b", secret: newComputeHandshakeSecret() }, { timeoutMs: 5_000 });
    const whole = frame({ v: 1, t: "hello", bindingId: "b", nonce: "0".repeat(32) });
    worker.write(whole.subarray(0, whole.length - 3));
    worker.end();
    await assert.rejects(hostSide, (error) => /cut short|closed during the handshake/.test(error.message));
});

test("a frame that is not an object ends the handshake", async () => {
    const { worker, host } = twoEnds();
    const hostSide = runHostHandshake(host, { bindingId: "b", secret: newComputeHandshakeSecret() }, { timeoutMs: 5_000 });
    worker.write(frame([1, 2, 3]));
    await assert.rejects(hostSide, (error) => /not an object/.test(error.message));
});

test("a far end that says nothing does not hang the worker", async () => {
    const { worker } = twoEnds();
    await assert.rejects(
        runWorkerHandshake(worker, { bindingId: "b", secret: newComputeHandshakeSecret() }, { timeoutMs: 150 }),
        (error) => /did not finish within 150 ms/.test(error.message));
});

test("a secret too short to carry 32 random bytes is refused before anything is sent", async () => {
    const { worker } = twoEnds();
    assert.equal(isUsableHandshakeSecret("x".repeat(COMPUTE_HANDSHAKE_SECRET_MIN_CHARS)), true);
    assert.equal(isUsableHandshakeSecret("x".repeat(COMPUTE_HANDSHAKE_SECRET_MIN_CHARS - 1)), false);
    assert.equal(newComputeHandshakeSecret().length, 64);
    await assert.rejects(
        runWorkerHandshake(worker, { bindingId: "b", secret: "too-short" }, { timeoutMs: 1_000 }),
        (error) => /at least 32 random bytes/.test(error.message));
});

test("the host's proof and the worker's proof are different, so neither can be replayed as the other", () => {
    const secret = newComputeHandshakeSecret();
    const parts = { bindingId: "b", workerNonce: "a".repeat(32), hostNonce: "c".repeat(32) };
    assert.notEqual(computeHandshakeProof(secret, "host", parts), computeHandshakeProof(secret, "worker", parts));
    // And a different binding gives a different proof under the same nonces.
    assert.notEqual(
        computeHandshakeProof(secret, "host", parts),
        computeHandshakeProof(secret, "host", { ...parts, bindingId: "other" }));
});

test("a connection proved for one purpose cannot be used as the other", async () => {
    const secret = newComputeHandshakeSecret();
    const parts = { bindingId: "b", workerNonce: "a".repeat(32), hostNonce: "c".repeat(32) };
    // The purpose is signed in, so a proof for the side channel is not a
    // proof for the session's own stream.
    assert.notEqual(
        computeHandshakeProof(secret, "worker", { ...parts, purpose: "control" }),
        computeHandshakeProof(secret, "worker", { ...parts, purpose: "runtime" }));
    // A hello that names no purpose means the runtime stream, which is
    // what every hello meant before there was a second purpose.
    assert.equal(
        computeHandshakeProof(secret, "worker", parts),
        computeHandshakeProof(secret, "worker", { ...parts, purpose: "runtime" }));

    // A host that serves only the runtime stream refuses the other.
    const { worker, host } = twoEnds();
    const hostSide = runHostHandshake(host, { bindingId: "b", secret }, { timeoutMs: 1_000, purposes: ["runtime"] });
    const workerSide = runWorkerHandshake(worker, { bindingId: "b", secret }, { timeoutMs: 1_000, purpose: "control" });
    await assert.rejects(hostSide, (error) => /does not serve/.test(error.message));
    await assert.rejects(workerSide);
});

test("a host that serves the side channel says which purpose was proved", async () => {
    const secret = newComputeHandshakeSecret();
    const { worker, host } = twoEnds();
    const [, proved] = await Promise.all([
        runWorkerHandshake(worker, { bindingId: "b", secret }, { timeoutMs: 5_000, purpose: "control" }),
        runHostHandshake(host, { bindingId: "b", secret }, { timeoutMs: 5_000, purposes: ["runtime", "control"] }),
    ]);
    assert.deepEqual(proved, { purpose: "control" });
});

test("a host that does not serve the side channel says so in a way the worker can act on", async () => {
    const secret = newComputeHandshakeSecret();
    const { worker, host } = twoEnds();
    const [refused] = await Promise.allSettled([
        runWorkerHandshake(worker, { bindingId: "b", secret }, { timeoutMs: 5_000, purpose: "control" }),
        runHostHandshake(host, { bindingId: "b", secret }, { timeoutMs: 5_000, purposes: ["runtime"] }),
    ]);
    assert.equal(refused.status, "rejected");
    assert.equal(isPurposeNotServed(refused.reason), true,
        "so the turn can go on with the session's skills and servers unavailable, rather than failing");
    // Anything else refused is NOT that, or every refusal would degrade
    // quietly instead of failing the turn.
    assert.equal(isPurposeNotServed(new Error("the host did not prove it holds this binding's secret")), false);
});

test("a proof that differs only in its last byte is still rejected, however it is compared", () => {
    const secret = newComputeHandshakeSecret();
    const parts = { bindingId: "b", workerNonce: "n".repeat(32), hostNonce: "m".repeat(32), purpose: "runtime" };
    const right = computeHandshakeProof(secret, "host", parts);
    // Every single-character difference, at every position: none matches,
    // and none of them is accepted by a shortcut that stops early.
    for (const at of [0, 1, right.length - 2, right.length - 1]) {
        const wrong = right.slice(0, at) + (right[at] === "0" ? "1" : "0") + right.slice(at + 1);
        assert.equal(wrong.length, right.length);
        assert.equal(proofsMatch(wrong, right), false, `a proof differing at ${at} must not match`);
    }
    assert.equal(proofsMatch(right, right), true);
    assert.equal(proofsMatch(right.slice(0, -1), right), false, "a shorter proof never matches");
    assert.equal(proofsMatch(undefined, right), false);
});
