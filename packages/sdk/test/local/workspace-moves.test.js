/**
 * Session workspaces across workers (docs/proposals/session-workspaces.md,
 * tests M2, M3 and M4, level W). Workers run in this process and share one
 * fake provider, which records each call with the worker's id. A move is
 * forced by stopping the worker that holds the session and starting another.
 *
 *   M2  the workspace moves A -> B -> A; each turn reads and edits the same
 *       relative file, and each attach names the worker running the turn
 *   M3  A is killed mid-turn: B runs the turn again with the partial-changes
 *       note; no release ran; the provider saw a dead holder
 *   M4  a graceful shutdown finishes the short turn within the drain budget,
 *       cuts the long one, releases the idle sessions but not the cut one
 *   F4  two failed attaches on one worker release the session, so another
 *       worker runs it promptly
 *   M7  a hold survives a continue-as-new, and the held prompt runs once
 *
 * Run: npx vitest run test/local/workspace-moves.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_PROVIDER, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { PilotSwarmClient, PilotSwarmManagementClient, PilotSwarmWorker } from "../../src/index.ts";
import { patchSessionStartInput } from "../helpers/pinned-start.mjs";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);
const NOTE = "An earlier attempt may have changed files";
/** A second model of the scripted provider, for a model switch. */
const SECOND_MODEL = "fixture-model-2";

