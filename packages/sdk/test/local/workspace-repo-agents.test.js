/**
 * Session workspaces, slice D: repo agents and skills on a real worker with
 * the real Copilot CLI and the scripted model
 * (docs/proposals/session-workspaces.md, section 4.6). Covers A1, A2, A4,
 * A6 and F10.
 *
 * Repo agents run as native task children, so native tasks are on: the
 * worker runs with nativeSubagents "sync", the cluster turns on
 * copilot.native_tasks, and each session has an owner.
 *
 * Run: npx vitest run test/local/workspace-repo-agents.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns, systemText } from "../helpers/scripted-model.mjs";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { createGitFixture } from "../helpers/git-fixture.mjs";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "repo-agents-owner", displayName: "Owner" };
const ALL = { agents: true, skills: true, instructions: true };
const NONE = { agents: false, skills: false, instructions: false };

/** The CLI's task tool declaration in a request, as text; "" when the request has no task tool. */
const taskTool = (body) => JSON.stringify((body.tools ?? []).find((t) => t.function?.name === "task") ?? "");
const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name);
const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

/** Native tasks on for the cluster. The suite env is reset after every test, so each test calls it. */
const nativeTasksOn = (env) => setClusterFeature(env, "copilot.native_tasks", true);

async function events(env, sessionId, type) {
    const catalog = await createCatalog(env);
    try {
        return (await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === type);
    } finally {
        await catalog.close?.();
    }
}

