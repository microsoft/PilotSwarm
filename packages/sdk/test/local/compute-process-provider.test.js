/**
 * Compute providers without a cluster: the `process` provider runs each
 * session tree's GHCP runtime as a separate local `copilot --headless`
 * process, and the worker drives it over TCP exactly as it would drive a
 * runtime on another machine (docs/proposals/compute-providers.md).
 *
 * Proves the remote-runtime plumbing end to end with the scripted model:
 *   - the turn runs in the separate runtime, with none of the worker's env
 *   - the runtime holds only credential placeholders; the model still gets
 *     the real key, swapped in by the worker's request handler
 *   - the runtime keeps its session state in the worker's session folder
 *     (SessionFs), so a new worker with a new runtime resumes the session
 *   - unknown targets and unknown kinds are refused
 *
 * Run: npx vitest run test/local/compute-process-provider.test.js
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { PilotSwarmWorker } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createProcessComputeProvider } from "../../src/compute-process.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function registerTarget(env, name, kind) {
    const catalog = await createCatalog(env);
    try {
        await catalog.computeTargets.create({ name, kind, class: "shared", displayName: name }, null, true);
    } finally {
        await catalog.close?.();
    }
}

function listTree(dir, prefix = "") {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
        ? listTree(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`]);
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const PROBE = 'echo "home=$COPILOT_HOME db=${PS_TEST_DATABASE_URL:-none} pg=${PGHOST:-none} cwd=$(pwd)"';

describe("process compute provider", () => {
    it("runs turns in a separate runtime and resumes on a new worker", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await registerTarget(env, "local-process", "process");
        const providerA = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-a") });
        const marker = `remote-${env.runId}`;
        let probeOutput = "";

        const respond = (body, position) => {
            if (position.turn === 1) {
                if (position.step === 0) return { tools: [{ name: "bash", args: { command: PROBE, description: "probe" } }] };
                probeOutput = position.toolResults.join("\n");
                return { content: `turn1:${marker}` };
            }
            const sawHistory = JSON.stringify(body.messages).includes(`turn1:${marker}`);
            return { content: `turn2:${sawHistory ? "history" : "no-history"}` };
        };

        await withScriptedModel(env, { respond, worker: { computeProviders: [providerA] } }, async ({ client, worker, model, modelProvidersPath, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, computeTarget: "local-process" });
            expect(await session.sendAndWait("first prompt", TIMEOUT)).toBe(`turn1:${marker}`);

            // The turn ran in the provider's runtime, not the worker's child process.
            const hosts = providerA.hosts();
            expect(hosts).toHaveLength(1);
            expect(hosts[0].sessions).toContain(session.sessionId);
            expect(probeOutput).toContain(`home=${hosts[0].homeDir}`);
            expect(probeOutput).toContain("db=none");
            expect(probeOutput).toContain("pg=none");

            // The runtime held placeholders; the model saw the real key.
            const requests = model.sessionRequests("first prompt");
            expect(requests.length).toBeGreaterThanOrEqual(2);
            for (const request of requests) {
                expect(request.headers.authorization).toBe("Bearer synthetic");
                expect(JSON.stringify(request.headers)).not.toContain("pilotswarm-worker-secret");
            }

            // Session state lives in the worker's folder, not the runtime's home.
            const workerFiles = listTree(join(env.sessionStateDir, session.sessionId));
            const hostFiles = listTree(hosts[0].homeDir);
            console.log(`[compute-process] worker session files: ${JSON.stringify(workerFiles)}`);
            console.log(`[compute-process] runtime home files: ${JSON.stringify(hostFiles)}`);
            expect(workerFiles).toContain("events.jsonl");
            expect(workerFiles.some((file) => file.includes("session-state/"))).toBe(false);
            expect(hostFiles.some((file) => file.includes(session.sessionId))).toBe(false);

            // A new worker with a new runtime picks the session up from the worker folder.
            const firstPid = hosts[0].pid;
            await worker.stop();
            expect(providerA.hosts()).toHaveLength(0);
            expect(isAlive(firstPid)).toBe(false);
            const providerB = createProcessComputeProvider({ rootDir: join(env.baseDir, "compute-b") });
            const replacement = new PilotSwarmWorker({
                store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                factsSchema: env.factsSchema, sessionStateDir: env.sessionStateDir,
                workerNodeId: "compute-replacement", disableManagementAgents: true,
                logLevel: "error", modelProvidersPath, computeProviders: [providerB],
            });
            await replacement.start();
            let secondPid;
            try {
                expect(await session.sendAndWait("second prompt", TIMEOUT)).toBe("turn2:history");
                expect(providerB.hosts()).toHaveLength(1);
                secondPid = providerB.hosts()[0].pid;
                expect(secondPid).not.toBe(firstPid);
            } finally {
                await replacement.stop();
                await providerB.stopAll();
            }
            expect(providerB.hosts()).toHaveLength(0);
            expect(isAlive(secondPid)).toBe(false);
        });
        await providerA.stopAll();
    });

    it("refuses an unknown target at create and an unknown kind at the turn", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await registerTarget(env, "nowhere", "no-such-kind");
        await withScriptedModel(env, { respond: () => ({ content: "should not run" }) }, async ({ client, model, qualifiedModel }) => {
            await expect(client.createSession({ model: qualifiedModel, computeTarget: "missing-target" }))
                .rejects.toThrow(/COMPUTE_TARGET_NOT_FOUND|no compute target/);
            const session = await client.createSession({ model: qualifiedModel, computeTarget: "nowhere" });
            // The refusal fails the turn; the session shows it as its error.
            // (Today the turn is then retried like any failed turn.)
            await session.send("hello");
            let info;
            for (let i = 0; i < 60; i++) {
                info = await session.getInfo();
                if (info.status === "error" && info.error) break;
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
            expect(info.status).toBe("error");
            expect(info.error).toMatch(/COMPUTE_KIND_UNKNOWN/);
            expect(model.sessionRequests()).toHaveLength(0);
        });
    });
});
