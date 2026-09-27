/**
 * Session workspaces: SessionManager.releaseWorkspace, the worker
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
import { spawn } from "node:child_process";
import { SessionManager } from "../../dist/session-manager.js";
import { checkWorkspaceForSpawn, workspaceReleaseReason } from "../../dist/workspace.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const WORKSPACE = { schema: 1, root: "a", folder: "repo-x" };
const ATTACH = { root: "a", rootPath: "/ws/a", path: "/ws/a/repo-x", realPath: "/ws/a/repo-x", revision: 3, rootSessionId: "root-1", turnIndex: 7 };

function fixture(t, { tasks = [], stubborn = false, release, cancelAnswer, liveStatus } = {}) {
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
    const openHandle = async (config) => {
            mkdirSync(join(home, config.sessionId), { recursive: true });
            const handle = {
                disconnected: false,
                disconnect: async () => { order.push("disconnect"); handle.disconnected = true; },
                rpc: {
                    tasks: {
                        list: async () => {
                            order.push("list");
                            return { tasks: current.map((task) => ({ ...task, ...(liveStatus ? { status: liveStatus(task) } : {}) })) };
                        },
                        cancel: async ({ id }) => {
                            order.push(`cancel:${id}`);
                            if (cancelAnswer) return cancelAnswer;
                            if (!stubborn) current = current.map((task) => (task.id === id ? { ...task, status: "cancelled" } : task));
                            return { cancelled: true };
                        },
                    },
                },
            };
            handles.push(handle);
            return handle;
    };
    manager.ensureClient = async () => ({
        createSession: openHandle,
        resumeSession: async (_id, config) => openHandle(config),
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
        sessionId: "s1", rootSessionId: "root-1", workspace: WORKSPACE, revision: 3, workerNodeId: "worker-a", turnIndex: 7, reason: "moved",
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
    assert.deepEqual(h.releases.map((r) => [r.sessionId, r.reason]), [["s1", "shutdown"]]);
    unlock();
    await busy;
});

test("the eviction sweep releases a workspace session before it evicts it", async (t) => {
    const h = fixture(t);
    await open(h);
    h.manager.sessionLastTouchedAt.set("s1", Date.now() - 60_000);
    await h.manager.sweepIdleSessions(1_000);
    assert.deepEqual(h.releases.map((r) => [r.sessionId, r.workerNodeId, r.reason]), [["s1", "worker-own-id", "evicted"]]);
    assert.equal(h.manager.get("s1"), null);
});

test("a shell the CLI will not cancel (after an abort) is killed with every process below it", async (t) => {
    // CLI 1.0.83, verified: after session.abort(), tasks.cancel answers
    // { cancelled: false }; the reported pid is not a process-group leader;
    // and the task stays "running" after the process dies. This fake does
    // the same: a shell in our own process group, with a child.
    const shell = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
    const childPid = Number(await new Promise((resolve) => shell.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
    t.after(() => { for (const pid of [shell.pid, childPid]) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.equal(alive(childPid), true);
    const exited = new Promise((resolve) => shell.once("exit", resolve));
    const h = fixture(t, {
        tasks: [{ id: "sh-1", type: "shell", status: "running", pid: shell.pid }],
        cancelAnswer: { cancelled: false },
    });
    await open(h);
    const result = await h.manager.releaseWorkspace("s1", { reason: "idle", workerNodeId: "worker-a" });
    await exited;
    const deadline = Date.now() + 2_000;
    while (alive(childPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(childPid), false, "the shell's child is dead too");
    assert.equal(result.released, true);
    assert.equal(result.cancelled, 1);
    assert.equal(result.detail, undefined, `a dead pid counts as done although the CLI still says running: ${result.detail}`);
});

test("a pid that now belongs to another process is never killed; a dead one counts as done (review R4)", async (t) => {
    // CLI 1.0.83 keeps a finished detached shell listed as running, with its
    // pid. The host may give that pid to another process later: here, one
    // that started a minute after the task did.
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => { try { process.kill(other.pid, "SIGKILL"); } catch {} });
    const gone = spawn("true", [], { stdio: "ignore" });
    await new Promise((resolve) => gone.once("exit", resolve));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const h = fixture(t, {
        tasks: [
            { id: "sh-reused", type: "shell", status: "running", pid: other.pid, startedAt: new Date(Date.now() - 60_000).toISOString() },
            { id: "sh-dead", type: "shell", status: "running", pid: gone.pid, startedAt: new Date(Date.now() - 1_000).toISOString() },
        ],
        cancelAnswer: { cancelled: false },
    });
    await open(h);
    const result = await h.manager.releaseWorkspace("s1", { reason: "idle", workerNodeId: "worker-a" });
    assert.equal(alive(other.pid), true, "the other process lives");
    assert.deepEqual(h.order.filter((entry) => entry.startsWith("cancel:")), [], "neither task is running, so neither is cancelled");
    assert.equal(result.released, true);
    assert.equal(result.cancelled, 0);
    assert.equal(result.detail, undefined);
});

test("a new root or a clear releases the old folder with the provider before the resume (review R2)", async (t) => {
    for (const next of [
        { workspace: { schema: 1, root: "b", folder: "repo-x" }, workspaceAttach: { ...ATTACH, root: "b", rootPath: "/ws/b", path: "/ws/b/repo-x", realPath: "/ws/b/repo-x" } },
        { workspaceCleared: true },
    ]) {
        const h = fixture(t, { tasks: [{ id: "sh-1", type: "shell", status: "running" }] });
        await open(h);
        await h.manager.getOrCreate("s1", next, { turnIndex: 1 });
        assert.deepEqual(h.order, ["list", "cancel:sh-1", "list", "disconnect", "release"]);
        assert.deepEqual(h.releases.map((r) => [r.workspace, r.reason]), [[WORKSPACE, "changed"]], "the old folder, not the new one");
    }
});

test("the provider learns why: a session that ended, one that moved, and the triggers behind each reason", async (t) => {
    const expected = {
        destroy: "ended",
        idle: "moved", timer: "moved", cron: "moved", cron_at: "moved", error: "moved",
        lossy_handoff: "moved", workspace_unavailable: "moved",
        workspace_changed: "changed",
        eviction: "evicted",
        worker_shutdown: "shutdown",
        spawn_check: "spawn_check",
        "some-future-trigger": "moved",
    };
    for (const [trigger, reason] of Object.entries(expected)) assert.equal(workspaceReleaseReason(trigger), reason, trigger);

    // The destroySession activity releases with "destroy"; an affinity release with its own trigger.
    const h = fixture(t);
    await open(h, "ends");
    await open(h, "moves");
    await h.manager.releaseWorkspace("ends", { reason: "destroy", workerNodeId: "worker-a" });
    await h.manager.releaseWorkspace("moves", { reason: "timer", workerNodeId: "worker-a" });
    assert.deepEqual(h.releases.map((r) => [r.sessionId, r.reason]), [["ends", "ended"], ["moves", "moved"]]);
});

test("the quick check before a child is created releases with spawn_check", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ps-ws-spawn-check-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "repo"));
    const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
    const req = { sessionId: "child-1", rootSessionId: "root-1", workspace: { schema: 1, root: "a", folder: "repo" }, revision: 1, workerNodeId: "worker-a", turnIndex: 0 };
    const checked = await checkWorkspaceForSpawn(provider, req);
    assert.equal(checked.ok, true, checked.message);
    assert.deepEqual(provider.callsFor("release").map((r) => [r.req.sessionId, r.req.reason]), [["child-1", "spawn_check"]]);
});

// ── Extra folders (section 4.10) ─────────────────────────────────

const WITH_EXTRAS = {
    ...WORKSPACE,
    extra: { logs: { root: "logs", folder: "svc" }, shared: { root: "shared", folder: "notes", required: false } },
};
const extraAttach = (name, root, folder) => ({
    name, root, folder, rootPath: `/ws/${root}`, path: `/ws/${root}/${folder}`, realPath: `/ws/${root}/${folder}`, required: true,
});
const ATTACH_WITH_EXTRAS = {
    ...ATTACH,
    extras: [extraAttach("logs", "logs", "svc"), extraAttach("shared", "shared", "notes")],
};
const byAttachment = (releases) => releases
    .map((r) => [r.attachment ?? "(working folder)", r.workspace, r.reason])
    .sort((a, b) => a[0].localeCompare(b[0]));

test("a release tells the provider about the working folder and each extra folder, by name, with one reason", async (t) => {
    const h = fixture(t);
    await open(h, "s1", { workspace: WITH_EXTRAS, workspaceAttach: ATTACH_WITH_EXTRAS });
    await h.manager.releaseWorkspace("s1", { reason: "destroy", workerNodeId: "worker-a" });
    assert.deepEqual(byAttachment(h.releases), [
        ["(working folder)", WORKSPACE, "ended"],
        ["logs", { schema: 1, root: "logs", folder: "svc" }, "ended"],
        ["shared", { schema: 1, root: "shared", folder: "notes" }, "ended"],
    ], "the working folder goes without its extra folders; each extra folder goes on its own");
    for (const r of h.releases) {
        assert.equal(r.sessionId, "s1");
        assert.equal(r.rootSessionId, "root-1");
        assert.equal(r.workerNodeId, "worker-a");
    }
});

test("changing extra folders only releases the removed or moved ones at the next turn and keeps the handle; while a shell runs, the release waits", async (t) => {
    const next = {
        workspace: { ...WORKSPACE, extra: { logs: { root: "logs", folder: "other" } } },
        workspaceAttach: { ...ATTACH, extras: [extraAttach("logs", "logs", "other")] },
    };
    // No task running: released at once, and the handle stays.
    const idle = fixture(t);
    const first = await open(idle, "s1", { workspace: WITH_EXTRAS, workspaceAttach: ATTACH_WITH_EXTRAS });
    const again = await idle.manager.getOrCreate("s1", next, { turnIndex: 1 });
    assert.equal(again, first, "the warm session stays: extra folders are not in the fingerprint");
    assert.equal(idle.handles.length, 1, "no new CLI handle");
    assert.deepEqual(idle.order, ["list", "release", "release"], "the busy check, then two releases; no cancel, no disconnect");
    assert.deepEqual(byAttachment(idle.releases), [
        ["logs", { schema: 1, root: "logs", folder: "svc" }, "changed"],
        ["shared", { schema: 1, root: "shared", folder: "notes" }, "changed"],
    ], "the moved one at its old folder, and the removed one");

    // A shell is running: it may use the folder, so the release waits for a
    // turn with nothing running.
    const busy = fixture(t, { tasks: [{ id: "sh-1", type: "shell", status: "running" }] });
    await open(busy, "s1", { workspace: WITH_EXTRAS, workspaceAttach: ATTACH_WITH_EXTRAS });
    await busy.manager.getOrCreate("s1", next, { turnIndex: 1 });
    assert.deepEqual(busy.order, ["list"], "nothing released while the shell runs");
    assert.deepEqual(busy.releases, []);
    assert.equal(busy.manager.heldWorkspaceFolders("s1").length, 4, "the old two are still held, with the working folder and the new one");
    // On leave everything held goes: the shell is stopped first.
    await busy.manager.releaseWorkspace("s1", { reason: "timer", workerNodeId: "worker-a" });
    assert.deepEqual(byAttachment(busy.releases).map(([name, folder, reason]) => [name, folder.folder, reason]).sort(), [
        ["(working folder)", "repo-x", "moved"],
        ["logs", "other", "moved"],
        ["logs", "svc", "moved"],
        ["shared", "notes", "moved"],
    ]);
    assert.deepEqual(busy.manager.heldWorkspaceFolders("s1"), [], "nothing is held after a release");
});

test("folders attached outside a turn's preamble are released too: the agent's tool, a held turn, a dropped handle", async (t) => {
    const h = fixture(t);
    await open(h, "s1", { workspace: WORKSPACE, workspaceAttach: ATTACH });
    // The agent's tool attached "logs" in this turn; the change is not stored yet.
    h.manager.holdWorkspaceFolders("s1", [{ root: "logs", folder: "svc", attachment: "logs", rootSessionId: "root-1", revision: 3, turnIndex: 7 }]);
    await h.manager.releaseWorkspace("s1", { reason: "destroy", workerNodeId: "worker-a" });
    assert.deepEqual(byAttachment(h.releases).map(([name, folder, reason]) => [name, folder.root, reason]), [
        ["(working folder)", "a", "ended"],
        ["logs", "logs", "ended"],
    ], "the tool's attach is released with the working folder");

    // A turn was held after some attaches succeeded: no handle here, the folders are held.
    const held = fixture(t);
    held.manager.holdWorkspaceFolders("s2", [
        { root: "a", folder: "repo-x", rootSessionId: "s2", revision: 1, turnIndex: 0 },
        { root: "logs", folder: "svc", attachment: "logs", rootSessionId: "s2", revision: 1, turnIndex: 0 },
    ]);
    const result = await held.manager.releaseWorkspace("s2", { reason: "timer", workerNodeId: "worker-a" });
    assert.equal(result.released, true);
    assert.deepEqual(held.releases.map((r) => [r.sessionId, r.attachment ?? null, r.reason]).sort(), [["s2", null, "moved"], ["s2", "logs", "moved"]].sort());
    const idle = await held.manager.releaseIdleWorkspaces({ reason: "worker_shutdown", workerNodeId: "worker-a" });
    assert.equal(idle, 0, "nothing left to release");

    // Shutdown also covers a session that holds folders but has no handle.
    const shut = fixture(t);
    shut.manager.holdWorkspaceFolders("s3", [{ root: "logs", folder: "svc", attachment: "logs", rootSessionId: "s3", revision: 1, turnIndex: 0 }]);
    assert.equal(await shut.manager.releaseIdleWorkspaces({ reason: "worker_shutdown", workerNodeId: "worker-a" }), 1);
    assert.deepEqual(shut.releases.map((r) => [r.sessionId, r.attachment, r.reason]), [["s3", "logs", "shutdown"]]);
});

test("a folder the next turn still uses is not released, whatever its role or name now", async (t) => {
    const h = fixture(t);
    await open(h, "s1", { workspace: WITH_EXTRAS, workspaceAttach: ATTACH_WITH_EXTRAS });
    // The old working folder becomes an extra folder, and "logs" is renamed "app-logs".
    const swapped = {
        workspace: { schema: 1, root: "a", folder: "repo-y", extra: { old: { root: "a", folder: "repo-x" }, "app-logs": { root: "logs", folder: "svc" } } },
        workspaceAttach: {
            ...ATTACH, path: "/ws/a/repo-y", realPath: "/ws/a/repo-y",
            extras: [extraAttach("app-logs", "logs", "svc"), { ...extraAttach("old", "a", "repo-x"), rootPath: "/ws/a", path: "/ws/a/repo-x", realPath: "/ws/a/repo-x" }],
        },
    };
    await h.manager.getOrCreate("s1", swapped, { turnIndex: 1 });
    assert.deepEqual(byAttachment(h.releases).map(([name, folder]) => [name, folder.root, folder.folder]), [["shared", "shared", "notes"]],
        "only the folder no longer in use; the old working folder and the renamed one stay attached");

    // The same with the working folder kept: only an extra folder is renamed.
    const kept = fixture(t);
    await open(kept, "s2", { workspace: WITH_EXTRAS, workspaceAttach: ATTACH_WITH_EXTRAS });
    const renamed = {
        workspace: { ...WORKSPACE, extra: { "app-logs": { root: "logs", folder: "svc" }, shared: { root: "shared", folder: "notes", required: false } } },
        workspaceAttach: { ...ATTACH, extras: [extraAttach("app-logs", "logs", "svc"), extraAttach("shared", "shared", "notes")] },
    };
    await kept.manager.getOrCreate("s2", renamed, { turnIndex: 1 });
    assert.deepEqual(kept.releases, [], "a renamed folder that is still attached is not released");
});

test("a new working folder releases the old one but not an extra folder the next turn keeps", async (t) => {
    const h = fixture(t);
    await open(h, "s1", { workspace: WITH_EXTRAS, workspaceAttach: ATTACH_WITH_EXTRAS });
    const moved = {
        workspace: { schema: 1, root: "a", folder: "repo-y", extra: { logs: { root: "logs", folder: "svc" } } },
        workspaceAttach: { ...ATTACH, path: "/ws/a/repo-y", realPath: "/ws/a/repo-y", extras: [extraAttach("logs", "logs", "svc")] },
    };
    await h.manager.getOrCreate("s1", moved, { turnIndex: 1 });
    assert.deepEqual(byAttachment(h.releases), [
        ["(working folder)", WORKSPACE, "changed"],
        ["shared", { schema: 1, root: "shared", folder: "notes" }, "changed"],
    ], "logs stays attached: the preamble of this turn attached it again");
});

test("a check's attaches are held while the session is on this worker, and released at once when it is not", async (t) => {
    const h = fixture(t);
    await open(h, "here", { workspace: WORKSPACE, workspaceAttach: ATTACH });
    const logs = { root: "logs", folder: "svc", attachment: "logs", rootSessionId: "root-1", revision: 3, turnIndex: 7 };
    assert.equal(await h.manager.settleCheckAttaches("here", [logs], { workerNodeId: "worker-a" }), "held");
    assert.deepEqual(h.releases, [], "no release while the session's own folders are attached here");
    assert.ok(h.manager.heldWorkspaceFolders("here").some((folder) => folder.attachment === "logs"));

    assert.equal(await h.manager.settleCheckAttaches("elsewhere", [{ ...logs, rootSessionId: "elsewhere" }], { workerNodeId: "worker-a" }), "released");
    assert.deepEqual(h.releases.map((r) => [r.sessionId, r.attachment, r.reason]), [["elsewhere", "logs", "set_check"]]);
    assert.deepEqual(h.manager.heldWorkspaceFolders("elsewhere"), []);
});

test("a dropped CLI handle's folders are still released: the manager holds them, not the handle", async (t) => {
    const h = fixture(t);
    await open(h, "s1", { workspace: WITH_EXTRAS, workspaceAttach: ATTACH_WITH_EXTRAS });
    await h.manager.invalidateWarmSession("s1");
    assert.equal(h.manager.sessions.has("s1"), false, "the handle is gone");
    const result = await h.manager.releaseWorkspace("s1", { reason: "timer", workerNodeId: "worker-a" });
    assert.equal(result.released, true);
    assert.deepEqual(byAttachment(h.releases).map(([name, folder, reason]) => [name, folder.folder, reason]), [
        ["(working folder)", "repo-x", "moved"],
        ["logs", "svc", "moved"],
        ["shared", "notes", "moved"],
    ]);
});
