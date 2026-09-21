import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionWorkspaceManager } from "../../dist/index.js";

function temporaryRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-session-workspace-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test("managed workspaces are confined, reusable, and platform-owned", (t) => {
    const root = temporaryRoot(t);
    const manager = new SessionWorkspaceManager(path.join(root, "workspaces"));
    const first = manager.resolve("session-123");
    const second = manager.resolve("session-123");

    assert.deepEqual(first, second);
    assert.equal(first.ownership, "platform");
    assert.equal(path.dirname(first.path), manager.rootDir);
    assert.equal(fs.statSync(first.path).isDirectory(), true);
    assert.equal(manager.remove("session-123"), true);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(manager.remove("session-123"), false);
});

test("case-variant session ids receive distinct managed workspaces", (t) => {
    const root = temporaryRoot(t);
    const manager = new SessionWorkspaceManager(path.join(root, "workspaces"));
    const upper = manager.resolve("Session-ABC");
    const lower = manager.resolve("session-abc");

    assert.notEqual(upper.path, lower.path);
    fs.writeFileSync(path.join(upper.path, "upper.txt"), "upper");
    assert.equal(fs.existsSync(path.join(lower.path, "upper.txt")), false);
    assert.equal(manager.remove("Session-ABC"), true);
    assert.equal(fs.existsSync(lower.path), true);
});

test("caller override wins and is never owned or removed by the manager", (t) => {
    const root = temporaryRoot(t);
    const override = path.join(root, "caller", "repo");
    const manager = new SessionWorkspaceManager(path.join(root, "managed"));
    const resolved = manager.resolve("session-123", override);

    assert.deepEqual(resolved, {
        path: path.resolve(override),
        ownership: "caller",
    });
    assert.equal(fs.existsSync(override), false);
    assert.equal(manager.remove("session-123"), false);
});

test("caller overrides cannot claim paths inside the managed namespace", (t) => {
    const root = temporaryRoot(t);
    const manager = new SessionWorkspaceManager(path.join(root, "managed"));
    assert.throws(
        () => manager.resolve("session-123", path.join(manager.rootDir, "session-123")),
        /must be outside the managed root/,
    );
});

test("session ids reject traversal and non-portable Windows names", (t) => {
    const root = temporaryRoot(t);
    const manager = new SessionWorkspaceManager(path.join(root, "managed"));
    for (const sessionId of ["../outside", "a/b", "a\\b", "CON", "name:", ".", ".."]) {
        assert.throws(() => manager.resolve(sessionId), /Invalid session workspace id/);
    }
    assert.equal(fs.existsSync(path.join(root, "outside")), false);
});

test("managed workspaces reject symlink and junction escapes", (t) => {
    const root = temporaryRoot(t);
    const outside = path.join(root, "outside");
    const managed = path.join(root, "managed");
    fs.mkdirSync(outside);
    fs.mkdirSync(managed);
    try {
        const token = createHash("sha256").update("session-link", "utf8").digest("hex").slice(0, 32);
        fs.symlinkSync(
            outside,
            path.join(managed, `session-${token}`),
            process.platform === "win32" ? "junction" : "dir",
        );
    } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EACCES") {
            t.skip("creating symlinks is not permitted on this host");
            return;
        }
        throw error;
    }

    const manager = new SessionWorkspaceManager(managed);
    assert.throws(() => manager.resolve("session-link"), /Symbolic links are not allowed/);
    assert.equal(fs.existsSync(outside), true);
});
