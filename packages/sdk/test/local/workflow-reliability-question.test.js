import { afterEach, describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import {
    createSuccessfulWorkflowProviders,
    createWorkflowClient,
    createWorkflowManagementClient,
    createWorkflowResourceTracker,
    createWorkflowWorker,
    registerControlWorkflow,
    waitForWorkflow,
} from "../helpers/workflow-test-harness.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const resources = createWorkflowResourceTracker();

afterEach(async () => resources.stopAll());

describe("Registered Workflow: Question Recovery", () => {
    it("resumes a durable question after the worker is replaced", {
        timeout: TIMEOUT,
    }, async () => {
        const env = getEnv();
        const providers = createSuccessfulWorkflowProviders();
        const worker = await resources.start(
            createWorkflowWorker(env, providers, "workflow-question-a"),
        );
        const client = await resources.start(createWorkflowClient(env));
        const management = await resources.start(
            createWorkflowManagementClient(env),
        );
        const definition = await registerControlWorkflow(management);
        const started = await client.startWorkflow({
            definitionId: definition.definitionId,
            inputs: { marker: `question-restart-${env.runId}` },
            idempotencyKey: `question-restart-${env.runId}`,
            visibility: "private",
        });

        await waitForWorkflow(
            management,
            started.sessionId,
            projection => projection.waitingOn === "question",
        );
        await worker.stop();
        resources.remove(worker);
        await resources.start(
            createWorkflowWorker(env, providers, "workflow-question-b"),
        );

        await management.answerWorkflowQuestion(
            started.sessionId,
            1,
            "continue",
            { approved: true },
        );
        expect(await waitForWorkflow(
            management,
            started.sessionId,
            projection => projection.status === "succeeded",
        )).toMatchObject({
            currentStateId: "done",
            terminalOutcome: "succeeded",
        });
    });
});
