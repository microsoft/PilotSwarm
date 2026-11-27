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
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { runWorkflowSurfaceScenario } from "../helpers/workflow-surface-scenario.mjs";
import {
    PilotSwarmClient,
    PilotSwarmManagementClient,
    PilotSwarmWorker,
    FilesystemArtifactStore,
    workflowScriptsOptionFromEnv,
} from "../../src/index.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "wf-surface-sdk" };

describe("Workflow surface scenario: SDK direct (PilotSwarmManagementClient)", () => {
    it("runs S1–S6 happy paths end to end", { timeout: TIMEOUT }, async () => {
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
            const adapter = {
                getWorkflowCapabilities: () => mgmt.getWorkflowCapabilities(),
                listWorkflowSkills: () => mgmt.readWorkflowSkills(),
                readWorkflowSkill: (name) => mgmt.readWorkflowSkills({ name }),
                createOwnerSession: async () => {
                    const session = await client.createSession({ owner: OWNER });
                    return { sessionId: session.sessionId };
                },
                validateDefinition: (yaml) => mgmt.validateWorkflowDefinition(yaml),
                saveDefinition: ({ ownerSessionId, name, yaml, definitionId, expectedRevision, operationId }) =>
                    mgmt.saveSessionWorkflowDefinition(ownerSessionId, {
                        name,
                        yaml,
                        ...(definitionId ? { definitionId } : {}),
                        ...(expectedRevision != null ? { expectedRevision } : {}),
                        operationId,
                    }),
                listDefinitions: (ownerSessionId) => mgmt.listSessionWorkflowDefinitions(ownerSessionId),
                readDefinition: ({ ownerSessionId, definitionId, name, revision }) =>
                    mgmt.readSessionWorkflowDefinition(ownerSessionId, { definitionId, name, revision }),
                startDefinition: ({ ownerSessionId, definitionId, name, revision, inputs, vars, workspace, operationId }) =>
                    mgmt.startSessionWorkflowDefinition(ownerSessionId, {
                        definitionId,
                        name,
                        ...(revision != null ? { revision } : {}),
                        ...(inputs !== undefined ? { inputs } : {}),
                        ...(vars !== undefined ? { vars } : {}),
                        workspace,
                        operationId,
                    }),
                readWorkflow: (workflowId, options) => mgmt.readWorkflow(workflowId, options),
                updateWorkflow: (workflowId, command) => mgmt.updateWorkflow(workflowId, command),
                deleteDefinition: ({ ownerSessionId, definitionId, name, operationId }) =>
                    mgmt.deleteSessionWorkflowDefinition(ownerSessionId, { definitionId, name, operationId }),
                publishPackage: (pkgName, files) => mgmt.uploadAgentPackage(files, "shared", null, true),
                deletePackage: (pkgName) => mgmt.deleteAgentPackage(pkgName, { scope: "shared" }, null, true),
                listCreatableWorkflows: () => mgmt.listCreatableWorkflows(OWNER),
                readPackageCard: ({ ownerSessionId, name }) => mgmt.readSessionWorkflowCard(ownerSessionId, { name }),
                createSessionForWorkflow: (ref) => mgmt.createSessionForWorkflow(ref, { client, owner: OWNER }),
                copyDefinition: ({ ownerSessionId, name, definitionId, operationId }) =>
                    mgmt.copySessionWorkflowDefinition(ownerSessionId, { name, definitionId, operationId }),
                deleteSession: (sessionId) => mgmt.deleteSession(sessionId),
            };

            const outcome = await runWorkflowSurfaceScenario(adapter, { prefix: "sdk" });
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
