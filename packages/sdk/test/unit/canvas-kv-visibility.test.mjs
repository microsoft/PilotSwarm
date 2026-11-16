/**
 * D9: an agent session inside a Workflow agent step's subtree reads, through
 * canvas_kv get and list, only rows an agent wrote. A script reads every row.
 *
 * - visibleToAgentStep: the writer kind decides; a legacy row (no writer,
 *   read back as kind "user" with an empty id) is a person row.
 * - canvasKv against an in-memory catalog and KV store: hide, show and fail
 *   (a lineage read that throws is an explicit error, never an empty
 *   result), a list cursor that is never a hidden row's key (nextAfter is
 *   the last agent row returned, set only when another agent row follows,
 *   found across store pages), the lineage read fresh on every get and
 *   list, none in script mode, and writes unchanged.
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
 * a/5 by an agent, then `extra` ([key, by] pairs). `lineage` is what
 * readWorkflowLineage answers: "agent-step", "outside", "throws",
 * "no-store" (no workflowStore), or "store-throws" (workflowStore() itself
 * throws).
 */
function kvWorld({ extra = [] } = {}) {
    const state = { lineage: "agent-step", lineageReads: [], listCalls: 0, getCalls: 0, writes: [] };
    const rows = new Map();
    const row = (key, by) => rows.set(`${P}:1:${key}`, { key, value: by ? { v: key, by, at: "t" } : { v: key }, rev: 1, updatedAt: "t" });
    row("a/1", USER_BY);
    row("a/2", AGENT_BY);
    row("a/3", LINK_BY);
    row("a/4", null);
    row("a/5", AGENT_BY);
    for (const [key, by] of extra) row(key, by);
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

/** Every page of a list from `start`, following nextAfter to the end. */
async function walk(kv, args, start) {
    const pages = [];
    let after = start;
    for (let i = 0; i < 50; i++) {
        const page = await kv({ op: "list", session_id: P, ...args, ...(after ? { after } : {}) });
        pages.push(page);
        if (!page.nextAfter) return pages;
        after = page.nextAfter;
    }
    throw new Error("the cursor never ended");
}

/** No hidden key, and no value a person or link typed, anywhere in a result. */
function assertNoHidden(result, hiddenKeys) {
    const text = JSON.stringify(result);
    for (const key of hiddenKeys) assert.ok(!text.includes(JSON.stringify(key)), `hidden key ${key} leaked: ${text}`);
}

test("agent step: the list cursor is never a hidden row's key, and every agent row stays reachable", async () => {
    const world = kvWorld();
    const kv = world.ops().canvasKv;
    const hidden = ["a/1", "a/3", "a/4"];
    // The first raw row is a/1 (a person's). A page of one starts at the
    // first AGENT row and its cursor is that row's own key.
    const first = await kv({ op: "list", limit: 1, session_id: P });
    assert.deepEqual(first.entries.map((e) => e.key), ["a/2"]);
    assert.equal(first.nextAfter, "a/2", "the cursor is the last row returned, not the last row read");
    assertNoHidden(first, hidden);
    for (const limit of [1, 2, 3, 5, undefined]) {
        const pages = await walk(kv, limit === undefined ? {} : { limit });
        assert.deepEqual(pages.flatMap((p) => p.entries.map((e) => e.key)), ["a/2", "a/5"], `limit ${limit}: every agent row, in order`);
        for (const page of pages) {
            assertNoHidden(page, hidden);
            assert.equal(page.policy, "owner");
            if (page.nextAfter) assert.equal(page.nextAfter, page.entries.at(-1).key, `limit ${limit}: the cursor is a returned key`);
        }
        assert.equal(pages.at(-1).nextAfter, undefined);
    }
    // After the last agent row there is nothing: no entries and no cursor.
    assert.deepEqual(await kv({ op: "list", limit: 1, after: "a/5", session_id: P }), { entries: [], policy: "owner" });
    // An `after` that names a hidden key answers like any other position:
    // the result depends on agent rows only.
    const fromHidden = await kv({ op: "list", limit: 1, after: "a/3", session_id: P });
    assert.deepEqual(fromHidden, await kv({ op: "list", limit: 1, after: "a/2", session_id: P }));
    assert.deepEqual(fromHidden, await kv({ op: "list", limit: 1, after: "a/30", session_id: P }));
    assert.deepEqual(fromHidden, { entries: [fromHidden.entries[0]], policy: "owner" });
    assert.equal(fromHidden.entries[0].key, "a/5");
});

test("agent step: a list reads on past whole store pages of hidden rows; trailing hidden rows give no cursor", async () => {
    // 250 person rows (more than one store page of 200) between a/5 and the
    // agent row c/1, and a link row d/1 after it.
    const people = Array.from({ length: 250 }, (_, i) => [`b/${String(i).padStart(3, "0")}`, USER_BY]);
    const world = kvWorld({ extra: [...people, ["c/1", AGENT_BY], ["d/1", LINK_BY]] });
    const kv = world.ops().canvasKv;
    const hidden = ["a/1", "a/3", "a/4", ...people.map(([key]) => key), "d/1"];
    const pages = await walk(kv, { limit: 1 });
    assert.deepEqual(pages.map((p) => p.entries.map((e) => e.key)), [["a/2"], ["a/5"], ["c/1"]]);
    assert.deepEqual(pages.map((p) => p.nextAfter), ["a/2", "a/5", undefined],
        "a/5 has a cursor because c/1 follows; c/1 has none because only d/1 (a link's) follows");
    for (const page of pages) assertNoHidden(page, hidden);
    // A full default page from the start: the three agent rows, no cursor.
    const all = await kv({ op: "list", session_id: P });
    assert.deepEqual(all.entries.map((e) => e.key), ["a/2", "a/5", "c/1"]);
    assert.equal(all.nextAfter, undefined);
    assertNoHidden(all, hidden);
    // The store is read in whole pages of 200: the 257 rows take two reads.
    const before = world.state.listCalls;
    await kv({ op: "list", session_id: P });
    assert.equal(world.state.listCalls - before, 2);
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
