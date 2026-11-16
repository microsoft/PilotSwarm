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
 *   found across store pages, within a fixed page budget even while the
 *   rows change), the lineage read fresh on every get and list, none in
 *   script mode, and writes unchanged.
 * - readCanvas in an agent step returns the document only when its bytes
 *   are the ones the last draw recorded (canvas_live doc_sha), so a
 *   canvas.html a person put there after the draw is refused.
 *
 * Run: node --test test/unit/canvas-kv-visibility.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createHash } from "node:crypto";

import * as canvasOperations from "../../dist/canvas-operations.js";
import { CANVAS_KV_LIST_PAGE, CANVAS_KV_MAX_KEYS } from "../../dist/canvas-kv.js";

// A namespace import, so a missing export fails its own assertions rather than the whole file.
const { AGENT_STEP_LIST_MAX_PAGES, createCanvasOperations, visibleToAgentStep } = canvasOperations;

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
const AGENT_DOC = "<html><body>the agent's page</body></html>";
const PERSON_DOC = "<html><body>typed by a person into canvas.html</body></html>";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * P (agent) <- W (Workflow) <- S (agent step child). Slot 1 of P holds
 * a/1 by a person, a/2 by an agent, a/3 by a link, a/4 legacy (no `by`),
 * a/5 by an agent, then `extra` ([key, by] pairs). `lineage` is what
 * readWorkflowLineage answers: "agent-step", "outside", "throws",
 * "no-store" (no workflowStore), or "store-throws" (workflowStore() itself
 * throws). `state.afterList(page, { put, del })` runs after each store
 * page read, to change the rows between reads; a list that reads more than
 * 100 store pages throws. Slot 1 of P has a drawn document
 * (`state.doc`, rev 1) and a canvas_live row whose doc_sha is
 * `state.docSha` ("" for no row; `state.live` "off" or "throws").
 */
