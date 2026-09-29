/**
 * The example's home provider: each person's own folder
 * (examples/repo-workspaces/home-provider.mjs, docs/proposals/session-workspaces.md 4.11).
 *
 *   H1  folder names: email, _anon, _system, and the fallbacks
 *   H2  defaultFolders: the person's folder and the default extra folders;
 *       none for system sessions and their sub-agents
 *   H3  first use makes the folder and copies the starter files; later
 *       attaches never overwrite what the person changed
 *   H4  the owner rule: only this session's person's folder; a link out of
 *       it is refused; an unknown owner is retried
 *   H5  the worker module's settings: PS_HOME_ROOT and PS_DEFAULT_EXTRAS
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_HOME_SEED, createHomeProvider, personFolderName } from "../../examples/repo-workspaces/home-provider.mjs";
import { createWorkspaceProvider, register } from "../../examples/repo-workspaces/index.mjs";

const person = (email) => ({ provider: "entra", subject: "oid-1", email });

describe("H1 folder names", () => {
    it("email lowercased with other characters as _, _anon, _system, and the fallbacks", () => {
        assert.equal(personFolderName(person("Ada.Lovelace@Example.com"), false), "ada.lovelace_example.com");
        assert.equal(personFolderName({ provider: "anonymous", subject: "anonymous" }, false), "_anon");
        assert.equal(personFolderName(null, false), "_system");
        assert.equal(personFolderName(person("x@y.z"), true), "_system", "a system session");
        assert.equal(personFolderName({ provider: "system", subject: "system" }, false), "_system", "a system session's sub-agent");
        assert.equal(personFolderName({ provider: "entra", subject: "3F2A-9C" }, false), "entra-3f2a-9c", "no email: provider and subject");
        assert.equal(personFolderName(person("_sneaky@x.io"), false), "u_sneaky_x.io", "a name starting with _ is never a person's");
        assert.equal(personFolderName(person(".hidden@x.io"), false), "u.hidden_x.io");
    });
});

describe("H2-H4 the home provider", () => {
    let base;
    let home;
    let owners;
    let provider;
    const req = (sessionId, folder) => ({ sessionId, rootSessionId: sessionId, workerNodeId: "w", turnIndex: 1, revision: 1, purpose: "turn", workspace: { schema: 1, root: "home", ...(folder !== undefined ? { folder } : {}) } });
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-home-")));
        home = { name: "home", path: path.join(base, "home") };
        fs.mkdirSync(path.join(home.path, "users"), { recursive: true });
        fs.writeFileSync(path.join(home.path, ".pilotswarm-export"), "");
        owners = new Map([
            ["s-me", { owner: person("me@example.com"), isSystem: false }],
            ["s-other", { owner: person("other@example.com"), isSystem: false }],
        ]);
        provider = createHomeProvider({
            root: home,
            defaultExtras: ["shared"],
            getCatalog: () => ({ getSession: async (id) => owners.get(id) ?? null }),
        });
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it("H2 defaultFolders: the person's folder as \"home\", plus the default extra folders; none for system sessions", () => {
        assert.deepEqual(provider.defaultFolders({ sessionId: "s", rootSessionId: "s", owner: person("me@example.com"), isSystem: false }), {
            home: { name: "home", root: "home", folder: "users/me_example.com" },
            extra: { shared: { root: "shared" } },
        });
        assert.equal(provider.defaultFolders({ owner: null, isSystem: true }), null, "a system session gets no default folders");
        assert.equal(provider.defaultFolders({ owner: { provider: "system", subject: "system" }, isSystem: false }), null, "nor does its sub-agent");
        assert.equal(provider.defaultFolders({ owner: person("x@y.z"), isSystem: true }), null, "nor a system session that names a person");
        assert.equal(provider.defaultFolders({ owner: { provider: "anonymous", subject: "anonymous" }, isSystem: false }).home.folder, "users/_anon");
    });

    it("H3 first use makes the folder and copies the starter files; a later attach keeps the person's changes", async () => {
        const mine = path.join(home.path, "users", "me_example.com");
        const first = await provider.ensureAttached(req("s-me", "users/me_example.com"));
        assert.deepEqual(first, { ok: true, path: mine, adopt: { agents: true, skills: true, instructions: true, folder: true } });
        for (const file of ["AGENTS.md", ".github/skills/notes/SKILL.md", ".github/agents/summarizer.agent.md"]) {
            assert.equal(fs.readFileSync(path.join(mine, file), "utf8"), fs.readFileSync(path.join(DEFAULT_HOME_SEED, file), "utf8"), file);
        }
        fs.writeFileSync(path.join(mine, "AGENTS.md"), "mine now\n");
        fs.rmSync(path.join(mine, ".github", "skills", "notes"), { recursive: true });
        assert.equal((await provider.ensureAttached(req("s-me", "users/me_example.com"))).ok, true);
        assert.equal(fs.readFileSync(path.join(mine, "AGENTS.md"), "utf8"), "mine now\n", "an existing folder is never seeded again");
        assert.equal(fs.existsSync(path.join(mine, ".github", "skills", "notes")), false, "nor are deleted starter files put back");
        const noSeed = createHomeProvider({ root: home, seedDir: null, getCatalog: () => ({ getSession: async () => ({ owner: person("bare@x.io") }) }) });
        assert.equal((await noSeed.ensureAttached(req("s-bare", "users/bare_x.io"))).ok, true);
        assert.deepEqual(fs.readdirSync(path.join(home.path, "users", "bare_x.io")), [], "seedDir null: an empty folder");
    });

    it("H4 the owner rule: only the session's own folder; a subfolder is not made; a link out is refused; an unknown owner is retried", async () => {
        const refused = await provider.ensureAttached(req("s-other", "users/me_example.com"));
        assert.equal(refused.code, "WORKSPACE_PATH_INVALID");
        assert.match(refused.message, /not this session's own folder \(users\/other_example.com\)/);
        assert.equal((await provider.ensureAttached(req("s-me"))).code, "WORKSPACE_PATH_INVALID", "the root itself is nobody's folder");
        assert.equal((await provider.ensureAttached(req("s-me", "users"))).code, "WORKSPACE_PATH_INVALID");
        assert.equal((await provider.ensureAttached(req("s-me", "users/me_example.com/missing"))).code, "WORKSPACE_FOLDER_MISSING", "only the person's folder itself is made");
        fs.mkdirSync(path.join(home.path, "users", "other_example.com"), { recursive: true });
        fs.symlinkSync(path.join(home.path, "users", "other_example.com"), path.join(home.path, "users", "me_example.com", "borrowed"));
        assert.equal((await provider.ensureAttached(req("s-me", "users/me_example.com/borrowed"))).code, "WORKSPACE_PATH_INVALID", "a link into another person's folder");
        const unknown = await provider.ensureAttached(req("s-nobody", "users/me_example.com"));
        assert.equal(unknown.code, "WORKSPACE_ATTACH_FAILED");
        assert.ok(unknown.retryAfterMs > 0);
        fs.rmSync(path.join(home.path, ".pilotswarm-export"));
        try {
            assert.equal((await provider.ensureAttached(req("s-me", "users/me_example.com"))).code, "WORKSPACE_NOT_MOUNTED");
        } finally {
            fs.writeFileSync(path.join(home.path, ".pilotswarm-export"), "");
        }
    });
});

describe("H5 the worker module's settings", () => {
    const roots = [{ name: "a", path: "/ws/a" }];
    const serviceUrls = { a: "http://repo:8080" };
    it("default extra folders need the home root and must be plain roots; roots must not overlap", () => {
        assert.throws(() => createWorkspaceProvider({ roots, serviceUrls, plainRoots: [{ name: "shared", path: "/ws/shared" }], defaultExtras: ["shared"] }),
            /PS_DEFAULT_EXTRAS needs PS_HOME_ROOT/);
        assert.throws(() => createWorkspaceProvider({ roots, serviceUrls, home: { name: "home", path: "/ws/home" }, defaultExtras: ["logs"] }),
            /"logs" is not a plain root/);
        assert.throws(() => createWorkspaceProvider({ roots, serviceUrls, home: { name: "home", path: "/ws/a/home" } }),
            /PS_HOME_ROOT: root "home" \(\/ws\/a\/home\) overlaps repo root "a"/);
        assert.throws(() => createWorkspaceProvider({ roots, serviceUrls, plainRoots: [{ name: "home", path: "/ws/p" }], home: { name: "home", path: "/ws/home" } }),
            /PS_HOME_ROOT: root "home" is also a plain root/);
    });

    it("register(worker) wires the home root and the default extra folders from the environment", async () => {
        const worker = { provider: null, tools: [], catalog: null, setWorkspaceProvider(p) { this.provider = p; }, registerTools(t) { this.tools.push(...t); } };
        await register(worker, { env: { PS_WORKSPACE_ROOTS: "a=/ws/a", REPO_SERVICE_URL: "http://repo:8080", PS_PLAIN_ROOTS: "shared=/ws/shared", PS_HOME_ROOT: "home=/ws/home", PS_DEFAULT_EXTRAS: "shared" } });
        assert.deepEqual((await worker.provider.listRoots()).map((r) => r.name), ["a", "shared", "home"]);
        assert.deepEqual(await worker.provider.defaultFolders({ owner: person("me@example.com"), isSystem: false }), {
            home: { name: "home", root: "home", folder: "users/me_example.com" },
            extra: { shared: { root: "shared" } },
        });
        const plain = { provider: null, tools: [], catalog: null, setWorkspaceProvider(p) { this.provider = p; }, registerTools(t) { this.tools.push(...t); } };
        await register(plain, { env: { PS_WORKSPACE_ROOTS: "a=/ws/a", REPO_SERVICE_URL: "http://repo:8080" } });
        assert.equal(plain.provider.defaultFolders, undefined, "without PS_HOME_ROOT, no default folders");
        await assert.rejects(register(plain, { env: { REPO_SERVICE_URL: "x", PS_HOME_ROOT: "a=/1,b=/2" } }), /PS_HOME_ROOT names one root/);
    });
});
