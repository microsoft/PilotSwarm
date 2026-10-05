/**
 * The reference deployment's phase 3 pieces (docs/proposals/session-workspaces.md,
 * section 12.1): a repo mirrored from an upstream with a sandbox remote that
 * takes the sessions' pushes, the node attacher, and plain roots with a
 * marker check.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRepoService } from "../../examples/repo-workspaces/repo-service.mjs";
import { SANDBOX_PRE_RECEIVE_MESSAGES } from "../../examples/repo-workspaces/sandbox-remote.mjs";
import { callAttacher, createAttacher, DEFAULT_MOUNT_OPTIONS, isMountedAt, mountAtStart, parseAttacherRoots } from "../../examples/repo-workspaces/attacher.mjs";
import { createPlainRootProvider } from "../../examples/repo-workspaces/provider.mjs";
import { createWorkspaceProvider } from "../../examples/repo-workspaces/index.mjs";
import { createGitFixture, git, tryGit } from "../helpers/git-fixture.mjs";

const REQ = { sessionId: "s1", rootSessionId: "s1", revision: 1, workerNodeId: "worker-a", turnIndex: 1 };

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

describe("a repo mirrored from an upstream, with a sandbox remote", () => {
    let fixture;
    let root;
    let service;
    let base;
    before(async () => {
        fixture = await createGitFixture();
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-sandbox-root-")));
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        service = createRepoService({
            root,
            rootName: "a",
            publicUrl: base,
            repos: { app: { upstream: fixture.remote, sandbox: true } },
            runGit: (args) => git(args),
        });
        await service.prepare();
        await service.listen(port);
    });
    after(async () => {
        await service?.close();
        await fixture?.cleanup();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const call = async (method, pathname, body) => {
        const response = await fetch(new URL(pathname, base), { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
        return response.json();
    };
    const withToken = async () => {
        const url = new URL(`${base}/git/app.git`);
        const answer = await call("POST", "/v1/token", { protocol: "http", host: url.host, path: url.pathname.slice(1) });
        assert.ok(answer.password, `a token for the sandbox: ${JSON.stringify(answer)}`);
        url.username = answer.username;
        url.password = answer.password;
        return url.toString();
    };

    it("prepare mirrors the upstream and makes a sandbox with the mirror's branches; clones use the sandbox as origin", async () => {
        const upstreamMain = await git(["-C", fixture.remote, "rev-parse", "refs/heads/main"]);
        assert.equal(await git(["-C", path.join(root, "repos", "app.git"), "rev-parse", "refs/heads/main"]), upstreamMain);
        assert.equal(await git(["-C", path.join(root, "remotes", "app.git"), "rev-parse", "refs/heads/main"]), upstreamMain);
        const made = await call("POST", "/v1/clones", { rootSessionId: "tree-1", repo: "app" });
        assert.equal(made.workspace.folder, "sessions/tree-1/app");
        assert.equal(await git(["-C", made.path, "remote", "get-url", "origin"]), `${base}/git/app.git`);
        // The clone checks out the upstream's default branch: the mirror's
        // HEAD follows the upstream, whatever `git init` named.
        assert.equal(await git(["-C", made.path, "rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert.equal(await git(["-C", made.path, "rev-parse", "HEAD"]), upstreamMain);
    });

    it("a token is minted only for the sandbox; a push needs it; a new branch is taken, main is refused", async () => {
        const made = await call("POST", "/v1/clones", { rootSessionId: "tree-2", repo: "app" });
        const clone = made.path;
        assert.deepEqual(await call("POST", "/v1/token", { protocol: "https", host: "github.com", path: "someone/else" }), {}, "no token for any other remote");
        await git(["-C", clone, "switch", "-q", "-c", "agent/fix-1"]);
        fs.writeFileSync(path.join(clone, "fix.txt"), "fix\n");
        await git(["-C", clone, "add", "fix.txt"]);
        await git(["-C", clone, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-q", "-m", "fix"]);

        const anonymous = await tryGit(["-C", clone, "push", "-q", `${base}/git/app.git`, "HEAD:refs/heads/agent/fix-1"]);
        assert.equal(anonymous.ok, false, "a push without a token fails");

        const authed = await withToken();
        const pushed = await tryGit(["-C", clone, "push", "-q", authed, "HEAD:refs/heads/agent/fix-1"]);
        assert.equal(pushed.ok, true, pushed.stderr);
        assert.equal(await git(["-C", path.join(root, "remotes", "app.git"), "rev-parse", "refs/heads/agent/fix-1"]), await git(["-C", clone, "rev-parse", "HEAD"]));

        const toMain = await tryGit(["-C", clone, "push", "-q", authed, "HEAD:refs/heads/main"]);
        assert.equal(toMain.ok, false);
        assert.match(toMain.stderr, new RegExp(SANDBOX_PRE_RECEIVE_MESSAGES.protectedBranch));
    });

    it("refresh brings the sandbox's main up to the upstream and leaves the sessions' branches alone", async () => {
        const moved = await fixture.pushUpstream({ branch: "main" });
        await service.refresh();
        assert.equal(await git(["-C", path.join(root, "repos", "app.git"), "rev-parse", "refs/heads/main"]), moved);
        assert.equal(await git(["-C", path.join(root, "remotes", "app.git"), "rev-parse", "refs/heads/main"]), moved);
        assert.ok(await git(["-C", path.join(root, "remotes", "app.git"), "rev-parse", "--verify", "refs/heads/agent/fix-1"]), "the pushed branch stays");
    });

    it("the sandbox's hook cannot be changed by a session: it is rewritten at prepare", async () => {
        const hook = path.join(root, "remotes", "app.git", "hooks", "pre-receive");
        fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n");
        await service.prepare();
        assert.match(fs.readFileSync(hook, "utf8"), /sandbox-pre-receive/);
    });
});

describe("a service that already runs as the clone uid (a laptop run)", () => {
    it("makes a clone without switching users, so it needs no setpriv (macOS has none)", { skip: process.platform === "win32" && "Windows has no Unix uid" }, async () => {
        const fixture = await createGitFixture();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-own-uid-root-")));
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        // No runGit: the service's own runner, as `node repo-service.mjs` uses it.
        const service = createRepoService({
            root,
            rootName: "a",
            publicUrl: base,
            repos: { app: { upstream: fixture.remote, sandbox: true } },
            cloneUid: process.getuid(),
        });
        try {
            await service.prepare();
            await service.listen(port);
            const response = await fetch(new URL("/v1/clones", base), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ rootSessionId: "tree-own", repo: "app" }),
            });
            const made = await response.json();
            assert.equal(made.workspace?.folder, "sessions/tree-own/app", JSON.stringify(made));
            assert.equal(await git(["-C", made.path, "rev-parse", "HEAD"]), await git(["-C", fixture.remote, "rev-parse", "refs/heads/main"]));
        } finally {
            await service.close();
            await fixture.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("a clone made as another uid than the mirror's owner", () => {
    // On the repo pod the service owns the mirror and the clone runs as the
    // session uid. Git 2.45.1 to 2.47 (the pod has Debian's 2.47) refuses a
    // local clone of another uid's repository ("dubious ownership"); found on a
    // real two-uid run. Newer git allows it. GIT_TEST_ASSUME_DIFFERENT_OWNER
    // makes git treat every repository as another uid's.
    let fixture;
    let root;
    let service;
    let base;
    const calls = [];
    const knob = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
    before(async () => {
        fixture = await createGitFixture();
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-owner-root-")));
        service = createRepoService({
            root,
            rootName: "a",
            repos: { app: { remote: fixture.remote } },
            runGit: (args) => {
                calls.push(args);
                return git(args, args.includes("clone") ? { env: knob } : {});
            },
        });
        base = await service.listen(0);
    });
    after(async () => {
        await service?.close();
        await fixture?.cleanup();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const makeClone = async (rootSessionId) => {
        const response = await fetch(new URL("/v1/clones", base), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rootSessionId, repo: "app" }),
        });
        const made = await response.json();
        assert.equal(response.status, 200, JSON.stringify(made));
        return made;
    };

    it("the exception goes to the upload-pack that reads the mirror, names only that mirror, and is written nowhere", async () => {
        const made = await makeClone("tree-1");
        const mirror = path.join(root, "repos", "app.git");
        const clone = calls.find((args) => args.includes("clone"));
        assert.ok(clone.includes(`--upload-pack=git -c 'safe.directory=${mirror}' upload-pack`), JSON.stringify(clone));
        assert.equal(await git(["-C", made.path, "rev-parse", "HEAD"]), await git(["-C", fixture.remote, "rev-parse", "refs/heads/main"]));
        const own = await tryGit(["-C", made.path, "config", "--get-all", "safe.directory"]);
        assert.equal(own.stdout.trim(), "", "the clone's own config has no exception");
    });

    it("with a git that refuses another uid's repository, the clone still works", async (t) => {
        // Only where this git refuses: a plain clone of the mirror must fail first.
        const mirror = path.join(root, "repos", "app.git");
        const probe = path.join(root, "probe");
        const plain = await tryGit(["clone", "-q", "--shared", mirror, probe], { env: knob });
        fs.rmSync(probe, { recursive: true, force: true });
        if (plain.ok) {
            t.skip(`${(await git(["--version"]))} lets a local clone read another uid's repository; the repo pod's git 2.47 does not`);
            return;
        }
        assert.match(plain.stderr, /dubious ownership/);
        const made = await makeClone("tree-2");
        assert.equal(made.created, true);
    });
});

describe("the node attacher", () => {
    it("mounts with the proposal's options plus nosharecache, so a remount after ESTALE gets a new kernel instance", () => {
        // Checked on a real kernel: with sharecache, a remount while a process
        // still held the old mount reused the old instance (same device number).
        assert.deepEqual(DEFAULT_MOUNT_OPTIONS.split(","), [
            "nfsvers=4.1", "hard", "timeo=600", "retrans=2", "actimeo=3", "lookupcache=positive", "nconnect=4", "nosharecache",
        ]);
    });

    it("parses its roots and refuses bad ones", () => {
        assert.deepEqual(parseAttacherRoots("a=nfs.svc:/ws/a, shared=10.0.0.5:/ws/shared"), [
            { name: "a", server: "nfs.svc", exportPath: "/ws/a" },
            { name: "shared", server: "10.0.0.5", exportPath: "/ws/shared" },
        ]);
        assert.throws(() => parseAttacherRoots("a=nfs.svc"), /name=server:\/export/);
        assert.throws(() => parseAttacherRoots("a=nfs.svc:ws/a"), /absolute/);
        assert.throws(() => parseAttacherRoots("../x=nfs:/ws"), /bad root name/);
    });

    it("reads mount points from mountinfo, octal escapes included", { skip: process.platform === "win32" && "mountinfo paths are Linux-specific" }, () => {
        const info = [
            "36 35 98:0 / /mnt/ps/a rw,noatime master:1 - nfs4 10.0.0.5:/ws/a rw",
            "37 35 98:0 / /mnt/ps/with\\040space rw - nfs4 10.0.0.5:/ws/b rw",
        ].join("\n");
        assert.equal(isMountedAt("/mnt/ps/a", info), true);
        assert.equal(isMountedAt("/mnt/ps/a/", info), true);
        assert.equal(isMountedAt("/mnt/ps/with space", info), true);
        assert.equal(isMountedAt("/mnt/ps/shared", info), false);
        assert.equal(isMountedAt("/mnt/ps", info), false);
    });

    it("mounts a known root once, even when two ask at once; remounts lazily; refuses an unknown root", async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "ps-attacher-"));
        const calls = [];
        let mountinfo = "";
        const attacher = createAttacher({
            roots: [{ name: "a", server: "nfs.svc", exportPath: "/ws/a" }],
            mountBase: base,
            mountOptions: "nfsvers=4.1,hard",
            resolveHost: async () => "10.0.0.5",
            readMountinfo: () => mountinfo,
            log: () => {},
            run: async (command, args) => {
                calls.push([command, ...args]);
                if (command === "mount") mountinfo += `1 1 0:0 / ${args.at(-1)} rw - nfs4 ${args.at(-2)} rw\n`;
                if (command === "umount") mountinfo = "";
                return "";
            },
        });
        try {
            const [first, second] = await Promise.all([attacher.mount("a"), attacher.mount("a")]);
            assert.deepEqual(first, { root: "a", path: path.join(base, "a"), mounted: true });
            assert.deepEqual(second, first);
            assert.deepEqual(calls, [["mount", "-t", "nfs4", "-o", "nfsvers=4.1,hard", "10.0.0.5:/ws/a", path.join(base, "a")]], "one mount for two asks");
            await attacher.remount("a");
            assert.deepEqual(calls.slice(1).map((c) => c.slice(0, 2)), [["umount", "-l"], ["mount", "-t"]]);
            await assert.rejects(() => attacher.mount("b"), /unknown root "b"/);
            assert.deepEqual(attacher.status().roots, [{ root: "a", path: path.join(base, "a"), mounted: true }]);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("at start, keeps retrying a root whose server is not there yet, until it is mounted", async () => {
        // Seen on the stamp: the attachers started with the workers, before
        // the repo pod's service existed, and gave up after one try.
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "ps-attacher-start-"));
        let mountinfo = "";
        let lookups = 0;
        const attacher = createAttacher({
            roots: [{ name: "a", server: "repo-cache.svc", exportPath: "/ws/a" }, { name: "shared", server: "10.0.0.5", exportPath: "/ws/shared" }],
            mountBase: base,
            mountOptions: "nfsvers=4.1",
            readMountinfo: () => mountinfo,
            log: () => {},
            // The service name resolves only on the third try.
            resolveHost: async (host) => {
                if (host !== "repo-cache.svc") return host;
                lookups += 1;
                if (lookups < 3) throw new Error("getaddrinfo ENOTFOUND repo-cache.svc");
                return "10.0.0.9";
            },
            run: async (command, args) => {
                if (command === "mount") mountinfo += `1 1 0:0 / ${args.at(-1)} rw - nfs4 ${args.at(-2)} rw\n`;
                return "";
            },
        });
        const started = mountAtStart(attacher, ["a", "shared"], { intervalMs: 20, log: () => {} });
        try {
            await started.done;
            assert.deepEqual([...started.pending], ["a"], "shared mounted in the first round; a not yet");
            const deadline = Date.now() + 2_000;
            while (started.pending.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
            assert.equal(started.pending.size, 0, "a was mounted by a later round");
            assert.equal(lookups, 3);
            assert.deepEqual(attacher.status().roots.map((root) => root.mounted), [true, true]);
        } finally {
            started.stop();
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it("answers over its unix socket: mount, status, and a refusal for an unknown root", { skip: process.platform === "win32" && "requires Unix domain socket paths" }, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-attacher-sock-"));
        const socket = path.join(dir, "sock");
        let mountinfo = "";
        const attacher = createAttacher({
            roots: [{ name: "shared", server: "10.0.0.5", exportPath: "/ws/shared" }],
            mountBase: path.join(dir, "mnt"),
            readMountinfo: () => mountinfo,
            log: () => {},
            run: async (command, args) => {
                if (command === "mount") mountinfo += `1 1 0:0 / ${args.at(-1)} rw - nfs4 x rw\n`;
                return "";
            },
        });
        await new Promise((resolve) => attacher.server.listen(socket, resolve));
        try {
            assert.deepEqual(await callAttacher(socket, "POST", "/mount", { root: "shared" }), { root: "shared", path: path.join(dir, "mnt", "shared"), mounted: true });
            assert.equal((await callAttacher(socket, "GET", "/status")).roots[0].mounted, true);
            await assert.rejects(() => callAttacher(socket, "POST", "/mount", { root: "etc" }), /unknown root "etc"/);
            await assert.rejects(() => callAttacher(socket, "POST", "/unmount", { root: "shared" }), /not found/, "there is no unmount call");
        } finally {
            await new Promise((resolve) => attacher.server.close(resolve));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("plain roots with a marker check", () => {
    let base;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-plain-")));
        fs.mkdirSync(path.join(base, "shared", "notes"), { recursive: true });
        fs.mkdirSync(path.join(base, "unmounted"), { recursive: true });
        fs.writeFileSync(path.join(base, "shared", ".pilotswarm-export"), "");
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it("needs the marker: an empty mount point is not a mount, and a session must not write into it", async () => {
        const provider = createPlainRootProvider({ roots: [{ name: "shared", path: path.join(base, "shared") }, { name: "bare", path: path.join(base, "unmounted") }] });
        assert.deepEqual(await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "shared", folder: "notes" } }), { ok: true, path: path.join(base, "shared", "notes") });
        const bare = await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "bare" } });
        assert.equal(bare.code, "WORKSPACE_NOT_MOUNTED");
        assert.equal(bare.retryAfterMs, 30_000);
        const missing = await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "shared", folder: "nope" } });
        assert.equal(missing.code, "WORKSPACE_FOLDER_MISSING");
        assert.equal("release" in provider, false, "nothing to release: no leases");
    });

    it("asks the attacher when the root is not mounted in this pod, and reports a failed attach", async () => {
        const asked = [];
        const provider = createPlainRootProvider({
            roots: [{ name: "shared", path: path.join(base, "shared") }],
            isMounted: () => false,
            attach: async (root) => { asked.push(root.name); },
        });
        assert.equal((await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "shared" } })).ok, true);
        assert.deepEqual(asked, ["shared"]);
        const failing = createPlainRootProvider({
            roots: [{ name: "shared", path: path.join(base, "shared") }],
            isMounted: () => false,
            attach: async () => { throw new Error("socket gone"); },
        });
        const failed = await failing.ensureAttached({ ...REQ, workspace: { schema: 1, root: "shared" } });
        assert.equal(failed.code, "WORKSPACE_ATTACH_FAILED");
        assert.match(failed.message, /socket gone/);
    });

    it("the example serves plain roots through it, so a missing marker holds the folder", async () => {
        const provider = createWorkspaceProvider({
            roots: [{ name: "a", path: "/ws/a-not-here" }],
            serviceUrls: { a: "http://127.0.0.1:9" },
            plainRoots: [{ name: "bare", path: path.join(base, "unmounted") }],
        });
        const bare = await provider.ensureAttached({ ...REQ, workspace: { schema: 1, root: "bare" }, attachment: "bare" });
        assert.equal(bare.code, "WORKSPACE_NOT_MOUNTED");
    });
});