function kvWorld({ extra = [] } = {}) {
    const state = {
        lineage: "agent-step", lineageReads: [], listCalls: 0, getCalls: 0, writes: [], afterList: null,
        doc: AGENT_DOC, docSha: sha256(AGENT_DOC), live: "on", docReads: 0,
    };
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
            if (state.listCalls > 100) throw new Error("unbounded: the store was read more than 100 times");
            const page = [...rows.values()]
                .filter((r) => rows.get(`${sid}:${slot}:${r.key}`) === r)
                .filter((r) => !prefix || r.key.startsWith(prefix))
                .filter((r) => !after || r.key > after)
                .sort((a, b) => (a.key < b.key ? -1 : 1))
                .slice(0, limit);
            state.afterList?.(page, { put: row, del: (key) => rows.delete(`${P}:1:${key}`) });
            return page;
        },
        async getSessionCanvases(sid) { return sid === P ? [{ slot: 1, latestRev: 1 }] : []; },
        async getSessionEventsBefore(sid) {
            return sid === P ? [{ eventType: "session.canvas_updated", data: { rev: 1, slot: 1 } }] : [];
        },
        async canvasLiveAvailable() { return state.live !== "off"; },
        async getCanvasLive(sid) {
            if (state.live === "throws") throw new Error("live read failed");
            if (sid !== P || !state.docSha) return [];
            return [{ slot: 1, seq: 2, docRev: 1, docSha: state.docSha, payload: { status: "ticked by P" }, updatedBy: P, updatedAt: "t" }];
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
    const artifactStore = {
        async downloadArtifactText(sid, filename) {
            state.docReads += 1;
            if (sid !== P || filename !== "canvas.html") throw new Error(`Artifact not found: ${filename} in session ${sid}`);
            return state.doc;
        },
    };
    const ops = (writerSessionId = S, mode = "agent") => createCanvasOperations({
        catalog, artifactStore, factStore: null, writerSessionId, workerNodeId: undefined, agentIdentity: null, mode,
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

const LIST_CHURN = {
    error: `list read ${AGENT_STEP_LIST_MAX_PAGES} store pages and the canvas data was still changing, so nothing is returned; call list again`,
};

/** h/00000, h/00001, ...: `count` person rows from `from`, as [key, by] pairs. */
const personRows = (from, count) => Array.from({ length: count }, (_, i) => [`h/${String(from + i).padStart(5, "0")}`, USER_BY]);

/**
 * Between store page reads, a person deletes the hidden h/ rows just read
 * and writes a page of new ones after them. The canvas never holds more
 * than one page of h/ person rows, well under the key quota, but a cursor
 * that only follows the rows never reaches the end.
 */
function churnHidden(world, from) {
    let next = from;
    world.state.afterList = (page, store) => {
        for (const r of page) if (r.key.startsWith("h/") && r.value.by?.kind !== "agent") store.del(r.key);
        for (const [key, by] of personRows(next, CANVAS_KV_LIST_PAGE)) store.put(key, by);
        next += CANVAS_KV_LIST_PAGE;
    };
}

test("agent step: the list page budget is the key quota's pages plus one", () => {
    assert.equal(AGENT_STEP_LIST_MAX_PAGES, Math.floor(CANVAS_KV_MAX_KEYS / CANVAS_KV_LIST_PAGE) + 2);
    assert.equal(AGENT_STEP_LIST_MAX_PAGES, 7);
});

test("agent step: a list whose hidden rows keep changing between page reads stops at the page budget with an error", async () => {
    // No agent row under h/: every page holds only new hidden rows.
    const world = kvWorld({ extra: personRows(0, CANVAS_KV_LIST_PAGE) });
    churnHidden(world, CANVAS_KV_LIST_PAGE);
    const result = await world.ops().canvasKv({ op: "list", prefix: "h/", session_id: P });
    assert.deepEqual(result, LIST_CHURN, "an explicit error: no entries and no cursor");
    assert.equal(world.state.listCalls, AGENT_STEP_LIST_MAX_PAGES, "the store is read at most the budget's pages");

    // With an agent row among them, the rows found so far are not returned
    // as a short page: that would look like the end of the data.
    const mixed = kvWorld({ extra: [...personRows(0, CANVAS_KV_LIST_PAGE), ["h/00000-a", AGENT_BY]] });
    churnHidden(mixed, CANVAS_KV_LIST_PAGE);
    for (const limit of [undefined, 2, 1]) {
        const before = mixed.state.listCalls;
        const r = await mixed.ops().canvasKv({ op: "list", prefix: "h/", ...(limit ? { limit } : {}), session_id: P });
        assert.deepEqual(r, LIST_CHURN, `limit ${limit}: no partial page and no cursor`);
        assert.equal(mixed.state.listCalls - before, AGENT_STEP_LIST_MAX_PAGES, `limit ${limit}: the budget bounds the reads`);
    }
});

test("agent step: a stable canvas at the key quota is read to its end within the budget", async () => {
    // 999 person rows then one agent row: 1000 rows under q/, the quota.
    const people = Array.from({ length: CANVAS_KV_MAX_KEYS - 1 }, (_, i) => [`q/${String(i).padStart(4, "0")}`, USER_BY]);
    const world = kvWorld({ extra: [...people, ["q/9999", AGENT_BY]] });
    const kv = world.ops().canvasKv;
    const before = world.state.listCalls;
    const result = await kv({ op: "list", prefix: "q/", session_id: P });
    assert.deepEqual(result.entries.map((e) => e.key), ["q/9999"]);
    assert.equal(result.nextAfter, undefined);
    assert.equal(result.error, undefined);
    const reads = world.state.listCalls - before;
    assert.equal(reads, CANVAS_KV_MAX_KEYS / CANVAS_KV_LIST_PAGE + 1, "five full pages and the empty sixth");
    assert.ok(reads < AGENT_STEP_LIST_MAX_PAGES, "a page of room for writes during the read");
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

const DOC_REFUSED = {
    error: "the document in canvas slot 1 does not match the last draw_canvas there, so a session in a Workflow agent step cannot read it (canvas.html may have been replaced after the draw); draw the canvas again",
};

test("read_canvas in an agent step: the document only when its bytes are the last draw's", async () => {
    const world = kvWorld();
    const read = world.ops().readCanvas;
    // The drawn document: content, card and live data, as before.
    const doc = await read({ session_id: P, includeData: true });
    assert.equal(doc.content, AGENT_DOC);
    assert.deepEqual(doc.live.data, { status: "ticked by P" });
    const card = await read({ session_id: "parent", includeData: true, manifestOnly: true });
    assert.equal(card.exists, true);
    assert.equal(card.sizeBytes, Buffer.byteLength(AGENT_DOC));
    // A person put other bytes in canvas.html after the draw: refused, in
    // every read shape and for both target forms.
    world.state.doc = PERSON_DOC;
    for (const target of [P, "parent"]) {
        for (const args of [{}, { includeData: true }, { manifestOnly: true }, { manifestOnly: true, includeData: true }]) {
            const refused = await read({ session_id: target, ...args });
            assert.deepEqual(refused, DOC_REFUSED, `${target} ${JSON.stringify(args)}`);
        }
    }
    // No record to compare with is a refusal too: no canvas_live row, or no plane.
    world.state.doc = AGENT_DOC;
    world.state.docSha = "";
    assert.deepEqual(await read({ session_id: P }), DOC_REFUSED);
    world.state.docSha = sha256(AGENT_DOC);
    world.state.live = "off";
    assert.deepEqual(await read({ session_id: P }), DOC_REFUSED);
    world.state.live = "throws";
    assert.deepEqual(await read({ session_id: P }), { error: "could not verify the canvas document: live read failed" });
    world.state.live = "on";
    assert.equal((await read({ session_id: P })).content, AGENT_DOC, "the drawn bytes read again");
});

test("read_canvas outside agent steps and in scripts is unchanged; a failed lineage read is an explicit error", async () => {
    const world = kvWorld();
    world.state.doc = PERSON_DOC;
    world.state.lineage = "outside";
    assert.equal((await world.ops().readCanvas({ session_id: P })).content, PERSON_DOC, "outside every agent step: what is stored");
    world.state.lineage = "agent-step";
    const reads = world.state.lineageReads.length;
    assert.equal((await world.ops(W, "script").readCanvas({ session_id: "parent" })).content, PERSON_DOC, "a script reads what is stored");
    assert.equal(world.state.lineageReads.length, reads, "a script reads no lineage");
    world.state.lineage = "throws";
    const docReads = world.state.docReads;
    assert.deepEqual(await world.ops().readCanvas({ session_id: P }), LINEAGE_FAILED);
    assert.deepEqual(await world.ops().readCanvas({ session_id: P, manifestOnly: true }), LINEAGE_FAILED);
    assert.equal(world.state.docReads, docReads, "the document is not read");
});
