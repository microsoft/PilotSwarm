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
import { createTestEnv, testTime } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { managementClientAdapter, runWorkflowSurfaceScenario } from "../helpers/workflow-surface-scenario.mjs";
import { PilotSwarmClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";

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
    });

    afterAll(async () => {
        await client?.stop?.().catch(() => {});
        await mgmt?.stop?.().catch(() => {});
        if (server?.stopPortal) await server.stopPortal();
        await model?.close?.().catch(() => {});
        restoreEnv();
        if (artifactDir) fs.rmSync(artifactDir, { recursive: true, force: true });
        if (env) await env.cleanup();
    });

    it("runs S1–S6 happy paths over HTTP end to end", async () => {
        const adapter = managementClientAdapter(mgmt, {
            createOwnerSession: async () => {
                const session = await client.createSession();
                return { sessionId: session.sessionId };
            },
            publishPackage: (_pkgName, files) => mgmt.uploadAgentPackage(files, "shared"),
            deletePackage: (pkgName) => mgmt.deleteAgentPackage(pkgName, null, true, { scope: "shared" }),
            listCreatableWorkflows: () => mgmt.listCreatableWorkflows(),
            createSessionForWorkflow: (ref) => mgmt.createSessionForWorkflow(ref),
        });

        const outcome = await runWorkflowSurfaceScenario(adapter, {
            prefix: "web",
            timeoutMs: testTime.ms(60_000),
        });
        expect(outcome.steps).toEqual(["S1", "S2", "S3", "S4", "S4b", "S5", "S6"]);
    });
});
