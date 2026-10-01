/**
 * Migration 0028 — paged session listing carries the owner.
 *
 * DB-only (no workers, no LLM): creates a throwaway schema, runs the full
 * migration chain through PgSessionCatalog.initialize(), persists an owned
 * session, and asserts the KEYSET-PAGED list — the path the web portal
 * always uses — returns the owner. Before 0028, cms_list_sessions_page
 * returned SETOF sessions (no owner columns), so paged rows carried
 * owner: null and the portal rendered "?" initials for every session.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/list-sessions-page-owner.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `t0028_${Date.now().toString(36)}`;

const OWNER = {
    provider: "entra",
    subject: "test-subject-0028",
    email: "owner0028@example.test",
    displayName: "Paged Owner",
};

describe.skipIf(!DATABASE_URL)("cms_list_sessions_page owner join (0028)", () => {
    let catalog;

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize(); // runs the full migration chain incl. 0028
    });

    afterAll(async () => {
        // Hermetic: drop the throwaway schema, then close.
        try {
            const { default: pg } = await import("pg");
            const p = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
            await p.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
            await p.end();
        } finally {
            await catalog?.close?.();
        }
    });

    it("paged rows carry the persisted owner", async () => {
        const sessionId = `sess-0028-${Date.now()}`;
        await catalog.createSession(sessionId, {
            model: "test-model",
            splash: "{cyan-fg}desktop{/cyan-fg}",
            splashMobile: "{cyan-fg}mobile{/cyan-fg}",
            owner: OWNER,
        });

        const page = await catalog.listSessionsPage({ limit: 10 });
        const row = page.find((r) => r.sessionId === sessionId);
        expect(row, "created session must appear in the paged list").toBeTruthy();
        expect(row.owner, "paged row must carry the owner (0028)").toBeTruthy();
        expect(row.owner.provider).toBe(OWNER.provider);
        expect(row.owner.subject).toBe(OWNER.subject);
        expect(row.owner.email).toBe(OWNER.email);
        expect(row.owner.displayName).toBe(OWNER.displayName);
        // 0026/0028 wire order: splash_mobile rides along on the paged path too.
        expect(row.splashMobile).toBe("{cyan-fg}mobile{/cyan-fg}");
    });

    it("paged list and full list agree on the owner for the same session", async () => {
        const sessionId = `sess-0028b-${Date.now()}`;
        await catalog.createSession(sessionId, { model: "test-model", owner: OWNER });

        const [paged, full] = await Promise.all([
            catalog.listSessionsPage({ limit: 10 }),
            catalog.listSessions(),
        ]);
        const pagedRow = paged.find((r) => r.sessionId === sessionId);
        const fullRow = full.find((r) => r.sessionId === sessionId);
        expect(pagedRow?.owner).toEqual(fullRow?.owner);
    });

    it("paginates equal-millisecond updates deterministically and applies filters", async () => {
        const ids = ["sess-page-a", "sess-page-b", "sess-page-c"].map(
            (suffix) => `${suffix}-${Date.now()}`,
        );
        for (const sessionId of ids) {
            await catalog.createSession(sessionId, { model: "test-model", owner: OWNER });
        }
        const updatedAt = new Date("2099-01-02T03:04:05.678Z");
        await catalog.pool.query(
            `UPDATE "${SCHEMA}".sessions SET updated_at = $1 WHERE session_id = ANY($2::text[])`,
            [updatedAt, ids],
        );

        const expected = [...ids].sort().reverse();
        const first = await catalog.listSessionsPage({
            limit: 2,
            ownerQuery: "Paged Owner",
            updatedAfter: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(first.map((row) => row.sessionId)).toEqual(expected.slice(0, 2));

        const second = await catalog.listSessionsPage({
            limit: 2,
            cursorUpdatedAt: first.at(-1).updatedAt,
            cursorSessionId: first.at(-1).sessionId,
            ownerQuery: "owner0028@example.test",
            status: first.at(-1).state,
            updatedAfter: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(second.map((row) => row.sessionId)).toEqual(expected.slice(2));
    });

    it("preserves legacy ten-argument Session page calls without overload ambiguity", async () => {
        const { rows } = await catalog.pool.query(
            `SELECT count(*)::int AS count
               FROM "${SCHEMA}".cms_list_sessions_page(
                   10, NULL, NULL, FALSE, NULL, NULL, TRUE, NULL, NULL, 'all'
               )`,
        );
        expect(rows[0].count).toBeGreaterThanOrEqual(0);
    });

    it("pages and filters Workflow Generators and Runs at equal timestamps", async () => {
        const suffix = Date.now().toString(36);
        const definition = await catalog.createWorkflowDefinition({
            workflowType: `catalog-query-${suffix}`,
            name: "Catalog Query Definition",
            owner: OWNER,
            workflowDefinition: {},
            affinities: { repo: "catalog-repo" },
            sessionComputeAffinity: "cluster",
        });
        const definitionId = definition.workflowDefinition.workflowDefinitionId;
        const generatorIds = ["a", "b", "c"].map((part) => `generator-${suffix}-${part}`);
        for (const workflowGeneratorId of generatorIds) {
            await catalog.createWorkflowGenerator({
                workflowGeneratorId,
                name: `Catalog Generator ${workflowGeneratorId}`,
                owner: OWNER,
                cadenceSeconds: 300,
                sourceType: "test",
                sourceConfig: {},
                controllerComputeAffinity: "cluster",
                workflowDefinitionId: definitionId,
            });
        }
        const runIds = ["a", "b", "c"].map((part) => `run-${suffix}-${part}`);
        for (const workflowRunId of runIds) {
            await catalog.createWorkflowRun({
                workflowRunId,
                workflowDefinitionId: definitionId,
                workflowRunKey: `catalog-key-${workflowRunId}`,
                input: {},
                owner: OWNER,
            });
        }
        const updatedAt = new Date("2099-02-03T04:05:06.789Z");
        await Promise.all([
            catalog.pool.query(
                `UPDATE "${SCHEMA}".workflow_generators
                    SET updated_at = $1 WHERE workflow_generator_id = ANY($2::text[])`,
                [updatedAt, generatorIds],
            ),
            catalog.pool.query(
                `UPDATE "${SCHEMA}".workflow_runs
                    SET updated_at = $1 WHERE workflow_run_id = ANY($2::text[])`,
                [updatedAt, runIds],
            ),
        ]);

        const generatorFirst = await catalog.listWorkflowGeneratorsPage({
            limit: 2,
            ownerQuery: "Paged Owner",
            status: "enabled",
            repository: "catalog-repo",
            placement: "cluster",
            updatedAfter: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(generatorFirst.map((row) => row.workflowGeneratorId))
            .toEqual([...generatorIds].sort().reverse().slice(0, 2));
        const generatorSecond = await catalog.listWorkflowGeneratorsPage({
            limit: 2,
            cursorUpdatedAt: generatorFirst.at(-1).updatedAt,
            cursorId: generatorFirst.at(-1).workflowGeneratorId,
            repository: "catalog-repo",
            updatedAfter: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(generatorSecond.map((row) => row.workflowGeneratorId))
            .toEqual([...generatorIds].sort().reverse().slice(2));

        const runFirst = await catalog.listWorkflowRunsPage({
            limit: 2,
            ownerQuery: "owner0028@example.test",
            repository: "catalog-repo",
            placement: "cluster",
            origin: "direct",
            workflowQuery: "Catalog Query",
            updatedAfter: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(runFirst.map((row) => row.workflowRunId))
            .toEqual([...runIds].sort().reverse().slice(0, 2));
        expect(runFirst.every((row) => row.sessionComputeAffinity === "cluster")).toBe(true);
        const runSecond = await catalog.listWorkflowRunsPage({
            limit: 2,
            cursorUpdatedAt: runFirst.at(-1).updatedAt,
            cursorId: runFirst.at(-1).workflowRunId,
            workflowRunKey: "catalog-key",
            updatedAfter: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(runSecond.map((row) => row.workflowRunId))
            .toEqual([...runIds].sort().reverse().slice(2));
    });
});
