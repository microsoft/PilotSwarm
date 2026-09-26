/**
 * Session workspaces, slice C3: SessionManager.releaseWorkspace, the worker
 * side of "the session leaves this worker" (docs/proposals/session-workspaces.md,
 * section 4.5), with the Copilot transport stubbed.
 *
 * Order that must hold: list tasks, cancel each running or idle shell and
 * agent task, list again until none remain, disconnect, then tell the
 * provider. disconnect() alone leaves background shells running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../dist/session-manager.js";

const WORKSPACE = { schema: 1, root: "a", folder: "repo-x" };
const ATTACH = { root: "a", rootPath: "/ws/a", path: "/ws/a/repo-x", realPath: "/ws/a/repo-x", revision: 3, rootSessionId: "root-1", turnIndex: 7 };

function fixture(t, { tasks = [], stubborn = false, release } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-ws-release-"));
    const order = [];
    const releases = [];
    let current = tasks.map((task) => ({ ...task }));
    const manager = new SessionManager(undefined, null, {}, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    manager.setWorkspaceProvider({
        listRoots: async () => [{ name: "a", path: "/ws/a" }],
        ensureAttached: async () => ({ ok: true, path: "/ws/a/repo-x" }),
        release: release ?? (async (req) => { order.push("release"); releases.push(req); }),
    }, "worker-own-id");
    const handles = [];
    manager.ensureClient = async () => ({
        createSession: async (config) => {
            mkdirSync(join(home, config.sessionId), { recursive: true });
            const handle = {
                disconnected: false,
                disconnect: async () => { order.push("disconnect"); handle.disconnected = true; },
                rpc: {
                    tasks: {
                        list: async () => { order.push("list"); return { tasks: current.map((task) => ({ ...task })) }; },
                        cancel: async ({ id }) => {
                            order.push(`cancel:${id}`);
                            if (!stubborn) current = current.map((task) => (task.id === id ? { ...task, status: "cancelled" } : task));
                            return { cancelled: true };
                        },
                    },
                },
            };
            handles.push(handle);
            return handle;
        },
        resumeSession: async () => { throw new Error("not expected"); },
        deleteSession: async () => {},
    });
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    return { manager, order, releases, handles };
}

const open = (h, id = "s1", config = { workspace: WORKSPACE, workspaceAttach: ATTACH }) =>
    h.manager.getOrCreate(id, config, { turnIndex: 0 });

test("cancels running and idle shells and agents, lists again, disconnects, then tells the provider", async (t) => {
    const h = fixture(t, {
        tasks: [
            { id: "sh-1", type: "shell", status: "running" },
            { id: "ag-1", type: "agent", status: "idle" },
            { id: "sh-2", type: "shell", status: "completed" },
            { id: "cl-1", type: "client", status: "running" },
        ],
    });
    await open(h);
    const result = await h.manager.releaseWorkspace("s1", { reason: "idle", workerNodeId: "worker-a" });
    assert.deepEqual(result, { released: true, cancelled: 2 });
    assert.deepEqual(h.order, ["list", "cancel:sh-1", "cancel:ag-1", "list", "disconnect", "release"]);
    assert.deepEqual(h.releases, [{
        sessionId: "s1", rootSessionId: "root-1", workspace: WORKSPACE, revision: 3, workerNodeId: "worker-a", turnIndex: 7,
    }]);
    assert.equal(h.manager.get("s1"), null, "the warm session is dropped");
});

test("the orchestration's revision and turn index win over the stored attach", async (t) => {
    const h = fixture(t);
    await open(h);
    await h.manager.releaseWorkspace("s1", { reason: "idle", workerNodeId: "worker-a", revision: 5, turnIndex: 9 });
    assert.equal(h.releases[0].revision, 5);
    assert.equal(h.releases[0].turnIndex, 9);
});

test("a session not in memory here is skipped: nothing to cancel, and no provider call", async (t) => {
    const h = fixture(t);
    const result = await h.manager.releaseWorkspace("never-here", { reason: "idle", workerNodeId: "worker-a" });
    assert.equal(result.released, false);
    assert.match(result.detail, /not in memory/);
    assert.deepEqual(h.order, []);
});

test("a session without a workspace is left alone", async (t) => {
    const h = fixture(t);
    await open(h, "plain", { workingDirectory: "/home/app" });
    const result = await h.manager.releaseWorkspace("plain", { reason: "idle", workerNodeId: "worker-a" });
    assert.equal(result.released, false);
    assert.equal(h.handles[0].disconnected, false);
    assert.equal(h.releases.length, 0);
});

test("tasks that will not stop are reported, and the session is still disconnected and released", async (t) => {
    const h = fixture(t, { tasks: [{ id: "sh-1", type: "shell", status: "running" }], stubborn: true });
    await open(h);
    const result = await h.manager.releaseWorkspace("s1", { reason: "idle", workerNodeId: "worker-a" });
    assert.equal(result.released, true);
    assert.match(result.detail, /still active/);
    assert.equal(h.order.at(-2), "disconnect");
    assert.equal(h.order.at(-1), "release");
});

test("a hanging provider release is cut off and reported; the call returns", async (t) => {
    const h = fixture(t, { release: () => new Promise(() => {}) });
    await open(h);
    const started = Date.now();
    const result = await h.manager.releaseWorkspace("s1", { reason: "idle", workerNodeId: "worker-a", releaseTimeoutMs: 100 });
    assert.equal(result.released, true);
    assert.match(result.detail, /timed out/);
    assert.ok(Date.now() - started < 2_000);
});

test("releaseIdleWorkspaces skips a session whose turn holds the lock", async (t) => {
    const h = fixture(t);
    await open(h, "s1");
    await open(h, "s2");
    let unlock;
    const busy = h.manager.withRunTurnLock("s2", "test", () => new Promise((resolve) => { unlock = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const released = await h.manager.releaseIdleWorkspaces({ reason: "worker_shutdown", workerNodeId: "worker-a" });
    assert.equal(released, 1);
    assert.deepEqual(h.releases.map((r) => r.sessionId), ["s1"]);
    unlock();
    await busy;
});

test("the eviction sweep releases a workspace session before it evicts it", async (t) => {
    const h = fixture(t);
    await open(h);
    h.manager.sessionLastTouchedAt.set("s1", Date.now() - 60_000);
    await h.manager.sweepIdleSessions(1_000);
    assert.deepEqual(h.releases.map((r) => [r.sessionId, r.workerNodeId]), [["s1", "worker-own-id"]]);
    assert.equal(h.manager.get("s1"), null);
});
