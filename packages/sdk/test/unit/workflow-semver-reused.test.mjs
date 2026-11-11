/**
 * SEMVER_REUSED (owner revision dump 2, 2026-11-06): a session reused 1.1.3 for 4 different YAMLs of one definition. One
 * metadata.name and version is one definition among the Workflows of one session: spawn_workflow and a draft's
 * replace_definition (an agent's or a person's) refuse a version that another live Workflow of the same parent has with
 * other YAML, or is being created with. The check runs inside the claim's transaction under a lock on (parent, name), so
 * two creations at the same moment are serialized and a refused one binds no row. Store SQL and the whole path on
 * PostgreSQL: test/local/workflow-semver-reused.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowStore, WorkflowStoreError } from "../../dist/workflow/store.js";
import { createWorkflow } from "../../dist/workflow/service.js";
import { updateWorkflowFromTool } from "../../dist/workflow/tools.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";

const YAML = (version, seconds = 60) => [
    "apiVersion: pilotswarm.dev/v1", "kind: Workflow", `metadata: { name: monitor, version: "${version}" }`, "initial: hold", "states:",
    `  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }`, "  done: { type: terminal, outcome: succeeded }", "",
].join("\n");

const CHECK = { parentSessionId: "chat", workflowSessionId: "wf-new", name: "monitor", semver: "1.1.3", yamlSha256: "y-new", irSha256: "i-new",
    nothingSaved: "Nothing was saved." };

/** A store over a fake pool that answers the sibling read with `rows` and records each query. */
function storeAnswering(rows) {
    const queries = [];
    const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows }; } };
    return { store: new WorkflowStore(pool, "cms"), queries };
}

async function refusal(promise) {
    try { await promise; } catch (error) { return error; }
    assert.fail("expected a refusal");
}

test("requireVersionFree reads the parent's other live Workflows, stored or being created, by name and version", async () => {
    const { store, queries } = storeAnswering([]);
    await store.requireVersionFree(CHECK);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].params, ["chat", "wf-new", "monitor", "1.1.3", "y-new", "i-new"]);
    const sql = queries[0].sql.replace(/\s+/g, " ");
    for (const part of [
        // A Workflow with a definition: its published or current revision.
        `FROM "cms".workflow_definitions d`, `JOIN "cms".workflow_revisions r`, "r.revision = COALESCE(d.published_revision, d.current_revision)",
        `JOIN "cms".sessions s ON s.session_id = d.workflow_session_id`, "d.parent_session_id = $1 AND d.workflow_session_id <> $2",
        "d.state <> 'deleted' AND s.deleted_at IS NULL", "r.name = $3 AND r.semver = $4 AND r.yaml_sha256 <> $5",
        "(r.ir_sha256 IS NULL OR $6::text IS NULL OR r.ir_sha256 <> $6::text)",
        // A Workflow claimed but not stored yet: what its claim recorded.
        "UNION ALL", "SELECT s.session_id, 'claimed', NULL, s.created_at",
        "s.parent_session_id = $1 AND s.session_id <> $2 AND s.session_kind = 'workflow' AND s.deleted_at IS NULL",
        `NOT EXISTS (SELECT 1 FROM "cms".workflow_definitions d WHERE d.workflow_session_id = s.session_id)`,
        "s.creation_config -> 'workflow' ->> 'name' = $3 AND s.creation_config -> 'workflow' ->> 'version' = $4",
        "s.creation_config -> 'workflow' ->> 'yamlSha256' <> $5",
    ]) {
        assert.ok(sql.includes(part), `the sibling read has: ${part}`);
    }
    // The read itself takes no lock: requireVersionFreeLocked takes it first, on the same transaction.
    assert.ok(!/FOR (NO KEY )?UPDATE|FOR SHARE/.test(sql));
});

test("requireVersionFreeLocked locks (schema, session, name) for the transaction, then reads on the same client", async () => {
    const { store } = storeAnswering([]);
    const calls = [];
    const client = { query: async (sql, params) => { calls.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [] }; } };
    await store.requireVersionFreeLocked(client, CHECK);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].sql, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))");
    assert.deepEqual(calls[0].params, [`cms:workflow-version:${JSON.stringify(["chat", "monitor"])}`]);
    assert.match(calls[1].sql, /UNION ALL/);
});

