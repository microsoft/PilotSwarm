/**
 * Git in the Workspace tab (packages/sdk/src/workspace-git.ts and the
 * management client's { op: "git" } file call): read-only status, log and
 * show for a session folder that is a git repository.
 *
 *   - the parsers, on git's machine output
 *   - the call itself, on a fake catalog and a real repository
 *   - no git info without the runner, outside a repository, or in a
 *     repository whose settings start a program
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseGitStatus, parseNumstat, parseNameStatus, parseCommits } from "../../dist/workspace-git.js";
import { WORKSPACE_FILE_ERROR_CODES as W } from "../../dist/workspace-files.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.test", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.test" },
});

describe("workspace git: parsers", () => {
    it("status: branch, ahead/behind, each kind of entry, paths with spaces", () => {
        const out = [
            "# branch.oid 1111111111111111111111111111111111111111",
            "# branch.head fix/x",
            "# branch.upstream origin/fix/x",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb src/a b.ts",
            "1 A. N... 000000 100644 100644 000 ccc new.ts",
            "1 .D N... 100644 100644 000000 ddd ddd gone.ts",
            "2 R. N... 100644 100644 100644 eee eee R100 to.ts",
            "from.ts",
            "u UU N... 100644 100644 100644 100644 f1 f2 f3 both.ts",
            "? notes/",
            "? loose.txt",
            "",
        ].join("\0");
        const parsed = parseGitStatus(out);
        assert.equal(parsed.head, "1111111111111111111111111111111111111111");
        assert.equal(parsed.branch, "fix/x");
        assert.equal(parsed.upstream, "origin/fix/x");
        assert.deepEqual([parsed.ahead, parsed.behind], [2, 1]);
        assert.deepEqual(parsed.files.map((f) => [f.path, f.letter, f.staged, f.unstaged]), [
            ["src/a b.ts", "M", false, true],
            ["new.ts", "A", true, false],
            ["gone.ts", "D", false, true],
            ["to.ts", "R", true, false],
            ["both.ts", "C", false, true],
            ["notes", "U", false, true],
            ["loose.txt", "U", false, true],
        ]);
        assert.equal(parsed.files[3].from, "from.ts");
        assert.equal(parsed.files[5].dir, true);
    });

    it("status: no commit yet, and a detached HEAD", () => {
        assert.equal(parseGitStatus("# branch.oid (initial)\0# branch.head main\0").head, null);
        assert.equal(parseGitStatus("# branch.oid abc\0# branch.head (detached)\0").branch, null);
    });

    it("numstat: counts, binary files, renames", () => {
        const counts = parseNumstat(["3\t1\ta.ts", "-\t-\timg.png", "2\t0\t", "old.ts", "new.ts", ""].join("\0"));
        assert.deepEqual(counts.get("a.ts"), { added: 3, removed: 1 });
        assert.deepEqual(counts.get("img.png"), { added: null, removed: null });
        assert.deepEqual(counts.get("new.ts"), { added: 2, removed: 0 });
        assert.equal(counts.has("old.ts"), false);
    });

    it("name-status: letters and renames", () => {
        const files = parseNameStatus(["M", "a.ts", "A", "b.ts", "D", "c.ts", "R087", "d.ts", "e.ts", ""].join("\0"));
        assert.deepEqual(files.map((f) => [f.path, f.letter, f.from ?? null]), [["a.ts", "M", null], ["b.ts", "A", null], ["c.ts", "D", null], ["e.ts", "R", "d.ts"]]);
    });

    it("commits: fields, parents, refs", () => {
        const sha = "a".repeat(40);
        const commits = parseCommits(`${[sha, "aaaaaaa", "Ada", "ada@x", "1700000000", "b c", "HEAD -> main, tag: v1", "Fix it"].join("\x1f")}\x1e\n`);
        assert.deepEqual(commits, [{ sha, short: "aaaaaaa", author: "Ada", email: "ada@x", time: 1700000000, parents: ["b", "c"], refs: ["HEAD -> main", "tag: v1"], subject: "Fix it" }]);
    });
});

describe("workspace git: the file call", () => {
    let base;
    let repo;
    let first;
    let second;
    const makeClient = (canvasCommands = { runner: "local", allow: ["git"] }) => {
        const client = new PilotSwarmManagementClient({
            store: "postgres://unused",
            workspaceFiles: { roots: [{ name: "a", path: path.join(base, "a") }] },
            canvasCommands,
        });
        client._started = true;
        client._catalog = { recordEvents: async () => {} };
        client.getSessionWorkspace = async () => ({
            workspace: { schema: 1, root: "a", folder: "repo", extra: {} },
            path: "/ws/a/repo",
            defaults: { workingFolder: null, extra: [{ name: "home", root: "a", folder: "home", home: true }] },
        });
        return client;
    };
    const folderIds = async (client) => {
        const listed = await client.listSessionWorkspaceFolders("s1");
        return { listed, work: listed.folders.find((f) => f.role === "working").id, home: listed.folders.find((f) => f.home).id };
    };

    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-git-")));
        repo = path.join(base, "a", "repo");
        fs.mkdirSync(path.join(repo, "src"), { recursive: true });
        fs.mkdirSync(path.join(base, "a", "home"), { recursive: true });
        fs.writeFileSync(path.join(base, "a", ".pilotswarm-export"), "");
        fs.writeFileSync(path.join(repo, "src", "a.ts"), "one\ntwo\n");
        fs.writeFileSync(path.join(repo, "old.ts"), "x\n");
        fs.writeFileSync(path.join(repo, "gone.ts"), "bye\n");
        git(repo, "init", "-q");
        git(repo, "add", ".");
        git(repo, "commit", "-q", "-m", "first");
        first = git(repo, "rev-parse", "HEAD").trim();
        git(repo, "switch", "-q", "-c", "feature");
        fs.writeFileSync(path.join(repo, "src", "b.ts"), "b\n");
        git(repo, "add", ".");
        git(repo, "commit", "-q", "-m", "second\n\nThe body.");
        second = git(repo, "rev-parse", "HEAD").trim();
        // Not committed: one change staged, one not, a rename, a deletion, an untracked file.
        fs.writeFileSync(path.join(repo, "src", "a.ts"), "one\nTWO\nthree\n");
        fs.writeFileSync(path.join(repo, "staged.ts"), "s\n");
        git(repo, "add", "staged.ts");
        git(repo, "mv", "old.ts", "new.ts");
        fs.rmSync(path.join(repo, "gone.ts"));
        fs.writeFileSync(path.join(repo, "loose.txt"), "l\n");
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it("the folder list says whether git is on", async () => {
        assert.equal((await folderIds(makeClient())).listed.git, true);
        assert.equal((await folderIds(makeClient(null))).listed.git, false);
    });

    it("status: branch and every changed file, with line counts", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        const result = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status" });
        assert.equal(result.repo, true);
        assert.equal(result.available, true);
        assert.equal(result.branch, "feature");
        assert.equal(result.head, second);
        const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
        assert.deepEqual(Object.keys(byPath).sort(), ["gone.ts", "loose.txt", "new.ts", "src/a.ts", "staged.ts"]);
        assert.deepEqual([byPath["src/a.ts"].letter, byPath["src/a.ts"].added, byPath["src/a.ts"].removed], ["M", 2, 1]);
        assert.deepEqual([byPath["staged.ts"].letter, byPath["staged.ts"].staged], ["A", true]);
        assert.equal(result.state, null, "no merge or rebase stopped");
        assert.deepEqual([byPath["new.ts"].letter, byPath["new.ts"].from], ["R", "old.ts"]);
        assert.equal(byPath["gone.ts"].letter, "D");
        assert.equal(byPath["loose.txt"].letter, "U");
    });

    it("status: a file staged and changed again counts each part in its own group", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        fs.writeFileSync(path.join(repo, "both.ts"), "one\n");
        git(repo, "add", "both.ts");
        git(repo, "commit", "-q", "-m", "both");
        fs.appendFileSync(path.join(repo, "both.ts"), "staged line\n");
        git(repo, "add", "both.ts");
        fs.appendFileSync(path.join(repo, "both.ts"), "disk line 1\ndisk line 2\n");
        try {
            const result = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status" });
            const both = result.files.find((f) => f.path === "both.ts");
            assert.deepEqual([both.staged, both.unstaged, both.added], [true, true, 3], "the total is both parts");
            assert.deepEqual(both.staged_counts, { added: 1, removed: 0 });
            assert.deepEqual(both.unstaged_counts, { added: 2, removed: 0 });
        } finally {
            git(repo, "reset", "-q", "--hard", "HEAD~1");
            // The reset dropped the uncommitted test state: put it back.
            fs.writeFileSync(path.join(repo, "src", "a.ts"), "one\nTWO\nthree\n");
            fs.writeFileSync(path.join(repo, "staged.ts"), "s\n");
            git(repo, "add", "staged.ts");
            git(repo, "mv", "old.ts", "new.ts");
            fs.rmSync(path.join(repo, "gone.ts"));
        }
    });

    it("status: a merge that stopped on a conflict says so", async () => {
        const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-git-merge-")));
        const merge = path.join(base, "a", "repo");
        fs.mkdirSync(merge, { recursive: true });
        fs.writeFileSync(path.join(base, "a", ".pilotswarm-export"), "");
        try {
            git(merge, "init", "-q");
            fs.writeFileSync(path.join(merge, "f.txt"), "a\nb\n");
            git(merge, "add", ".");
            git(merge, "commit", "-q", "-m", "base");
            git(merge, "switch", "-q", "-c", "other");
            fs.writeFileSync(path.join(merge, "f.txt"), "a\nB other\n");
            git(merge, "commit", "-q", "-am", "other");
            git(merge, "switch", "-q", "main");
            fs.writeFileSync(path.join(merge, "f.txt"), "a\nB main\n");
            git(merge, "commit", "-q", "-am", "main");
            assert.throws(() => git(merge, "merge", "-q", "other"));
            const client = new PilotSwarmManagementClient({
                store: "postgres://unused",
                workspaceFiles: { roots: [{ name: "a", path: path.join(base, "a") }] },
                canvasCommands: { runner: "local", allow: ["git"] },
            });
            client._started = true;
            client._catalog = { recordEvents: async () => {} };
            client.getSessionWorkspace = async () => ({ workspace: { schema: 1, root: "a", folder: "repo", extra: {} }, path: "/ws/a/repo", defaults: { workingFolder: null, extra: [] } });
            const listed = await client.listSessionWorkspaceFolders("s1");
            const result = await client.sessionWorkspaceFiles("s1", { op: "git", folder: listed.folders[0].id, what: "status" });
            assert.equal(result.state, "merge");
            assert.deepEqual(result.files.map((f) => [f.path, f.letter]), [["f.txt", "C"]]);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("status since main: the branch's commits too", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        const result = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status", since: "main" });
        assert.equal(result.since.sha, first);
        assert.equal(result.since.label, "main");
        assert.ok(result.files.some((f) => f.path === "src/b.ts" && f.letter === "A"), "the committed file shows");
        const sinceCommit = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status", since: second.slice(0, 8) });
        assert.equal(sinceCommit.since.sha, second);
        assert.ok(!sinceCommit.files.some((f) => f.path === "src/b.ts"));
        await assert.rejects(client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status", since: "--output=/tmp/x" }), (e) => e.code === W.PATH_INVALID);
    });

    it("log and show: commits, then one commit's files and message", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        const log = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "log" });
        assert.deepEqual(log.commits.map((c) => c.subject), ["second", "first"]);
        assert.ok(log.commits[0].refs.some((r) => r.includes("feature")));
        assert.equal(log.more, false);
        const shown = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "show", sha: second });
        assert.equal(shown.commit.subject, "second");
        assert.equal(shown.commit.body, "The body.");
        assert.deepEqual(shown.files.map((f) => [f.path, f.letter, f.added]), [["src/b.ts", "A", 1]]);
        const root = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "show", sha: first });
        assert.deepEqual(root.files.map((f) => f.path).sort(), ["gone.ts", "old.ts", "src/a.ts"]);
        await assert.rejects(client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "show", sha: "HEAD~1" }), (e) => e.code === W.PATH_INVALID);
    });

    it("compare: the files that differ between two commits", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        const result = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "compare", from: first.slice(0, 9), to: second });
        assert.deepEqual([result.from.sha, result.to.sha], [first, second]);
        assert.deepEqual(result.files.map((f) => [f.path, f.letter, f.added]), [["src/b.ts", "A", 1]]);
        const back = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "compare", from: second, to: first });
        assert.deepEqual(back.files.map((f) => [f.path, f.letter]), [["src/b.ts", "D"]]);
        await assert.rejects(client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "compare", from: "HEAD", to: second }), (e) => e.code === W.PATH_INVALID);
        await assert.rejects(client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "compare", from: "abcdef0", to: second }), (e) => e.code === W.NOT_FOUND);
    });

    it("file: the text at HEAD, in the index, at a commit; missing and binary files", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        const at = (rev, file) => client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "file", rev, path: file });
        assert.equal((await at("HEAD", "src/a.ts")).text, "one\ntwo\n", "HEAD: the committed text, not the edit on disk");
        assert.equal((await at("INDEX", "staged.ts")).text, "s\n", "the index holds the staged file");
        assert.equal((await at("HEAD", "staged.ts")).exists, false, "a staged new file has no HEAD side");
        assert.equal((await at(first, "src/b.ts")).exists, false);
        assert.equal((await at(second.slice(0, 10), "src/b.ts")).text, "b\n");
        fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([1, 0, 2, 0]));
        git(repo, "add", "bin.dat");
        try {
            assert.equal((await at("INDEX", "bin.dat")).binary, true);
        } finally {
            git(repo, "rm", "-q", "--cached", "bin.dat");
            fs.rmSync(path.join(repo, "bin.dat"));
        }
        await assert.rejects(at("HEAD~1", "src/a.ts"), (e) => e.code === W.PATH_INVALID);
        await assert.rejects(at("HEAD", "../outside.txt"), (e) => e.code === W.PATH_INVALID || e.code === W.OUTSIDE);
        await assert.rejects(at("HEAD", ""), (e) => e.code === W.PATH_INVALID);
    });

    it("repos: the folder itself, or repositories inside it (a clone in home)", async () => {
        const client = makeClient();
        const { work, home } = await folderIds(client);
        assert.deepEqual(await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "repos" }), { top: true, repos: [], truncated: false });
        const clone = path.join(base, "a", "home", "projects", "clone");
        fs.mkdirSync(path.join(clone, "src"), { recursive: true });
        fs.mkdirSync(path.join(base, "a", "home", "node_modules", "dep"), { recursive: true });
        fs.writeFileSync(path.join(clone, "src", "x.ts"), "x\n");
        git(clone, "init", "-q");
        git(clone, "add", ".");
        git(clone, "commit", "-q", "-m", "clone start");
        // Not searched: node_modules, and repositories inside a repository.
        git(path.join(base, "a", "home", "node_modules", "dep"), "init", "-q");
        fs.mkdirSync(path.join(clone, "vendor", "inner"), { recursive: true });
        git(path.join(clone, "vendor", "inner"), "init", "-q");
        try {
            assert.deepEqual(await client.sessionWorkspaceFiles("s1", { op: "git", folder: home, what: "repos" }), { top: false, repos: ["projects/clone"], truncated: false });
            fs.writeFileSync(path.join(clone, "src", "x.ts"), "x\ny\n");
            const status = await client.sessionWorkspaceFiles("s1", { op: "git", folder: home, what: "status", repo: "projects/clone" });
            assert.equal(status.branch, "main");
            const changed = status.files.find((f) => f.path === "src/x.ts");
            assert.deepEqual([changed.letter, changed.added], ["M", 1], "paths are relative to the clone");
            const log = await client.sessionWorkspaceFiles("s1", { op: "git", folder: home, what: "log", repo: "projects/clone" });
            assert.deepEqual(log.commits.map((c) => c.subject), ["clone start"]);
            const file = await client.sessionWorkspaceFiles("s1", { op: "git", folder: home, what: "file", repo: "projects/clone", rev: "HEAD", path: "src/x.ts" });
            assert.equal(file.text, "x\n");
            assert.deepEqual(await client.sessionWorkspaceFiles("s1", { op: "git", folder: home, what: "status", repo: "projects" }), { repo: false });
            await assert.rejects(client.sessionWorkspaceFiles("s1", { op: "git", folder: home, what: "status", repo: "../repo" }), (e) => e.code === W.PATH_INVALID);
        } finally {
            fs.rmSync(path.join(base, "a", "home", "projects"), { recursive: true, force: true });
            fs.rmSync(path.join(base, "a", "home", "node_modules"), { recursive: true, force: true });
        }
    });

    it("no git info: a folder that is not a repository, or no runner", async () => {
        const client = makeClient();
        const { work, home } = await folderIds(client);
        assert.deepEqual(await client.sessionWorkspaceFiles("s1", { op: "git", folder: home, what: "status" }), { repo: false });
        const off = makeClient(null);
        assert.deepEqual(await off.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status" }), { repo: false, enabled: false });
    });

    it("a repository nested inside (a submodule) cannot start a program through its own settings", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        const inner = path.join(repo, "inner");
        const marker = path.join(base, "pwned-by-inner");
        fs.mkdirSync(inner);
        fs.writeFileSync(path.join(inner, "f.txt"), "one\n");
        fs.writeFileSync(path.join(inner, ".gitattributes"), "* filter=evil\n");
        git(inner, "init", "-q");
        git(inner, "add", ".");
        git(inner, "commit", "-q", "-m", "inner");
        git(repo, "add", "inner");
        git(repo, "commit", "-q", "-m", "add inner as a submodule entry");
        // Set after the commits, so only a git run inside "inner" can start it.
        git(inner, "config", "filter.evil.clean", `touch ${marker}`);
        fs.writeFileSync(path.join(inner, "f.txt"), "two\n");
        try {
            const status = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status" });
            assert.equal(status.available, true);
            await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status", since: "main" });
            assert.equal(fs.existsSync(marker), false, "no program from the nested repository's settings ran");
        } finally {
            fs.rmSync(marker, { force: true });
            git(repo, "reset", "-q", "--hard", "HEAD~1");
            fs.rmSync(inner, { recursive: true, force: true });
            fs.writeFileSync(path.join(repo, "src", "a.ts"), "one\nTWO\nthree\n");
            fs.writeFileSync(path.join(repo, "staged.ts"), "s\n");
            git(repo, "add", "staged.ts");
            git(repo, "mv", "old.ts", "new.ts");
            fs.rmSync(path.join(repo, "gone.ts"));
        }
    });

    it("a repository whose settings start a program gets no git info", async () => {
        const client = makeClient();
        const { work } = await folderIds(client);
        git(repo, "config", "filter.evil.clean", "touch pwned");
        try {
            const result = await client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what: "status" });
            assert.equal(result.available, false);
            assert.match(result.reason, /filter\.evil\.clean/);
            assert.equal(fs.existsSync(path.join(repo, "pwned")), false);
        } finally {
            git(repo, "config", "--unset", "filter.evil.clean");
        }
    });
});

describe("workspace git: check out a commit, go back, put the changes back", () => {
    let base;
    let repo;
    let first;
    let state;
    let events;
    let client;
    let work;

    before(async () => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-git-checkout-")));
        repo = path.join(base, "a", "repo");
        fs.mkdirSync(repo, { recursive: true });
        fs.writeFileSync(path.join(base, "a", ".pilotswarm-export"), "");
        fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
        fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
        git(repo, "init", "-q");
        git(repo, "add", ".");
        git(repo, "commit", "-q", "-m", "one");
        first = git(repo, "rev-parse", "HEAD").trim();
        fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
        fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
        git(repo, "add", ".");
        git(repo, "commit", "-q", "-m", "two");
        // Not committed: a change, an untracked file, an ignored file.
        fs.writeFileSync(path.join(repo, "a.txt"), "3\n");
        fs.writeFileSync(path.join(repo, "u.txt"), "untracked\n");
        fs.writeFileSync(path.join(repo, "x.log"), "ignored\n");
        state = "idle";
        events = [];
        client = new PilotSwarmManagementClient({
            store: "postgres://unused",
            workspaceFiles: { roots: [{ name: "a", path: path.join(base, "a") }] },
            canvasCommands: { runner: "local", allow: ["git"] },
        });
        client._started = true;
        client._catalog = {
            recordEvents: async (sessionId, rows) => { events.push(...rows); },
            getSession: async () => ({ state, owner: { provider: "dev", subject: "ada", email: "ada@example.test", displayName: "Ada" } }),
        };
        client.getSessionWorkspace = async () => ({ workspace: { schema: 1, root: "a", folder: "repo", extra: {} }, path: "/ws/a/repo", defaults: { workingFolder: null, extra: [] } });
        work = (await client.listSessionWorkspaceFolders("s1")).folders[0].id;
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    const gitCall = (what, extra = {}) => client.sessionWorkspaceFiles("s1", { op: "git", folder: work, what, ...extra });
    const read = (name) => (fs.existsSync(path.join(repo, name)) ? fs.readFileSync(path.join(repo, name), "utf8") : null);

    it("with uncommitted changes it asks for a stash and changes nothing", async () => {
        const result = await gitCall("checkout", { sha: first });
        assert.deepEqual([result.done, result.needsStash, result.changes], [false, true, 2]);
        assert.equal(read("a.txt"), "3\n");
        assert.equal(events.length, 0);
    });

    it("never under a running turn", async () => {
        state = "running";
        try {
            await assert.rejects(gitCall("checkout", { sha: first, stash: true }), (e) => e.code === W.BUSY);
        } finally {
            state = "idle";
        }
        assert.equal(read("a.txt"), "3\n");
    });

    it("with stash: the folder is the commit; untracked files are stashed, ignored ones stay", async () => {
        const result = await gitCall("checkout", { sha: first.slice(0, 10), stash: true });
        assert.deepEqual([result.done, result.detached, result.stashed, result.to, result.from], [true, true, true, first.slice(0, 7), "main"]);
        assert.equal(read("a.txt"), "1\n");
        assert.equal(read("b.txt"), null, "added later: not there at this commit");
        assert.equal(read("u.txt"), null, "the untracked file is in the stash");
        assert.equal(read("x.log"), "ignored\n", "ignored files are left alone");
        const status = await gitCall("status");
        assert.deepEqual([status.branch, status.previousBranch, status.files.length], [null, "main", 0]);
        assert.match(status.stash.message, /^pilotswarm: before checking out/);
        assert.equal(events.at(-1).data.op, "git");
        assert.deepEqual(events.at(-1).data.git, { action: "checkout", to: first.slice(0, 7), from: "main", detached: true, stashed: true });
    });

    it("back to the branch, then the stashed changes come back", async () => {
        const back = await gitCall("checkout", { branch: "main" });
        assert.deepEqual([back.done, back.detached, back.stashed], [true, false, false]);
        assert.equal(read("a.txt"), "2\n");
        const restored = await gitCall("restore");
        assert.equal(restored.done, true);
        assert.equal(read("a.txt"), "3\n");
        assert.equal(read("u.txt"), "untracked\n");
        const status = await gitCall("status");
        assert.deepEqual([status.branch, status.stash], ["main", null]);
        assert.equal((await gitCall("restore")).done, false, "nothing left to restore");
    });

    it("refuses odd targets", async () => {
        await assert.rejects(gitCall("checkout", { branch: "--orphan" }), (e) => e.code === W.PATH_INVALID);
        await assert.rejects(gitCall("checkout", { branch: "nope" }), (e) => e.code === W.NOT_FOUND);
        await assert.rejects(gitCall("checkout", { sha: "HEAD~1" }), (e) => e.code === W.PATH_INVALID);
        await assert.rejects(gitCall("checkout", {}), (e) => e.code === W.PATH_INVALID);
    });

    it("the agent's next-turn note says what happened", async () => {
        const { workspaceFileChangesNote } = await import("../../dist/workspace-files.js");
        const note = workspaceFileChangesNote([
            { op: "git", folder: "repo", path: "", git: { action: "checkout", to: "abc1234", from: "main", detached: true, stashed: true } },
            { op: "git", folder: "repo", path: "", git: { action: "restore" } },
        ]);
        assert.match(note, /checked out commit abc1234 in repo \(detached HEAD; it was on main\); their uncommitted changes are stashed/);
        assert.match(note, /put their stashed changes back in repo/);
    });
});
