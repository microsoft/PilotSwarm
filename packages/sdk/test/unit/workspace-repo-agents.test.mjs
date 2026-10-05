/**
 * Session workspaces: repo agents and skills
 * (docs/proposals/session-workspaces.md, section 4.6).
 *
 *   - the path check reads .github/agents and names .github/skills, inside
 *     its deadline, and never reads a file that leaves the workspace
 *   - parseRepoAgentFile, resolveRepoAdoption: the filters and the report
 *   - adoptionNote, RepoAgentAccess, and the native child guard
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    checkWorkspacePath, MAX_REPO_AGENTS, MAX_REPO_AGENT_BYTES, MAX_REPO_AGENT_OVERFLOW, MAX_REPO_SKILL_ENTRIES,
} from "../../dist/workspace-check.js";
import { prepareWorkspace } from "../../dist/workspace.js";
import { parseRepoAgentFile, resolveRepoAdoption, adoptionNote, sameAdoption, RepoAgentAccess, groupSkipped } from "../../dist/workspace-repo-agents.js";
import { nativeTaskAgentMarks } from "../../dist/native-task-observer.js";
import { nativeSubagentHooks } from "../../dist/native-subagents.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const temps = [];
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * A root with one git clone, `repo`; `files` maps paths relative to the clone
 * to contents. `git: false` leaves out `.git`. `sub` makes the workspace a
 * folder inside the clone.
 */
function workspace(files = {}, { git = true, sub } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-repo-agents-")));
    temps.push(root);
    const clone = path.join(root, "repo");
    fs.mkdirSync(clone);
    if (git) fs.mkdirSync(path.join(clone, ".git"));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
        fs.writeFileSync(path.join(clone, rel), content);
    }
    const folder = sub ? path.join(clone, sub) : clone;
    fs.mkdirSync(folder, { recursive: true });
    return { root, clone, folder };
}

const agentFile = (name, tools = '["read"]') => `---\nname: ${name}\ndescription: The ${name} agent.\ntools: ${tools}\n---\n\nYou are ${name}.\n`;
const check = (ws, collect) => checkWorkspacePath({ rootName: `r-${path.basename(ws.root)}`, rootPath: ws.root, path: ws.folder, collect });

