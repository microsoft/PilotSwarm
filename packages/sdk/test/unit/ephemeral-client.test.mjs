import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import path from "node:path";
import { createEphemeralClient } from "../../dist/ephemeral-client.js";

const source = `
const mode = process.env.SYNTHETIC_MODE;
let config, deferred;
const reply = (id, value) => process.send({ kind: "reply", id, ok: true, value });
process.on("message", message => {
  if (message.kind === "bearer-reply") {
    if (message.value !== "synthetic-bearer") throw new Error("synthetic-raw-secret");
    reply(deferred, config.sessionId); return;
  }
  if (message.method === "initialize") {
    console.log("synthetic-raw-secret");
    console.error("synthetic-raw-secret");
    if (mode === "crash") throw new Error("synthetic-raw-secret");
    reply(message.id, true);
  } else if (message.method === "createSession") {
    config = message.input.config;
    if (mode === "hang") return;
    if (message.input.hostBearer) {
      deferred = message.id;
      process.send({ kind: "bearer", id: 1, value: { resource: "synthetic-resource" } });
    } else reply(message.id, config.sessionId);
  } else if (message.method === "getStatus") reply(message.id, { version: "1.0.85" });
  else if (message.method === "stop") reply(message.id, mode !== "bad-stop");
  else reply(message.id, true);
});
`;

async function fixture(t, mode = "normal") {
    const root = path.resolve(`.ephemeral-client-test-${randomUUID()}`);
    await mkdir(root, { mode: 0o700 });
    const entrypoint = path.join(root, "synthetic-helper.mjs");
    await writeFile(entrypoint, source, { mode: 0o600 });
    const notices = [], captured = {};
    const client = createEphemeralClient({
        mode: "empty", logLevel: "none", workingDirectory: root, baseDirectory: root,
        env: { HOME: root, SYNTHETIC_MODE: mode },
        onGetTraceContext: () => ({}),
    }, { type: "openai" }, () => notices.push("failed"), () => notices.push("suppressed"),
    (_url, args, options) => {
        captured.options = options;
        captured.child = fork(entrypoint, args, options);
        return captured.child;
    });
    t.after(async () => {
        await client.forceStop();
        await rm(root, { recursive: true, force: true });
    });
    return { client, notices, captured, root };
}

test("OS-level log isolation uses private cwd/env and never emits raw SDK diagnostics", async t => {
    const writes = [];
    t.mock.method(process.stderr, "write", chunk => { writes.push(String(chunk)); return true; });
    const f = await fixture(t);
    assert.equal((await f.client.getStatus()).version, "1.0.85");
    await f.client.stop();
    assert.equal(f.notices.includes("suppressed"), true);
    assert.doesNotMatch(writes.join(""), /synthetic-raw-secret/);
    assert.deepEqual(f.captured.options.stdio, ["ignore", "ignore", "pipe", "ipc"]);
    assert.deepEqual(f.captured.options.execArgv, []);
    assert.equal(f.captured.options.cwd, f.root);
    assert.equal(f.captured.options.env.HOME, f.root);
    assert.equal(f.captured.options.env.GITHUB_TOKEN, undefined);
    assert.equal(f.captured.options.detached, true);
    assert.throws(() => process.kill(f.captured.child.pid, 0), { code: "ESRCH" });
});

test("selected WIF callbacks cross only private IPC, retaining their request and not serializing functions", async t => {
    const f = await fixture(t);
    let called;
    const session = await f.client.createSession({
        sessionId: "synthetic-session", availableTools: [], onPermissionRequest: () => ({ kind: "denied-by-rules", rules: [] }),
        onEvent() {}, hooks: { onPreToolUse: () => ({ permissionDecision: "deny" }) },
        provider: { type: "anthropic", baseUrl: "https://synthetic.invalid", bearerTokenProvider: async args => {
            called = args; return "synthetic-bearer";
        } },
    });
    assert.equal(session.sessionId, "synthetic-session");
    assert.deepEqual(called, { resource: "synthetic-resource" });
    await f.client.stop();
});

