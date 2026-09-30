/**
 * canvas-ws (packages/sdk/src/canvas-workspace.ts and the management
 * client's canvasWorkspace): a canvas app reaches its session's folders
 * and runs commands only as its drawn manifest declared.
 *
 *   - the declaration: what is accepted, what fails the draw
 *   - path patterns: read, write, list, whole-folder
 *   - command parameters: each one a checked, whole argument
 *   - the local runner: no shell, a clean environment, git's program
 *     settings off
 *   - the call itself, on a fake catalog and real folders
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
    CANVAS_WS_ERROR_CODES as X,
    canvasCommandArgv,
    canvasCommandsConfigFromEnv,
    canvasDirListable,
    canvasDirWritable,
    canvasGlobMatch,
    canvasPathAllowed,
    canvasTreeReadable,
    canvasTreeWritable,
    checkCanvasCommandParams,
    normalizeCanvasWorkspaceManifest,
    runCanvasCommandLocally,
    splitCanvasPath,
} from "../../dist/canvas-workspace.js";
import { extractCanvasAppManifest, canvasAppCard } from "../../dist/canvas-app-manifest.js";
import { WORKSPACE_FILE_ERROR_CODES as W } from "../../dist/workspace-files.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const text = (answer) => Buffer.from(answer.contentBase64, "base64").toString("utf8");
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });

async function rejectsWith(promise, code) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
    });
}
function throwsWith(fn, code) {
    assert.throws(fn, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
    });
}

const HISTORY = {
    in: "work",
    run: ["git", "log", "--format=%H %s", "-n", "{limit}", "--", "{path}"],
    params: { path: { type: "path" }, limit: { type: "int", min: 1, max: 200, default: 20 } },
};

describe("the workspace block of a canvas manifest", () => {
    it("a good block is kept, checked and shown on the app card", () => {
        const html = `<!doctype html>\n<!-- CANVAS-APP-MANIFEST\n${JSON.stringify({
            name: "history",
            workspace: { read: ["work/**"], write: ["home/notes/*.md/"], watch: true, commands: { history: HISTORY } },
        })}\n-->\n<html></html>`;
        const { manifest, error } = extractCanvasAppManifest(html);
        assert.equal(error, undefined);
        assert.deepEqual(manifest.workspace.read, ["work/**"]);
        assert.deepEqual(manifest.workspace.write, ["home/notes/*.md"], "a trailing slash is dropped");
        assert.equal(manifest.workspace.watch, true);
        assert.deepEqual(manifest.workspace.commands.history.params.limit, { type: "int", min: 1, max: 200, default: 20 });
        assert.deepEqual(canvasAppCard(manifest).workspace, manifest.workspace, "the agent sees what the app can do");
    });

    it("an empty block is no block; a broken block fails the manifest", () => {
        assert.deepEqual(normalizeCanvasWorkspaceManifest({ watch: true }), { workspace: null });
        const broken = extractCanvasAppManifest(`<!-- CANVAS-APP-MANIFEST {"workspace":{"read":"work/**"}} -->`);
        assert.equal(broken.manifest, null);
        assert.match(broken.error, /workspace: workspace.read must be a list/);
    });

    for (const [why, block, message] of [
        ["a pattern that climbs out", { read: ["work/../etc/**"] }, /not a "<folder>\/<path>" pattern/],
        ["an absolute pattern", { read: ["/etc/**"] }, /not a "<folder>\/<path>" pattern/],
        ["a program with a path", { commands: { x: { in: "work", run: ["/bin/sh", "-c", "id"] } } }, /run\[0\] must be a program name/],
        ["a parameter as the program", { commands: { x: { in: "work", run: ["{p}"], params: { p: { type: "text" } } } } }, /run\[0\] must be a program name/],
        ["a parameter inside a longer argument", { commands: { x: { in: "work", run: ["git", "--format={f}"], params: { f: { type: "text" } } } } }, /mixes text and a parameter/],
        ["a parameter that is not declared", { commands: { x: { in: "work", run: ["git", "show", "{sha}"] } } }, /\{sha\}, which is not in params/],
        ["an unknown parameter type", { commands: { x: { in: "work", run: ["git", "{p}"], params: { p: { type: "shell" } } } } }, /type must be path, int, enum, ref, sha or text/],
        ["a default outside min..max", { commands: { x: { in: "work", run: ["git", "{n}"], params: { n: { type: "int", max: 5, default: 9 } } } } }, /default is outside/],
        ["an \"in\" that climbs out", { commands: { x: { in: "work/../etc", run: ["git", "status"] } } }, /"in" must be a session folder/],
        ["an absolute \"in\"", { commands: { x: { in: "/etc", run: ["git", "status"] } } }, /"in" must be a session folder/],
        ["a timeout over a minute", { commands: { x: { in: "work", run: ["git", "status"], timeoutSeconds: 600 } } }, /timeoutSeconds must be 1–60/],
        ["git options before the subcommand (-C picks another repository)", { commands: { x: { in: "work", run: ["git", "-C", "tfenv", "log"] } } }, /run\[1\] must be a git subcommand/],
        ["a git config setting on the command line", { commands: { x: { in: "work", run: ["git", "-c", "alias.x=!id", "x"] } } }, /run\[1\] must be a git subcommand/],
        ["a git subcommand that runs programs", { commands: { x: { in: "work", run: ["git", "difftool", "--extcmd=id"] } } }, /run\[1\] must be a git subcommand/],
        ["a git option that runs a program", { commands: { x: { in: "work", run: ["git", "grep", "--open-files-in-pager=id", "x"] } } }, /is not allowed in canvas commands/],
        ["a git option that reads outside the repository", { commands: { x: { in: "work", run: ["git", "diff", "--no-index", "a", "b"] } } }, /is not allowed in canvas commands/],
        ["a path outside the command's folder", { commands: { x: { in: "work", run: ["git", "log", "--", "../other"] } } }, /outside the command's folder/],
        ["an absolute path", { commands: { x: { in: "work", run: ["git", "log", "--", "/etc"] } } }, /outside the command's folder/],
        ["a block over 8 KB", { read: Array.from({ length: 32 }, (_, i) => `work/${"x".repeat(190)}${i}`), write: Array.from({ length: 32 }, (_, i) => `home/${"y".repeat(190)}${i}`) }, /the limit is 8192/],
    ]) {
        it(`refuses ${why}`, () => {
            const { workspace, error } = normalizeCanvasWorkspaceManifest(block);
            assert.equal(workspace, null);
            assert.match(error ?? "", message);
        });
    }
});

describe("path patterns", () => {
    const decl = {
        read: ["work/**", "home/notes/*.md"],
        write: ["home/notes/*.md", "shared/drop/**"],
        watch: false,
        commands: {},
    };

    it("** crosses folders, * and ? stay inside one", () => {
        assert.ok(canvasGlobMatch("work/**", "work/a/b/c.ts"));
        assert.ok(canvasGlobMatch("work/**/x.md", "work/x.md"));
        assert.ok(canvasGlobMatch("work/**/x.md", "work/a/b/x.md"));
        assert.ok(!canvasGlobMatch("home/notes/*.md", "home/notes/sub/a.md"));
        assert.ok(canvasGlobMatch("home/?.md", "home/a.md"));
        assert.ok(!canvasGlobMatch("home/?.md", "home/ab.md"));
        assert.ok(!canvasGlobMatch("work/a.b", "work/aXb"), "a dot is a dot");
    });

    it("read, write, list and whole-folder checks", () => {
        assert.ok(canvasPathAllowed(decl, "work/src/a.ts", "read"));
        assert.ok(!canvasPathAllowed(decl, "work/src/a.ts", "write"));
        assert.ok(canvasPathAllowed(decl, "shared/drop/x/y.bin", "read"), "writing allows reading");
        assert.ok(!canvasPathAllowed(decl, "home/secret.txt", "read"));

        assert.ok(canvasDirListable(decl, "home"), "home is on the way to home/notes/*.md");
        assert.ok(canvasDirListable(decl, "home/notes"));
        assert.ok(!canvasDirListable(decl, "home/other"));
        assert.ok(!canvasDirListable(decl, "shared/other"));

        assert.ok(canvasTreeReadable(decl, "work"));
        assert.ok(canvasTreeReadable(decl, "work/src"));
        assert.ok(!canvasTreeReadable(decl, "home/notes"), "only some files there");
        assert.ok(canvasTreeWritable(decl, "shared/drop/x"));
        assert.ok(!canvasTreeWritable(decl, "work"));

        assert.ok(canvasDirWritable(decl, "shared/drop/new"));
        assert.ok(!canvasDirWritable(decl, "work/new"));
    });

    it("\"<folder>/<path>\" splits; empty, . and .. parts are refused", () => {
        assert.deepEqual(splitCanvasPath("work/src/a.ts"), { folder: "work", path: "src/a.ts" });
        assert.deepEqual(splitCanvasPath("home/"), { folder: "home", path: "" });
        for (const bad of ["", "/work/a", "work/../x", "work/./a", "work//a", 7]) throwsWith(() => splitCanvasPath(bad), X.PARAM_INVALID);
    });
});