describe("the path check collects repo agents and skills", () => {
    it("reads agent files in name order and names the skills; nothing without collect", async () => {
        const ws = workspace({
            ".github/agents/b.agent.md": agentFile("b"),
            ".github/agents/a.agent.md": agentFile("a"),
            ".github/agents/notes.md": "not an agent",
            ".github/skills/build/SKILL.md": "---\nname: build\n---\nbuild it\n",
            ".github/skills/empty/README.md": "no skill here",
        });
        const plain = await check(ws);
        assert.equal(plain.ok, true);
        assert.equal("repo" in plain, false, "no repo field without collect");

        const both = await check(ws, { agents: true, skills: true });
        assert.equal(both.ok, true);
        assert.deepEqual(both.repo.agents.map((a) => a.file), [".github/agents/a.agent.md", ".github/agents/b.agent.md"]);
        assert.match(both.repo.agents[0].content, /You are a\./);
        assert.deepEqual(both.repo.skills, ["build"]);
        assert.deepEqual(both.repo.skipped, []);
        assert.equal(both.repo.cloneRoot, "", "the workspace is the clone root");

        const agentsOnly = await check(ws, { agents: true });
        assert.deepEqual(agentsOnly.repo.skills, []);
    });

    it("skips an agent file over 64 KB and agents past the 30th", async () => {
        const files = { ".github/agents/big.agent.md": agentFile("big") + "x".repeat(MAX_REPO_AGENT_BYTES) };
        for (let i = 0; i < MAX_REPO_AGENTS + 2; i++) files[`.github/agents/n${String(i).padStart(2, "0")}.agent.md`] = agentFile(`n${i}`);
        const result = await check(workspace(files), { agents: true });
        assert.equal(result.repo.agents.length, MAX_REPO_AGENTS);
        const reasons = result.repo.skipped.map((s) => `${s.file}: ${s.reason}`);
        assert.ok(reasons.includes(".github/agents/big.agent.md: larger than 64 KB"), reasons.join("\n"));
        assert.equal(reasons.filter((r) => r.endsWith(`more than ${MAX_REPO_AGENTS} agents`)).length, 2);
    });

    it("never reads an agent file or a skill that resolves outside the workspace", async () => {
        const ws = workspace({ ".github/agents/ok.agent.md": agentFile("ok"), ".github/skills/good/SKILL.md": "good" });
        const secret = path.join(ws.root, "secret.txt");
        fs.writeFileSync(secret, "TOP SECRET");
        fs.symlinkSync(secret, path.join(ws.folder, ".github/agents/leak.agent.md"));
        const result = await check(ws, { agents: true, skills: true });
        assert.deepEqual(result.repo.agents.map((a) => a.file), [".github/agents/ok.agent.md"]);
        assert.ok(!JSON.stringify(result.repo).includes("TOP SECRET"), "the target was not read");
        assert.deepEqual(result.repo.skipped, [{ kind: "agent", file: ".github/agents/leak.agent.md", reason: "the file resolves outside the clone" }]);
        assert.deepEqual(result.repo.skills, ["good"]);

        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ps-repo-skill-out-"));
        temps.push(outside);
        fs.writeFileSync(path.join(outside, "SKILL.md"), "outside");
        fs.symlinkSync(outside, path.join(ws.folder, ".github/skills/evil"));
        const escaped = await check(ws, { skills: true });
        assert.deepEqual(escaped.repo.skills, [], "one escaping skill skips them all: the CLI reads the whole folder");
        assert.equal(escaped.repo.skipped[0].kind, "skill");
        assert.match(escaped.repo.skipped[0].reason, /outside the clone/);
    });

    it("reads from the clone root above a subfolder workspace; a folder outside any clone adopts nothing (review R6)", async () => {
        const files = { ".github/agents/a.agent.md": agentFile("a"), ".github/skills/build/SKILL.md": "build" };
        const sub = workspace(files, { sub: "packages/api" });
        const fromSub = await check(sub, { agents: true, skills: true });
        assert.deepEqual(fromSub.repo.agents.map((a) => a.file), [".github/agents/a.agent.md"]);
        assert.deepEqual(fromSub.repo.skills, ["build"]);
        assert.equal(fromSub.repo.cloneRoot, path.join("..", ".."));

        const plain = workspace(files, { git: false });
        const none = await check(plain, { agents: true, skills: true });
        assert.deepEqual([none.repo.agents, none.repo.skills], [[], []]);
        assert.equal("cloneRoot" in none.repo, false);
        assert.deepEqual(none.repo.skipped.map((s) => [s.kind, s.file]), [["agent", ".github/agents"], ["skill", ".github/skills"]]);
        assert.match(none.repo.skipped[0].reason, /not inside a git clone/);

        // The walk stops at the root: a .git above the root does not count.
        const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-repo-outer-")));
        temps.push(outer);
        fs.mkdirSync(path.join(outer, ".git"));
        fs.mkdirSync(path.join(outer, "root", "repo", ".github", "agents"), { recursive: true });
        fs.writeFileSync(path.join(outer, "root", "repo", ".github", "agents", "a.agent.md"), agentFile("a"));
        const above = await checkWorkspacePath({ rootName: "outer", rootPath: path.join(outer, "root"), path: path.join(outer, "root", "repo"), collect: { agents: true } });
        assert.deepEqual(above.repo.agents, []);
        assert.equal("cloneRoot" in above.repo, false);
    });

    it("looks at a bounded number of agent files and skill folders (review S-W4)", async () => {
        const files = {};
        const total = MAX_REPO_AGENTS + MAX_REPO_AGENT_OVERFLOW + 50;
        for (let i = 0; i < total; i++) files[`.github/agents/n${String(i).padStart(3, "0")}.agent.md`] = agentFile(`n${i}`);
        const many = await check(workspace(files), { agents: true });
        assert.equal(many.repo.agents.length, MAX_REPO_AGENTS);
        assert.equal(many.repo.skipped.length, MAX_REPO_AGENT_OVERFLOW + 1, "one entry per looked-at extra file, then one summary");
        assert.deepEqual(many.repo.skipped.at(-1), { kind: "agent", file: ".github/agents", reason: "50 more agent files, not read" });

        const skills = {};
        for (let i = 0; i <= MAX_REPO_SKILL_ENTRIES; i++) skills[`.github/skills/s${i}/SKILL.md`] = "s";
        const crowded = await check(workspace(skills), { skills: true });
        assert.deepEqual(crowded.repo.skills, []);
        assert.match(crowded.repo.skipped[0].reason, new RegExp(`more than ${MAX_REPO_SKILL_ENTRIES} entries, so no repo skill is adopted`));
    });

    it("stamps the instruction files when instructions are adopted, and the stamp moves when one changes (review R7)", async () => {
        const ws = workspace({ "AGENTS.md": "Rule one.", ".github/copilot-instructions.md": "Be brief." }, { sub: "lib" });
        fs.writeFileSync(path.join(ws.folder, "AGENTS.md"), "Local rule.");
        const first = await check(ws, { instructions: true });
        assert.deepEqual(first.repo.instructions.map(([file]) => file).sort(), ["../.github/copilot-instructions.md", "../AGENTS.md", "AGENTS.md"]);
        assert.deepEqual([first.repo.agents, first.repo.skills], [[], []], "instructions alone read no agents");
        fs.writeFileSync(path.join(ws.clone, "AGENTS.md"), "Rule one, and rule two.");
        const second = await check(ws, { instructions: true });
        assert.notDeepEqual(second.repo.instructions, first.repo.instructions);
    });

    it("prepareWorkspace asks for the collection only when adopt allows agents, skills or instructions", async () => {
        const ws = workspace({ ".github/agents/a.agent.md": agentFile("a"), ".github/skills/s/SKILL.md": "s", "AGENTS.md": "rules" });
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "r", path: ws.root }] });
        const req = { sessionId: "s1", rootSessionId: "s1", revision: 1, workerNodeId: "w", turnIndex: 0, workspace: { schema: 1, root: "r", folder: "repo" } };
        provider.setAdopt(null);
        assert.equal("repo" in (await prepareWorkspace(provider, req)), false);
        provider.setAdopt({ agents: false, skills: false, instructions: false });
        assert.equal("repo" in (await prepareWorkspace(provider, req)), false);
        provider.setAdopt({ agents: false, skills: false, instructions: true });
        const instructions = await prepareWorkspace(provider, req);
        assert.deepEqual([instructions.repo.agents, instructions.repo.skills], [[], []]);
        assert.deepEqual(instructions.repo.instructions.map(([file]) => file), ["AGENTS.md"]);
        provider.setAdopt({ agents: true, skills: false, instructions: false });
        const agents = await prepareWorkspace(provider, req);
        assert.deepEqual(agents.repo.agents.map((a) => a.file), [".github/agents/a.agent.md"]);
        assert.deepEqual(agents.repo.skills, []);
    });
});

