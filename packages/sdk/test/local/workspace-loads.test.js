/**
 * Agents and skills loaded by path, on a real worker with the real Copilot
 * CLI and the scripted model (docs/proposals/session-workspaces.md, section
 * 4.12).
 *
 *   L8   load_agent on a file deep in the person's folder: the turn ends,
 *        the next turn continues by itself, and the task tool runs the
 *        loaded agent; it wins over the person's own agent of that name;
 *        when the file is gone, get_session_workspace says so and the
 *        person's own agent is back
 *   L9   load_skill by path: the body comes back at once; from the next turn
 *        the loaded skill wins over the person's and the repo's skill of that
 *        name, also after a move into a repo (the load's folder is then the
 *        extra folder "home"); load_skill by name serves it, and an edit
 *        to the file shows in the next turn; unload gives the name back
 *   L10  refusals end nothing: a path outside the folders is an error in the
 *        same turn, and nothing is saved
 *
 * Agents run as native task children, so native tasks are on: the worker
 * runs with nativeSubagents "sync", the cluster turns on
 * copilot.native_tasks, and each session has an owner.
 *
 * Run: npx vitest run test/local/workspace-loads.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { scriptTurns, systemText } from "../helpers/scripted-model.mjs";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { createBuiltInWorkspaceProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "loads-owner", displayName: "Owner" };

/** The CLI's task tool declaration in a request, as text; "" when the request has no task tool. */
const taskTool = (body) => JSON.stringify((body.tools ?? []).find((t) => t.function?.name === "task") ?? "");
/**
 * What the CLI offers in a request: its tools and the system message. Not
 * the conversation: a load_skill result stays in the history.
 */
const offered = (body) => `${JSON.stringify(body.tools ?? [])}\n${systemText(body)}`;
const requestAt = (model, prompt, turn, step = 0) => model.sessionRequests(prompt).find((r) => r.position.turn === turn && r.position.step === step);

async function savedLoads(env, sessionId) {
    const catalog = await createCatalog(env);
    try {
        return (await catalog.getSessionCapabilities(sessionId))?.loads ?? [];
    } finally {
        await catalog.close?.();
    }
}