describe("command parameters", () => {
    const command = {
        in: "work",
        run: ["git", "show", "{rev}", "--stat", "{mode}", "{n}", "{note}", "--", "{file}"],
        params: {
            rev: { type: "ref", default: "HEAD" },
            mode: { type: "enum", values: ["--oneline", "--raw"], default: "--oneline" },
            n: { type: "int", min: 0, max: 9, default: 1 },
            note: { type: "text", maxLength: 10, default: "x" },
            file: { type: "path", optional: true },
        },
    };

    it("defaults fill in; a missing optional path drops its argument", () => {
        const checked = checkCanvasCommandParams(command, {});
        const values = Object.fromEntries(Object.entries(checked).map(([k, v]) => [k, v.value]));
        assert.deepEqual(canvasCommandArgv(command, values), { program: "git", args: ["show", "HEAD", "--stat", "--oneline", "1", "x", "--"] });
    });

    it("each value is checked against its type", () => {
        const bad = [
            [{ rev: "--output=/tmp/x" }, "an option as a ref"],
            [{ rev: "a..b" }, "a range"],
            [{ mode: "--patch" }, "a value outside the enum"],
            [{ n: -1 }, "below min"],
            [{ n: "3; rm -rf /" }, "text as a number"],
            [{ note: "-rf" }, "text that reads as an option"],
            [{ note: "two\nlines" }, "a newline"],
            [{ note: "x".repeat(11) }, "longer than maxLength"],
            [{ file: 12 }, "a number as a path"],
            [{ extra: "x" }, "an undeclared parameter"],
        ];
        for (const [values, why] of bad) {
            assert.throws(() => checkCanvasCommandParams(command, values), (e) => e.code === X.PARAM_INVALID, why);
        }
        assert.equal(checkCanvasCommandParams(command, { n: "7" }).n.value, "7", "digits as text are a number");
        assert.throws(() => checkCanvasCommandParams({ in: "work", run: ["git"], params: { s: { type: "sha" } } }, { s: "HEAD" }), (e) => e.code === X.PARAM_INVALID);
    });

    it("commands are off unless the deployment says local; git only by default", () => {
        assert.equal(canvasCommandsConfigFromEnv({}), null);
        assert.equal(canvasCommandsConfigFromEnv({ PORTAL_CANVAS_COMMANDS_RUNNER: "pod" }), null);
        assert.deepEqual(canvasCommandsConfigFromEnv({ PORTAL_CANVAS_COMMANDS_RUNNER: "local" }), { runner: "local", allow: ["git"] });
        assert.deepEqual(canvasCommandsConfigFromEnv({ PORTAL_CANVAS_COMMANDS_RUNNER: "local", PORTAL_CANVAS_COMMANDS_ALLOW: "git, rg ,/bin/sh" }).allow, ["git", "rg"]);
    });
});