describe("parseRepoAgentFile", () => {
    it("reads name, description, tools in every list form, model and the body", () => {
        const inline = parseRepoAgentFile(".github/agents/x.agent.md", '---\nname: fixer\ndescription: Fixes things.\ntools: ["read", \'edit\', bash]\nmodel: gpt-x\n---\n\nFix it.\n');
        assert.deepEqual(inline, { ok: true, agent: { name: "fixer", description: "Fixes things.", prompt: "Fix it.", tools: ["read", "edit", "bash"], model: "gpt-x", hasMcpServers: false } });
        const yamlList = parseRepoAgentFile("f.agent.md", "---\nname: y\ntools:\n  - read\n  - \"search\"\n---\nBody\n");
        assert.deepEqual(yamlList.agent.tools, ["read", "search"]);
        const comma = parseRepoAgentFile("f.agent.md", "---\nname: z\ntools: 'read, bash'\n---\nBody\n");
        assert.deepEqual(comma.agent.tools, ["read", "bash"]);
        const folded = parseRepoAgentFile("f.agent.md", "---\nname: w\ndescription: >\n  Two\n  lines.\n---\nBody\n");
        assert.equal(folded.agent.description, "Two lines.");
    });

    it("defaults the name to the file name; no tools key means every tool; notes MCP servers", () => {
        const bare = parseRepoAgentFile(".github/agents/helper.agent.md", "Just instructions.");
        assert.equal(bare.agent.name, "helper");
        assert.equal("tools" in bare.agent, false);
        assert.equal(bare.agent.prompt, "Just instructions.");
        const mcp = parseRepoAgentFile("m.agent.md", "---\nname: m\nmcp-servers:\n  srv:\n    command: x\n---\nBody\n");
        assert.equal(mcp.agent.hasMcpServers, true);
    });

    it("refuses a bad name, an unclosed frontmatter and an empty body", () => {
        assert.match(parseRepoAgentFile("a.agent.md", "---\nname: bad name!\n---\nBody").reason, /invalid agent name/);
        assert.match(parseRepoAgentFile("a.agent.md", "---\nname: x\nBody").reason, /no closing/);
        assert.match(parseRepoAgentFile("a.agent.md", "---\nname: x\n---\n\n").reason, /no instructions/);
    });

    it("reads frontmatter after a byte-order mark or with spaces after ---, and refuses one it cannot read (review R8)", () => {
        const bom = parseRepoAgentFile("r.agent.md", "\uFEFF---\nname: reviewer\ntools: [view, grep]\n---\nReview.\n");
        assert.deepEqual([bom.agent.name, bom.agent.tools, bom.agent.prompt], ["reviewer", ["view", "grep"], "Review."]);
        const spaced = parseRepoAgentFile("r.agent.md", "--- \r\nname: reviewer\r\ntools: [view]\r\n---\t\r\nReview.\r\n");
        assert.deepEqual([spaced.agent.tools, spaced.agent.prompt], [["view"], "Review."]);
        // Never read as all prompt: its tools line would be lost.
        assert.match(parseRepoAgentFile("r.agent.md", "\n---\nname: r\ntools: [view]\n---\nReview.").reason, /must start with a --- line/);
        assert.match(parseRepoAgentFile("r.agent.md", "----\nname: r\ntools: [view]\n----\nReview.").reason, /must start with a --- line/);
        assert.match(parseRepoAgentFile("r.agent.md", "--- x\nname: r\n---\nReview.").reason, /must start with a --- line/);
    });
});