test("a hung create can be force-stopped without a late runtime or pending IPC request", async t => {
    const f = await fixture(t, "hang");
    await f.client.getStatus();
    const creating = f.client.createSession({ sessionId: "never-created", availableTools: [] });
    const rejected = assert.rejects(creating, { code: "EPHEMERAL_INVOCATION_FAILED" });
    await f.client.forceStop();
    await rejected;
    assert.throws(() => process.kill(f.captured.child.pid, 0), { code: "ESRCH" });
});

test("raw helper crashes and shutdown errors become fixed failures and clean up only the owned group", async t => {
    const crashed = await fixture(t, "crash");
    await assert.rejects(crashed.client.getStatus(), error => {
        assert.equal(error.code, "EPHEMERAL_INVOCATION_FAILED");
        assert.doesNotMatch(String(error), /synthetic-raw-secret/);
        return true;
    });
    await crashed.client.forceStop();
    const badStop = await fixture(t, "bad-stop");
    await badStop.client.getStatus();
    const errors = await badStop.client.stop();
    assert.equal(errors[0].code, "EPHEMERAL_CLEANUP_FAILED");
    await badStop.client.forceStop();
    assert.throws(() => process.kill(badStop.captured.child.pid, 0), { code: "ESRCH" });
});

function syntheticChild(t, { replyFailure, killRace } = {}) {
    const child = Object.assign(new EventEmitter(), {
        pid: 424242, connected: true, stderr: new EventEmitter(),
    });
    const sent = [], notices = [], signals = [], unhandled = [], events = [];
    let exited = false;
    const emitExit = () => { exited = true; child.emit("exit", 0, null); };
    const disconnect = () => { child.connected = false; child.emit("disconnect"); };
    const onUnhandled = error => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    t.mock.method(process, "kill", (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === 0) {
            assert.equal(exited, true);
            if (pid === -child.pid) {
                if (killRace === "present") return true;
                if (killRace === "denied") throw Object.assign(new Error("Synthetic permission failure."), { code: "EPERM" });
            } else assert.equal(pid, child.pid);
            throw Object.assign(new Error("Synthetic helper was reaped."), { code: "ESRCH" });
        }
        assert.equal(pid, -child.pid);
        assert.equal(signal, "SIGKILL");
        if (killRace) throw Object.assign(new Error("Synthetic group signal failure."), { code: "EPERM" });
        return true;
    });
    child.send = (message, callback) => {
        sent.push(message);
        assert.equal(child.connected, true, "must not send on a disconnected channel");
        assert.equal(exited, false, "must not send after helper exit");
        if (message.kind === "host-reply" && replyFailure) {
            const error = new Error("synthetic-raw-secret");
            if (replyFailure === "throw") throw error;
            queueMicrotask(() => callback(error));
            return true;
        }
        queueMicrotask(() => {
            callback(null);
            if (message.kind !== "call") return;
            const values = {
                initialize: true,
                createSession: "synthetic-session",
                getStatus: { version: "1.0.85" },
                stop: true,
            };
            if (Object.hasOwn(values, message.method)) {
                child.emit("message", { kind: "reply", id: message.id, ok: true, value: values[message.method] });
            }
        });
        return true;
    };
    const client = createEphemeralClient({
        workingDirectory: process.cwd(), env: {}, mode: "empty",
    }, undefined, () => notices.push("failed"), () => notices.push("suppressed"), () => child);
    t.after(async () => {
        try {
            if (!exited) emitExit();
            if (killRace && killRace !== "gone") await assert.rejects(client.forceStop(), { code: "EPERM" });
            else await client.forceStop();
            await nextTurn();
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
    return { client, child, sent, notices, signals, unhandled, events, emitExit, disconnect };
}

async function hostCallback(t, f, method) {
    const completion = Promise.withResolvers();
    t.after(() => completion.resolve("Late synthetic completion."));
    const calls = [];
    const handler = (input, invocation) => { calls.push({ input, invocation }); return completion.promise; };
    const session = await f.client.createSession({
        sessionId: "synthetic-session",
        tools: [{ name: "ephemeral_report_progress", handler }],
        onPermissionRequest: handler,
        hooks: { onPreToolUse: handler },
        onEvent: event => f.events.push(event),
    });
    const message = { kind: "host", id: 17, value: {
        method, name: "ephemeral_report_progress", input: { synthetic: true },
        invocation: { sessionId: session.sessionId },
    } };
    f.child.emit("message", message);
    assert.deepEqual(calls, [{ input: message.value.input, invocation: message.value.invocation }]);
    return { session, completion, calls, message };
}

const hostReplies = f => f.sent.filter(message => message.kind === "host-reply");
const invocationFailed = { code: "EPHEMERAL_INVOCATION_FAILED" };

test("late child failure rejects inference but does not reject in-flight cleanup RPCs", async t => {
    const f = syntheticChild(t);
    const session = await f.client.createSession({ sessionId: "synthetic-session" });
    const sending = assert.rejects(session.send({ prompt: "Synthetic prompt." }), invocationFailed);
    const cleaning = session.rpc.tasks.list();
    const request = f.sent.find(message => message.method === "tasks.list");
    f.child.emit("message", { kind: "failed" });
    f.child.emit("message", { kind: "failed" });
    f.child.emit("message", { kind: "reply", id: request.id, ok: true, value: { tasks: [] } });
    assert.deepEqual(await cleaning, { tasks: [] });
    await sending;
    assert.deepEqual(f.notices, ["failed"]);
    assert.deepEqual(f.unhandled, []);
});

for (const method of ["tool", "permission", "preTool"]) {
    for (const outcome of ["resolve", "reject"]) {
        test(`disconnect without exit closes IPC while an in-flight ${method} callback ${outcome}s`, async t => {
            const f = syntheticChild(t);
            const h = await hostCallback(t, f, method);
            const pending = assert.rejects(h.session.send({ prompt: "Synthetic prompt." }), invocationFailed);
            f.disconnect();
            const immediatelyNotified = f.notices.length;
            h.completion[outcome](outcome === "resolve" ? "Synthetic result." : new Error("synthetic-raw-secret"));
            await nextTurn();
            assert.equal(immediatelyNotified, 1);
            assert.deepEqual(f.notices, ["failed"]);
            await pending;
            assert.deepEqual(hostReplies(f), []);
            assert.deepEqual(f.unhandled, []);
            const sentCount = f.sent.length;
            await assert.rejects(f.client.getStatus(), invocationFailed);
            assert.equal(f.sent.length, sentCount);
        });

        test(`cleanup handles a late ${method} callback ${outcome} without sending to the helper`, async t => {
            const f = syntheticChild(t);
            const h = await hostCallback(t, f, method);
            const stopping = f.client.forceStop();
            h.completion[outcome](outcome === "resolve" ? "Synthetic result." : new Error("synthetic-raw-secret"));
            await nextTurn();
            assert.deepEqual(hostReplies(f), []);
            assert.deepEqual(f.notices, outcome === "reject" ? ["failed"] : []);
            assert.deepEqual(f.unhandled, []);
            f.emitExit();
            await stopping;
            assert.deepEqual(f.signals, [{ pid: -f.child.pid, signal: "SIGKILL" }]);
        });

        test(`a connected ${method} callback ${outcome} preserves its fixed IPC response`, async t => {
            const f = syntheticChild(t);
            const h = await hostCallback(t, f, method);
            h.completion[outcome](outcome === "resolve" ? "Synthetic result." : new Error("synthetic-raw-secret"));
            await nextTurn();
            assert.deepEqual(hostReplies(f), [{
                kind: "host-reply", id: 17, ok: outcome === "resolve",
                ...(outcome === "resolve" ? { value: "Synthetic result." } : {}),
            }]);
            assert.deepEqual(f.notices, outcome === "reject" ? ["failed"] : []);
            assert.deepEqual(f.unhandled, []);
            assert.equal((await f.client.getStatus()).version, "1.0.85");
        });
    }

    test(`a ${method} callback rejection during sequential runner cleanup after exit stays handled`, async t => {
        const f = syntheticChild(t);
        const h = await hostCallback(t, f, method);
        f.emitExit();
        // Exit can precede IPC disconnection; runner cleanup awaits these calls in order.
        assert.equal(f.child.connected, true);
        const sentCount = f.sent.length;
        await assert.rejects(h.session.abort(), invocationFailed);
        h.completion.reject(new Error("synthetic-raw-secret"));
        await assert.rejects(h.session.rpc.tasks.list(), invocationFailed);
        await assert.rejects(f.client.stop(), invocationFailed);
        await f.client.forceStop();
        await nextTurn();
        assert.equal(f.sent.length, sentCount);
        assert.deepEqual(hostReplies(f), []);
        assert.deepEqual(f.notices, ["failed"]);
        assert.deepEqual(f.unhandled, []);
        assert.deepEqual(f.signals, [
            { pid: f.child.pid, signal: 0 }, { pid: -f.child.pid, signal: "SIGKILL" },
        ]);
    });
}

for (const replyFailure of ["throw", "callback"]) {
    for (const outcome of ["resolve", "reject"]) {
        test(`a ${replyFailure} delivering a host ${outcome} reply notifies failure without an unhandled rejection`, async t => {
            const f = syntheticChild(t, { replyFailure });
            const h = await hostCallback(t, f, "tool");
            const pending = assert.rejects(h.session.send({ prompt: "Synthetic prompt." }), invocationFailed);
            h.completion[outcome](outcome === "resolve" ? "Synthetic result." : new Error("synthetic-raw-secret"));
            await nextTurn();
            assert.deepEqual(f.notices, ["failed"]);
            await pending;
            assert.equal(hostReplies(f).length, 1);
            assert.deepEqual(f.unhandled, []);
            const sentCount = f.sent.length;
            await assert.rejects(h.session.abort(), invocationFailed);
            assert.equal(f.sent.length, sentCount);
        });
    }
}

for (const outcome of ["resolve", "reject"]) {
    test(`a disconnected flag before lifecycle events safely rejects a host ${outcome} reply`, async t => {
        const f = syntheticChild(t);
        const h = await hostCallback(t, f, "tool");
        const pending = assert.rejects(h.session.send({ prompt: "Synthetic prompt." }), invocationFailed);
        f.child.connected = false;
        h.completion[outcome](outcome === "resolve" ? "Synthetic result." : new Error("synthetic-raw-secret"));
        await nextTurn();
        assert.deepEqual(f.notices, ["failed"]);
        await pending;
        assert.deepEqual(hostReplies(f), []);
        assert.deepEqual(f.unhandled, []);
    });
}

test("closed IPC shares one cleanup operation that still waits for helper exit", async t => {
    const f = syntheticChild(t);
    const h = await hostCallback(t, f, "tool");
    f.disconnect();
    const stopping = f.client.forceStop();
    assert.equal(f.client.forceStop(), stopping);
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    h.completion.resolve("Synthetic result.");
    f.child.emit("message", h.message);
    f.child.emit("message", { kind: "event", value: { type: "session.idle" } });
    await nextTurn();
    assert.equal(stopped, false);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(f.events, []);
    f.emitExit();
    await stopping;
    await f.client.forceStop();
    assert.equal(stopped, true);
    assert.deepEqual(f.signals, [{ pid: -f.child.pid, signal: "SIGKILL" }]);
    assert.deepEqual(f.notices, ["failed"]);
    assert.deepEqual(f.unhandled, []);
});

test("an already-closed and exited helper still has its owned process group cleaned exactly once", async t => {
    const f = syntheticChild(t);
    await f.client.getStatus();
    f.disconnect();
    f.emitExit();
    f.child.emit("error", new Error("synthetic-raw-secret"));
    await f.client.forceStop();
    await f.client.forceStop();
    assert.deepEqual(f.signals, [
        { pid: f.child.pid, signal: 0 }, { pid: -f.child.pid, signal: "SIGKILL" },
    ]);
    assert.deepEqual(f.notices, ["failed"]);
    assert.deepEqual(f.unhandled, []);
});

for (const killRace of ["gone", "present", "denied"]) {
    test(`a disconnect/exit signal race verifies the ${killRace} process group instead of swallowing EPERM`, async t => {
        const f = syntheticChild(t, { killRace });
        await f.client.getStatus();
        f.disconnect();
        const stopping = f.client.forceStop();
        let stopped = false;
        const result = stopping.then(
            () => { stopped = true; return undefined; },
            error => { stopped = true; return error; },
        );
        await nextTurn();
        assert.equal(stopped, false);
        f.emitExit();
        const error = await result;
        if (killRace === "gone") assert.equal(error, undefined);
        else assert.equal(error.code, "EPERM");
        assert.equal(f.client.forceStop(), stopping);
        assert.deepEqual(f.signals, [
            { pid: -f.child.pid, signal: "SIGKILL" }, { pid: -f.child.pid, signal: 0 },
        ]);
        assert.deepEqual(f.notices, ["failed"]);
        assert.deepEqual(f.unhandled, []);
    });
}

test("history.clearContext resolves from inside a pending tool handler, with the reply still owed", async t => {
    const f = syntheticChild(t);
    const h = await hostCallback(t, f, "tool");
    const pending = assert.rejects(h.session.send({ prompt: "Synthetic prompt." }), invocationFailed);

    // The handler is in flight and its host-reply has not been sent, which is
    // exactly the state clearContext requires: a tool call must be pending.
    assert.deepEqual(hostReplies(f), []);
    const clearing = h.session.rpc.history.clearContext({ prompt: "Analyze batch 2." });
    const request = f.sent.find(message => message.method === "history.clearContext");
    assert.deepEqual(request.input, { prompt: "Analyze batch 2." });
    assert.deepEqual(hostReplies(f), [], "the clear must not depend on first replying to the tool call");

    f.child.emit("message", { kind: "reply", id: request.id, ok: true, value: { messagesCleared: 12 } });
    assert.deepEqual(await clearing, { messagesCleared: 12 });

    // Only after the clear resolves does the handler answer, and its reply is
    // still delivered against the original callback id.
    h.completion.resolve("Batch cleared.");
    await nextTurn();
    assert.deepEqual(hostReplies(f), [{ kind: "host-reply", id: h.message.id, ok: true, value: "Batch cleared." }]);

    f.child.emit("message", { kind: "failed" });
    await pending;
    assert.deepEqual(f.unhandled, []);
});

test("the narrowed history surface exposes exactly the methods the runtime is allowed to reach", async t => {
    const f = syntheticChild(t);
    const session = await f.client.createSession({ sessionId: "synthetic-session" });
    assert.deepEqual(Object.keys(session.rpc.history).sort(), ["cancelBackgroundCompaction", "clearContext", "compact"]);
    for (const [name, input] of [["compact", {}], ["cancelBackgroundCompaction", undefined],
        ["clearContext", { prompt: "Analyze batch 2." }]]) {
        const call = session.rpc.history[name](input);
        const request = f.sent.find(message => message.method === `history.${name}`);
        assert.ok(request, `history.${name} must cross IPC under its own method name`);
        assert.deepEqual(request.input, input);
        f.child.emit("message", { kind: "reply", id: request.id, ok: true, value: { ok: name } });
        assert.deepEqual(await call, { ok: name });
    }
    assert.deepEqual(f.unhandled, []);
});