test("a published Workflow with the version and other YAML refuses it: raise the version and spawn the change as a draft", async () => {
    const { store } = storeAnswering([{ workflow_session_id: "wf-old", state: "published", revision: 1 }]);
    const error = await refusal(store.requireVersionFree(CHECK));
    assert.ok(error instanceof WorkflowStoreError);
    assert.equal(error.code, "SEMVER_REUSED");
    assert.equal(error.message, "monitor 1.1.3 is already Workflow wf-old of this session (published, revision 1) with other YAML. "
        + "A published version never changes: raise metadata.version and spawn the change as a draft. Nothing was saved.");
    assert.deepEqual(error.details, { name: "monitor", version: "1.1.3", workflowId: "wf-old", state: "published", revision: 1 });
});

test("a draft with the version and other YAML refuses it: change that draft with replace_definition, or raise the version", async () => {
    const { store } = storeAnswering([{ workflow_session_id: "wf-draft", state: "draft", revision: 3 }]);
    const error = await refusal(store.requireVersionFree({ ...CHECK, irSha256: null, nothingSaved: "Nothing was saved: the draft keeps its revision." }));
    assert.equal(error.code, "SEMVER_REUSED");
    assert.equal(error.message, "monitor 1.1.3 is already Workflow wf-draft of this session (a draft, revision 3) with other YAML. "
        + "To change that draft, use update_workflow replace_definition on it; for a new definition, raise metadata.version. "
        + "Nothing was saved: the draft keeps its revision.");
});

test("a Workflow being created with the version and other YAML refuses it: raise the version, or wait and change it as a draft", async () => {
    const { store } = storeAnswering([{ workflow_session_id: "wf-claimed", state: "claimed", revision: null }]);
    const error = await refusal(store.requireVersionFree(CHECK));
    assert.equal(error.code, "SEMVER_REUSED");
    assert.equal(error.message, "monitor 1.1.3 is being created as Workflow wf-claimed of this session with other YAML. Raise metadata.version, "
        + "or wait for it and change it as a draft. Nothing was saved.");
    assert.deepEqual(error.details, { name: "monitor", version: "1.1.3", workflowId: "wf-claimed", state: "claimed", revision: null });
});

/**
 * A host for createWorkflow whose claim runs `afterClaim` on a fake client (as the catalog does inside its transaction),
 * then fails with a marker: the guard's decision and the claim's record are all that is observed.
 */
function createHost({ definition = null, guard = async () => {} } = {}) {
    const calls = { guard: [], claims: [], client: { fake: "client" } };
    const host = {
        catalog: {
            getSession: async () => null,
            getSessionCreationConfig: async () => null,
            createWorkflowSession: async (id, opts) => {
                calls.claims.push({ id, opts });
                if (opts.afterClaim) await opts.afterClaim(calls.client);
                throw new Error("claim reached");
            },
        },
        store: {
            readDefinition: async () => definition,
            requireVersionFreeLocked: async (client, input) => { calls.guard.push({ client, input }); await guard(input); },
        },
        duroxideClient: {},
    };
    return { host, calls };
}

const request = (extra = {}) => ({ workflowSessionId: "wf-new", parentSessionId: "chat", yaml: YAML("1.1.3"), actor: { kind: "agent", sessionId: "chat" },
    operationId: "spawn:call:1", ...extra });

test("createWorkflow checks the version inside the claim, on its transaction, when asked; the claim records the version", async () => {
    const compiled = compileWorkflow(YAML("1.1.3"));
    const refused = createHost({ guard: async () => { throw new WorkflowStoreError("SEMVER_REUSED", "reused"); } });
    const error = await refusal(createWorkflow(refused.host, request({ refuseVersionReuse: true })));
    assert.equal(error.code, "SEMVER_REUSED", "the claim's transaction throws it, so the claim is rolled back");
    assert.equal(refused.calls.claims.length, 1);
    assert.equal(refused.calls.guard[0].client, refused.calls.client, "on the claim's own client");
    assert.deepEqual(refused.calls.guard[0].input, { parentSessionId: "chat", workflowSessionId: "wf-new", name: "monitor", semver: "1.1.3",
        yamlSha256: compiled.yamlSha256, irSha256: compiled.irSha256, nothingSaved: "Nothing was saved." });
    // What a concurrent creation's check reads until the definition is stored.
    assert.deepEqual(refused.calls.claims[0].opts.creationConfig.workflow, { ...refused.calls.claims[0].opts.creationConfig.workflow,
        name: "monitor", version: "1.1.3", yamlSha256: compiled.yamlSha256, irSha256: compiled.irSha256 });

    const passed = createHost();
    assert.equal((await refusal(createWorkflow(passed.host, request({ refuseVersionReuse: true })))).message, "claim reached");
    assert.equal(passed.calls.guard.length, 1);
});