describe("resolveRepoAdoption", () => {
    // The workspace is repo/lib inside the clone repo.
    const scanOf = (files, skills = [], extra = {}) => ({ agents: Object.entries(files).map(([file, content]) => ({ file, content })), skills, skipped: [], cloneRoot: "..", ...extra });
    const base = (over = {}) => ({
        scan: scanOf({}),
        adopt: { agents: true, skills: true, instructions: false },
        attachPath: "/ws/a/repo/lib",
        nativeTasks: true,
        sessionModel: "model-1",
        pilotswarmToolNames: new Set(["store_fact", "spawn_agent"]),
        reservedAgentNames: new Set(["swarm-explore", "swarm-task", "explore"]),
        ...over,
    });

    it("passes names through, drops MCP and PilotSwarm tools, never passes [], and pins the session model", () => {
        const result = resolveRepoAdoption(base({ scan: scanOf({
            ".github/agents/a.agent.md": agentFile("a", '["read", "search", "github/create_issue", "store_fact"]'),
            ".github/agents/b.agent.md": agentFile("b", '["github/x", "spawn_agent"]'),
            ".github/agents/c.agent.md": "---\nname: c\nmodel: other-model\n---\nAll tools.\n",
            ".github/agents/d.agent.md": agentFile("d", "[]"),
        }) }));
        assert.deepEqual(result.customAgents.map((a) => [a.name, a.tools ?? null, a.model]), [["a", ["read", "search"], "model-1"], ["c", null, "model-1"]]);
        assert.deepEqual(result.report.agents, ["a", "c"]);
        const why = Object.fromEntries(result.report.skipped.map((s) => [s.name ?? s.file, s.reason]));
        assert.match(why.a, /adopted without: github\/create_issue \(MCP tool\), store_fact \(PilotSwarm tool\)/);
        assert.match(why.b, /no usable tools: github\/x \(MCP tool\), spawn_agent \(PilotSwarm tool\)/);
        assert.match(why.c, /model other-model \(runs on the session model\)/);
        assert.match(why.d, /lists no tools/);
        assert.ok(result.customAgents.every((a) => a.tools === undefined || a.tools.length > 0), "never []");
    });

    it("names the repo by its clone folder, even from a subfolder; outside a clone there is no name", () => {
        const inside = resolveRepoAdoption(base({ scan: scanOf({ ".github/agents/a.agent.md": agentFile("a") }) }));
        assert.equal(inside.report.repo, "repo", "attach /ws/a/repo/lib, clone root .. -> repo");
        const atRoot = resolveRepoAdoption(base({ attachPath: "/ws/a/sessions/t1/tfenv", scan: scanOf({}, [], { cloneRoot: "" }) }));
        assert.equal(atRoot.report.repo, "tfenv");
        const noClone = resolveRepoAdoption(base({ scan: scanOf({}, [], { cloneRoot: undefined }) }));
        assert.equal(Object.hasOwn(noClone.report, "repo"), false);
    });

    it("reports a name collision with a PilotSwarm agent and a repeated repo name", () => {
        const result = resolveRepoAdoption(base({ scan: scanOf({
            ".github/agents/1.agent.md": agentFile("explore"),
            ".github/agents/2.agent.md": agentFile("dup"),
            ".github/agents/3.agent.md": agentFile("dup"),
        }) }));
        assert.deepEqual(result.report.agents, ["dup"]);
        assert.deepEqual(result.report.skipped.map((s) => [s.file, s.reason]), [
            [".github/agents/1.agent.md", "a PilotSwarm agent has this name"],
            [".github/agents/3.agent.md", "an earlier repo agent file has this name"],
        ]);
    });

    it("skips every agent when native tasks are off; skills still load", () => {
        const result = resolveRepoAdoption(base({ nativeTasks: false, scan: scanOf({ ".github/agents/a.agent.md": agentFile("a") }, ["build"]) }));
        assert.deepEqual(result.customAgents, []);
        assert.match(result.report.skipped[0].reason, /native tasks are off/);
        assert.deepEqual(result.skillDirectories, [path.join("/ws/a/repo", ".github", "skills")], "the clone root's skills folder");
        assert.deepEqual(result.report.skills, ["build"]);
    });

    it("adopts nothing the flags do not allow, and hashes only when something is adopted", () => {
        const scan = scanOf({ ".github/agents/a.agent.md": agentFile("a") }, ["build"], { instructions: [["AGENTS.md", 5, 1000]] });
        const none = resolveRepoAdoption(base({ scan, adopt: { agents: false, skills: false, instructions: false } }));
        assert.deepEqual([none.customAgents, none.skillDirectories, none.report.agents, none.report.skills], [[], [], [], []]);
        assert.equal(none.hash, undefined);
        const noAdopt = resolveRepoAdoption(base({ scan, adopt: undefined }));
        assert.equal(noAdopt.hash, undefined);

        // Instructions alone: the stamp of the files the CLI reads decides (review R7).
        const instructions = { agents: false, skills: false, instructions: true };
        const stamped = resolveRepoAdoption(base({ scan, adopt: instructions }));
        assert.deepEqual([stamped.customAgents, stamped.skillDirectories], [[], []]);
        assert.equal(typeof stamped.hash, "string");
        const touched = resolveRepoAdoption(base({ scan: { ...scan, instructions: [["AGENTS.md", 9, 2000]] }, adopt: instructions }));
        assert.notEqual(touched.hash, stamped.hash, "an edited AGENTS.md changes the hash");
        assert.equal(resolveRepoAdoption(base({ scan: { ...scan, instructions: [["AGENTS.md", 9, 2000]] } })).hash,
            resolveRepoAdoption(base({ scan })).hash, "without instructions adopted, the stamp does not count");

        // Skills need a clone root.
        const noClone = resolveRepoAdoption(base({ scan: { ...scan, cloneRoot: undefined } }));
        assert.deepEqual(noClone.skillDirectories, []);

        const one = resolveRepoAdoption(base({ scan }));
        assert.equal(one.hash, resolveRepoAdoption(base({ scan })).hash, "stable");
        const edited = resolveRepoAdoption(base({ scan: scanOf({ ".github/agents/a.agent.md": agentFile("a").replace("You are a.", "You are A.") }, ["build"]) }));
        assert.notEqual(edited.hash, one.hash, "an edited prompt changes the hash");
        const fewerSkills = resolveRepoAdoption(base({ scan: scanOf({ ".github/agents/a.agent.md": agentFile("a") }) }));
        assert.notEqual(fewerSkills.hash, one.hash, "a removed skill changes the hash");
    });
});

