/**
 * The ways a deployment can set up workspaces, on a real worker with the
 * real Copilot CLI and the scripted model (docs/proposals/session-workspaces.md,
 * sections 4.9, 4.10 and 4.11).
 *
 *   S1  no provider: a session runs in the worker's own folder, with no
 *       workspace tools, no "Your folders are durable" section and no
 *       workspace events
 *   S2  a provider without default folders: a session with no workspace is
 *       exactly S1, and the provider is never called
 *   S3  repo only (the same provider): a session in a repo works there, has
 *       the workspace tools and the durable-folders section, and no extra
 *       folders
 *   S4  shared folder only (the provider's defaults name only extra
 *       folders): a session with no workspace gets no folders at all (rule
 *       A), and nothing is recorded
 *   S5  shared folder + repo (the same provider): a session in a repo gets
 *       the shared folder as an extra folder and the durable-folders
 *       section; its defaults are recorded once for two turns
 *
 * In every session the base prompt says a working directory on the
 * worker's own disk may be gone, not that the cwd may be.
 *
 * Run: npx vitest run test/local/workspace-setups.test.js
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
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createBuiltInWorkspaceProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const WORKSPACE_TOOLS = ["set_session_workspace", "get_session_workspace", "load_agent"];
const DURABLE_HEADING = "## Your folders are durable";
const NEW_SENTENCE = "a working directory on the worker's own disk may simply be gone next turn";
const OLD_SENTENCE = "and the cwd may simply be gone next turn";
const ENV_LINE = "Additional directories available for file access";

const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];
const toolNames = (body) => (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
/** Every turn: run pwd, then answer with it. */
const pwdEveryTurn = scriptTurns([1, 2].map(() => [
    { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
    (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
]));

/** Roots repo (a git repo "app") and shared; a provider that logs its calls, with or without defaults. */
function fixture({ defaults } = {}) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-setups-")));
    const repo = path.join(base, "repo", "app");
    fs.mkdirSync(path.join(base, "shared"), { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "app\n");
    execFileSync("git", ["init", "-q", repo]);
    const inner = createBuiltInWorkspaceProvider(["repo", "shared"].map((name) => ({ name, path: path.join(base, name) })));
    const calls = [];
    const provider = {
        listRoots: () => inner.listRoots(),
        async ensureAttached(req) {
            calls.push({ root: req.workspace.root, folder: req.workspace.folder ?? "", attachment: req.attachment ?? null });
            return inner.ensureAttached(req);
        },
        ...(defaults ? { defaultFolders: () => defaults } : {}),
    };
    return { base, repo, provider, calls, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function events(env, sessionId) {
    const catalog = await createCatalog(env);
    try {
        return await catalog.getSessionEvents(sessionId);
    } finally {
        await catalog.close?.();
    }
}

/** What the model saw in a session with no folders: the worker's own folder, no workspace tools or section, no events. */
async function assertNoFolders(env, model, prompt, answer, sessionId, what) {
    assertEqual(answer, `out:${fs.realpathSync(process.cwd())}`, `${what}: runs in the worker's own folder`);
    const body = model.sessionRequests(prompt)[0].body;
    const names = toolNames(body);
    for (const tool of WORKSPACE_TOOLS) assert(!names.includes(tool), `${what}: no ${tool}`);
    const system = systemText(body);
    assert(!system.includes(DURABLE_HEADING), `${what}: no durable-folders section`);
    assert(!system.includes(ENV_LINE), `${what}: no extra folders`);
    assert(system.includes(NEW_SENTENCE) && !system.includes(OLD_SENTENCE), `${what}: the base prompt's weakened sentence`);
    const workspaceEvents = (await events(env, sessionId)).filter((e) => e.eventType.startsWith("session.workspace_"));
    assertEqual(JSON.stringify(workspaceEvents.map((e) => e.eventType)), "[]", `${what}: no workspace events`);
}

describe("workspace setups", () => {
    it("S1 no provider: the worker's own folder, no workspace tools, no section, no events", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { respond: pwdEveryTurn }, async ({ client, model, qualifiedModel }) => {
            const sessionId = randomUUID();
            const session = await client.createSession({ sessionId, model: qualifiedModel });
            const answer = await session.sendAndWait("s1 no provider", TIMEOUT);
            await assertNoFolders(env, model, "s1 no provider", answer, sessionId, "S1");
        });
    });

    it("S2 + S3 a provider without defaults: no workspace = S1 and no provider call; a repo session works there with the section and no extra folders", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture();
        try {
            await withScriptedModel(env, { respond: pwdEveryTurn, worker: { workspaceProvider: fx.provider } }, async ({ client, model, qualifiedModel }) => {
                const plainId = randomUUID();
                const plain = await client.createSession({ sessionId: plainId, model: qualifiedModel });
                const plainAnswer = await plain.sendAndWait("s2 no workspace", TIMEOUT);
                await assertNoFolders(env, model, "s2 no workspace", plainAnswer, plainId, "S2");
                assertEqual(fx.calls.length, 0, "S2: the provider is never called");

                const repoId = randomUUID();
                const inRepo = await client.createSession({ sessionId: repoId, model: qualifiedModel, workspace: { root: "repo", folder: "app" } });
                assertEqual(await inRepo.sendAndWait("s3 repo only", TIMEOUT), `out:${fx.repo}`, "S3: the turn runs in the repo");
                const body = model.sessionRequests("s3 repo only")[0].body;
                const names = toolNames(body);
                for (const tool of WORKSPACE_TOOLS) assert(names.includes(tool), `S3: ${tool} is offered`);
                const system = systemText(body);
                assertEqual(system.split(DURABLE_HEADING).length - 1, 1, "S3: the durable-folders section, once");
                assert(!system.includes(ENV_LINE), "S3: no extra folders");
                assert(system.includes(NEW_SENTENCE) && !system.includes(OLD_SENTENCE), "S3: the weakened sentence");
                assert(fx.calls.every((call) => call.root === "repo" && call.attachment === null), `S3: only the repo is attached: ${JSON.stringify(fx.calls)}`);
                const recorded = (await events(env, repoId)).filter((e) => e.eventType === "session.workspace_defaults");
                assertEqual(recorded.length, 0, "S3: a provider without defaults records none");
            });
        } finally {
            fx.cleanup();
        }
    });

    it("S4 + S5 shared folder only: no workspace gets no folders (rule A); a repo session gets shared as an extra folder and the section, one defaults record", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fx = fixture({ defaults: { extra: { shared: { root: "shared" } } } });
        try {
            await withScriptedModel(env, { respond: pwdEveryTurn, worker: { workspaceProvider: fx.provider } }, async ({ client, model, qualifiedModel }) => {
                const plainId = randomUUID();
                const plain = await client.createSession({ sessionId: plainId, model: qualifiedModel });
                const plainAnswer = await plain.sendAndWait("s4 shared only", TIMEOUT);
                await assertNoFolders(env, model, "s4 shared only", plainAnswer, plainId, "S4");
                assertEqual(fx.calls.length, 0, "S4: an extra folder needs a working folder, so nothing is attached");

                const repoId = randomUUID();
                const inRepo = await client.createSession({ sessionId: repoId, model: qualifiedModel, workspace: { root: "repo", folder: "app" } });
                assertEqual(await inRepo.sendAndWait("s5 shared and repo", TIMEOUT), `out:${fx.repo}`, "S5: the turn runs in the repo");
                assertEqual(await inRepo.sendAndWait("s5 second turn", TIMEOUT), `out:${fx.repo}`);
                const first = model.sessionRequests("s5 shared and repo").find((r) => r.position.turn === 1 && r.position.step === 0).body;
                const system = systemText(first);
                assert(system.includes(`${ENV_LINE}:\n  - \`${path.join(fx.base, "shared")}\``), `S5: the shared folder is an extra folder: ${system.slice(system.indexOf("<environment_context>"), system.indexOf("</environment_context>"))}`);
                assertEqual(system.split(DURABLE_HEADING).length - 1, 1, "S5: the durable-folders section, once");
                assert(fx.calls.some((call) => call.root === "shared" && call.attachment === "shared"), `S5: shared attached as an extra folder: ${JSON.stringify(fx.calls)}`);
                const recorded = (await events(env, repoId)).filter((e) => e.eventType === "session.workspace_defaults");
                assertEqual(recorded.length, 1, "S5: recorded once for two turns");
                assertEqual(JSON.stringify([recorded[0].data.workingFolder, recorded[0].data.extra.map((e) => [e.name, e.root])]),
                    JSON.stringify([null, [["shared", "shared"]]]));
            });
        } finally {
            fx.cleanup();
        }
    });
});