describe("workspace repo agents and skills", () => {
    it("a repo agent reaches the task tool only with adopt.agents and native tasks (A1)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await nativeTasksOn(env);
        const fixture = await createGitFixture();
        try {
            const clone = await fixture.cloneSession({ rootSessionId: "a1" });
            const folder = path.relative(fixture.root, clone);
            const provider = createFakeWorkspaceProvider({ roots: [{ name: "fx", path: fixture.root }] });
            await withScriptedModel(env, {
                respond: scriptTurns([[{ content: "ok" }]]),
                worker: { workspaceProvider: provider, nativeSubagents: "sync" },
            }, async ({ client, model, qualifiedModel }) => {
                const run = async (prompt, adopt, owner = OWNER) => {
                    provider.setAdopt(adopt);
                    const sessionId = randomUUID();
                    const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "fx", folder }, ...(owner ? { owner } : {}) });
                    assertEqual(await session.sendAndWait(prompt, TIMEOUT), "ok");
                    return { sessionId, body: model.sessionRequests(prompt)[0].body };
                };
                const adopting = await run("a1 adopting", { agents: true, skills: false, instructions: false });
                assert(taskTool(adopting.body).includes("reviewer"), `the task tool lists the repo agent: ${taskTool(adopting.body).slice(0, 600)}`);
                const [adopted] = await events(env, adopting.sessionId, "session.workspace_adopted");
                assertEqual(JSON.stringify(adopted.data.agents), JSON.stringify(["reviewer"]));
                assertEqual(adopted.data.revision, 1);

                const notAdopting = await run("a1 not adopting", NONE);
                assert(taskTool(notAdopting.body) !== "", "native tasks are on: the task tool is there");
                assert(!taskTool(notAdopting.body).includes("reviewer"), "adopt.agents false: no repo agent");
                assertEqual((await events(env, notAdopting.sessionId, "session.workspace_adopted")).length, 0, "nothing adopted, nothing recorded");

                // No owner: native tasks cannot be resolved, so they are off.
                const nativeOff = await run("a1 native off", { agents: true, skills: false, instructions: false }, null);
                assert(!toolNames(nativeOff.body).includes("task"), "native tasks off: no task tool");
                const [skipped] = await events(env, nativeOff.sessionId, "session.workspace_adopted");
                assertEqual(JSON.stringify(skipped.data.agents), "[]");
                assert(skipped.data.skipped.some((s) => s.file === ".github/agents/reviewer.agent.md" && /native tasks are off/.test(s.reason)),
                    `reported as skipped: ${JSON.stringify(skipped.data.skipped)}`);
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it("filters repo agents, and the child guard lets an adopted agent's child work while a stranger is denied (A2)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await nativeTasksOn(env);
        const fixture = await createGitFixture();
        try {
            const clone = await fixture.cloneSession({ rootSessionId: "a2" });
            const agents = path.join(clone, ".github", "agents");
            fs.writeFileSync(path.join(agents, "fixer.agent.md"),
                "---\nname: fixer\ndescription: Fixes things.\ntools: [\"read\", \"github/create_issue\", \"store_fact\"]\nmodel: some-other-model\n---\nFix what you are told to fix.\n");
            fs.writeFileSync(path.join(agents, "clash.agent.md"), "---\nname: swarm-task\ndescription: Takes a PilotSwarm name.\n---\nNever adopted.\n");
            fs.writeFileSync(path.join(agents, "writer.agent.md"), "---\nname: writer\ndescription: Writes files.\ntools: [\"read\", \"create\"]\n---\nWrite the file you are asked to write.\n");
            const provider = createFakeWorkspaceProvider({ roots: [{ name: "fx", path: fixture.root }] });
            provider.setAdopt({ agents: true, skills: false, instructions: false });
            const parent = scriptTurns([[
                { tools: [
                    { name: "task", args: { name: "review", agent_type: "reviewer", description: "Review the readme", prompt: "CHILD-REVIEW: read README.md and report its first line", mode: "sync" } },
                    { name: "task", args: { name: "write", agent_type: "writer", description: "Write a file", prompt: "CHILD-WRITE: create out.txt", mode: "sync" } },
                    { name: "task", args: { name: "stranger", agent_type: "stranger", description: "Not adopted", prompt: "CHILD-STRANGER: say hi", mode: "sync" } },
                ] },
                (_body, position) => ({ content: `results:${JSON.stringify(position.toolResults)}` }),
            ]]);
            const child = scriptTurns([[
                { tools: [{ name: "view", args: { path: path.join(clone, "README.md") } }] },
                (_body, position) => ({ content: `REVIEWED:${position.toolResults.join("").includes("# Fixture repo")}` }),
            ]]);
            // create is not a swarm child tool: only the adopted-agent rule lets the writer's child use it.
            const writer = scriptTurns([[
                { tools: [{ name: "create", args: { path: path.join(clone, "out.txt"), file_text: "written by the writer\n" } }] },
                (_body, position) => ({ content: `WROTE:${firstLine(position.toolResults)}` }),
            ]]);
            const respond = (body, position) => (position.firstUserText.includes("CHILD-WRITE")
                ? writer : position.firstUserText.includes("CHILD-") ? child : parent)(body, position);
            await withScriptedModel(env, { respond, worker: { workspaceProvider: provider, nativeSubagents: "sync" } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, owner: OWNER, workspace: { root: "fx", folder: path.relative(fixture.root, clone) } });
                const answer = await session.sendAndWait("a2 run the reviewer", TIMEOUT);
                const results = JSON.parse(answer.slice("results:".length));
                assert(results.some((text) => text.includes("REVIEWED:true")), `the adopted agent's child read the file with its listed tool: ${answer}`);
                assert(results.some((text) => /adopted repo agent/.test(text)), `a non-adopted name is denied: ${answer}`);

                const childRequest = model.sessionRequests("CHILD-REVIEW")[0];
                assert(childRequest, "the reviewer child called the model");
                const childTools = toolNames(childRequest.body);
                assert(childTools.includes("view"), `read resolved to view: ${childTools.join(",")}`);
                assert(!childTools.includes("store_fact") && !childTools.includes("spawn_agent"), `no PilotSwarm tools: ${childTools.join(",")}`);
                assertEqual(model.sessionRequests("CHILD-STRANGER").length, 0, "the stranger never ran");
                assertEqual(fs.existsSync(path.join(clone, "out.txt")) && fs.readFileSync(path.join(clone, "out.txt"), "utf8"), "written by the writer\n",
                    `the writer's child used create, a tool only its agent lists: ${answer}`);

                const [adopted] = await events(env, sessionId, "session.workspace_adopted");
                assertEqual(JSON.stringify(adopted.data.agents), JSON.stringify(["fixer", "reviewer", "writer"]));
                const why = Object.fromEntries(adopted.data.skipped.map((s) => [s.name ?? s.file, s.reason]));
                assertEqual(why["swarm-task"], "a PilotSwarm agent has this name");
                assert(/github\/create_issue \(MCP tool\)/.test(why.fixer) && /store_fact \(PilotSwarm tool\)/.test(why.fixer) && /some-other-model/.test(why.fixer),
                    `fixer's drops are reported: ${why.fixer}`);
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it("an adopt flip gives the next turn the new set and the agents-changed note; the same adopt again changes nothing (A4)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await nativeTasksOn(env);
        const fixture = await createGitFixture();
        try {
            const clone = await fixture.cloneSession({ rootSessionId: "a4" });
            const provider = createFakeWorkspaceProvider({ roots: [{ name: "fx", path: fixture.root }] });
            await withScriptedModel(env, {
                respond: scriptTurns([[{ content: "one" }], [{ content: "two" }], [{ content: "three" }]]),
                worker: { workspaceProvider: provider, nativeSubagents: "sync" },
            }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, owner: OWNER, workspace: { root: "fx", folder: path.relative(fixture.root, clone) } });
                provider.setAdopt(ALL);
                assertEqual(await session.sendAndWait("a4 turn one", TIMEOUT), "one");
                provider.setAdopt(NONE);
                assertEqual(await session.sendAndWait("a4 turn two", TIMEOUT), "two");
                assertEqual(await session.sendAndWait("a4 turn three", TIMEOUT), "three");

                const byTurn = (text) => model.sessionRequests("a4 turn one").find((r) => r.position.lastUserText.includes(text));
                const [one, two, three] = ["a4 turn one", "a4 turn two", "a4 turn three"].map(byTurn);
                assert(taskTool(one.body).includes("reviewer"), "turn one: the repo agent");
                assert(systemText(one.body).includes(fixture.agentsMarker), "turn one: AGENTS.md is loaded");
                assert(JSON.stringify(one.body).includes("Builds the fixture project"), "turn one: the repo skill is offered");
                assert(one.position.lastUserText.includes("Repo agents available through the task tool: reviewer."), `turn one names the set: ${one.position.lastUserText}`);

                assert(!taskTool(two.body).includes("reviewer"), "turn two: the repo agent is gone");
                assert(!systemText(two.body).includes(fixture.agentsMarker), "turn two: AGENTS.md is not loaded");
                assert(!JSON.stringify(two.body).includes("Builds the fixture project"), "turn two: no repo skill");
                assert(two.position.lastUserText.includes("Repo agents changed: added none, removed reviewer."), `turn two gets the note: ${two.position.lastUserText}`);
                assert(two.position.lastUserText.includes("Repo skills changed: added none, removed build."), "and the skills part");

                assert(!/Repo (agents|skills)/.test(three.position.lastUserText), `turn three: no note: ${three.position.lastUserText}`);
                assertEqual(JSON.stringify(three.body.tools), JSON.stringify(two.body.tools), "turn three: the same tools");
                assertEqual(systemText(three.body), systemText(two.body), "turn three: the same system message");

                const adopted = await events(env, sessionId, "session.workspace_adopted");
                assertEqual(JSON.stringify(adopted.map((e) => [e.data.agents, e.data.skills])), JSON.stringify([[["reviewer"], ["build"]], [[], []]]),
                    "one event per change");
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it("a branch switch that changes the repo agents, with the same adopt, gives the next turn the new set and the note (A4, K13)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await nativeTasksOn(env);
        const fixture = await createGitFixture();
        try {
            const clone = await fixture.cloneSession({ rootSessionId: "a4b" });
            const provider = createFakeWorkspaceProvider({ roots: [{ name: "fx", path: fixture.root }] });
            provider.setAdopt({ agents: true, skills: false, instructions: false });
            await withScriptedModel(env, {
                respond: scriptTurns([[{ content: "one" }], [{ content: "two" }]]),
                worker: { workspaceProvider: provider, nativeSubagents: "sync" },
            }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER, workspace: { root: "fx", folder: path.relative(fixture.root, clone) } });
                assertEqual(await session.sendAndWait("a4b turn one", TIMEOUT), "one");
                // What a checkout of another branch does to the working tree.
                fs.writeFileSync(path.join(clone, ".github", "agents", "newbie.agent.md"), "---\nname: newbie\ndescription: Only on the other branch.\ntools: [\"read\"]\n---\nNew here.\n");
                fs.rmSync(path.join(clone, ".github", "agents", "reviewer.agent.md"));
                assertEqual(await session.sendAndWait("a4b turn two", TIMEOUT), "two");
                const two = model.sessionRequests("a4b turn one").find((r) => r.position.lastUserText.includes("a4b turn two"));
                assert(taskTool(two.body).includes("newbie") && !taskTool(two.body).includes("reviewer"), "turn two resumed with the new set");
                assert(two.position.lastUserText.includes("Repo agents changed: added newbie, removed reviewer."), `the note: ${two.position.lastUserText}`);
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it("a child spawned into another checkout adopts that checkout's agents (A6)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await nativeTasksOn(env);
        const fixture = await createGitFixture();
        try {
            const parentClone = await fixture.cloneSession({ rootSessionId: "a6" });
            const childClone = await fixture.cloneSession({ rootSessionId: "a6", name: "child" });
            fs.writeFileSync(path.join(childClone, ".github", "agents", "libhelper.agent.md"),
                "---\nname: libhelper\ndescription: Only in the child's checkout.\ntools: [\"read\"]\n---\nHelp with the library.\n");
            const provider = createFakeWorkspaceProvider({ roots: [{ name: "fx", path: fixture.root }] });
            provider.setAdopt({ agents: true, skills: false, instructions: false });
            const parent = scriptTurns([[
                { tools: [{ name: "spawn_agent", args: { task: "A6-CHILD: say done", workspace: { root: "fx", folder: path.relative(fixture.root, childClone) } } }] },
                { content: "spawned" },
            ]]);
            const respond = (body, position) => (position.firstUserText.includes("A6-CHILD") ? { content: "done" } : parent(body, position));
            await withScriptedModel(env, { respond, worker: { workspaceProvider: provider, nativeSubagents: "sync" } }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, owner: OWNER, workspace: { root: "fx", folder: path.relative(fixture.root, parentClone) } });
                assertEqual(await session.sendAndWait("a6 spawn into the other checkout", TIMEOUT), "spawned");
                const deadline = Date.now() + 90_000;
                while (model.sessionRequests("A6-CHILD").length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
                const childBody = model.sessionRequests("A6-CHILD")[0]?.body;
                assert(childBody, "the child called the model");
                assert(taskTool(childBody).includes("libhelper"), "the child adopted its own checkout's agent");
                const parentBody = model.sessionRequests("a6 spawn into the other checkout")[0].body;
                assert(!taskTool(parentBody).includes("libhelper"), "the parent's checkout has no such agent");
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it("the wall-clock cap cancels a running shell before the turn returns (F10)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f10-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        const respond = scriptTurns([[
            { tools: [{ name: "bash", args: { command: "while true; do date +%s >> hb.txt; sleep 0.2; done", description: "heartbeat", mode: "async", detach: true } }] },
            { tools: [{ name: "bash", args: { command: "sleep 60", description: "too long" } }] },
            { content: "never" },
        ]]);
        try {
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "a", path: root }], turnTimeoutMs: 4_000 } }, async ({ client, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                await session.send("f10 start and hang");
                const hb = path.join(root, "repo-x", "hb.txt");
                const deadline = Date.now() + 60_000;
                while (!fs.existsSync(hb) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
                assert(fs.existsSync(hb), "the heartbeat started");
                // The cap fires about 4 s into the turn; the retry is 15 s after it.
                await new Promise((r) => setTimeout(r, 7_000));
                const before = fs.statSync(hb).size;
                await new Promise((r) => setTimeout(r, 1_500));
                assertEqual(fs.statSync(hb).size, before, "the heartbeat stopped when the capped turn returned");
                // The error retry releases the worker too; by then the cap has
                // already stopped the shell, so the release finds nothing.
                for (const released of await events(env, sessionId, "session.workspace_released")) {
                    assertEqual(released.data.cancelled, 0, `the cap stopped the shell, not the release: ${JSON.stringify(released.data)}`);
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
