import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `ps_test_workflow_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!DATABASE_URL)("workflow execution persistence", () => {
    let catalog;

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize();
        await catalog.createSession("workflow-1", { sessionKind: "workflow" });
    });

    afterAll(async () => {
        await catalog?.close();
        const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
        try {
            await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        } finally {
            await pool.end();
        }
    });

    it("records, accepts, completes, and rebuilds without using lifecycle events as authority", async () => {
        const admission = {
            workflowSessionId: "workflow-1",
            executionSequence: 1,
            graphId: "graph-1",
            stateId: "inspect",
            childSessionId: "child-1",
            waitingOn: "agent-result",
        };
        await catalog.recordWorkflowExecution(admission);
        await catalog.recordWorkflowExecution(admission);

        let projection = await catalog.getWorkflowProjection("workflow-1");
        expect(projection).toMatchObject({
            status: "running",
            currentStateId: "inspect",
            currentExecutionSequence: 1,
            waitingOn: "agent-result",
        });
        expect(await catalog.listWorkflowExecutions("workflow-1")).toHaveLength(1);

        await expect(catalog.recordWorkflowExecution({
            ...admission,
            stateId: "different",
        })).rejects.toThrow(/WORKFLOW_EXECUTION_CONFLICT/);

        const accepted = {
            workflowSessionId: "workflow-1",
            executionSequence: 1,
            graphId: "graph-1",
            stateId: "inspect",
            childSessionId: "child-1",
            outcome: "succeeded",
            output: { commit: "abc123" },
        };
        await catalog.acceptWorkflowExecution(accepted);
        await catalog.acceptWorkflowExecution(accepted);

        const [execution] = await catalog.listWorkflowExecutions("workflow-1");
        expect(execution).toMatchObject({
            status: "accepted",
            outcome: "succeeded",
            output: { commit: "abc123" },
        });
        projection = await catalog.getWorkflowProjection("workflow-1");
        expect(projection.waitingOn).toBeNull();
        expect(await catalog.getChildOutcome("child-1")).toMatchObject({
            parentSessionId: "workflow-1",
            verdict: "succeeded",
        });

        await expect(catalog.acceptWorkflowExecution({
            ...accepted,
            output: { commit: "different" },
        })).rejects.toThrow(/WORKFLOW_RESULT_CONFLICT/);

        const completion = {
            workflowSessionId: "workflow-1",
            graphId: "graph-1",
            terminalStateId: "done",
            outcome: "succeeded",
            summary: "Done.",
            result: { outcome: "succeeded", result: { commit: "abc123" } },
            completedAt: new Date("2026-10-07T20:01:00.000Z"),
        };
        await catalog.completeWorkflowProjection(completion);
        await catalog.completeWorkflowProjection(completion);

        projection = await catalog.getWorkflowProjection("workflow-1");
        expect(projection).toMatchObject({
            status: "succeeded",
            currentStateId: "done",
            terminalOutcome: "succeeded",
            result: completion.result,
        });

        const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
        try {
            await pool.query(
                `DELETE FROM "${SCHEMA}".workflow_projections WHERE workflow_session_id = $1`,
                ["workflow-1"],
            );
        } finally {
            await pool.end();
        }
        expect(await catalog.getWorkflowProjection("workflow-1")).toBeNull();
        await catalog.rebuildWorkflowProjection("workflow-1");
        expect(await catalog.getWorkflowProjection("workflow-1")).toMatchObject({
            status: "succeeded",
            currentStateId: "done",
            terminalOutcome: "succeeded",
        });

        const events = await catalog.getSessionEvents("workflow-1", undefined, 100);
        expect(events.map(event => event.eventType)).toEqual([
            "workflow.execution_admitted",
            "workflow.execution_accepted",
            "workflow.completed",
        ]);
    });

    it("registers immutable authored definitions with normalized compiled manifests", async () => {
        const manifest = {
            compilerVersion: "v1alpha1-3",
            apiVersion: "pilotswarm.dev/v1alpha1",
            kind: "Workflow",
            graphId: "registered-example@0.1.0",
            packageSha256: "a".repeat(64),
            metadata: { name: "registered-example", version: "0.1.0" },
            inputSchema: {},
            configuration: {},
            initialState: "done",
            states: [{
                id: "done",
                type: "terminal",
                outcome: "succeeded",
                summary: "Done.",
                hasOutput: false,
            }],
        };
        const registration = {
            definitionId: "definition-1",
            sourceYaml: "workflow-yaml",
            sourceSha256: "source-hash",
            packageSha256: "a".repeat(64),
            packageArtifactFilename: `workflow-package.${"a".repeat(64)}.tar.gz`,
            packageSource: { kind: "local-package" },
            compiledSha256: "compiled-hash",
            manifest,
        };

        const first = await catalog.registerWorkflowDefinition(registration);
        const duplicate = await catalog.registerWorkflowDefinition({
            ...registration,
            definitionId: "definition-retry",
        });

        expect(first.definitionId).toBe("definition-1");
        expect(duplicate.definitionId).toBe("definition-1");
        expect(first).toMatchObject({
            graphId: "registered-example@0.1.0",
            sourceYaml: "workflow-yaml",
            sourceSha256: "source-hash",
            packageSha256: "a".repeat(64),
            packageArtifactFilename: `workflow-package.${"a".repeat(64)}.tar.gz`,
            packageSource: { kind: "local-package" },
            compiledSha256: "compiled-hash",
            initialStateId: "done",
            compiledManifest: manifest,
        });

        await expect(catalog.registerWorkflowDefinition({
            ...registration,
            definitionId: "definition-conflict",
            sourceSha256: "different-source",
        })).rejects.toThrow(/WORKFLOW_DEFINITION_CONFLICT/);
    });

    it("atomically deduplicates keyed starts and admits authorized reruns", async () => {
        const manifest = {
            compilerVersion: "v1alpha1-3",
            apiVersion: "pilotswarm.dev/v1alpha1",
            kind: "Workflow",
            graphId: "admission-example@0.1.0",
            packageSha256: "b".repeat(64),
            metadata: { name: "admission-example", version: "0.1.0" },
            inputSchema: {
                entityId: { type: "string", required: true },
            },
            identity: {
                primaryKey: ["inputs.entityId"],
            },
            configuration: {},
            initialState: "done",
            states: [{
                id: "done",
                type: "terminal",
                outcome: "succeeded",
                summary: "Done.",
                hasOutput: false,
            }],
        };
        await catalog.registerWorkflowDefinition({
            definitionId: "definition-admission",
            sourceYaml: "admission-workflow-yaml",
            sourceSha256: "admission-source-hash",
            packageSha256: "b".repeat(64),
            packageArtifactFilename: `workflow-package.${"b".repeat(64)}.tar.gz`,
            packageSource: { kind: "local-package" },
            compiledSha256: "admission-compiled-hash",
            manifest,
        });

        const owner = {
            provider: "entra",
            subject: "owner-1",
            email: "owner@example.test",
            displayName: "Owner One",
        };
        const base = {
            definitionId: "definition-admission",
            inputs: { entityId: "entity-1" },
            primaryKeyValues: ["entity-1"],
            primaryKeySha256: "c".repeat(64),
            owner,
            groupId: "owner-group",
            visibility: "private",
            forceRerun: false,
            isAdmin: false,
        };
        const first = await catalog.admitWorkflow({
            ...base,
            sessionId: "workflow-admission-1",
            idempotencyKey: "request-1",
            requestSha256: "d".repeat(64),
        });
        expect(first).toMatchObject({
            sessionId: "workflow-admission-1",
            attempt: 1,
            created: true,
            deduplicated: false,
            needsStart: true,
            owner,
            groupId: "owner-group",
        });

        const retry = await catalog.admitWorkflow({
            ...base,
            sessionId: "workflow-admission-ignored",
            idempotencyKey: "request-1",
            requestSha256: "d".repeat(64),
        });
        expect(retry).toMatchObject({
            sessionId: "workflow-admission-1",
            attempt: 1,
            created: false,
            deduplicated: true,
            needsStart: true,
        });

        await catalog.markWorkflowAdmissionStarted(
            first.sessionId,
            first.orchestrationId,
        );
        const duplicate = await catalog.admitWorkflow({
            ...base,
            sessionId: "workflow-admission-ignored-2",
            idempotencyKey: "request-2",
            requestSha256: "e".repeat(64),
        });
        expect(duplicate).toMatchObject({
            sessionId: "workflow-admission-1",
            attempt: 1,
            created: false,
            deduplicated: true,
            needsStart: false,
        });

        await expect(catalog.admitWorkflow({
            ...base,
            sessionId: "workflow-admission-other-owner",
            owner: {
                provider: "entra",
                subject: "owner-2",
                email: "other@example.test",
                displayName: "Owner Two",
            },
            idempotencyKey: "request-other-owner",
            requestSha256: "f".repeat(64),
        })).rejects.toMatchObject({
            code: "WORKFLOW_DUPLICATE_CONFLICT",
        });

        const rerun = await catalog.admitWorkflow({
            ...base,
            sessionId: "workflow-admission-2",
            idempotencyKey: "request-rerun",
            requestSha256: "1".repeat(64),
            forceRerun: true,
            rerunReason: "Repair completed.",
        });
        expect(rerun).toMatchObject({
            sessionId: "workflow-admission-2",
            attempt: 2,
            created: true,
            deduplicated: false,
            needsStart: true,
            rerunReason: "Repair completed.",
            owner,
        });

        const adminRerun = await catalog.admitWorkflow({
            ...base,
            sessionId: "workflow-admission-3",
            owner: {
                provider: "entra",
                subject: "admin-1",
                email: "admin@example.test",
                displayName: "Admin One",
            },
            idempotencyKey: "request-admin-rerun",
            requestSha256: "2".repeat(64),
            forceRerun: true,
            rerunReason: "Administrator-authorized retry.",
            isAdmin: true,
        });
        expect(adminRerun).toMatchObject({
            sessionId: "workflow-admission-3",
            attempt: 3,
            created: true,
            deduplicated: false,
            needsStart: true,
            rerunReason: "Administrator-authorized retry.",
            owner,
            groupId: "owner-group",
        });
    });
});
