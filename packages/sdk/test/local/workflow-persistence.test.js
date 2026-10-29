import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `ps_test_workflow_${randomUUID().replaceAll("-", "")}`;

function atomicWorkflowRegistration({
    packageName = "atomic-workflow-package",
    packageId,
    versionId,
    semver,
    packageSha,
    definitionId,
    graphName,
    sourceSha,
}) {
    const workflowPackageSha = "f".repeat(64);
    const manifest = {
        compilerVersion: "v1alpha1-4",
        apiVersion: "pilotswarm.dev/v1alpha1",
        kind: "Workflow",
        graphId: `${graphName}@0.1.0`,
        packageSha256: workflowPackageSha,
        metadata: { name: graphName, version: "0.1.0" },
        inputSchema: {},
        configuration: {},
        initialState: "agent",
        states: [{
            id: "agent",
            type: "agent",
            agent: "atomic-agent",
            agentPackageId: packageId,
            input: {},
            result: { schema: "atomic/result/v1" },
            completion: { mode: "one-shot", outcomes: ["succeeded"] },
            transition: {
                handler: {
                    module: "./transition.mjs",
                    export: "advance",
                    moduleSha256: "e".repeat(64),
                    packageSha256: workflowPackageSha,
                },
            },
        }],
    };
    return {
        packageId,
        versionId,
        package: {
            name: packageName,
            scope: "shared",
            owner: null,
            sourceId: null,
            semver,
            sha256: packageSha,
            sizeBytes: 100,
            artifactFilename: `${packageName}.${semver}.${packageSha}.tar.gz`,
            commitSha: null,
            manifest: { name: packageName, version: semver },
            createdBy: "workflow-definition-registration",
            isAdmin: true,
        },
        definition: {
            definitionId,
            sourceYaml: `workflow-${sourceSha}`,
            sourceSha256: sourceSha,
            packageSha256: workflowPackageSha,
            packageArtifactFilename: `workflow-package.${workflowPackageSha}.tar.gz`,
            packageSource: { kind: "local-package" },
            compiledSha256: `${sourceSha}-compiled`,
            manifest,
        },
    };
}

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

    it("isolates user definitions and preserves creator ownership for shared definitions", async () => {
        const ownerA = { provider: "entra", subject: "owner-a" };
        const ownerB = { provider: "entra", subject: "owner-b" };
        const makeRegistration = ({
            definitionId,
            graphId,
            scope,
            owner,
            createdBy,
        }) => {
            const [name, version] = graphId.split("@");
            const packageSha256 = "b".repeat(64);
            return {
                definitionId,
                scope,
                owner,
                createdBy,
                isAdmin: false,
                sourceYaml: `workflow-${graphId}`,
                sourceSha256: `source-${graphId}`,
                packageSha256,
                packageArtifactFilename: `workflow-package.${packageSha256}.tar.gz`,
                packageSource: { kind: "local-package" },
                compiledSha256: `compiled-${graphId}`,
                manifest: {
                    compilerVersion: "v1alpha1-4",
                    apiVersion: "pilotswarm.dev/v1alpha1",
                    kind: "Workflow",
                    graphId,
                    packageSha256,
                    metadata: { name, version },
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
                },
            };
        };

        const userA = await catalog.registerWorkflowDefinition(makeRegistration({
            definitionId: "owned-user-a",
            graphId: "owned-workflow@1.0.0",
            scope: "user",
            owner: ownerA,
            createdBy: "owner-a@example.test",
        }));
        const userB = await catalog.registerWorkflowDefinition(makeRegistration({
            definitionId: "owned-user-b",
            graphId: "owned-workflow@1.0.0",
            scope: "user",
            owner: ownerB,
            createdBy: "owner-b@example.test",
        }));
        const shared = await catalog.registerWorkflowDefinition(makeRegistration({
            definitionId: "owned-shared",
            graphId: "shared-workflow@1.0.0",
            scope: "shared",
            owner: ownerA,
            createdBy: "owner-a@example.test",
        }));

        expect(userA).toMatchObject({
            scope: "user",
            owner: ownerA,
            createdBy: "owner-a@example.test",
        });
        expect(userB).toMatchObject({ scope: "user", owner: ownerB });
        expect(shared).toMatchObject({ scope: "shared", owner: ownerA });

        expect(
            await catalog.getWorkflowDefinitionForViewer(userA.definitionId, ownerA, false),
        ).not.toBeNull();
        expect(
            await catalog.getWorkflowDefinitionForViewer(userB.definitionId, ownerA, false),
        ).toBeNull();
        expect(
            await catalog.getWorkflowDefinitionForViewer(shared.definitionId, ownerB, false),
        ).not.toBeNull();

        const visibleToA = await catalog.listWorkflowDefinitions(ownerA, false);
        expect(visibleToA.map(definition => definition.definitionId)).toContain(userA.definitionId);
        expect(visibleToA.map(definition => definition.definitionId)).not.toContain(userB.definitionId);
        expect(visibleToA.map(definition => definition.definitionId)).toContain(shared.definitionId);

        await expect(catalog.registerWorkflowDefinition(makeRegistration({
            definitionId: "shared-owner-conflict",
            graphId: "shared-workflow@1.0.0",
            scope: "shared",
            owner: ownerB,
            createdBy: "owner-b@example.test",
        }))).rejects.toThrow(/WORKFLOW_DEFINITION_FORBIDDEN/);

        const adminRetry = await catalog.registerWorkflowDefinition({
            ...makeRegistration({
                definitionId: "shared-admin-retry",
                graphId: "shared-workflow@1.0.0",
                scope: "shared",
                owner: ownerB,
                createdBy: "admin@example.test",
            }),
            isAdmin: true,
        });
        expect(adminRetry.definitionId).toBe(shared.definitionId);
    });

    it("enforces workflow package ownership in the catalog transaction", async () => {
        const ownerA = { provider: "entra", subject: "package-owner-a" };
        const ownerB = { provider: "entra", subject: "package-owner-b" };
        const publish = (name, scope, owner, sha) =>
            catalog.publishAgentPackage({
                name,
                scope,
                owner,
                sourceId: null,
                semver: "1.0.0",
                sha256: sha,
                sizeBytes: 100,
                artifactFilename: `${name}.1.0.0.${sha}.tar.gz`,
                commitSha: null,
                manifest: {
                    name,
                    version: "1.0.0",
                    agents: [{ name: "atomic-agent" }],
                },
                createdBy: "workflow-package-test",
                isAdmin: false,
            });
        const sharedPackage = await publish(
            "workflow-shared-reference",
            "shared",
            ownerA,
            "1".repeat(64),
        );
        const userPackage = await publish(
            "workflow-user-reference",
            "user",
            ownerA,
            "2".repeat(64),
        );
        const definition = ({
            definitionId,
            graphName,
            packageId,
            scope,
            owner,
            sourceSha,
        }) => ({
            ...atomicWorkflowRegistration({
                packageName: "unused",
                packageId,
                versionId: "unused",
                semver: "1.0.0",
                packageSha: "3".repeat(64),
                definitionId,
                graphName,
                sourceSha,
            }).definition,
            scope,
            owner,
            createdBy: `${owner.subject}@example.test`,
            isAdmin: false,
        });

        await expect(catalog.registerWorkflowDefinition(definition({
            definitionId: "shared-uses-user-package",
            graphName: "shared-uses-user-package",
            packageId: userPackage.packageId,
            scope: "shared",
            owner: ownerA,
            sourceSha: "4".repeat(64),
        }))).rejects.toThrow(/WORKFLOW_AGENT_PACKAGE_SCOPE_INVALID/);

        await expect(catalog.registerWorkflowDefinition(definition({
            definitionId: "other-user-package",
            graphName: "other-user-package",
            packageId: userPackage.packageId,
            scope: "user",
            owner: ownerB,
            sourceSha: "5".repeat(64),
        }))).rejects.toThrow(/WORKFLOW_AGENT_PACKAGE_SCOPE_INVALID/);

        await expect(catalog.registerWorkflowDefinition(definition({
            definitionId: "owner-user-package",
            graphName: "owner-user-package",
            packageId: userPackage.packageId,
            scope: "user",
            owner: ownerA,
            sourceSha: "6".repeat(64),
        }))).resolves.toMatchObject({
            definitionId: "owner-user-package",
            scope: "user",
            owner: ownerA,
        });

        await expect(catalog.registerWorkflowDefinition(definition({
            definitionId: "user-shared-package",
            graphName: "user-shared-package",
            packageId: sharedPackage.packageId,
            scope: "user",
            owner: ownerB,
            sourceSha: "7".repeat(64),
        }))).resolves.toMatchObject({
            definitionId: "user-shared-package",
            scope: "user",
            owner: ownerB,
        });
    });

    it("cannot commit an external package reference after concurrent deletion", async () => {
        const owner = { provider: "entra", subject: "package-race-owner" };
        const published = await catalog.publishAgentPackage({
            name: "workflow-registration-race",
            scope: "shared",
            owner,
            sourceId: null,
            semver: "1.0.0",
            sha256: "8".repeat(64),
            sizeBytes: 100,
            artifactFilename: `workflow-registration-race.1.0.0.${"8".repeat(64)}.tar.gz`,
            commitSha: null,
            manifest: {
                name: "workflow-registration-race",
                version: "1.0.0",
                agents: [{ name: "atomic-agent" }],
            },
            createdBy: "workflow-package-test",
            isAdmin: false,
        });
        const registration = {
            ...atomicWorkflowRegistration({
                packageName: "unused",
                packageId: published.packageId,
                versionId: "unused",
                semver: "1.0.0",
                packageSha: "9".repeat(64),
                definitionId: "workflow-registration-race-definition",
                graphName: "workflow-registration-race",
                sourceSha: "9".repeat(64),
            }).definition,
            scope: "shared",
            owner,
            createdBy: "package-race-owner@example.test",
            isAdmin: false,
        };

        const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
        const client = await pool.connect();
        let transactionOpen = false;
        try {
            await client.query("BEGIN");
            transactionOpen = true;
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended('workflow-agent-package:' || $1, 0))",
                [published.packageId],
            );
            let settled = false;
            const registering = catalog.registerWorkflowDefinition(registration)
                .finally(() => {
                    settled = true;
                });
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(settled).toBe(false);

            await client.query(
                `DELETE FROM "${SCHEMA}".agent_packages WHERE package_id = $1`,
                [published.packageId],
            );
            await client.query("COMMIT");
            transactionOpen = false;

            await expect(registering).rejects.toThrow(
                /WORKFLOW_AGENT_PACKAGE_UNAVAILABLE/,
            );
        } finally {
            if (transactionOpen) {
                await client.query("ROLLBACK").catch(() => {});
            }
            client.release();
            await pool.end();
        }
    });

    it("reports committed workflow and agent package artifact references", async () => {
        const registration = atomicWorkflowRegistration({
            packageName: "artifact-reference-package",
            packageId: "artifact-reference-package-id",
            versionId: "artifact-reference-version-id",
            semver: "1.0.0",
            packageSha: "9".repeat(64),
            definitionId: "artifact-reference-definition",
            graphName: "artifact-reference-workflow",
            sourceSha: "9".repeat(64),
        });
        await catalog.registerWorkflowDefinitionWithAgentPackage(registration);

        const references = await catalog.listPackageArtifactReferences();
        expect(references.workflowArtifactFilenames).toContain(
            registration.definition.packageArtifactFilename,
        );
        expect(references.agentArtifactFilenames).toContain(
            registration.package.artifactFilename,
        );
        expect(
            await catalog.countWorkflowPackageArtifactRefs(
                registration.definition.packageArtifactFilename,
            ),
        ).toBeGreaterThan(0);
        expect(
            await catalog.countAgentPackageArtifactRefs(
                registration.package.artifactFilename,
            ),
        ).toBe(1);
        expect(
            await catalog.countWorkflowPackageArtifactRefs("missing-workflow-artifact"),
        ).toBe(0);
        expect(
            await catalog.countAgentPackageArtifactRefs("missing-agent-artifact"),
        ).toBe(0);
    });

    it("serializes package artifact publication and collection", async () => {
        const contender = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await contender.initialize();
        const target = {
            sessionId: "00000000-0000-0000-0000-000000000001",
            filename: "shared-content-addressed-package.tar.gz",
        };
        let releaseFirst;
        const firstRelease = new Promise(resolve => {
            releaseFirst = resolve;
        });
        let signalFirstEntered;
        const firstEntered = new Promise(resolve => {
            signalFirstEntered = resolve;
        });

        try {
            const first = catalog.withPackageArtifactLocks([target], async () => {
                signalFirstEntered();
                await firstRelease;
            });
            await firstEntered;

            let secondEntered = false;
            const second = contender.withPackageArtifactLocks([target], async () => {
                secondEntered = true;
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(secondEntered).toBe(false);

            releaseFirst();
            await Promise.all([first, second]);
            expect(secondEntered).toBe(true);
        } finally {
            releaseFirst?.();
            await contender.close();
        }
    });

    it("rolls back package activation and registry epoch when atomic definition registration conflicts", async () => {
        const packageName = "atomic-conflict-package";
        const packageId = "atomic-package-1";
        const first = atomicWorkflowRegistration({
            packageName,
            packageId,
            versionId: "atomic-version-1",
            semver: "1.0.0",
            packageSha: "1".repeat(64),
            definitionId: "atomic-definition-1",
            graphName: "atomic-registration",
            sourceSha: "a".repeat(64),
        });
        await catalog.registerWorkflowDefinitionWithAgentPackage(first);

        const epochAfterFirst = await catalog.agentRegistryEpoch();
        const packageAfterFirst = await catalog.getAgentPackage(
            packageName,
            null,
            true,
            { scope: "shared" },
        );
        expect(packageAfterFirst.activeVersionId).toBe("atomic-version-1");
        expect(packageAfterFirst.versions.map(version => version.semver)).toEqual(["1.0.0"]);

        const conflicting = atomicWorkflowRegistration({
            packageName,
            packageId,
            versionId: "atomic-version-2",
            semver: "2.0.0",
            packageSha: "2".repeat(64),
            definitionId: "atomic-definition-conflict",
            graphName: "atomic-registration",
            sourceSha: "b".repeat(64),
        });
        await expect(
            catalog.registerWorkflowDefinitionWithAgentPackage(conflicting),
        ).rejects.toThrow(/WORKFLOW_DEFINITION_CONFLICT/);

        const packageAfterConflict = await catalog.getAgentPackage(
            packageName,
            null,
            true,
            { scope: "shared" },
        );
        expect(await catalog.agentRegistryEpoch()).toBe(epochAfterFirst);
        expect(packageAfterConflict.activeVersionId).toBe("atomic-version-1");
        expect(packageAfterConflict.versions.map(version => version.semver)).toEqual(["1.0.0"]);
    });

    it("rolls back a concurrent logical-package identity mismatch for safe retry", async () => {
        const packageName = "atomic-retry-package";
        await catalog.registerWorkflowDefinitionWithAgentPackage(
            atomicWorkflowRegistration({
                packageName,
                packageId: "atomic-retry-winner",
                versionId: "atomic-retry-version-1",
                semver: "1.0.0",
                packageSha: "4".repeat(64),
                definitionId: "atomic-retry-definition-1",
                graphName: "atomic-retry-initial",
                sourceSha: "d".repeat(64),
            }),
        );
        const existing = await catalog.getAgentPackage(
            packageName,
            null,
            true,
            { scope: "shared" },
        );
        const mismatched = atomicWorkflowRegistration({
            packageName,
            packageId: "stale-package-candidate",
            versionId: "atomic-version-retry",
            semver: "1.1.0",
            packageSha: "3".repeat(64),
            definitionId: "atomic-definition-retry",
            graphName: "atomic-registration-retry",
            sourceSha: "c".repeat(64),
        });

        await expect(
            catalog.registerWorkflowDefinitionWithAgentPackage(mismatched),
        ).rejects.toThrow(/WORKFLOW_AGENT_PACKAGE_RETRY/);

        const afterRetry = await catalog.getAgentPackage(
            packageName,
            null,
            true,
            { scope: "shared" },
        );
        expect(afterRetry.packageId).toBe(existing.packageId);
        expect(afterRetry.versions.map(version => version.semver)).not.toContain("1.1.0");
    });

    it("converges concurrent first registrations on one logical package and one epoch bump", async () => {
        const packageName = "atomic-concurrent-package";
        const beforeEpoch = await catalog.agentRegistryEpoch();
        const registrations = [
            atomicWorkflowRegistration({
                packageName,
                packageId: "atomic-concurrent-package-a",
                versionId: "atomic-concurrent-version-a",
                semver: "1.0.0",
                packageSha: "5".repeat(64),
                definitionId: "atomic-concurrent-definition-a",
                graphName: "atomic-concurrent-a",
                sourceSha: "5".repeat(64),
            }),
            atomicWorkflowRegistration({
                packageName,
                packageId: "atomic-concurrent-package-b",
                versionId: "atomic-concurrent-version-b",
                semver: "1.0.0",
                packageSha: "5".repeat(64),
                definitionId: "atomic-concurrent-definition-b",
                graphName: "atomic-concurrent-b",
                sourceSha: "6".repeat(64),
            }),
        ];

        const results = await Promise.allSettled(
            registrations.map(input =>
                catalog.registerWorkflowDefinitionWithAgentPackage(input)
            ),
        );
        const winnerIndex = results.findIndex(result => result.status === "fulfilled");
        const loserIndex = results.findIndex(result => result.status === "rejected");
        expect(winnerIndex).toBeGreaterThanOrEqual(0);
        expect(loserIndex).toBeGreaterThanOrEqual(0);
        expect(results[loserIndex].reason.message).toMatch(/WORKFLOW_AGENT_PACKAGE_RETRY/);

        const published = await catalog.getAgentPackage(
            packageName,
            null,
            true,
            { scope: "shared" },
        );
        expect(published.versions).toHaveLength(1);
        expect(await catalog.agentRegistryEpoch()).toBe(beforeEpoch + 1);

        const retry = structuredClone(registrations[loserIndex]);
        retry.packageId = published.packageId;
        retry.definition.manifest.states[0].agentPackageId = published.packageId;
        await catalog.registerWorkflowDefinitionWithAgentPackage(retry);

        expect(await catalog.agentRegistryEpoch()).toBe(beforeEpoch + 1);
        expect(
            await catalog.getWorkflowDefinition(retry.definition.definitionId),
        ).toMatchObject({
            graphId: retry.definition.manifest.graphId,
        });
    });

    it("blocks package deletion until every admitted workflow is terminal", async () => {
        const packageName = "active-workflow-package";
        const registration = atomicWorkflowRegistration({
            packageName,
            packageId: "active-workflow-package-id",
            versionId: "active-workflow-version-id",
            semver: "1.0.0",
            packageSha: "7".repeat(64),
            definitionId: "active-workflow-definition",
            graphName: "active-workflow-deletion",
            sourceSha: "7".repeat(64),
        });
        await catalog.registerWorkflowDefinitionWithAgentPackage(registration);

        const sessionId = "active-workflow-session";
        await catalog.admitWorkflow({
            sessionId,
            definitionId: registration.definition.definitionId,
            inputs: {},
            primaryKeyValues: null,
            primaryKeySha256: null,
            owner: {
                provider: "test",
                subject: "active-workflow-owner",
            },
            idempotencyKey: "active-workflow-request",
            requestSha256: "8".repeat(64),
            forceRerun: false,
            isAdmin: false,
        });

        await expect(
            catalog.deleteAgentPackage(
                packageName,
                null,
                true,
                { scope: "shared" },
            ),
        ).rejects.toThrow(/AGENT_PACKAGE_WORKFLOW_IN_USE/);

        await catalog.createSession(sessionId, { sessionKind: "workflow" });
        await expect(
            catalog.deleteAgentPackage(
                packageName,
                null,
                true,
                { scope: "shared" },
            ),
        ).rejects.toThrow(/AGENT_PACKAGE_WORKFLOW_IN_USE/);

        await catalog.updateSession(sessionId, { state: "completed" });
        await expect(
            catalog.deleteAgentPackage(
                packageName,
                null,
                true,
                { scope: "shared" },
            ),
        ).resolves.toEqual([registration.package.artifactFilename]);
        await expect(
            catalog.getAgentPackage(
                packageName,
                null,
                true,
                { scope: "shared" },
            ),
        ).resolves.toBeNull();
    });

    it("serializes first admission against package deletion", async () => {
        const packageName = "concurrent-deletion-package";
        const registration = atomicWorkflowRegistration({
            packageName,
            packageId: "concurrent-deletion-package-id",
            versionId: "concurrent-deletion-version-id",
            semver: "1.0.0",
            packageSha: "9".repeat(64),
            definitionId: "concurrent-deletion-definition",
            graphName: "concurrent-deletion",
            sourceSha: "9".repeat(64),
        });
        await catalog.registerWorkflowDefinitionWithAgentPackage(registration);

        const results = await Promise.allSettled([
            catalog.admitWorkflow({
                sessionId: "concurrent-deletion-session",
                definitionId: registration.definition.definitionId,
                inputs: {},
                primaryKeyValues: null,
                primaryKeySha256: null,
                owner: {
                    provider: "test",
                    subject: "concurrent-deletion-owner",
                },
                idempotencyKey: "concurrent-deletion-request",
                requestSha256: "a".repeat(64),
                forceRerun: false,
                isAdmin: false,
            }),
            catalog.deleteAgentPackage(
                packageName,
                null,
                true,
                { scope: "shared" },
            ),
        ]);

        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
        expect(results.find(result => result.status === "rejected").reason.message)
            .toMatch(/AGENT_PACKAGE_WORKFLOW_IN_USE|WORKFLOW_AGENT_PACKAGE_UNAVAILABLE/);
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
