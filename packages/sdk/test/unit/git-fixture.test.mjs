// Proves the session-workspaces git fixtures work, and runs the proposal's
// fixture checks (section 9, "Git dev-box": G1, G2 fixture half, G5, G7).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createGitFixture, git, tryGit, countObjects, PRE_RECEIVE_MESSAGES, MCP_CONFIG_FILES, mcpServerName } from "../helpers/git-fixture.mjs";
import { startGitTokenServer } from "../helpers/git-token-server.mjs";

async function commitFile(clone, rel, content, message = `change ${rel}`) {
    fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    fs.writeFileSync(path.join(clone, rel), content);
    await git(["-C", clone, "add", "-A"]);
    await git(["-C", clone, "commit", "-q", "-m", message]);
    return git(["-C", clone, "rev-parse", "HEAD"]);
}

async function fsck(repo) {
    return tryGit(["-C", repo, "fsck", "--full"]);
}

describe("fixture content", () => {
    let fixture, clone;
    before(async () => {
        fixture = await createGitFixture();
        clone = await fixture.cloneSession({ rootSessionId: "root-content" });
    });
    after(async () => { await fixture?.cleanup(); });

    it("has the section 5.1 layout", () => {
        for (const dir of ["repos", "sessions", "remotes"]) assert.ok(fs.statSync(path.join(fixture.root, dir)).isDirectory(), dir);
        assert.equal(fixture.mirror, path.join(fixture.root, "repos", "app.git"));
        assert.equal(fixture.remote, path.join(fixture.root, "remotes", "app.git"));
        assert.equal(clone, path.join(fixture.root, "sessions", "root-content", "app"));
    });

    it("checks out the repo agent, skill, hook, instructions and MCP files", () => {
        const agent = fs.readFileSync(path.join(clone, ".github/agents/reviewer.agent.md"), "utf8");
        assert.match(agent, /^---\nname: reviewer\ndescription: .+\ntools: \["read", "search"\]\n---\n\n\S/);
        assert.match(fs.readFileSync(path.join(clone, ".github/skills/build/SKILL.md"), "utf8"), /^---\nname: build\ndescription: .+\n---\n/);
        const hooks = JSON.parse(fs.readFileSync(path.join(clone, ".github/hooks/fixture-marker.json"), "utf8"));
        assert.equal(hooks.version, 1);
        assert.ok(hooks.hooks.userPromptSubmitted[0].bash.includes(fixture.markers.hook));
        assert.ok(fs.readFileSync(path.join(clone, "AGENTS.md"), "utf8").includes(fixture.agentsMarker));
        for (const file of MCP_CONFIG_FILES) {
            const config = JSON.parse(fs.readFileSync(path.join(clone, file), "utf8"));
            const servers = file === ".vscode/mcp.json" ? config.servers : config.mcpServers;
            assert.deepEqual(Object.keys(servers), [mcpServerName(file)], file);
            assert.ok(servers[mcpServerName(file)].args.join(" ").includes(fixture.markers.mcp), file);
        }
        assert.equal(new Set(MCP_CONFIG_FILES.map(mcpServerName)).size, MCP_CONFIG_FILES.length, "server names are distinct");
        assert.ok(fs.existsSync(path.join(clone, "README.md")));
    });

    it("builds the mirror with the production fetch and gc settings, pruning deleted branches", async () => {
        const config = key => git(["-C", fixture.mirror, "config", "--get-all", key]);
        assert.equal(await config("remote.origin.fetch"), "+refs/heads/*:refs/heads/*\n+refs/tags/*:refs/tags/*");
        assert.equal(await config("gc.auto"), "0");
        assert.equal(await config("maintenance.auto"), "false");
        assert.equal(await config("gc.pruneExpire"), "never");
        assert.equal(await git(["-C", fixture.mirror, "rev-parse", "release/1"]), fixture.commits.initial);

        await fixture.pushUpstream({ branch: "feature/short-lived" });
        await fixture.fetchMirror();
        assert.ok((await tryGit(["-C", fixture.mirror, "rev-parse", "--verify", "-q", "refs/heads/feature/short-lived"])).ok);
        await git(["-C", fixture.remote, "update-ref", "-d", "refs/heads/feature/short-lived"]);
        await fixture.fetchMirror();
        assert.equal((await tryGit(["-C", fixture.mirror, "rev-parse", "--verify", "-q", "refs/heads/feature/short-lived"])).ok, false);
    });

    it("exposes absolute marker paths inside the fixture that do not exist yet", () => {
        for (const marker of Object.values(fixture.markers)) {
            assert.ok(path.isAbsolute(marker));
            assert.ok(marker.startsWith(fixture.root + path.sep));
            assert.equal(fs.existsSync(marker), false, marker);
        }
    });

    it("each MCP command really appends its file name to the marker when something runs it", async () => {
        // Guards the "marker does NOT exist" assertions later tests make: they
        // mean nothing if the commands could never create the file.
        const probe = await createGitFixture();
        try {
            const probeClone = await probe.cloneSession({ rootSessionId: "probe" });
            for (const file of MCP_CONFIG_FILES) {
                const config = JSON.parse(fs.readFileSync(path.join(probeClone, file), "utf8"));
                const server = (config.mcpServers ?? config.servers)[mcpServerName(file)];
                execFileSync(server.command, server.args);
            }
            assert.deepEqual(fs.readFileSync(probe.markers.mcp, "utf8").trim().split("\n"), [...MCP_CONFIG_FILES]);
        } finally { await probe.cleanup(); }
    });

    it("each hook command really appends its event name to the marker when something runs it", async () => {
        const probe = await createGitFixture();
        try {
            const probeClone = await probe.cloneSession({ rootSessionId: "probe" });
            const { hooks } = JSON.parse(fs.readFileSync(path.join(probeClone, ".github/hooks/fixture-marker.json"), "utf8"));
            const events = Object.keys(hooks);
            assert.deepEqual(events.sort(), ["sessionStart", "userPromptSubmitted"]);
            for (const event of events) execFileSync("bash", ["-c", hooks[event][0].bash]);
            assert.deepEqual(fs.readFileSync(probe.markers.hook, "utf8").trim().split("\n"), events);
        } finally { await probe.cleanup(); }
    });
});

