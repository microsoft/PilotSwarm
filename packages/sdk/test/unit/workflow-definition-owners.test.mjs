/**
 * OF-S2-5 (owner, 2026-11-07T20:58Z: "Need to workflow icon next to the session title if the session has grown a
 * workflow"): the paged session list says which sessions own a live Workflow Definition, read in one query on the owner
 * index (migration 0107). Without a database: the catalog's read against a pool that runs the query's own conditions on
 * an in-memory table, and the list's flag from a catalog that has the read, has none, or fails (a database without 0107).
 * The read on PostgreSQL is in test/local/workflow-session-definitions.test.js.
 *
 * Run: node --test test/unit/workflow-definition-owners.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PgSessionCatalogProvider } from "../../dist/cms.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const TABLE = [
    { owner_session_id: "owner-a", deleted_at: null },
    { owner_session_id: "owner-a", deleted_at: null },
    { owner_session_id: "owner-b", deleted_at: "2026-11-07T20:00:00Z" },
    { owner_session_id: "owner-x", deleted_at: null },
];

/** A pool whose query applies only the conditions its SQL names: drop one and the answer changes. */
function tablePool(calls) {
    return {
        async query(sql, params) {
            calls.push({ sql, params });
            let rows = TABLE;
            if (/owner_session_id\s*=\s*ANY\(\$1\)/.test(sql)) rows = rows.filter(row => params[0].includes(row.owner_session_id));
            if (/deleted_at IS NULL/.test(sql)) rows = rows.filter(row => row.deleted_at === null);
            if (/SELECT DISTINCT owner_session_id/.test(sql)) rows = [...new Set(rows.map(row => row.owner_session_id))].map(id => ({ owner_session_id: id }));
            return { rows };
        },
    };
}

const read = (ids, calls = []) => PgSessionCatalogProvider.prototype.listWorkflowDefinitionOwnersFor.call({ pool: tablePool(calls), sql: { schema: "cms" } }, ids);

test("the batched read: the given sessions that own a live definition, once each; a deleted one does not count", async () => {
    const calls = [];
    const owners = await read(["owner-a", "owner-b", "owner-c", "owner-a"], calls);
    assert.deepEqual([...owners], ["owner-a"]);
    assert.equal(calls.length, 1, "one query for the whole page");
    assert.match(calls[0].sql, /FROM "cms"\.session_workflow_definitions/);
    assert.deepEqual(calls[0].params, [["owner-a", "owner-b", "owner-c"]]);
});

test("the batched read: no ids, no query", async () => {
    const calls = [];
    assert.equal((await read([], calls)).size, 0);
    assert.equal((await read(["", null], calls)).size, 0);
    assert.equal(calls.length, 0);
});

const ROW = (sessionId) => ({ sessionId, state: "idle", createdAt: new Date(0), updatedAt: new Date(1000) });

/** The list over a catalog with the page's rows and, optionally, the owners read (a function, or absent). */
function listOver(ownersFor) {
    const catalog = {
        listSessionsPage: async () => [ROW("owner-a"), ROW("owner-b"), ROW("owner-c")],
        listSessionCanvasesFor: async () => new Map(),
        ...(ownersFor ? { listWorkflowDefinitionOwnersFor: ownersFor } : {}),
    };
    return PilotSwarmManagementClient.prototype.listSessionsPage.call({ _ensureStarted() {}, _catalog: catalog }, { limit: 10 });
}

test("the list: hasWorkflowDefinitions true for an owner of a live definition, false for the others", async () => {
    let asked = null;
    const page = await listOver(async ids => { asked = ids; return read(ids); });
    assert.deepEqual(asked, ["owner-a", "owner-b", "owner-c"]);
    assert.deepEqual(page.sessions.map(session => [session.sessionId, session.hasWorkflowDefinitions]),
        [["owner-a", true], ["owner-b", false], ["owner-c", false]]);
});

test("the list: no flag and no error with no 0107 table (the read fails) or a catalog without the read", async () => {
    const missing = Object.assign(new Error('relation "cms.session_workflow_definitions" does not exist'), { code: "42P01" });
    for (const ownersFor of [async () => { throw missing; }, null]) {
        const page = await listOver(ownersFor);
        assert.equal(page.sessions.length, 3);
        for (const session of page.sessions) assert.equal(Object.hasOwn(session, "hasWorkflowDefinitions"), false, session.sessionId);
    }
});