test("createWorkflow skips the check unless asked, without a parent, and for a creation whose definition is stored (a replay)", async () => {
    for (const [label, options, extra] of [
        ["not asked", {}, {}],
        ["no parent", {}, { refuseVersionReuse: true, parentSessionId: null }],
        ["replay", { definition: { state: "draft", parentSessionId: "chat" } }, { refuseVersionReuse: true }],
    ]) {
        const { host, calls } = createHost(options);
        assert.equal((await refusal(createWorkflow(host, request(extra)))).message, "claim reached", label);
        assert.equal(calls.guard.length, 0, label);
        assert.equal(calls.claims[0].opts.afterClaim, undefined, label);
    }
});

test("a replay of a creation that named no owner is compared with the owner it inherited from its parent", async () => {
    const compiled = compileWorkflow(YAML("1.1.3"));
    const owner = { provider: "test", subject: "ada" };
    // The stored claim of the same request (its owner inherited from "session"), so the replay continues to the definition.
    const marker = createHost();
    await refusal(createWorkflow(marker.host, request({ refuseVersionReuse: true })));
    const stored = marker.calls.claims[0].opts.creationConfig;
    const replayHost = (parentOwner) => ({
        catalog: {
            getSession: async id => (id === "wf-new" ? { sessionKind: "workflow", parentSessionId: "chat", deletedAt: null, owner }
                : id === "chat" ? { sessionId: "chat", owner: parentOwner } : null),
            getSessionCreationConfig: async () => stored,
            createWorkflowSession: async () => ({ created: false }),
        },
        store: {
            readDefinition: async () => null,
            createDefinition: async () => { throw new Error("definition reached"); },
        },
        duroxideClient: {},
    });
    assert.equal((await refusal(createWorkflow(replayHost(owner), request({ refuseVersionReuse: true })))).message, "definition reached");
    const other = await refusal(createWorkflow(replayHost({ provider: "test", subject: "bob" }), request({ refuseVersionReuse: true })));
    assert.equal(other.code, "WORKFLOW_EXISTS", "the parent's owner changed: not the same request");
    assert.equal(compiled.valid, true);
});

test("update_workflow replace_definition asks the store to refuse a reused version", async () => {
    const replaced = [];
    const host = {
        catalog: { getSession: async id => (id === "wf" ? { sessionKind: "workflow", parentSessionId: "chat", deletedAt: null } : null) },
        store: {
            readDefinition: async id => (id === "wf" ? { parentSessionId: "chat" } : null),
            replaceDraft: async input => { replaced.push(input); throw new WorkflowStoreError("SEMVER_REUSED", "reused"); },
        },
        duroxideClient: {},
    };
    const answer = JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "edit-1", operation: "replace_definition",
        expected_revision: 1, yaml: YAML("1.1.3", 30) }, { callerSessionId: "chat", host }));
    assert.equal(answer.error.code, "SEMVER_REUSED");
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].refuseVersionReuse, true);
});

