/**
 * Migration 0107 (Workflow Simplified stage 2.1, decision D3; the coordinator's readings Q4–Q6) on a database with stage 1
 * Workflows: each live chat's Workflow children are grouped by definition name into one chat definition. Its revisions are
 * every distinct YAML any of them stored (a draft's replaced revisions included), deduplicated by YAML hash, never by
 * metadata.version, oldest first, each marked imported and based on the one before. Each child points at the revision of
 * the YAML it ran (a stage 1 draft: its current YAML; it stays a row). A deleted chat's children are left as they are.
 * Nothing stored before is changed or deleted.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { createWorkflowV2, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const CMS_LOCK_SEED = 0x63_6D_73;
const ACTOR = { kind: "system", name: "migration-0107-test" };
const PERSON = { provider: "test", subject: "migration-0107" };

const YAML = (name, version, seconds) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "${version}" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

describe("migration 0107: stage 1 Workflows become chat definitions with imported revisions (D3)", () => {
    it("groups by name, imports every distinct YAML oldest first (replaced drafts too; not by version), pins each child, skips deleted chats", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        try {
            await runMigrations(direct, env.cmsSchema, CMS_MIGRATIONS(env.cmsSchema).filter(m => m.version <= "0106"), CMS_LOCK_SEED);
            const store = catalog.workflowStore();
            const host = { catalog, store, duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const chat = randomUUID();
            const gone = randomUUID();
            await catalog.createSession(chat, { owner: PERSON });
            await catalog.createSession(gone, { owner: PERSON });
            const make = async (parent, yaml, { publish = true, start = true } = {}) => {
                const id = randomUUID();
                await createWorkflowV2(host, { workflowSessionId: id, parentSessionId: parent, yaml, actor: ACTOR, operationId: `create-${id}`, publish,
                    ...(start ? { start: { inputs: {} } } : {}) });
                return id;
            };
            const A = YAML("hn-top-watch", "1.0.0", 30);
            const B = YAML("hn-top-watch", "1.1.0", 40);
            const C = YAML("hn-top-watch", "1.1.0", 45);
            const D = YAML("hn-top-watch", "1.1.0", 50);
            const E = YAML("other", "1.0.0", 10);
            const w1 = await make(chat, A);
            const w2 = await make(chat, A);
            // A draft at B, replaced by C, then published and started at C.
            const w3 = await make(chat, B, { publish: false, start: false });
            await updateWorkflowV2(host, w3, { operation: "replace_definition", yaml: C, expectedRevision: 1 }, { actor: ACTOR, operationId: "replace-1" });
            const w3Hash = (await store.readRevision(w3, 2)).yamlSha256;
            await updateWorkflowV2(host, w3, { operation: "publish_and_start", expectedRevision: 2, definitionHash: w3Hash, inputs: {} }, { actor: ACTOR, operationId: "pas-1" });
            // Another YAML at 1.1.0 (stage 1 allowed it before SEMVER_REUSED).
            const w4 = await make(chat, D);
            // A draft of another name, never started.
            const w5 = await make(chat, E, { publish: false, start: false });
            // A deleted chat's Workflow.
            const w6 = await make(gone, YAML("hn-top-watch", "9.9.9", 99));
            await direct.query(`UPDATE "${env.cmsSchema}".sessions SET deleted_at = now() WHERE session_id = $1`, [gone]);
            const before = (await direct.query(`SELECT workflow_session_id, revision, yaml_sha256 FROM "${env.cmsSchema}".workflow_revisions ORDER BY 1, 2`)).rows;

            await catalog.initialize();
            const versions = (await direct.query(`SELECT version FROM "${env.cmsSchema}".schema_migrations ORDER BY version`)).rows.map(row => row.version);
            expect(versions).toContain("0107");
            expect(versions.at(-1)).toBe(CMS_MIGRATIONS(env.cmsSchema).at(-1).version);

            const definitions = await store.chat.listDefinitions(chat);
            expect(definitions.map(item => [item.name, item.source, item.currentRevision])).toEqual([["hn-top-watch", "imported", 4], ["other", "imported", 1]]);
            const hn = definitions[0];
            const revisions = await Promise.all([1, 2, 3, 4].map(n => store.chat.readRevision(hn.definitionId, n)));
            expect(revisions.map(item => item.yaml)).toEqual([A, B, C, D]);
            expect(revisions.map(item => [item.semver, item.basedOn, item.imported, item.actor.kind])).toEqual([
                ["1.0.0", null, true, "system"], ["1.1.0", 1, true, "system"], ["1.1.0", 2, true, "system"], ["1.1.0", 3, true, "system"]]);
            // Each child points at the revision of the YAML it ran; the draft at its current YAML.
            const pins = Object.fromEntries((await direct.query(
                `SELECT workflow_session_id, chat_definition_id, chat_revision FROM "${env.cmsSchema}".workflow_definitions`)).rows
                .map(row => [row.workflow_session_id, [row.chat_definition_id, row.chat_revision]]));
            expect(pins[w1]).toEqual([hn.definitionId, 1]);
            expect(pins[w2]).toEqual([hn.definitionId, 1]);
            expect(pins[w3]).toEqual([hn.definitionId, 3]);
            expect(pins[w4]).toEqual([hn.definitionId, 4]);
            expect(pins[w5]).toEqual([definitions[1].definitionId, 1]);
            expect(pins[w6]).toEqual([null, null]);
            expect(await store.chat.listDefinitions(gone, { includeDeleted: true })).toEqual([]);
            // Nothing stored before changed.
            expect((await direct.query(`SELECT workflow_session_id, revision, yaml_sha256 FROM "${env.cmsSchema}".workflow_revisions ORDER BY 1, 2`)).rows).toEqual(before);
            // The Workflows of the imported definition are listed with their revisions; a save goes on after the imported ones.
            expect((await store.chat.listWorkflows({ definitionId: hn.definitionId })).map(item => item.revision).sort()).toEqual([1, 1, 3, 4]);
            // 0107 is idempotent on a second start.
            await catalog.initialize();
            expect((await store.chat.listDefinitions(chat)).length).toBe(2);
        } finally {
            await catalog.close();
            await direct.end();
        }
    });
});
