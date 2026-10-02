/**
 * Default folders and a person's own agents, skills and instructions
 * (docs/proposals/session-workspaces.md, section 4.11).
 *
 *   D1  applyWorkspaceDefaults: the record wins; the default home folder is
 *       the working folder or an extra folder; names and overlaps; defaults
 *       do not count against the extra-folder limit
 *   D2  resolveWorkspaceDefaults: no hook, a throw, a slow provider
 *   D3  combineWorkspaceProviders merges the providers' defaults
 *   D4  the path check adopts from a folder without git when asked, and
 *       reads instruction text within a bound
 *   D5  prepareWorkspaceExtras lets only the named extra folder adopt
 *   D6  resolveWorkspaceAdoption: loaded, then repo, then personal; skills
 *       from several sources are linked
 *   D7  linkSkillFolders keeps one link per adopted skill
 *   D8  notes and the personal instructions section
 *   D13 the defaults record for session.workspace_defaults: built from the
 *       applied defaults, read back from a stored event, compared; the
 *       defaults left out are listed under `skipped`
 *   D14 the "Your folders are durable" section: only with folders, after
 *       PilotSwarm's base, and the same text every time; the Base V2 prompt's
 *       sentence about the worker's own disk
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    applyWorkspaceDefaults,
    combineWorkspaceProviders,
    createBuiltInWorkspaceProvider,
    prepareWorkspace,
    prepareWorkspaceExtras,
    resolveWorkspaceDefaults,
    defaultsRecordOf,
    readDefaultsRecord,
    sameDefaultsRecord,
} from "../../dist/workspace.js";
import { MAX_WORKSPACE_EXTRAS, checkWorkspacePath } from "../../dist/workspace-check.js";
import { adoptionNote, linkSkillFolders, resolveRepoAdoption, resolveWorkspaceAdoption } from "../../dist/workspace-repo-agents.js";
import { DURABLE_FOLDERS_NOTE, withDurableFoldersNote, withPersonalInstructions } from "../../dist/session-manager.js";
import { baseAgentInstructions } from "../../dist/base-agent-policy.js";

const clone = { schema: 1, root: "a", folder: "sessions/t/app" };
const HOME = { name: "home", root: "home", folder: "users/me" };
const SHARED = { shared: { root: "shared" } };

describe("D1 applyWorkspaceDefaults", () => {
    it("no defaults: the record, unchanged", () => {
        assert.deepEqual(applyWorkspaceDefaults(clone, null), { workspace: clone, defaultNames: [], homeIsWorkingFolder: false, skipped: [] });
        assert.equal(applyWorkspaceDefaults(null, undefined).workspace, null);
    });

    it("no record: the default home folder is the working folder; default extras join it", () => {
        const result = applyWorkspaceDefaults(null, { home: HOME, extra: SHARED });
        assert.deepEqual(result.workspace, { schema: 1, root: "home", folder: "users/me", extra: { shared: { root: "shared", required: false } } });
        assert.equal(result.homeIsWorkingFolder, true);
        assert.equal(result.homeExtra, undefined);
        assert.deepEqual(result.defaultNames, ["shared"]);
    });

    it("no record and no home: no working folder, so no extra folders either", () => {
        const result = applyWorkspaceDefaults(null, { extra: SHARED });
        assert.equal(result.workspace, null);
        assert.deepEqual(result.skipped, [{ name: "shared", reason: "the session has no working folder" }]);
    });

    it("a record with a working folder elsewhere: the home folder becomes extra folder \"home\"", () => {
        const result = applyWorkspaceDefaults(clone, { home: HOME, extra: SHARED });
        assert.deepEqual(result.workspace, {
            schema: 1, root: "a", folder: "sessions/t/app",
            extra: { home: { root: "home", folder: "users/me", required: false }, shared: { root: "shared", required: false } },
        });
        assert.equal(result.homeExtra, "home");
        assert.equal(result.homeIsWorkingFolder, false);
        assert.deepEqual(result.defaultNames, ["home", "shared"]);
    });

    it("the record wins: its name, its folder; the same folder as the working folder is not added again", () => {
        const named = applyWorkspaceDefaults({ ...clone, extra: { home: { root: "logs" } } }, { home: HOME });
        assert.deepEqual(named.workspace.extra, { home: { root: "logs" } });
        assert.deepEqual(named.skipped, [{ name: "home", reason: "the session's record uses this name" }]);
        const same = applyWorkspaceDefaults({ schema: 1, root: "home", folder: "users/me" }, { home: HOME });
        assert.equal(same.homeIsWorkingFolder, true);
        assert.equal(same.workspace.extra, undefined);
    });

    it("overlaps are left out: a working folder inside the home folder, a default inside a record's extra folder", () => {
        const inside = applyWorkspaceDefaults({ schema: 1, root: "home", folder: "users/me/project" }, { home: HOME });
        assert.equal(inside.workspace.extra, undefined);
        assert.deepEqual(inside.skipped, [{ name: "home", reason: "it overlaps the working folder" }]);
        const nested = applyWorkspaceDefaults({ ...clone, extra: { notes: { root: "shared" } } }, { extra: { team: { root: "shared", folder: "team" } } });
        assert.deepEqual(nested.skipped, [{ name: "team", reason: "it overlaps extra folder \"notes\"" }]);
    });

    it("defaults do not count against the limit of extra folders", () => {
        const extra = Object.fromEntries(Array.from({ length: MAX_WORKSPACE_EXTRAS }, (_, i) => [`e${i}`, { root: "logs", folder: `f${i}` }]));
        const result = applyWorkspaceDefaults({ ...clone, extra }, { home: HOME, extra: SHARED });
        assert.equal(Object.keys(result.workspace.extra).length, MAX_WORKSPACE_EXTRAS + 2);
    });

    it("a bad default is left out with the reason; required is kept only when true", () => {
        const result = applyWorkspaceDefaults(clone, { extra: { "Bad Name": { root: "x" }, abs: { root: "x", folder: "/etc" }, work: { root: "x" }, must: { root: "logs", required: true } } });
        assert.deepEqual(result.skipped.map((s) => s.name).sort(), ["Bad Name", "abs", "work"], "\"work\" is what canvas apps call the working folder");
        assert.deepEqual(result.workspace.extra, { must: { root: "logs", required: true } });
    });
});

describe("D2 resolveWorkspaceDefaults", () => {
    const ctx = { sessionId: "s", rootSessionId: "s", owner: null, isSystem: true };
    it("no hook, a throw, or a slow provider gives no defaults, and says why", async () => {
        assert.equal(await resolveWorkspaceDefaults({ listRoots: async () => [] }, ctx), null);
        const errors = [];
        assert.equal(await resolveWorkspaceDefaults({ defaultFolders: () => { throw new Error("boom"); } }, ctx, { onError: (m) => errors.push(m) }), null);
        assert.equal(await resolveWorkspaceDefaults({ defaultFolders: () => new Promise(() => {}) }, ctx, { timeoutMs: 20, onError: (m) => errors.push(m) }), null);
        assert.deepEqual(errors.map((m) => m.split(":")[0].split(" ")[0]), ["defaultFolders", "defaultFolders"]);
        assert.match(errors[0], /boom/);
        assert.match(errors[1], /20 ms/);
        assert.deepEqual(await resolveWorkspaceDefaults({ defaultFolders: (c) => ({ home: { ...HOME, folder: `users/${c.isSystem ? "_system" : "x"}` } }) }, ctx),
            { home: { ...HOME, folder: "users/_system" } }, "the provider sees the context");
    });
});

describe("D3 combineWorkspaceProviders", () => {
    it("the first provider's home wins; extra folders merge by name, the first winning; none gives null", async () => {
        const a = { listRoots: async () => [{ name: "a", path: "/a" }], ensureAttached: async () => ({ ok: false, code: "X", message: "x" }),
            defaultFolders: () => ({ home: HOME, extra: { shared: { root: "shared" } } }) };
        const b = { listRoots: async () => [{ name: "b", path: "/b" }], ensureAttached: async () => ({ ok: false, code: "X", message: "x" }),
            defaultFolders: () => ({ home: { name: "home", root: "b" }, extra: { shared: { root: "b" }, logs: { root: "b", folder: "logs" } } }) };
        const combined = combineWorkspaceProviders([a, b]);
        assert.deepEqual(await combined.defaultFolders({}), { home: HOME, extra: { shared: { root: "shared" }, logs: { root: "b", folder: "logs" } } });
        const none = combineWorkspaceProviders([{ listRoots: async () => [] }]);
        assert.equal(none.defaultFolders, undefined, "no provider has the hook: the combined one has none");
        const empty = combineWorkspaceProviders([{ ...a, defaultFolders: () => null }]);
        assert.equal(await empty.defaultFolders({}), null);
    });
});

describe("D4-D5 the path check and prepareWorkspaceExtras on a person's folder", () => {
    let base;
    let roots;
    before(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-defaults-")));
        const me = path.join(base, "home", "users", "me");
        fs.mkdirSync(path.join(me, ".github", "agents"), { recursive: true });
        fs.mkdirSync(path.join(me, ".github", "skills", "notes"), { recursive: true });
        fs.writeFileSync(path.join(me, ".github", "agents", "helper.agent.md"), "---\nname: helper\ndescription: My helper\n---\nHelp me.\n");
        fs.writeFileSync(path.join(me, ".github", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Keep notes\n---\nKeep notes in notes/.\n");
        fs.writeFileSync(path.join(me, "AGENTS.md"), "Always answer in short sentences.\n");
        fs.mkdirSync(path.join(base, "shared"), { recursive: true });
        roots = [{ name: "home", path: path.join(base, "home") }, { name: "shared", path: path.join(base, "shared") }];
    });
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it("D4 without folder mode nothing is adopted outside a clone; with it, agents, skills and the instruction text are", async () => {
        const target = path.join(base, "home", "users", "me");
        const collect = { agents: true, skills: true, instructions: true };
        const plain = await checkWorkspacePath({ rootName: "home", rootPath: roots[0].path, path: target, collect });
        assert.equal(plain.repo.agents.length, 0);
        assert.ok(plain.repo.skipped.some((s) => /not inside a git clone/.test(s.reason)));
        const folder = await checkWorkspacePath({ rootName: "home", rootPath: roots[0].path, path: target, collect: { ...collect, folder: true, instructionText: true } });
        assert.equal(folder.repo.folderRoot, true);
        assert.deepEqual(folder.repo.agents.map((a) => a.file), [".github/agents/helper.agent.md"]);
        assert.deepEqual(folder.repo.skills, ["notes"]);
        assert.deepEqual(folder.repo.instructionText, [{ file: "AGENTS.md", content: "Always answer in short sentences.\n" }]);
    });

    it("D5 only the extra folder named by adoptFrom adopts, and its scan comes back", async () => {
        const inner = createBuiltInWorkspaceProvider(roots);
        const provider = { ...inner, ensureAttached: async (req) => ({ ...(await inner.ensureAttached(req)), adopt: { agents: true, skills: true, instructions: true, folder: true } }) };
        const req = { sessionId: "s", rootSessionId: "s", revision: 1, workerNodeId: "w", turnIndex: 1, purpose: "turn",
            workspace: { schema: 1, root: "shared", extra: { home: { root: "home", folder: "users/me" }, other: { root: "home", folder: "users" } } } };
        // "other" overlaps "home" in a real record; the test only checks which one adopts.
        const extras = await prepareWorkspaceExtras(provider, req, { adoptFrom: "home" });
        const home = extras.find((e) => e.name === "home");
        const other = extras.find((e) => e.name === "other");
        assert.deepEqual(home.adopt, { agents: true, skills: true, instructions: true, folder: true });
        assert.deepEqual(home.repo.skills, ["notes"]);
        assert.equal(other.adopt, undefined);
        assert.equal(other.repo, undefined);
        const none = await prepareWorkspaceExtras(provider, req);
        assert.ok(none.every((e) => e.adopt === undefined), "without adoptFrom, no extra folder adopts");
        // One level down: an extra folder is not even scanned unless it may adopt.
        const extraReq = { ...req, workspace: { schema: 1, root: "home", folder: "users/me" }, attachment: "home" };
        const plain = await prepareWorkspace(provider, extraReq);
        assert.equal(plain.adopt, undefined, "an extra folder adopts nothing by default");
        assert.equal(plain.repo, undefined, "and is not scanned");
        const allowed = await prepareWorkspace(provider, extraReq, { adoptExtra: true });
        assert.deepEqual(allowed.repo.skills, ["notes"], "the default home folder is scanned");
    });
});

describe("D6-D7 resolveWorkspaceAdoption and linked skills", () => {
    const base = { nativeTasks: true, sessionModel: "m", pilotswarmToolNames: new Set(), reservedAgentNames: new Set() };
    const ALL = { agents: true, skills: true, instructions: false };
    const agent = (name, text) => ({ file: `.github/agents/${name}.agent.md`, content: `---\nname: ${name}\ndescription: ${text}\n---\n${text}\n` });
    const repo = { kind: "repo", adopt: ALL, attachPath: "/ws/a/c", scan: { agents: [agent("reviewer", "repo reviewer"), agent("tester", "repo tester")], skills: ["build"], skipped: [], cloneRoot: "" } };
    const personal = { kind: "personal", adopt: ALL, attachPath: "/ws/home/users/me", scan: { agents: [agent("reviewer", "my reviewer"), agent("helper", "my helper")], skills: ["build", "notes"], skipped: [], cloneRoot: "" } };
    const loaded = { kind: "loaded", adopt: ALL, attachPath: "/ws/shared", scan: { agents: [agent("tester", "loaded tester")], skills: [], skipped: [], cloneRoot: "" },
        skillFolders: [{ name: "notes", path: "/ws/shared/skills/notes" }] };

    it("the repo alone: exactly resolveRepoAdoption, with its skills folder given directly", () => {
        const one = resolveWorkspaceAdoption({ ...base, sources: [repo] });
        const plain = resolveRepoAdoption({ ...base, scan: repo.scan, adopt: repo.adopt, attachPath: repo.attachPath });
        assert.deepEqual(one.customAgents, plain.customAgents);
        assert.deepEqual(one.report, plain.report);
        assert.equal(one.hash, plain.hash);
        assert.deepEqual(one.skillDirectories, ["/ws/a/c/.github/skills"]);
        assert.equal(one.linkSkills, false);
    });

    it("repo beats personal; loaded beats both; each loser is reported with the winner", () => {
        const all = resolveWorkspaceAdoption({ ...base, sources: [loaded, repo, personal] });
        assert.deepEqual(all.customAgents.map((a) => [a.name, a.description]), [
            ["tester", "loaded tester"], ["reviewer", "repo reviewer"], ["helper", "my helper"],
        ]);
        assert.deepEqual(all.report.agents, ["reviewer"]);
        assert.deepEqual(all.report.personal, { agents: ["helper"], skills: [] });
        assert.deepEqual(all.report.loaded, { agents: ["tester"], skills: ["notes"] });
        assert.deepEqual(all.report.skills, ["build"]);
        const skips = all.report.skipped.map((s) => [s.kind, s.name, s.source ?? "repo", s.reason]);
        assert.deepEqual(skips, [
            ["agent", "tester", "repo", "a loaded agent has this name"],
            ["agent", "reviewer", "personal", "the repo's agent has this name"],
            ["skill", "build", "personal", "the repo's skill has this name"],
            ["skill", "notes", "personal", "a loaded skill has this name"],
        ]);
        assert.equal(all.linkSkills, true, "skills from several sources are linked");
        assert.deepEqual(all.skillDirectories, []);
        assert.deepEqual(all.skills.map((s) => [s.name, s.path, s.kind]), [
            ["notes", "/ws/shared/skills/notes", "loaded"], ["build", "/ws/a/c/.github/skills/build", "repo"],
        ]);
    });

    it("the person's folder as the only source: its own skills folder, given directly", () => {
        const only = resolveWorkspaceAdoption({ ...base, sources: [{ ...personal, scan: { ...personal.scan, skills: ["notes"] } }] });
        assert.deepEqual(only.report.personal, { agents: ["helper", "reviewer"], skills: ["notes"] });
        assert.deepEqual(only.report.agents, []);
        assert.equal(only.linkSkills, false);
        assert.deepEqual(only.skillDirectories, ["/ws/home/users/me/.github/skills"]);
    });

    it("D7 linkSkillFolders: one link per skill; a changed target is replaced; a gone skill is removed", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-links-"));
        try {
            const a = fs.mkdtempSync(path.join(os.tmpdir(), "ps-skill-a-"));
            const b = fs.mkdtempSync(path.join(os.tmpdir(), "ps-skill-b-"));
            linkSkillFolders(dir, [{ name: "one", path: a }, { name: "two", path: b }]);
            assert.deepEqual(fs.readdirSync(dir).sort(), ["one", "two"]);
            assert.equal(fs.readlinkSync(path.join(dir, "one")), a);
            linkSkillFolders(dir, [{ name: "one", path: b }]);
            assert.deepEqual(fs.readdirSync(dir), ["one"]);
            assert.equal(fs.readlinkSync(path.join(dir, "one")), b);
            fs.rmSync(a, { recursive: true, force: true });
            fs.rmSync(b, { recursive: true, force: true });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("D8 notes and the personal instructions section", () => {
    it("the note names each source; a repo-only note reads as before", () => {
        const report = { agents: ["reviewer"], skills: [], skipped: [], personal: { agents: ["helper"], skills: ["notes"] }, loaded: { agents: ["tester"], skills: [] } };
        assert.equal(adoptionNote(null, report), "Repo agents available through the task tool: reviewer. Your own agents available through the task tool: helper. "
            + "Your own skills available: notes. Loaded agents available through the task tool: tester.");
        assert.equal(adoptionNote(report, { ...report, personal: { agents: [], skills: ["notes"] } }), "Your own agents changed: added none, removed helper.");
        assert.equal(adoptionNote(null, { agents: ["a"], skills: ["b"], skipped: [] }), "Repo agents available through the task tool: a. Repo skills available: b.");
    });

    it("withPersonalInstructions appends after PilotSwarm's base; nothing to add leaves the message alone", () => {
        const message = { mode: "customize", sections: { custom_instructions: { action: "prepend", content: "BASE" } } };
        const out = withPersonalInstructions(message, [{ file: "AGENTS.md", content: "Short sentences.\n" }], "/ws/home/users/me");
        const text = out.sections.custom_instructions.content;
        assert.ok(text.startsWith("BASE\n\n# Your own instructions"), text);
        assert.ok(text.includes("## AGENTS.md\n\nShort sentences."), text);
        assert.equal(out.sections.custom_instructions.action, "prepend");
        assert.equal(withPersonalInstructions(message, [{ file: "AGENTS.md", content: "  \n" }], "/x"), message);
        assert.equal(withPersonalInstructions(message, [], "/x"), message);
    });
});

describe("D13 the defaults record", () => {
    const HOME = { name: "home", root: "home", folder: "users/me" };
    const SHARED = { shared: { root: "shared" } };
    it("the person's folder as the working folder only when the record has none; default extra folders, home marked", () => {
        assert.deepEqual(defaultsRecordOf(applyWorkspaceDefaults(null, { home: HOME, extra: SHARED }), false), {
            workingFolder: { root: "home", folder: "users/me" },
            extra: [{ name: "shared", root: "shared" }],
        });
        const clone = { schema: 1, root: "a", folder: "sessions/t/app" };
        assert.deepEqual(defaultsRecordOf(applyWorkspaceDefaults(clone, { home: HOME, extra: SHARED }), true), {
            workingFolder: null,
            extra: [{ name: "home", root: "home", folder: "users/me", home: true }, { name: "shared", root: "shared" }],
        });
        const own = { schema: 1, root: "home", folder: "users/me" };
        assert.equal(defaultsRecordOf(applyWorkspaceDefaults(own, { home: HOME }), true), null,
            "the record names the person's folder itself: it is the record's, not a default");
        assert.equal(defaultsRecordOf(applyWorkspaceDefaults(null, { extra: SHARED }), false), null,
            "extra folders only, and no working folder: nothing applied (rule A)");
        assert.equal(defaultsRecordOf(applyWorkspaceDefaults(clone, null), true), null, "no defaults");
    });

    it("an extra folder inside the person's folder: the record says the home default was left out, and why", () => {
        const clone = { schema: 1, root: "a", folder: "sessions/t/app" };
        const inside = { ...clone, extra: { notes: { root: "home", folder: "users/me/notes" } } };
        // Only a skip: the record still exists, so the portal and the tools can say so.
        assert.deepEqual(defaultsRecordOf(applyWorkspaceDefaults(inside, { home: HOME }), true), {
            workingFolder: null,
            extra: [],
            skipped: [{ name: "home", reason: "it overlaps extra folder \"notes\"" }],
        });
        // With another default used, the skip rides along.
        assert.deepEqual(defaultsRecordOf(applyWorkspaceDefaults(inside, { home: HOME, extra: SHARED }), true), {
            workingFolder: null,
            extra: [{ name: "shared", root: "shared" }],
            skipped: [{ name: "home", reason: "it overlaps extra folder \"notes\"" }],
        });
        // Nothing skipped: no skipped key, as before.
        assert.equal("skipped" in defaultsRecordOf(applyWorkspaceDefaults(clone, { home: HOME }), true), false);

        // The stored event reads back with its skips; a change of skips is a change.
        const read = readDefaultsRecord({ revision: 2, workingFolder: null, extra: [], skipped: [{ name: "home", reason: "it overlaps extra folder \"notes\"" }, { name: 7 }] });
        assert.deepEqual(read, { workingFolder: null, extra: [], skipped: [{ name: "home", reason: "it overlaps extra folder \"notes\"" }] });
        assert.equal(sameDefaultsRecord(read, { workingFolder: null, extra: [] }), false, "a skip that goes away is recorded");
        assert.equal(sameDefaultsRecord(read, { workingFolder: null, extra: [], skipped: [{ name: "home", reason: "it overlaps the working folder" }] }), false);
        assert.equal(sameDefaultsRecord(read, { extra: [], workingFolder: null, skipped: [{ reason: "it overlaps extra folder \"notes\"", name: "home" }] }), true);
    });

    it("a stored record reads back whatever its key order; empty or malformed reads as none; compare ignores order", () => {
        const stored = { extra: [{ root: "shared", name: "shared" }, { home: true, folder: "users/me", root: "home", name: "home" }], revision: 3, workingFolder: null };
        const read = readDefaultsRecord(stored);
        assert.deepEqual(read, { workingFolder: null, extra: [{ name: "shared", root: "shared" }, { name: "home", root: "home", folder: "users/me", home: true }] });
        assert.equal(sameDefaultsRecord(read, { workingFolder: null, extra: [{ name: "home", root: "home", folder: "users/me", home: true }, { name: "shared", root: "shared" }] }), true);
        assert.equal(sameDefaultsRecord(read, { workingFolder: null, extra: [{ name: "shared", root: "shared" }] }), false);
        assert.equal(sameDefaultsRecord(read, { workingFolder: { root: "home", folder: "users/me" }, extra: read.extra }), false);
        assert.equal(readDefaultsRecord({ workingFolder: null, extra: [] }), null);
        assert.equal(readDefaultsRecord({ extra: [{ name: 1, root: "x" }, { name: "x" }] }), null);
        assert.equal(readDefaultsRecord(undefined), null);
        assert.equal(sameDefaultsRecord(null, null), true);
        assert.equal(sameDefaultsRecord(null, read), false);
    });
});

describe("D14 the durable folders section", () => {
    it("added after PilotSwarm's base only when the turn has folders; the text never changes", () => {
        const message = { mode: "customize", sections: { custom_instructions: { action: "prepend", content: "BASE" } } };
        const out = withDurableFoldersNote(message, true);
        assert.equal(out.sections.custom_instructions.content, `BASE\n\n${DURABLE_FOLDERS_NOTE}`);
        assert.deepEqual(withDurableFoldersNote(message, true), out, "the same input gives the same text: the prompt cache holds");
        assert.equal(out.sections.custom_instructions.action, "prepend");
        assert.equal(withDurableFoldersNote(message, false), message, "no folders: the same message");
        assert.equal(withDurableFoldersNote({ content: "BASE" }, true).content, `BASE\n\n${DURABLE_FOLDERS_NOTE}`);
        assert.equal(withDurableFoldersNote(undefined, true), undefined);
        assert.match(DURABLE_FOLDERS_NOTE, /^## Your folders are durable\n\n/);
        assert.match(DURABLE_FOLDERS_NOTE, /replaces "Local Filesystem Is Ephemeral"/);
        assert.doesNotMatch(DURABLE_FOLDERS_NOTE, /\/ws\//, "it names no path, so it cannot go stale");
    });

    it("the Base V2 prompt says a working directory on the worker's own disk may be gone, not the cwd", () => {
        // Base V1 is checked on a real worker (S1-S3); V2 sessions get exactly this text.
        const v2 = baseAgentInstructions({ version: "v2", fingerprint: "x", revision: null }, "LEGACY");
        assert.notEqual(v2, "LEGACY");
        assert.match(v2, /`\/tmp`, `\$HOME`, and a working directory on the worker's own disk may simply be gone next turn\./);
        assert.doesNotMatch(v2, /and the cwd may simply be gone/);
    });
});
