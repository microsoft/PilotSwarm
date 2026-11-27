/**
 * Happy-path Workflow surface scenario: Web API (`WebPilotSwarmManagementClient`).
 *
 * Boots the real local portal server (`pilotswarm/web` Express/Hono + embedded
 * worker) against an isolated PostgreSQL schema and drives S1–S6 exclusively
 * over HTTP through `WebPilotSwarmManagementClient` and `PilotSwarmClient({ apiUrl })`.
 *
 * Run: npm exec --workspace=pilotswarm-sdk -- vitest run test/local/workflow-surface-webapi.test.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { runWorkflowSurfaceScenario } from "../helpers/workflow-surface-scenario.mjs";
import { PilotSwarmClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";

const TIMEOUT = 120_000;

let env;
let model;
let artifactDir;
let server;
let apiUrl;
let mgmt;
let client;
const savedEnv = {};

function setEnv(entries) {
    for (const [key, value] of Object.entries(entries)) {
        if (!(key in savedEnv)) savedEnv[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

describe("Workflow surface scenario: Web API (WebPilotSwarmManagementClient)", () => {
    beforeAll(async () => {
        env = createTestEnv("wf-surface-webapi");
        artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wf-surface-webapi-artifacts-"));
        model = await startScriptedModel({ respond: () => ({ content: "Ready." }) });
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);

        setEnv({
            DATABASE_URL: env.store,
            PILOTSWARM_DUROXIDE_SCHEMA: env.duroxideSchema,
            PILOTSWARM_CMS_SCHEMA: env.cmsSchema,
            PILOTSWARM_FACTS_SCHEMA: env.factsSchema,
            SESSION_STATE_DIR: env.sessionStateDir,
            ARTIFACT_DIR: artifactDir,
            PS_MODEL_PROVIDERS_PATH: modelProvidersPath,
            WORKERS: "1",
            PORTAL_TUI_MODE: "local",
        });

        const { startServer } = await import("pilotswarm/web");
        server = await startServer({ port: 0 });
        apiUrl = `http://localhost:${server.address().port}`;

        mgmt = new WebPilotSwarmManagementClient({ apiUrl });
        await mgmt.start();
        client = new PilotSwarmClient({ apiUrl });
        await client.start();
    }, TIMEOUT);

    afterAll(async () => {
        await client?.stop?.().catch(() => {});
        await mgmt?.stop?.().catch(() => {});
        if (server?.stopPortal) await server.stopPortal();
        await model?.close?.().catch(() => {});
        restoreEnv();
        if (artifactDir) fs.rmSync(artifactDir, { recursive: true, force: true });
        if (env) await env.cleanup();
    }, TIMEOUT);

    it("runs S1–S6 happy paths over HTTP end to end", { timeout: TIMEOUT }, async () => {
        const adapter = {
            getWorkflowCapabilities: () => mgmt.getWorkflowCapabilities(),
            listWorkflowSkills: () => mgmt.readWorkflowSkills(),
            readWorkflowSkill: (name) => mgmt.readWorkflowSkills({ name }),
            createOwnerSession: async () => {
                const session = await client.createSession();
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
            publishPackage: (_pkgName, files) => mgmt.uploadAgentPackage(files, "shared"),
            deletePackage: (pkgName) => mgmt.deleteAgentPackage(pkgName, null, true, { scope: "shared" }),
            listCreatableWorkflows: () => mgmt.listCreatableWorkflows(),
            readPackageCard: ({ ownerSessionId, name }) => mgmt.readSessionWorkflowCard(ownerSessionId, { name }),
            createSessionForWorkflow: (ref) => mgmt.createSessionForWorkflow(ref),
            copyDefinition: ({ ownerSessionId, name, definitionId, operationId }) =>
                mgmt.copySessionWorkflowDefinition(ownerSessionId, { name, definitionId, operationId }),
            deleteSession: (sessionId) => mgmt.deleteSession(sessionId),
        };

        const outcome = await runWorkflowSurfaceScenario(adapter, { prefix: "web" });
        expect(outcome.steps).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    });
});
