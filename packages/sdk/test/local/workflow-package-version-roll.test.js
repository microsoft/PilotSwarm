import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    FilesystemArtifactStore,
    PilotSwarmClient,
    PilotSwarmManagementClient,
    PilotSwarmWorker,
    publishAgentPackageDir,
} from "../../src/index.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { waitForWorkflow } from "../helpers/workflow-test-harness.js";

const TIMEOUT = 240_000;
const MODEL = "fixture-model";
const PACKAGE_NAME = "workflow-version-roll-kit";
const AGENT_NAME = "workflow-version-reporter";
const WORKFLOW_NAME = "workflow-package-version-roll";
const getEnv = useSuiteEnv(import.meta.url);

function write(root, relative, content) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function writeAgentPackage(root, version, marker, includeWorkflow) {
    const include = includeWorkflow
        ? ["version-roll.workflow.yaml", "transitions.mjs"]
        : [];
    write(root, "plugin.json", JSON.stringify({
        name: PACKAGE_NAME,
        version,
        description: "Workflow package version-roll fixture",
        agents: [`agents/${AGENT_NAME}.agent.md`],
        ...(include.length > 0 ? { include } : {}),
    }));
    write(root, `agents/${AGENT_NAME}.agent.md`, [
        "---",
        `name: ${AGENT_NAME}`,
        "description: Reports the exact workflow package version loaded by the worker.",
        "schemaVersion: 1",
        `version: ${version}`,
        "tools:",
        "  - submit_workflow_result",
        "---",
        "",
        `PACKAGE_VERSION_MARKER=${marker}`,
        "Submit the marker and requested phase through submit_workflow_result.",
    ].join("\n"));

    if (includeWorkflow) {
        write(root, "version-roll.workflow.yaml", `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: ${WORKFLOW_NAME}
  version: 0.1.0
inputs:
  runId:
    type: string
    required: true
identity:
  primaryKey:
    - inputs.runId
initial: first
states:
  first:
    type: agent
    agent: ${AGENT_NAME}
    input:
      phase: first
    result:
      schema: test/package-version/v1
    completion:
      mode: one-shot
      outcomes: [succeeded]
    transition:
      handler:
        module: ./transitions.mjs
        export: first
  gate:
    type: question
    prompt: Continue after package activation?
    context:
      runId: \${inputs.runId}
    authorization:
      mode: session-write
    completion:
      outcomes: [continue]
    transition:
      handler:
        module: ./transitions.mjs
        export: gate
  second:
    type: agent
    agent: ${AGENT_NAME}
    input:
      phase: second
    result:
      schema: test/package-version/v1
    completion:
      mode: one-shot
      outcomes: [succeeded]
    transition:
      handler:
        module: ./transitions.mjs
        export: second
  done:
    type: terminal
    outcome: succeeded
    output:
      first: \${states.first.result}
      second: \${states.second.result}
`);
        write(root, "transitions.mjs", `
export const first = {
    allowedTargets: ["gate"],
    handler: () => ({ kind: "advance", target: "gate" }),
};
export const gate = {
    allowedTargets: ["second"],
    handler: () => ({ kind: "advance", target: "second" }),
};
export const second = {
    allowedTargets: ["done"],
    handler: () => ({ kind: "advance", target: "done" }),
};
`);
    }
    return root;
}

function systemPrompt(body) {
    return body.messages
        .filter(message => message.role === "system")
        .map(message => typeof message.content === "string"
            ? message.content
            : message.content.map(part => part.text ?? "").join("\n"))
        .join("\n");
}

function latestUserPrompt(body) {
    const message = [...body.messages].reverse().find(entry => entry.role === "user");
    return typeof message?.content === "string"
        ? message.content
        : message?.content?.map(part => part.text ?? "").join("\n") ?? "";
}

function createWorker(env, {
    workerNodeId,
    sessionStateDir,
    cacheDir,
    modelProvidersPath,
}) {
    return new PilotSwarmWorker({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir,
        workerNodeId,
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        modelProvidersPath,
        turnTimeoutMs: 30_000,
        agentPackages: {
            cacheDir,
            refreshIntervalMs: 0,
        },
    });
}

