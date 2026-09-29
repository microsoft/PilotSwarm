/**
 * Default folders on a real worker with the real Copilot CLI and the
 * scripted model (docs/proposals/session-workspaces.md, section 4.11).
 *
 *   D9   a session with no workspace runs in the person's own folder: its
 *        instructions and skills reach the model, and the default "shared"
 *        folder is listed
 *   D10  after the agent moves into a repo, the person's folder is extra
 *        folder "home": its instructions still reach the model, before the
 *        repo's; on a skill name clash the repo's skill wins
 *   D13  the portal can show the defaults: session.workspace_defaults is
 *        recorded when they change (not on every turn), and
 *        getSessionWorkspace returns them
 *   D11  a session with only default folders gets the workspace tools
 *   D12  the person's folder cannot attach: when it is optional the turn
 *        runs without folders and the model is told; when the provider
 *        marks it required the turn is held
 *
 * Run: npx vitest run test/local/workspace-defaults.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { scriptTurns, systemText } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createBuiltInWorkspaceProvider } from "../../src/index.ts";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { createManagementClient } from "../helpers/local-workers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

/** Roots home, shared and repo on a temp folder; the person's folder and a git repo with clashing skills. */
function fixture() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-defaults-local-")));
    const me = path.join(base, "home", "users", "_anon");
    const repo = path.join(base, "repo", "app");
    const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    write(path.join(me, "AGENTS.md"), "PERSONAL-RULE-D9: end every answer with a period.\n");
    write(path.join(me, ".github", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: PERSONAL-NOTES-DESC keep notes\n---\nKeep notes.\n");
    write(path.join(me, ".github", "skills", "journal", "SKILL.md"), "---\nname: journal\ndescription: PERSONAL-JOURNAL-DESC keep a journal\n---\nKeep a journal.\n");
    write(path.join(repo, "AGENTS.md"), "REPO-RULE-D10: run the tests before you commit.\n");
    write(path.join(repo, ".github", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: REPO-NOTES-DESC the repo's notes\n---\nRepo notes.\n");
    execFileSync("git", ["init", "-q", repo]);
    fs.mkdirSync(path.join(base, "shared"), { recursive: true });
    const roots = ["home", "shared", "repo"].map((name) => ({ name, path: path.join(base, name) }));
    const inner = createBuiltInWorkspaceProvider(roots);
    const adopt = { home: { agents: true, skills: true, instructions: true, folder: true }, repo: { agents: true, skills: true, instructions: true } };
    // D12: the home root can "go down", and the home default can be required.
    const state = { homeDown: false, homeRequired: false };
    const provider = {
        listRoots: () => inner.listRoots(),
        async ensureAttached(req) {
            if (state.homeDown && req.workspace.root === "home") {
                return { ok: false, code: "WORKSPACE_NOT_MOUNTED", message: "root \"home\" is not mounted (test)", retryAfterMs: 30_000 };
            }
            const result = await inner.ensureAttached(req);
            return result.ok && adopt[req.workspace.root] ? { ...result, adopt: adopt[req.workspace.root] } : result;
        },
        defaultFolders: (ctx) => ({
            home: {
                name: "home", root: "home", folder: `users/${ctx.owner?.subject && ctx.owner.provider !== "anonymous" ? ctx.owner.subject : "_anon"}`,
                ...(state.homeRequired ? { required: true } : {}),
            },
            extra: { shared: { root: "shared" } },
        }),
    };
    return { base, me, repo, provider, state, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

describe("default folders (section 4.11)", () => {
    it("the person's folder cannot attach: optional runs without folders and says so; required holds (D12)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture();
        const catalog = await createCatalog(env);
        try {
            const respond = scriptTurns([[
                { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
                (_body, position) => ({ content: `d12:${firstLine(position.toolResults)}` }),
            ]]);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: fx.provider } }, async ({ client, model, qualifiedModel }) => {
                fx.state.homeDown = true;
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel });
                const answer = await session.sendAndWait("d12 home is down", TIMEOUT);
                assert(answer.startsWith("d12:/") && answer !== `d12:${fx.me}`, `the turn ran, not in the person's folder: ${answer}`);
                const prompt = JSON.stringify(model.sessionRequests("d12 home is down")[0].body.messages);
                assert(prompt.includes("Your own folder (root") && prompt.includes("WORKSPACE_NOT_MOUNTED") && prompt.includes("files written there are not kept"),
                    `the model is told: ${prompt.slice(-1500)}`);
                const notes = (await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === "system.message" && /Your own folder/.test(e.data?.content ?? ""));
                assertEqual(notes.length, 1, "the note is recorded once");
                assertEqual(notes[0].data.source, undefined, "as PilotSwarm's note, not the provider's");
                assertEqual((await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === "session.workspace_unavailable").length, 0, "nothing was held");

                fx.state.homeRequired = true;
                const heldId = randomUUID();
                const held = await client.createSession({ sessionId: heldId, model: qualifiedModel });
                await held.send("d12 home is required");
                const [unavailable] = await waitForEventCount(catalog, heldId, "session.workspace_unavailable", 1, 60_000);
                assertEqual(unavailable.data.code, "WORKSPACE_NOT_MOUNTED", "a required home folder holds the turn");
                assertEqual(model.sessionRequests("d12 home is required").length, 0, "and calls no model");
            });
        } finally {
            await catalog.close?.();
            fx.cleanup();
        }
    });

    it("a session with only default folders gets the workspace tools, with no tool list of its own (D11)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture();
        try {
            const respond = scriptTurns([[{ content: "d11 done" }]]);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: fx.provider } }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel });
                assertEqual(await session.sendAndWait("d11 which tools", TIMEOUT), "d11 done");
                const request = model.sessionRequests("d11 which tools")[0];
                const names = (request.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
                assert(names.includes("set_session_workspace") && names.includes("get_session_workspace"),
                    `the workspace tools are offered: ${names.filter((n) => /workspace/.test(n)).join(", ") || "none"}`);
            });
        } finally {
            fx.cleanup();
        }
    });

    it("no workspace: the person's folder is the working folder, with its instructions and skills; then in a repo it is extra folder \"home\" (D9, D10)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture();
        try {
            const respond = scriptTurns([
                [
                    { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
                    (_body, position) => ({ content: `one:${firstLine(position.toolResults)}` }),
                ],
                [
                    { tools: [{ name: "set_session_workspace", args: { root: "repo", folder: "app" } }] },
                    { content: "moving" },
                ],
                [
                    { tools: [{ name: "get_session_workspace", args: {} }] },
                    (_body, position) => ({ content: `three:${position.toolResults.join("").slice(0, 2000)}` }),
                ],
            ]);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: fx.provider } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, toolNames: ["set_session_workspace", "get_session_workspace"] });
                assertEqual(await session.sendAndWait("d9 where am I", TIMEOUT), `one:${fx.me}`, "a session with no workspace runs in the person's folder");

                const requests = model.sessionRequests("d9 where am I");
                const first = requests.find((r) => r.position.turn === 1 && r.position.step === 0);
                const firstBody = JSON.stringify(first.body);
                assert(firstBody.includes("PERSONAL-RULE-D9"), "the person's AGENTS.md reaches the model (the CLI reads it from the working folder)");
                assert(firstBody.includes("PERSONAL-NOTES-DESC") && firstBody.includes("PERSONAL-JOURNAL-DESC"), "the person's skills are offered");
                assert(systemText(first.body).includes(path.join(path.dirname(fx.me), "..", "..", "shared").replace(/\/users\/\.\.\/\.\.\//, "/")) || firstBody.includes(path.join(fx.base, "shared")),
                    "the default shared folder is listed");

                // D13: the defaults the first turn used, recorded once.
                const mgmt = await createManagementClient(env);
                try {
                    const first = await mgmt.getSessionWorkspace(sessionId);
                    assertEqual(first.workspace, null, "the record is still empty");
                    assert(JSON.stringify(first.defaults) === JSON.stringify({ workingFolder: { root: "home", folder: "users/_anon" }, extra: [{ name: "shared", root: "shared" }] }),
                        `the view reports the defaults: ${JSON.stringify(first.defaults)}`);
                } finally {
                    await mgmt.stop();
                }

                const answer = await session.sendAndWait("d10 move into the repo", TIMEOUT);
                assert(answer.startsWith("three:"), answer);
                const view = JSON.parse(answer.slice("three:".length));
                assertEqual(view.workspace?.root, "repo", "the record names the repo");
                assertEqual(JSON.stringify(view.defaults?.extra?.map((e) => [e.name, e.status])), JSON.stringify([["home", "attached"], ["shared", "attached"]]),
                    "the person's folder and the shared folder are default extra folders");
                assertEqual(JSON.stringify(view.adoptedFromYourFolder), JSON.stringify({ agents: [], skills: ["journal"] }), "the person's journal skill is adopted from the extra folder");

                const moved = model.sessionRequests("d9 where am I").find((r) => r.position.turn === 3 && r.position.step === 0);
                const movedBody = JSON.stringify(moved.body);
                const system = systemText(moved.body);
                assert(system.includes(`Current working directory: ${fx.repo}`), "the working folder is the repo");
                const personal = system.indexOf("PERSONAL-RULE-D9");
                const repoRule = system.indexOf("REPO-RULE-D10");
                assert(personal >= 0, "the person's instructions still reach the model from the extra folder");
                assert(repoRule > personal, `the person's instructions come before the repo's: ${personal} / ${repoRule}`);
                assert(movedBody.includes("REPO-NOTES-DESC"), "the repo's notes skill is offered");
                assert(!movedBody.includes("PERSONAL-NOTES-DESC"), "the person's notes skill lost the name clash to the repo's");
                assert(movedBody.includes("PERSONAL-JOURNAL-DESC"), "the person's other skill is still offered");

                // D13: three turns ran (the move continues by itself); the
                // defaults changed once, at the move.
                const catalog = await createCatalog(env);
                try {
                    const recorded = (await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === "session.workspace_defaults");
                    assertEqual(recorded.length, 2, "recorded at the first turn and at the move, not on every turn");
                    assertEqual(recorded[1].data.workingFolder, null, "in the repo, the person's folder is no longer the working folder");
                    assertEqual(JSON.stringify(recorded[1].data.extra.map((e) => [e.name, e.root, e.folder ?? "", e.home === true])),
                        JSON.stringify([["home", "home", "users/_anon", true], ["shared", "shared", "", false]]));
                } finally {
                    await catalog.close?.();
                }
                const mgmtAfter = await createManagementClient(env);
                try {
                    const after = await mgmtAfter.getSessionWorkspace(sessionId);
                    assertEqual(after.workspace?.root, "repo");
                    assertEqual(JSON.stringify(after.defaults?.extra.map((e) => e.name)), JSON.stringify(["home", "shared"]));
                } finally {
                    await mgmtAfter.stop();
                }
            });
        } finally {
            fx.cleanup();
        }
    });
});