describe("adoptionNote and sameAdoption", () => {
    const report = (agents, skills = [], skipped = []) => ({ agents, skills, skipped });
    it("names the set on the first adoption and the difference on a change", () => {
        assert.equal(adoptionNote(null, report(["a", "b"], ["build"])), "Repo agents available through the task tool: a, b. Repo skills available: build.");
        assert.equal(adoptionNote(null, report([], [], [{ kind: "agent", file: "x", reason: "r" }])), undefined, "only skips: no note");
        assert.equal(adoptionNote(report(["a", "b"]), report(["b", "c"])), "Repo agents changed: added c, removed a.");
        assert.equal(adoptionNote(report(["a"], ["build"]), report([], [])), "Repo agents changed: added none, removed a. Repo skills changed: added none, removed build.");
        assert.equal(adoptionNote(report(["a"]), report(["a"], [], [{ kind: "agent", file: "x", reason: "r" }])), undefined);
    });
    it("compares agents, skills and skips", () => {
        assert.equal(sameAdoption(report(["a"]), report(["a"])), true);
        assert.equal(sameAdoption(report(["a"]), report(["a"], ["s"])), false);
        assert.equal(sameAdoption(report(["a"]), report(["a"], [], [{ kind: "agent", file: "x", reason: "r" }])), false);
    });
});

