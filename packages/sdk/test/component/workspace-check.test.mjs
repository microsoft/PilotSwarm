/**
 * Session workspaces: the folder-text check, the out-of-process path
 * check (one check per root at a time, with a deadline), the built-in
 * provider, and the per-turn attach (docs/proposals/session-workspaces.md,
 * sections 4.1, 4.2 and 4.4; tests B3-U, F1-U, F7-U, and the worker half of F8).
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkWorkspacePath, setWorkspaceCheckTestHook } from "../../dist/workspace-check.js";
import { createBuiltInWorkspaceProvider, prepareWorkspace } from "../../dist/workspace.js";
import { WORKSPACE_ERROR_CODES as CODES } from "../../dist/types.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const REQ = { sessionId: "s1", rootSessionId: "s1", revision: 1, workerNodeId: "worker-a", turnIndex: 1 };

describe("path check", () => {
    let base, root, outside;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-check-")));
        root = path.join(base, "root");
        outside = path.join(base, "outside");
        fs.mkdirSync(path.join(root, "sessions", "s-1", "app"), { recursive: true });
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(root, "a-file"), "x");
        execFileSync("mkfifo", [path.join(root, "a-fifo")]);
        fs.symlinkSync(path.join(root, "a-file"), path.join(root, "link-to-file"));
        fs.symlinkSync(outside, path.join(root, "link-outside"));
        fs.symlinkSync(path.join(root, "sessions", "s-1", "app"), path.join(root, "link-inside"));
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));
    afterEach(() => setWorkspaceCheckTestHook(null));

    const check = (rel, extra = {}) => checkWorkspacePath({ rootName: "a", rootPath: root, path: path.join(root, rel), ...extra });

    it("accepts a directory inside the root and returns its real path", async () => {
        assert.deepEqual(await check("sessions/s-1/app"), { ok: true, realPath: path.join(root, "sessions", "s-1", "app") });
    });

    it("accepts a symlink to a directory inside the root, resolved", async () => {
        assert.deepEqual(await check("link-inside"), { ok: true, realPath: path.join(root, "sessions", "s-1", "app") });
    });

    it("a missing folder, a file, a FIFO and a symlink to a file are FOLDER_MISSING, at once (F7)", async () => {
        for (const rel of ["no-such-folder", "a-file", "a-fifo", "link-to-file"]) {
            const started = Date.now();
            const result = await check(rel, { timeoutMs: 3_000 });
            assert.equal(result.ok, false, rel);
            assert.equal(result.code, CODES.FOLDER_MISSING, `${rel}: ${result.message}`);
            assert.ok(Date.now() - started < 2_000, `${rel} took ${Date.now() - started} ms`);
        }
    });

    it("a symlink that leaves the root is PATH_INVALID (B3)", async () => {
        const result = await check("link-outside");
        assert.equal(result.code, CODES.PATH_INVALID, result.message);
    });

    it("a root path that does not exist on this worker is FOLDER_MISSING", async () => {
        const result = await checkWorkspacePath({ rootName: "gone", rootPath: path.join(base, "gone"), path: path.join(base, "gone", "x") });
        assert.equal(result.code, CODES.FOLDER_MISSING);
        assert.match(result.message, /not available on this worker/);
    });

    it("a hung check times out; queued and later checks on that root fail fast; other roots are unaffected (F3, F8)", async () => {
        const hungRoot = path.join(base, "hung-root");
        fs.mkdirSync(path.join(hungRoot, "x"), { recursive: true });
        setWorkspaceCheckTestHook(({ rootName }) => (rootName === "hung" ? { sleepMs: 1_500, unkillable: true } : undefined));
        const started = Date.now();
        const hung = { rootName: "hung", rootPath: hungRoot, path: path.join(hungRoot, "x"), timeoutMs: 300 };
        const first = checkWorkspacePath(hung);
        await new Promise((resolve) => setTimeout(resolve, 50));
        // A long deadline of its own: it must fail when the running check hangs, not when its own timer ends.
        const queued = checkWorkspacePath({ ...hung, timeoutMs: 3_000 });
        const other = check("sessions/s-1/app", { timeoutMs: 1_000 });
        const [firstResult, queuedResult, otherResult] = await Promise.all([first, queued, other]);
        assert.equal(firstResult.code, CODES.CHECK_TIMEOUT);
        assert.equal(queuedResult.code, CODES.CHECK_TIMEOUT);
        assert.ok(Date.now() - started < 1_000, "the queued check failed when the running one timed out");
        assert.equal(otherResult.ok, true, "another root keeps working");

        const lateStart = Date.now();
        const late = await checkWorkspacePath(hung);
        assert.equal(late.code, CODES.CHECK_TIMEOUT);
        assert.match(late.message, /still hung/);
        assert.ok(Date.now() - lateStart < 200, "a check after the timeout fails at once");

        // The stuck process exits when its sleep ends; the root recovers. Poll
        // for that instead of guessing how long node takes to start (T9).
        setWorkspaceCheckTestHook(null);
        const deadline = Date.now() + 10_000;
        let recovered;
        for (;;) {
            recovered = await checkWorkspacePath({ ...hung, timeoutMs: 3_000 });
            if (recovered.ok || Date.now() > deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(recovered.ok, true, recovered.message);
    });

    it("a slow but live check makes nine queued checks wait and pass, none times out (F8)", async () => {
        setWorkspaceCheckTestHook(({ path: target }) => (target.endsWith("app") ? { sleepMs: 400 } : undefined));
        const slow = check("sessions/s-1/app", { timeoutMs: 3_000 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const queued = Array.from({ length: 9 }, () => check("sessions/s-1", { timeoutMs: 3_000 }));
        const results = await Promise.all([slow, ...queued]);
        assert.deepEqual(results.map((r) => r.ok), Array(10).fill(true), JSON.stringify(results.filter((r) => !r.ok)));
    });

    it("a killable hung check is killed at the deadline, so the next check runs", async () => {
        setWorkspaceCheckTestHook(({ path: target }) => (target.endsWith("app") ? { sleepMs: 10_000 } : undefined));
        const first = await check("sessions/s-1/app", { timeoutMs: 300 });
        assert.equal(first.code, CODES.CHECK_TIMEOUT);
        setWorkspaceCheckTestHook(null);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const next = await check("sessions/s-1/app", { timeoutMs: 3_000 });
        assert.equal(next.ok, true, next.message);
    });
});

describe("built-in provider", () => {
    it("serves fixed roots: path = root path + folder, adopts nothing, unknown roots fail", async () => {
        const provider = createBuiltInWorkspaceProvider([{ name: "a", path: "/ws/a" }]);
        const roots = await provider.listRoots();
        assert.deepEqual(roots, [{ name: "a", path: "/ws/a" }]);
        roots[0].path = "/changed";
        assert.deepEqual(await provider.listRoots(), [{ name: "a", path: "/ws/a" }], "listRoots hands out copies");
        assert.deepEqual(await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "a", folder: "x/y" } }), { ok: true, path: path.join("/ws/a", "x/y") });
        assert.deepEqual(await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "a" } }), { ok: true, path: "/ws/a" });
        const unknown = await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "b" } });
        assert.equal(unknown.code, CODES.ROOT_UNKNOWN);
    });

    it("rejects roots without a name, with a relative path, or listed twice", () => {
        assert.throws(() => createBuiltInWorkspaceProvider([{ name: "", path: "/x" }]), /name/);
        assert.throws(() => createBuiltInWorkspaceProvider([{ name: "a", path: "rel" }]), /absolute/);
        assert.throws(() => createBuiltInWorkspaceProvider([{ name: "a", path: "/x" }, { name: "a", path: "/y" }]), /twice/);
    });
});

describe("prepareWorkspace (the per-turn attach)", () => {
    let base, root;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-prepare-")));
        root = path.join(base, "a");
        fs.mkdirSync(path.join(root, "repo-x"), { recursive: true });
        fs.mkdirSync(path.join(base, "elsewhere"), { recursive: true });
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));
    const workspace = (folder = "repo-x", rootName = "a") => ({ schema: 1, root: rootName, ...(folder ? { folder } : {}) });

    it("attaches through the built-in provider and checks the path", async () => {
        const provider = createBuiltInWorkspaceProvider([{ name: "a", path: root }]);
        const result = await prepareWorkspace(provider, { ...REQ, workspace: workspace() });
        assert.deepEqual(result, { ok: true, root: { name: "a", path: root }, path: path.join(root, "repo-x"), realPath: path.join(root, "repo-x") });
    });

    it("lists the roots on every call, then calls ensureAttached with the normalized record", async () => {
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        await prepareWorkspace(provider, { ...REQ, workspace: { root: "a", folder: "repo-x/" } });
        await prepareWorkspace(provider, { ...REQ, turnIndex: 2, workspace: workspace() });
        assert.deepEqual(provider.calls.map((c) => c.method), ["listRoots", "ensureAttached", "listRoots", "ensureAttached"]);
        assert.deepEqual(provider.calls[1].req.workspace, { schema: 1, root: "a", folder: "repo-x" });
        assert.equal(provider.calls[3].req.turnIndex, 2);
    });

    it("an unknown root, or no provider at all, is ROOT_UNKNOWN; ensureAttached is not called", async () => {
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        const unknown = await prepareWorkspace(provider, { ...REQ, workspace: workspace("repo-x", "b") });
        assert.equal(unknown.code, CODES.ROOT_UNKNOWN);
        assert.equal(provider.callsFor("ensureAttached").length, 0);
        const none = await prepareWorkspace(null, { ...REQ, workspace: workspace() });
        assert.equal(none.code, CODES.ROOT_UNKNOWN);
        assert.match(none.message, /no workspace provider/);
    });

    it("a folder that fails the text check never reaches the provider", async () => {
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        const result = await prepareWorkspace(provider, { ...REQ, workspace: { schema: 1, root: "a", folder: "../escape" } });
        assert.equal(result.code, CODES.PATH_INVALID);
        assert.equal(provider.calls.length, 0);
    });

    it("provider failures pass through with their code and retryAfterMs; a thrown error is ATTACH_FAILED", async () => {
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        provider.script({ type: "fail", code: "WORKSPACE_IN_USE", message: "held by another tree", retryAfterMs: 60_000, times: 1 });
        const inUse = await prepareWorkspace(provider, { ...REQ, workspace: workspace() });
        assert.deepEqual(inUse, { ok: false, code: "WORKSPACE_IN_USE", message: "held by another tree", retryAfterMs: 60_000 });
        provider.script({ type: "throw", error: "socket closed", times: 1 });
        const thrown = await prepareWorkspace(provider, { ...REQ, workspace: workspace() });
        assert.equal(thrown.code, CODES.ATTACH_FAILED);
        assert.match(thrown.message, /socket closed/);
    });

    it("a hung provider is cut at the attach deadline with no path check (F1)", async () => {
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        provider.script({ type: "hang" });
        const started = Date.now();
        const result = await prepareWorkspace(provider, { ...REQ, workspace: workspace() }, { attachTimeoutMs: 200 });
        assert.equal(result.code, CODES.ATTACH_TIMEOUT);
        assert.ok(Date.now() - started < 1_000);
        provider.reset();
    });

    it("an ok result without an absolute path is ATTACH_FAILED; a path outside the root is PATH_INVALID", async () => {
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        provider.script({ type: "ok", path: "relative/path", times: 1 });
        assert.equal((await prepareWorkspace(provider, { ...REQ, workspace: workspace() })).code, CODES.ATTACH_FAILED);
        provider.script({ type: "ok", path: path.join(base, "elsewhere"), times: 1 });
        assert.equal((await prepareWorkspace(provider, { ...REQ, workspace: workspace() })).code, CODES.PATH_INVALID);
    });

    it("adopt is copied as three booleans, and left out when the provider gives none", async () => {
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }], adopt: { agents: true, skills: 1, instructions: false } });
        const adopted = await prepareWorkspace(provider, { ...REQ, workspace: workspace() });
        assert.deepEqual(adopted.adopt, { agents: true, skills: false, instructions: false });
        provider.setAdopt(null);
        const none = await prepareWorkspace(provider, { ...REQ, workspace: workspace() });
        assert.equal("adopt" in none, false);
    });
});
