/**
 * Review CI-1 (CI run 114): on a worker with a GitHub token (CI sets GITHUB_TOKEN), a session with no per-user key was bound
 * to a client key without the worker's token, while its client was pooled under the key with it. The binding named no
 * client, so every close of the session in the Copilot CLI (L1's release, DRR-4's and DR2-004's rebind) found nothing to
 * close and was counted as confirmed. The binding is now the pool key of the client the session runs on. A binding with no
 * pooled client is a confirmed close only when no pooled client still holds the session; otherwise the close goes there.
 * The Copilot transport is a stub, pooled where the real pool puts it.
 *
 * Run: node --test test/unit/session-client-binding.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../dist/session-manager.js";

const WORKER_TOKEN = "ci1-worker-token";

/** A pooled client stub: its sessions map and its close, as the SDK's client has them. */
function stubClient(home, { closeFails = false } = {}) {
    const stub = { sessions: new Map(), closes: [] };
    const open = (config) => {
        const handle = { sessionId: config.sessionId, disconnect: async () => {} };
        stub.sessions.set(config.sessionId, handle);
        mkdirSync(join(home, config.sessionId), { recursive: true });
        return handle;
    };
    stub.createSession = async (config) => open(config);
    stub.resumeSession = async (_id, config) => open(config);
    stub.deleteSession = async () => {};
    stub.rpc = { sessions: { close: async ({ sessionId }) => {
        stub.closes.push(sessionId);
        if (closeFails) throw new Error("the CLI refused the close");
        stub.sessions.delete(sessionId);
    } } };
    return stub;
}

function fixture(t, { githubToken = WORKER_TOKEN } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-client-binding-"));
    const manager = new SessionManager(githubToken ?? undefined, null, {}, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    t.mock.method(console, "warn", () => {});
    t.mock.method(console, "error", () => {});
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id).catch(() => {});
        rmSync(home, { recursive: true, force: true });
    });
    return { manager, home };
}

test("with a worker token and no per-user key, the session is bound to the client it runs on, and its close reaches it", async (t) => {
    const { manager, home } = fixture(t);
    // The worker's client, pooled where ensureClient keeps it: under the worker's token.
    const worker = stubClient(home);
    manager.clients.set(WORKER_TOKEN, worker);
    await manager.getOrCreate("ci1-a", {}, { turnIndex: 0 });
    assert.equal(worker.sessions.has("ci1-a"), true, "the session runs on the worker's client");
    assert.equal(manager.clients.get(manager.sessionClientKeys.get("ci1-a")), worker, "its binding names that client");
    assert.equal(await manager.withRunTurnLock("ci1-a", "ci1", () => manager._closeCliSession("ci1-a")), true);
    assert.deepEqual(worker.closes, ["ci1-a"], "the close reached the client");
    assert.equal(worker.sessions.has("ci1-a"), false);
});

test("without any token the binding and the pool still agree (no token in either)", async (t) => {
    const { manager, home } = fixture(t, { githubToken: null });
    const worker = stubClient(home);
    manager.clients.set("", worker);
    await manager.getOrCreate("ci1-b", {}, { turnIndex: 0 });
    assert.equal(manager.clients.get(manager.sessionClientKeys.get("ci1-b")), worker);
});

test("a binding whose client left the pool, held by no pooled client, is a confirmed close", async (t) => {
    const { manager } = fixture(t);
    manager.sessionClientKeys.set("ci1-c", "stopped-client");
    manager.cliClosesOwed.set("ci1-c", new Set(["stopped-client"]));
    assert.equal(await manager._closeCliSession("ci1-c"), true);
    assert.equal(manager.cliClosesOwed.has("ci1-c"), false, "nothing is owed to a client that is gone");
});

test("a binding with no pooled client is not a confirmed close while a pooled client holds the session: it is closed there", async (t) => {
    const { manager, home } = fixture(t);
    const holder = stubClient(home);
    holder.sessions.set("ci1-d", { sessionId: "ci1-d" });
    manager.clients.set("holder-key", holder);
    manager.sessionClientKeys.set("ci1-d", "unpooled-key");
    assert.equal(await manager._closeCliSession("ci1-d"), true);
    assert.deepEqual(holder.closes, ["ci1-d"], "the holder was asked to close it");
    assert.equal(holder.sessions.has("ci1-d"), false);

    // A holder whose close fails: not confirmed, and owed to the holder.
    const failing = stubClient(home, { closeFails: true });
    failing.sessions.set("ci1-e", { sessionId: "ci1-e" });
    manager.clients.set("failing-key", failing);
    manager.sessionClientKeys.set("ci1-e", "unpooled-key");
    assert.equal(await manager._closeCliSession("ci1-e"), false);
    assert.deepEqual(failing.closes, ["ci1-e"]);
    assert.deepEqual([...manager.cliClosesOwed.get("ci1-e")], ["failing-key"]);
});