describe("the local runner", () => {
    let base;
    let repo;
    let marker;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-run-")));
        repo = path.join(base, "repo");
        marker = path.join(base, "ran");
        fs.mkdirSync(repo);
        git(repo, "init", "-q");
        fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
        git(repo, "add", "a.txt");
        git(repo, "commit", "-q", "-m", "first");
        fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
        // Repository settings that would start programs; the runner turns these off.
        for (const [key, value] of [["core.fsmonitor", `touch ${marker}-fsmonitor`], ["core.pager", `touch ${marker}-pager`], ["core.hooksPath", path.join(base, "hooks")]]) {
            git(repo, "config", key, value);
        }
        fs.mkdirSync(path.join(base, "hooks"));
        fs.writeFileSync(path.join(base, "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}-hook\n`, { mode: 0o755 });
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it("git's program settings are off; the run gives output and an exit code", async () => {
        const status = await runCanvasCommandLocally({ program: "git", args: ["status", "--short"] }, repo);
        assert.equal(status.exitCode, 0, status.stderr);
        assert.match(status.stdout, /M a\.txt/);
        const diff = await runCanvasCommandLocally({ program: "git", args: ["diff"] }, repo);
        assert.match(diff.stdout, /-one\n\+two/);
        const log = await runCanvasCommandLocally({ program: "git", args: ["log", "-p"] }, repo);
        assert.match(log.stdout, /first/);
        const commit = await runCanvasCommandLocally({ program: "git", args: ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-a", "-m", "second"] }, repo);
        assert.equal(commit.exitCode, 0, commit.stderr);
        for (const what of ["fsmonitor", "hook"]) assert.ok(!fs.existsSync(`${marker}-${what}`), `${what} did not run`);
    });

    it("the runner's git settings win over the repository's", async () => {
        const pager = await runCanvasCommandLocally({ program: "git", args: ["config", "--get", "core.pager"] }, repo);
        assert.equal(pager.stdout.trim(), "cat");
        const fsmonitor = await runCanvasCommandLocally({ program: "git", args: ["config", "--get", "core.fsmonitor"] }, repo);
        assert.equal(fsmonitor.stdout.trim(), "false");
        const ext = await runCanvasCommandLocally({ program: "git", args: ["config", "--get", "protocol.ext.allow"] }, repo);
        assert.equal(ext.stdout.trim(), "never");
    });

    it("an ext:: remote, a protocol setting, or a .git file pointing elsewhere gets no git", async () => {
        for (const [key, value] of [["protocol.ext.allow", "always"], ["remote.origin.url", `ext::sh -c touch% ${marker}-ext`], ["submodule.x.update", "!id"]]) {
            git(repo, "config", key, value);
            try {
                await rejectsWith(runCanvasCommandLocally({ program: "git", args: ["status"] }, repo), X.DENIED);
            } finally {
                git(repo, "config", "--unset", key);
            }
        }
        // A folder whose .git is a FILE naming a repository outside the session folder.
        const other = fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-other-"));
        const pointer = path.join(base, "pointer");
        fs.mkdirSync(pointer, { recursive: true });
        try {
            git(other, "init", "-q");
            fs.writeFileSync(path.join(pointer, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
            await rejectsWith(runCanvasCommandLocally({ program: "git", args: ["log"] }, pointer, { top: pointer }), X.DENIED);
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
            fs.rmSync(pointer, { recursive: true, force: true });
        }
    });

    it("a repository whose settings start a program gets no git at all", async () => {
        for (const [key, value] of [["diff.external", `touch ${marker}-diff`], ["diff.x.textconv", "cat"], ["filter.x.smudge", "cat"], ["alias.st", `!touch ${marker}-alias`], ["core.worktree", "/"]]) {
            git(repo, "config", key, value);
            try {
                await rejectsWith(runCanvasCommandLocally({ program: "git", args: ["diff"] }, repo), X.DENIED);
            } finally {
                git(repo, "config", "--unset", key);
            }
        }
        assert.ok(!fs.existsSync(`${marker}-diff`));
        const plain = await runCanvasCommandLocally({ program: "git", args: ["status", "--short"] }, repo);
        assert.equal(plain.exitCode, 0, "settings removed: git runs again");
    });

    it("never a repository above the folder", async () => {
        const inner = path.join(repo, "sub");
        fs.mkdirSync(inner, { recursive: true });
        const status = await runCanvasCommandLocally({ program: "git", args: ["status"] }, inner);
        assert.notEqual(status.exitCode, 0);
        assert.match(status.stderr, /not a git repository/);
    });

    it("the environment is clean: nothing of this process's own", async () => {
        process.env.PS_CANVAS_TEST_SECRET = "do-not-leak";
        try {
            const env = await runCanvasCommandLocally({ program: "env", args: [] }, repo);
            assert.doesNotMatch(env.stdout, /do-not-leak/);
            assert.match(env.stdout, /GIT_CONFIG_NOSYSTEM=1/);
            assert.match(env.stdout, /HOME=.*ps-canvas-cmd-/);
        } finally {
            delete process.env.PS_CANVAS_TEST_SECRET;
        }
    });

    it("no shell: an argument is one argument", async () => {
        const echo = await runCanvasCommandLocally({ program: "echo", args: ["$(touch x); `id`"] }, repo);
        assert.equal(echo.stdout, "$(touch x); `id`\n");
        assert.ok(!fs.existsSync(path.join(repo, "x")));
    });

    it("output is cut at the limit; a slow program is stopped; a missing one says so", async () => {
        const big = await runCanvasCommandLocally({ program: "head", args: ["-c", "5000", "/dev/zero"] }, repo, { maxOutputBytes: 1024 });
        assert.equal(big.truncated, true);
        assert.equal(Buffer.byteLength(big.stdout), 1024);
        await rejectsWith(runCanvasCommandLocally({ program: "sleep", args: ["5"] }, repo, { timeoutSeconds: 1 }), X.TIMEOUT);
        await rejectsWith(runCanvasCommandLocally({ program: "no-such-program-here", args: [] }, repo), X.RUN_FAILED);
    });
});

describe("the canvasWorkspace call", () => {
    let base;
    let client;
    let events;
    let html;
    let rev;
    let legacyEvent = false;
    let eventWorkspace;
    const manifest = (workspace) => `<!doctype html>\n<!-- CANVAS-APP-MANIFEST\n${JSON.stringify({ name: "t", workspace })}\n-->\n<html></html>`;
    const DECLARED = {
        read: ["work/**", "home/notes/*.md"],
        write: ["home/notes/*.md", "work/drop/**"],
        watch: true,
        commands: {
            history: HISTORY,
            commit: { in: "work", run: ["git", "commit", "-q", "-a", "-m", "{message}"], params: { message: { type: "text", maxLength: 100 } } },
            status: { in: "work", run: ["git", "status", "--short"] },
            listing: { in: "work", run: ["ls"] },
            srcLog: { in: "work/src", run: ["git", "log", "--format=%s", "--", "{path}"], params: { path: { type: "path" } } },
            missing: { in: "work/nope", run: ["git", "status"] },
        },
    };

    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-canvas-call-")));
        const repo = path.join(base, "a", "repo");
        fs.mkdirSync(path.join(repo, "src"), { recursive: true });
        fs.mkdirSync(path.join(base, "a", "home", "notes"), { recursive: true });
        fs.mkdirSync(path.join(base, "outside"));
        fs.writeFileSync(path.join(base, "outside", "secret.txt"), "secret\n");
        fs.writeFileSync(path.join(base, "a", ".pilotswarm-export"), "");
        fs.writeFileSync(path.join(base, "a", "home", "notes", "todo.md"), "- one\n");
        fs.writeFileSync(path.join(base, "a", "home", "private.txt"), "mine\n");
        fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
        git(repo, "init", "-q");
        git(repo, "add", ".");
        git(repo, "commit", "-q", "-m", "first");
        fs.symlinkSync(path.join(base, "outside"), path.join(repo, "out"));

        events = [];
        rev = 3;
        html = manifest(DECLARED);
        client = new PilotSwarmManagementClient({
            store: "postgres://unused",
            workspaceFiles: { roots: [{ name: "a", path: path.join(base, "a") }] },
            canvasCommands: { runner: "local", allow: ["git"] },
            artifactStore: { downloadArtifactText: async (sessionId, filename) => { assert.equal(filename, "canvas.html"); return html; } },
        });
        client._started = true;
        client._catalog = {
            getSessionCanvases: async () => [{ slot: 1, latestRev: rev }],
            // The draw event: new draws carry the page's checked block;
            // canvases drawn before that carry none (legacy: the page is read).
            getSessionEventsBefore: async () => (rev > 0 ? [{
                seq: rev,
                eventType: "session.canvas_updated",
                data: {
                    slot: 1,
                    rev,
                    ...(legacyEvent ? {} : { workspace: eventWorkspace !== undefined ? eventWorkspace : (extractCanvasAppManifest(html).manifest?.workspace ?? null) }),
                },
            }] : []),
            getSession: async () => ({ owner: { provider: "dev", subject: "alice", email: "alice@example.test", displayName: "Alice" } }),
            recordEvents: async (sessionId, rows) => { events.push(...rows); },
        };
        client.getSessionWorkspace = async () => ({
            workspace: { schema: 1, root: "a", folder: "repo", extra: {} },
            path: "/ws/a/repo",
            defaults: { workingFolder: null, extra: [{ name: "home", root: "a", folder: "home", home: true }] },
        });
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    const call = (c, slot = 1) => client.canvasWorkspace("s1", slot, c);

    it("info: the folders it can reach and the commands it declared", async () => {
        const info = await call({ op: "info" });
        assert.deepEqual(info.folders.map((f) => f.name), ["work", "home"]);
        assert.deepEqual(Object.keys(info.commands), ["history", "commit", "status", "listing", "srcLog", "missing"]);
        assert.equal(info.commandsEnabled, true);
        assert.equal(info.watch, true);
    });

    it("list shows only what the app may see; read and write follow the patterns", async () => {
        const home = await call({ op: "list", path: "home" });
        assert.deepEqual(home.entries.map((e) => e.name), ["notes"], "private.txt is not shown");
        const notes = await call({ op: "list", path: "home/notes" });
        assert.deepEqual(notes.entries.map((e) => [e.path, e.readOnly === true]), [["home/notes/todo.md", false]]);
        assert.equal(text(await call({ op: "read", path: "home/notes/todo.md" })), "- one\n");
        await rejectsWith(call({ op: "read", path: "home/private.txt" }), X.DENIED);
        await rejectsWith(call({ op: "list", path: "home/other" }), X.DENIED);

        const read = await call({ op: "read", path: "work/src/a.ts" });
        assert.equal(read.readOnly, true, "work is read-only for this app");
        await rejectsWith(call({ op: "write", path: "work/src/a.ts", contentBase64: b64("x"), ifMatch: read.etag }), X.DENIED);

        const written = await call({ op: "write", path: "home/notes/new.md", contentBase64: b64("hi\n"), ifMatch: null });
        assert.equal(written.created, true);
        assert.equal(fs.readFileSync(path.join(base, "a", "home", "notes", "new.md"), "utf8"), "hi\n");
        assert.deepEqual(events.at(-1), { eventType: "session.workspace_files_changed", data: { op: "write", folder: "home", path: "notes/new.md", created: true, via: "canvas" } });
        await rejectsWith(call({ op: "write", path: "home/notes/new.md", contentBase64: b64("again\n"), ifMatch: "sha256:stale" }), W.CONFLICT);
    });

    it("folders: made, moved and deleted only where the patterns cover them", async () => {
        await call({ op: "mkdir", path: "work/drop" });
        await call({ op: "mkdir", path: "work/drop/in" });
        await rejectsWith(call({ op: "mkdir", path: "work/src/new" }), X.DENIED);
        fs.writeFileSync(path.join(base, "a", "repo", "drop", "in", "f.txt"), "f\n");
        await call({ op: "move", path: "work/drop/in", toPath: "work/drop/out" });
        assert.ok(fs.existsSync(path.join(base, "a", "repo", "drop", "out", "f.txt")));
        await rejectsWith(call({ op: "move", path: "work/drop/out", toPath: "home/notes/out.md" }), X.DENIED);
        await rejectsWith(call({ op: "delete", path: "work/src", recursive: true }), X.DENIED);
        await rejectsWith(call({ op: "delete", path: "work/src/a.ts" }), X.DENIED);
        await rejectsWith(call({ op: "delete", path: "work/drop" }), W.NOT_EMPTY);
        await call({ op: "delete", path: "work/drop", recursive: true });
        assert.ok(!fs.existsSync(path.join(base, "a", "repo", "drop")));
    });

    it("zip only for a folder the app may read whole; .git stays read-only; links out are refused", async () => {
        const zip = await call({ op: "zip", path: "work/src" });
        assert.ok(zip.contentBase64.length > 0);
        await rejectsWith(call({ op: "zip", path: "home/notes" }), X.DENIED);
        await rejectsWith(call({ op: "read", path: "work/out/secret.txt" }), W.OUTSIDE);
        html = manifest({ ...DECLARED, write: [...DECLARED.write, "work/**"] });
        rev = 4;
        await rejectsWith(call({ op: "write", path: "work/.git/config", contentBase64: b64("x"), ifMatch: null }), W.READ_ONLY);
        html = manifest(DECLARED);
        rev = 5;
    });

    it("run: a declared command with checked values, as the session's owner", async () => {
        const history = await call({ op: "run", command: "history", params: { path: "work/src/a.ts", limit: 5 } });
        assert.equal(history.exitCode, 0, history.stderr);
        assert.match(history.stdout, /^[0-9a-f]{40} first\n$/);

        fs.writeFileSync(path.join(base, "a", "repo", "src", "a.ts"), "export const a = 2;\n");
        const commit = await call({ op: "run", command: "commit", params: { message: "from the canvas" } });
        assert.equal(commit.exitCode, 0, commit.stderr);
        assert.equal(git(path.join(base, "a", "repo"), "log", "-1", "--format=%an <%ae> %s").trim(), "Alice <alice@example.test> from the canvas");

        await rejectsWith(call({ op: "run", command: "nope" }), X.COMMAND_UNKNOWN);
        await rejectsWith(call({ op: "run", command: "listing" }), X.PROGRAM_NOT_ALLOWED);
        await rejectsWith(call({ op: "run", command: "history", params: { path: "home/notes/todo.md" } }), X.PARAM_INVALID);
        await rejectsWith(call({ op: "run", command: "history", params: { path: "work/out/secret.txt" } }), W.OUTSIDE);
        await rejectsWith(call({ op: "run", command: "commit", params: { message: "--amend" } }), X.PARAM_INVALID);
    });

    it("run in a folder inside a session folder: paths are taken from there, git finds the repo above it", async () => {
        const log = await call({ op: "run", command: "srcLog", params: { path: "work/src/a.ts" } });
        assert.equal(log.exitCode, 0, log.stderr);
        assert.equal(log.stdout, "from the canvas\nfirst\n");
        await rejectsWith(call({ op: "run", command: "srcLog", params: { path: "work/README.md" } }), X.PARAM_INVALID);
        await rejectsWith(call({ op: "run", command: "missing" }), W.NOT_FOUND);
    });

    it("the rules come from the draw event, not from a page uploaded after it", async () => {
        // A redraw uploads the new page before it records its event. In that
        // window the portal must keep the old page's rules, with the old rev.
        eventWorkspace = normalizeCanvasWorkspaceManifest({ read: ["work/**"], write: ["work/**"] }).workspace;
        html = manifest({ read: ["work/**"] });
        rev = 20;
        const written = await call({ op: "write", path: "work/event-rules.txt", contentBase64: b64("x"), ifMatch: null });
        assert.equal(written.created, true, "the event's block (write work/**) applies, not the newer page's");
        eventWorkspace = undefined;
        rev = 21;
        await rejectsWith(call({ op: "write", path: "work/event-rules.txt", contentBase64: b64("y"), ifMatch: written.etag }), X.DENIED);
        fs.rmSync(path.join(base, "a", "repo", "event-rules.txt"), { force: true });
    });

    it("a canvas drawn before events carried the block: the page is read", async () => {
        legacyEvent = true;
        try {
            html = manifest(DECLARED);
            rev = 30;
            assert.equal((await call({ op: "info" })).watch, true);
            html = "<!doctype html><html>no manifest</html>";
            rev = 31;
            await rejectsWith(call({ op: "info" }), X.UNDECLARED);
        } finally {
            legacyEvent = false;
            html = manifest(DECLARED);
            rev = 32;
        }
    });

    it("canvas calls never go through a link, even one inside the folder", async () => {
        const repo = path.join(base, "a", "repo");
        fs.mkdirSync(path.join(repo, "real"), { recursive: true });
        fs.writeFileSync(path.join(repo, "real", "file.md"), "real\n");
        fs.symlinkSync(path.join(repo, "real"), path.join(repo, "linked"));
        try {
            await rejectsWith(call({ op: "read", path: "work/linked/file.md" }), W.OUTSIDE);
            await rejectsWith(call({ op: "write", path: "work/drop/../linked/x" , contentBase64: b64("x"), ifMatch: null }), X.PARAM_INVALID);
            const listed = await call({ op: "list", path: "work" });
            assert.ok(!listed.entries.some((e) => e.name === "linked"), "links are not listed to canvas apps");
            assert.equal(text(await call({ op: "read", path: "work/real/file.md" })), "real\n");
        } finally {
            fs.unlinkSync(path.join(repo, "linked"));
            fs.rmSync(path.join(repo, "real"), { recursive: true, force: true });
        }
    });

    it("stat and command paths need read access, and do not tell whether a hidden file exists", async () => {
        html = manifest({ read: ["work/**/*.md"], commands: { hist: { in: "work", run: ["git", "log", "--format=%s", "--", "{path}"], params: { path: { type: "path" } } } } });
        rev = 40;
        const repo = path.join(base, "a", "repo");
        fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
        try {
            // work/.env is in a folder the app may list, but it may not read it.
            await rejectsWith(call({ op: "stat", path: "work/.env" }), X.DENIED);
            await rejectsWith(call({ op: "stat", path: "work/.nothing-here" }), X.DENIED, "missing and hidden answer alike");
            await rejectsWith(call({ op: "run", command: "hist", params: { path: "work/.env" } }), X.DENIED);
            await rejectsWith(call({ op: "run", command: "hist", params: { path: "work/src" } }), X.DENIED, "a folder needs all of it readable");
            assert.equal((await call({ op: "stat", path: "work/src" })).kind, "dir", "a folder it may list");
        } finally {
            fs.rmSync(path.join(repo, ".env"), { force: true });
            html = manifest(DECLARED);
            rev = 41;
        }
    });

    it("a command run is told to the agent, once a minute per command", async () => {
        const before = events.length;
        await call({ op: "run", command: "status" });
        await call({ op: "run", command: "status" });
        const told = events.slice(before).filter((e) => e.data.op === "run");
        assert.deepEqual(told.map((e) => e.data), [{ op: "run", folder: "repo", path: "", command: "status", via: "canvas" }]);
    });

    it("no commands without a runner; nothing at all without a declaration", async () => {
        const saved = client.config.canvasCommands;
        client.config.canvasCommands = null;
        try {
            await rejectsWith(call({ op: "run", command: "status" }), X.COMMANDS_DISABLED);
            assert.equal((await call({ op: "info" })).commandsEnabled, false);
        } finally {
            client.config.canvasCommands = saved;
        }
        html = "<!doctype html><html>no manifest</html>";
        rev = 6;
        await rejectsWith(call({ op: "info" }), X.UNDECLARED);
        await rejectsWith(call({ op: "read", path: "work/src/a.ts" }), X.UNDECLARED);
        html = manifest(DECLARED);
        rev = 7;
        await rejectsWith(call({ op: "info" }, 2), X.UNDECLARED, "slot 2 was never drawn");
    });
});
