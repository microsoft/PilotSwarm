/**
 * Session workspaces, slice B: the per-turn attach on a real worker with the
 * real Copilot CLI and the scripted model (docs/proposals/session-workspaces.md,
 * section 4.4). Covers the happy path of B1, the worker half of F1, A5, and
 * the instruction half of A3.
 *
 * Run: npx vitest run test/local/workspace-turn.test.js
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
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createGitFixture } from "../helpers/git-fixture.mjs";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { patchSessionStartInput } from "../helpers/pinned-start.mjs";
import { createManagementClient } from "../helpers/local-workers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

/** One turn: run `command` in bash, then answer with the tool output. */
function bashThenEcho(command) {
    return scriptTurns([[
        { tools: [{ name: "bash", args: { command, description: "workspace probe" } }] },
        (_body, position) => ({ content: `out:${position.toolResults.join("\n")}` }),
    ]]);
}

describe("workspace turn", () => {
    it("runs the turn in the workspace folder: cwd, relative writes, and the CLI's cwd line (B1)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-root-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        try {
            await withScriptedModel(env, {
                respond: bashThenEcho("pwd && echo written > note.txt"),
                worker: { workspaceRoots: [{ name: "a", path: root }] },
            }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({
                    sessionId: randomUUID(), model: qualifiedModel,
                    workspace: { root: "a", folder: "repo-x" },
                });
                const answer = await session.sendAndWait("where are you", TIMEOUT);
                assert(answer.includes(path.join(root, "repo-x")), `pwd shows the workspace folder: ${answer}`);
                assertEqual(fs.readFileSync(path.join(root, "repo-x", "note.txt"), "utf8").trim(), "written");
                const first = model.sessionRequests("where are you")[0];
                assert(systemText(first.body).includes(`Current working directory: ${path.join(root, "repo-x")}`),
                    "the CLI reports the workspace folder as its working directory");
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a failed attach calls no model and records session.workspace_unavailable (F1)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: os.tmpdir() }] });
        provider.script({ type: "fail", code: "WORKSPACE_IN_USE", message: "held by another tree" });
        await withScriptedModel(env, {
            worker: { workspaceProvider: provider },
        }, async ({ client, model, qualifiedModel }) => {
            const sessionId = randomUUID();
            const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "x" } });
            await session.send("do the work");
            const catalog = await createCatalog(env);
            try {
                const [event] = await waitForEventCount(catalog, sessionId, "session.workspace_unavailable", 1, 60_000);
                assertEqual(event.data.code, "WORKSPACE_IN_USE");
                assertEqual(event.data.message, "held by another tree");
                assertEqual(event.data.revision, 1);
                assert(typeof event.data.workerNodeId === "string" && event.data.workerNodeId.length > 0, "names the worker");
            } finally {
                await catalog.close?.();
            }
            assertEqual(model.sessionRequests().length, 0, "no model call for a failed attach");
            const attach = provider.lastAttach(sessionId);
            assert(attach, "the provider was asked to attach");
            assertEqual(attach.req.rootSessionId, sessionId);
            assertEqual(attach.req.workspace.folder, "x");
        });
    });

    it("a failing provider holds the prompt, follows the shortened schedule, and the recovery turn runs it once (F2)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f2-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        provider.script({ type: "fail", code: "WORKSPACE_FOLDER_MISSING", message: "not there yet", times: 3 });
        try {
            await withScriptedModel(env, {
                respond: scriptTurns([[{ content: "recovered" }]]),
                worker: { workspaceProvider: provider },
            }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const patch = patchSessionStartInput(client, (input) => ({ ...input, workspaceRetryScheduleMs: [400, 400, 400] }), { sessionId });
                const startedAt = Date.now();
                try {
                    const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                    const sender = { kind: "user", provider: "test", subject: "ada", display: "Ada" };
                    await session.send("held prompt text", { clientMessageIds: ["cm-f2"], sender });
                    assertEqual(await session.wait(TIMEOUT), "recovered");
                } finally {
                    patch.restore();
                }
                assert(Date.now() - startedAt < 60_000, "the shortened schedule was followed");
                assertEqual(provider.callsFor("ensureAttached", { sessionId }).length, 4, "three failed attempts, then one that passed");

                const requests = model.sessionRequests();
                assert(requests.length >= 1, "the recovery turn called the model");
                const recovery = requests[0].position.lastUserText;
                assert(recovery.includes("held prompt text"), `the recovery request carries the held prompt: ${recovery}`);
                assert(!/Retrying the workspace|Internal orchestration wake-up/.test(recovery), `the recovery request carries only the held prompt: ${recovery}`);

                const catalog = await createCatalog(env);
                try {
                    const all = await catalog.getSessionEvents(sessionId);
                    const users = all.filter((e) => e.eventType === "user.message");
                    assertEqual(users.length, 1, "exactly the one held user.message");
                    assertEqual(users[0].data.content, "held prompt text");
                    assertEqual(users[0].data.workspaceQueued, true);
                    assertEqual(JSON.stringify(users[0].data.clientMessageIds), JSON.stringify(["cm-f2"]));
                    assertEqual(users[0].data.sender?.subject, "ada");
                    assertEqual(all.filter((e) => e.eventType === "session.workspace_unavailable").length, 3);
                    assertEqual(all.filter((e) => e.eventType === "session.workspace_available").length, 1);
                } finally {
                    await catalog.close?.();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /** A turn that starts a detached shell appending to hb.txt every 200 ms, then answers. */
    const startHeartbeat = scriptTurns([[
        { tools: [{ name: "bash", args: { command: "while true; do date +%s >> hb.txt; sleep 0.2; done", description: "heartbeat", mode: "async", detach: true } }] },
        { content: "started" },
    ]]);
    const heartbeatStopped = async (file) => {
        const before = fs.statSync(file).size;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return fs.statSync(file).size === before;
    };

    it("the hold-window release cancels a detached shell and tells the provider (M1, one worker)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-m1-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        try {
            await withScriptedModel(env, {
                respond: startHeartbeat,
                worker: { workspaceProvider: provider },
                client: { dehydrateOnIdle: 3 },
            }, async ({ client, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await session.sendAndWait("start the heartbeat", TIMEOUT), "started");
                const hb = path.join(root, "repo-x", "hb.txt");
                await new Promise((resolve) => setTimeout(resolve, 300));
                // Before the 3 s hold window ends, the shell must be writing.
                assert(fs.existsSync(hb) && !(await heartbeatStopped(hb)), "the heartbeat shell is writing before the release");
                const catalog = await createCatalog(env);
                try {
                    const [released] = await waitForEventCount(catalog, sessionId, "session.workspace_released", 1, 60_000);
                    assertEqual(released.data.reason, "idle");
                    assert(released.data.cancelled >= 1, `at least one task cancelled: ${JSON.stringify(released.data)}`);
                } finally {
                    await catalog.close?.();
                }
                assert(await heartbeatStopped(hb), "the detached shell stopped writing after the release");
                const releases = provider.callsFor("release", { sessionId });
                assertEqual(releases.length, 1, "the provider heard about the release once");
                assertEqual(releases[0].req.workerNodeId, "test-worker-a");
                assertEqual(releases[0].req.workspace.folder, "repo-x");
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("completing the session releases through destroySession and keeps the files (M5)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-m5-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        try {
            await withScriptedModel(env, {
                respond: startHeartbeat,
                worker: { workspaceProvider: provider },
            }, async ({ client, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await session.sendAndWait("start the heartbeat", TIMEOUT), "started");
                const hb = path.join(root, "repo-x", "hb.txt");
                const mgmt = await createManagementClient(env);
                const catalog = await createCatalog(env);
                try {
                    await mgmt.completeSession(sessionId, "done for now");
                    const [released] = await waitForEventCount(catalog, sessionId, "session.workspace_released", 1, 60_000);
                    assertEqual(released.data.reason, "destroy");
                } finally {
                    await catalog.close?.();
                    await mgmt.stop();
                }
                assert(await heartbeatStopped(hb), "the detached shell stopped writing");
                assert(fs.existsSync(hb), "the files stay");
                assertEqual(provider.callsFor("release", { sessionId }).length, 1);
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a workspace session in a git clone starts no repo hook and no repo MCP server; a plain session in the same clone still runs hooks (A5)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fixture = await createGitFixture();
        try {
            const workspaceClone = await fixture.cloneSession({ rootSessionId: "ws" });
            await withScriptedModel(env, {
                respond: scriptTurns([[{ content: "done" }]]),
                worker: { workspaceRoots: [{ name: "fx", path: fixture.root }] },
            }, async ({ client, qualifiedModel }) => {
                const session = await client.createSession({
                    sessionId: randomUUID(), model: qualifiedModel,
                    workspace: { root: "fx", folder: path.relative(fixture.root, workspaceClone) },
                });
                assertEqual(await session.sendAndWait("first prompt", TIMEOUT), "done");
                assertEqual(fs.existsSync(fixture.markers.hook), false, "no repo hook ran in the workspace session");
                assertEqual(fs.existsSync(fixture.markers.mcp), false, "no repo MCP server started");

                // Control: the same clone as a plain working directory. Repo
                // hooks run there today and must keep running (additive rule),
                // which also proves the marker can appear in this harness.
                const plain = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workingDirectory: workspaceClone });
                assertEqual(await plain.sendAndWait("second prompt", TIMEOUT), "done");
                assertEqual(fs.existsSync(fixture.markers.hook), true, "the plain session ran the repo hook");
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it("repo instructions reach the model only when the provider adopts them (A3)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fixture = await createGitFixture();
        try {
            const clone = await fixture.cloneSession({ rootSessionId: "instr" });
            const folder = path.relative(fixture.root, clone);
            const provider = createFakeWorkspaceProvider({ roots: [{ name: "fx", path: fixture.root }] });
            await withScriptedModel(env, {
                respond: scriptTurns([[{ content: "ok" }]]),
                worker: { workspaceProvider: provider },
            }, async ({ client, model, qualifiedModel }) => {
                provider.setAdopt(null);
                const plain = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "fx", folder } });
                await plain.sendAndWait("no adoption", TIMEOUT);
                const without = systemText(model.sessionRequests("no adoption")[0].body);
                assert(!without.includes(fixture.agentsMarker), "AGENTS.md is not loaded without adopt.instructions");

                provider.setAdopt({ agents: false, skills: false, instructions: true });
                const adopting = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "fx", folder } });
                await adopting.sendAndWait("with adoption", TIMEOUT);
                const withInstructions = systemText(model.sessionRequests("with adoption")[0].body);
                assert(withInstructions.includes(fixture.agentsMarker), "AGENTS.md is loaded with adopt.instructions");
            });
        } finally {
            await fixture.cleanup();
        }
    });
});