// Review SDK3-F2: the claim's transaction reads what an earlier holder of the version lock committed, so it runs at READ
// COMMITTED whatever the connection's default isolation (at REPEATABLE READ the check would keep the snapshot of its
// first statement, the claim, taken before it waited for the lock).
test("SDK3-F2: the claim's transaction is READ COMMITTED; the check runs after the claim, before the owner, on its client", async () => {
    const { PgSessionCatalog } = await import("../../dist/cms.js");
    const calls = [];
    const client = {
        query: async (sql) => {
            calls.push(sql.replace(/\s+/g, " ").trim());
            return { rows: /cms_create_workflow_session/.test(sql) ? [{ created: true }] : [] };
        },
        release: () => calls.push("release"),
    };
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.pool = { connect: async () => client };
    catalog.sql = { schema: "cms", fn: { setSessionOwner: "cms_set_session_owner", inheritSessionOwner: "cms_inherit_session_owner" } };
    const seen = [];
    await catalog.createWorkflowSession("wf-new", { parentSessionId: "chat", owner: null, creationConfig: {},
        afterClaim: async (given) => { seen.push(given === client); calls.push("afterClaim"); } });
    assert.deepEqual(seen, [true]);
    assert.equal(calls[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
    // Review DR-02: the parent is locked first (NO KEY UPDATE: afterClaim may take that lock), and a deleted one refused.
    assert.equal(calls[1], 'SELECT deleted_at FROM "cms".sessions WHERE session_id = $1 FOR NO KEY UPDATE');
    assert.match(calls[2], /cms_create_workflow_session/);
    assert.equal(calls[3], "afterClaim");
    assert.match(calls[4], /cms_inherit_session_owner/);
    assert.deepEqual(calls.slice(5), ["COMMIT", "release"]);
    // A refusal rolls the claim back.
    calls.length = 0;
    await assert.rejects(catalog.createWorkflowSession("wf-new", { parentSessionId: "chat", owner: null, creationConfig: {},
        afterClaim: async () => { throw new WorkflowStoreError("SEMVER_REUSED", "reused"); } }), /reused/);
    assert.deepEqual(calls.slice(-2), ["ROLLBACK", "release"]);
});

// Review SDK3-F3: a creation resumed on a claim it did not make now (its row found: an earlier attempt's claim, or an earlier
// build's that records no version) is checked when its definition is stored, in that transaction, under the lock; a fresh
// claim is checked in the claim and its definition is not checked again; a stored creation's replay is not checked.
test("SDK3-F3: a resumed claim's definition is checked when it is stored; a fresh claim's and a replay's are not", async () => {
    const compiled = compileWorkflow(YAML("1.1.3"));
    const marker = createHost();
    await refusal(createWorkflow(marker.host, request({ refuseVersionReuse: true })));
    const stored = marker.calls.claims[0].opts.creationConfig;
    const definitions = [];
    const hostOf = ({ created, definition = null }) => ({
        catalog: {
            getSession: async id => (id === "wf-new" ? { sessionKind: "workflow", parentSessionId: "chat", deletedAt: null, owner: null }
                : id === "chat" ? { sessionId: "chat", owner: null } : null),
            getSessionCreationConfig: async () => stored,
            createWorkflowSession: async (id, opts) => { if (created && opts.afterClaim) await opts.afterClaim({}); return { created }; },
        },
        store: {
            readDefinition: async () => definition,
            requireVersionFreeLocked: async () => {},
            createDefinition: async (input) => { definitions.push(input); throw new Error("definition reached"); },
        },
        duroxideClient: {},
    });
    assert.equal((await refusal(createWorkflow(hostOf({ created: false }), request({ refuseVersionReuse: true })))).message, "definition reached");
    assert.deepEqual(definitions[0].versionGuard, { parentSessionId: "chat", workflowSessionId: "wf-new", name: "monitor", semver: "1.1.3",
        yamlSha256: compiled.yamlSha256, irSha256: compiled.irSha256, nothingSaved: "Nothing was saved: the claim stays without a definition." });
    assert.equal((await refusal(createWorkflow(hostOf({ created: true }), request({ refuseVersionReuse: true })))).message, "definition reached");
    assert.equal(definitions[1].versionGuard, undefined, "a fresh claim was checked in its own transaction");
    assert.equal((await refusal(createWorkflow(hostOf({ created: false }), request({})))).message, "definition reached");
    assert.equal(definitions[2].versionGuard, undefined, "not asked");
});

test("SDK3-F3: the store runs the check after the new definition row and before its revision; a replay answers first", async () => {
    const calls = [];
    const client = {
        query: async (sql) => {
            const text = sql.replace(/\s+/g, " ").trim();
            calls.push(text);
            if (/^INSERT INTO "cms".workflow_definitions/.test(text)) return { rows: [{ workflow_session_id: "wf-new" }] };
            if (/FOR NO KEY UPDATE|FOR UPDATE/.test(text)) return { rows: [{ deleted_at: null }] };
            return { rows: [] };
        },
    };
    const store = new WorkflowStore({ query: async () => ({ rows: [] }) }, "cms");
    store.transaction = async (work) => work(client);
    store.requireLiveSession = async () => {};
    const order = [];
    store.requireVersionFreeLocked = async (given, input) => { order.push(["guard", given === client, input.name]); throw new WorkflowStoreError("SEMVER_REUSED", "reused"); };
    store.insertRevision = async () => { order.push(["revision"]); };
    const compiled = compileWorkflow(YAML("1.1.3"));
    const error = await refusal(store.createDefinition({ workflowSessionId: "wf-new", parentSessionId: "chat", notifyParent: true, yaml: YAML("1.1.3"),
        compiled, actor: { kind: "agent", sessionId: "chat" }, operationId: "op", requestSha256: "r", publish: false, start: null, title: "Workflow: monitor",
        versionGuard: { ...CHECK, name: "monitor" } }));
    assert.equal(error.code, "SEMVER_REUSED");
    assert.deepEqual(order, [["guard", true, "monitor"]], "checked before the revision; the transaction rolls back");
    assert.match(calls[0], /^INSERT INTO "cms".workflow_definitions/);
});