describe("the native child guard with adopted repo agents", () => {
    const PARENT = "parent-1";
    const guard = (repoAgents) => nativeSubagentHooks("model-1", undefined, () => true, undefined, repoAgents);
    const call = (hooks, input) => hooks.onPreToolUse({ toolArgs: {}, ...input }, { sessionId: PARENT });

    it("allows a task for an adopted agent and pins the model; a non-adopted name is still denied", async () => {
        const access = new RepoAgentAccess(new Set(["reviewer"]), new Set(["store_fact"]));
        const hooks = guard(access);
        const allowed = await call(hooks, { sessionId: PARENT, toolName: "task", toolArgs: { agent_type: "reviewer", prompt: "look" } });
        assert.notEqual(allowed?.permissionDecision, "deny");
        assert.deepEqual(allowed.modifiedArgs, { agent_type: "reviewer", prompt: "look", mode: "sync", model: "model-1" });
        const denied = await call(hooks, { sessionId: PARENT, toolName: "task", toolArgs: { agent_type: "stranger" } });
        assert.equal(denied.permissionDecision, "deny");
        assert.match(denied.permissionDecisionReason, /adopted repo agent/);
        const plain = await call(guard(undefined), { sessionId: PARENT, toolName: "task", toolArgs: { agent_type: "reviewer" } });
        assert.equal(plain.permissionDecisionReason, "Use the native swarm-explore or swarm-task agent.", "unchanged without adopted agents");
    });

    it("lets an adopted child use CLI tools, never PilotSwarm tools, task, or a detached shell", async () => {
        const access = new RepoAgentAccess(new Set(["reviewer"]), new Set(["store_fact"]));
        const hooks = guard(access);
        const child = "child-7";
        const before = await call(hooks, { sessionId: child, toolName: "edit" });
        assert.equal(before.permissionDecision, "deny", "unknown child: the swarm child rules apply");
        access.observe({ type: "subagent.started", agentId: child, data: { agentName: "reviewer" } });
        assert.notEqual((await call(hooks, { sessionId: child, toolName: "edit" }))?.permissionDecision, "deny");
        assert.notEqual((await call(hooks, { sessionId: child, toolName: "view" }))?.permissionDecision, "deny");
        assert.equal((await call(hooks, { sessionId: child, toolName: "store_fact" })).permissionDecision, "deny");
        assert.equal((await call(hooks, { sessionId: child, toolName: "task", toolArgs: { agent_type: "reviewer" } })).permissionDecision, "deny");
        assert.equal((await call(hooks, { sessionId: child, toolName: "bash", toolArgs: { command: "x", detach: true } })).permissionDecision, "deny");
        access.observe({ type: "subagent.completed", agentId: child });
        assert.equal((await call(hooks, { sessionId: child, toolName: "edit" })).permissionDecision, "deny", "a finished child is forgotten");
        access.observe({ type: "subagent.started", agentId: "other", data: { agentName: "swarm-task" } });
        assert.equal((await call(hooks, { sessionId: "other", toolName: "edit" })).permissionDecision, "deny", "a swarm child keeps its own rules");
    });
});

