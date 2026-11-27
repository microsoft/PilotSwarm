/**
 * Happy-path Workflow surface scenario: SDK direct (`PilotSwarmManagementClient`).
 *
 * Exercises S1–S6 (discover, author, run, control, packages, clean up) against
 * a real PostgreSQL database and live embedded worker with model-free flows.
 *
 * Run: npm exec --workspace=pilotswarm-sdk -- vitest run test/local/workflow-surface-sdk.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { useSuiteEnv, testTime } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { managementClientAdapter, runWorkflowSurfaceScenario } from "../helpers/workflow-surface-scenario.mjs";
import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
    PilotSwarmWorker,
    FilesystemArtifactStore,
    workflowScriptsOptionFromEnv,
} from "../../src/index.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "wf-surface-sdk" };

describe("Workflow surface scenario: SDK direct (PilotSwarmManagementClient)", () => {
    it("runs S1–S6 happy paths end to end", async () => {
        const env = getEnv();
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wf-surface-sdk-artifacts-"));
        const artifactStore = new FilesystemArtifactStore(artifactDir);
        const model = await startScriptedModel({ respond: () => ({ content: "Ready." }) });
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);

        const worker = new PilotSwarmWorker({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            sessionStateDir: env.sessionStateDir,
            artifactDir,
            modelProvidersPath,
            workerNodeId: `wf-surface-sdk-${process.pid}`,
            disableManagementAgents: true,
            logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
            ...workflowScriptsOptionFromEnv(),
        });
        await worker.start();

        const client = new PilotSwarmClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            modelProvidersPath,
        });
        await client.start();

        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            artifactStore,
            modelProvidersPath,
            workflowCommands: {},
            ...workflowScriptsOptionFromEnv(),
        });
        await mgmt.start();

        try {
            const adapter = managementClientAdapter(mgmt, {
                createOwnerSession: async () => {
                    const session = await client.createSession({ owner: OWNER });
                    return { sessionId: session.sessionId };
                },
                publishPackage: (_pkgName, files) => mgmt.uploadAgentPackage(files, "shared", null, true),
                deletePackage: (pkgName) => mgmt.deleteAgentPackage(pkgName, null, true, { scope: "shared" }),
                listCreatableWorkflows: () => mgmt.listCreatableWorkflows(OWNER),
                createSessionForWorkflow: (ref) => mgmt.createSessionForWorkflow(ref, { client, owner: OWNER }),
            });

            const outcome = await runWorkflowSurfaceScenario(adapter, {
                prefix: "sdk",
                timeoutMs: testTime.ms(60_000),
            });
            expect(outcome.steps).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
        } finally {
            await mgmt.stop().catch(() => {});
            await client.stop().catch(() => {});
            await worker.stop().catch(() => {});
            await model.close().catch(() => {});
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });
});