describe("relative alternates", () => {
    it("writes a relative alternates path and survives moving the whole root", async () => {
        const fixture = await createGitFixture();
        let root = fixture.root;
        const moved = `${fixture.root}-moved`;
        try {
            const clone = await fixture.cloneSession({ rootSessionId: "root-move" });
            const alternates = fs.readFileSync(path.join(clone, ".git/objects/info/alternates"), "utf8").trim();
            assert.equal(alternates, path.join("..", "..", "..", "..", "..", "repos", "app.git", "objects"));
            assert.equal(await git(["-C", clone, "remote", "get-url", "origin"]), fixture.remote);
            // Objects come only from the mirror: the clone owns none.
            assert.equal((await countObjects(clone)).total, 0);
            await commitFile(clone, "notes/before-move.txt", "x\n");

            fs.renameSync(fixture.root, moved);
            root = moved;
            const movedClone = path.join(moved, "sessions", "root-move", "app");
            const result = await fsck(movedClone);
            assert.ok(result.ok, result.stderr);
            assert.match(await git(["-C", movedClone, "log", "--oneline", "-n", "2"]), /initial fixture content/);
            await commitFile(movedClone, "notes/after-move.txt", "y\n");
        } finally {
            if (root === moved) {
                try { fs.renameSync(moved, fixture.root); } catch { fs.rmSync(moved, { recursive: true, force: true }); }
            }
            await fixture.cleanup();
        }
    });
});

