/**
 * Session workspaces: the per-turn attach on a real worker with the
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
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns, systemText, startScriptedModel } from "../helpers/scripted-model.mjs";
import { withScriptedModel, registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../../src/index.ts";
import { setWorkspaceCheckTestHook } from "../../src/workspace-check.ts";
import { createGitFixture } from "../helpers/git-fixture.mjs";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { patchSessionStartInput, pinSessionStartVersion, sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { createManagementClient } from "../helpers/local-workers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

/** The first line of a tool result; the bash tool appends a "<shellId: ...>" status line. */
const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

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

    it("complete, cancel and delete release through destroySession and keep the files (M5)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-m5-")));
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        try {
            await withScriptedModel(env, {
                respond: startHeartbeat,
                worker: { workspaceProvider: provider },
            }, async ({ client, qualifiedModel }) => {
                const mgmt = await createManagementClient(env);
                const catalog = await createCatalog(env);
                try {
                    for (const [end, reason] of [["completeSession", "done for now"], ["cancelSession", "not needed"], ["deleteSession", "gone"]]) {
                        const folder = `repo-${end}`;
                        fs.mkdirSync(path.join(root, folder));
                        const sessionId = randomUUID();
                        const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder } });
                        assertEqual(await session.sendAndWait("start the heartbeat", TIMEOUT), "started");
                        const hb = path.join(root, folder, "hb.txt");
                        await mgmt[end](sessionId, reason);
                        await eventually(() => provider.callsFor("release", { sessionId }).length > 0, `${end}: the provider release`);
                        assert(await heartbeatStopped(hb), `${end}: the detached shell stopped writing`);
                        assert(fs.existsSync(hb), `${end}: the files stay`);
                        assertEqual(provider.callsFor("release", { sessionId }).length, 1, `${end}: one release`);
                        // A deleted session's events go with it.
                        if (end !== "deleteSession") {
                            const [released] = await waitForEventCount(catalog, sessionId, "session.workspace_released", 1, 60_000);
                            assertEqual(released.data.reason, "destroy");
                        }
                    }
                } finally {
                    await catalog.close?.();
                    await mgmt.stop();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /** Every turn: run `pwd`, then answer "out:<its output>". */
    const pwdEveryTurn = (_body, position) => (position.step === 0
        ? { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] }
        : { content: `out:${firstLine(position.toolResults)}` });

    it("an external set moves the next turn into the folder with the changed-cwd note; a stale revision and a clear behave (B1, B5, B9)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-ext-")));
        const home = path.join(root, "home");
        fs.mkdirSync(path.join(root, "repo-x"), { recursive: true });
        fs.mkdirSync(home);
        try {
            await withScriptedModel(env, {
                respond: pwdEveryTurn,
                worker: { workspaceRoots: [{ name: "a", path: root }] },
            }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workingDirectory: home });
                assertEqual(await session.sendAndWait("turn one", TIMEOUT), `out:${home}`);
                const mgmt = await createManagementClient(env);
                try {
                    const set = await mgmt.setSessionWorkspace(sessionId, { expectedRevision: 0, workspace: { root: "a", folder: "repo-x" } });
                    assertEqual(set.status, "changed");
                    assertEqual(set.revision, 1);
                    assertEqual(set.path, path.join(root, "repo-x"));

                    const stale = await mgmt.setSessionWorkspace(sessionId, { expectedRevision: 0, workspace: { root: "a", folder: "repo-y" } }).then(() => null, (err) => err);
                    assert(stale, "a stale revision is rejected");
                    assertEqual(stale.code, "WORKSPACE_REVISION_CONFLICT");
                    assertEqual(stale.status, 409);

                    assertEqual(await session.sendAndWait("turn two", TIMEOUT), `out:${path.join(root, "repo-x")}`);
                    const turnTwo = model.sessionRequests().find((r) => r.position.lastUserText.includes("turn two"));
                    assert(turnTwo.position.lastUserText.includes('The working directory changed from the default working directory to root "a", folder "repo-x"'),
                        `the model got the changed-cwd note: ${turnTwo.position.lastUserText}`);

                    const view = await mgmt.getSessionWorkspace(sessionId);
                    assertEqual(view.revision, 1);
                    assertEqual(view.status, "ready");
                    assertEqual(view.workspace.folder, "repo-x");

                    fs.writeFileSync(path.join(root, "repo-x", "keep.txt"), "kept");
                    const cleared = await mgmt.setSessionWorkspace(sessionId, { expectedRevision: 1, workspace: null });
                    assertEqual(cleared.revision, 2);
                    assertEqual(await session.sendAndWait("turn three", TIMEOUT), `out:${home}`, "a clear returns to config.workingDirectory");
                    assert(fs.existsSync(path.join(root, "repo-x", "keep.txt")), "a clear deletes no files");
                    assertEqual((await mgmt.getSessionWorkspace(sessionId)).status, "none");
                } finally {
                    await mgmt.stop();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a set during a running turn waits for it, then the next turn resumes in the new folder and the old folder's shell is cancelled (B14)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-b14-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        fs.mkdirSync(path.join(root, "repo-y"));
        const respond = scriptTurns([
            [
                { tools: [{ name: "bash", args: { command: "while true; do date +%s >> hb.txt; sleep 0.2; done", description: "heartbeat", mode: "async", detach: true } }] },
                { tools: [{ name: "bash", args: { command: "sleep 4; pwd", description: "slow pwd" } }] },
                (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
            ],
            [
                { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
                (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
            ],
        ]);
        try {
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "a", path: root }] } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                await session.send("slow turn");
                const mgmt = await createManagementClient(env);
                const catalog = await createCatalog(env);
                try {
                    // Wait until the slow turn is running, then change the workspace under it.
                    await waitForEventCount(catalog, sessionId, "tool.execution_start", 2, 60_000).catch(() => {});
                    const set = await mgmt.setSessionWorkspace(sessionId, { expectedRevision: 1, workspace: { root: "a", folder: "repo-y" } });
                    assertEqual(set.status, "changed");
                    assertEqual(await session.wait(TIMEOUT), `out:${path.join(root, "repo-x")}`, "the running turn stayed in the old folder");
                    const all = await catalog.getSessionEvents(sessionId);
                    const lastAnswer = all.filter((e) => e.eventType === "assistant.message").at(-1);
                    const changed = all.filter((e) => e.eventType === "session.workspace_changed").at(-1);
                    assert(Number(changed.seq) > Number(lastAnswer.seq), "workspace_changed follows the running turn");
                    assertEqual(await session.sendAndWait("next turn", TIMEOUT), `out:${path.join(root, "repo-y")}`);
                    assert(await heartbeatStopped(path.join(root, "repo-x", "hb.txt")), "the old folder's detached shell was cancelled before the new resume");
                    const nextRequest = model.sessionRequests().find((r) => r.position.lastUserText.includes("next turn"));
                    assert(nextRequest.position.lastUserText.includes('to root "a", folder "repo-y"'), "the next turn got the changed-cwd note");
                } finally {
                    await catalog.close?.();
                    await mgmt.stop();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("the agent's change is acknowledged, every later tool call in the turn is refused, and one continuation turn runs in the new folder (B7)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-b7-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        fs.mkdirSync(path.join(root, "repo-y"));
        const respond = scriptTurns([
            [
                { tools: [{ name: "set_session_workspace", args: { root: "a", folder: "repo-y" } }] },
                // A model that keeps going after the acknowledgement.
                { tools: [{ name: "bash", args: { command: "touch after.txt", description: "keep going" } }, { name: "wait", args: { seconds: 5, reason: "keep going" } }] },
                { content: "stopping" },
            ],
            [
                { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
                (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
            ],
        ]);
        try {
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "a", path: root }] } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await session.sendAndWait("switch to repo-y, then fix the typo", TIMEOUT), `out:${path.join(root, "repo-y")}`);

                const requests = model.sessionRequests("switch to repo-y");
                const afterAck = requests.find((r) => r.position.turn === 1 && r.position.step === 1);
                assert(afterAck.position.toolResults.join("").includes(`You are still in ${path.join(root, "repo-x")}`), "the acknowledgement names the old folder");
                // Both later calls are refused: the deny hook covers every tool,
                // PilotSwarm tools included; a PilotSwarm tool it misses answers
                // with the turn-boundary text instead.
                const refusals = requests.find((r) => r.position.turn === 1 && r.position.step === 2).position.toolResults;
                assertEqual(refusals.length, 2, `two tool results: ${JSON.stringify(refusals)}`);
                for (const text of refusals) {
                    assert(/working directory is changing|was not executed because a previous control tool/.test(text), `refused: ${text}`);
                }
                assertEqual(fs.existsSync(path.join(root, "repo-x", "after.txt")) || fs.existsSync(path.join(root, "repo-y", "after.txt")), false, "the refused bash call ran nowhere");

                const continuations = requests.filter((r) => r.position.turn === 2 && r.position.step === 0);
                assertEqual(continuations.length, 1, "exactly one continuation turn");
                assert(continuations[0].position.lastUserText.includes('The working directory changed from root "a", folder "repo-x" to root "a", folder "repo-y"'),
                    `the continuation carries the changed-cwd note: ${continuations[0].position.lastUserText}`);

                const catalog = await createCatalog(env);
                try {
                    const all = await catalog.getSessionEvents(sessionId);
                    const changed = all.filter((e) => e.eventType === "session.workspace_changed").map((e) => e.data);
                    assertEqual(JSON.stringify(changed.map((d) => [d.source, d.revision])), JSON.stringify([["create", 1], ["agent", 2]]));
                    assertEqual(all.filter((e) => e.eventType === "session.wait_started").length, 0, "the refused wait created no durable wait");
                } finally {
                    await catalog.close?.();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("the agent's change is refused with WORKSPACE_BUSY while a background shell runs, and 'no change' lets the turn go on (B8, B4)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-b8-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        fs.mkdirSync(path.join(root, "repo-y"));
        // One script per conversation, chosen by its first prompt.
        const busyScript = scriptTurns([[
            { tools: [{ name: "bash", args: { command: "sleep 30", description: "long job", mode: "async", detach: true } }] },
            { tools: [{ name: "set_session_workspace", args: { root: "a", folder: "repo-y" } }] },
            (_body, position) => ({ content: `busy:${position.toolResults.join("").includes("WORKSPACE_BUSY")}` }),
        ]]);
        const sameScript = scriptTurns([[
            { tools: [{ name: "set_session_workspace", args: { root: "a", folder: "repo-x" } }] },
            { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
            (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
        ]]);
        // Only a detached shell: CLI 1.0.83 asks the model again only after an
        // attached background shell ends, so within a turn an attached shell is
        // never running when set_session_workspace is called.
        const respond = (body, position) => (position.firstUserText.includes("try to switch") ? busyScript : sameScript)(body, position);
        try {
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "a", path: root }] } }, async ({ client, qualifiedModel }) => {
                const busyId = randomUUID();
                const busy = await client.createSession({ sessionId: busyId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await busy.sendAndWait("try to switch", TIMEOUT), "busy:true");

                // A fresh session with nothing running: only "no change" can keep this turn going.
                const sameId = randomUUID();
                const same = await client.createSession({ sessionId: sameId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await same.sendAndWait("same folder", TIMEOUT), `out:${path.join(root, "repo-x")}`, "'no change' did not end the turn");
                const catalog = await createCatalog(env);
                try {
                    for (const id of [busyId, sameId]) {
                        const changed = (await catalog.getSessionEvents(id)).filter((e) => e.eventType === "session.workspace_changed");
                        assertEqual(changed.length, 1, "only the creation event: the call changed nothing");
                    }
                } finally {
                    await catalog.close?.();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /** Polls `probe` until it returns a truthy value. */
    const eventually = async (probe, what, timeoutMs = 90_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = await probe();
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    };

    it("spawn_agent's workspace: omitted inherits, a record is used, null gives none and the default cwd, a bad folder fails at spawn (B10)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-b10-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        fs.mkdirSync(path.join(root, "repo-y"));
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        const parentScript = scriptTurns([[
            { tools: [
                { name: "spawn_agent", args: { task: "child-inherit: report pwd" } },
                { name: "spawn_agent", args: { task: "child-record: report pwd", workspace: { root: "a", folder: "repo-y" } } },
                { name: "spawn_agent", args: { task: "child-none: report pwd", workspace: null } },
                { name: "spawn_agent", args: { task: "child-bad: report pwd", workspace: { root: "a", folder: "missing" } } },
            ] },
            (_body, position) => ({ content: `spawned:${JSON.stringify(position.toolResults)}` }),
        ]]);
        const respond = (body, position) => (/child-|plain-probe/.test(position.firstUserText) ? pwdEveryTurn : parentScript)(body, position);
        try {
            await withScriptedModel(env, { respond, worker: { workspaceProvider: provider } }, async ({ client, model, qualifiedModel }) => {
                const parentId = randomUUID();
                const parent = await client.createSession({ sessionId: parentId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                const answer = await parent.sendAndWait("spawn the four", TIMEOUT);
                const results = JSON.parse(answer.slice("spawned:".length));
                assertEqual(results.filter((text) => text.includes("Sub-agent spawned successfully")).length, 3, `three spawns: ${answer}`);
                const refused = results.filter((text) => text.includes("spawn_agent failed"));
                assertEqual(refused.length, 1, "one refused spawn");
                assert(refused[0].includes("WORKSPACE_FOLDER_MISSING"), `the bad folder fails at spawn: ${refused[0]}`);

                const plain = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel });
                const defaultCwd = (await plain.sendAndWait("plain-probe", TIMEOUT)).slice("out:".length);

                const pwdOf = (task) => eventually(() => {
                    const done = model.sessionRequests(task).find((r) => r.position.turn === 1 && r.position.step === 1);
                    return done ? firstLine(done.position.toolResults) : null;
                }, `${task} to report its pwd`);
                assertEqual(await pwdOf("child-inherit"), path.join(root, "repo-x"), "omitted: the child shares the parent's folder");
                assertEqual(await pwdOf("child-record"), path.join(root, "repo-y"), "a record: the child works there");
                const noneCwd = await pwdOf("child-none");
                assertEqual(noneCwd, defaultCwd, "null: the child lands in the default cwd");
                assert(!noneCwd.startsWith(root), "null: the child is outside every workspace");

                const catalog = await createCatalog(env);
                try {
                    const spawned = (await catalog.getSessionEvents(parentId)).filter((e) => e.eventType === "session.agent_spawned");
                    assertEqual(spawned.length, 3, "the refused spawn created no child");
                    const childFor = (prefix) => spawned.find((e) => e.data.task.startsWith(prefix)).data.childSessionId;
                    const [inheritId, recordId, noneId] = ["child-inherit", "child-record", "child-none"].map(childFor);
                    const created = async (id) => (await catalog.getSessionEvents(id))
                        .filter((e) => e.eventType === "session.workspace_changed")
                        .map((e) => [e.data.source, e.data.revision, e.data.workspace?.folder ?? null]);
                    assertEqual(JSON.stringify(await created(inheritId)), JSON.stringify([["create", 1, "repo-x"]]));
                    assertEqual(JSON.stringify(await created(recordId)), JSON.stringify([["create", 1, "repo-y"]]));
                    assertEqual(JSON.stringify(await created(noneId)), "[]", "null: no workspace at all");

                    // The record is checked on the parent's worker under the
                    // child's id, and that attach is released before the
                    // child's own first-turn attach.
                    const attaches = provider.callsFor("ensureAttached", { sessionId: recordId });
                    const releases = provider.callsFor("release", { sessionId: recordId });
                    assert(attaches.length >= 2, `a quick check and a first-turn attach: ${attaches.length}`);
                    assertEqual(releases.length >= 1, true, "the quick check was released");
                    assert(attaches[0].seq < releases[0].seq && releases[0].seq < attaches[1].seq, "check, release, then the child's attach");
                    assertEqual(attaches[0].req.rootSessionId, parentId, "the check leases under the parent's tree");
                    assertEqual(attaches[1].req.rootSessionId, parentId, "the child attaches under the parent's tree");
                    assertEqual(provider.callsFor("release", (r) => r.req?.workspace?.folder === "missing").length, 1,
                        "a failed check still releases its attach");
                    assertEqual(provider.callsFor("ensureAttached", { sessionId: noneId }).length, 0);
                    assertEqual(provider.callsFor("ensureAttached", { sessionId: inheritId })[0].req.rootSessionId, parentId);
                } finally {
                    await catalog.close?.();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a retried turn in a workspace session gets the partial-changes note; a plain session's retry does not (F6)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f6-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        const NOTE = "An earlier attempt may have changed files. Check `git status` first.";
        // Each conversation's first model call fails once; the orchestration
        // retries the turn (retryCount 1).
        const failed = new Set();
        const respond = (_body, position) => {
            if (!failed.has(position.firstUserText)) {
                failed.add(position.firstUserText);
                return { httpStatus: 400, message: "scripted failure" };
            }
            return { content: `note:${position.lastUserText.includes(NOTE)}` };
        };
        try {
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "a", path: root }] } }, async ({ client, qualifiedModel }) => {
                const workspaceId = randomUUID();
                const withWorkspace = await client.createSession({ sessionId: workspaceId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                const plain = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel });
                const [workspaceAnswer, plainAnswer] = await Promise.all([
                    withWorkspace.sendAndWait("f6 workspace turn", TIMEOUT),
                    plain.sendAndWait("f6 plain turn", TIMEOUT),
                ]);
                assertEqual(workspaceAnswer, "note:true", "the retried workspace turn carries the note");
                assertEqual(plainAnswer, "note:false", "a plain session's retry gets no note");
                const catalog = await createCatalog(env);
                try {
                    const notes = (await catalog.getSessionEvents(workspaceId)).filter((e) => e.eventType === "system.message" && e.data.workspacePartialChanges);
                    assertEqual(notes.length, 1, "the note is recorded once");
                    assertEqual(notes[0].data.content, NOTE);
                } finally {
                    await catalog.close?.();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a folder changed while warm is where a cold resume in a new CLI process lands (B2)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-b2-")));
        for (const folder of ["repo-x", "repo-y"]) fs.mkdirSync(path.join(root, folder));
        const model = await startScriptedModel({ respond: pwdEveryTurn });
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
        const workerFor = (workerNodeId) => new PilotSwarmWorker({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
            sessionStateDir: env.sessionStateDir, workerNodeId, disableManagementAgents: true, logLevel: "error",
            modelProvidersPath, workspaceRoots: [{ name: "a", path: root }],
        });
        const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, modelProvidersPath });
        let workerB;
        const workerA = workerFor("b2-worker-a");
        try {
            await workerA.start();
            await client.start();
            const sessionId = randomUUID();
            const session = await client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder: "repo-x" } });
            assertEqual(await session.sendAndWait("b2 turn one", TIMEOUT), `out:${path.join(root, "repo-x")}`);
            const mgmt = await createManagementClient(env);
            try {
                const set = await mgmt.setSessionWorkspace(sessionId, { expectedRevision: 1, workspace: { root: "a", folder: "repo-y" } });
                assertEqual(set.status, "changed");
            } finally {
                await mgmt.stop();
            }
            // The session was warm on worker A. Stop it: the next turn needs a new worker and a new CLI process.
            await workerA.stop();
            workerB = workerFor("b2-worker-b");
            await workerB.start();
            assertEqual(await session.sendAndWait("b2 turn two", TIMEOUT), `out:${path.join(root, "repo-y")}`);
            const turnTwo = model.sessionRequests("b2 turn one").find((r) => r.position.lastUserText.includes("b2 turn two"));
            assert(systemText(turnTwo.body).includes(`Current working directory: ${path.join(root, "repo-y")}`), "the new CLI process has the new cwd");
            assert(JSON.stringify(turnTwo.body.messages).includes("b2 turn one"), "the conversation was resumed, not restarted");
        } finally {
            await client.stop().catch(() => {});
            await workerB?.stop().catch(() => {});
            await workerA.stop().catch(() => {});
            await model.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a deleted folder holds the next prompt with no model call; retry now after it is back runs it once (R2)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-r2-")));
        const folder = path.join(root, "repo-x");
        fs.mkdirSync(folder);
        try {
            await withScriptedModel(env, { respond: pwdEveryTurn, worker: { workspaceRoots: [{ name: "a", path: root }] } }, async ({ client, model, qualifiedModel }) => {
                const sessionId = randomUUID();
                // A long retry schedule: only "retry now" can run the held prompt in time.
                const patch = patchSessionStartInput(client, (input) => ({ ...input, workspaceRetryScheduleMs: [600_000] }), { sessionId });
                const mgmt = await createManagementClient(env);
                const catalog = await createCatalog(env);
                try {
                    const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                    assertEqual(await session.sendAndWait("r2 turn one", TIMEOUT), `out:${folder}`);
                    fs.rmSync(folder, { recursive: true, force: true });
                    await session.send("r2 held turn");
                    const [held] = await waitForEventCount(catalog, sessionId, "session.workspace_unavailable", 1, 60_000);
                    assertEqual(held.data.code, "WORKSPACE_FOLDER_MISSING");
                    assertEqual(model.sessionRequests().filter((r) => r.position.lastUserText.includes("r2 held turn")).length, 0, "no model call while held");
                    assertEqual((await mgmt.getSessionWorkspace(sessionId)).status, "unavailable");

                    fs.mkdirSync(folder);
                    await mgmt.retrySessionWorkspace(sessionId);
                    assertEqual(await session.wait(TIMEOUT), `out:${folder}`);
                    const ran = model.sessionRequests().filter((r) => r.position.lastUserText.includes("r2 held turn") && r.position.step === 0);
                    assertEqual(ran.length, 1, "the held prompt ran exactly once");
                    assertEqual((await mgmt.getSessionWorkspace(sessionId)).status, "ready");
                } finally {
                    patch.restore();
                    await catalog.close?.();
                    await mgmt.stop();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a root the provider drops holds its sessions and is refused by the agent's tools; it and a new root work when listed again (R4)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const dirs = Object.fromEntries(["a", "b", "c"].map((name) => {
            const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ps-ws-r4-${name}-`)));
            fs.mkdirSync(path.join(dir, "repo"));
            return [name, dir];
        }));
        const rootsOf = (...names) => names.map((name) => ({ name, path: dirs[name] }));
        const provider = createFakeWorkspaceProvider({ roots: rootsOf("a", "b") });
        // Two messages: a call sent after set_session_workspace in the same
        // message is refused before it runs (review R3), so spawn_agent would
        // never reach its own check.
        let setResult = "";
        const agentScript = scriptTurns([[
            { tools: [{ name: "set_session_workspace", args: { root: "b", folder: "repo" } }] },
            (_body, position) => {
                setResult = position.toolResults.join("");
                return { tools: [{ name: "spawn_agent", args: { task: "R4-CHILD: never runs", workspace: { root: "b", folder: "repo" } } }] };
            },
            (_body, position) => ({ content: `results:${JSON.stringify([setResult, ...position.toolResults])}` }),
        ]]);
        const respond = (body, position) => (position.firstUserText.includes("r4 agent") ? agentScript : pwdEveryTurn)(body, position);
        try {
            await withScriptedModel(env, { respond, worker: { workspaceProvider: provider } }, async ({ client, model, qualifiedModel }) => {
                const patch = patchSessionStartInput(client, (input) => ({ ...input, workspaceRetryScheduleMs: [300, 300, 300] }));
                const catalog = await createCatalog(env);
                try {
                    const onB = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "b", folder: "repo" } });
                    assertEqual(await onB.sendAndWait("r4 on b", TIMEOUT), `out:${path.join(dirs.b, "repo")}`);

                    provider.setRoots(rootsOf("a"));
                    await onB.send("r4 held on b");
                    const newOnB = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "b", folder: "repo" } });
                    await newOnB.send("r4 new on b");
                    for (const id of [onB.sessionId, newOnB.sessionId]) {
                        const [held] = await waitForEventCount(catalog, id, "session.workspace_unavailable", 1, 60_000);
                        assertEqual(held.data.code, "WORKSPACE_ROOT_UNKNOWN");
                    }

                    const agent = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "a", folder: "repo" } });
                    const answer = await agent.sendAndWait("r4 agent tries root b", TIMEOUT);
                    const results = JSON.parse(answer.slice("results:".length));
                    assertEqual(results.length, 2);
                    assert(results.every((text) => text.includes("WORKSPACE_ROOT_UNKNOWN")), `both refuse root b: ${answer}`);
                    assertEqual(model.sessionRequests("R4-CHILD").length, 0, "no child was made");

                    // B comes back and C is new: no worker restart.
                    provider.setRoots(rootsOf("a", "b", "c"));
                    assertEqual(await onB.wait(TIMEOUT), `out:${path.join(dirs.b, "repo")}`);
                    assertEqual(await newOnB.wait(TIMEOUT), `out:${path.join(dirs.b, "repo")}`);
                    for (const text of ["r4 held on b", "r4 new on b"]) {
                        assertEqual(model.sessionRequests().filter((r) => r.position.lastUserText.includes(text) && r.position.step === 0).length, 1, `${text} ran once`);
                    }
                    const onC = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "c", folder: "repo" } });
                    assertEqual(await onC.sendAndWait("r4 on c", TIMEOUT), `out:${path.join(dirs.c, "repo")}`);
                } finally {
                    patch.restore();
                    await catalog.close?.();
                }
            });
        } finally {
            for (const dir of Object.values(dirs)) fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a session pinned at 1.0.79 replays on a new worker, then a command moves it to 1.0.80 with its state (C4)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const model = await startScriptedModel({ respond: scriptTurns([[{ content: "c4 one" }], [{ content: "continued" }], [{ content: "c4 three" }]]) });
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
        const workerFor = (workerNodeId) => new PilotSwarmWorker({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
            sessionStateDir: env.sessionStateDir, workerNodeId, disableManagementAgents: true, logLevel: "error", modelProvidersPath,
        });
        const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, modelProvidersPath });
        const workerA = workerFor("c4-worker-a");
        let workerB;
        try {
            await workerA.start();
            await client.start();
            const sessionId = randomUUID();
            const pin = pinSessionStartVersion(client, "1.0.79", { sessionId });
            const session = await client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL });
            assertEqual(await session.sendAndWait("c4 turn one", TIMEOUT), "c4 one");
            pin.restore();
            assertEqual(await sessionOrchestrationVersion(client, sessionId), "1.0.79");

            // A new worker replays the 1.0.79 history for the next message.
            await workerA.stop();
            workerB = workerFor("c4-worker-b");
            await workerB.start();
            const mgmt = await createManagementClient(env);
            try {
                await mgmt.sendCommand(sessionId, { cmd: "set_model", id: `c4-${randomUUID()}`, args: { model: FIXTURE_QUALIFIED_MODEL } });
            } finally {
                await mgmt.stop();
            }
            const deadline = Date.now() + 90_000;
            while (!model.sessionRequests("c4 turn one").some((r) => /Continue on /.test(r.position.lastUserText)) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
            }
            assert(model.sessionRequests("c4 turn one").some((r) => /Continue on /.test(r.position.lastUserText)), "the continuation turn ran");
            const catalog = await createCatalog(env);
            try {
                // The continuation's answer is recorded before the next prompt goes in.
                await waitForEventCount(catalog, sessionId, "assistant.message", 2, 60_000);
            } finally {
                await catalog.close?.();
            }
            assertEqual(await sessionOrchestrationVersion(client, sessionId), "1.0.80", "the command moved the session to 1.0.80");

            // No execution failed; the conversation and the turn count carried over.
            const duroxide = client._getDuroxideClient();
            const instanceId = `session-${sessionId}`;
            for (const executionId of await duroxide.listExecutions(instanceId)) {
                const history = await duroxide.readExecutionHistory(instanceId, executionId);
                const failures = history.filter((event) => /^(Orchestration|Execution)\w*Failed$/.test(event.kind) || /nondetermin/i.test(event.data ?? ""));
                assertEqual(failures.length, 0, `execution ${executionId}: ${JSON.stringify(failures).slice(0, 400)}`);
            }
            assert(!/fail/i.test((await duroxide.getInstanceInfo(instanceId)).status), "the instance is not failed");
            assertEqual(await session.sendAndWait("c4 turn three", TIMEOUT), "c4 three");
            const three = model.sessionRequests("c4 turn one").find((r) => r.position.lastUserText.includes("c4 turn three"));
            assert(three && three.position.turn >= 3, `the same conversation continued on 1.0.80 (turn ${three?.position.turn})`);
        } finally {
            await client.stop().catch(() => {});
            await workerB?.stop().catch(() => {});
            await workerA.stop().catch(() => {});
            await model.close();
        }
    });

    /** Runs `fn` with the worker's turn and orchestration slots raised, so many turns run at once. */
    const withConcurrency = async (slots, fn) => {
        const saved = [process.env.PILOTSWARM_WORKER_CONCURRENCY, process.env.PILOTSWARM_ORCHESTRATION_CONCURRENCY];
        process.env.PILOTSWARM_WORKER_CONCURRENCY = String(slots);
        process.env.PILOTSWARM_ORCHESTRATION_CONCURRENCY = String(slots);
        try {
            return await fn();
        } finally {
            const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
            restore("PILOTSWARM_WORKER_CONCURRENCY", saved[0]);
            restore("PILOTSWARM_ORCHESTRATION_CONCURRENCY", saved[1]);
        }
    };

    it("a hung path check holds that root's sessions; other roots and plain sessions keep running turns (F3, F5)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f3a-")));
        const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f3b-")));
        for (const dir of [path.join(rootA, "x"), path.join(rootA, "y"), path.join(rootB, "z")]) fs.mkdirSync(dir);
        // The check of a/x hangs past its deadline and cannot be killed: root a stays hung for 12 s.
        // The hook runs when a check starts, so it also signals that start (T9).
        let hungStarted;
        const hung = new Promise((resolve) => { hungStarted = resolve; });
        setWorkspaceCheckTestHook((req) => {
            if (req.path !== path.join(rootA, "x")) return undefined;
            hungStarted();
            return { sleepMs: 12_000, unkillable: true };
        });
        try {
            await withConcurrency(8, () => withScriptedModel(env, {
                respond: pwdEveryTurn,
                worker: { workspaceRoots: [{ name: "a", path: rootA }, { name: "b", path: rootB }] },
            }, async ({ client, model, qualifiedModel }) => {
                const make = (workspace) => client.createSession({ sessionId: randomUUID(), model: qualifiedModel, ...(workspace ? { workspace } : {}) });
                const [onX, onY, onZ, plain] = await Promise.all([make({ root: "a", folder: "x" }), make({ root: "a", folder: "y" }), make({ root: "b", folder: "z" }), make(null)]);
                const started = Date.now();
                await onX.send("f3 hung x");
                await hung;
                await onY.send("f3 queued y");
                const [z, p] = await Promise.all([onZ.sendAndWait("f3 other root", TIMEOUT), plain.sendAndWait("f3 no workspace", TIMEOUT)]);
                assertEqual(z, `out:${path.join(rootB, "z")}`);
                assert(p.startsWith("out:"), p);
                assert(Date.now() - started < 11_000, `the other root and the plain session answered while root a was hung (${Date.now() - started} ms)`);

                const catalog = await createCatalog(env);
                try {
                    for (const session of [onX, onY]) {
                        const [held] = await waitForEventCount(catalog, session.sessionId, "session.workspace_unavailable", 1, 30_000);
                        assertEqual(held.data.code, "WORKSPACE_CHECK_TIMEOUT");
                    }
                } finally {
                    await catalog.close?.();
                }
                assertEqual(model.sessionRequests().filter((r) => /f3 (hung|queued)/.test(r.position.lastUserText)).length, 0, "no model call for the held sessions");
            }));
        } finally {
            setWorkspaceCheckTestHook(null);
            await new Promise((r) => setTimeout(r, 12_500)); // let the unkillable check exit before cleanup
            for (const dir of [rootA, rootB]) fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("ten sessions in ten folders of one root run at once in one CLI process; a slow check delays, a hung one holds the rest (F8)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f8-")));
        const hungRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f8h-")));
        const folders = Array.from({ length: 10 }, (_, i) => `f${i}`);
        for (const folder of folders) {
            fs.mkdirSync(path.join(root, folder));
            fs.mkdirSync(path.join(hungRoot, folder));
        }
        try {
            await withConcurrency(24, () => withScriptedModel(env, {
                respond: pwdEveryTurn,
                worker: { workspaceRoots: [{ name: "a", path: root }, { name: "h", path: hungRoot }] },
            }, async ({ client, worker, model, qualifiedModel }) => {
                const sessions = await Promise.all(folders.map((folder) => client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "a", folder } })));
                const answers = await Promise.all(sessions.map((session, i) => session.sendAndWait(`f8 turn one ${i}`, TIMEOUT)));
                answers.forEach((answer, i) => assertEqual(answer, `out:${path.join(root, folders[i])}`));
                // The client pool (one CopilotClient, so one CLI process, per key): one entry for the root.
                const workspaceClients = [...worker.sessionManager.clients.keys()].filter((key) => key.includes("\0workspace-root:"));
                assertEqual(workspaceClients.length, 1, "one CLI process serves the root");

                // The hook runs when a check starts; `startOf` resolves at that start (T9).
                const startOf = (target, answer) => new Promise((resolve) => {
                    setWorkspaceCheckTestHook((req) => {
                        if (req.path !== target) return undefined;
                        resolve();
                        return answer;
                    });
                });
                // A slow but live check (2 s) for one session: the other nine wait and pass.
                const slowStarted = startOf(path.join(root, "f0"), { sleepMs: 2_000 });
                await sessions[0].send("f8 slow 0");
                await slowStarted;
                const slowAnswers = await Promise.all(sessions.slice(1).map((session, i) => session.sendAndWait(`f8 slow ${i + 1}`, TIMEOUT)));
                slowAnswers.forEach((answer, i) => assertEqual(answer, `out:${path.join(root, folders[i + 1])}`));
                assertEqual(await sessions[0].wait(TIMEOUT), `out:${path.join(root, "f0")}`);

                // A hung check on the other root: the nine queued behind it fail within about 5 s and are held.
                const onHung = await Promise.all(folders.map((folder) => client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "h", folder } })));
                const hungStarted = startOf(path.join(hungRoot, "f0"), { sleepMs: 15_000, unkillable: true });
                await onHung[0].send("f8 hung 0");
                await hungStarted;
                const started = Date.now();
                await Promise.all(onHung.slice(1).map((session, i) => session.send(`f8 hung ${i + 1}`)));
                const catalog = await createCatalog(env);
                try {
                    for (const session of onHung) {
                        const [held] = await waitForEventCount(catalog, session.sessionId, "session.workspace_unavailable", 1, 30_000);
                        assertEqual(held.data.code, "WORKSPACE_CHECK_TIMEOUT");
                    }
                    assert(Date.now() - started < 12_000, `the nine were held within about 5 s of the hung check (${Date.now() - started} ms)`);
                    for (const session of sessions) {
                        assertEqual((await catalog.getSessionEvents(session.sessionId)).filter((e) => e.eventType === "session.workspace_unavailable").length, 0,
                            "the slow check held nobody on root a");
                    }
                } finally {
                    await catalog.close?.();
                }
                assertEqual(model.sessionRequests().filter((r) => /f8 hung/.test(r.position.lastUserText)).length, 0, "no model call on the hung root");
            }));
        } finally {
            setWorkspaceCheckTestHook(null);
            await new Promise((r) => setTimeout(r, 15_500)); // let the unkillable check exit before cleanup
            for (const dir of [root, hungRoot]) fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("two setters racing on one revision: one wins, one gets WORKSPACE_REVISION_CONFLICT, the revision rises by one (R3)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-r3-")));
        for (const f of ["repo-x", "repo-y", "repo-z"]) fs.mkdirSync(path.join(root, f));
        try {
            await withScriptedModel(env, { respond: pwdEveryTurn, worker: { workspaceRoots: [{ name: "a", path: root }] } }, async ({ client, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                await session.sendAndWait("hello", TIMEOUT);
                const mgmt = await createManagementClient(env);
                try {
                    const results = await Promise.allSettled([
                        mgmt.setSessionWorkspace(sessionId, { expectedRevision: 1, workspace: { root: "a", folder: "repo-y" } }),
                        mgmt.setSessionWorkspace(sessionId, { expectedRevision: 1, workspace: { root: "a", folder: "repo-z" } }),
                    ]);
                    assertEqual(results.filter((r) => r.status === "fulfilled").length, 1);
                    const loser = results.find((r) => r.status === "rejected");
                    assertEqual(loser?.reason?.code, "WORKSPACE_REVISION_CONFLICT");
                    assertEqual((await mgmt.getSessionWorkspace(sessionId)).revision, 2);
                } finally {
                    await mgmt.stop();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a workspace session in a git clone runs no repo hook; a plain session in the same clone still runs hooks (A5)", { timeout: TIMEOUT }, async () => {
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
                // Repo MCP servers need CLI discovery and a trusted folder, which
                // PilotSwarm never turns on for any session; this harness cannot
                // make one start, so it makes no claim about them (T7).

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
    it("after a clear, turns run in the default folder with repo hooks off, and the checkout's shells are stopped (review R1, R2)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const fixture = await createGitFixture();
        try {
            const clone = await fixture.cloneSession({ rootSessionId: "clear" });
            const respond = scriptTurns([
                [
                    { tools: [{ name: "bash", args: { command: "while true; do date +%s >> hb.txt; sleep 0.2; done", description: "heartbeat", mode: "async", detach: true } }] },
                    { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
                    (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
                ],
                [
                    { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
                    (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
                ],
            ]);
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "fx", path: fixture.root }] } }, async ({ client, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "fx", folder: path.relative(fixture.root, clone) } });
                assertEqual(await session.sendAndWait("clear turn one", TIMEOUT), `out:${clone}`);
                const mgmt = await createManagementClient(env);
                try {
                    assertEqual((await mgmt.setSessionWorkspace(sessionId, { expectedRevision: 1, workspace: null })).revision, 2);
                } finally {
                    await mgmt.stop();
                }
                // A resume with no folder would land back in the checkout the CLI
                // session was created in, and run its hooks.
                assertEqual(await session.sendAndWait("clear turn two", TIMEOUT), `out:${fs.realpathSync(process.cwd())}`);
                assertEqual(fs.existsSync(fixture.markers.hook), false, "no repo hook ran after the clear");
                assert(await heartbeatStopped(path.join(clone, "hb.txt")), "the checkout's detached shell was stopped when the session left it");
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it("a tool call after set_session_workspace in the same message is refused; after a refused change the turn goes on (review R3)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-r3same-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        fs.mkdirSync(path.join(root, "repo-y"));
        const touch = (file) => ({ name: "bash", args: { command: `touch ${file}`, description: "same message" } });
        const accepted = scriptTurns([
            [
                { tools: [{ name: "set_session_workspace", args: { root: "a", folder: "repo-y" } }, touch("same-message.txt")] },
                (_body, position) => ({ content: `results:${position.toolResults.join(" | ")}` }),
            ],
            [{ content: "continued" }],
        ]);
        const refused = scriptTurns([[
            { tools: [{ name: "set_session_workspace", args: { root: "a", folder: "missing" } }, touch("too-early.txt")] },
            { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] },
            (_body, position) => ({ content: `out:${firstLine(position.toolResults)}` }),
        ]]);
        const respond = (body, position) => (position.firstUserText.includes("refused change") ? refused : accepted)(body, position);
        try {
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "a", path: root }] } }, async ({ client, model, qualifiedModel }) => {
                const moved = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await moved.sendAndWait("switch and touch", TIMEOUT), "continued");
                for (const folder of ["repo-x", "repo-y"]) {
                    assertEqual(fs.existsSync(path.join(root, folder, "same-message.txt")), false, `the call after the change ran nowhere (${folder})`);
                }
                const results = model.sessionRequests("switch and touch").find((r) => r.position.turn === 1 && r.position.step === 1).position.toolResults.join(" | ");
                assert(/has not answered yet/.test(results), `the same-message call was refused: ${results}`);

                const stays = await client.createSession({ sessionId: randomUUID(), model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await stays.sendAndWait("refused change", TIMEOUT), `out:${path.join(root, "repo-x")}`, "the refused change let the turn go on");
                assertEqual(fs.existsSync(path.join(root, "repo-x", "too-early.txt")), false, "the call sent with the refused change did not run");
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("a turn cut by the wall-clock cap after the agent's change was accepted still moves the session (review F8)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f8cap-")));
        fs.mkdirSync(path.join(root, "repo-x"));
        fs.mkdirSync(path.join(root, "repo-y"));
        const respond = (_body, position) => {
            if (position.turn === 1 && position.step === 0) return { tools: [{ name: "set_session_workspace", args: { root: "a", folder: "repo-y" } }] };
            // The model hangs after the acknowledgement; the cap ends the turn.
            if (position.turn === 1) return new Promise((resolve) => setTimeout(() => resolve({ content: "too late" }), 20_000));
            if (position.step === 0) return { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] };
            return { content: `out:${firstLine(position.toolResults)}` };
        };
        try {
            await withScriptedModel(env, { respond, worker: { workspaceRoots: [{ name: "a", path: root }], turnTimeoutMs: 4_000 } }, async ({ client, qualifiedModel }) => {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder: "repo-x" } });
                assertEqual(await session.sendAndWait("switch, then hang", TIMEOUT), `out:${path.join(root, "repo-y")}`, "the retried turn ran in the new folder");
                const catalog = await createCatalog(env);
                try {
                    const changed = (await catalog.getSessionEvents(sessionId))
                        .filter((e) => e.eventType === "session.workspace_changed")
                        .map((e) => [e.data.source, e.data.revision]);
                    assertEqual(JSON.stringify(changed), JSON.stringify([["create", 1], ["agent", 2]]));
                } finally {
                    await catalog.close?.();
                }
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it("a regular file, a FIFO or a link to a file at the folder is refused at once as not a directory (F7)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-f7-")));
        fs.writeFileSync(path.join(root, "file"), "not a folder");
        execFileSync("mkfifo", [path.join(root, "fifo")]);
        fs.symlinkSync(path.join(root, "file"), path.join(root, "link"));
        try {
            await withScriptedModel(env, {
                respond: scriptTurns([[{ content: "never" }]]),
                worker: { workspaceRoots: [{ name: "a", path: root }] },
            }, async ({ client, model, qualifiedModel }) => {
                const catalog = await createCatalog(env);
                try {
                    for (const folder of ["file", "fifo", "link"]) {
                        const sessionId = randomUUID();
                        const session = await client.createSession({ sessionId, model: qualifiedModel, workspace: { root: "a", folder } });
                        await session.send(`f7 ${folder}`);
                        const [held] = await waitForEventCount(catalog, sessionId, "session.workspace_unavailable", 1, 30_000);
                        // A check that opened the FIFO would hang and fail with WORKSPACE_CHECK_TIMEOUT instead.
                        assertEqual(held.data.code, "WORKSPACE_FOLDER_MISSING", folder);
                    }
                } finally {
                    await catalog.close?.();
                }
                assertEqual(model.sessionRequests().filter((r) => /f7 /.test(r.position.lastUserText)).length, 0, "no model call");
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
