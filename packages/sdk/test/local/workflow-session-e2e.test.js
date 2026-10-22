/**
 * Real parent-agent to workflow-child integration boundary.
 *
 * The synthetic markdown agent invokes the production spawn_workflow tool with
 * an immutable registered definition and the child runs to completion.
 *
 * Run: npx vitest run test/local/workflow-session-e2e.test.js
 */

import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import {
    createWorkflowManagementClient,
    waitForWorkflow,
    WORKFLOW_PACKAGE_ROOT,
} from "../helpers/workflow-test-harness.js";

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

describe("Workflow Session: Agent E2E", () => {
    beforeAll(async () => { await preflightChecks(); }, TIMEOUT);

    it("a markdown agent starts a registered durable workflow child", {
        timeout: TIMEOUT * 2,
    }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const management = createWorkflowManagementClient(env);

        try {
            await management.start();
            const definition = await management.registerWorkflowDefinition(`
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: agent-spawn-e2e
  version: 1.0.0
inputs:
  request:
    type: string
    required: true
initial: done
states:
  done:
    type: terminal
    outcome: succeeded
    output: \${inputs.request}
`, { packageRoot: WORKFLOW_PACKAGE_ROOT });

            await withClient(env, {
                worker: { pluginDirs: [PLUGIN_DIR] },
            }, async client => {
                const parent = await client.createSession({ agentId: "workflow-runner" });
                const response = await parent.sendAndWait(
                    "Exercise workflow sessions now. Call spawn_workflow with this exact definition:\n" +
                    "kind: registered\n" +
                    `definition_id: ${definition.definitionId}\n` +
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
                            kind: "registered",
                            definitionId: definition.definitionId,
                        },
                        inputs: { request: "integration-test" },
                    },
                });

                expect(await waitForWorkflow(
                    management,
                    child.sessionId,
                    projection => projection.status === "succeeded",
                )).toMatchObject({
                    workflowSessionId: child.sessionId,
                    status: "succeeded",
                    result: {
                        outcome: "succeeded",
                        result: "integration-test",
                    },
                });
            });
        } finally {
            await management.stop();
            await catalog.close();
        }
    });
});
