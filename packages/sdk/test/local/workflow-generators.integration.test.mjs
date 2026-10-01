import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgSessionCatalog } from "../../dist/index.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const catalogUrl = process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || databaseUrl;
const useManagedIdentity = ["1", "true", "yes", "on"].includes(
    (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
);
const aadUser = process.env.PILOTSWARM_DB_AAD_USER || process.env.PILOTSWARM_AAD_DB_USER;

async function initializeWorkflowSubsystem(catalog, schema) {
    await catalog.pool.query(`
        CREATE SCHEMA "${schema}";
        CREATE TABLE "${schema}".sessions (session_id TEXT PRIMARY KEY);
        CREATE TABLE "${schema}".schema_migrations (
            version TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    const migrations = CMS_MIGRATIONS(schema);
    for (const version of ["0095", "0096", "0097", "0098", "0099", "0100"]) {
        const migration = migrations.find((entry) => entry.version === version);
        assert.ok(migration);
        const client = await catalog.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(migration.sql);
            await client.query(
                `INSERT INTO "${schema}".schema_migrations (version, name) VALUES ($1, $2)`,
                [migration.version, migration.name],
            );
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }
}

async function createGenerator(catalog, {
    name,
    owner,
    sourceConfig,
    workflowDefinition,
    validationGates,
    sessionComputeAffinity,
}) {
    const published = await catalog.createWorkflowDefinition({
        workflowType: name,
        name,
        owner,
        sessionComputeAffinity,
        workflowDefinition,
        validationGates,
    });
    return catalog.createWorkflowGenerator({
        name,
        owner,
        cadenceSeconds: 60,
        workflowDefinitionId: published.workflowDefinition.workflowDefinitionId,
        sourceType: "test-source",
        sourceConfig,
    });
}

test("Postgres WorkflowGenerator reconciliation is exactly-once and retains session history", {
    skip: !catalogUrl,
    timeout: 120_000,
}, async () => {
    const schema = `workflowRungen_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    try {
        await catalog.initialize();
        const created = await createGenerator(catalog, {
            name: "integration",
            owner: { provider: "test", subject: "owner" },
            sourceConfig: { filter: "sample-records" },
        });
        const { generator, definition } = created;
        assert.equal(definition.version, 1);
        assert.equal(generator.activeDefinitionId, definition.workflowDefinitionId);
        assert.equal((await catalog.listWorkflowGenerators({ provider: "test", subject: "owner" })).length, 1);
        assert.equal((await catalog.listWorkflowGenerators({ provider: "test", subject: "other" })).length, 0);

        const claimed = await catalog.claimDueWorkflowGenerators("worker-1", 1, 60, "cluster");
        assert.equal(claimed.length, 1);
        const { cycle } = await catalog.beginWorkflowGeneratorCycle(generator.workflowGeneratorId, "worker-1");
        const first = await catalog.reconcileWorkflowGeneratorDiscoveries(cycle.cycleId, [
            { key: "source-record-42", payload: { id: 42 } },
        ]);
        const retry = await catalog.reconcileWorkflowGeneratorDiscoveries(cycle.cycleId, [
            { key: "source-record-42", payload: { id: 42, revision: 2 } },
        ]);
        assert.equal(first[0].created, true);
        assert.equal(first[0].workflowDefinitionId, definition.workflowDefinitionId);
        assert.equal(retry[0].created, false);
        assert.equal(retry[0].workflowRunId, first[0].workflowRunId);
        assert.equal(retry[0].input.revision, 2);

        const reserved = await catalog.reserveWorkflowRunSession(first[0].workflowRunId, cycle.cycleId, "worker-1", "session-1");
        const repeatedReservation = await catalog.reserveWorkflowRunSession(
            first[0].workflowRunId,
            cycle.cycleId,
            "worker-1",
            "session-other",
        );
        assert.equal(repeatedReservation.sessionId, reserved.sessionId);
        const stateRuns = await catalog.listWorkflowRunStateRuns(first[0].workflowRunId);
        assert.equal(stateRuns.length, 1);
        assert.equal(stateRuns[0].stateName, "Initial");
        assert.equal(stateRuns[0].stateRevision, 1);
        assert.equal(stateRuns[0].sessionId, reserved.sessionId);
        await catalog.attachWorkflowRunSession(first[0].workflowRunId, reserved.sessionId, cycle.cycleId, "worker-1");
        assert.equal((await catalog.listWorkflowRunSessions(first[0].workflowRunId))[0].status, "unacked");
        await catalog.acknowledgeWorkflowRunSession(reserved.sessionId);
        assert.equal((await catalog.listWorkflowRunSessions(first[0].workflowRunId))[0].status, "active");
        await catalog.replaceWorkflowRunSession(first[0].workflowRunId, "session-2");
        const history = await catalog.listWorkflowRunSessions(first[0].workflowRunId);
        assert.deepEqual(history.map((entry) => entry.sessionId), ["session-1", "session-2"]);
        assert.equal(history.filter((entry) => entry.isCurrent).length, 1);
        assert.equal(history[0].status, "replaced");

        await catalog.completeWorkflowGeneratorCycle({
            cycleId: cycle.cycleId,
            workerId: "worker-1",
            status: "succeeded",
            watermark: "next",
            discoveredCount: 1,
            createdCount: 1,
        });
        const aggregate = (await catalog.listWorkflowGenerators())[0];
        assert.equal(aggregate.materializedWorkflowRuns, 1);
        assert.equal(aggregate.watermark, "next");
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});

test("Postgres WorkflowGenerator claims honor controller placement and persist session placement", {
    skip: !catalogUrl,
    timeout: 120_000,
}, async () => {
    const schema = `workflowRuncompute_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    const create = async (name, controllerComputeAffinity, sessionComputeAffinity) => {
        const published = await catalog.createWorkflowDefinition({
            workflowType: name,
            name,
            owner: { provider: "test", subject: "owner" },
            sessionComputeAffinity,
        });
        return catalog.createWorkflowGenerator({
            name,
            owner: { provider: "test", subject: "owner" },
            controllerComputeAffinity,
            cadenceSeconds: 60,
            workflowDefinitionId: published.workflowDefinition.workflowDefinitionId,
            sourceType: "test-source",
            sourceConfig: { name },
        });
    };
    try {
        await catalog.initialize();

        const devbox = await create("devbox-pinned", "devbox", "cluster");
        assert.equal(devbox.generator.controllerComputeAffinity, "devbox");
        assert.equal(devbox.definition.sessionComputeAffinity, "cluster");
        assert.equal(
            (await catalog.claimDueWorkflowGenerators("cluster-controller", 10, 60, "cluster")).length,
            0,
        );
        assert.deepEqual(
            (await catalog.claimDueWorkflowGenerators("devbox-controller", 10, 60, "devbox"))
                .map((row) => row.workflowGeneratorId),
            [devbox.generator.workflowGeneratorId],
        );

        const cluster = await create("cluster-pinned", "cluster", "devbox");
        assert.equal(
            (await catalog.claimDueWorkflowGenerators("devbox-controller-2", 10, 60, "devbox")).length,
            0,
        );
        assert.deepEqual(
            (await catalog.claimDueWorkflowGenerators("cluster-controller-2", 10, 60, "cluster"))
                .map((row) => row.workflowGeneratorId),
            [cluster.generator.workflowGeneratorId],
        );

        const unpinned = await create("unpinned", null, null);
        assert.deepEqual(
            (await catalog.claimDueWorkflowGenerators("devbox-controller-3", 10, 60, "devbox"))
                .map((row) => row.workflowGeneratorId),
            [unpinned.generator.workflowGeneratorId],
        );

        const published = await catalog.createWorkflowDefinition({
            workflowType: "unpinned",
            name: "unpinned-v2",
            owner: { provider: "test", subject: "owner" },
            sessionComputeAffinity: "devbox",
        });
        assert.equal(published.workflowDefinition.sessionComputeAffinity, "devbox");
        assert.equal(
            (await catalog.getWorkflowDefinition(published.workflowDefinition.workflowDefinitionId))
                .sessionComputeAffinity,
            "devbox",
        );
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});

test("Postgres WorkflowRun induction preserves private execution affinity for direct and generated Runs", {
    skip: !catalogUrl,
    timeout: 120_000,
}, async () => {
    const schema = `workflowRunAffinity_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    try {
        await initializeWorkflowSubsystem(catalog, schema);
        const generatorOwner = {
            provider: "entra",
            subject: "generator-owner",
            email: "generator-owner@example.test",
            displayName: "Generator Owner",
        };
        const { generator } = await createGenerator(catalog, {
            name: "generated-affinity",
            owner: generatorOwner,
            sourceConfig: {},
            sessionComputeAffinity: "devbox",
        });
        await catalog.claimDueWorkflowGenerators("generator-controller", 1, 60, "cluster");
        const { cycle } = await catalog.beginWorkflowGeneratorCycle(
            generator.workflowGeneratorId,
            "generator-controller",
        );
        const [generatedRun] = await catalog.reconcileWorkflowGeneratorDiscoveries(cycle.cycleId, [
            { key: "generated-key", payload: { source: "generator" } },
        ]);

        const requester = {
            provider: "entra",
            subject: "direct-requester",
            email: "direct-requester@example.test",
            displayName: "Direct Requester",
        };
        const directDefinition = await catalog.createWorkflowDefinition({
            workflowType: "direct-affinity",
            name: "Direct Affinity",
            owner: { provider: "entra", subject: "definition-publisher" },
            sessionComputeAffinity: "devbox",
        });
        const directRun = await catalog.createWorkflowRun({
            workflowDefinitionId: directDefinition.workflowDefinition.workflowDefinitionId,
            owner: requester,
            input: { source: "direct" },
            workflowRunKey: "direct-key",
        });
        const observer = {
            provider: "entra",
            subject: "direct-observer",
            email: "direct-observer@example.test",
            displayName: "Direct Observer",
        };
        const observedGeneratedRun = await catalog.createWorkflowRun({
            workflowDefinitionId: generatedRun.workflowDefinitionId,
            owner: observer,
            input: { source: "direct-observation" },
            workflowRunKey: generatedRun.workflowRunKey,
        });
        assert.equal(observedGeneratedRun.created, false);
        assert.equal(observedGeneratedRun.workflowRun.workflowRunId, generatedRun.workflowRunId);

        assert.deepEqual(generatedRun.owner, {
            provider: "system",
            subject: "system",
            email: null,
            displayName: "System",
        });
        assert.deepEqual(directRun.workflowRun.owner, generatedRun.owner);
        assert.equal("executionAffinity" in generatedRun, false);
        assert.equal("executionAffinity" in directRun.workflowRun, false);
        assert.deepEqual(
            (await catalog.getWorkflowRun(generatedRun.workflowRunId)).requestedBy,
            generatorOwner,
        );
        assert.deepEqual(
            (await catalog.getWorkflowRun(directRun.workflowRun.workflowRunId)).requestedBy,
            requester,
        );

        const generatedCatalog = await catalog.listWorkflowRuns({}, {
            provider: generatorOwner.provider,
            subject: generatorOwner.subject,
        });
        assert.deepEqual(generatedCatalog.map((run) => run.workflowRunId), [generatedRun.workflowRunId]);
        assert.equal(generatedCatalog[0].origin, "Workflow Generator");
        assert.equal(generatedCatalog[0].producerType, "workflow_generator");
        assert.equal(generatedCatalog[0].workflowGeneratorId, generator.workflowGeneratorId);
        assert.deepEqual(generatedCatalog[0].requestedBy, generatorOwner);

        const directCatalog = await catalog.listWorkflowRuns({}, {
            provider: requester.provider,
            subject: requester.subject,
        });
        assert.deepEqual(directCatalog.map((run) => run.workflowRunId), [directRun.workflowRun.workflowRunId]);
        assert.equal(directCatalog[0].origin, "Direct");
        assert.equal(directCatalog[0].producerType, "direct_request");
        assert.equal(directCatalog[0].workflowGeneratorId, null);
        assert.deepEqual(directCatalog[0].requestedBy, requester);

        const observerCatalog = await catalog.listWorkflowRuns({}, {
            provider: observer.provider,
            subject: observer.subject,
        });
        assert.deepEqual(observerCatalog, []);

        const unrelatedCatalog = await catalog.listWorkflowRuns({}, {
            provider: "entra",
            subject: "unrelated",
        });
        assert.deepEqual(unrelatedCatalog, []);

        const fleetCatalog = await catalog.listWorkflowRuns();
        assert.deepEqual(
            new Set(fleetCatalog.map((run) => run.workflowRunId)),
            new Set([generatedRun.workflowRunId, directRun.workflowRun.workflowRunId]),
        );

        const claims = await catalog.claimWorkflowRunsForInduction("inducer", 10, 60);
        const byKey = new Map(claims.map((claim) => [claim.workflowRun.workflowRunKey, claim]));
        assert.deepEqual(byKey.get("generated-key").executionAffinity, generatorOwner);
        assert.deepEqual(byKey.get("direct-key").executionAffinity, requester);

        await assert.rejects(
            catalog.beginWorkflowRunCleanup({
                workflowRunId: directRun.workflowRun.workflowRunId,
                actor: observer,
            }),
            (error) => error.code === "NOT_FOUND",
        );
        assert.equal(
            (await catalog.beginWorkflowRunCleanup({
                workflowRunId: directRun.workflowRun.workflowRunId,
                actor: requester,
            })).workflowRunId,
            directRun.workflowRun.workflowRunId,
        );
        assert.equal(
            (await catalog.beginWorkflowRunCleanup({
                workflowRunId: generatedRun.workflowRunId,
                actor: observer,
                isAdmin: true,
            })).workflowRunId,
            generatedRun.workflowRunId,
        );
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});

test("Postgres upgrades a feature-parent 0096 schema through the shared identity conversion", {
    skip: !catalogUrl,
    timeout: 120_000,
}, async () => {
    const schema = `workflowRunCompat_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    try {
        await catalog.pool.query(`CREATE SCHEMA "${schema}"`);
        await catalog.pool.query(`
            CREATE TABLE "${schema}".schema_migrations (
                version TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE "${schema}".workflow_generators (
                workflow_generator_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                owner_provider TEXT NOT NULL,
                owner_subject TEXT NOT NULL,
                owner_email TEXT,
                owner_display_name TEXT,
                cadence_seconds INTEGER NOT NULL,
                operational_state TEXT NOT NULL DEFAULT 'enabled',
                active_workflow_definition_id TEXT,
                next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                watermark JSONB,
                total_cycles BIGINT NOT NULL DEFAULT 0,
                successful_cycles BIGINT NOT NULL DEFAULT 0,
                failed_cycles BIGINT NOT NULL DEFAULT 0,
                materialized_workflow_runs BIGINT NOT NULL DEFAULT 0,
                last_cycle_at TIMESTAMPTZ,
                last_error TEXT,
                lease_owner TEXT,
                lease_expires_at TIMESTAMPTZ,
                controller_compute_affinity TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE "${schema}".workflow_definitions (
                workflow_definition_id TEXT PRIMARY KEY,
                workflow_generator_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                source_type TEXT NOT NULL,
                source_config JSONB NOT NULL DEFAULT '{}'::jsonb,
                session_compute_affinity TEXT,
                workflow_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
                affinities JSONB NOT NULL DEFAULT '{}'::jsonb,
                validation_gates JSONB NOT NULL DEFAULT '[]'::jsonb,
                guardrails JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE "${schema}".workflow_generator_cycles (
                cycle_id TEXT PRIMARY KEY,
                workflow_generator_id TEXT NOT NULL,
                workflow_definition_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                claimed_by TEXT NOT NULL,
                watermark_before JSONB,
                watermark_after JSONB,
                discovered_count INTEGER NOT NULL DEFAULT 0,
                created_count INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                completed_at TIMESTAMPTZ
            );
            CREATE TABLE "${schema}".workflow_runs (
                workflow_run_id TEXT PRIMARY KEY,
                workflow_generator_id TEXT NOT NULL,
                workflow_definition_id TEXT NOT NULL,
                workflow_run_key TEXT NOT NULL,
                source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                lifecycle_state TEXT NOT NULL DEFAULT 'pending_session',
                first_seen_cycle_id TEXT NOT NULL,
                last_seen_cycle_id TEXT NOT NULL,
                first_discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                session_attempts INTEGER NOT NULL DEFAULT 0,
                session_error TEXT,
                deleted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE "${schema}".workflow_run_cleanup_tombstones (
                cleanup_id TEXT PRIMARY KEY,
                workflow_generator_id TEXT NOT NULL
            );
            CREATE OR REPLACE FUNCTION "${schema}".cms_workflow_generator_definition_immutable()
            RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'WORKFLOW_GENERATOR_DEFINITION_IMMUTABLE';
            END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER trg_workflow_generator_definition_immutable
                BEFORE UPDATE ON "${schema}".workflow_definitions
                FOR EACH ROW EXECUTE FUNCTION "${schema}".cms_workflow_generator_definition_immutable();
        `);
        for (const migration of CMS_MIGRATIONS(schema).filter((entry) => entry.version <= "0096")) {
            await catalog.pool.query(
                `INSERT INTO "${schema}".schema_migrations (version, name) VALUES ($1, $2)`,
                [
                    migration.version,
                    migration.version === "0096"
                        ? "workflow_generator_compute_affinity"
                        : migration.name,
                ],
            );
        }
        await catalog.pool.query(`
            INSERT INTO "${schema}".workflow_generators (
                workflow_generator_id, name, owner_provider, owner_subject,
                owner_email, owner_display_name, cadence_seconds,
                active_workflow_definition_id, controller_compute_affinity
            ) VALUES (
                'generator-old', 'Old Generator', 'entra', 'generator-owner',
                'owner@example.test', 'Generator Owner', 60,
                'definition-old', 'devbox'
            );
            INSERT INTO "${schema}".workflow_definitions (
                workflow_definition_id, workflow_generator_id, version,
                source_type, source_config, session_compute_affinity,
                workflow_definition, affinities, created_by
            ) VALUES (
                'definition-old', 'generator-old', 1,
                'test-source', '{"filter":"old"}', 'devbox',
                '{"initialState":"Initial"}', '{"repo":"pilotswarm"}',
                'generator-owner'
            );
            INSERT INTO "${schema}".workflow_generator_cycles (
                cycle_id, workflow_generator_id, workflow_definition_id,
                status, claimed_by
            ) VALUES (
                'cycle-old', 'generator-old', 'definition-old',
                'succeeded', 'controller-old'
            );
            INSERT INTO "${schema}".workflow_runs (
                workflow_run_id, workflow_generator_id, workflow_definition_id,
                workflow_run_key, source_payload, first_seen_cycle_id,
                last_seen_cycle_id
            ) VALUES (
                'run-old', 'generator-old', 'definition-old',
                'source-old', '{"id":42}', 'cycle-old', 'cycle-old'
            );
        `);

        await catalog.initialize();

        const migrationRows = await catalog.pool.query(
            `SELECT version, name FROM "${schema}".schema_migrations
             WHERE version IN ('0096', '0099', '0100') ORDER BY version`,
        );
        assert.deepEqual(migrationRows.rows, [
            { version: "0096", name: "workflow_generator_compute_affinity" },
            { version: "0099", name: "workflow_0096_collision_compatibility" },
            { version: "0100", name: "workflow_run_execution_affinity" },
        ]);
        const generatorResult = await catalog.pool.query(
            `SELECT source_type, source_config, controller_compute_affinity
             FROM "${schema}".workflow_generators WHERE workflow_generator_id = 'generator-old'`,
        );
        assert.deepEqual(generatorResult.rows[0], {
            source_type: "test-source",
            source_config: { filter: "old" },
            controller_compute_affinity: "devbox",
        });
        const definitionResult = await catalog.pool.query(
            `SELECT workflow_type, session_compute_affinity
             FROM "${schema}".workflow_definitions WHERE workflow_definition_id = 'definition-old'`,
        );
        assert.deepEqual(definitionResult.rows[0], {
            workflow_type: "legacy-generator:generator-old",
            session_compute_affinity: "devbox",
        });
        const runResult = await catalog.pool.query(
            `SELECT workflow_type, input, owner_provider, owner_subject,
                    execution_affinity_provider, execution_affinity_subject
             FROM "${schema}".workflow_runs WHERE workflow_run_id = 'run-old'`,
        );
        assert.deepEqual(runResult.rows[0], {
            workflow_type: "legacy-generator:generator-old",
            input: { id: 42 },
            owner_provider: "system",
            owner_subject: "system",
            execution_affinity_provider: "entra",
            execution_affinity_subject: "generator-owner",
        });
        const producerResult = await catalog.pool.query(
            `SELECT payload FROM "${schema}".workflow_run_producers
             WHERE workflow_run_id = 'run-old'`,
        );
        assert.deepEqual(producerResult.rows, [{ payload: { id: 42 } }]);
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});

test("Postgres WorkflowRun cleanup is owner-scoped, idempotent, and fenced from stale work", {
    skip: !catalogUrl,
    timeout: 120_000,
}, async () => {
    const schema = `workflowRuncleanup_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    const owner = { provider: "test", subject: "owner", displayName: "Owner" };
    try {
        await catalog.initialize();
        await catalog.createSession("tree-root");
        await catalog.createSession("tree-child", { parentSessionId: "tree-root" });
        await catalog.beginSessionTreeDeletion("tree-root");
        assert.equal(await catalog.isSessionActive("tree-root"), false);
        assert.deepEqual(
            await catalog.getDescendantSessionIdsIncludingDeleted("tree-root"),
            ["tree-child"],
        );
        await assert.rejects(
            catalog.createSession("tree-late-child", { parentSessionId: "tree-root" }),
            /fenced for deletion/,
        );

        const { generator } = await createGenerator(catalog, {
            name: "cleanup",
            owner,
            sourceConfig: { filter: "sample-records" },
        });
        await catalog.claimDueWorkflowGenerators("worker-1", 1, 60, "cluster");
        const { cycle } = await catalog.beginWorkflowGeneratorCycle(generator.workflowGeneratorId, "worker-1");
        const workflowRuns = await catalog.reconcileWorkflowGeneratorDiscoveries(cycle.cycleId, [
            { key: "delete-me", payload: { id: 1 } },
            { key: "keep-me", payload: { id: 2 } },
        ]);
        const deletedWorkflowRun = workflowRuns.find((workflowRun) => workflowRun.workflowRunKey === "delete-me");
        assert.ok(deletedWorkflowRun);
        await catalog.reserveWorkflowRunSession(deletedWorkflowRun.workflowRunId, cycle.cycleId, "worker-1", "session-delete");

        await assert.rejects(
            catalog.beginWorkflowRunCleanup({
                workflowRunId: deletedWorkflowRun.workflowRunId,
                actor: { provider: "test", subject: "other" },
            }),
            (error) => error.code === "NOT_FOUND",
        );

        const workflowRunPlan = await catalog.beginWorkflowRunCleanup({ workflowRunId: deletedWorkflowRun.workflowRunId, actor: owner });
        assert.equal(workflowRunPlan.alreadyDeleted, false);
        assert.deepEqual(workflowRunPlan.sessionIds, ["session-delete"]);
        assert.deepEqual(
            await catalog.recordWorkflowRunCleanupSessions(
                "workflowRun",
                deletedWorkflowRun.workflowRunId,
                ["session-delete", "session-child"],
            ),
            ["session-child", "session-delete"],
        );
        assert.deepEqual(
            (await catalog.listWorkflowGeneratorRuns(generator.workflowGeneratorId)).map((workflowRun) => workflowRun.workflowRunKey),
            ["keep-me"],
        );
        assert.equal((await catalog.getWorkflowRun(deletedWorkflowRun.workflowRunId, true)).lifecycleState, "cancelled");
        await assert.rejects(
            catalog.replaceWorkflowRunSession(deletedWorkflowRun.workflowRunId, "session-stale"),
            /WorkflowRun is terminal/,
        );
        assert.deepEqual(
            await catalog.reconcileWorkflowGeneratorDiscoveries(cycle.cycleId, [
                { key: "delete-me", payload: { id: 1, stale: true } },
            ]),
            [],
        );
        await catalog.completeWorkflowRunCleanup("workflowRun", deletedWorkflowRun.workflowRunId, {
            status: "completed",
            deletedSessionCount: 1,
        });

        const repeatedWorkflowRunPlan = await catalog.beginWorkflowRunCleanup({ workflowRunId: deletedWorkflowRun.workflowRunId, actor: owner });
        assert.equal(repeatedWorkflowRunPlan.alreadyDeleted, true);
        assert.deepEqual(repeatedWorkflowRunPlan.sessionIds, ["session-child", "session-delete"]);
        await catalog.completeWorkflowRunCleanup("workflowRun", deletedWorkflowRun.workflowRunId, {
            status: "failed",
            error: "late concurrent failure",
        });
        const tombstone = await catalog.pool.query(
            `SELECT cleanup_status, cleanup_error
             FROM "${schema}".workflow_run_cleanup_tombstones
             WHERE aggregate_type = 'workflowRun' AND aggregate_id = $1`,
            [deletedWorkflowRun.workflowRunId],
        );
        assert.equal(tombstone.rows[0].cleanup_status, "completed");
        assert.equal(tombstone.rows[0].cleanup_error, null);

        const generatorPlan = await catalog.beginWorkflowGeneratorCleanup({
            workflowGeneratorId: generator.workflowGeneratorId,
            actor: owner,
        });
        assert.equal(generatorPlan.alreadyDeleted, false);
        assert.equal((await catalog.listWorkflowGenerators()).length, 0);
        assert.equal((await catalog.listWorkflowGeneratorRuns(generator.workflowGeneratorId)).length, 0);
        assert.equal((await catalog.claimDueWorkflowGenerators("worker-2", 1, 60, "cluster")).length, 0);
        await assert.rejects(
            catalog.registerWorkflowGenerator({
                workflowGeneratorId: generator.workflowGeneratorId,
                name: "resurrected",
                owner,
                cadenceSeconds: 60,
            }),
            /WORKFLOW_GENERATOR_DELETED/,
        );

        const replacement = await createGenerator(catalog, {
            name: "cleanup",
            owner,
            sourceConfig: { filter: "sample-records" },
        });
        assert.notEqual(replacement.generator.workflowGeneratorId, generator.workflowGeneratorId);
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});
