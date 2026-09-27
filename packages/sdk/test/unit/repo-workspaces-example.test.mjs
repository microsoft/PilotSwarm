/**
 * The reference repo service, provider and tools in
 * examples/repo-workspaces/ (docs/proposals/session-workspaces.md, section 5),
 * against a real git fixture. No worker: the service and the provider are
 * called directly.
 *
 *   clones      clone --shared, relative alternates, the real origin, the per-clone helper
 *   R1, R2      leases: one tree per clone; cleanup refused while an entry is live
 *   R5          lock files stay while any entry is live, and go when all are dead
 *   G2          forbidden mirror maintenance is refused; allowed runs keep clones fsck-clean
 *   G6          the per-clone helper wins over a global one; a clone without it cannot push
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createGitFixture, git, gitEnv, tryGit } from "../helpers/git-fixture.mjs";
import { startGitTokenServer } from "../helpers/git-token-server.mjs";
import {
    MAINTENANCE_OPERATIONS,
    createRepoService,
    parseCheckout,
} from "../../examples/repo-workspaces/repo-service.mjs";
import { createRepoWorkspaceProvider } from "../../examples/repo-workspaces/provider.mjs";
import { createRepoTools } from "../../examples/repo-workspaces/tools.mjs";
import { parseRoots, register } from "../../examples/repo-workspaces/index.mjs";

const HELPER = fileURLToPath(new URL("../../examples/repo-workspaces/credential-helper.mjs", import.meta.url));
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function serviceFor(fixture, extra = {}) {
    const alive = new Set(["w1", "w2", "w3"]);
    let clock = 1_000_000;
    const service = createRepoService({
        root: fixture.root,
        rootName: "fx",
        repos: { app: { remote: fixture.remote, adopt: { agents: true, skills: false, instructions: true } } },
        isWorkerAlive: (worker) => alive.has(worker),
        now: () => clock,
        // The fixture's isolated git env: no host config leaks in.
        runGit: (args) => git(args),
        ...extra,
    });
    const url = await service.listen();
    cleanups.push(() => service.close());
    const call = async (method, pathname, body, headers = {}) => {
        const response = await fetch(new URL(pathname, url), {
            method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    return { service, url, call, alive, advance: (ms) => { clock += ms; } };
}

async function fixture(opts) {
    const fx = await createGitFixture(opts);
    cleanups.push(() => fx.cleanup());
    return fx;
}

describe("repo service: clones", () => {
    it("makes a clone --shared with relative alternates, the real origin and the per-clone helper; again returns it", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx, { credentialHelper: "!echo helper" });
        const made = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(made.status, 200, JSON.stringify(made.body));
        assert.deepEqual(made.body.workspace, { root: "fx", folder: "sessions/tree-a/app" });
        assert.equal(made.body.created, true);
        const clone = made.body.path;
        const alternates = fs.readFileSync(path.join(clone, ".git/objects/info/alternates"), "utf8").trim();
        assert.ok(!path.isAbsolute(alternates) && alternates.includes("repos/app.git/objects"), alternates);
        assert.equal(await git(["-C", clone, "remote", "get-url", "origin"]), fx.remote);
        // Untrimmed: the first value is the empty helper that clears inherited ones.
        assert.equal((await tryGit(["-C", clone, "config", "--local", "--get-all", "credential.helper"])).stdout, "\n!echo helper\n");
        assert.equal(await git(["-C", clone, "config", "--local", "credential.useHttpPath"]), "true");
        assert.equal((await git(["-C", clone, "fsck"])).includes("error"), false);

        const again = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(again.body.created, false);
        const list = await svc.call("GET", "/v1/clones?rootSessionId=tree-a");
        assert.deepEqual(list.body.clones.map((c) => c.workspace.folder), ["sessions/tree-a/app"]);

        fs.mkdirSync(path.join(fx.root, "sessions/tree-z/app"), { recursive: true });
        const foreign = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-z", repo: "app" });
        assert.equal(foreign.status, 409);
        assert.equal(foreign.body.error.code, "CHECKOUT_EXISTS");
        assert.equal((await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "nope" })).body.error.code, "REPO_UNKNOWN");
        assert.equal(parseCheckout("sessions/tree-a/app").repo, "app");
        assert.equal(parseCheckout("repos/app.git"), null);
    });
});

describe("repo service: removing a clone", () => {
    it("keeps the tree's folder while anything else is in it", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-c", repo: "app" });
        fs.mkdirSync(path.join(fx.root, "sessions/tree-c/notes"));
        assert.equal((await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-c", repo: "app" })).body.deleted, true);
        assert.equal(fs.existsSync(path.join(fx.root, "sessions/tree-c/app")), false);
        assert.ok(fs.existsSync(path.join(fx.root, "sessions/tree-c/notes")), "the other folder and the tree stay");
    });
});

describe("repo service: leases", () => {
    const lease = (svc, sessionId, rootSessionId, workerNodeId, checkout = "sessions/tree-a/app") =>
        svc.call("POST", "/v1/leases", { checkout, sessionId, rootSessionId, workerNodeId, turnIndex: 1 }).then((r) => r.body);

    it("one tree per clone: another tree is refused before and after the owner releases; a child is let in; cleanup waits for live entries (R1, R2)", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        const owner = await lease(svc, "a1", "tree-a", "w1");
        assert.deepEqual(owner, { ok: true, adopt: { agents: true, skills: false, instructions: true } });

        assert.equal((await lease(svc, "b1", "tree-b", "w2")).code, "WORKSPACE_IN_USE");
        await svc.call("DELETE", "/v1/leases", { checkout: "sessions/tree-a/app", sessionId: "a1" });
        assert.equal((await lease(svc, "b1", "tree-b", "w2")).code, "WORKSPACE_IN_USE", "released is not freed");

        assert.equal((await lease(svc, "a1-child", "tree-a", "w2")).ok, true, "a child of the tree attaches");
        const refused = await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error.code, "CHECKOUT_IN_USE");
        assert.ok(fs.existsSync(path.join(fx.root, "sessions/tree-a/app")), "the refused cleanup deleted nothing");

        await svc.call("DELETE", "/v1/leases", { checkout: "sessions/tree-a/app", sessionId: "a1-child" });
        assert.equal((await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-a", repo: "app" })).body.deleted, true);
        assert.equal(fs.existsSync(path.join(fx.root, "sessions/tree-a/app")), false);
        assert.equal(fs.existsSync(path.join(fx.root, "sessions/tree-a")), false, "the tree's folder goes with its last clone");
        // The other tree is no longer refused as "in use": the checkout is
        // gone, and the tree makes its own clone.
        assert.equal((await lease(svc, "b1", "tree-b", "w2")).code, "WORKSPACE_FOLDER_MISSING");
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-b", repo: "app" });
        assert.equal((await lease(svc, "b1", "tree-b", "w2", "sessions/tree-b/app")).ok, true);
    });

    it("a release deletes only the holder's own entry: a late one from another worker or an older turn keeps it (review R5)", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        const checkout = "sessions/tree-a/app";
        // The session moved: worker 2 attached in turn 4 after worker 1's turn 3.
        await svc.call("POST", "/v1/leases", { checkout, sessionId: "a1", rootSessionId: "tree-a", workerNodeId: "w1", turnIndex: 3 });
        await svc.call("POST", "/v1/leases", { checkout, sessionId: "a1", rootSessionId: "tree-a", workerNodeId: "w2", turnIndex: 4 });

        const late = await svc.call("DELETE", "/v1/leases", { checkout, sessionId: "a1", workerNodeId: "w1", turnIndex: 4 });
        assert.deepEqual(late.body, { deleted: false, reason: "another worker holds the entry" });
        const older = await svc.call("DELETE", "/v1/leases", { checkout, sessionId: "a1", workerNodeId: "w2", turnIndex: 3 });
        assert.deepEqual(older.body, { deleted: false, reason: "a newer turn holds the entry" });
        const refused = await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        assert.equal(refused.body.error.code, "CHECKOUT_IN_USE", "the kept entry still guards the clone");

        const own = await svc.call("DELETE", "/v1/leases", { checkout, sessionId: "a1", workerNodeId: "w2", turnIndex: 5 });
        assert.deepEqual(own.body, { deleted: true });
        assert.equal((await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-a", repo: "app" })).body.deleted, true);
    });

    it("lock files stay while any entry is live and go when every entry is dead (R5)", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx, { entryTtlMs: 60_000 });
        const { body } = await svc.call("POST", "/v1/clones", { rootSessionId: "tree-a", repo: "app" });
        const lock = path.join(body.path, ".git", "index.lock");
        const refLock = path.join(body.path, ".git", "refs", "heads", "main.lock");
        await lease(svc, "parent", "tree-a", "w1");
        await lease(svc, "child", "tree-a", "w2");
        fs.writeFileSync(lock, "");
        fs.writeFileSync(refLock, "");

        assert.equal((await lease(svc, "child", "tree-a", "w2")).removedLocks, undefined, "the child's attach keeps the parent's lock");
        svc.alive.delete("w1");
        assert.equal((await lease(svc, "child", "tree-a", "w2")).removedLocks, undefined, "a live child entry keeps the locks");
        assert.ok(fs.existsSync(lock));

        svc.alive.delete("w2");
        svc.advance(61_000); // and too old, as well as on a missing worker
        const cleared = await lease(svc, "child", "tree-a", "w3");
        assert.deepEqual(cleared.removedLocks.sort(), [".git/index.lock", ".git/refs/heads/main.lock"]);
        assert.equal(fs.existsSync(lock) || fs.existsSync(refLock), false);
        assert.deepEqual(svc.service.state().leases["sessions/tree-a/app"].map((e) => [e.sessionId, e.workerNodeId]), [["child", "w3"]],
            "dead entries are dropped");
    });
});

describe("repo service: mirror maintenance (G2)", () => {
    it("runs named operations only, with the admin token; every operation keeps a borrowing clone fsck-clean", async () => {
        const fx = await fixture({ layout: "packed" });
        const admin = { authorization: "Bearer admin-secret" };
        const svc = await serviceFor(fx, { adminToken: "admin-secret" });
        let clone;
        await fx.createUnreachableObjects({
            // The clone borrows the commit through its alternates: exactly the object a bad prune would drop.
            prepare: async (commit) => {
                clone = (await svc.call("POST", "/v1/clones", { rootSessionId: "tree-g2", repo: "app" })).body.path;
                await git(["-C", clone, "checkout", "-q", "--detach", commit]);
            },
        });
        // Workers, and so agent shells, can reach the service: no token, no maintenance.
        assert.equal((await svc.call("POST", "/v1/maintenance", { repo: "app", operation: "gc" })).body.error.code, "ADMIN_REQUIRED");
        assert.equal((await svc.call("POST", "/v1/maintenance", { repo: "app", operation: "gc" }, { authorization: "Bearer wrong" })).body.error.code, "ADMIN_REQUIRED");
        assert.equal((await svc.call("POST", "/v1/mirrors/fetch", { repo: "app" })).body.error.code, "ADMIN_REQUIRED");
        // Git arguments are never accepted: the forms that got past an argument filter cannot be sent at all.
        for (const body of [{ repo: "app", args: ["gc", "--prun=now"] }, { repo: "app", operation: "prune" }, { repo: "app", operation: "gc --prune=now" }]) {
            const refused = await svc.call("POST", "/v1/maintenance", body, admin);
            assert.equal(refused.status, 400, JSON.stringify(body));
            assert.equal(refused.body.error.code, "MAINTENANCE_UNKNOWN");
        }
        for (const operation of Object.keys(MAINTENANCE_OPERATIONS)) {
            const ran = await svc.call("POST", "/v1/maintenance", { repo: "app", operation }, admin);
            assert.equal(ran.status, 200, `${operation}: ${JSON.stringify(ran.body)}`);
        }
        const fsck = await tryGit(["-C", clone, "fsck", "--full"]);
        assert.equal(fsck.ok, true, fsck.stderr);
        assert.equal((await svc.call("POST", "/v1/mirrors/fetch", { repo: "app" }, admin)).body.fetched, true);

        const off = await serviceFor(fx);
        assert.equal((await off.call("POST", "/v1/maintenance", { repo: "app", operation: "gc" }, admin)).body.error.code, "ADMIN_DISABLED");
    });

    it("every named operation pins gc.pruneExpire=never or keeps unreachable objects", () => {
        for (const [name, args] of Object.entries(MAINTENANCE_OPERATIONS)) {
            assert.ok(args.includes("gc.pruneExpire=never") || args.includes("-k"), name);
            assert.ok(!args.some((arg) => /^--(prune|expire)=(?!never)/.test(arg) || /expiration=(?!never)/.test(arg)), name);
        }
    });
});

describe("repo service: links a session can plant", () => {
    it("cleanup refuses to delete through a linked tree folder; lock removal skips a linked .git", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx, { entryTtlMs: 1000 });
        const made = (await svc.call("POST", "/v1/clones", { rootSessionId: "tree-l", repo: "app" })).body;
        // The session swaps its tree folder for a link to somewhere else.
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ps-link-target-"));
        cleanups.push(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
        fs.mkdirSync(path.join(elsewhere, "app"));
        fs.writeFileSync(path.join(elsewhere, "app", "precious.txt"), "keep");
        fs.renameSync(path.join(fx.root, "sessions/tree-l"), path.join(fx.root, "sessions/tree-l.real"));
        fs.symlinkSync(elsewhere, path.join(fx.root, "sessions/tree-l"));
        const refused = await svc.call("DELETE", "/v1/clones", { rootSessionId: "tree-l", repo: "app" });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error.code, "CHECKOUT_UNSAFE");
        assert.ok(fs.existsSync(path.join(elsewhere, "app", "precious.txt")), "nothing behind the link was deleted");
        fs.unlinkSync(path.join(fx.root, "sessions/tree-l"));
        fs.renameSync(path.join(fx.root, "sessions/tree-l.real"), path.join(fx.root, "sessions/tree-l"));

        // The session swaps its .git for a link to the mirror, which has a lock file.
        const mirrorLock = path.join(fx.mirror, "packed-refs.lock");
        fs.writeFileSync(mirrorLock, "");
        cleanups.push(() => fs.rmSync(mirrorLock, { force: true }));
        fs.renameSync(path.join(made.path, ".git"), path.join(made.path, ".git.real"));
        fs.symlinkSync(fx.mirror, path.join(made.path, ".git"));
        const lease = (sessionId, worker) => svc.call("POST", "/v1/leases", { checkout: "sessions/tree-l/app", sessionId, rootSessionId: "tree-l", workerNodeId: worker, turnIndex: 0 }).then((r) => r.body);
        await lease("l1", "w1");
        svc.alive.delete("w1");
        svc.advance(2_000);
        const next = await lease("l2", "w2");
        assert.equal(next.ok, true);
        assert.equal(next.removedLocks, undefined, "no lock removal through a linked .git");
        assert.ok(fs.existsSync(mirrorLock), "the mirror's lock file is intact");
        assert.equal((await svc.call("POST", "/v1/leases", { checkout: "sessions/tree-l/app/src", sessionId: "l3", rootSessionId: "tree-l", workerNodeId: "w2", turnIndex: 0 })).status, 400,
            "a lease names an exact checkout");
    });
});

describe("repo service: credentials (G6)", () => {
    it("the per-clone helper wins over a global one; a clone without it cannot push; other hosts get no token", async () => {
        const fx = await fixture();
        const tokens = await startGitTokenServer({ projectRoot: fx.root });
        cleanups.push(() => tokens.close());
        const remoteUrl = tokens.url("remotes/app.git");
        // The service's URL is not known until it listens; the helper reads it at run time.
        const env = { REPO_SERVICE_URL: "" };
        const svc = await serviceFor(fx, {
            repos: { app: { remote: remoteUrl } },
            mintToken: () => tokens.mintToken(),
            credentialHelper: `!REPO_SERVICE_URL="$PS_TEST_REPO_SERVICE_URL" '${process.execPath}' '${HELPER}'`,
        });
        env.REPO_SERVICE_URL = svc.url;
        const globalConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ps-g6-")), "gitconfig");
        cleanups.push(() => fs.rmSync(path.dirname(globalConfig), { recursive: true, force: true }));
        fs.writeFileSync(globalConfig, "[credential]\n\thelper = \"!f() { echo username=x; echo password=wrong-token; }; f\"\n");
        const withGlobal = { GIT_CONFIG_GLOBAL: globalConfig, PS_TEST_REPO_SERVICE_URL: svc.url };

        const serviceClone = (await svc.call("POST", "/v1/clones", { rootSessionId: "tree-g6", repo: "app" })).body.path;
        await git(["-C", serviceClone, "commit", "-q", "--allow-empty", "-m", "g6 via the per-clone helper"], { env: withGlobal });
        const pushed = await tryGit(["-C", serviceClone, "push", "-q", "origin", "HEAD:refs/heads/agent/g6"], { env: withGlobal });
        assert.equal(pushed.ok, true, `the per-clone helper's token wins: ${pushed.stderr}`);

        const plain = await fx.cloneSession({ rootSessionId: "tree-plain", originUrl: remoteUrl });
        await git(["-C", plain, "commit", "-q", "--allow-empty", "-m", "no per-clone helper"], { env: withGlobal });
        const refused = await tryGit(["-C", plain, "push", "-q", "origin", "HEAD:refs/heads/agent/plain"], { env: withGlobal });
        assert.equal(refused.ok, false, "a clone without the per-clone helper cannot push");

        // Async, so this process keeps serving the repo service the helper calls.
        const fill = (host, pathName) => new Promise((resolve) => {
            const child = spawn("git", ["-C", serviceClone, "credential", "fill"], { env: gitEnv({ ...withGlobal, GIT_TERMINAL_PROMPT: "0" }) });
            let stdout = "";
            child.stdout.on("data", (chunk) => { stdout += chunk; });
            child.on("close", () => resolve(stdout));
            child.stdin.end(`protocol=${new URL(remoteUrl).protocol.replace(":", "")}\nhost=${host}\npath=${pathName}\n\n`);
        });
        const own = await fill(new URL(remoteUrl).host, "remotes/app.git");
        assert.match(own, /password=/, "the clone's own remote gets a token (the helper is reachable)");
        const other = await fill("evil.example", "x.git");
        assert.ok(!/password=/.test(other), `no token for another host: ${other}`);
    });
});

describe("provider, tools and register()", () => {
    it("checks the export marker, leases only session clones, passes adopt through, and releases", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-p", repo: "app" });
        const provider = createRepoWorkspaceProvider({ roots: [{ name: "fx", path: fx.root }], serviceUrls: { fx: svc.url } });
        const req = (folder, extra = {}) => ({ sessionId: "p1", rootSessionId: "tree-p", workerNodeId: "w1", turnIndex: 0, revision: 1, workspace: { schema: 1, root: "fx", ...(folder ? { folder } : {}) }, ...extra });

        const attached = await provider.ensureAttached(req("sessions/tree-p/app"));
        assert.deepEqual(attached, { ok: true, path: path.join(fx.root, "sessions/tree-p/app"), adopt: { agents: true, skills: false, instructions: true } });
        assert.equal(svc.service.state().leases["sessions/tree-p/app"].length, 1);
        assert.deepEqual(await provider.ensureAttached(req("sessions/tree-p/app", { rootSessionId: "tree-q" })),
            { ok: false, code: "WORKSPACE_IN_USE", message: "sessions/tree-p/app belongs to session tree tree-p" });
        assert.equal((await provider.ensureAttached({ ...req("x"), workspace: { schema: 1, root: "nope" } })).code, "WORKSPACE_ROOT_UNKNOWN");
        // Only session clones: the root, a tree folder and other folders are refused.
        for (const folder of [undefined, "markers", "sessions", "sessions/tree-p", "repos/app.git"]) {
            assert.equal((await provider.ensureAttached(req(folder))).code, "WORKSPACE_PATH_INVALID", `refused: ${folder}`);
        }
        assert.equal((await provider.ensureAttached(req("sessions/tree-p/app/missing"))).code, "WORKSPACE_FOLDER_MISSING");
        // A subfolder of a clone, or a link into one, leases the clone that contains it.
        fs.mkdirSync(path.join(fx.root, "sessions/tree-p/app/src"));
        assert.equal((await provider.ensureAttached(req("sessions/tree-p/app/src", { rootSessionId: "tree-q", sessionId: "q1" }))).code, "WORKSPACE_IN_USE",
            "another tree cannot use a subfolder of the clone");
        fs.mkdirSync(path.join(fx.root, "sessions/tree-q"), { recursive: true });
        fs.symlinkSync(path.join(fx.root, "sessions/tree-p/app"), path.join(fx.root, "sessions/tree-q/borrowed"));
        assert.equal((await provider.ensureAttached(req("sessions/tree-q/borrowed", { rootSessionId: "tree-q", sessionId: "q1" }))).code, "WORKSPACE_IN_USE",
            "nor a link into it");
        const child = await provider.ensureAttached(req("sessions/tree-p/app/src", { sessionId: "p1-child" }));
        assert.equal(child.ok, true);
        assert.deepEqual(svc.service.state().leases["sessions/tree-p/app"].map((e) => e.sessionId).sort(), ["p1", "p1-child"], "the subfolder session holds an entry on the clone");
        await provider.release(req("sessions/tree-p/app/src", { sessionId: "p1-child" }));

        await provider.release(req("sessions/tree-p/app"));
        assert.equal(svc.service.state().leases["sessions/tree-p/app"], undefined, "released, the subfolder session's entry included");

        fs.rmSync(path.join(fx.root, ".pilotswarm-export"));
        const unmounted = await provider.ensureAttached(req("sessions/tree-p/app"));
        assert.equal(unmounted.code, "WORKSPACE_NOT_MOUNTED");
        assert.ok(unmounted.retryAfterMs > 0);
        fs.writeFileSync(path.join(fx.root, ".pilotswarm-export"), "");

        await svc.service.close();
        const down = await provider.ensureAttached(req("sessions/tree-p/app"));
        assert.equal(down.code, "WORKSPACE_ATTACH_FAILED");
    });

    it("the tools make, list and remove clones for the calling session's tree", async () => {
        const fx = await fixture();
        const svc = await serviceFor(fx);
        const tools = createRepoTools({ serviceUrl: svc.url, getCatalog: () => ({ getSession: async (id) => ({ sessionId: id, rootSessionId: "tree-root" }) }) });
        const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
        const child = { durableSessionId: "child-session" };
        const made = JSON.parse(await byName.create_session_clone.handler({ repo: "app" }, child));
        assert.deepEqual(made.workspace, { root: "fx", folder: "sessions/tree-root/app" }, "the clone belongs to the tree root");
        assert.deepEqual(JSON.parse(await byName.list_session_clones.handler({}, child)).clones.map((c) => c.workspace.folder), ["sessions/tree-root/app"]);
        assert.equal(JSON.parse(await byName.remove_session_clone.handler({ repo: "app" }, child)).deleted, true);
        await assert.rejects(byName.remove_session_clone.handler({ repo: "app" }, child), /CLONE_UNKNOWN/);
    });

    it("register(worker) sets the provider and the tools from the environment", async () => {
        assert.deepEqual(parseRoots("a=/ws/a, b=/ws/b"), [{ name: "a", path: "/ws/a" }, { name: "b", path: "/ws/b" }]);
        assert.throws(() => parseRoots("nope"), /name=path/);
        const worker = { provider: null, tools: [], catalog: null, setWorkspaceProvider(p) { this.provider = p; }, registerTools(t) { this.tools.push(...t); } };
        await register(worker, { env: { PS_WORKSPACE_ROOTS: "a=/ws/a", REPO_SERVICE_URL: "http://repo:8080" } });
        assert.deepEqual(await worker.provider.listRoots(), [{ name: "a", path: "/ws/a" }]);
        assert.deepEqual(worker.tools.map((t) => t.name), ["create_session_clone", "list_session_clones", "remove_session_clone"]);
        await assert.rejects(register(worker, { env: {} }), /REPO_SERVICE_URL is required/);
    });
});
