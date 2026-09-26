/**
 * Checks the fake WorkspaceProvider itself, so the session-workspace tests
 * that lean on it (F1, F2, F4, F8, M1-M4, R1-R5) can trust what it records.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

// A root that does not exist on disk: the fake must not care.
const ROOT_A = { name: "a", path: path.join(os.tmpdir(), `ps-fake-ws-${randomUUID()}`, "a") };
const ROOT_B = { name: "b", path: path.join(os.tmpdir(), `ps-fake-ws-${randomUUID()}`, "b") };
const ADOPT_ALL = { agents: true, skills: true, instructions: true };
const ADOPT_NONE = { agents: false, skills: false, instructions: false };

function req(overrides = {}) {
    return {
        sessionId: "s1",
        rootSessionId: "s1",
        workspace: { schema: 1, root: "a", folder: "repo-x" },
        revision: 1,
        workerNodeId: "worker-a",
        turnIndex: 0,
        ...overrides,
    };
}

// A broken hang or delay shows up as a stuck test; fail it fast instead.
const FAST = { timeout: 5_000 };
const timerCount = () => process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length;

let provider;
afterEach(() => provider?.reset());

describe("fake WorkspaceProvider: shape and defaults", FAST, () => {
    it("is a plain object with the three provider methods", () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        assert.equal(Object.getPrototypeOf(provider), Object.prototype);
        for (const name of ["listRoots", "ensureAttached", "release"]) assert.equal(typeof provider[name], "function");
        // The worker may call a detached reference, so no `this` is needed.
        const { ensureAttached } = provider;
        return ensureAttached(req()).then(r => assert.equal(r.ok, true));
    });

    it("returns root path + folder, omits adopt, and never touches the filesystem", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        const result = await provider.ensureAttached(req());
        assert.deepEqual(result, { ok: true, path: path.join(ROOT_A.path, "repo-x") });
        assert.equal("adopt" in result, false);
        assert.equal(fs.existsSync(ROOT_A.path), false);
        const whole = await provider.ensureAttached(req({ workspace: { schema: 1, root: "a" } }));
        assert.equal(whole.path, ROOT_A.path);
    });

    it("fails an unknown root with WORKSPACE_ROOT_UNKNOWN", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        const result = await provider.ensureAttached(req({ workspace: { schema: 1, root: "zzz" } }));
        assert.equal(result.ok, false);
        assert.equal(result.code, "WORKSPACE_ROOT_UNKNOWN");
        assert.match(result.message, /zzz/);
    });

    it("uses opts.adopt as the default adopt", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A], adopt: ADOPT_ALL });
        assert.deepEqual((await provider.ensureAttached(req())).adopt, ADOPT_ALL);
    });

    it("release resolves with nothing by default", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        assert.equal(await provider.release(req()), undefined);
    });
});

describe("fake WorkspaceProvider: roots", FAST, () => {
    it("listRoots returns a copy", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        const list = await provider.listRoots();
        assert.deepEqual(list, [ROOT_A]);
        list[0].path = "/elsewhere";
        list.push({ name: "x", path: "/x" });
        assert.deepEqual(await provider.listRoots(), [ROOT_A]);
    });

    it("does not keep a reference to the caller's roots", async () => {
        const mine = [{ ...ROOT_A }];
        provider = createFakeWorkspaceProvider({ roots: mine });
        mine[0].path = "/elsewhere";
        assert.deepEqual(await provider.listRoots(), [ROOT_A]);
    });

    it("setRoots drops and adds roots at runtime (R4)", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A, ROOT_B] });
        const onB = req({ workspace: { schema: 1, root: "b", folder: "repo-y" } });
        assert.equal((await provider.ensureAttached(onB)).ok, true);

        provider.setRoots([ROOT_A]);
        assert.deepEqual(await provider.listRoots(), [ROOT_A]);
        assert.equal((await provider.ensureAttached(onB)).code, "WORKSPACE_ROOT_UNKNOWN");

        const rootC = { name: "c", path: path.join(os.tmpdir(), "ps-fake-ws-c") };
        provider.setRoots([ROOT_A, ROOT_B, rootC]);
        assert.equal((await provider.ensureAttached(onB)).ok, true);
        const onC = await provider.ensureAttached(req({ workspace: { schema: 1, root: "c", folder: "f" } }));
        assert.equal(onC.path, path.join(rootC.path, "f"));
    });
});

describe("fake WorkspaceProvider: scripted outcomes", FAST, () => {
    it("worker A always fails, worker B succeeds (F4)", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "WORKSPACE_FOLDER_MISSING", message: "gone" }, { workerNodeId: "worker-a" });
        for (let turn = 0; turn < 5; turn++) {
            const onA = await provider.ensureAttached(req({ workerNodeId: "worker-a", turnIndex: turn }));
            assert.deepEqual(onA, { ok: false, code: "WORKSPACE_FOLDER_MISSING", message: "gone" });
        }
        assert.equal((await provider.ensureAttached(req({ workerNodeId: "worker-b" }))).ok, true);
    });

    it("fails the next N calls, then falls back to the default", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "WORKSPACE_UNAVAILABLE", retryAfterMs: 1234, times: 2 });
        const results = [];
        for (let i = 0; i < 3; i++) results.push(await provider.ensureAttached(req()));
        assert.equal(results[0].code, "WORKSPACE_UNAVAILABLE");
        assert.equal(results[0].retryAfterMs, 1234);
        assert.equal(results[0].message, "WORKSPACE_UNAVAILABLE (scripted)");
        assert.equal(results[1].code, "WORKSPACE_UNAVAILABLE");
        assert.equal(results[2].ok, true);
        assert.deepEqual(provider.calls.map(c => c.outcome), ["fail", "fail", "default"]);
    });

    it("omits retryAfterMs when the script has none", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "X" });
        assert.equal("retryAfterMs" in await provider.ensureAttached(req()), false);
    });

    it("scopes by session, and the most specific script wins", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        // Registered most specific first, so "newest wins" alone would pick GLOBAL every time.
        provider.script({ type: "ok" }, { sessionId: "s2", workerNodeId: "worker-a" });
        provider.script({ type: "fail", code: "SESSION" }, { sessionId: "s2" });
        provider.script({ type: "fail", code: "WORKER" }, { workerNodeId: "worker-a" });
        provider.script({ type: "fail", code: "GLOBAL" });
        assert.equal((await provider.ensureAttached(req({ workerNodeId: "worker-z" }))).code, "GLOBAL");
        assert.equal((await provider.ensureAttached(req())).code, "WORKER");
        assert.equal((await provider.ensureAttached(req({ sessionId: "s2", workerNodeId: "worker-z" }))).code, "SESSION");
        assert.equal((await provider.ensureAttached(req({ sessionId: "s2" }))).ok, true);
    });

    it("the newest of two equally specific scripts wins, and an exhausted one uncovers the older", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "OLD" });
        provider.script({ type: "fail", code: "NEW", times: 1 });
        assert.equal((await provider.ensureAttached(req())).code, "NEW");
        assert.equal((await provider.ensureAttached(req())).code, "OLD");
    });

    it("scripted ok can override path and adopt", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "ok", path: "/somewhere/else", adopt: ADOPT_ALL, times: 1 });
        assert.deepEqual(await provider.ensureAttached(req()), { ok: true, path: "/somewhere/else", adopt: ADOPT_ALL });
    });

    it("scripted ok with no path on an unknown root rejects, so the test bug is loud", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "ok" });
        await assert.rejects(provider.ensureAttached(req({ workspace: { schema: 1, root: "nope" } })), /needs a path/);
    });

    it("clearScripts drops one scope or all", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "A" }, { workerNodeId: "worker-a" });
        provider.script({ type: "fail", code: "G" });
        provider.clearScripts({ workerNodeId: "worker-a" });
        assert.equal((await provider.ensureAttached(req())).code, "G");
        provider.clearScripts();
        assert.equal((await provider.ensureAttached(req())).ok, true);
    });

    it("throws a scripted Error once, then succeeds", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        const boom = new Error("mount exploded");
        provider.script({ type: "throw", error: boom, times: 1 });
        await assert.rejects(provider.ensureAttached(req()), err => err === boom);
        assert.deepEqual(provider.calls[0].error, { name: "Error", message: "mount exploded" });
        assert.equal("result" in provider.calls[0], false);
        assert.equal((await provider.ensureAttached(req())).ok, true);
    });

    it("a scripted fail on release rejects with the code", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "LEASE_GONE" }, { method: "release" });
        await assert.rejects(provider.release(req()), err => err.code === "LEASE_GONE");
        assert.equal((await provider.ensureAttached(req())).ok, true);
    });

    it("delays, then runs the default", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "delay", ms: 50 });
        const started = performance.now();
        const pending = provider.ensureAttached(req());
        assert.equal(provider.pendingCalls().length, 1);
        const result = await pending;
        assert.ok(performance.now() - started >= 45, "resolved too early");
        assert.equal(result.ok, true);
        assert.equal(provider.calls[0].outcome, "delay");
        assert.equal(provider.calls[0].pending, false);
    });

    it("reset settles a long delay at once and clears its timer", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        // Short enough that a leaked timer delays the exit by seconds, not minutes.
        const before = timerCount();
        provider.script({ type: "delay", ms: 3_000 });
        const started = performance.now();
        const pending = provider.ensureAttached(req());
        assert.equal(timerCount(), before + 1);
        provider.reset();
        assert.equal(timerCount(), before, "reset left the delay timer running");
        assert.equal((await pending).ok, true);
        assert.ok(performance.now() - started < 1_000, "reset did not settle the delay at once");
    });

    it("hangs until reset, and the test still finishes", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "hang" });
        let settled = false;
        const pending = provider.ensureAttached(req()).then(r => { settled = true; return r; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal(provider.calls[0].pending, true);
        provider.reset();
        assert.equal((await pending).ok, true);
        assert.equal(provider.pendingCalls().length, 0);
        // The script is gone, so the next call does not hang.
        assert.equal((await provider.ensureAttached(req())).ok, true);
    });

    it("releaseHangs lets only the matching hung calls go, with an optional outcome", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "hang" });
        const onA = provider.ensureAttached(req({ workerNodeId: "worker-a" }));
        const onB = provider.ensureAttached(req({ workerNodeId: "worker-b" }));
        assert.equal(provider.releaseHangs({ workerNodeId: "worker-a" }, { type: "fail", code: "WORKSPACE_CHECK_TIMEOUT" }), 1);
        assert.equal((await onA).code, "WORKSPACE_CHECK_TIMEOUT");
        assert.deepEqual(provider.pendingCalls().map(r => r.workerNodeId), ["worker-b"]);
        assert.equal(provider.releaseHangs(), 1);
        assert.equal((await onB).ok, true);
        assert.throws(() => provider.releaseHangs(undefined, { type: "hang" }), TypeError);
    });

    it("a hanging release does not block attach (M6 shape)", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "hang" }, { method: "release" });
        const released = provider.release(req());
        assert.equal((await provider.ensureAttached(req({ workerNodeId: "worker-b" }))).ok, true);
        provider.reset();
        await released;
    });

    it("rejects bad scripts", () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        assert.throws(() => provider.script({ type: "explode" }), TypeError);
        assert.throws(() => provider.script({ type: "fail" }), /needs a code/);
        assert.throws(() => provider.script({ type: "delay" }), /ms/);
        assert.throws(() => provider.script({ type: "ok", times: 0 }), /times/);
        assert.throws(() => provider.script({ type: "ok" }, { method: "attach" }), /unknown method/);
    });
});

describe("fake WorkspaceProvider: adopt", FAST, () => {
    it("setAdopt flips the global adopt between turns (A4)", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.setAdopt(ADOPT_ALL);
        assert.deepEqual((await provider.ensureAttached(req({ turnIndex: 1 }))).adopt, ADOPT_ALL);
        provider.setAdopt(ADOPT_NONE);
        assert.deepEqual((await provider.ensureAttached(req({ turnIndex: 2 }))).adopt, ADOPT_NONE);
        provider.setAdopt(undefined);
        assert.equal("adopt" in await provider.ensureAttached(req({ turnIndex: 3 })), false);
    });

    it("a per-root adopt beats the global one, and null means adopt nothing for that root", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A, ROOT_B], adopt: ADOPT_NONE });
        const onB = req({ workspace: { schema: 1, root: "b" } });
        provider.setAdopt(ADOPT_ALL, { root: "b" });
        assert.deepEqual((await provider.ensureAttached(onB)).adopt, ADOPT_ALL);
        assert.deepEqual((await provider.ensureAttached(req())).adopt, ADOPT_NONE);
        provider.setAdopt(null, { root: "b" });
        assert.equal("adopt" in await provider.ensureAttached(onB), false);
        provider.setAdopt(undefined, { root: "b" });
        assert.deepEqual((await provider.ensureAttached(onB)).adopt, ADOPT_NONE);
    });

    it("hands out a copy of adopt, and reset restores opts.adopt", async () => {
        const initial = { agents: true, skills: false, instructions: false };
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A], adopt: initial });
        initial.skills = true;
        const first = await provider.ensureAttached(req());
        first.adopt.agents = false;
        assert.deepEqual((await provider.ensureAttached(req())).adopt, { agents: true, skills: false, instructions: false });
        provider.setAdopt(ADOPT_ALL);
        provider.reset();
        assert.deepEqual((await provider.ensureAttached(req())).adopt, { agents: true, skills: false, instructions: false });
    });
});

describe("fake WorkspaceProvider: recording", FAST, () => {
    it("records every method with a rising seq", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.listRoots();
        await provider.ensureAttached(req());
        await provider.release(req());
        assert.deepEqual(provider.calls.map(c => [c.seq, c.method]), [[1, "listRoots"], [2, "ensureAttached"], [3, "release"]]);
        assert.equal(provider.calls[0].workerNodeId, null);
        assert.deepEqual(provider.calls[0].result, [ROOT_A]);
        assert.equal(provider.calls[1].workerNodeId, "worker-a");
        assert.equal(provider.calls[1].sessionId, "s1");
        assert.equal(provider.calls[2].result, undefined);
    });

    it("keeps a deep copy of the request", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        const mine = req();
        provider.script({ type: "delay", ms: 5 });
        const pending = provider.ensureAttached(mine);
        mine.workspace.folder = "tampered";
        mine.sessionId = "tampered";
        const result = await pending;
        assert.equal(provider.calls[0].req.workspace.folder, "repo-x");
        assert.equal(provider.calls[0].req.sessionId, "s1");
        // The fake also acts on the request as sent, not as mutated later.
        assert.equal(result.path, path.join(ROOT_A.path, "repo-x"));
    });

    it("keeps a deep copy of the result", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A], adopt: ADOPT_ALL });
        const result = await provider.ensureAttached(req());
        result.adopt.agents = false;
        result.path = "/tampered";
        assert.deepEqual(provider.calls[0].result, { ok: true, path: path.join(ROOT_A.path, "repo-x"), adopt: ADOPT_ALL });
    });

    it("callsFor filters by method and by object or function; lastAttach finds the newest", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ turnIndex: 1 }));
        await provider.ensureAttached(req({ sessionId: "s2", workerNodeId: "worker-b", turnIndex: 1 }));
        await provider.ensureAttached(req({ turnIndex: 2 }));
        await provider.release(req());
        assert.equal(provider.callsFor("ensureAttached").length, 3);
        assert.equal(provider.callsFor("ensureAttached", { sessionId: "s1" }).length, 2);
        assert.equal(provider.callsFor("ensureAttached", r => r.req.turnIndex === 1).length, 2);
        assert.equal(provider.callsFor("release", { workerNodeId: "worker-b" }).length, 0);
        assert.equal(provider.lastAttach("s1").req.turnIndex, 2);
        assert.equal(provider.lastAttach("nobody"), undefined);
    });

    it("onCall fires synchronously, before ensureAttached returns", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        const seen = [];
        const stop = provider.onCall((record, phase) => seen.push(`${phase}:${record.method}:${record.seq}`));
        const pending = provider.ensureAttached(req());
        seen.push("returned");
        await pending;
        assert.deepEqual(seen, ["call:ensureAttached:1", "returned", "settle:ensureAttached:1"]);
        stop();
        await provider.listRoots();
        assert.equal(seen.length, 3);
    });

    it("a listener that throws when the call starts rejects that call, and uses up no script", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "ONCE", times: 1 });
        const stop = provider.onCall(() => { throw new Error("listener broke"); });
        const call = provider.ensureAttached(req());
        assert.ok(call instanceof Promise, "the call returns a promise, not a synchronous throw");
        await assert.rejects(call, /listener broke/);
        stop();
        assert.equal(provider.calls[0].pending, false);
        assert.equal(provider.calls[0].error.message, "listener broke");
        assert.equal((await provider.ensureAttached(req())).code, "ONCE");
    });

    it("a listener that throws when the call settles rejects that call and crashes nothing", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.onCall((_record, phase) => { if (phase === "settle") throw new Error("settle listener broke"); });
        await assert.rejects(provider.ensureAttached(req()), /settle listener broke/);
        provider.script({ type: "fail", code: "X" }, { method: "release" });
        await assert.rejects(provider.release(req()), /settle listener broke/);
        assert.equal(provider.pendingCalls().length, 0);
    });

    it("object filters also match request fields", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ turnIndex: 1 }));
        await provider.ensureAttached(req({ turnIndex: 2 }));
        assert.deepEqual(provider.callsFor("ensureAttached", { turnIndex: 2 }).map(r => r.seq), [2]);
        assert.deepEqual(provider.callsFor("ensureAttached", { sessionId: "s1", turnIndex: 1 }).map(r => r.seq), [1]);
        provider.script({ type: "hang" });
        const hung = provider.ensureAttached(req({ turnIndex: 3 }));
        assert.equal(provider.releaseHangs({ turnIndex: 9 }), 0);
        assert.equal(provider.releaseHangs({ turnIndex: 3 }), 1);
        await hung;
    });

    it("reset keeps calls and roots unless told, and seq keeps rising", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req());
        provider.reset();
        assert.equal(provider.calls.length, 1);
        assert.deepEqual(await provider.listRoots(), [ROOT_A]);
        const calls = provider.calls;
        provider.reset({ clearCalls: true, roots: [ROOT_B] });
        assert.equal(provider.calls, calls, "the calls array must stay the same object");
        assert.equal(calls.length, 0);
        assert.deepEqual(await provider.listRoots(), [ROOT_B]);
        assert.equal(provider.calls[0].seq, 3);
    });
});

describe("fake WorkspaceProvider: holders and dead holders", FAST, () => {
    it("normal release, then another worker attaches: not dead", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ workerNodeId: "worker-a", turnIndex: 1 }));
        await provider.release(req({ workerNodeId: "worker-a", turnIndex: 1 }));
        assert.deepEqual(provider.holders().get("s1"), { workerNodeId: "worker-a", turnIndex: 1, released: true });
        await provider.ensureAttached(req({ workerNodeId: "worker-b", turnIndex: 2 }));
        assert.equal(provider.deadHolderSeen("s1"), false);
        assert.deepEqual(provider.holders().get("s1"), { workerNodeId: "worker-b", turnIndex: 2, released: false });
    });

    it("no release, then another worker attaches: dead (M3, M4)", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ workerNodeId: "worker-a", turnIndex: 1 }));
        assert.equal(provider.deadHolderSeen("s1"), false);
        await provider.ensureAttached(req({ workerNodeId: "worker-b", turnIndex: 2 }));
        assert.equal(provider.deadHolderSeen("s1"), true);
        assert.equal(provider.holders().get("s1").workerNodeId, "worker-b");
    });

    it("the same worker re-attaches: not dead", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ turnIndex: 1 }));
        await provider.ensureAttached(req({ turnIndex: 2 }));
        assert.equal(provider.deadHolderSeen("s1"), false);
        assert.deepEqual(provider.holders().get("s1"), { workerNodeId: "worker-a", turnIndex: 2, released: false });
    });

    it("a failed attach takes no hold, so the next worker sees no dead holder", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "fail", code: "WORKSPACE_FOLDER_MISSING" }, { workerNodeId: "worker-a" });
        await provider.ensureAttached(req({ workerNodeId: "worker-a" }));
        assert.equal(provider.holders().has("s1"), false);
        await provider.ensureAttached(req({ workerNodeId: "worker-b" }));
        assert.equal(provider.deadHolderSeen("s1"), false);
    });

    it("a release from a worker that is not the holder does not free the holder", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ workerNodeId: "worker-a" }));
        await provider.release(req({ workerNodeId: "worker-b" }));
        assert.equal(provider.holders().get("s1").released, false);
        await provider.ensureAttached(req({ workerNodeId: "worker-c" }));
        assert.equal(provider.deadHolderSeen("s1"), true);
    });

    it("a release that never finished does not count", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ workerNodeId: "worker-a" }));
        provider.script({ type: "hang" }, { method: "release" });
        const hung = provider.release(req({ workerNodeId: "worker-a" }));
        await provider.ensureAttached(req({ workerNodeId: "worker-b" }));
        assert.equal(provider.deadHolderSeen("s1"), true);
        provider.reset();
        await hung;
    });

    it("overlapping attaches: the holder is the attach that finished last", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        provider.script({ type: "delay", ms: 20, times: 1 }, { workerNodeId: "worker-a" });
        const slow = provider.ensureAttached(req({ workerNodeId: "worker-a", turnIndex: 1 }));
        await provider.ensureAttached(req({ workerNodeId: "worker-b", turnIndex: 2 }));
        await slow;
        assert.equal(provider.holders().get("s1").workerNodeId, "worker-a");
        assert.equal(provider.deadHolderSeen("s1"), false, "neither attach saw a finished hold when it started");
        await provider.ensureAttached(req({ workerNodeId: "worker-b", turnIndex: 3 }));
        assert.equal(provider.deadHolderSeen("s1"), true);
    });

    it("tracks sessions separately", async () => {
        provider = createFakeWorkspaceProvider({ roots: [ROOT_A] });
        await provider.ensureAttached(req({ sessionId: "s1", workerNodeId: "worker-a" }));
        await provider.ensureAttached(req({ sessionId: "s2", workerNodeId: "worker-b" }));
        assert.equal(provider.deadHolderSeen("s1"), false);
        assert.equal(provider.deadHolderSeen("s2"), false);
        assert.deepEqual([...provider.holders().keys()].sort(), ["s1", "s2"]);
    });
});