describe("G1: two session clones of one mirror do not interfere (fixture check)", () => {
    let fixture;
    before(async () => { fixture = await createGitFixture(); });
    after(async () => { await fixture?.cleanup(); });

    it("both check out main, create the same branch name and stash independently", async () => {
        const a = await fixture.cloneSession({ rootSessionId: "root-a" });
        const b = await fixture.cloneSession({ rootSessionId: "root-b" });
        for (const clone of [a, b]) {
            assert.equal(await git(["-C", clone, "rev-parse", "--abbrev-ref", "HEAD"]), "main");
            await git(["-C", clone, "checkout", "-q", "-b", "agent/same"]);
        }
        const tipA = await commitFile(a, "a.txt", "from a\n", "commit in a");
        const tipB = await commitFile(b, "b.txt", "from b\n", "commit in b");
        assert.notEqual(tipA, tipB);

        fs.writeFileSync(path.join(a, "README.md"), "stash from a\n");
        await git(["-C", a, "stash", "push", "-q", "-m", "stash-in-a"]);
        fs.writeFileSync(path.join(b, "README.md"), "stash from b\n");
        await git(["-C", b, "stash", "push", "-q", "-m", "stash-in-b"]);

        const stashA = await git(["-C", a, "stash", "list"]);
        const stashB = await git(["-C", b, "stash", "list"]);
        assert.match(stashA, /stash-in-a/); assert.doesNotMatch(stashA, /stash-in-b/);
        assert.match(stashB, /stash-in-b/); assert.doesNotMatch(stashB, /stash-in-a/);
        assert.equal(stashA.split("\n").length, 1);

        assert.equal(await git(["-C", a, "rev-parse", "agent/same"]), tipA);
        assert.equal(await git(["-C", b, "rev-parse", "agent/same"]), tipB);
        assert.equal(await git(["-C", a, "cat-file", "-t", tipB]).catch(() => "missing"), "missing");

        // Nothing leaked into the shared mirror.
        assert.equal((await tryGit(["-C", fixture.mirror, "rev-parse", "--verify", "-q", "refs/heads/agent/same"])).ok, false);
        assert.equal((await tryGit(["-C", fixture.mirror, "rev-parse", "--verify", "-q", "refs/stash"])).ok, false);
    });
});

describe("G5: a session clone fetches nothing the mirror already has (fixture check)", () => {
    let fixture;
    before(async () => { fixture = await createGitFixture(); });
    after(async () => { await fixture?.cleanup(); });

    it("downloads zero objects with alternates and all of them without", async () => {
        const shared = await fixture.cloneSession({ rootSessionId: "root-shared" });
        const plain = await fixture.cloneSession({ rootSessionId: "root-plain", shared: false });
        const sharedBefore = await countObjects(shared);
        const plainBefore = await countObjects(plain);
        assert.equal(sharedBefore.total, 0);
        assert.ok(plainBefore.total > 0);

        const files = {};
        for (let i = 0; i < 5; i++) files[`new/${i}.txt`] = `${randomBytes(16).toString("hex")}\n`;
        const tip = await fixture.pushUpstream({ branch: "main", files, message: "new upstream work" });
        await fixture.fetchMirror();

        await git(["-C", shared, "fetch", "-q", "origin"]);
        await git(["-C", plain, "fetch", "-q", "origin"]);
        assert.equal(await git(["-C", shared, "rev-parse", "origin/main"]), tip);
        assert.equal(await git(["-C", plain, "rev-parse", "origin/main"]), tip);

        assert.deepEqual(await countObjects(shared), sharedBefore);
        // 1 commit + 2 trees (root, new/) + 5 blobs.
        assert.equal((await countObjects(plain)).total - plainBefore.total, 8);
    });
});

