/**
 * Session workspace files for the portal's Workspace pane
 * (packages/sdk/src/workspace-files.ts): the session's folders, and the file
 * calls with their rules (inside the folder, .git and root markers
 * read-only, version tags, the size limit, the deadline).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
import {
    WORKSPACE_FILE_ERROR_CODES as C,
    checkWorkspaceFilePath,
    resolveWorkspaceFileFolder,
    runWorkspaceFileCall,
    FILES_SCRIPT,
    WORKSPACE_FILE_ERROR_CODES,
    acquireFileCallSlot,
    workspaceFileChangesNote,
    workspaceFileChangesToTell,
    workspaceFileError,
    workspaceFileFolders,
    workspaceFilesConfigFromEnv,
} from "../../dist/workspace-files.js";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/** Each entry's Unix mode and "made by" system, from a zip's central directory. */
function zipModes(buf) {
    const modes = {};
    for (let i = 0; i + 46 <= buf.length; i += 1) {
        if (buf.readUInt32LE(i) !== 0x02014b50) continue;
        const nameLength = buf.readUInt16LE(i + 28);
        const name = buf.toString("utf8", i + 46, i + 46 + nameLength);
        modes[name] = { os: buf[i + 5], mode: buf.readUInt32LE(i + 38) >>> 16 };
        i += 45 + nameLength + buf.readUInt16LE(i + 30) + buf.readUInt16LE(i + 32);
    }
    return modes;
}
const text = (answer) => Buffer.from(answer.contentBase64, "base64").toString("utf8");

async function rejectsWith(promise, code) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
    });
}

describe("the session's folders", () => {
    const config = { roots: [{ name: "a", path: "/ws/a" }, { name: "home", path: "/ws/home" }] };

    it("a repo session: the working folder, then its extra folders and the default ones", () => {
        const view = {
            workspace: { schema: 1, root: "a", folder: "sessions/s1/tfenv", extra: { logs: { root: "logs", folder: "x" } } },
            path: "/ws/a/sessions/s1/tfenv",
            extraPaths: { logs: "/ws/logs/x" },
            defaults: { workingFolder: null, extra: [{ name: "home", root: "home", folder: "users/ada_dev.local", home: true }, { name: "logs", root: "a", folder: "ignored" }] },
        };
        assert.deepEqual(workspaceFileFolders(view, config), [
            { id: "working", name: "tfenv", role: "working", home: false, root: "a", folder: "sessions/s1/tfenv", opened: true, available: true },
            { id: "extra:logs", name: "logs", role: "extra", home: false, root: "logs", folder: "x", opened: true, available: false },
            { id: "extra:home", name: "home", role: "extra", home: true, root: "home", folder: "users/ada_dev.local", opened: true, available: true },
        ]);
    });

    it("a folder the record names but no worker opened is not served", () => {
        // A session can be CREATED with any folder text; the worker's provider
        // checks it (the home root: only the owner's own folder) and refuses.
        // Until a worker reports the folder's path, the portal serves nothing.
        const view = {
            workspace: { schema: 1, root: "home", folder: "users/alice_example.com", extra: { other: { root: "home", folder: "users/carol" } } },
            path: null,
            defaults: null,
        };
        const folders = workspaceFileFolders(view, config);
        assert.deepEqual(folders.map((f) => [f.id, f.opened, f.available]), [["working", false, false], ["extra:other", false, false]]);
        assert.throws(() => resolveWorkspaceFileFolder(folders, "working", config), (e) => e.code === C.NOT_OPENED && e.status === 409);
        assert.throws(() => resolveWorkspaceFileFolder(folders, "extra:other", config), (e) => e.code === C.NOT_OPENED);
    });

    it("no record: the person's own folder is the working folder", () => {
        const view = { workspace: null, defaults: { workingFolder: { root: "home", folder: "users/bob_dev.local" }, extra: [{ name: "shared", root: "shared" }] } };
        const folders = workspaceFileFolders(view, config);
        assert.deepEqual(folders.map((f) => [f.id, f.name, f.home, f.available]), [["working", "home", true, true], ["extra:shared", "shared", false, false]]);
        assert.equal(resolveWorkspaceFileFolder(folders, "working", config).base, "/ws/home/users/bob_dev.local");
        assert.throws(() => resolveWorkspaceFileFolder(folders, "extra:shared", config), (e) => e.code === C.ROOT_UNAVAILABLE);
        assert.throws(() => resolveWorkspaceFileFolder(folders, "extra:nope", config), (e) => e.code === C.FOLDER_UNKNOWN);
        assert.deepEqual(workspaceFileFolders(null, config), []);
    });

    it("paths are relative, without NUL", () => {
        assert.equal(checkWorkspaceFilePath(undefined), "");
        assert.equal(checkWorkspaceFilePath("notes/a.md/"), "notes/a.md");
        assert.throws(() => checkWorkspaceFilePath("/etc/passwd"), (e) => e.code === C.PATH_INVALID);
        assert.throws(() => checkWorkspaceFilePath("a\0b"), (e) => e.code === C.PATH_INVALID);
    });

    it("the settings: name=/path pairs and a limit in MB", () => {
        assert.equal(workspaceFilesConfigFromEnv({}), null);
        assert.deepEqual(workspaceFilesConfigFromEnv({ PORTAL_WORKSPACE_ROOTS: "a=/ws/a, home=/ws/home", PORTAL_WORKSPACE_MAX_FILE_MB: "5" }), {
            roots: [{ name: "a", path: "/ws/a" }, { name: "home", path: "/ws/home" }],
            maxBytes: 5 * 1024 * 1024,
        });
        assert.throws(() => workspaceFilesConfigFromEnv({ PORTAL_WORKSPACE_ROOTS: "a=relative/path" }), /name=\/absolute\/path/);
    });
});

