import { describe, expect, it } from "vitest";
import {
    WorkflowStateProviderRegistry,
} from "../../src/index.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import {
    createWorkflowManagementClient,
    registerControlWorkflow,
    waitForWorkflow,
} from "../helpers/workflow-test-harness.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

describe("Registered Workflow: Domain-neutral E2E", () => {
    it("registers and executes question, action, observation, and terminal states", {
        timeout: TIMEOUT,
    }, async () => {
        const env = getEnv();
        const writtenMarkers = new Set();
        let actionInvocationCount = 0;
        const providers = new WorkflowStateProviderRegistry()
            .registerAction("test-memory", request => {
                actionInvocationCount += 1;
                const marker = request.input?.marker;
                writtenMarkers.add(marker);
                return {
                    outcome: "succeeded",
                    output: { marker },
                };
            })
            .registerObservedCondition("test-memory", request => {
                const marker = request.operation?.marker;
                if (request.observationAttempt === 1) {
                    return { status: "pending", retryAfterMs: 100 };
                }
                return {
                    status: "completed",
                    outcome: "satisfied",
                    output: {
                        marker,
                        observed: writtenMarkers.has(marker),
                        observationAttempt: request.observationAttempt,
                    },
                };
            });

        await withClient(env, {
            worker: { workflowStateProviders: providers },
        }, async client => {
            const management = createWorkflowManagementClient(env);
            await management.start();
            try {
                const definition = await registerControlWorkflow(management);
                const marker = `marker-${env.runId}`;
                const started = await client.startWorkflow({
                    definitionId: definition.definitionId,
                    inputs: { marker },
                    idempotencyKey: `request-${env.runId}`,
                    visibility: "private",
                });

                const waiting = await waitForWorkflow(
                    management,
                    started.sessionId,
                    projection => projection.waitingOn === "question",
                );
                expect(waiting).toMatchObject({
                    status: "running",
                    currentStateId: "approve",
                    currentExecutionSequence: 1,
                });

                const answers = await Promise.allSettled([
                    management.answerWorkflowQuestion(
                        started.sessionId,
                        1,
                        "continue",
                        { approved: true },
                    ),
                    management.answerWorkflowQuestion(
                        started.sessionId,
                        1,
                        "continue",
                        { approved: true },
                    ),
                ]);
                expect(answers.some(answer => answer.status === "fulfilled")).toBe(true);
                for (const answer of answers) {
                    if (answer.status === "rejected") {
                        expect(answer.reason?.code).toBe("WORKFLOW_QUESTION_NOT_PENDING");
                    }
                }

                const completed = await waitForWorkflow(
                    management,
                    started.sessionId,
                    projection => projection.status === "succeeded",
                );
                expect(completed).toMatchObject({
                    currentStateId: "done",
                    terminalOutcome: "succeeded",
                    result: {
                        outcome: "succeeded",
                        result: {
                            marker,
                            observed: true,
                            observationAttempt: 2,
                        },
                    },
                });
                expect(await management.listWorkflowExecutions(started.sessionId))
                    .toMatchObject([
                        {
                            executionSequence: 1,
                            stateId: "approve",
                            status: "accepted",
                            outcome: "continue",
                        },
                        {
                            executionSequence: 2,
                            stateId: "write",
                            status: "accepted",
                            outcome: "succeeded",
                        },
                        {
                            executionSequence: 3,
                            stateId: "observe",
                            status: "accepted",
                            outcome: "satisfied",
                        },
                    ]);

                const stopped = await client.startWorkflow({
                    definitionId: definition.definitionId,
                    inputs: { marker: `stopped-${env.runId}` },
                    idempotencyKey: `stopped-request-${env.runId}`,
                    visibility: "private",
                });
                await waitForWorkflow(
                    management,
                    stopped.sessionId,
                    projection => projection.waitingOn === "question",
                );
                await management.answerWorkflowQuestion(
                    stopped.sessionId,
                    1,
                    "stop",
                    { approved: false },
                );

                expect(await waitForWorkflow(
                    management,
                    stopped.sessionId,
                    projection => projection.status === "cancelled",
                )).toMatchObject({
                    currentStateId: "stopped",
                    terminalOutcome: "cancelled",
                });
                expect(await management.listWorkflowExecutions(stopped.sessionId))
                    .toMatchObject([{
                        executionSequence: 1,
                        stateId: "approve",
                        status: "accepted",
                        outcome: "stop",
                    }]);
                expect(actionInvocationCount).toBe(1);
            } finally {
                await management.stop();
            }
        });
    });
});