describe("G2 (fixture half): mirror maintenance after an upstream force push", () => {
    // Expected broken layouts per command, from proposal section 5.1.
    const commands = [
        { args: ["gc"], breaks: [] },
        { args: ["maintenance", "run"], breaks: [] },
        { args: ["repack", "-A", "-d"], breaks: [] },
        { args: ["repack", "--cruft", "-d"], breaks: [] },
        { args: ["repack", "-a", "-d", "-k"], breaks: [] },
        { args: ["prune", "--expire=now"], breaks: ["loose"] },
        { args: ["gc", "--prune=now"], breaks: ["loose", "packed"] },
        { args: ["repack", "-a", "-d"], breaks: ["packed"] },
    ];

    for (const layout of ["loose", "packed"]) {
        describe(`${layout} layout`, { concurrency: true }, () => {
            for (const { args, breaks } of commands) {
                const expectBroken = breaks.includes(layout);
                it(`git ${args.join(" ")} ${expectBroken ? "breaks" : "keeps"} the session clones`, async () => {
                    const fixture = await createGitFixture({ layout });
                    try {
                        const plainClone = await fixture.cloneSession({ rootSessionId: "root-plain" });
                        let dependent;
                        const { commit, objects } = await fixture.createUnreachableObjects({
                            prepare: async sha => {
                                dependent = await fixture.cloneSession({ rootSessionId: "root-dependent" });
                                await git(["-C", dependent, "checkout", "-q", "-b", "agent/on-old", sha]);
                                await commitFile(dependent, "agent.txt", "work on top of the old upstream commit\n");
                                // The clone also inherited a remote-tracking ref to the old
                                // commit. Drop it, so the only thing that needs the mirror's
                                // unreachable objects is the agent's own branch.
                                await git(["-C", dependent, "update-ref", "-d", "refs/remotes/origin/feature/unreachable"]);
                            },
                        });
                        // The setup is what the test claims: unreachable, still present, in this layout.
                        assert.doesNotMatch(await git(["-C", fixture.mirror, "rev-list", "--all"]), new RegExp(commit));
                        for (const sha of objects) {
                            assert.ok((await tryGit(["-C", fixture.mirror, "cat-file", "-e", sha])).ok, sha);
                            const loose = fs.existsSync(path.join(fixture.mirror, "objects", sha.slice(0, 2), sha.slice(2)));
                            assert.equal(loose, layout === "loose", `${sha} loose=${loose}`);
                        }
                        for (const clone of [plainClone, dependent]) {
                            const clean = await fsck(clone);
                            assert.ok(clean.ok, clean.stderr);
                        }

                        await git(["-C", fixture.mirror, ...args]);

                        assert.ok((await fsck(plainClone)).ok, "a clone that only uses reachable objects stays clean");
                        const result = await fsck(dependent);
                        if (expectBroken) {
                            assert.equal(result.ok, false, "forbidden command should break the dependent clone");
                            assert.match(result.stderr, /invalid sha1 pointer|missing (commit|tree|blob)/);
                        } else {
                            assert.ok(result.ok, result.stderr);
                        }
                    } finally { await fixture.cleanup(); }
                });
            }
        });
    }
});

describe("G7 (simulated): read-only mirror", () => {
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const skip = process.platform === "win32"
        ? "Windows does not enforce Unix chmod-based read-only directory semantics"
        : isRoot ? "running as root: root ignores file permissions, so this cannot fail" : false;
    let fixture;
    before(async () => { fixture = await createGitFixture(); });
    after(async () => { await fixture?.cleanup(); });

    it("blocks deletes and fetches in the mirror while clones still commit", { skip }, async () => {
        const clone = await fixture.cloneSession({ rootSessionId: "root-ro" });
        await fixture.pushUpstream({ branch: "main", message: "upstream commit the mirror cannot fetch" });
        await fixture.setMirrorReadOnly(true);
        try {
            assert.throws(() => fs.unlinkSync(path.join(fixture.mirror, "config")), err => ["EACCES", "EPERM"].includes(err.code));
            assert.throws(() => fs.rmSync(fixture.mirror, { recursive: true }), err => ["EACCES", "EPERM"].includes(err.code));
            assert.throws(() => fs.renameSync(fixture.mirror, `${fixture.mirror}.moved`), err => ["EACCES", "EPERM"].includes(err.code));
            assert.throws(() => fs.writeFileSync(path.join(fixture.mirror, "objects", "new-file"), "x"), err => ["EACCES", "EPERM"].includes(err.code));
            assert.ok(fs.existsSync(path.join(fixture.mirror, "config")));

            const fetch = await tryGit(["-C", fixture.mirror, "fetch", "--prune", "origin"]);
            assert.equal(fetch.ok, false, "fetch inside a read-only mirror must fail");

            await commitFile(clone, "ro/commit.txt", "committed with a read-only mirror\n");
            const result = await fsck(clone);
            assert.ok(result.ok, result.stderr);
        } finally {
            await fixture.setMirrorReadOnly(false);
        }
        // Write access is back: the repo service can fetch again.
        await fixture.fetchMirror();
    });
});

