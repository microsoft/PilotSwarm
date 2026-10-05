/**
 * Agents and skills loaded by path (docs/proposals/session-workspaces.md,
 * section 4.12).
 *
 *   L1  storage: loads in the capability state, withWorkspaceLoad, and a
 *       package change keeps them
 *   L2  resolveLoadPath: inside an attached folder, relative to the working
 *       folder, the deepest folder wins
 *   L3  parseSkillFile
 *   L4  readWorkspaceFiles: real paths must stay in the folder; size, kind
 *       and time limits
 *   L5  resolveWorkspaceLoads: every turn, each load is read again inside
 *       this turn's folders
 *   L6  the declarations: load_agent and load_skill's path only with the
 *       workspace tools; load_agent is a reserved name
 *   L7  the load helpers behind the tools: what is saved, and what is refused
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_WORKSPACE_LOADS, normalizeCapabilityState, withWorkspaceLoad } from "../../dist/capability-catalog.js";
import { nextCapabilityState } from "../../dist/capability-runtime.js";
import { readWorkspaceFiles, MAX_LOAD_FILE_BYTES } from "../../dist/workspace-check.js";
import { attachedFoldersOf, parseSkillFile, resolveLoadPath, resolveWorkspaceLoads } from "../../dist/workspace-loads.js";
import { findReservedPackageToolName } from "../../dist/reserved-tool-names.js";
import { ManagedSession } from "../../dist/managed-session.js";

const load = (kind, name, root, file) => ({ kind, name, root, path: file });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const agentText = (name, prompt = "Do the work.") => `---\nname: ${name}\ndescription: ${name} agent\n---\n${prompt}\n`;
const skillText = (name, body = "Follow these steps.") => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

describe("L1 storage", () => {
    const state = { revision: 3, selections: [{ sourceId: "s1", tools: ["t"], mcpServers: [] }], requests: [{ id: "r1", hash: "a".repeat(64) }] };

    it("the capability state keeps valid loads and refuses bad ones", () => {
        const good = [load("agent", "helper", "home", "users/me/helper.agent.md"), load("skill", "helper", "home", "users/me/skills/helper")];
        assert.deepEqual(normalizeCapabilityState({ ...state, loads: good }).loads, good, "an agent and a skill may share a name");
        assert.equal("loads" in normalizeCapabilityState({ ...state, loads: [] }), false, "no loads: no key");
        const bad = {
            "a bad kind": load("tool", "x", "home", "x"),
            "a bad name": load("agent", "../x", "home", "x"),
            "an empty name": load("agent", "", "home", "x"),
            "a root with a /": load("agent", "x", "home/users", "x"),
            "an empty root": load("agent", "x", "", "x"),
            "an absolute path": load("agent", "x", "home", "/etc/x.agent.md"),
            "a .. segment": load("agent", "x", "home", "users/../../x.agent.md"),
            "a NUL": load("agent", "x", "home", "x\0y"),
            "an empty path": load("agent", "x", "home", ""),
        };
        for (const [what, one] of Object.entries(bad)) {
            assert.throws(() => normalizeCapabilityState({ ...state, loads: [one] }), /Invalid durable workspace load/, what);
        }
        assert.throws(() => normalizeCapabilityState({ ...state, loads: [load("agent", "x", "home", "a"), load("agent", "x", "shared", "b")] }),
            /Invalid durable workspace load/, "the same kind and name twice");
        const many = Array.from({ length: MAX_WORKSPACE_LOADS + 1 }, (_, i) => load("agent", `a${i}`, "home", `a${i}.agent.md`));
        assert.throws(() => normalizeCapabilityState({ ...state, loads: many }), /Invalid durable workspace loads/);
    });

    it("withWorkspaceLoad adds, replaces and removes; the revision advances; selections stay", () => {
        const one = withWorkspaceLoad(state, { add: load("agent", "helper", "home", "users/me/a.agent.md") });
        assert.equal(one.revision, 4);
        assert.deepEqual(one.selections, state.selections);
        assert.deepEqual(one.requests, state.requests);
        const replaced = withWorkspaceLoad(one, { add: load("agent", "helper", "shared", "b.agent.md") });
        assert.deepEqual(replaced.loads, [load("agent", "helper", "shared", "b.agent.md")], "the same kind and name replaces the earlier load");
        const removed = withWorkspaceLoad(replaced, { remove: { kind: "agent", name: "helper" } });
        assert.equal("loads" in removed, false);
        assert.equal(removed.revision, 6);
        assert.throws(() => withWorkspaceLoad(removed, { remove: { kind: "skill", name: "helper" } }), /no skill named "helper" is loaded by path/);
        let full = state;
        for (let i = 0; i < MAX_WORKSPACE_LOADS; i += 1) full = withWorkspaceLoad(full, { add: load("skill", `s${i}`, "home", `s${i}`) });
        assert.throws(() => withWorkspaceLoad(full, { add: load("skill", "one-more", "home", "x") }), /At most 32/);
    });

    it("a package change keeps the loads", () => {
        const loads = [load("skill", "notes", "home", "users/me/notes")];
        const next = nextCapabilityState({ ...state, loads }, "s2", { source_ref: "cap1.x", tools: ["u"], expected_revision: 3, request_id: "r2" });
        assert.deepEqual(next.state.loads, loads);
    });
});

describe("L2 resolveLoadPath", () => {
    const testRoot = path.join(path.parse(process.cwd()).root, "r");
    const working = { root: "a", rootPath: path.join(testRoot, "a"), path: path.join(testRoot, "a", "sessions", "t", "app") };
    const shared = { root: "shared", rootPath: path.join(testRoot, "shared"), path: path.join(testRoot, "shared") };
    const folders = [working, shared];

    it("a path in the working folder or an extra folder, kept relative to its root", () => {
        const agentPath = path.join(working.path, ".github", "agents", "x.agent.md");
        assert.deepEqual(resolveLoadPath(agentPath, folders),
            { ok: true, folder: working, absolute: agentPath, rootRelative: "sessions/t/app/.github/agents/x.agent.md" });
        const relative = resolveLoadPath("tools/y.agent.md", folders);
        assert.equal(relative.absolute, path.join(working.path, "tools", "y.agent.md"), "a relative path starts at the working folder");
        const extra = resolveLoadPath(path.join(shared.path, "agents", "..", "agents", "r.agent.md"), folders);
        assert.deepEqual([extra.folder.root, extra.rootRelative], ["shared", "agents/r.agent.md"]);
    });

    it("anything else is refused", () => {
        for (const input of ["../../other/x.agent.md", path.join(path.parse(process.cwd()).root, "etc", "passwd"),
            path.join(testRoot, "sharedX", "x.agent.md"), path.join(testRoot, "a", "sessions", "t", "other", "x.agent.md")]) {
            const result = resolveLoadPath(input, folders);
            assert.equal(result.ok, false, input);
            assert.match(result.reason, /is not inside the working folder or an extra folder/, input);
        }
        for (const input of ["", "   ", 7, null, "x\0y"]) assert.equal(resolveLoadPath(input, folders).reason, "path is required", String(input));
        assert.match(resolveLoadPath("x", []).reason, /no attached folders/);
        assert.match(resolveLoadPath(shared.path, folders).reason, /not inside its root/, "the root itself is not a file");
    });

    it("the deepest folder that holds the path wins", () => {
        const inner = { root: "b", rootPath: path.join(working.path, "vendor"), path: path.join(working.path, "vendor") };
        const result = resolveLoadPath("vendor/x.agent.md", [working, inner]);
        assert.deepEqual([result.folder.root, result.rootRelative], ["b", "x.agent.md"]);
    });

    it("attachedFoldersOf lists the working folder first, then the extra folders", () => {
        assert.deepEqual(attachedFoldersOf(undefined), []);
        assert.deepEqual(attachedFoldersOf({ ...working, extras: [{ name: "shared", ...shared, adopt: {} }] }), folders);
    });
});

describe("L3 parseSkillFile", () => {
    it("the name from the frontmatter, else the folder; the description and the body", () => {
        assert.deepEqual(parseSkillFile("folder", skillText("notes")), { ok: true, name: "notes", description: "notes skill", body: "Follow these steps." });
        assert.deepEqual(parseSkillFile("notes", "Just steps.\n"), { ok: true, name: "notes", description: "", body: "Just steps." });
        assert.equal(parseSkillFile("f", "﻿---\r\nname: \"quoted\"\r\n---\r\nBody\r\n").name, "quoted", "a byte-order mark, CRLF and quotes");
    });

    it("a broken skill is refused with the reason", () => {
        assert.deepEqual(parseSkillFile("f", "---\nname: x\nBody\n"), { ok: false, reason: "the frontmatter has no closing ---" });
        assert.deepEqual(parseSkillFile("f", "---\nname: bad name\n---\nBody\n"), { ok: false, reason: "invalid skill name \"bad name\"" });
        assert.deepEqual(parseSkillFile("f", "---\nname: x\n---\n  \n"), { ok: false, reason: "the skill has no instructions" });
    });
});

describe("L4 readWorkspaceFiles", () => {
    let base;
    let folder;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-loads-read-")));
        folder = path.join(base, "me");
        write(path.join(folder, "a.agent.md"), agentText("a"));
        write(path.join(folder, "skills", "notes", "SKILL.md"), skillText("notes"));
        write(path.join(folder, "big.agent.md"), "x".repeat(MAX_LOAD_FILE_BYTES + 1));
        write(path.join(base, "other", "secret.agent.md"), agentText("secret"));
        write(path.join(base, "other", "evil", "SKILL.md"), skillText("evil"));
        fs.symlinkSync(path.join(base, "other", "secret.agent.md"), path.join(folder, "link.agent.md"));
        fs.mkdirSync(path.join(folder, "skills", "linked"), { recursive: true });
        fs.symlinkSync(path.join(base, "other", "evil", "SKILL.md"), path.join(folder, "skills", "linked", "SKILL.md"));
        fs.symlinkSync(path.join(folder, "a.agent.md"), path.join(folder, "inside.agent.md"));
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    const ask = (kind, file) => ({ kind, path: path.join(folder, file), within: folder });

    it("reads agents and skills, in request order", async () => {
        const [agent, skillFolder, skillFile, inside] = await readWorkspaceFiles([
            ask("agent", "a.agent.md"), ask("skill", "skills/notes"), ask("skill", "skills/notes/SKILL.md"), ask("agent", "inside.agent.md"),
        ]);
        assert.deepEqual([agent.ok, agent.content, agent.realPath], [true, agentText("a"), path.join(folder, "a.agent.md")]);
        assert.deepEqual([skillFolder.ok, skillFolder.folder, skillFolder.content], [true, path.join(folder, "skills", "notes"), skillText("notes")]);
        assert.equal(skillFile.folder, path.join(folder, "skills", "notes"), "a SKILL.md path means its folder");
        assert.equal(inside.ok, true, "a link that stays inside the folder is fine");
        assert.deepEqual(await readWorkspaceFiles([]), []);
    });

    it("refuses links out, big files, the wrong kind and missing files", async () => {
        const reasons = (await readWorkspaceFiles([
            ask("agent", "link.agent.md"),
            ask("skill", "skills/linked"),
            ask("agent", "big.agent.md"),
            ask("skill", "a.agent.md"),
            ask("agent", "skills"),
            ask("agent", "missing.agent.md"),
        ])).map((result) => result.ok ? "ok" : result.reason);
        assert.deepEqual(reasons, [
            "it resolves outside the folder it is in",
            "its SKILL.md resolves outside the folder it is in",
            "larger than 64 KB",
            "a skill is a folder with a SKILL.md, or that SKILL.md file",
            "not a regular file",
            "no such file or folder",
        ]);
    });

    it("a folder that does not answer in time fails every request", async () => {
        const results = await readWorkspaceFiles([ask("agent", "a.agent.md"), ask("skill", "skills/notes")], { timeoutMs: 1 });
        assert.deepEqual(results, [
            { ok: false, reason: "the folder did not answer within 1 ms" },
            { ok: false, reason: "the folder did not answer within 1 ms" },
        ]);
    });
});

describe("L5 resolveWorkspaceLoads", () => {
    let base;
    let folders;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-loads-turn-")));
        const home = path.join(base, "home");
        const shared = path.join(base, "shared");
        write(path.join(home, "users", "me", "agents", "helper.agent.md"), agentText("helper"));
        write(path.join(home, "users", "me", "agents", "renamed.agent.md"), agentText("other-name"));
        write(path.join(home, "users", "me", "skills", "notes", "SKILL.md"), skillText("notes", "NOTES-BODY"));
        write(path.join(home, "users", "other", "agents", "theirs.agent.md"), agentText("theirs"));
        write(path.join(shared, "reviewer.agent.md"), agentText("reviewer"));
        folders = [
            { root: "home", rootPath: home, path: path.join(home, "users", "me") },
            { root: "shared", rootPath: shared, path: shared },
        ];
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it("reads each load again inside this turn's folders; the rest are left out with the reason", async () => {
        const resolved = await resolveWorkspaceLoads([
            load("agent", "helper", "home", "users/me/agents/helper.agent.md"),
            load("skill", "notes", "home", "users/me/skills/notes"),
            load("agent", "reviewer", "shared", "reviewer.agent.md"),
            load("agent", "gone", "home", "users/me/agents/gone.agent.md"),
            load("agent", "renamed", "home", "users/me/agents/renamed.agent.md"),
            load("agent", "theirs", "home", "users/other/agents/theirs.agent.md"),
            load("skill", "logs", "logs", "skills/logs"),
        ], folders);
        assert.equal(resolved.source.kind, "loaded");
        assert.deepEqual(resolved.source.scan.agents.map((agent) => agent.file), ["home:users/me/agents/helper.agent.md", "shared:reviewer.agent.md"]);
        assert.deepEqual(resolved.source.adopt, { agents: true, skills: false, instructions: false });
        assert.deepEqual(resolved.source.skillFolders, [{ name: "notes", path: path.join(base, "home", "users", "me", "skills", "notes") }]);
        assert.deepEqual(resolved.skillCatalog, [{ name: "notes", description: "notes skill", prompt: "NOTES-BODY" }]);
        assert.deepEqual(resolved.skipped.map((skip) => [skip.name, skip.reason, skip.source]), [
            ["theirs", "its folder is not attached in this turn", "loaded"],
            ["logs", "its folder is not attached in this turn", "loaded"],
            ["gone", "no such file or folder", "loaded"],
            ["renamed", "the file now names agent \"other-name\"; load it again", "loaded"],
        ]);
    });

    it("nothing readable: no source", async () => {
        const resolved = await resolveWorkspaceLoads([load("agent", "gone", "home", "users/me/gone.agent.md")], folders);
        assert.equal("source" in resolved, false);
        assert.equal(resolved.skipped.length, 1);
    });
});

describe("L6 the declarations", () => {
    const find = (tools, name) => tools.find((tool) => tool.name === name);

    it("without the workspace tools: no load_agent, and load_skill is unchanged", () => {
        const tools = ManagedSession.systemToolDefs({});
        assert.equal(find(tools, "load_agent"), undefined);
        const loadSkill = find(tools, "load_skill");
        assert.deepEqual(Object.keys(loadSkill.parameters.properties), ["name"]);
        assert.deepEqual(loadSkill.parameters.required, ["name"]);
        assert.doesNotMatch(loadSkill.description, /path/);
    });

    it("with the workspace tools: load_skill takes a path or an unload, and load_agent is declared", () => {
        const tools = ManagedSession.systemToolDefs({ workspaceTools: true });
        const loadSkill = find(tools, "load_skill");
        assert.deepEqual(Object.keys(loadSkill.parameters.properties), ["name", "path", "unload"]);
        assert.equal(loadSkill.parameters.required, undefined, "none of name, path or unload is required on its own");
        assert.deepEqual(Object.keys(find(tools, "load_agent").parameters.properties), ["path", "unload"]);
    });

    it("load_agent is a reserved tool name", () => {
        assert.equal(findReservedPackageToolName(["load_agent"], [], []), "load_agent");
    });
});

describe("L7 the load helpers behind the tools", () => {
    let base;
    let session;
    let saved;
    let tasks;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-loads-tool-")));
        write(path.join(base, "home", "users", "me", "deep", "a", "b", "c", "finder.agent.md"), agentText("finder"));
        write(path.join(base, "home", "users", "me", "deep", "skills", "digest", "SKILL.md"), skillText("digest", "DIGEST-BODY"));
        write(path.join(base, "home", "users", "me", "bad.agent.md"), "---\nname: bad\n");
        write(path.join(base, "elsewhere", "x.agent.md"), agentText("x"));
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    const fresh = (services) => {
        saved = [];
        tasks = [];
        session = Object.create(ManagedSession.prototype);
        session.config = {
            workspaceTools: true,
            workspaceAttach: { root: "home", rootPath: path.join(base, "home"), path: path.join(base, "home", "users", "me"), extras: [] },
            capabilityServices: services === undefined ? {
                saveWorkspaceLoad: async (change) => {
                    if ("remove" in change && !saved.some((s) => s.add?.name === change.remove.name)) throw new Error(`no ${change.remove.kind} named "${change.remove.name}" is loaded by path in this session`);
                    saved.push(change);
                    return { loads: [] };
                },
            } : services,
        };
        session.copilotSession = { rpc: { tasks: { list: async () => ({ tasks }) } } };
    };

    it("an agent deep in a folder: saved relative to its root", async () => {
        fresh();
        const result = await session.loadByPath("agent", "deep/a/b/c/finder.agent.md");
        assert.deepEqual([result.ok, result.name, result.absolute], [true, "finder", path.join(base, "home", "users", "me", "deep", "a", "b", "c", "finder.agent.md")]);
        assert.deepEqual(saved, [{ add: { kind: "agent", name: "finder", root: "home", path: "users/me/deep/a/b/c/finder.agent.md" } }]);
    });

    it("a skill named by its SKILL.md is saved as its folder, and its body comes back", async () => {
        fresh();
        const result = await session.loadByPath("skill", path.join(base, "home", "users", "me", "deep", "skills", "digest", "SKILL.md"));
        assert.deepEqual([result.ok, result.name, result.body], [true, "digest", "DIGEST-BODY"]);
        assert.deepEqual(saved, [{ add: { kind: "skill", name: "digest", root: "home", path: "users/me/deep/skills/digest" } }]);
    });

    it("refused: outside the folders, a broken file, a busy session, no storage; nothing is saved", async () => {
        fresh();
        assert.match((await session.loadByPath("agent", path.join(base, "elsewhere", "x.agent.md"))).error, /is not inside the working folder or an extra folder/);
        assert.match((await session.loadByPath("agent", "bad.agent.md")).error, /^cannot load .*bad\.agent\.md: /);
        assert.match((await session.loadByPath("agent", "missing.agent.md")).error, /no such file or folder/);
        tasks = [{ id: "t1", type: "agent", status: "running" }];
        assert.match((await session.loadByPath("agent", "deep/a/b/c/finder.agent.md")).error, /^WORKSPACE_BUSY: 1 background task\(s\) are running \(agent t1\)/);
        assert.match((await session.unloadByPath("agent", "finder")).error, /^WORKSPACE_BUSY/);
        assert.deepEqual(saved, []);
        fresh(null);
        assert.equal((await session.loadByPath("agent", "deep/a/b/c/finder.agent.md")).error, "this session cannot save loaded agents or skills");
    });

    it("unload drops a load by name; an unknown name is an error", async () => {
        fresh();
        await session.loadByPath("agent", "deep/a/b/c/finder.agent.md");
        assert.deepEqual(await session.unloadByPath("agent", " finder "), { ok: true });
        assert.deepEqual(saved.at(-1), { remove: { kind: "agent", name: "finder" } });
        assert.deepEqual(await session.unloadByPath("skill", "nope"), { ok: false, error: "no skill named \"nope\" is loaded by path in this session" });
        assert.deepEqual(await session.unloadByPath("skill", ""), { ok: false, error: "unload needs the name" });
    });
});
