/**
 * D9: an agent session inside a Workflow agent step's subtree reads, through
 * canvas_kv get and list, only rows an agent wrote. A script reads every row.
 *
 * - visibleToAgentStep: the writer kind decides; a legacy row (no writer,
 *   read back as kind "user" with an empty id) is a person row.
 * - canvasKv against an in-memory catalog and KV store: hide, show and fail
 *   (a lineage read that throws is an explicit error, never an empty
 *   result), nextAfter from the unfiltered page, the lineage read fresh on
 *   every get and list, none in script mode, and writes unchanged.
 *
 * Run: node --test test/unit/canvas-kv-visibility.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCanvasOperations, visibleToAgentStep } from "../../dist/canvas-operations.js";

const entry = (by) => ({ key: "k", v: 1, by, at: "t", rev: 1 });

test("visibleToAgentStep: only a row an agent wrote", () => {
    assert.equal(visibleToAgentStep(entry({ kind: "agent", id: "agent:s", label: "agent" })), true);
    assert.equal(visibleToAgentStep(entry({ kind: "user", id: "test/alice", label: "Alice" })), false);
    assert.equal(visibleToAgentStep(entry({ kind: "link", id: "w1", label: null })), false);
    assert.equal(visibleToAgentStep(entry({ kind: "user", id: "" })), false, "the legacy shape is a person row");
    assert.equal(visibleToAgentStep({ key: "k", v: 1, at: "t", rev: 1 }), false, "no writer at all is not an agent row");
});

const P = "kvv-parent";
const W = "kvv-workflow";
const S = "kvv-step";
const USER_BY = { kind: "user", id: "test/alice", label: "Alice" };
const AGENT_BY = { kind: "agent", id: `agent:${P}`, label: "agent" };
const LINK_BY = { kind: "link", id: "w1", label: null };
const AGENT_ROOT = { childSessionId: S, nodeExecutionId: "n", workflowSessionId: W, controllingSessionId: P, distance: 0 };

/**
 * P (agent) <- W (Workflow) <- S (agent step child). Slot 1 of P holds
 * a/1 by a person, a/2 by an agent, a/3 by a link, a/4 legacy (no `by`),
 * a/5 by an agent. `lineage` is what readWorkflowLineage answers:
 * "agent-step", "outside", "throws", "no-store" (no workflowStore), or
 * "store-throws" (workflowStore() itself throws).
 */
function kvWorld() {
    const state = { lineage: "agent-step", lineageReads: [], listCalls: 0, getCalls: 0, writes: [] };
    const rows = new Map();
    const row = (key, by) => rows.set(`${P}:1:${key}`, { key, value: by ? { v: key, by, at: "t" } : { v: key }, rev: 1, updatedAt: "t" });
    row("a/1", USER_BY);
    row("a/2", AGENT_BY);
    row("a/3", LINK_BY);
    row("a/4", null);
    row("a/5", AGENT_BY);
    const sessions = {
        [P]: { sessionId: P, parentSessionId: null, sessionKind: "agent" },
        [W]: { sessionId: W, parentSessionId: P, sessionKind: "workflow" },
        [S]: { sessionId: S, parentSessionId: W, sessionKind: "agent" },
    };
    const workflowStore = {
        async readWorkflowLineage(sessionId) {
            state.lineageReads.push(sessionId);
            if (state.lineage === "throws") throw new Error("lineage read failed");
            return { sessionId, level: 2, agentRoot: state.lineage === "agent-step" ? AGENT_ROOT : null };
        },
    };
    const base = {
        async getSession(id) { return sessions[id] ?? null; },
        async getCanvasKvSettings() { return { kvAccess: "owner", kvManifest: null, latestRev: 1 }; },
        async canvasKvGet(sid, slot, key) { state.getCalls += 1; return rows.get(`${sid}:${slot}:${key}`) ?? null; },
        async canvasKvList(sid, slot, prefix, limit, after) {
            state.listCalls += 1;
            return [...rows.values()]
                .filter((r) => rows.get(`${sid}:${slot}:${r.key}`) === r)
                .filter((r) => !prefix || r.key.startsWith(prefix))
                .filter((r) => !after || r.key > after)
                .sort((a, b) => (a.key < b.key ? -1 : 1))
                .slice(0, limit);
        },
        async canvasKvWrite(sid, slot, key, value) {
            state.writes.push([sid, slot, key, value]);
            if (value === null) { rows.delete(`${sid}:${slot}:${key}`); return { status: "deleted", rev: 2, sizeBytes: null }; }
            rows.set(`${sid}:${slot}:${key}`, { key, value, rev: 2, updatedAt: "t" });
            return { status: "written", rev: 2, sizeBytes: 1 };
        },
    };
    const catalog = new Proxy(base, {
        get(target, prop) {
            if (prop === "workflowStore") {
                if (state.lineage === "no-store") return undefined;
                if (state.lineage === "store-throws") return () => { throw new Error("workflow store unavailable"); };
                return () => workflowStore;
            }
            return Reflect.get(target, prop);
        },
    });
    const ops = (writerSessionId = S, mode = "agent") => createCanvasOperations({
        catalog, artifactStore: null, factStore: null, writerSessionId, workerNodeId: undefined, agentIdentity: null, mode,
    });
    return { state, ops };
}