describe("pre-receive rules on the bare remote", () => {
    let fixture, clone;
    before(async () => {
        fixture = await createGitFixture();
        clone = await fixture.cloneSession({ rootSessionId: "root-push" });
    });
    after(async () => { await fixture?.cleanup(); });

    async function push(args) {
        return tryGit(["-C", clone, "push", "origin", ...args]);
    }

    it("rejects a push to main", async () => {
        await commitFile(clone, "p/main.txt", "main\n");
        const result = await push(["HEAD:refs/heads/main"]);
        assert.equal(result.ok, false);
        assert.ok(result.stderr.includes(`${PRE_RECEIVE_MESSAGES.protectedBranch}: refs/heads/main`), result.stderr);
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "main"]), fixture.commits.initial);
    });

    it("rejects a push to release/1", async () => {
        const result = await push(["HEAD:refs/heads/release/1"]);
        assert.equal(result.ok, false);
        assert.ok(result.stderr.includes(`${PRE_RECEIVE_MESSAGES.protectedBranch}: refs/heads/release/1`), result.stderr);
    });

    it("accepts a normal push to a new branch agent/x", async () => {
        const tip = await git(["-C", clone, "rev-parse", "HEAD"]);
        const result = await push(["HEAD:refs/heads/agent/x"]);
        assert.ok(result.ok, result.stderr);
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "refs/heads/agent/x"]), tip);
    });

    it("rejects a force push to a feature branch", async () => {
        await git(["-C", clone, "checkout", "-q", "-b", "agent/force"]);
        await commitFile(clone, "p/force.txt", "first\n");
        assert.ok((await push(["HEAD:refs/heads/agent/force"])).ok);
        const pushed = await git(["-C", clone, "rev-parse", "HEAD"]);
        await git(["-C", clone, "commit", "-q", "--amend", "-m", "rewritten"]);
        const result = await push(["--force", "HEAD:refs/heads/agent/force"]);
        assert.equal(result.ok, false);
        assert.ok(result.stderr.includes(`${PRE_RECEIVE_MESSAGES.nonFastForward}: refs/heads/agent/force`), result.stderr);
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "refs/heads/agent/force"]), pushed);
    });

    it("rejects deleting a branch", async () => {
        const result = await push([":refs/heads/agent/x"]);
        assert.equal(result.ok, false);
        assert.ok(result.stderr.includes(`${PRE_RECEIVE_MESSAGES.deletion}: refs/heads/agent/x`), result.stderr);
        assert.ok((await tryGit(["-C", fixture.remote, "rev-parse", "--verify", "-q", "refs/heads/agent/x"])).ok);
    });

    it("rewriteUpstream moves a protected branch without running the hook", async () => {
        const target = await git(["-C", fixture.remote, "rev-parse", "refs/heads/agent/force"]);
        await fixture.rewriteUpstream({ branch: "main", toCommit: target });
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "main"]), target);
        await fixture.rewriteUpstream({ branch: "main", toCommit: fixture.commits.initial });
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "main"]), fixture.commits.initial);
    });
});

