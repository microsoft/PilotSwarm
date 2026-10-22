import { afterEach, describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import {
    createSuccessfulWorkflowProviders,
    createWorkflowClient,
    createWorkflowManagementClient,
    createWorkflowResourceTracker,
    createWorkflowWorker,
    registerControlWorkflow,
    waitForCondition,
    waitForWorkflow,
} from "../helpers/workflow-test-harness.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const resources = createWorkflowResourceTracker();

afterEach(async () => resources.stopAll());

describe("Registered Workflow: Observation Recovery", () => {
    it("resumes observation polling after the worker is replaced", {
        timeout: TIMEOUT,
    }, async () => {
        const env = getEnv();
        let actionInvocations = 0;
        let observationInvocations = 0;
        const providers = createSuccessfulWorkflowProviders({
            onAction: () => {
                actionInvocations += 1;
            },
            onObservation: () => {
                observationInvocations += 1;
            },
            retryAfterMs: 2_000,
        });
        const worker = await resources.start(
            createWorkflowWorker(env, providers, "workflow-observation-a"),
        );
        const client = await resources.start(createWorkflowClient(env));
        const management = await resources.start(
            createWorkflowManagementClient(env),
        );
        const definition = await registerControlWorkflow(management);
        const started = await client.startWorkflow({
            definitionId: definition.definitionId,
            inputs: { marker: `observation-restart-${env.runId}` },
            idempotencyKey: `observation-restart-${env.runId}`,
            visibility: "private",
        });
        await waitForWorkflow(
            management,
            started.sessionId,
            projection => projection.waitingOn === "question",
        );
        await management.answerWorkflowQuestion(
            started.sessionId,
            1,
            "continue",
            { approved: true },
        );
        await waitForCondition(
            () => observationInvocations >= 1,
            "the first observation attempt",
        );

        await worker.stop();
        resources.remove(worker);
        await resources.start(
            createWorkflowWorker(env, providers, "workflow-observation-b"),
        );

        expect(await waitForWorkflow(
            management,
            started.sessionId,
            projection => projection.status === "succeeded",
        )).toMatchObject({
            currentStateId: "done",
            terminalOutcome: "succeeded",
        });
        expect(actionInvocations).toBe(1);
        expect(observationInvocations).toBeGreaterThanOrEqual(2);
    });
});
