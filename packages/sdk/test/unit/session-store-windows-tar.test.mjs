import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { FilesystemSessionStore } from "../../dist/session-store.js";

test("session archives round-trip with the native Windows tar even when PATH has no tar", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-tar-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateDir = path.join(root, "session state");
    const sessionId = "tar-round-trip";
    const sessionDir = path.join(stateDir, sessionId);
    const payload = Buffer.from([0, 1, 127, 128, 255]);
    fs.mkdirSync(path.join(sessionDir, "files"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: workspace\n");
    fs.writeFileSync(path.join(sessionDir, "files", "payload with spaces.bin"), payload);
    const store = new FilesystemSessionStore(path.join(root, "snapshot store"), stateDir);
    const originalSpawn = childProcess.spawn;
    const originalPath = process.env.PATH;
    const launches = [];

    childProcess.spawn = (command, args, options) => {
        launches.push({ command, args, options });
        return originalSpawn(command, args, options);
    };
    syncBuiltinESMExports();
    if (process.platform === "win32") process.env.PATH = root;
    try {
        await store.dehydrate(sessionId);
        assert.equal(fs.existsSync(sessionDir), false);
        await store.hydrate(sessionId);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
    }

    assert.deepEqual(fs.readFileSync(path.join(sessionDir, "files", "payload with spaces.bin")), payload);
    assert.equal(fs.readFileSync(path.join(sessionDir, "workspace.yaml"), "utf8"), "cwd: workspace\n");
    assert.equal(launches.length, 2, "one archive and one extraction");
    for (const launch of launches) {
        if (process.platform === "win32") {
            assert.equal(launch.command, "C:\\Windows\\System32\\tar.exe");
            assert.equal(launch.options.windowsHide, true);
        } else {
            assert.equal(launch.command, "tar");
            assert.equal(launch.options, undefined, "POSIX launch options stay unchanged");
        }
    }
});
