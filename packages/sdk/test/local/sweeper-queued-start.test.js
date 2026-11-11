/**
 * Review DR-01 (re-review of d5118761): an accepted first message whose start no worker has picked up yet is never taken
 * as ended. The session's first message is sent while no worker runs: the client commits its start and queues the
 * message, so the send is acknowledged, but the orchestration reads NotFound until a worker picks the start up. Long past
 * any grace (10 hours), scan does not list it, cleanup_session (default grace and grace 0) refuses it (StartUnresolved),
 * and prune_orchestrations (cutoffs 5 and 0) keeps it. Then a worker starts: that same message runs, on the same session.
 *
 * Real duroxide and PostgreSQL, the real session orchestration, a scripted model.
 *
 * Run: npx vitest run test/local/sweeper-queued-start.test.js
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmWorker } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createSweeperTools } from "../../src/sweeper-tools.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "sweeper-queued-start" };

function findTool(tools, name) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

describe("an accepted first message whose start waits for a worker (review DR-01)", () => {
    it("is kept by scan, cleanup and prune at any age, and runs once a worker starts", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const marker = `queued-start-${randomUUID()}`;
        let lateWorker = null;
        try {
            await withScriptedModel(env, { respond: () => ({ content: "noted" }) }, async ({ client, worker, model, qualifiedModel, modelProvidersPath }) => {
                const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
                const sessionId = session.sessionId;
                // No worker: the start the first message commits waits in the queue.
                await worker.stop();
                await session.send(`Remember ${marker} and say noted.`);
                const duroxide = client._getDuroxideClient();
                expect((await duroxide.getStatus(`session-${sessionId}`)).status).toBe("NotFound");
                expect(await catalog.getSession(sessionId)).toMatchObject({ state: "running", orchestrationId: `session-${sessionId}` });
                await catalog.pool.query(`UPDATE "${env.cmsSchema}".sessions SET updated_at = now() - interval '600 minutes' WHERE session_id = $1`, [sessionId]);

                const tools = createSweeperTools({ catalog, duroxideClient: duroxide, factStore: null });
                const scanned = await findTool(tools, "scan_completed_sessions").handler({ graceMinutes: 5 });
                expect(scanned.sessions.map(item => item.sessionId)).not.toContain(sessionId);
                for (const grace of [undefined, 0]) {
                    const refused = await findTool(tools, "cleanup_session").handler({ sessionId, ...(grace === undefined ? {} : { graceMinutes: grace }) });
                    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, refused: true, status: "StartUnresolved" });
                }
                for (const minutes of [5, 0]) {
                    const pruned = await findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: minutes });
                    expect(pruned.ok, JSON.stringify(pruned)).toBe(true);
                }
                expect((await catalog.getSession(sessionId))?.deletedAt ?? null).toBeNull();
                expect(model.requests.filter(request => JSON.stringify(request.body).includes(marker))).toEqual([]);

                // A worker starts: the queued start runs, and with it the same message.
                lateWorker = new PilotSwarmWorker({
                    store: env.store, githubToken: process.env.GITHUB_TOKEN, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema, sessionStateDir: env.sessionStateDir, workerNodeId: "test-worker-late",
                    disableManagementAgents: true, logLevel: process.env.DUROXIDE_LOG_LEVEL || "error", modelProvidersPath,
                });
                await lateWorker.start();
                await until(() => model.requests.some(request => JSON.stringify(request.body).includes(marker)), "the model to get the queued message");
                await until(async () => (await catalog.getSessionEvents(sessionId, 0, 200, ["assistant.message"]))
                    .some(event => String(event.data?.content ?? "").includes("noted")), "the session's answer to the queued message");
                expect((await duroxide.getStatus(`session-${sessionId}`)).status).toBe("Running");
                expect((await catalog.getSession(sessionId))?.deletedAt ?? null).toBeNull();
            });
        } finally {
            if (lateWorker) await lateWorker.stop().catch(() => {});
            await catalog.close();
        }
    });
});