describe("file calls in a folder", () => {
    let root;
    let base;
    let outside;
    let config;
    const call = (request) => runWorkspaceFileCall({ base, rootPath: root, ...request }, config);

    before(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-files-root-")));
        outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-files-outside-")));
        base = path.join(root, "users", "ada");
        fs.mkdirSync(path.join(base, "notes"), { recursive: true });
        fs.mkdirSync(path.join(base, ".git"), { recursive: true });
        fs.writeFileSync(path.join(root, ".pilotswarm-export"), "");
        fs.writeFileSync(path.join(base, "AGENTS.md"), "# Rules\n");
        fs.writeFileSync(path.join(base, ".hidden"), "dot\n");
        fs.writeFileSync(path.join(base, ".git", "config"), "[core]\n");
        fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
        fs.symlinkSync(path.join(outside, "secret.txt"), path.join(base, "escape.txt"));
        config = { roots: [{ name: "home", path: root }], maxBytes: 64 * 1024 };
    });
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it("list: folders first, dotfiles shown, .git read-only, a link out of the folder marked", async () => {
        const answer = await call({ op: "list", path: "" });
        assert.deepEqual(answer.entries.map((e) => e.name), [".git", "notes", ".hidden", "AGENTS.md", "escape.txt"]);
        assert.equal(answer.entries.find((e) => e.name === ".git").readOnly, true);
        assert.equal(answer.entries.find((e) => e.name === "escape.txt").target, "outside");
        assert.equal(answer.truncated, false);
    });

    it("read, then write with the version tag; a stale tag is a conflict that names the current one", async () => {
        const first = await call({ op: "read", path: "AGENTS.md" });
        assert.equal(text(first), "# Rules\n");
        const saved = await call({ op: "write", path: "AGENTS.md", contentBase64: b64("# Rules\n1. Be brief.\n"), ifMatch: first.etag });
        assert.notEqual(saved.etag, first.etag);
        await assert.rejects(call({ op: "write", path: "AGENTS.md", contentBase64: b64("mine\n"), ifMatch: first.etag }), (e) => {
            assert.equal(e.code, C.CONFLICT);
            assert.equal(e.etag, saved.etag);
            return true;
        });
        assert.equal(fs.readFileSync(path.join(base, "AGENTS.md"), "utf8"), "# Rules\n1. Be brief.\n");
    });

    it("a new file: made with its folders; ifMatch null refuses to replace one", async () => {
        await call({ op: "write", path: "notes/2026/today.md", contentBase64: b64("hello\n"), ifMatch: null, createParents: true });
        assert.equal(fs.readFileSync(path.join(base, "notes", "2026", "today.md"), "utf8"), "hello\n");
        await rejectsWith(call({ op: "write", path: "notes/2026/today.md", contentBase64: b64("again\n"), ifMatch: null }), C.EXISTS);
    });

    it("nothing leaves the folder: .. and links out are refused", async () => {
        await rejectsWith(call({ op: "read", path: "../../x" }), C.OUTSIDE);
        await rejectsWith(call({ op: "read", path: "escape.txt" }), C.OUTSIDE);
        await rejectsWith(call({ op: "write", path: "escape.txt", contentBase64: b64("x") }), C.OUTSIDE);
    });

    it(".git and the root's marker are read-only", async () => {
        const git = await call({ op: "read", path: ".git/config" });
        assert.equal(git.readOnly, true);
        await rejectsWith(call({ op: "write", path: ".git/config", contentBase64: b64("x") }), C.READ_ONLY);
        await rejectsWith(call({ op: "delete", path: ".git/config" }), C.READ_ONLY);
        await rejectsWith(call({ op: "move", path: "AGENTS.md", toBase: base, toRootPath: root, toPath: ".git/AGENTS.md" }), C.READ_ONLY);
        const atRoot = (request) => runWorkspaceFileCall({ base: root, rootPath: root, ...request }, config);
        await rejectsWith(atRoot({ op: "delete", path: ".pilotswarm-export" }), C.READ_ONLY);
        assert.ok(fs.existsSync(path.join(root, ".pilotswarm-export")));
    });

    it("the size limit holds for read, write and zip", async () => {
        fs.writeFileSync(path.join(base, "big.bin"), Buffer.alloc(config.maxBytes + 1));
        await rejectsWith(call({ op: "read", path: "big.bin" }), C.TOO_LARGE);
        await rejectsWith(call({ op: "write", path: "big2.bin", contentBase64: Buffer.alloc(config.maxBytes + 1).toString("base64") }), C.TOO_LARGE);
        await rejectsWith(call({ op: "zip", path: "" }), C.TOO_LARGE);
        fs.rmSync(path.join(base, "big.bin"));
    });

    it("mkdir, move and delete, with their refusals", async () => {
        await call({ op: "mkdir", path: "drafts" });
        await rejectsWith(call({ op: "mkdir", path: "drafts" }), C.EXISTS);
        await call({ op: "write", path: "drafts/a.txt", contentBase64: b64("a"), ifMatch: null });
        await call({ op: "move", path: "drafts/a.txt", toBase: base, toRootPath: root, toPath: "notes/a.txt" });
        assert.ok(fs.existsSync(path.join(base, "notes", "a.txt")));
        await rejectsWith(call({ op: "move", path: "notes/a.txt", toBase: base, toRootPath: root, toPath: "AGENTS.md" }), C.EXISTS);
        await rejectsWith(call({ op: "move", path: "notes", toBase: base, toRootPath: root, toPath: "notes/inner" }), C.PATH_INVALID);
        await rejectsWith(call({ op: "delete", path: "" }), C.PATH_INVALID);
        await call({ op: "write", path: "drafts/b.txt", contentBase64: b64("b"), ifMatch: null });
        await rejectsWith(call({ op: "delete", path: "drafts" }), C.NOT_EMPTY);
        await call({ op: "delete", path: "drafts", recursive: true });
        assert.equal(fs.existsSync(path.join(base, "drafts")), false);
    });

    it("zip: the folder's files, without .git (and it says so), with their Unix modes", async () => {
        fs.writeFileSync(path.join(base, "run.sh"), "#!/bin/sh\necho hi\n");
        fs.chmodSync(path.join(base, "run.sh"), 0o755);
        const answer = await call({ op: "zip", path: "" });
        const bytes = Buffer.from(answer.contentBase64, "base64");
        const names = Object.keys(unzipSync(new Uint8Array(bytes))).sort();
        assert.ok(names.includes("AGENTS.md") && names.includes("notes/2026/today.md") && names.includes(".hidden"), names.join(", "));
        assert.ok(!names.some((name) => name.startsWith(".git/")), names.join(", "));
        assert.deepEqual(answer.skipped, [".git"], "the answer names what was left out");
        const modes = zipModes(bytes);
        assert.equal(modes["run.sh"].os, 3, "made by Unix");
        if (process.platform !== "win32") {
            assert.equal(modes["run.sh"].mode & 0o777, 0o755, "a script stays executable");
            assert.equal(modes["AGENTS.md"].mode & 0o111, 0, "a plain file is not made executable");
        }
        fs.rmSync(path.join(base, "run.sh"));
    });

    it("find: names holding every word, best first, never inside .git", async () => {
        fs.mkdirSync(path.join(base, "deep", "er"), { recursive: true });
        fs.writeFileSync(path.join(base, "deep", "er", "agents-notes.md"), "x");
        fs.writeFileSync(path.join(base, "deep", "Agents.md"), "x");
        fs.writeFileSync(path.join(base, ".git", "agents"), "x");
        const byName = await call({ op: "find", path: "", query: "AGENTS" });
        assert.deepEqual(byName.matches.map((m) => m.path), ["AGENTS.md", "deep/Agents.md", "deep/er/agents-notes.md"],
            "start of the name first, nearer the top first; case does not matter; .git is not searched");
        assert.equal(byName.truncated, false);
        const byPath = await call({ op: "find", path: "", query: "er/ md" });
        assert.deepEqual(byPath.matches.map((m) => m.path), ["deep/er/agents-notes.md"], "a word with a / matches the path");
        const folders = await call({ op: "find", path: "", query: "deep" });
        assert.deepEqual(folders.matches, [{ path: "deep", kind: "dir" }]);
        assert.deepEqual((await call({ op: "find", path: "", query: "   " })).matches, [], "no words, nothing");
        fs.symlinkSync(outside, path.join(base, "outlink"));
        try {
            assert.deepEqual((await call({ op: "find", path: "", query: "secret" })).matches.map((m) => m.path), [], "a link to a folder outside is not followed");
        } finally {
            fs.unlinkSync(path.join(base, "outlink"));
        }
    });

    it("find: at most 200 matches, and it says there are more", async () => {
        fs.mkdirSync(path.join(base, "many"));
        for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(base, "many", `item-${i}.txt`), "");
        const answer = await call({ op: "find", path: "many", query: "item" });
        assert.equal(answer.matches.length, 200);
        assert.equal(answer.truncated, true);
        fs.rmSync(path.join(base, "many"), { recursive: true, force: true });
    });

    it("a link inside the folder does not get around .git being read-only; nor does .GIT", async () => {
        fs.mkdirSync(path.join(base, ".git", "hooks"), { recursive: true });
        fs.symlinkSync(path.join(base, ".git", "hooks"), path.join(base, "hooks"));
        try {
            await rejectsWith(call({ op: "write", path: "hooks/pre-commit", contentBase64: b64("#!/bin/sh\n"), ifMatch: null }), C.READ_ONLY);
            assert.ok(!fs.existsSync(path.join(base, ".git", "hooks", "pre-commit")));
            await rejectsWith(call({ op: "write", path: ".GIT/config", contentBase64: b64("x"), ifMatch: null }), C.READ_ONLY);
            const listed = await call({ op: "list", path: "" });
            assert.equal(listed.entries.find((e) => e.name === "hooks").readOnly, true, "the link into .git shows as read-only");
        } finally {
            fs.unlinkSync(path.join(base, "hooks"));
        }
    });

    it("a root without its marker is not served: an unmounted share is a local folder", async () => {
        const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-files-bare-")));
        try {
            await rejectsWith(runWorkspaceFileCall({ base: bare, rootPath: bare, op: "write", path: "x.txt", contentBase64: b64("x"), ifMatch: null }, { roots: [], maxBytes: 1024 }), C.ROOT_UNAVAILABLE);
            assert.ok(!fs.existsSync(path.join(bare, "x.txt")));
            const allowed = await runWorkspaceFileCall({ base: bare, rootPath: bare, op: "write", path: "x.txt", contentBase64: b64("x"), ifMatch: null }, { roots: [], maxBytes: 1024, requireMarker: false });
            assert.equal(allowed.created, true, "requireMarker: false serves it");
        } finally {
            fs.rmSync(bare, { recursive: true, force: true });
        }
        assert.equal(workspaceFilesConfigFromEnv({ PORTAL_WORKSPACE_ROOTS: "a=/ws/a", PORTAL_WORKSPACE_REQUIRE_MARKER: "false" }).requireMarker, false);
        assert.equal(workspaceFilesConfigFromEnv({ PORTAL_WORKSPACE_ROOTS: "a=/ws/a" }).requireMarker, undefined);
    });

    it("a long folder is cut after sorting: its subfolders come first", async () => {
        const many = path.join(base, "long");
        fs.mkdirSync(many);
        for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), "");
        fs.mkdirSync(path.join(many, "zz-folder"));
        try {
            const listed = await runWorkspaceFileCall({ base, rootPath: root, op: "list", path: "long" }, { ...config, maxEntries: 5 });
            assert.equal(listed.entries[0].name, "zz-folder");
        } finally {
            fs.rmSync(many, { recursive: true, force: true });
        }
    });

    it("zip of a selection: each path at its own name, .git left out, folders as folders", async () => {
        fs.mkdirSync(path.join(base, "sel", "inner"), { recursive: true });
        fs.writeFileSync(path.join(base, "sel", "inner", "x.txt"), "x");
        const answer = await call({ op: "zip", path: "", paths: ["AGENTS.md", "sel", ".git"] });
        const names = Object.keys(unzipSync(new Uint8Array(Buffer.from(answer.contentBase64, "base64")))).sort();
        assert.deepEqual(names, ["AGENTS.md", "sel/", "sel/inner/", "sel/inner/x.txt"]);
        assert.deepEqual(answer.skipped, [".git"], "a selected .git is left out, and said");
        const plain = await call({ op: "zip", path: "", paths: ["AGENTS.md"] });
        assert.equal(plain.skipped, undefined, "nothing left out, nothing said");
        await rejectsWith(call({ op: "zip", path: "", paths: ["../outside"] }), C.OUTSIDE);
        fs.rmSync(path.join(base, "sel"), { recursive: true, force: true });
    });

    it("a call that does not answer in time fails, and nothing waits for it", async () => {
        await rejectsWith(runWorkspaceFileCall({ base, rootPath: root, op: "list", path: "" }, { ...config, timeoutMs: 1 }), C.TIMEOUT);
    });

    it("a timeout or an unmounted root may show its message; an I/O failure may not", async () => {
        const late = await runWorkspaceFileCall({ base, rootPath: root, op: "list", path: "" }, { ...config, timeoutMs: 1 }).catch((error) => error);
        assert.equal(late.expose, true, "the Web API passes a 504's fixed message on");
        const unmounted = await runWorkspaceFileCall({ base, rootPath: path.join(root, "nowhere"), op: "list", path: "" }, config).catch((error) => error);
        assert.equal(unmounted.code, C.ROOT_UNAVAILABLE);
        assert.equal(unmounted.expose, true);
        assert.equal(workspaceFileError(C.IO, "EACCES: /somewhere").expose, undefined, "an I/O message can name a server path");
    });
});

