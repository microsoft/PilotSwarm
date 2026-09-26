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
    checkMaintenanceCommand,
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
    const call = async (method, pathname, body) => {
        const response = await fetch(new URL(pathname, url), {
            method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
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
        // The other tree is no longer refused as "in use": the checkout is
        // gone, and the tree makes its own clone.
        assert.equal((await lease(svc, "b1", "tree-b", "w2")).code, "WORKSPACE_FOLDER_MISSING");
        await svc.call("POST", "/v1/clones", { rootSessionId: "tree-b", repo: "app" });
        assert.equal((await lease(svc, "b1", "tree-b", "w2", "sessions/tree-b/app")).ok, true);
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
    it("the allowlist refuses what drops borrowed objects and allows the rest", () => {
        for (const args of [["prune"], ["gc", "--prune=now"], ["gc", "--prune"], ["repack", "-a", "-d"], ["repack", "-ad"], ["repack", "-a", "-d", "-q"], ["fsck"], []]) {
            assert.equal(checkMaintenanceCommand(args).ok, false, `refused: ${args.join(" ")}`);
        }
        for (const args of [["gc"], ["gc", "--prune=never"], ["maintenance", "run"], ["repack", "-A", "-d"], ["repack", "--cruft", "-d"], ["repack", "-a", "-d", "-k"], ["repack", "-adk"], ["repack", "-d"]]) {
            assert.equal(checkMaintenanceCommand(args).ok, true, `allowed: ${args.join(" ")}`);
        }
    });

    it("refuses over the API, and the allowed commands leave a borrowing clone fsck-clean", async () => {
        const fx = await fixture({ layout: "packed" });
        const svc = await serviceFor(fx);
        let clone;
        await fx.createUnreachableObjects({
            // The clone borrows the commit through its alternates, so checking
            // it out needs no fetch: exactly the object a bad prune would drop.
            prepare: async (commit) => {
                clone = (await svc.call("POST", "/v1/clones", { rootSessionId: "tree-g2", repo: "app" })).body.path;
                await git(["-C", clone, "checkout", "-q", "--detach", commit]);
            },
        });
        for (const args of [["prune"], ["repack", "-a", "-d"]]) {
            const refused = await svc.call("POST", "/v1/maintenance", { repo: "app", args });
            assert.equal(refused.status, 403, args.join(" "));
            assert.equal(refused.body.error.code, "MAINTENANCE_REFUSED");
        }
        for (const args of [["gc"], ["maintenance", "run"], ["repack", "-A", "-d"], ["repack", "--cruft", "-d"], ["repack", "-a", "-d", "-k"]]) {
            const ran = await svc.call("POST", "/v1/maintenance", { repo: "app", args });
            assert.equal(ran.status, 200, `${args.join(" ")}: ${JSON.stringify(ran.body)}`);
        }
        const fsck = await tryGit(["-C", clone, "fsck", "--full"]);
        assert.equal(fsck.ok, true, fsck.stderr);
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
        assert.deepEqual(await provider.ensureAttached(req("markers")), { ok: true, path: path.join(fx.root, "markers") }, "not a clone: no lease");
        assert.equal((await provider.ensureAttached({ ...req("x"), workspace: { schema: 1, root: "nope" } })).code, "WORKSPACE_ROOT_UNKNOWN");

        await provider.release(req("sessions/tree-p/app"));
        assert.equal(svc.service.state().leases["sessions/tree-p/app"], undefined, "released");

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
