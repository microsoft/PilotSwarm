/**
 * SEMVER_REUSED (owner revision dump 2, 2026-11-06): a chat reused 1.1.3 for 4 different YAMLs of one definition. One
 * metadata.name and version is one definition among the Workflows of one session: spawn_workflow and a draft's
 * replace_definition (an agent's or a person's) refuse a version that another live Workflow of the same parent has with
 * other YAML. Store SQL and the whole path on PostgreSQL: test/local/workflow-v2-semver-reused.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowStore, WorkflowStoreError } from "../../dist/workflow/v2/store.js";
import { createWorkflowV2 } from "../../dist/workflow/v2/service.js";
import { spawnWorkflowV2FromTool, updateWorkflowFromTool } from "../../dist/workflow/v2/tools.js";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";

const YAML = (version, seconds = 60) => [
    "apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", `metadata: { name: monitor, version: "${version}" }`, "initial: hold", "states:",
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

test("requireVersionFree reads the parent's other live Workflows by name and version, and passes when none has other YAML", async () => {
    const { store, queries } = storeAnswering([]);
    await store.requireVersionFree(CHECK);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].params, ["chat", "wf-new", "monitor", "1.1.3", "y-new", "i-new"]);
    const sql = queries[0].sql.replace(/\s+/g, " ");
    for (const part of [
        `FROM "cms".workflow_definitions d`, `JOIN "cms".workflow_revisions r`, "r.revision = COALESCE(d.published_revision, d.current_revision)",
        `JOIN "cms".sessions s ON s.session_id = d.workflow_session_id`, "d.parent_session_id = $1 AND d.workflow_session_id <> $2",
        "d.state <> 'deleted' AND s.deleted_at IS NULL", "r.name = $3 AND r.semver = $4 AND r.yaml_sha256 <> $5",
        "(r.ir_sha256 IS NULL OR $6::text IS NULL OR r.ir_sha256 <> $6::text)",
    ]) {
        assert.ok(sql.includes(part), `the sibling read has: ${part}`);
    }
    // No lock: the read takes none.
    assert.ok(!/FOR (NO KEY )?UPDATE|FOR SHARE/.test(sql));
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

/** A host for createWorkflowV2 whose claim fails with a marker: the guard's decision is all that is observed. */
function createHost({ definition = null, guard = async () => {} } = {}) {
    const calls = { guard: [], claims: 0 };
    const host = {
        catalog: {
            getSession: async () => null,
            getSessionCreationConfig: async () => null,
            createWorkflowSessionV2: async () => { calls.claims += 1; throw new Error("claim reached"); },
        },
        store: {
            readDefinition: async () => definition,
            requireVersionFree: async input => { calls.guard.push(input); await guard(input); },
        },
        duroxideClient: {},
    };
    return { host, calls };
}

const request = (extra = {}) => ({ workflowSessionId: "wf-new", parentSessionId: "chat", yaml: YAML("1.1.3"), actor: { kind: "agent", sessionId: "chat" },
    operationId: "spawn:call:1", ...extra });

test("createWorkflowV2 checks the version before the claim when asked, and a refusal writes nothing", async () => {
    const compiled = compileWorkflowV2(YAML("1.1.3"));
    const refused = createHost({ guard: async () => { throw new WorkflowStoreError("SEMVER_REUSED", "reused"); } });
    const error = await refusal(createWorkflowV2(refused.host, request({ refuseVersionReuse: true })));
    assert.equal(error.code, "SEMVER_REUSED");
    assert.equal(refused.calls.claims, 0);
    assert.deepEqual(refused.calls.guard, [{ parentSessionId: "chat", workflowSessionId: "wf-new", name: "monitor", semver: "1.1.3",
        yamlSha256: compiled.yamlSha256, irSha256: compiled.irSha256, nothingSaved: "Nothing was saved." }]);

    const passed = createHost();
    assert.equal((await refusal(createWorkflowV2(passed.host, request({ refuseVersionReuse: true })))).message, "claim reached");
    assert.equal(passed.calls.guard.length, 1);
    assert.equal(passed.calls.claims, 1);
});

test("createWorkflowV2 skips the check unless asked, without a parent, and for a creation whose definition is stored (a replay)", async () => {
    for (const [label, options, extra] of [
        ["not asked", {}, {}],
        ["no parent", {}, { refuseVersionReuse: true, parentSessionId: null }],
        ["replay", { definition: { state: "draft", parentSessionId: "chat" } }, { refuseVersionReuse: true }],
    ]) {
        const { host, calls } = createHost(options);
        assert.equal((await refusal(createWorkflowV2(host, request(extra)))).message, "claim reached", label);
        assert.equal(calls.guard.length, 0, label);
    }
});

test("spawn_workflow asks for the check and answers SEMVER_REUSED in its coded JSON", async () => {
    const { host, calls } = createHost({ guard: async () => {
        throw new WorkflowStoreError("SEMVER_REUSED", "monitor 1.1.3 is already Workflow wf-old of this session (published, revision 1) with other YAML.",
            { name: "monitor", version: "1.1.3", workflowId: "wf-old", state: "published", revision: 1 });
    } });
    const answer = JSON.parse(await spawnWorkflowV2FromTool({ yaml: YAML("1.1.3"), state: "published", start: true },
        { callerSessionId: "chat", workflowSessionId: "wf-new", operationId: "spawn:call:1", owner: null, binding: null, host }));
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, "SEMVER_REUSED");
    assert.match(answer.error.message, /^monitor 1\.1\.3 is already Workflow wf-old/);
    assert.deepEqual(answer.error.details, { name: "monitor", version: "1.1.3", workflowId: "wf-old", state: "published", revision: 1 });
    assert.equal(calls.guard.length, 1);
    assert.equal(calls.claims, 0);
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
