/**
 * A session that leaves a worker lets go of its compute host there
 * (docs/proposals/compute-providers.md, "One worker drives one session").
 *
 * Two things must hold, and neither did before:
 *
 *   a. the worker that ran the last turn lets go when the session moves,
 *      instead of keeping its bridge, its pooled client and its warm handle
 *      until it evicts the session much later — otherwise two workers drive
 *      one runtime
 *   b. a provider counts its users per (worker, session), not per session,
 *      so the worker letting go cannot take a host away from a worker that
 *      is still using it
 *
 * Run: npx vitest run test/local/compute-worker-move.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../../src/index.ts";
import { createProcessComputeProvider } from "../../src/compute-process.ts";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

const until = async (probe, what, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await probe()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
};

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

async function registerTarget(env, name) {
    const catalog = await createCatalog(env);
    try {
        await catalog.computeTargets.create({ name: `shared/${name}`, kind: "process", class: "shared", displayName: name }, null, true);
    } finally {
        await catalog.close?.();
    }
}

/** Every release the provider was told about, with who told it and why. */
function recordReleases(provider) {
    const releases = [];
    const inner = provider.release.bind(provider);
    provider.release = async (req) => {
        releases.push({ sessionId: req.sessionId, workerNodeId: req.workerNodeId, reason: req.reason });
        return inner(req);
    };
    return releases;
}

describe("a compute session that moves worker", () => {
    it("lets go on the worker it leaves, and resumes cleanly on the next one", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await registerTarget(env, "move-process");
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-compute-move-")));
        // One provider for both workers: the same target, served from the
        // same place, as a pool provider would.
        const provider = createProcessComputeProvider({ rootDir: path.join(root, "hosts") });
        const releases = recordReleases(provider);
        const marker = `moved-${env.runId}`;

        const wakeUps = [];
        const respond = (body, position) => {
            if (position.lastUserText.includes("wait is now complete")) {
                const sawHistory = JSON.stringify(body.messages).includes(`before:${marker}`);
                wakeUps.push(sawHistory);
                return { content: `after:${sawHistory ? "history" : "no-history"}` };
            }
            if (position.step === 0) return { tools: [{ name: "wait", args: { seconds: 20, reason: "let the session move" } }] };
            return { content: `before:${marker}` };
        };

        const model = await startScriptedModel({ respond });
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
        // A 3 s hold window: the 20 s wait is longer, so the session leaves A
        // before its timer fires.
        const client = new PilotSwarmClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, modelProvidersPath, dehydrateOnIdle: 3,
        });
        await client.start();
        const makeWorker = (workerNodeId) => new PilotSwarmWorker({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, sessionStateDir: env.sessionStateDir,
            workerNodeId, disableManagementAgents: true, logLevel: "error",
            modelProvidersPath, computeProviders: [provider],
        });
        const workerA = makeWorker("compute-move-a");
        await workerA.start();
        let workerB;
        try {
            await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "300" }, async () => {
                const sessionId = randomUUID();
                // Waits under waitThreshold sleep inside the turn; 5 s makes
                // the 20 s wait a durable one.
                const session = await client.createSession({
                    sessionId, model: FIXTURE_QUALIFIED_MODEL, waitThreshold: 5,
                    computeTarget: "shared/move-process",
                });
                await session.send("first prompt");
                await until(() => releases.some((entry) => entry.sessionId === sessionId), "the release before the wait timer");

                const [release] = releases.filter((entry) => entry.sessionId === sessionId);
                expect(release.reason).toBe("moved");
                expect(release.workerNodeId).toBe("compute-move-a");
                // A let go of everything it held for this session: no
                // binding, no warm handle, no host of its own.
                expect(provider.hosts().some((host) => host.holders.includes(`compute-move-a\u001f${sessionId}`))).toBe(false);

                const catalog = await createCatalog(env);
                try {
                    await waitForEventCount(catalog, sessionId, "session.affinity_released", 1, 60_000);
                    await waitForEventCount(catalog, sessionId, "session.compute_released", 1, 60_000);
                } finally {
                    await catalog.close?.();
                }

                // Nothing has woken yet: A let go before the wait timer.
                expect(wakeUps).toEqual([]);

                // Only B is left, so the wake-up can only run there.
                await workerA.stop();
                workerB = makeWorker("compute-move-b");
                await workerB.start();
                await until(
                    () => provider.hosts().some((host) => host.holders.includes(`compute-move-b\u001f${sessionId}`)),
                    "B to hold the session's host",
                );
                await until(() => wakeUps.length > 0, "the wake-up turn on B");
                // B resumed the same conversation, not a fresh one.
                expect(wakeUps[0]).toBe(true);
                // B never released: it is the worker holding the session now.
                expect(releases.filter((entry) => entry.sessionId === sessionId && entry.workerNodeId === "compute-move-b")).toEqual([]);
            });
        } finally {
            await workerA.stop().catch(() => {});
            await workerB?.stop().catch(() => {});
            await client.stop().catch(() => {});
            await provider.stopAll();
            await model.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps a host alive for the worker still using it when another worker lets go", { timeout: TIMEOUT }, async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-compute-shared-")));
        const provider = createProcessComputeProvider({ rootDir: path.join(root, "hosts") });
        const target = { id: "target-1", name: "shared/shared-host", kind: "process", class: "shared", displayName: null, config: {}, enabled: true };
        const signal = AbortSignal.timeout(60_000);
        const sessionId = randomUUID();
        const rootSessionId = sessionId;
        try {
            // The same session, held by two workers at once: what a move
            // looks like from the provider's side for as long as it lasts.
            const a = await provider.bind({ target, sessionId, rootSessionId, owner: null, workerNodeId: "shared-a", signal });
            const b = await provider.bind({ target, sessionId, rootSessionId, owner: null, workerNodeId: "shared-b", signal });
            expect(a.ok && b.ok).toBe(true);
            expect(a.host.id).toBe(b.host.id);
            expect(provider.hosts()).toHaveLength(1);
            expect(provider.hosts()[0].holders).toEqual(
                expect.arrayContaining([`shared-a\u001f${sessionId}`, `shared-b\u001f${sessionId}`]));
            // One session, whatever the number of workers holding it.
            expect(provider.hosts()[0].sessions).toEqual([sessionId]);

            // A lets go. B is still using the host, so the host stays, and B
            // can still reach it.
            await provider.release({ target, host: a.host, sessionId, rootSessionId, workerNodeId: "shared-a", reason: "moved", signal });
            expect(provider.hosts()).toHaveLength(1);
            const connected = await provider.connect({
                target, host: b.host, sessionId, rootSessionId, workerNodeId: "shared-b", turnIndex: 1, signal,
                workspace: {},
            });
            expect(connected.ok).toBe(true);

            // B lets go too: nothing is using the host, so it goes.
            await provider.release({ target, host: b.host, sessionId, rootSessionId, workerNodeId: "shared-b", reason: "ended", signal });
            expect(provider.hosts()).toHaveLength(0);
        } finally {
            await provider.stopAll();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
