/**
 * The `process` compute provider's lifecycle with a stand-in runtime: a
 * small script that prints the runtime's "listening on port" line. No
 * Copilot CLI and no database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProcessComputeProvider, PROCESS_COMPUTE_KIND } from "../../dist/compute-process.js";
import { COMPUTE_ERROR_CODES } from "../../dist/compute.js";

const FAKE_RUNTIME = `
const fs = require("node:fs");
fs.writeFileSync("env.json", JSON.stringify(process.env));
console.log("CLI server listening on port 41234");
setInterval(() => {}, 1000);
`;

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-process-compute-"));
    const cliPath = path.join(root, "fake-runtime.cjs");
    fs.writeFileSync(cliPath, FAKE_RUNTIME);
    const provider = createProcessComputeProvider({ cliPath, rootDir: path.join(root, "hosts"), startTimeoutMs: 10_000 });
    t.after(async () => {
        await provider.stopAll();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { provider, root };
}

const target = { id: "00000000-0000-4000-8000-000000000001", name: "p", kind: PROCESS_COMPUTE_KIND, class: "shared", ownerUserId: null, displayName: null, config: {}, enabled: true };
const otherTarget = { ...target, id: "00000000-0000-4000-8000-000000000002", name: "q" };
const signal = new AbortController().signal;

function bindReq(sessionId, rootSessionId = "tree-1", forTarget = target) {
    return { target: forTarget, sessionId, rootSessionId, owner: null, workerNodeId: "w1", signal };
}

function connectReq(host, sessionId = "s1") {
    return { target, host, sessionId, rootSessionId: "tree-1", workerNodeId: "w1", turnIndex: 0, workspace: {}, signal };
}

function releaseReq(host, sessionId, reason) {
    return { target, host, sessionId, rootSessionId: "tree-1", workerNodeId: "w1", reason, signal };
}

test("one runtime per session tree, reached by address and token, with a scrubbed environment", async (t) => {
    const { provider } = setup(t);
    process.env.PS_SECRET_FOR_TEST = "must-not-leak";
    t.after(() => { delete process.env.PS_SECRET_FOR_TEST; });

    const a = await provider.bind(bindReq("s1"));
    const b = await provider.bind(bindReq("s2"));
    assert.equal(a.ok, true);
    assert.deepEqual(b.host, a.host);
    assert.equal(provider.hosts().length, 1);
    assert.deepEqual(provider.hosts()[0].sessions.sort(), ["s1", "s2"]);

    const connected = await provider.connect(connectReq(a.host));
    assert.equal(connected.ok, true);
    assert.equal(connected.endpoint.transport, "uri");
    // The address is the PilotSwarm host component in front of the
    // runtime, never the runtime's own port: everything the worker sends
    // goes through the handshake first.
    assert.match(connected.endpoint.address, /^127\.0\.0\.1:\d+$/);
    assert.notEqual(connected.endpoint.address, "127.0.0.1:41234");
    assert.match(connected.endpoint.connectionToken, /^[0-9a-f]{48}$/);
    assert.equal(connected.endpoint.handshake.bindingId, a.host.incarnation);
    assert.match(connected.endpoint.handshake.secret, /^[0-9a-f]{64}$/);
    assert.equal(connected.workspace.cwd, provider.hosts()[0].workDir);

    const envPath = path.join(provider.hosts()[0].workDir, "env.json");
    for (let i = 0; i < 50 && !fs.existsSync(envPath); i++) await new Promise((r) => setTimeout(r, 20));
    const env = JSON.parse(fs.readFileSync(envPath, "utf8"));
    assert.equal(env.PS_SECRET_FOR_TEST, undefined);
    assert.equal(env.COPILOT_CONNECTION_TOKEN, connected.endpoint.connectionToken);
    assert.equal(env.COPILOT_HOME, provider.hosts()[0].homeDir);
    if (process.platform !== "win32") {
        assert.equal(fs.statSync(provider.hosts()[0].homeDir).mode & 0o077, 0, "the runtime's home is private");
    }

    const otherTree = await provider.bind(bindReq("s3", "tree-2"));
    const otherKind = await provider.bind(bindReq("s4", "tree-1", otherTarget));
    assert.notDeepEqual(otherTree.host, a.host, "trees get their own runtime");
    assert.notDeepEqual(otherKind.host, a.host, "targets get their own runtime");
    assert.equal(provider.hosts().length, 3);
});

test("the runtime stops when the last session of its tree leaves", async (t) => {
    const { provider } = setup(t);
    const a = await provider.bind(bindReq("s1"));
    await provider.bind(bindReq("s2"));
    const { pid, homeDir } = provider.hosts()[0];

    await provider.release(releaseReq(a.host, "s1", "evicted"));
    assert.equal(isAlive(pid), true);
    await provider.release(releaseReq(a.host, "s2", "ended"));
    assert.equal(isAlive(pid), false);
    assert.equal(provider.hosts().length, 0);
    assert.equal(fs.existsSync(homeDir), false, "the runtime's folders go with it");

    const gone = await provider.connect(connectReq(a.host));
    assert.equal(gone.ok, false);
    assert.equal(gone.code, COMPUTE_ERROR_CODES.UNAVAILABLE);

    const again = await provider.bind(bindReq("s1"));
    assert.equal(again.ok, true);
    assert.notEqual(again.host.incarnation, a.host.incarnation);
});

test("a runtime that never listens is reported, not hung on", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-process-compute-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cliPath = path.join(root, "silent.cjs");
    fs.writeFileSync(cliPath, "process.exit(3);");
    const provider = createProcessComputeProvider({ cliPath, rootDir: path.join(root, "hosts"), startTimeoutMs: 5_000 });
    const result = await provider.bind(bindReq("s1"));
    assert.equal(result.ok, false);
    assert.equal(result.code, COMPUTE_ERROR_CODES.UNAVAILABLE);
    assert.match(result.message, /exited before listening/);
});