describe("workflow package version roll", () => {
    it("keeps an admitted run on v1 across v2 activation and worker replacement", {
        timeout: TIMEOUT,
    }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const artifactStore = new FilesystemArtifactStore(
            path.join(env.baseDir, "artifacts"),
        );
        const modelProvidersPath = path.join(
            env.baseDir,
            "model-providers.version-roll.json",
        );
        const packageRootV1 = writeAgentPackage(
            path.join(env.baseDir, "version-roll-v1"),
            "1.0.0",
            "v1",
            true,
        );
        const packageRootV2 = writeAgentPackage(
            path.join(env.baseDir, "version-roll-v2"),
            "2.0.0",
            "v2",
            false,
        );
        const yaml = fs.readFileSync(
            path.join(packageRootV1, "version-roll.workflow.yaml"),
            "utf8",
        );
        const provider = await createNativeCopilotProvider(body => {
            if (body.messages.at(-1)?.role === "tool") {
                return { content: "Workflow result submitted." };
            }
            const prompt = systemPrompt(body);
            const version = prompt.includes("PACKAGE_VERSION_MARKER=v1")
                ? "v1"
                : prompt.includes("PACKAGE_VERSION_MARKER=v2")
                    ? "v2"
                    : null;
            if (!version) {
                throw new Error("The workflow agent prompt did not contain a package version marker.");
            }
            const task = latestUserPrompt(body);
            const phase = task.includes('"phase": "second"') ? "second" : "first";
            return {
                tools: [{
                    name: "submit_workflow_result",
                    args: {
                        outcome: "succeeded",
                        output: { version, phase },
                    },
                }],
            };
        });
        const management = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            artifactStore,
        });
        const client = new PilotSwarmClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            modelProvidersPath,
        });
        let workerA;
        let workerB;

        try {
            fs.writeFileSync(modelProvidersPath, JSON.stringify({
                providers: [{
                    id: "fixture-openai-type",
                    type: "openai",
                    baseUrl: provider.baseUrl,
                    models: [{ name: MODEL }],
                }],
            }));
            await catalog.providers.createProvider({
                name: "fixture-provider",
                typeId: "fixture-openai-type",
                class: "shared",
                secretRef: { apiKey: "fixture-key" },
            }, null, true);
            await catalog.providers.setClusterDefault({
                provider: "fixture-provider",
                model: `fixture-provider:${MODEL}`,
                reasoning: null,
                context: null,
            }, true);

            await management.start();
            const definition = await management.registerWorkflowDefinition(
                yaml,
                { packageRoot: packageRootV1 },
            );
            const v1Package = await catalog.getAgentPackage(
                PACKAGE_NAME,
                null,
                true,
                { scope: "shared" },
            );
            const v1VersionId = v1Package.activeVersionId;

            workerA = createWorker(env, {
                workerNodeId: `version-roll-a-${env.runId}`,
                sessionStateDir: path.join(env.baseDir, "worker-a-sessions"),
                cacheDir: path.join(env.baseDir, "worker-a-package-cache"),
                modelProvidersPath,
            });
            await workerA.start();
            await client.start();

            const existing = await client.startWorkflow({
                definitionId: definition.definitionId,
                inputs: { runId: `existing-${env.runId}` },
                idempotencyKey: `existing-${env.runId}`,
                visibility: "private",
            });
            await waitForWorkflow(
                management,
                existing.sessionId,
                projection =>
                    projection.currentStateId === "gate"
                    && projection.waitingOn === "question",
                60_000,
            );
            const [existingFirst] = await management.listWorkflowExecutions(
                existing.sessionId,
            );
            expect(existingFirst).toMatchObject({
                stateId: "first",
                outcome: "succeeded",
                output: { version: "v1", phase: "first" },
            });

            await publishAgentPackageDir({ catalog, artifactStore }, {
                dir: packageRootV2,
                scope: "shared",
                owner: null,
                createdBy: "workflow-version-roll@test",
                isAdmin: true,
            });
            const rolledPackage = await catalog.getAgentPackage(
                PACKAGE_NAME,
                null,
                true,
                { scope: "shared" },
            );
            expect(rolledPackage.activeVersionId).not.toBe(v1VersionId);
            const v2VersionId = rolledPackage.activeVersionId;

            await workerA.stop();
            workerA = undefined;
            workerB = createWorker(env, {
                workerNodeId: `version-roll-b-${env.runId}`,
                sessionStateDir: path.join(env.baseDir, "worker-b-sessions"),
                cacheDir: path.join(env.baseDir, "worker-b-empty-package-cache"),
                modelProvidersPath,
            });
            await workerB.start();

            await management.answerWorkflowQuestion(
                existing.sessionId,
                2,
                "continue",
                { approved: true },
            );
            const existingCompleted = await waitForWorkflow(
                management,
                existing.sessionId,
                projection => projection.status === "succeeded",
                60_000,
            );
            expect(existingCompleted.result).toMatchObject({
                outcome: "succeeded",
                result: {
                    first: { version: "v1", phase: "first" },
                    second: { version: "v1", phase: "second" },
                },
            });

            const existingExecutions = await management.listWorkflowExecutions(
                existing.sessionId,
            );
            const existingAgentExecutions = existingExecutions.filter(
                execution => execution.childSessionId,
            );
            expect(existingAgentExecutions).toHaveLength(2);
            for (const execution of existingAgentExecutions) {
                const config = await catalog.getSessionCreationConfig(
                    execution.childSessionId,
                );
                expect(config).toMatchObject({
                    boundAgentPackageId: v1Package.packageId,
                    boundAgentPackageVersionId: v1VersionId,
                });
            }

            const fresh = await client.startWorkflow({
                definitionId: definition.definitionId,
                inputs: { runId: `fresh-${env.runId}` },
                idempotencyKey: `fresh-${env.runId}`,
                visibility: "private",
            });
            await waitForWorkflow(
                management,
                fresh.sessionId,
                projection =>
                    projection.currentStateId === "gate"
                    && projection.waitingOn === "question",
                60_000,
            );
            const [freshFirst] = await management.listWorkflowExecutions(
                fresh.sessionId,
            );
            expect(freshFirst).toMatchObject({
                stateId: "first",
                outcome: "succeeded",
                output: { version: "v2", phase: "first" },
            });
            const freshConfig = await catalog.getSessionCreationConfig(
                freshFirst.childSessionId,
            );
            expect(freshConfig).toMatchObject({
                boundAgentPackageId: rolledPackage.packageId,
                boundAgentPackageVersionId: v2VersionId,
            });

            await management.answerWorkflowQuestion(
                fresh.sessionId,
                2,
                "continue",
                { approved: true },
            );
            const freshCompleted = await waitForWorkflow(
                management,
                fresh.sessionId,
                projection => projection.status === "succeeded",
                60_000,
            );
            expect(freshCompleted.result).toMatchObject({
                outcome: "succeeded",
                result: {
                    first: { version: "v2", phase: "first" },
                    second: { version: "v2", phase: "second" },
                },
            });
        } finally {
            try { await client.stop(); } catch {}
            try { await workerB?.stop(); } catch {}
            try { await workerA?.stop(); } catch {}
            try { await management.stop(); } catch {}
            await provider.close();
            await catalog.close();
        }
    });
});