describe("a move to another root (another mount)", () => {
    it("copies links as they are and keeps modes, then removes the source", () => {
        const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-xroot-")));
        try {
            const rootA = path.join(base, "rootA");
            const rootB = path.join(base, "rootB");
            for (const root of [rootA, rootB]) {
                fs.mkdirSync(root, { recursive: true });
                fs.writeFileSync(path.join(root, ".pilotswarm-export"), "");
            }
            fs.mkdirSync(path.join(rootA, "proj", "sub"), { recursive: true });
            fs.writeFileSync(path.join(rootA, "proj", "sub", "f.txt"), "f\n");
            fs.symlinkSync("sub/f.txt", path.join(rootA, "proj", "rel-link"));
            fs.writeFileSync(path.join(rootA, "proj", "run.sh"), "#!/bin/sh\n");
            fs.chmodSync(path.join(rootA, "proj", "run.sh"), 0o755);
            // Separate mounts: a rename from one root to the other fails as it would on NFS.
            const stub = path.join(base, "exdev.cjs");
            fs.writeFileSync(stub, `const fs = require("fs"); const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (String(from).startsWith(${JSON.stringify(rootA)}) && String(to).startsWith(${JSON.stringify(rootB)})) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
  return rename.apply(this, arguments);
};`);
            const request = { base: rootA, rootPath: rootA, op: "move", path: "proj", toBase: rootB, toRootPath: rootB, toPath: "proj", codes: WORKSPACE_FILE_ERROR_CODES, requireMarker: true, maxBytes: 20 * 1024 * 1024, maxEntries: 5000 };
            const child = spawnSync(process.execPath, ["--require", stub, "-e", FILES_SCRIPT], { input: JSON.stringify(request) });
            const answer = JSON.parse(child.stdout.toString("utf8"));
            assert.equal(answer.ok, true, JSON.stringify(answer));
            assert.equal(fs.existsSync(path.join(rootA, "proj")), false, "the source is gone");
            assert.equal(fs.readlinkSync(path.join(rootB, "proj", "rel-link")), path.join("sub", "f.txt"), "a relative link stays relative");
            assert.equal(fs.readFileSync(path.join(rootB, "proj", "rel-link"), "utf8"), "f\n", "and still leads to its file");
            if (process.platform !== "win32") assert.equal(fs.statSync(path.join(rootB, "proj", "run.sh")).mode & 0o777, 0o755);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});

describe("how many file calls run at once", () => {
    it("two whole-file calls at a time; a third fails busy after its wait, and lighter calls still run", async () => {
        const first = await acquireFileCallSlot("read", 50);
        const second = await acquireFileCallSlot("zip", 50);
        const busy = await acquireFileCallSlot("write", 50).catch((error) => error);
        assert.equal(busy.code, C.BUSY);
        assert.equal(busy.status, 503);
        assert.equal(busy.expose, true, "the caller sees why");
        const light = await acquireFileCallSlot("list", 50);
        light();
        first();
        const third = await acquireFileCallSlot("move", 50);
        third();
        second();
    });

    it("a freed turn goes to the caller waiting, not to a newcomer", async () => {
        const first = await acquireFileCallSlot("read", 1000);
        const second = await acquireFileCallSlot("read", 1000);
        const waiter = acquireFileCallSlot("read", 1000);
        first();
        const handed = await waiter;
        const newcomer = await acquireFileCallSlot("read", 50).catch((error) => error);
        assert.equal(newcomer.code, C.BUSY, "the lane is still full: the freed turn went to the waiter");
        handed();
        second();
        handed();
        const again = await acquireFileCallSlot("read", 50);
        again();
    });
});

describe("which owner changes a turn tells", () => {
    const changed = (seq) => ({ seq, eventType: "session.workspace_files_changed", data: { op: "write", folder: "w", path: `f${seq}` } });
    const noted = (seq, fromSeq, throughSeq, turnIndex) => ({ seq, eventType: "session.workspace_files_noted", data: { fromSeq, throughSeq, turnIndex } });
    const seqs = (result) => result.changed.map((event) => event.seq);

    it("the first turn is told every change", () => {
        const result = workspaceFileChangesToTell([changed(1), changed(2)], 0);
        assert.deepEqual([seqs(result), result.from, result.again], [[1, 2], 1, false]);
    });

    it("the next turn is told only what came after the last note", () => {
        const result = workspaceFileChangesToTell([changed(1), changed(2), noted(3, 1, 2, 0), changed(4)], 1);
        assert.deepEqual([seqs(result), result.again], [[4], false]);
        assert.deepEqual(seqs(workspaceFileChangesToTell([changed(1), noted(2, 1, 1, 0)], 1)), [], "nothing new, nothing said");
    });

    it("another attempt at the same turn is told the same changes; newer ones wait", () => {
        const result = workspaceFileChangesToTell([changed(1), changed(2), noted(3, 1, 2, 5), changed(4)], 5);
        assert.deepEqual([seqs(result), result.from, result.again], [[1, 2], 1, true]);
    });
});

describe("the line that tells the agent what the owner changed", () => {
    it("names each change once, in order, with the folder", () => {
        assert.match(workspaceFileChangesNote([{ op: "run", folder: "tfenv", path: "", command: "discard" }]), /ran the canvas command "discard" in tfenv/);
        const note = workspaceFileChangesNote([
            { op: "write", folder: "home", path: "notes/today.md", created: true },
            { op: "write", folder: "tfenv", path: "README.md", created: false },
            { op: "write", folder: "tfenv", path: "README.md", created: false },
            { op: "mkdir", folder: "shared", path: "drop" },
            { op: "move", folder: "home", path: "notes/today.md", toFolder: "shared", toPath: "drop/today.md" },
            { op: "delete", folder: "tfenv", path: "tmp" },
        ]);
        assert.equal(note,
            "Since your last turn, the session's owner changed files in the portal (the Workspace tab or a canvas app): "
            + "added home/notes/today.md; edited tfenv/README.md; made folder shared/drop; "
            + "moved home/notes/today.md to shared/drop/today.md; deleted tfenv/tmp. "
            + "Read a file again before you rely on what you saw of it earlier.");
    });

    it("nothing to tell: null; many changes: the latest 20 and a count", () => {
        assert.equal(workspaceFileChangesNote([]), null);
        assert.equal(workspaceFileChangesNote([{ op: "list", folder: "home", path: "" }]), null);
        const many = Array.from({ length: 25 }, (_, i) => ({ op: "write", folder: "home", path: `f${i}.txt`, created: true }));
        const note = workspaceFileChangesNote(many);
        assert.match(note, /added home\/f24\.txt; and 5 more\./);
        assert.ok(!note.includes("f4.txt;"), note);
    });
});