const keys = (result) => result.entries.map((e) => e.key).join(",");

test("agent step: list keeps only agent rows, get reports a person row as not found", async () => {
    const world = kvWorld();
    const kv = world.ops().canvasKv;
    const list = await kv({ op: "list", session_id: P });
    assert.equal(keys(list), "a/2,a/5");
    assert.equal(list.policy, "owner", "the owner's policy still rides a filtered list");
    assert.deepEqual(await kv({ op: "get", key: "a/1", session_id: P }), { found: false, key: "a/1" });
    assert.deepEqual(await kv({ op: "get", key: "a/3", session_id: P }), { found: false, key: "a/3" });
    assert.deepEqual(await kv({ op: "get", key: "a/4", session_id: P }), { found: false, key: "a/4" }, "a legacy row is a person row");
    const agentRow = await kv({ op: "get", key: "a/2", session_id: P });
    assert.equal(agentRow.found, true);
    assert.equal(agentRow.by.kind, "agent");
    assert.deepEqual(world.state.lineageReads, [S, S, S, S, S], "the reader's lineage, read on every call");
});

test("agent step: nextAfter comes from the unfiltered page", async () => {
    const world = kvWorld();
    const kv = world.ops().canvasKv;
    // The first page of 3 is a/1 (person), a/2 (agent), a/3 (link): one row
    // survives, and the cursor is the last row READ, a/3, not a/2.
    const page1 = await kv({ op: "list", limit: 3, session_id: P });
    assert.equal(keys(page1), "a/2");
    assert.equal(page1.nextAfter, "a/3");
    const page2 = await kv({ op: "list", limit: 3, after: page1.nextAfter, session_id: P });
    assert.equal(keys(page2), "a/5");
    assert.equal(page2.nextAfter, undefined, "a short page has no cursor");
    // A page that is all person rows is empty but still pages on.
    const personPage = await kv({ op: "list", limit: 1, session_id: P });
    assert.deepEqual(personPage.entries, []);
    assert.equal(personPage.nextAfter, "a/1");
});

test("outside every agent step, and with no workflow store, every row shows", async () => {
    const world = kvWorld();
    world.state.lineage = "outside";
    const kv = world.ops().canvasKv;
    assert.equal(keys(await kv({ op: "list", session_id: P })), "a/1,a/2,a/3,a/4,a/5");
    assert.equal((await kv({ op: "get", key: "a/1", session_id: P })).found, true);
    world.state.lineage = "no-store";
    assert.equal(keys(await kv({ op: "list", session_id: P })), "a/1,a/2,a/3,a/4,a/5");
    assert.equal((await kv({ op: "get", key: "a/4", session_id: P })).found, true);
});

const LINEAGE_FAILED = { error: "could not verify the session lineage: lineage read failed" };