/** Roots home, shared and repo on a temp folder: the owner's folder, and a git repo. */
function fixture() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-loads-local-")));
    const me = path.join(base, "home", "users", OWNER.subject);
    const repo = path.join(base, "repo", "app");
    const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    // The person's own agent and skill (adopted from their folder), and
    // files of the same names deeper down, to load by path.
    write(path.join(me, ".github", "agents", "finder.agent.md"), "---\nname: finder\ndescription: PERSONAL-FINDER-DESC the person's finder\n---\nFind.\n");
    write(path.join(me, "deep", "a", "b", "c", "finder.agent.md"), "---\nname: finder\ndescription: LOADED-FINDER-DESC the loaded finder\n---\nFind well.\n");
    write(path.join(me, ".github", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: PERSONAL-NOTES-DESC keep notes\n---\nKeep notes.\n");
    write(path.join(me, "stash", "notes", "SKILL.md"), "---\nname: notes\ndescription: LOADED-NOTES-DESC the loaded notes\n---\nLOADED-NOTES-BODY\n");
    write(path.join(repo, ".github", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: REPO-NOTES-DESC the repo's notes\n---\nRepo notes.\n");
    write(path.join(base, "outside", "x.agent.md"), "---\nname: x\ndescription: x\n---\nX.\n");
    execFileSync("git", ["init", "-q", repo]);
    fs.mkdirSync(path.join(base, "shared"), { recursive: true });
    const roots = ["home", "shared", "repo"].map((name) => ({ name, path: path.join(base, name) }));
    const inner = createBuiltInWorkspaceProvider(roots);
    const adopt = { home: { agents: true, skills: true, instructions: true, folder: true }, repo: { agents: true, skills: true, instructions: true } };
    const provider = {
        listRoots: () => inner.listRoots(),
        async ensureAttached(req) {
            const result = await inner.ensureAttached(req);
            return result.ok && adopt[req.workspace.root] ? { ...result, adopt: adopt[req.workspace.root] } : result;
        },
        defaultFolders: (ctx) => ({
            home: { name: "home", root: "home", folder: `users/${ctx.owner?.subject ?? "_anon"}` },
            extra: { shared: { root: "shared" } },
        }),
    };
    return { base, me, repo, provider, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

describe("agents and skills loaded by path (section 4.12)", () => {
    it("load_agent: the turn ends, the next continues, and the task tool runs the loaded agent over the person's own (L8)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await setClusterFeature(env, "copilot.native_tasks", true);
        const fx = fixture();
        try {
            let loadResult = "";
            let view = null;
            const parent = scriptTurns([
                [
                    { tools: [{ name: "load_agent", args: { path: "deep/a/b/c/finder.agent.md" } }] },
                    (_body, position) => { loadResult = position.toolResults.join(""); return { content: "loading" }; },
                ],
                [
                    { tools: [{ name: "task", args: { name: "find", agent_type: "finder", description: "Find it", prompt: "CHILD-L8: report", mode: "sync" } }] },
                    (_body, position) => ({ content: `ran:${position.toolResults.join("")}` }),
                ],
                [
                    { tools: [{ name: "get_session_workspace", args: {} }] },
                    (_body, position) => { view = JSON.parse(position.toolResults.join("")); return { content: "checked" }; },
                ],
            ]);
            const child = scriptTurns([[{ content: "L8-FOUND" }]]);
            const respond = (body, position) => (position.firstUserText.includes("CHILD-L8") ? child : parent)(body, position);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: fx.provider, nativeSubagents: "sync" } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, owner: OWNER });
                const answer = await session.sendAndWait("l8 load the finder", TIMEOUT);

                assert(loadResult.startsWith(`Loaded agent "finder" from ${path.join(fx.me, "deep", "a", "b", "c", "finder.agent.md")}.`), loadResult);
                assert(loadResult.includes("load_agent acknowledged"), `the turn ends after the load: ${loadResult}`);
                const before = taskTool(requestAt(model, "l8 load the finder", 1).body);
                assert(before.includes("PERSONAL-FINDER-DESC") && !before.includes("LOADED-FINDER-DESC"), `before the load, the person's own finder: ${before.slice(0, 800)}`);
                const next = requestAt(model, "l8 load the finder", 2);
                assert(next, "the next turn started by itself");
                const after = taskTool(next.body);
                assert(after.includes("LOADED-FINDER-DESC") && !after.includes("PERSONAL-FINDER-DESC"), `after the load, the loaded finder wins: ${after.slice(0, 800)}`);
                assert(answer.includes("L8-FOUND"), `the loaded agent ran as a native task: ${answer.slice(0, 600)}`);
                assertEqual(JSON.stringify(await savedLoads(env, sessionId)),
                    JSON.stringify([{ kind: "agent", name: "finder", root: "home", path: `users/${OWNER.subject}/deep/a/b/c/finder.agent.md` }]),
                    "the load is saved with the session, relative to its root");

                // The loaded file is gone: the load is left out with the reason,
                // and the person's own finder has the name again.
                fs.rmSync(path.join(fx.me, "deep"), { recursive: true });
                assertEqual(await session.sendAndWait("l8 check", TIMEOUT), "checked");
                const gone = view.skipped?.find((skip) => skip.source === "loaded");
                assertEqual(JSON.stringify(gone && [gone.name, gone.reason]), JSON.stringify(["finder", "no such file or folder"]), JSON.stringify(view).slice(0, 1500));
                const back = taskTool(requestAt(model, "l8 load the finder", 3).body);
                assert(back.includes("PERSONAL-FINDER-DESC") && !back.includes("LOADED-FINDER-DESC"), `the person's own finder is back: ${back.slice(0, 800)}`);
            });
        } finally {
            fx.cleanup();
        }
    });

    it("load_skill by path: the body at once, then it wins over the person's and the repo's, also after a move; unload gives the name back (L9)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture();
        try {
            let loadResult = "";
            let view = null;
            let edited = "";
            const respond = scriptTurns([
                [
                    { tools: [{ name: "load_skill", args: { path: "stash/notes/SKILL.md" } }] },
                    (_body, position) => { loadResult = position.toolResults.join(""); return { content: "loaded" }; },
                ],
                [
                    { tools: [{ name: "load_skill", args: { name: "notes" } }] },
                    (_body, position) => ({ content: `two:${position.toolResults.join("")}` }),
                ],
                [{ tools: [{ name: "set_session_workspace", args: { root: "repo", folder: "app" } }] }, { content: "moving" }],
                [
                    { tools: [{ name: "get_session_workspace", args: {} }] },
                    (_body, position) => { view = JSON.parse(position.toolResults.join("")); return { content: "four" }; },
                ],
                [
                    { tools: [{ name: "load_skill", args: { name: "notes" } }] },
                    (_body, position) => { edited = position.toolResults.join(""); return { tools: [{ name: "load_skill", args: { unload: "notes" } }] }; },
                    { content: "unloaded" },
                ],
                [{ content: "six" }],
            ]);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: fx.provider } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, owner: OWNER });
                const prompt = "l9 load my notes";
                assertEqual(await session.sendAndWait(prompt, TIMEOUT), "loaded");
                assert(loadResult.startsWith("[SKILL: notes]\nLOADED-NOTES-DESC the loaded notes\n\nLOADED-NOTES-BODY"), `the body comes back at once: ${loadResult}`);
                assertEqual(requestAt(model, prompt, 1, 1).position.turn, 1, "a skill load does not end the turn");
                const first = offered(requestAt(model, prompt, 1).body);
                assert(first.includes("PERSONAL-NOTES-DESC") && !first.includes("LOADED-NOTES-DESC"), "before the load, the person's own notes skill");

                const byName = await session.sendAndWait("l9 next", TIMEOUT);
                assert(byName.startsWith("two:[SKILL: notes]") && byName.includes("LOADED-NOTES-BODY"), `load_skill by name serves the loaded skill: ${byName.slice(0, 300)}`);
                const second = offered(requestAt(model, prompt, 2).body);
                assert(second.includes("LOADED-NOTES-DESC") && !second.includes("PERSONAL-NOTES-DESC"), "the loaded skill wins over the person's");

                assertEqual(await session.sendAndWait("l9 move into the repo", TIMEOUT), "four");
                const moved = offered(requestAt(model, prompt, 4).body);
                assert(moved.includes("LOADED-NOTES-DESC") && !moved.includes("REPO-NOTES-DESC"),
                    "in the repo, the load (now in extra folder \"home\") still wins over the repo's skill");
                assertEqual(JSON.stringify(view.loaded), JSON.stringify({ agents: [], skills: ["notes"] }), `get_session_workspace lists the load: ${JSON.stringify(view).slice(0, 1500)}`);

                // Every turn the file is read again: an edit shows in the next turn.
                fs.writeFileSync(path.join(fx.me, "stash", "notes", "SKILL.md"), "---\nname: notes\ndescription: LOADED-NOTES-DESC the loaded notes\n---\nLOADED-NOTES-BODY-EDITED\n");
                assertEqual(await session.sendAndWait("l9 unload", TIMEOUT), "unloaded");
                assert(edited.includes("LOADED-NOTES-BODY-EDITED"), `the edit shows: ${edited.slice(0, 300)}`);
                assertEqual(await session.sendAndWait("l9 after", TIMEOUT), "six");
                const after = offered(requestAt(model, prompt, 6).body);
                assert(after.includes("REPO-NOTES-DESC") && !after.includes("LOADED-NOTES-DESC"),
                    `after the unload, the repo's skill has the name again: ${JSON.stringify(after.match(/[A-Z]+-NOTES-DESC/g))}`);
                assertEqual(JSON.stringify(await savedLoads(env, sessionId)), "[]");
            });
        } finally {
            fx.cleanup();
        }
    });

    it("a path outside the folders is an error in the same turn; nothing is saved (L10)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture();
        try {
            const respond = scriptTurns([[
                { tools: [{ name: "load_agent", args: { path: path.join(fx.base, "outside", "x.agent.md") } }] },
                (_body, position) => ({ content: `agent:${position.toolResults.join("")}` }),
            ]]);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: fx.provider } }, async ({ client, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, owner: OWNER });
                const answer = await session.sendAndWait("l10 load from outside", TIMEOUT);
                assert(answer.startsWith(`agent:Error: ${path.join(fx.base, "outside", "x.agent.md")} is not inside the working folder or an extra folder`), answer);
                assertEqual(JSON.stringify(await savedLoads(env, sessionId)), "[]");
            });
        } finally {
            fx.cleanup();
        }
    });
});