describe("token-protected git HTTP server: failures never crash it", () => {
    const auth = token => ({ Authorization: `Basic ${Buffer.from(`x-token:${token}`).toString("base64")}` });

    it("answers 400 to a bad percent-encoding and keeps serving", async () => {
        const fixture = await createGitFixture();
        const server = await startGitTokenServer({ projectRoot: fixture.root });
        try {
            const token = server.mintToken();
            const bad = await fetch(`${server.baseUrl}/%E0.git/info/refs`, { headers: auth(token) });
            assert.equal(bad.status, 400);
            const good = await fetch(`${server.baseUrl}/remotes/app.git/info/refs?service=git-upload-pack`, { headers: auth(token) });
            assert.equal(good.status, 200);
            await good.arrayBuffer();
        } finally { await server.close(); await fixture.cleanup(); }
    });

    it("answers 502 once when the backend cannot start, and keeps serving", async () => {
        const fixture = await createGitFixture();
        const server = await startGitTokenServer({ projectRoot: fixture.root, backendPath: path.join(fixture.root, "no-such-backend") });
        try {
            const token = server.mintToken();
            for (let i = 0; i < 2; i++) {
                const res = await fetch(`${server.baseUrl}/remotes/app.git/info/refs`, { headers: auth(token) });
                assert.equal(res.status, 502);
                assert.match(await res.text(), /ENOENT/);
            }
        } finally { await server.close(); await fixture.cleanup(); }
    });

    it("close() stops a backend that never answers", { skip: process.platform === "win32" && "requires executable shebang scripts" }, async () => {
        const fixture = await createGitFixture();
        const pidFile = path.join(fixture.root, "hung.pid");
        const script = path.join(fixture.root, "hung-backend.sh");
        fs.writeFileSync(script, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 60\n`, { mode: 0o755 });
        const server = await startGitTokenServer({ projectRoot: fixture.root, backendPath: script });
        try {
            const pending = fetch(`${server.baseUrl}/remotes/app.git/info/refs`, { headers: auth(server.mintToken()) }).catch(error => error);
            const deadline = Date.now() + 5_000;
            while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, "utf8").trim()) {
                assert.ok(Date.now() < deadline, "the backend never started");
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
            await server.close();
            await pending;
            const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
            const stopBy = Date.now() + 2_000;
            while (alive() && Date.now() < stopBy) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(alive(), false, "the hung backend is still running after close()");
        } finally { await server.close().catch(() => {}); await fixture.cleanup(); }
    });
});

describe("token-protected git HTTP server", () => {
    let fixture, server, clone, remoteUrl;
    before(async () => {
        fixture = await createGitFixture();
        server = await startGitTokenServer({ projectRoot: fixture.root });
        remoteUrl = opts => server.url("remotes/app.git", opts);
        clone = await fixture.cloneSession({ rootSessionId: "root-http", originUrl: server.url("remotes/app.git") });
    });
    after(async () => {
        await server?.close();
        await fixture?.cleanup();
    });

    function pushTo(url, refspec, extra = []) {
        return tryGit(["-C", clone, ...extra, "push", url, refspec]);
    }

    it("sets origin to the server URL", async () => {
        assert.equal(await git(["-C", clone, "remote", "get-url", "origin"]), server.url("remotes/app.git"));
    });

    it("pushes to agent/x with a minted token", async () => {
        await git(["-C", clone, "checkout", "-q", "-b", "agent/x"]);
        const tip = await commitFile(clone, "http/one.txt", "over http\n");
        const token = server.mintToken({ ttlMs: 60_000 });
        const result = await pushTo(remoteUrl({ token }), "HEAD:refs/heads/agent/x");
        assert.ok(result.ok, result.stderr);
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "refs/heads/agent/x"]), tip);
        assert.ok(server.log.some(e => e.path.endsWith("/git-receive-pack") && e.status === 200));
    });

    it("fails without a token or with a wrong one, and logs a 401", async () => {
        const before = server.log.length;
        await commitFile(clone, "http/two.txt", "rejected\n");
        const none = await pushTo(remoteUrl(), "HEAD:refs/heads/agent/x");
        assert.equal(none.ok, false);
        const wrong = await pushTo(remoteUrl({ token: "fixture_not-a-real-token" }), "HEAD:refs/heads/agent/x");
        assert.equal(wrong.ok, false);
        assert.match(wrong.stderr, /Authentication failed|401/);
        const fresh = server.log.slice(before);
        assert.ok(fresh.length >= 2 && fresh.every(e => e.status === 401), JSON.stringify(fresh));
        assert.notEqual(await git(["-C", fixture.remote, "rev-parse", "refs/heads/agent/x"]), await git(["-C", clone, "rev-parse", "HEAD"]));
    });

    it("runs the pre-receive hook: a push to main is rejected", async () => {
        const token = server.mintToken();
        const result = await pushTo(remoteUrl({ token }), "HEAD:refs/heads/main");
        assert.equal(result.ok, false);
        assert.ok(result.stderr.includes(`${PRE_RECEIVE_MESSAGES.protectedBranch}: refs/heads/main`), result.stderr);
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "main"]), fixture.commits.initial);
    });

    it("streams a chunked push body and a gzip fetch body through the CGI", async () => {
        const token = server.mintToken();
        // Random bytes do not compress, so the pack exceeds the 64 KiB post
        // buffer and git switches to a chunked request body.
        await commitFile(clone, "http/big.bin", randomBytes(256 * 1024));
        const before = server.log.length;
        const push = await pushTo(remoteUrl({ token }), "HEAD:refs/heads/agent/x", ["-c", "http.postBuffer=65536"]);
        assert.ok(push.ok, push.stderr);
        assert.ok(server.log.slice(before).some(e => e.path.endsWith("/git-receive-pack") && e.transferEncoding === "chunked"),
            JSON.stringify(server.log.slice(before)));
        assert.equal(await git(["-C", fixture.remote, "rev-parse", "refs/heads/agent/x"]), await git(["-C", clone, "rev-parse", "HEAD"]));

        // 30 new upstream tips make one fetch request carry 30 "want" lines,
        // about 1.5 KiB, and git gzips upload-pack requests over 1 KiB. Wants
        // are fixed by the refs; "have" counts depend on negotiation, so they
        // would make this flaky.
        const tree = await git(["-C", fixture.remote, "rev-parse", `${fixture.commits.initial}^{tree}`]);
        const tips = [];
        for (let i = 0; i < 30; i++) {
            const sha = await git(["-C", fixture.remote, "commit-tree", tree, "-p", fixture.commits.initial, "-m", `upstream tip ${i}`]);
            await fixture.rewriteUpstream({ branch: `many/${i}`, toCommit: sha });
            tips.push(sha);
        }
        const fetchStart = server.log.length;
        const fetch = await tryGit(["-C", clone, "fetch", remoteUrl({ token }), "+refs/heads/many/*:refs/remotes/http/many/*"]);
        assert.ok(fetch.ok, fetch.stderr);
        assert.ok(server.log.slice(fetchStart).some(e => e.path.endsWith("/git-upload-pack") && e.contentEncoding === "gzip"),
            JSON.stringify(server.log.slice(fetchStart)));
        assert.equal(await git(["-C", clone, "rev-parse", "refs/remotes/http/many/29"]), tips[29]);
    });

    it("rejects a token after revokeAll and after it expires", async () => {
        const token = server.mintToken();
        assert.ok((await tryGit(["ls-remote", remoteUrl({ token })])).ok);
        server.revokeAll();
        const revoked = await tryGit(["ls-remote", remoteUrl({ token })]);
        assert.equal(revoked.ok, false);
        assert.equal(server.log.at(-1).status, 401);

        const shortLived = server.mintToken({ ttlMs: 1 });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal((await tryGit(["ls-remote", remoteUrl({ token: shortLived })])).ok, false);
    });
});

describe("gitEnv isolation", () => {
    it("ignores the host's global and system git config", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-git-env-"));
        try {
            const origins = await git(["config", "--list", "--show-origin"], { cwd: dir });
            assert.equal(origins, "");
            assert.equal(await git(["var", "GIT_AUTHOR_IDENT"], { cwd: dir }).then(s => s.split(" <")[0]), "fixture");
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