test("a lineage read that throws fails closed with an explicit error, and the store is not read", async () => {
    const world = kvWorld();
    world.state.lineage = "throws";
    const kv = world.ops().canvasKv;
    assert.deepEqual(await kv({ op: "list", session_id: P }), LINEAGE_FAILED, "never an empty page");
    assert.deepEqual(await kv({ op: "get", key: "a/2", session_id: P }), LINEAGE_FAILED, "never found: false");
    assert.equal(world.state.listCalls, 0);
    assert.equal(world.state.getCalls, 0);
    assert.deepEqual(await kv({ op: "get", session_id: P }), { error: "key is required for get (use list with a prefix to browse)" },
        "the argument check still comes first");
    // Writes are unchanged: they read no lineage and land.
    const reads = world.state.lineageReads.length;
    assert.deepEqual(await kv({ op: "put", key: "a/6", value: { n: 1 }, session_id: P }), { ok: true, key: "a/6", rev: 2 });
    assert.deepEqual(await kv({ op: "delete", key: "a/6", session_id: P }), { ok: true, key: "a/6", rev: 2 });
    assert.equal(world.state.lineageReads.length, reads);
});

test("a workflowStore() that throws is the same explicit lineage error", async () => {
    const world = kvWorld();
    world.state.lineage = "store-throws";
    const kv = world.ops().canvasKv;
    const failed = { error: "could not verify the session lineage: workflow store unavailable" };
    assert.deepEqual(await kv({ op: "list", session_id: P }), failed);
    assert.deepEqual(await kv({ op: "get", key: "a/2", session_id: P }), failed);
    assert.equal(world.state.listCalls, 0);
    assert.equal(world.state.getCalls, 0);
});

test("the mode is read fresh on every call: one operations set follows the lineage", async () => {
    const world = kvWorld();
    const kv = world.ops().canvasKv;
    assert.equal(keys(await kv({ op: "list", session_id: P })), "a/2,a/5");
    world.state.lineage = "outside";
    assert.equal(keys(await kv({ op: "list", session_id: P })), "a/1,a/2,a/3,a/4,a/5");
    world.state.lineage = "throws";
    assert.deepEqual(await kv({ op: "list", session_id: P }), LINEAGE_FAILED);
    world.state.lineage = "agent-step";
    assert.deepEqual(await kv({ op: "get", key: "a/1", session_id: P }), { found: false, key: "a/1" });
    assert.equal(world.state.lineageReads.length, 4);
});

test("a script reads every row and never reads the lineage", async () => {
    const world = kvWorld();
    // Even a lineage that would hide or fail is not consulted for a script.
    for (const lineage of ["agent-step", "throws"]) {
        world.state.lineage = lineage;
        const kv = world.ops(W, "script").canvasKv;
        assert.equal(keys(await kv({ op: "list", session_id: "parent" })), "a/1,a/2,a/3,a/4,a/5");
        const person = await kv({ op: "get", key: "a/1", session_id: "parent" });
        assert.equal(person.found, true);
        assert.equal(person.by.kind, "user");
    }
    assert.deepEqual(world.state.lineageReads, []);
});

test("writes are unchanged in an agent step: put and delete land, and read no lineage", async () => {
    const world = kvWorld();
    const kv = world.ops().canvasKv;
    const put = await kv({ op: "put", key: "a/6", value: { n: 1 }, session_id: P });
    assert.deepEqual(put, { ok: true, key: "a/6", rev: 2 });
    const del = await kv({ op: "delete", key: "a/1", session_id: P });
    assert.deepEqual(del, { ok: true, key: "a/1", rev: 2 });
    assert.equal(world.state.writes.length, 2);
    assert.equal(world.state.writes[0][3].by.kind, "agent");
    assert.equal(world.state.writes[0][3].by.id, `agent:${S}`);
    assert.deepEqual(world.state.lineageReads, []);
    // The step's own row is an agent row, so it reads it back.
    assert.equal((await kv({ op: "get", key: "a/6", session_id: P })).found, true);
});
