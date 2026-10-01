import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgSessionCatalog, azureDevOpsPullRequestResourceKey } from "pilotswarm-sdk";
import { WorkflowGeneratorController } from "../dist/controller.js";

const databaseUrl = process.env.DATABASE_URL;
const catalogUrl = process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || databaseUrl;
const useManagedIdentity = ["1", "true", "yes", "on"].includes(
    (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
);
const aadUser = process.env.PILOTSWARM_DB_AAD_USER || process.env.PILOTSWARM_AAD_DB_USER;

async function createGenerator(catalog, {
    name,
    owner,
    workflowDefinition,
    validationGates,
}) {
    const published = await catalog.createWorkflowDefinition({
        workflowType: name,
        name,
        owner,
        workflowDefinition,
        validationGates,
    });
    return catalog.createWorkflowGenerator({
        name,
        owner,
        cadenceSeconds: 60,
        workflowDefinitionId: published.workflowDefinition.workflowDefinitionId,
        sourceType: "test-source",
        sourceConfig: { filter: "active" },
    });
}

test("controller materialization and durable WorkflowRun lifecycle transitions", {
    skip: !catalogUrl,
    timeout: 600_000,
}, async () => {
    const schema = `workflowRungen_controller_${randomUUID().replaceAll("-", "")}`;
    let lifecycleCommit = "lifecycle-commit-one";
    let diagnosedInstruction = "Diagnose the original source revision.";
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
        lifecycleStateReader: {
            async resolveSourceCommit() {
                return lifecycleCommit;
            },
            async readStateMarkdown(_source, sourcePath) {
                if (sourcePath === "Example.Diagnosed.md") {
                    return [
                        "# Diagnosed",
                        "",
                        diagnosedInstruction,
                        "",
                        "## Possible next states",
                        "- [Fixed](./Example.Fixed.md)",
                    ].join("\n");
                }
                if (sourcePath === "Example.Fixed.md") {
                    return "# Fixed\n\nDelivery is complete.\n";
                }
                return null;
            },
        },
    });
    try {
        await catalog.initialize();
        const registrations = await Promise.all([
            createGenerator(catalog, {
                name: "first-owner-generator",
                owner: { provider: "test", subject: "owner-a" },
            }),
            createGenerator(catalog, {
                name: "second-owner-generator",
                owner: { provider: "test", subject: "owner-b" },
            }),
        ]);
        const abort = new AbortController();
        let evaluationCount = 0;
        const controller = new WorkflowGeneratorController({
            store: catalog,
            evaluators: new Map([["test-source", {
                type: "test-source",
                async evaluate({ generator }) {
                    evaluationCount += 1;
                    if (evaluationCount === registrations.length) abort.abort();
                    return {
                        discoveries: [{
                            key: `record-${generator.owner.subject}`,
                            payload: { owner: generator.owner.subject },
                        }],
                        watermark: { completed: true },
                    };
                },
            }]]),
            workerId: "integration-controller",
            induceSessions: false,
        });

        await controller.run(abort.signal);
        assert.equal(evaluationCount, 2);
        for (const { generator } of registrations) {
            const workflowRuns = await catalog.listWorkflowGeneratorRuns(generator.workflowGeneratorId);
            assert.equal(workflowRuns.length, 1);
            assert.equal(workflowRuns[0].input.owner, generator.owner.subject);
            const cycles = await catalog.listWorkflowGeneratorCycles(generator.workflowGeneratorId);
            assert.equal(cycles.length, 1);
            assert.equal(cycles[0].status, "succeeded");
        }

        const lifecycleRegistration = await createGenerator(catalog, {
            name: "lifecycle-generator",
            owner: { provider: "test", subject: "lifecycle-owner" },
            workflowDefinition: {
                lifecycle: {
                    name: "Example",
                    initialState: "Diagnosed",
                    sources: [{
                        sourceId: "example-lifecycle",
                        owner: "user",
                        filePrefix: "Example",
                        requestedRef: "main",
                    }],
                },
            },
            validationGates: [{
                type: "external_operation",
                name: "Integration validation",
                beforeState: "Fixed",
                provider: "mock",
                kind: "validation",
            }],
        });
        const lifecycleWorker = "lifecycle-controller";
        const [claimed] = await catalog.claimDueWorkflowGenerators(lifecycleWorker, 1, 300);
        assert.equal(claimed.workflowGeneratorId, lifecycleRegistration.generator.workflowGeneratorId);
        const { cycle } = await catalog.beginWorkflowGeneratorCycle(
            lifecycleRegistration.generator.workflowGeneratorId,
            lifecycleWorker,
        );
        const [workflowRun, failingWorkflowRun] = await catalog.reconcileWorkflowGeneratorDiscoveries(cycle.cycleId, [
            {
                key: "record-42",
                payload: { id: 42 },
            },
            {
                key: "record-failure",
                payload: { id: "failure" },
            },
        ]);
        assert.equal(workflowRun.currentState, "Diagnosed");
        assert.equal(workflowRun.stateRevision, 1);
        const firstSnapshot = lifecycleRegistration.definition.workflowDefinition
            .lifecycle.stateMachineSnapshot;
        assert.equal(firstSnapshot.states.Diagnosed.sourceCommit, "lifecycle-commit-one");
        assert.match(firstSnapshot.states.Diagnosed.markdown, /original source revision/);
        assert.equal(
            workflowRun.effectiveConfig.workflowDefinition.lifecycle.stateMachineSnapshot.sha256,
            firstSnapshot.sha256,
        );

        lifecycleCommit = "lifecycle-commit-two";
        diagnosedInstruction = "Diagnose the updated source revision.";
        const nextDefinition = await catalog.createWorkflowDefinition({
            workflowType: "lifecycle-generator",
            name: "lifecycle-generator-v2",
            owner: { provider: "test", subject: "lifecycle-owner" },
            workflowDefinition: {
                lifecycle: {
                    name: "Example",
                    initialState: "Diagnosed",
                    sources: [{
                        sourceId: "example-lifecycle",
                        owner: "user",
                        filePrefix: "Example",
                        requestedRef: "main",
                    }],
                },
            },
            validationGates: [{
                type: "external_operation",
                name: "Integration validation",
                beforeState: "Fixed",
                provider: "mock",
                kind: "validation",
            }],
        });
        const nextSnapshot = nextDefinition.workflowDefinition.workflowDefinition
            .lifecycle.stateMachineSnapshot;
        assert.equal(nextDefinition.workflowDefinition.version, 2);
        assert.equal(nextSnapshot.states.Diagnosed.sourceCommit, "lifecycle-commit-two");
        assert.match(nextSnapshot.states.Diagnosed.markdown, /updated source revision/);
        assert.notEqual(nextSnapshot.sha256, firstSnapshot.sha256);
        assert.equal(
            workflowRun.effectiveConfig.workflowDefinition.lifecycle.stateMachineSnapshot.sha256,
            firstSnapshot.sha256,
        );

        const firstSession = await catalog.reserveWorkflowRunSession(
            workflowRun.workflowRunId,
            cycle.cycleId,
            lifecycleWorker,
            "lifecycle-session-1",
        );
        const candidateSnapshots = [
            {
                sourceCommit: "abc123",
                markdownSha256: "a".repeat(64),
            },
            {
                sourceCommit: "moved-branch-commit",
                markdownSha256: "c".repeat(64),
            },
        ];
        const preparationResults = await Promise.allSettled(
            candidateSnapshots.map((snapshot) => catalog.prepareWorkflowRunStateRun({
                sessionId: firstSession.sessionId,
                expectedState: "Diagnosed",
                expectedRevision: 1,
                stateOwner: "user",
                sourceId: "user-lifecycle",
                sourcePath: "Example.Diagnosed.md",
                ...snapshot,
                allowedOutcomes: [{ outcome: "Fixed", toState: "Fixed" }],
                terminal: false,
            })),
        );
        assert.equal(
            preparationResults.filter((result) => result.status === "fulfilled").length,
            1,
        );
        assert.equal(
            preparationResults.filter((result) => result.status === "rejected").length,
            1,
        );
        const durableRun = (await catalog.listWorkflowRunStateRuns(workflowRun.workflowRunId))[0];
        const durableSnapshot = {
            sourceCommit: durableRun.sourceCommit,
            markdownSha256: durableRun.markdownSha256,
        };
        assert.ok(candidateSnapshots.some((snapshot) => (
            snapshot.sourceCommit === durableSnapshot.sourceCommit
            && snapshot.markdownSha256 === durableSnapshot.markdownSha256
        )));
        const conflictingSnapshot = candidateSnapshots.find(
            (snapshot) => snapshot.sourceCommit !== durableSnapshot.sourceCommit,
        );
        assert.ok(conflictingSnapshot);
        // The git worker can start the durable turn before the controller's
        // post-send attach returns; acknowledgement must be race-safe.
        await catalog.acknowledgeWorkflowRunSession(firstSession.sessionId, "git-worker-1");
        await catalog.attachWorkflowRunSession(
            workflowRun.workflowRunId,
            firstSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
        );
        await catalog.setWorkflowRunSessionExecutionStatus(firstSession.sessionId, "waiting");
        assert.equal((await catalog.getWorkflowRun(workflowRun.workflowRunId)).lifecycleState, "blocked");
        await assert.rejects(
            catalog.completeWorkflowRunState({
                sessionId: firstSession.sessionId,
                outcome: "Fixed",
                summary: "A system-waiting state must not advance.",
            }),
            /not the active current run/,
        );
        await catalog.acknowledgeWorkflowRunSession(firstSession.sessionId, "git-worker-1");
        assert.equal((await catalog.getWorkflowRun(workflowRun.workflowRunId)).lifecycleState, "active");
        await catalog.setWorkflowRunSessionExecutionStatus(firstSession.sessionId, "input_required");
        assert.equal(
            await catalog.acceptWorkflowRunResponse({
                sessionId: firstSession.sessionId,
                answer: "Legacy answer",
            }),
            null,
        );
        await catalog.acknowledgeWorkflowRunSession(firstSession.sessionId, "git-worker-1");
        const supersededResponseWait = await catalog.startWorkflowRunResponseWait({
            sessionId: firstSession.sessionId,
            waitKey: `response:${firstSession.sessionId}:0`,
            question: "This prompt was superseded by a later turn.",
        });
        const responseWait = await catalog.startWorkflowRunResponseWait({
            sessionId: firstSession.sessionId,
            waitKey: `response:${firstSession.sessionId}:1`,
            question: "Publish the proposed fix?",
            choices: ["Approved", "Rejected"],
            allowFreeform: false,
        });
        assert.ok(responseWait);
        assert.equal(responseWait.kind, "response");
        assert.equal(responseWait.status, "pending");
        assert.equal(responseWait.expectedStateRevision, 1);
        assert.deepEqual(responseWait.responderPolicy, { kind: "session_writer" });
        assert.equal(
            (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
                (wait) => wait.waitId === supersededResponseWait.waitId,
            ).status,
            "cancelled",
        );
        assert.equal(
            (await catalog.startWorkflowRunResponseWait({
                sessionId: firstSession.sessionId,
                waitKey: `response:${firstSession.sessionId}:1`,
                question: "Publish the proposed fix?",
                choices: ["Approved", "Rejected"],
                allowFreeform: false,
            })).waitId,
            responseWait.waitId,
        );
        await catalog.setWorkflowRunSessionExecutionStatus(firstSession.sessionId, "input_required");
        assert.equal((await catalog.getWorkflowRun(workflowRun.workflowRunId)).lifecycleState, "blocked");
        await assert.rejects(
            catalog.acceptWorkflowRunResponse({
                sessionId: firstSession.sessionId,
                answer: "Maybe",
            }),
            /must be one of/,
        );
        const concurrentResponses = await Promise.allSettled([
            catalog.acceptWorkflowRunResponse({
                sessionId: firstSession.sessionId,
                answer: "Approved",
                respondedBy: {
                    kind: "user",
                    provider: "test-identity",
                    subject: "reviewer-1",
                    relation: "owner",
                },
            }),
            catalog.acceptWorkflowRunResponse({
                sessionId: firstSession.sessionId,
                answer: "Rejected",
                respondedBy: {
                    kind: "user",
                    provider: "test-identity",
                    subject: "reviewer-2",
                    relation: "collaborator",
                },
            }),
        ]);
        assert.equal(
            concurrentResponses.filter((result) => result.status === "fulfilled").length,
            1,
        );
        assert.equal(
            concurrentResponses.filter((result) => result.status === "rejected").length,
            1,
        );
        const acceptedResponse = concurrentResponses.find(
            (result) => result.status === "fulfilled",
        ).value;
        assert.equal(acceptedResponse.status, "satisfied");
        assert.ok(acceptedResponse.responseId);
        assert.ok(["Approved", "Rejected"].includes(acceptedResponse.response.answer));
        assert.equal(acceptedResponse.satisfactionEvidence.source, "direct_submission");
        await assert.rejects(
            catalog.acceptWorkflowRunResponse({
                sessionId: firstSession.sessionId,
                answer: "Approved",
            }),
            /already satisfied/,
        );
        await catalog.reopenWorkflowRunResponseWait(
            acceptedResponse.waitId,
            acceptedResponse.responseId,
        );
        assert.equal(
            (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
                (wait) => wait.waitId === responseWait.waitId,
            ).status,
            "pending",
        );
        const finalResponse = await catalog.acceptWorkflowRunResponse({
            sessionId: firstSession.sessionId,
            answer: "Approved",
            respondedBy: {
                kind: "user",
                provider: "test-identity",
                subject: "reviewer-1",
                relation: "owner",
            },
        });
        assert.equal(finalResponse.status, "satisfied");
        assert.equal(finalResponse.responseDeliveryStatus, "pending");
        await catalog.markWorkflowRunResponseEnqueued(finalResponse.waitId, finalResponse.responseId);
        const persistedWait = (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
            (wait) => wait.waitId === responseWait.waitId,
        );
        assert.equal(persistedWait.waitId, responseWait.waitId);
        assert.equal(persistedWait.response.answer, "Approved");
        assert.equal(persistedWait.satisfiedBy.subject, "reviewer-1");
        assert.equal(persistedWait.responseDeliveryStatus, "enqueued");
        assert.ok(persistedWait.responseEnqueuedAt);
        await catalog.acknowledgeWorkflowRunSession(firstSession.sessionId, "git-worker-1");
        assert.equal((await catalog.getWorkflowRun(workflowRun.workflowRunId)).lifecycleState, "active");
        const executionCompletedAt = new Date(Date.now() - 5_000).toISOString();
        await catalog.recordEvents(firstSession.sessionId, [
            {
                eventType: "session.turn_started",
                data: { turnIndex: 1 },
            },
            {
                eventType: "session.turn_execution_completed",
                data: {
                    turnIndex: 1,
                    resultType: "completed",
                    executionCompletedAt,
                },
            },
        ], "git-worker-1");
        await assert.rejects(
            catalog.completeWorkflowRunState({
                sessionId: firstSession.sessionId,
                outcome: "Rejected",
                summary: "This must not commit.",
            }),
            /not allowed/,
        );
        const operation = await catalog.startWorkflowRunExternalOperation({
            sessionId: firstSession.sessionId,
            provider: "mock",
            kind: "validation",
            operationKey: "integration",
            request: { result: { passed: true } },
            nextPollAt: new Date(Date.now() - 1_000),
        });
        const replayedOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: firstSession.sessionId,
            provider: "mock",
            kind: "validation",
            operationKey: "integration",
            request: { result: { passed: false }, delayMs: 30_000 },
        });
        assert.equal(replayedOperation.operationId, operation.operationId);
        assert.equal(
            (await catalog.getWorkflowRunExternalOperation(firstSession.sessionId, operation.operationId)).signalKey,
            operation.signalKey,
        );
        const pendingObservedWait = (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
            (wait) => wait.externalOperationId === operation.operationId,
        );
        assert.equal(pendingObservedWait.kind, "observed_condition");
        assert.equal(pendingObservedWait.status, "pending");
        assert.equal(pendingObservedWait.provider, "mock");
        assert.equal(pendingObservedWait.predicate.kind, "validation");
        await assert.rejects(
            catalog.completeWorkflowRunState({
                sessionId: firstSession.sessionId,
                outcome: "Fixed",
                summary: "The validation gate must reject pending work.",
            }),
            /requires completed external operation evidence/,
        );
        const [claimedOperation] = await catalog.claimDueWorkflowRunExternalOperations(
            "mock",
            "mock-producer-1",
        );
        assert.equal(claimedOperation.operationId, operation.operationId);
        await catalog.completeWorkflowRunExternalOperation({
            operationId: operation.operationId,
            workerId: "mock-producer-1",
            status: "succeeded",
            result: { passed: true },
            evidence: "validation-integration-1",
        });
        const satisfiedObservedWait = (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
            (wait) => wait.externalOperationId === operation.operationId,
        );
        assert.equal(satisfiedObservedWait.status, "satisfied");
        assert.deepEqual(satisfiedObservedWait.latestObservation, { passed: true });
        assert.deepEqual(satisfiedObservedWait.satisfactionEvidence, { value: "validation-integration-1" });
        const staleResponseWait = await catalog.startWorkflowRunResponseWait({
            sessionId: firstSession.sessionId,
            waitKey: `response:${firstSession.sessionId}:2`,
            question: "This wait must not survive session replacement.",
        });
        await catalog.setWorkflowRunSessionExecutionStatus(firstSession.sessionId, "input_required");
        const replacementSession = await catalog.replaceWorkflowRunSession(
            workflowRun.workflowRunId,
            "lifecycle-session-1-replacement",
        );
        assert.equal(
            (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
                (wait) => wait.waitId === staleResponseWait.waitId,
            ).status,
            "cancelled",
        );
        // Re-activation (A'): replacing the session clears the durable Markdown
        // snapshot so the state re-resolves its source branch ref. The prior pin
        // is dropped and the replacement can adopt a newly pushed commit without
        // the WorkflowRun (or its PR) being re-created.
        const clearedRun = (await catalog.listWorkflowRunStateRuns(workflowRun.workflowRunId))[0];
        assert.equal(clearedRun.sourceCommit, null);
        assert.equal(clearedRun.markdownSha256, null);
        assert.equal(clearedRun.terminal, null);
        assert.equal(clearedRun.attempt, durableRun.attempt + 1);
        // The replacement adopts the moved-branch snapshot that the first session
        // had rejected as conflicting; on a cleared run it is now accepted.
        await catalog.prepareWorkflowRunStateRun({
            sessionId: replacementSession.sessionId,
            expectedState: "Diagnosed",
            expectedRevision: 1,
            stateOwner: "user",
            sourceId: "user-lifecycle",
            sourcePath: "Example.Diagnosed.md",
            ...conflictingSnapshot,
            allowedOutcomes: [{ outcome: "Fixed", toState: "Fixed" }],
            terminal: false,
        });
        const reactivatedRun = (await catalog.listWorkflowRunStateRuns(workflowRun.workflowRunId))[0];
        assert.equal(reactivatedRun.sourceCommit, conflictingSnapshot.sourceCommit);
        assert.equal(reactivatedRun.markdownSha256, conflictingSnapshot.markdownSha256);
        await catalog.attachWorkflowRunSession(
            workflowRun.workflowRunId,
            replacementSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
        );
        await catalog.acknowledgeWorkflowRunSession(replacementSession.sessionId, "git-worker-2");
        const reboundOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: replacementSession.sessionId,
            provider: "mock",
            kind: "validation",
            operationKey: "integration",
            request: {},
        });
        assert.equal(reboundOperation.operationId, operation.operationId);
        assert.equal(reboundOperation.createdSessionId, firstSession.sessionId);
        assert.equal(reboundOperation.sessionId, replacementSession.sessionId);
        assert.equal(
            (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
                (wait) => wait.externalOperationId === operation.operationId,
            ).sessionId,
            replacementSession.sessionId,
        );
        assert.equal(
            await catalog.getWorkflowRunExternalOperation(firstSession.sessionId, operation.operationId),
            null,
        );
        assert.equal(
            (await catalog.getWorkflowRunExternalOperation(replacementSession.sessionId, operation.operationId)).operationId,
            operation.operationId,
        );

        await catalog.setWorkflowRunSessionExecutionStatus(replacementSession.sessionId, "waiting");
        assert.equal(
            await catalog.recordWorkflowRunExternalOperationWait(
                replacementSession.sessionId,
                operation.signalKey,
                "started",
            ),
            true,
        );
        await catalog.recordEvents(replacementSession.sessionId, [{
            eventType: "session.system_wait_started",
            data: { signalKey: operation.signalKey },
        }], "git-worker-2");
        const [claimedSignal] = await catalog.claimWorkflowRunExternalOperationSignals("mock-producer-1");
        assert.equal(claimedSignal.operationId, operation.operationId);
        assert.equal(claimedSignal.sessionId, replacementSession.sessionId);
        await catalog.markWorkflowRunExternalOperationSignalDelivered(
            operation.operationId,
            "mock-producer-1",
        );
        assert.equal(
            await catalog.recordWorkflowRunExternalOperationWait(
                replacementSession.sessionId,
                operation.signalKey,
                "completed",
            ),
            true,
        );
        await catalog.recordEvents(replacementSession.sessionId, [{
            eventType: "session.system_wait_completed",
            data: { signalKey: operation.signalKey },
        }], "git-worker-2");
        await catalog.acknowledgeWorkflowRunSession(replacementSession.sessionId, "git-worker-2");
        const completionCleanupWait = await catalog.startWorkflowRunResponseWait({
            sessionId: replacementSession.sessionId,
            waitKey: `response:${replacementSession.sessionId}:2`,
            question: "This wait must be cancelled by state completion.",
        });
        assert.notEqual(completionCleanupWait.waitKey, staleResponseWait.waitKey);
        const firstEntry = await catalog.completeWorkflowRunState({
            sessionId: replacementSession.sessionId,
            outcome: "Fixed",
            summary: "Diagnosed the issue and applied the fix.",
        });
        assert.equal(firstEntry.sequence, 1);
        assert.equal(firstEntry.fromState, "Diagnosed");
        assert.equal(firstEntry.toState, "Fixed");
        assert.equal((await catalog.getWorkflowRun(workflowRun.workflowRunId)).currentState, "Fixed");
        assert.equal(
            (await catalog.listWorkflowRunWaits(workflowRun.workflowRunId)).find(
                (wait) => wait.waitId === completionCleanupWait.waitId,
            ).status,
            "cancelled",
        );

        const secondSession = await catalog.reserveWorkflowRunSession(
            workflowRun.workflowRunId,
            cycle.cycleId,
            lifecycleWorker,
            "lifecycle-session-2",
        );
        const transitionedStateRun = (await catalog.listWorkflowRunStateRuns(
            workflowRun.workflowRunId,
        )).find((stateRun) => stateRun.stateRevision === 2);
        assert.equal(transitionedStateRun.sessionId, secondSession.sessionId);
        await catalog.prepareWorkflowRunStateRun({
            sessionId: secondSession.sessionId,
            expectedState: "Fixed",
            expectedRevision: 2,
            stateOwner: "platform",
            sourceId: "platform-lifecycle",
            sourcePath: "Standard.Fixed.md",
            sourceCommit: "def456",
            markdownSha256: "b".repeat(64),
            allowedOutcomes: [],
            terminal: true,
        });
        await catalog.attachWorkflowRunSession(
            workflowRun.workflowRunId,
            secondSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
        );
        await catalog.acknowledgeWorkflowRunSession(secondSession.sessionId, "git-worker-3");
        const sourceContext = await catalog.readWorkflowRunSourceSession(
            secondSession.sessionId,
            replacementSession.sessionId,
        );
        assert.equal(sourceContext.journalEntry.journalEntryId, firstEntry.journalEntryId);
        assert.equal(sourceContext.journalEntry.summary, "Diagnosed the issue and applied the fix.");
        assert.ok(sourceContext.events.some(
            (event) => event.eventType === "session.system_wait_completed",
        ));
        assert.equal(
            await catalog.readWorkflowRunSourceSession(secondSession.sessionId, "unrelated-session"),
            null,
        );
        await catalog.recordEvents(secondSession.sessionId, [{
            eventType: "session.turn_started",
            data: { iteration: 1 },
        }], "git-worker-3");
        await assert.rejects(
            catalog.completeWorkflowRunState({
                sessionId: secondSession.sessionId,
                outcome: "Done",
                summary: "This must not commit.",
            }),
            /must not specify an outcome/,
        );
        const terminalEntry = await catalog.completeWorkflowRunState({
            sessionId: secondSession.sessionId,
            summary: "Verified the fix and completed delivery.",
        });
        assert.equal(terminalEntry.sequence, 2);
        assert.equal(terminalEntry.fromState, "Fixed");
        assert.equal(terminalEntry.toState, "Fixed");
        const completedWorkflowRun = await catalog.getWorkflowRun(workflowRun.workflowRunId);
        assert.equal(completedWorkflowRun.lifecycleState, "completed");
        assert.equal(completedWorkflowRun.currentState, "Fixed");
        assert.equal(
            (await catalog.listWorkflowRunSessions(workflowRun.workflowRunId)).find((entry) => entry.sessionId === secondSession.sessionId).status,
            "completed",
        );
        assert.deepEqual(
            (await catalog.listWorkflowRunJournal(workflowRun.workflowRunId)).map((entry) => entry.summary),
            [
                "Diagnosed the issue and applied the fix.",
                "Verified the fix and completed delivery.",
            ],
        );

        const replay = await catalog.completeWorkflowRunState({
            sessionId: replacementSession.sessionId,
            outcome: "Fixed",
            summary: "A replay does not append another entry.",
        });
        assert.equal(replay.journalEntryId, firstEntry.journalEntryId);
        assert.equal((await catalog.listWorkflowRunJournal(workflowRun.workflowRunId)).length, 2);
        const workerTimeline = await catalog.getWorkerTimeline("git-worker-1");
        assert.ok(workerTimeline.some((entry) => entry.eventType === "session.turn_started"));
        assert.equal(
            workerTimeline.find((entry) => entry.eventType === "session.turn_execution_completed")?.at.toISOString(),
            executionCompletedAt,
        );
        assert.ok(workerTimeline.some((entry) => entry.eventType === "workflow_run.external_operation_started"));
        assert.ok(workerTimeline.some((entry) => entry.eventType === "workflow_run.external_operation_completed"));
        assert.ok(workerTimeline.some((entry) => entry.eventType === "workflow_run.external_operation_signal_delivered"));
        assert.equal(workerTimeline.some((entry) => (
            entry.eventType === "workflow_run.state_transition"
            && entry.details.toState === "Fixed"
        )), false);
        const replacementWorkerTimeline = await catalog.getWorkerTimeline("git-worker-2");
        assert.ok(replacementWorkerTimeline.some((entry) => (
            entry.eventType === "workflow_run.state_transition"
            && entry.details.toState === "Fixed"
        )));
        const resumedWorkerTimeline = await catalog.getWorkerTimeline("git-worker-3");
        const capacityWait = resumedWorkerTimeline.find((entry) => (
            entry.eventType === "workflow_run.worker_capacity_wait"
            && entry.sessionId === secondSession.sessionId
        ));
        assert.ok(capacityWait);
        assert.equal(capacityWait.kind, "worker_capacity_wait");
        assert.equal(
            new Date(capacityWait.details.workerAcquiredAt).getTime(),
            capacityWait.at.getTime(),
        );
        assert.ok(new Date(capacityWait.details.runnableAt).getTime() < capacityWait.at.getTime());
        assert.ok(resumedWorkerTimeline.some((entry) => (
            entry.eventType === "workflow_run.state_completed"
            && entry.details.fromState === "Fixed"
            && entry.details.terminal === true
        )));
        assert.deepEqual(
            workerTimeline.map((entry) => entry.at.getTime()),
            [...workerTimeline].map((entry) => entry.at.getTime()).sort((a, b) => a - b),
        );

        const failingSession = await catalog.reserveWorkflowRunSession(
            failingWorkflowRun.workflowRunId,
            cycle.cycleId,
            lifecycleWorker,
            "lifecycle-session-failure",
        );
        await catalog.prepareWorkflowRunStateRun({
            sessionId: failingSession.sessionId,
            expectedState: "Diagnosed",
            expectedRevision: 1,
            stateOwner: "user",
            sourceId: "user-lifecycle",
            sourcePath: "Example.Diagnosed.md",
            sourceCommit: "failure123",
            markdownSha256: "d".repeat(64),
            allowedOutcomes: [{ outcome: "Fixed", toState: "Fixed" }],
            terminal: false,
        });
        await catalog.attachWorkflowRunSession(
            failingWorkflowRun.workflowRunId,
            failingSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
        );
        await catalog.acknowledgeWorkflowRunSession(failingSession.sessionId, "git-worker-failure");
        const scheduledOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: failingSession.sessionId,
            provider: "mock",
            kind: "scheduler-validation",
            operationKey: "pending-then-satisfied",
            detectionMode: "hybrid",
            request: {},
            nextPollAt: new Date(Date.now() - 1_000),
        });
        const concurrentClaims = await Promise.all([
            catalog.claimDueWorkflowRunWaits("wait-scheduler-a", 1, 30),
            catalog.claimDueWorkflowRunWaits("wait-scheduler-b", 1, 30),
        ]);
        const [firstClaim] = concurrentClaims.flat();
        assert.ok(firstClaim);
        assert.equal(concurrentClaims.flat().length, 1);
        assert.equal(firstClaim.externalOperationId, scheduledOperation.operationId);
        const acceleratedAt = new Date(Date.now() - 1_000);
        assert.equal(
            await catalog.accelerateWorkflowRunWaitCheck(
                firstClaim.waitId,
                firstClaim.expectedStateRevision,
                acceleratedAt,
            ),
            true,
        );
        const nextCheckAt = new Date(Date.now() + 60_000);
        const pendingCheck = await catalog.completeWorkflowRunWaitCheck({
            waitId: firstClaim.waitId,
            workerId: firstClaim.checkLeaseOwner,
            disposition: "pending",
            observation: { state: "running" },
            providerCursor: { sequence: 1 },
            nextCheckAt,
        });
        assert.equal(pendingCheck.status, "pending");
        assert.equal(pendingCheck.checkAttempts, 1);
        assert.deepEqual(pendingCheck.latestObservation, { state: "running" });
        assert.deepEqual(pendingCheck.providerCursor, { sequence: 1 });
        assert.equal(pendingCheck.nextCheckAt.getTime(), acceleratedAt.getTime());
        const [acceleratedClaim] = await catalog.claimDueWorkflowRunWaits("wait-scheduler-c", 1, 30);
        assert.equal(acceleratedClaim.waitId, firstClaim.waitId);
        const satisfiedCheck = await catalog.completeWorkflowRunWaitCheck({
            waitId: acceleratedClaim.waitId,
            workerId: "wait-scheduler-c",
            disposition: "satisfied",
            observation: { state: "completed" },
            result: { passed: true },
            evidence: "scheduler-validation-1",
        });
        assert.equal(satisfiedCheck.status, "satisfied");
        assert.equal(satisfiedCheck.checkAttempts, 2);
        assert.deepEqual(satisfiedCheck.satisfactionEvidence, {
            value: "scheduler-validation-1",
        });
        assert.equal(
            (await catalog.getWorkflowRunExternalOperation(
                failingSession.sessionId,
                scheduledOperation.operationId,
            )).status,
            "succeeded",
        );

        const approvalIdentity = {
            organization: "contoso",
            project: "project",
            repositoryId: "repo-1",
            pullRequestId: 42,
        };
        const approvalResourceKey = azureDevOpsPullRequestResourceKey(approvalIdentity);
        const approvalOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: failingSession.sessionId,
            provider: "azure_devops",
            kind: "pull_request_approval",
            operationKey: "approval-selector",
            detectionMode: "hybrid",
            request: {
                ...approvalIdentity,
                expectedSourceCommit: "a".repeat(40),
                resourceKey: approvalResourceKey,
            },
            nextPollAt: new Date(Date.now() + 60_000),
        });
        const completionOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: failingSession.sessionId,
            provider: "azure_devops",
            kind: "pull_request_completion",
            operationKey: "completion-selector",
            detectionMode: "hybrid",
            request: {
                ...approvalIdentity,
                expectedSourceCommit: "a".repeat(40),
                resourceKey: approvalResourceKey,
            },
            nextPollAt: new Date(Date.now() - 1_000),
        });
        const providerEventAt = new Date(Date.now() - 500);
        assert.equal(
            await catalog.accelerateWorkflowRunWaitChecksByTarget(
                "azure_devops",
                "pull_request_approval",
                approvalResourceKey,
                providerEventAt,
            ),
            1,
        );
        const [approvalClaim] = await catalog.claimDueWorkflowRunWaits(
            "wait-scheduler-approval-selector",
            1,
            30,
            [{ provider: "azure_devops", kind: "pull_request_approval" }],
        );
        assert.equal(approvalClaim.externalOperationId, approvalOperation.operationId);
        await catalog.completeWorkflowRunWaitCheck({
            waitId: approvalClaim.waitId,
            workerId: "wait-scheduler-approval-selector",
            disposition: "pending",
            observation: { state: "waiting-for-approval" },
            nextCheckAt: new Date(Date.now() + 60_000),
        });
        assert.deepEqual(
            await catalog.claimDueWorkflowRunWaits(
                "wait-scheduler-approval-selector-empty",
                1,
                30,
                [{ provider: "azure_devops", kind: "pull_request_approval" }],
            ),
            [],
        );
        const [completionClaim] = await catalog.claimDueWorkflowRunWaits(
            "wait-scheduler-completion-selector",
            1,
            30,
            ["azure_devops"],
        );
        assert.equal(completionClaim.externalOperationId, completionOperation.operationId);
        await catalog.completeWorkflowRunWaitCheck({
            waitId: completionClaim.waitId,
            workerId: "wait-scheduler-completion-selector",
            disposition: "pending",
            observation: { state: "waiting-for-completion" },
            nextCheckAt: new Date(Date.now() + 60_000),
        });

        const deadlineOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: failingSession.sessionId,
            provider: "mock",
            kind: "scheduler-validation",
            operationKey: "deadline",
            request: {},
            deadlineAt: new Date(Date.now() - 1_000),
            nextPollAt: new Date(Date.now() - 2_000),
        });
        const [deadlineClaim] = await catalog.claimDueWorkflowRunWaits("wait-scheduler-deadline", 1, 30);
        assert.equal(deadlineClaim.externalOperationId, deadlineOperation.operationId);
        const timedOutCheck = await catalog.completeWorkflowRunWaitCheck({
            waitId: deadlineClaim.waitId,
            workerId: "wait-scheduler-deadline",
            disposition: "pending",
            observation: { state: "still-running" },
            nextCheckAt: new Date(Date.now() + 60_000),
        });
        assert.equal(timedOutCheck.status, "timed_out");
        assert.equal(timedOutCheck.lastCheckError, "WorkflowRun wait deadline elapsed");
        assert.equal(
            (await catalog.getWorkflowRunExternalOperation(
                failingSession.sessionId,
                deadlineOperation.operationId,
            )).status,
            "failed",
        );
        const terminalAfterDeadlineOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: failingSession.sessionId,
            provider: "mock",
            kind: "scheduler-validation",
            operationKey: "terminal-after-deadline",
            request: {},
            deadlineAt: new Date(Date.now() - 1_000),
            nextPollAt: new Date(Date.now() - 2_000),
        });
        const [terminalAfterDeadlineClaim] = await catalog.claimDueWorkflowRunWaits(
            "wait-scheduler-terminal-after-deadline",
            1,
            30,
        );
        const terminalAfterDeadline = await catalog.completeWorkflowRunWaitCheck({
            waitId: terminalAfterDeadlineClaim.waitId,
            workerId: "wait-scheduler-terminal-after-deadline",
            disposition: "satisfied",
            observation: { state: "completed" },
            result: { passed: true },
            evidence: { runId: "late-terminal-result" },
        });
        assert.equal(terminalAfterDeadline.status, "satisfied");
        assert.equal(
            (await catalog.getWorkflowRunExternalOperation(
                failingSession.sessionId,
                terminalAfterDeadlineOperation.operationId,
            )).status,
            "succeeded",
        );

        await catalog.setWorkflowRunSessionExecutionStatus(failingSession.sessionId, "waiting");
        const timerWait = await catalog.startWorkflowRunTimerWait({
            sessionId: failingSession.sessionId,
            waitKey: `timer:${failingSession.sessionId}:1`,
            reason: "Integration timer",
            dueAt: new Date(Date.now() + 30_000),
        });
        assert.equal(timerWait.kind, "timer");
        assert.equal(timerWait.status, "pending");
        const cancelledTimerWait = await catalog.cancelWorkflowRunTimerWait(failingSession.sessionId);
        assert.equal(cancelledTimerWait.waitId, timerWait.waitId);
        assert.equal(cancelledTimerWait.status, "cancelled");
        assert.ok(cancelledTimerWait.waitCompletedAt);
        const resumedTimerWait = await catalog.startWorkflowRunTimerWait({
            sessionId: failingSession.sessionId,
            waitKey: `timer:${failingSession.sessionId}:resume:1`,
            reason: "Resumed integration timer",
            dueAt: new Date(Date.now() + 30_000),
        });
        const completedTimerWait = await catalog.completeWorkflowRunTimerWait(failingSession.sessionId);
        assert.equal(completedTimerWait.waitId, resumedTimerWait.waitId);
        assert.equal(completedTimerWait.status, "satisfied");
        assert.ok(completedTimerWait.waitStartedAt);
        assert.ok(completedTimerWait.waitCompletedAt);
        assert.equal(await catalog.completeWorkflowRunTimerWait(failingSession.sessionId), null);
        await catalog.acknowledgeWorkflowRunSession(failingSession.sessionId, "git-worker-failure");

        const staleOperation = await catalog.startWorkflowRunExternalOperation({
            sessionId: failingSession.sessionId,
            provider: "mock",
            kind: "scheduler-validation",
            operationKey: "stale-completion",
            request: {},
            nextPollAt: new Date(Date.now() - 1_000),
        });
        const [leasedWait] = await catalog.claimDueWorkflowRunWaits("wait-scheduler-expired", 1, 30);
        assert.equal(leasedWait.externalOperationId, staleOperation.operationId);
        await catalog.pool.query(
            `UPDATE "${schema}".workflow_run_waits
             SET check_lease_expires_at = now() - interval '1 second'
             WHERE wait_id = $1`,
            [leasedWait.waitId],
        );
        const [reclaimedWait] = await catalog.claimDueWorkflowRunWaits("wait-scheduler-reclaimed", 1, 30);
        assert.equal(reclaimedWait.waitId, leasedWait.waitId);
        assert.equal(reclaimedWait.checkAttempts, 2);
        const failureCleanupWait = await catalog.startWorkflowRunResponseWait({
            sessionId: failingSession.sessionId,
            waitKey: `response:${failingSession.sessionId}:1`,
            question: "This wait must be cancelled when the state run fails.",
        });
        await catalog.setWorkflowRunSessionExecutionStatus(failingSession.sessionId, "input_required");
        await catalog.failWorkflowRunSession(
            failingWorkflowRun.workflowRunId,
            failingSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
            "Intentional integration failure",
        );
        await assert.rejects(
            catalog.completeWorkflowRunWaitCheck({
                waitId: reclaimedWait.waitId,
                workerId: "wait-scheduler-reclaimed",
                disposition: "satisfied",
                observation: { state: "late" },
            }),
            /no longer pending|stale/,
        );
        assert.equal(
            (await catalog.listWorkflowRunWaits(failingWorkflowRun.workflowRunId)).find(
                (wait) => wait.waitId === failureCleanupWait.waitId,
            ).status,
            "cancelled",
        );

        await catalog.completeWorkflowGeneratorCycle({
            cycleId: cycle.cycleId,
            workerId: lifecycleWorker,
            status: "succeeded",
            discoveredCount: 2,
            createdCount: 2,
        });
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});