/** A scripted model, a shared fake provider, a client, and workers made on demand. */
async function cluster(env, respond, clientOptions = {}, { extraModels = [] } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-moves-")));
    fs.mkdirSync(path.join(root, "repo"));
    const model = await startScriptedModel({ respond });
    const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
    if (extraModels.length > 0) {
        const file = JSON.parse(fs.readFileSync(modelProvidersPath, "utf8"));
        file.providers[0].models.push(...extraModels.map((name) => ({ name, description: "Another scripted model." })));
        fs.writeFileSync(modelProvidersPath, JSON.stringify(file, null, 2));
    }
    const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
    const workers = [];
    const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, modelProvidersPath, ...clientOptions });
    await client.start();
    return {
        root, model, provider, client, modelProvidersPath,
        async worker(workerNodeId) {
            const worker = new PilotSwarmWorker({
                store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
                sessionStateDir: env.sessionStateDir, workerNodeId, disableManagementAgents: true, logLevel: "error",
                modelProvidersPath, workspaceProvider: provider,
            });
            await worker.start();
            workers.push(worker);
            return worker;
        },
        async close() {
            await client.stop().catch(() => {});
            for (const worker of workers) await worker.stop().catch(() => {});
            await model.close();
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

const withEnv = async (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const until = async (probe, what, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await probe()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
    }
};

/** Each turn runs the bash command after "run:" in its prompt, then answers with the output. */
const runFromPrompt = (_body, position) => {
    if (position.step === 0) {
        const command = /run: ([\s\S]*)$/.exec(position.lastUserText.split("\n\n<system_context>")[0])?.[1];
        return command ? { tools: [{ name: "bash", args: { command, description: "scripted" } }] } : { content: "ok" };
    }
    return { content: `out:${position.toolResults.join("").trim().split("\n").filter((l) => !l.startsWith("<shellId")).join("|")}` };
};

describe("workspace moves between workers", () => {
    it("the workspace survives moves A -> B -> A: relative files, the right attach path and worker id (M2)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const c = await cluster(env, runFromPrompt);
        try {
            await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "10000" }, async () => {
                const folder = path.join(c.root, "repo");
                const workerA = await c.worker("m2-a");
                const sessionId = randomUUID();
                const session = await c.client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder: "repo" } });
                assertEqual(await session.sendAndWait("m2 one run: echo hello > notes.txt && pwd", TIMEOUT), `out:${folder}`);
                await workerA.gracefulShutdown();
                assertEqual(c.provider.callsFor("release", { sessionId }).map((r) => r.req.workerNodeId).join(","), "m2-a", "A released on its way out");
                assertEqual(c.provider.callsFor("release", { sessionId })[0].req.reason, "shutdown", "A's release says the worker shut down");

                const workerB = await c.worker("m2-b");
                assertEqual(await session.sendAndWait("m2 two run: cat notes.txt && pwd && echo edited >> notes.txt", TIMEOUT), `out:hello|${folder}`);
                assertEqual(c.provider.lastAttach(sessionId).req.workerNodeId, "m2-b", "B attached for its turn");
                assertEqual(c.provider.lastAttach(sessionId).result.path, folder, "the same folder on B");
                await workerB.gracefulShutdown();

                await c.worker("m2-a");
                assertEqual(await session.sendAndWait("m2 three run: cat notes.txt && pwd", TIMEOUT), `out:hello|edited|${folder}`);
                assertEqual(c.provider.lastAttach(sessionId).req.workerNodeId, "m2-a", "back on A");
                assertEqual(c.provider.callsFor("release", { sessionId }).map((r) => r.req.workerNodeId).join(","), "m2-a,m2-b", "each move released the old worker");
            });
        } finally {
            await c.close();
        }
    });

    it("a worker killed mid-turn: the next worker runs the turn again with the partial-changes note; no release; a dead holder (M3)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        // The first attempt starts a long command; the attempt that got the note answers.
        const respond = (_body, position) => {
            if (position.lastUserText.includes(NOTE)) return { content: "note:true" };
            if (position.step === 0) return { tools: [{ name: "bash", args: { command: "echo partial > half.txt; sleep 60", description: "long" } }] };
            return { content: "note:false" };
        };
        const c = await cluster(env, respond);
        try {
            // stop() waits this long for the running turn, then cuts it; it never tells the provider.
            await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "300" }, async () => {
                const workerA = await c.worker("m3-a");
                const sessionId = randomUUID();
                const session = await c.client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder: "repo" } });
                await session.send("m3 long turn");
                await until(() => fs.existsSync(path.join(c.root, "repo", "half.txt")), "the first attempt to start its command");
                await workerA.stop();

                await c.worker("m3-b");
                assertEqual(await session.wait(TIMEOUT), "note:true", "the turn ran again on B with the partial-changes note");
                assertEqual(c.provider.callsFor("release", { sessionId }).length, 0, "no release ran for the killed worker");
                assert(c.provider.deadHolderSeen(sessionId), "the provider saw A as a dead holder at B's attach");
                assertEqual(c.provider.lastAttach(sessionId).req.workerNodeId, "m3-b");
            });
        } finally {
            await c.close();
        }
    });

    it("a graceful shutdown finishes the short turn, cuts the long one, and releases only what is idle (M4)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const respond = (_body, position) => {
            if (position.lastUserText.includes(NOTE)) return { content: "long:again" };
            if (position.lastUserText.includes("m4 long") && position.step === 0) {
                return { tools: [{ name: "bash", args: { command: "echo started > long.txt; sleep 60", description: "long" } }] };
            }
            if (position.lastUserText.includes("m4 short") && position.step === 0) {
                return { tools: [{ name: "bash", args: { command: "sleep 1; echo short-done", description: "short" } }] };
            }
            return { content: position.lastUserText.includes("m4 idle") ? "idle:done" : "short:done" };
        };
        const c = await cluster(env, respond);
        try {
            await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "6000" }, async () => {
                for (const folder of ["idle", "short", "long"]) fs.mkdirSync(path.join(c.root, folder));
                const workerA = await c.worker("m4-a");
                const make = (folder) => c.client.createSession({ sessionId: randomUUID(), model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder } });
                const [idle, short, long] = await Promise.all([make("idle"), make("short"), make("long")]);
                assertEqual(await idle.sendAndWait("m4 idle", TIMEOUT), "idle:done");
                await long.send("m4 long");
                await until(() => fs.existsSync(path.join(c.root, "long", "long.txt")), "the long turn to start");
                await short.send("m4 short");
                await until(() => c.model.sessionRequests("m4 short").length > 0, "the short turn to start");

                await workerA.gracefulShutdown();
                // The short turn's activity finished inside the drain, so its
                // session was idle when A released; the long one was cut.
                const releasedIds = new Set(c.provider.callsFor("release").map((r) => r.req.sessionId));
                assert(releasedIds.has(idle.sessionId), "the idle session was released");
                assert(releasedIds.has(short.sessionId), "the session whose turn finished in the drain was released");
                assert(!releasedIds.has(long.sessionId), "the cut turn's session was not released");

                // With no worker left, B processes what A finished and runs what A cut.
                await c.worker("m4-b");
                assertEqual(await short.wait(TIMEOUT), "short:done");
                assertEqual(c.model.sessionRequests("m4 short").filter((r) => r.position.step === 0).length, 1, "the short turn ran once, on A");
                assertEqual(await long.wait(TIMEOUT), "long:again", "the cut turn ran again on B with the note");
                assert(c.provider.deadHolderSeen(long.sessionId), "the provider saw A as a dead holder for the cut session");
                // The idle session must attach on B before a dead holder can show (T5).
                assertEqual(await idle.sendAndWait("m4 idle again", TIMEOUT), "idle:done");
                assertEqual(c.provider.lastAttach(idle.sessionId).req.workerNodeId, "m4-b");
                assert(!c.provider.deadHolderSeen(idle.sessionId), "not for a released one");
            });
        } finally {
            await c.close();
        }
    });

    it("a wait longer than the hold window releases on the current worker first; the wake-up on another worker runs no release (M1)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const respond = (_body, position) => {
            if (position.lastUserText.includes("wait is now complete")) return { content: "woke" };
            if (position.step === 0) return { tools: [{ name: "wait", args: { seconds: 20, reason: "wait for the build" } }] };
            return { content: "waiting" };
        };
        // A 3 s hold window: the 20 s wait is longer, so the session leaves A before its timer.
        const c = await cluster(env, respond, { dehydrateOnIdle: 3 });
        try {
            await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "300" }, async () => {
                const workerA = await c.worker("m1-a");
                const sessionId = randomUUID();
                // Waits under waitThreshold sleep inside the turn; 5 s makes the 20 s wait durable.
                const session = await c.client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, waitThreshold: 5, workspace: { root: "a", folder: "repo" } });
                await session.send("m1 wait across workers");
                await until(() => c.provider.callsFor("release", { sessionId }).length > 0, "the release before the wait timer");
                const [release] = c.provider.callsFor("release", { sessionId });
                assertEqual(release.req.reason, "moved", "the session left A and stays open");
                assertEqual(release.req.workerNodeId, "m1-a", "released on the worker that ran the turn");
                assert(c.model.sessionRequests("m1 wait").every((r) => !r.position.lastUserText.includes("wait is now complete")), "released before the timer fired");
                // A finishes its part of the release (the affinity goes) before it stops.
                const catalog = await createCatalog(env);
                try {
                    await waitForEventCount(catalog, sessionId, "session.affinity_released", 1, 30_000);
                } finally {
                    await catalog.close?.();
                }
                await workerA.stop();

                await c.worker("m1-b");
                await until(() => c.model.sessionRequests("m1 wait").some((r) => r.position.lastUserText.includes("wait is now complete")), "the wake-up turn", 90_000);
                const calls = c.provider.callsFor("release", { sessionId });
                assertEqual(calls.length, 1, "the wake-up on B ran no release");
                assertEqual(c.provider.lastAttach(sessionId).req.workerNodeId, "m1-b", "the wake-up attached on B");
            });
        } finally {
            await c.close();
        }
    });
    it("two failed attaches on one worker release the session, so another worker runs it promptly (F4)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const c = await cluster(env, () => ({ content: "ran" }));
        try {
            await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "300" }, async () => {
                // The mount is gone on A only.
                c.provider.script({ type: "fail", code: "WORKSPACE_FOLDER_MISSING", message: "the mount is gone on A" }, { workerNodeId: "f4-a" });
                const workerA = await c.worker("f4-a");
                const sessionId = randomUUID();
                // A quick first retry, then a long one: the second failure on A
                // releases the session, and the next attempt comes 8 s later.
                const patch = patchSessionStartInput(c.client, (input) => ({ ...input, workspaceRetryScheduleMs: [300, 8_000, 600_000] }), { sessionId });
                let session;
                try {
                    session = await c.client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder: "repo" } });
                    await session.send("f4 run anywhere");
                } finally {
                    patch.restore();
                }
                const catalog = await createCatalog(env);
                try {
                    const [released] = await waitForEventCount(catalog, sessionId, "session.affinity_released", 1, 60_000);
                    assertEqual(released.data.reason, "workspace_unavailable");
                    assertEqual(released.data.failures, 2);
                } finally {
                    await catalog.close?.();
                }
                assertEqual(c.provider.callsFor("ensureAttached", { sessionId }).filter((r) => r.req.workerNodeId === "f4-a").length, 2);
                await workerA.stop();

                // The released session takes a new key, which B can take at once.
                // Without the release, B would wait out A's ownership of the old key.
                const stoppedAt = Date.now();
                await c.worker("f4-b");
                assertEqual(await session.wait(TIMEOUT), "ran");
                assert(Date.now() - stoppedAt < 20_000, `B ran the turn promptly (${Date.now() - stoppedAt} ms)`);
                assertEqual(c.provider.lastAttach(sessionId).req.workerNodeId, "f4-b");
            });
        } finally {
            await c.close();
        }
    });
    it("a hold survives a continue-as-new: after a model switch the held prompt runs once and the workspace comes back (M7)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const respond = (_body, position) => ({ content: `ran:${position.lastUserText.includes("m7 held prompt") ? "held" : "other"}` });
        const c = await cluster(env, respond, {}, { extraModels: [SECOND_MODEL] });
        try {
            c.provider.script({ type: "fail", code: "WORKSPACE_FOLDER_MISSING", message: "not there yet" });
            await c.worker("m7-a");
            const sessionId = randomUUID();
            // A long schedule: only the model switch brings the next attempt.
            const patch = patchSessionStartInput(c.client, (input) => ({ ...input, workspaceRetryScheduleMs: [600_000] }), { sessionId });
            let session;
            try {
                session = await c.client.createSession({ sessionId, model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder: "repo" } });
                await session.send("m7 held prompt", { clientMessageIds: ["cm-m7"] });
            } finally {
                patch.restore();
            }
            const catalog = await createCatalog(env);
            const mgmt = new PilotSwarmManagementClient({
                store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
                modelProvidersPath: c.modelProvidersPath,
            });
            await mgmt.start();
            try {
                await waitForEventCount(catalog, sessionId, "session.workspace_unavailable", 1, 60_000);
                c.provider.clearScripts();
                // The switch continues the session as new; its first turn is the next attempt.
                await mgmt.setSessionModel(sessionId, `${FIXTURE_PROVIDER}:${SECOND_MODEL}`);
                assertEqual(await session.wait(TIMEOUT), "ran:held");
                const all = await catalog.getSessionEvents(sessionId);
                assertEqual(all.filter((e) => e.eventType === "user.message").length, 1, "the held prompt was recorded once");
                assertEqual(all.filter((e) => e.eventType === "session.workspace_available").length, 1);
                assertEqual(c.model.sessionRequests().filter((r) => r.position.lastUserText.includes("m7 held prompt")).length, 1, "it ran once");
            } finally {
                await mgmt.stop();
                await catalog.close?.();
            }
        } finally {
            await c.close();
        }
    });
});
