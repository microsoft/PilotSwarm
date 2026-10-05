/**
 * Real parent-agent to workflow-child integration boundary.
 *
 * The synthetic markdown agent invokes the production spawn_workflow tool.
 * Until the workflow controller is implemented, the child orchestration is
 * expected to fail explicitly after the parent has created it successfully.
 *
 * Run: npx vitest run test/local/workflow-session-e2e.test.js
 */

import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../fixtures/workflow-session-e2e-plugin");

async function waitForWorkflowChild(catalog, parentSessionId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const sessions = await catalog.listSessions();
        const child = sessions.find(row =>
            row.parentSessionId === parentSessionId && row.sessionKind === "workflow");
        if (child) return child;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`No workflow child appeared for parent ${parentSessionId}`);
}

async function waitForFailedOrchestration(client, sessionId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus;
    while (Date.now() < deadline) {
        lastStatus = await client._getDuroxideClient().getStatus(`session-${sessionId}`);
        if (lastStatus.status === "Failed") return lastStatus;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(
        `Workflow orchestration session-${sessionId} did not fail within ${timeoutMs}ms; ` +
        `last status was ${lastStatus?.status ?? "unknown"}`,
    );
}

describe("Workflow Session: Agent E2E", () => {
    beforeAll(async () => { await preflightChecks(); }, TIMEOUT);

    it("a markdown agent starts a durable workflow child that reaches the explicit scaffold failure", {
        timeout: TIMEOUT * 2,
    }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);

        try {
            await withClient(env, {
                worker: { pluginDirs: [PLUGIN_DIR] },
            }, async client => {
                const parent = await client.createSession({ agentId: "workflow-runner" });
                const response = await parent.sendAndWait(
                    "Exercise workflow sessions now. Call spawn_workflow with this exact definition:\n" +
                    "kind: inline\n" +
                    "yaml: |\n" +
                    "  name: synthetic-e2e\n" +
                    "  version: 1\n" +
                    "  steps: []\n" +
                    "and these exact inputs: {\"request\":\"integration-test\"}.",
                    TIMEOUT,
                    undefined,
                    { requiredTool: "spawn_workflow" },
                );

                expect(response).toBeTruthy();

                const child = await waitForWorkflowChild(catalog, parent.sessionId);
                expect(child).toMatchObject({
                    parentSessionId: parent.sessionId,
                    sessionKind: "workflow",
                    orchestrationId: `session-${child.sessionId}`,
                });

                const creationConfig = await catalog.getSessionCreationConfig(child.sessionId);
                expect(creationConfig).toEqual({
                    workflow: {
                        definition: {
                            kind: "inline",
                            yaml: "name: synthetic-e2e\nversion: 1\nsteps: []\n",
                        },
                        inputs: { request: "integration-test" },
                    },
                });

                const failed = await waitForFailedOrchestration(client, child.sessionId);
                expect(String(failed.error ?? failed.output ?? "")).toMatch(
                    /WORKFLOW_CONTROLLER_NOT_IMPLEMENTED|Workflow session controller is not implemented/i,
                );
            });
        } finally {
            await catalog.close();
        }
    });
});