describe("the views of an adoption (v0.7.1)", () => {
    it("groupSkipped: entries with the same kind, source and reason become one with their names; single entries are unchanged", () => {
        const pinned = (name) => ({ kind: "agent", file: `.github/agents/${name}.agent.md`, name, reason: "adopted without: model Claude Opus 4.6 (runs on the session model)" });
        const lone = { kind: "skill", file: "big", name: "big", reason: "larger than 64 KB" };
        const loaded = { kind: "agent", file: "home:users/me/x.agent.md", name: "x", reason: "no such file or folder", source: "loaded" };
        const loadedToo = { ...loaded, file: "home:users/me/y.agent.md", name: "y" };
        const grouped = groupSkipped([pinned("architect"), lone, pinned("bug-finder"), loaded, pinned("reviewer"), loadedToo]);
        assert.deepEqual(grouped, [
            { kind: "agent", reason: "adopted without: model Claude Opus 4.6 (runs on the session model)", names: ["architect", "bug-finder", "reviewer"] },
            lone,
            { kind: "agent", reason: "no such file or folder", source: "loaded", names: ["x", "y"] },
        ]);
        assert.deepEqual(groupSkipped([lone]), [lone], "one entry: unchanged, with its file");
        assert.deepEqual(groupSkipped([]), []);
        assert.deepEqual(groupSkipped([{ ...lone, source: "personal" }, lone]).length, 2, "a different source is a different group");
    });

    it("nativeTaskAgentMarks: repo agents with the repo; the person's and loaded-by-path agents as loaded", () => {
        assert.deepEqual(nativeTaskAgentMarks({ repo: "tfenv", agents: ["architect"], skipped: [], personal: { agents: ["summarizer"], skills: [] }, loaded: { agents: ["reviewer"], skills: [] } }), {
            repoAgents: { repo: "tfenv", names: ["architect"] },
            loadedAgents: { personal: ["summarizer"], path: ["reviewer"] },
        });
        assert.deepEqual(nativeTaskAgentMarks({ agents: [], skipped: [], personal: { agents: ["summarizer"], skills: [] } }), {
            loadedAgents: { personal: ["summarizer"] },
        }, "the person's folder as the working folder: no repo");
        assert.deepEqual(nativeTaskAgentMarks({ agents: ["a"], skipped: [] }), { repoAgents: { names: ["a"] } });
        assert.deepEqual(nativeTaskAgentMarks(undefined), {});
        assert.deepEqual(nativeTaskAgentMarks({ agents: [], skipped: [], personal: { agents: [], skills: ["notes"] } }), {}, "skills only: nothing to mark");
    });
});
