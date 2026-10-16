import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import {
    createWorkflowClient,
    createWorkflowManagementClient,
    createWorkflowResourceTracker,
    forkWorkflowWorker,
    registerControlWorkflow,
    waitForCondition,
    waitForWorkflow,
    workflowEffectPath,
} from "../helpers/workflow-test-harness.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const resources = createWorkflowResourceTracker();

afterEach(async () => resources.stopAll());

describe("Registered Workflow: Action Recovery", () => {
    it("keeps action side effects idempotent when a failed activity is retried", {
        timeout: TIMEOUT * 2,
    }, async () => {
        const env = getEnv();
        const marker = `action-retry-${env.runId}`;
        const effectDir = path.join(env.baseDir, "workflow-action-effects");
        const workerA = resources.add(
            forkWorkflowWorker(env, "workflow-action-a", {
                effectDir,
                exitAfterActionEffect: true,
            }),
        );
        await workerA.ready;
        const client = await resources.start(createWorkflowClient(env));
        const management = await resources.start(
            createWorkflowManagementClient(env),
        );
        const definition = await registerControlWorkflow(management);
        const started = await client.startWorkflow({
            definitionId: definition.definitionId,
            inputs: { marker },
            idempotencyKey: `request-${marker}`,
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
            () => existsSync(workflowEffectPath(effectDir, marker)),
            "the first action side effect",
        );
        const firstExit = await workerA.exited;
        expect(firstExit.code).toBe(137);
        resources.remove(workerA);
        const workerB = resources.add(
            forkWorkflowWorker(env, "workflow-action-b", { effectDir }),
        );
        await workerB.ready;

        expect(await waitForWorkflow(
            management,
            started.sessionId,
            projection => projection.status === "succeeded",
            120_000,
        )).toMatchObject({
            currentStateId: "done",
            terminalOutcome: "succeeded",
        });
        const attempts = readFileSync(
            path.join(effectDir, "attempts.jsonl"),
            "utf8",
        ).trim().split(/\r?\n/).map(line => JSON.parse(line));
        expect(attempts).toHaveLength(2);
        expect(attempts.map(attempt => attempt.applied)).toEqual([true, false]);
        expect(new Set(attempts.map(attempt => [
            attempt.workflowSessionId,
            attempt.stateId,
            attempt.executionSequence,
        ].join("/"))).size).toBe(1);
    });
});
