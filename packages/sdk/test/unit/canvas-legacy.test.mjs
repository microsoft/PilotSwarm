// The canvas app transition (issue 181): the one switch, and the old catalog
// judged against the registry's install time (minus a safety margin).
//
// Run: node --test test/unit/canvas-legacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    canvasLegacyModeFromEnv, CANVAS_LEGACY_MODE_ENV, CANVAS_LEGACY_CUTOFF_MARGIN_MS,
    CanvasLegacyCatalog, canvasLegacyCatalogFor, canvasLegacyCardFromFact, mergeLegacyCanvasAppHits, canvasRevisionIsLegacy,
    canvasPageLabel, canvasPageLabelFor,
} from "../../dist/canvas-legacy.js";
import { mintedCanvasRevStrict } from "../../dist/canvas-support.js";
import { CanvasAppError, canvasRegistryPresence } from "../../dist/canvas-app-store.js";
import * as sdk from "../../dist/index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const INSTALLED = new Date("2026-10-20T08:00:00Z");
const MIN = 60_000;
const at = (offsetMs) => new Date(INSTALLED.getTime() + offsetMs);
const BEFORE = new Date("2026-09-18T12:22:36Z");
const AFTER = new Date("2026-10-21T08:00:00Z");

const card = (name, sha, updatedAt, extra = {}) => ({
    key: `apps/${name}`, shared: true, deletedAt: null, updatedAt,
    value: { name, description: `Use when ${name}.`, tags: ["t"], kv: { write: "owner" }, source: { sessionId: "s-src", filename: `app-${name}.html`, sha256: sha }, ...extra },
});

/**
 * A facts store that behaves like both providers' read procedure: a LIKE
 * prefix or exact scope keys, newest updated_at first, at most 1,000 rows.
 */
function fakeFacts(rows) {
    const calls = [];
    return {
        calls, rows,
        async readFacts(query) {
            calls.push(query);
            let out = this.rows.filter((r) => r.shared !== false && !r.deletedAt);
            if (query.scopeKeys) out = out.filter((r) => query.scopeKeys.includes(`shared:${r.key}`));
            if (query.keyPattern) {
                assert.ok(query.keyPattern.endsWith("*") && !/[%_*]/.test(query.keyPattern.slice(0, -1).replace(/-/g, "")), `a literal prefix: ${query.keyPattern}`);
                const prefix = query.keyPattern.slice(0, -1);
                out = out.filter((r) => r.key.startsWith(prefix));
            }
            out = [...out].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.min(query.limit ?? 50, 1000));
            return { count: out.length, facts: out };
        },
    };
}

const catalogOf = (facts, opts = {}) => new CanvasLegacyCatalog({ factStore: facts, installedAt: async () => INSTALLED, ...opts });

test("the switch: unset or on/true/1/yes is on; off, false, 0, no or a typo is off (the stricter rules)", () => {
    assert.equal(CANVAS_LEGACY_MODE_ENV, "PILOTSWARM_CANVAS_LEGACY_MODE");
    assert.equal(canvasLegacyModeFromEnv({}), true);
    for (const v of ["", "on", "ON", " true ", "1", "yes"]) assert.equal(canvasLegacyModeFromEnv({ PILOTSWARM_CANVAS_LEGACY_MODE: v }), true, v);
    for (const v of ["off", "OFF", "false", "0", "no", "of", "disabled"]) assert.equal(canvasLegacyModeFromEnv({ PILOTSWARM_CANVAS_LEGACY_MODE: v }), false, v);
});

test("the SDK exports the switch and the catalog for Issue 184", () => {
    assert.equal(sdk.canvasLegacyModeFromEnv, canvasLegacyModeFromEnv);
    assert.equal(sdk.CANVAS_LEGACY_MODE_ENV, CANVAS_LEGACY_MODE_ENV);
    assert.equal(sdk.CANVAS_APP_REGISTRY_MIGRATION_VERSION, "0084");
    assert.equal(sdk.CANVAS_LEGACY_CUTOFF_MARGIN_MS, 5 * MIN);
    assert.equal(typeof sdk.CanvasLegacyCatalog, "function");
    assert.equal(typeof sdk.canvasLegacyCatalogFor, "function");
});

test("the cutoff is the registry's install minus 5 minutes: 4 minutes before is not exempt, 6 minutes before is (clock skew, precision)", async () => {
    assert.equal(CANVAS_LEGACY_CUTOFF_MARGIN_MS, 5 * MIN);
    const facts = fakeFacts([
        card("six-before", "6".repeat(64), at(-6 * MIN)),
        card("five-before", "5".repeat(64), at(-5 * MIN)),
        card("four-before", "4".repeat(64), at(-4 * MIN)),
        card("at-install", "0".repeat(64), INSTALLED),
        card("one-ms-after-cutoff", "1".repeat(64), new Date(at(-5 * MIN).getTime() + 1)),
    ]);
    const catalog = catalogOf(facts);
    assert.equal(await catalog.isExemptSha256("6".repeat(64)), true, "6 minutes before: exempt");
    assert.equal(await catalog.isExemptSha256("5".repeat(64)), true, "exactly at the cutoff: exempt");
    assert.equal(await catalog.isExemptSha256("4".repeat(64)), false, "4 minutes before: not exempt");
    assert.equal(await catalog.isExemptSha256("0".repeat(64)), false, "at the install: not exempt");
    assert.equal(await catalog.isExemptSha256("1".repeat(64)), false, "1 ms past the cutoff: not exempt");
});

test("only app cards with a valid source exempt; a card written after the deploy is found but exempts nothing", async () => {
    const facts = fakeFacts([
        card("old", SHA_A, BEFORE),
        card("new", SHA_B, AFTER),
        { key: "apps/r2d-blocker-board/publication", shared: true, deletedAt: null, updatedAt: BEFORE, value: { appName: "r2d-blocker-board", source: { sessionId: "s", filename: "f", sha256: "c".repeat(64) } } },
        card("Bad_Name", "d".repeat(64), BEFORE),
        card("bad-sha", "not-a-sha", BEFORE),
        { key: "apps/text", shared: true, deletedAt: null, updatedAt: BEFORE, value: JSON.stringify({ name: "text", source: { sessionId: "s", filename: "f", sha256: "e".repeat(64) } }) },
    ]);
    const catalog = catalogOf(facts);
    assert.equal(await catalog.isExemptSha256(SHA_A), true);
    assert.equal(await catalog.isExemptSha256(SHA_A.toUpperCase()), true, "hex case does not matter");
    assert.equal(await catalog.isExemptSha256(SHA_B), false, "written after the deploy");
    assert.equal(await catalog.isExemptSha256("c".repeat(64)), false, "a publication record is not an app card");
    assert.equal(await catalog.isExemptSha256("d".repeat(64)), false, "not a valid app name");
    assert.equal(await catalog.isExemptSha256("e".repeat(64)), true, "a JSON-string value");
    assert.equal(await catalog.isExemptSha256("nope"), false);
    assert.equal(await catalog.isComplete(), true);
    // Found by its exact key, exempt or not.
    assert.equal((await catalog.get("new")).value.name, "new");
    assert.equal((await catalog.get("new")).exempt, false);
    assert.equal((await catalog.get("OLD")).exempt, true);
    assert.equal(await catalog.get("missing"), null);
    assert.equal(await catalog.get("r2d-blocker-board/publication"), null, "not an app name");
});

test("1,500 newer apps/* facts cannot push an old card out of the set or of find-by-name (review F4)", async () => {
    const rows = [card("zz-old", SHA_A, BEFORE), card("a", "f".repeat(64), BEFORE)];
    for (let i = 0; i < 1200; i++) rows.push(card(`a${i}`, SHA_B, new Date(AFTER.getTime() + i)));
    for (let i = 0; i < 300; i++) rows.push({ key: `apps/zz-old/note-${i}`, shared: true, deletedAt: null, updatedAt: new Date(AFTER.getTime() + i), value: { note: i } });
    const facts = fakeFacts(rows);
    const catalog = catalogOf(facts);
    assert.equal(await catalog.isExemptSha256(SHA_A), true, "the old card is still in the set");
    assert.equal(await catalog.isExemptSha256("f".repeat(64)), true, "a name that is also a full prefix is read exactly");
    assert.equal(await catalog.isComplete(), true);
    assert.equal((await catalog.get("zz-old")).exempt, true, "find-by-name reads the exact key");
    assert.ok(facts.calls.every((q) => !q.limit || q.limit <= 1000), "every read stays within the providers' page");
});

test("an enumeration that needs more than its read budget is incomplete and exempts only what it found (fails closed)", async () => {
    const rows = [];
    for (let i = 0; i < 1100; i++) rows.push(card(`a${i}`, SHA_B, new Date(AFTER.getTime() + i)));
    rows.push(card("zz-old", SHA_A, BEFORE));
    const catalog = catalogOf(fakeFacts(rows), { maxReads: 2 });
    assert.equal(await catalog.isComplete(), false);
    assert.equal(await catalog.isExemptSha256(SHA_A), false, "not found within the budget: not exempt");
});

test("a full 1,000-row page splits on the next name character; at the read cap the snapshot is incomplete and exempts only what it found", async () => {
    // 1,040 newer cards spread over the 26 letters fill the first page; the two
    // old cards are the oldest rows, so the first read cannot return them.
    const rows = [card("b-old", SHA_A, BEFORE), card("z-old", "9".repeat(64), BEFORE)];
    for (let i = 0; i < 1040; i++) rows.push(card(`${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${i}`, SHA_B, new Date(AFTER.getTime() + i)));
    // No cap reached: the root page is full, so all 37 name characters are read.
    const all = fakeFacts(rows);
    const complete = catalogOf(all);
    assert.equal(await complete.isComplete(), true);
    assert.equal(await complete.isExemptSha256(SHA_A), true);
    assert.equal(await complete.isExemptSha256("9".repeat(64)), true);
    assert.equal(all.calls.length, 1 + 37, "the full root page, then one read per name character");
    assert.equal(all.calls[0].keyPattern, "apps/*");
    assert.equal((await all.readFacts({ keyPattern: "apps/*", limit: 1000 })).facts.length, 1000, "the root page really is full");
    // Cap reached after "apps/*", "apps/a*", "apps/b*", "apps/c*": "b-old" was found, "z-old" was not.
    const capped = fakeFacts(rows);
    const partial = catalogOf(capped, { maxReads: 4 });
    assert.equal(await partial.isComplete(), false, "incomplete");
    assert.deepEqual(capped.calls.map((q) => q.keyPattern), ["apps/*", "apps/a*", "apps/b*", "apps/c*"]);
    assert.equal(await partial.isExemptSha256(SHA_A), true, "what it found still exempts");
    assert.equal(await partial.isExemptSha256("9".repeat(64)), false, "what it did not reach does not");
});

test("a longest-possible (64-character) app name under a full prefix chain is still read exactly (review R1)", async () => {
    const long = "a".repeat(64);
    const rows = [card(long, SHA_A, BEFORE)];
    for (let i = 0; i < 1000; i++) rows.push({ key: `apps/${long}/note-${i}`, shared: true, deletedAt: null, updatedAt: new Date(AFTER.getTime() + i), value: { note: i } });
    // Default budget: the "a"-branch is walked to depth 64 and the exact key is read there.
    const facts = fakeFacts(rows);
    const catalog = catalogOf(facts);
    assert.equal(await catalog.isExemptSha256(SHA_A), true, "recovered under the default budget");
    assert.ok(facts.calls.some((q) => q.scopeKeys?.[0] === `shared:apps/${long}`), "the 64-character key was read exactly");
    // A larger budget finishes the whole walk; the card is in the complete set.
    const big = catalogOf(fakeFacts(rows), { maxReads: 2500 });
    assert.equal(await big.isComplete(), true);
    assert.equal(await big.isExemptSha256(SHA_A), true, "a complete walk includes it");
    assert.equal((await big.get(long)).exempt, true, "and find-by-name agrees");
});

test("find_canvas_app's merge: registry first, then old hits marked legacy while the registry answers absent", async () => {
    const registryHits = [{ name: "both", scope: "user", description: "d" }];
    const legacyHits = [
        { key: "apps/old", name: "old", description: "o", source: { sessionId: "s", filename: "f", sha256: SHA_A } },
        { key: "apps/both", name: "both", description: "b" },
        { key: "apps/disabled", name: "disabled", description: "x" },
        { key: "apps/refused", name: "refused", description: "x" },
        { key: "apps/hidden", name: "hidden", description: "x" },
    ];
    const answers = { old: "absent", disabled: "present", refused: "present", hidden: "absent" };
    const probed = [];
    const out = await mergeLegacyCanvasAppHits({
        registryHits, legacy: { apps: legacyHits }, limit: 20,
        probe: async (name) => { probed.push(name); return answers[name]; },
    });
    assert.deepEqual(out.apps.map((a) => [a.name, a.legacy === true]), [["both", false], ["old", true], ["hidden", true]]);
    assert.equal(out.apps[1].key, "apps/old", "main's shape kept");
    assert.equal(out.apps[1].source.sha256, SHA_A);
    assert.equal(out.legacyCount, 2);
    assert.equal(out.legacyError, null);
    assert.deepEqual(probed, ["old", "disabled", "refused", "hidden"], "a name already listed is not probed");
    // The limit counts registry hits too.
    const capped = await mergeLegacyCanvasAppHits({ registryHits, legacy: { apps: legacyHits }, limit: 2, probe: async () => "absent" });
    assert.deepEqual(capped.apps.map((a) => a.name), ["both", "old"]);
    // A failed old-catalog search is reported next to the registry hits.
    const failed = await mergeLegacyCanvasAppHits({ registryHits, legacy: { error: "facts down" }, limit: 20, probe: async () => "absent" });
    assert.deepEqual(failed.apps.map((a) => a.name), ["both"]);
    assert.equal(failed.legacyError, "facts down");
    // A probe failure fails the merge (the search's error).
    await assert.rejects(mergeLegacyCanvasAppHits({ registryHits: [], legacy: { apps: legacyHits }, limit: 20, probe: async () => { throw new Error("registry down"); } }), /registry down/);
    // No registry on this worker: every old hit stays.
    const noRegistry = await mergeLegacyCanvasAppHits({ registryHits: [], legacy: { apps: legacyHits.slice(0, 2) }, limit: 20, probe: null });
    assert.deepEqual(noRegistry.apps.map((a) => a.name), ["old", "both"]);
});

test("the registry's answer for a same-name app: found, disabled or refused is present; NOT_FOUND is absent; anything else fails (review F3/R2)", async () => {
    assert.equal(await canvasRegistryPresence(async () => ({ name: "x" })), "present");
    assert.equal(await canvasRegistryPresence(async () => { throw new CanvasAppError("APP_DISABLED", "disabled"); }), "present");
    assert.equal(await canvasRegistryPresence(async () => { throw new CanvasAppError("FORBIDDEN", "no"); }), "present");
    assert.equal(await canvasRegistryPresence(async () => { throw new CanvasAppError("NOT_FOUND", "no such app (or a private one you cannot see)"); }), "absent");
    await assert.rejects(canvasRegistryPresence(async () => { throw new CanvasAppError("NAME_TAKEN", "x"); }), (e) => e.code === "NAME_TAKEN");
    await assert.rejects(canvasRegistryPresence(async () => { throw new Error("connection reset"); }), /connection reset/);
    assert.equal(sdk.canvasRegistryPresence, canvasRegistryPresence);
    assert.equal(sdk.mergeLegacyCanvasAppHits, mergeLegacyCanvasAppHits);
});

test("an old card overwritten after the deploy stops exempting once the TTL passes", async () => {
    const facts = fakeFacts([card("board", SHA_A, BEFORE)]);
    let now = 0;
    const catalog = catalogOf(facts, { ttlMs: 60_000, now: () => now });
    assert.equal(await catalog.isExemptSha256(SHA_A), true);
    const reads = facts.calls.length;
    facts.rows = [card("board", SHA_B, AFTER)];
    now = 59_999;
    assert.equal(await catalog.isExemptSha256(SHA_A), true, "within the TTL the earlier enumeration is reused");
    assert.equal(facts.calls.length, reads);
    now = 60_000;
    assert.equal(await catalog.isExemptSha256(SHA_A), false, "after the TTL the overwritten card no longer exempts");
    assert.equal(await catalog.isExemptSha256(SHA_B), false, "and the new source was written after the deploy");
});

test("a failed refresh after the TTL exempts nothing, even what the expired snapshot held (review F2)", async () => {
    const facts = fakeFacts([card("old", SHA_A, BEFORE)]);
    let now = 0;
    const catalog = catalogOf(facts, { ttlMs: 10, now: () => now });
    assert.equal(await catalog.isExemptSha256(SHA_A), true);
    const good = facts.readFacts;
    facts.readFacts = async () => { throw new Error("read failed"); };
    now = 5;
    assert.equal(await catalog.isExemptSha256(SHA_A), true, "within the TTL");
    now = 10;
    assert.equal(await catalog.isExemptSha256(SHA_A), false, "expired and the refresh failed: nothing");
    now = 11;
    assert.equal(await catalog.isExemptSha256(SHA_A), false, "still failing: still nothing");
    facts.readFacts = good;
    now = 12;
    assert.equal(await catalog.isExemptSha256(SHA_A), true, "a good refresh restores it");
});

test("no install time (registry missing or unreadable) exempts nothing; it is asked again until known, then kept", async () => {
    const facts = fakeFacts([card("old", SHA_A, BEFORE)]);
    let asks = 0;
    let installed = null;
    let now = 0;
    const catalog = new CanvasLegacyCatalog({ factStore: facts, installedAt: async () => { asks++; return installed; }, ttlMs: 10, now: () => now });
    assert.equal(await catalog.isExemptSha256(SHA_A), false);
    installed = INSTALLED;
    now = 10;
    assert.equal(await catalog.isExemptSha256(SHA_A), true);
    now = 20;
    await catalog.isExemptSha256(SHA_A);
    assert.equal(asks, 2, "known once, never asked again");
    const failing = new CanvasLegacyCatalog({ factStore: facts, installedAt: async () => { throw new Error("db down"); } });
    assert.equal(await failing.isExemptSha256(SHA_A), false);
    assert.equal((await failing.get("old")).exempt, false, "found, but not exempt");
    const none = new CanvasLegacyCatalog({ factStore: null, installedAt: async () => INSTALLED });
    assert.equal(await none.isExemptSha256(SHA_A), false);
    assert.equal(await none.get("old"), null);
});

test("one cached catalog per fact store; none without one", () => {
    const store = fakeFacts([]);
    const a = canvasLegacyCatalogFor(store, async () => INSTALLED);
    assert.equal(canvasLegacyCatalogFor(store, async () => null), a);
    assert.notEqual(canvasLegacyCatalogFor(fakeFacts([]), async () => INSTALLED), a);
    assert.equal(canvasLegacyCatalogFor(null, async () => INSTALLED), null);
});

test("cards outside apps/ or with an unreadable value are ignored", () => {
    assert.equal(canvasLegacyCardFromFact({ key: "notes/x", value: {}, updatedAt: BEFORE }, INSTALLED), null);
    assert.equal(canvasLegacyCardFromFact({ key: "apps/x", value: "not json", updatedAt: BEFORE }, INSTALLED), null);
    assert.equal(canvasLegacyCardFromFact({ key: "apps/x", value: [1], updatedAt: BEFORE }, INSTALLED), null);
    assert.equal(canvasLegacyCardFromFact({ key: "apps/x", value: { source: { sessionId: "s", filename: "f", sha256: SHA_A } }, updatedAt: null }, INSTALLED).exempt, false, "no timestamp: no exemption");
    assert.equal(canvasLegacyCardFromFact({ key: "apps/x", value: { source: { sessionId: "s", filename: "f", sha256: SHA_A } }, updatedAt: BEFORE }, null).exempt, false, "no install time: no exemption");
});

test("canvasRevisionIsLegacy: (a) an old app's page while its card qualifies now; (b) a revision drawn before the registry; never with the switch off", async () => {
    const page = SHA_A;
    let inSet = true;
    const catalog = { isExemptSha256: async (sha) => inSet && sha === SHA_A };
    const judge = (over) => canvasRevisionIsLegacy({ mode: true, catalog, eventRev: 7, mintedRev: 7, pageSha256: page, data: {}, ...over });
    // (b) drawn before the registry: no trust recorded.
    assert.equal(await judge({ data: {} }), true);
    assert.equal(await judge({ data: { pageSha256: SHA_A } }), true, "bytes equal to the recorded ones");
    assert.equal(await judge({ data: { pageSha256: SHA_B } }), false, "other bytes than the event recorded");
    assert.equal(await judge({ mintedRev: 8 }), false, "a redraw is in flight");
    assert.equal(await judge({ data: { trust: "something-else" } }), false, "an unknown trust is not 'no trust'");
    // (a) an old app's page.
    const a = { trust: "cross-owner", legacy: true, pageSha256: SHA_A };
    assert.equal(await judge({ data: a }), true);
    assert.equal(await judge({ data: a, mintedRev: 8 }), true, "bound by the page hash, not the minted revision");
    assert.equal(await judge({ data: { ...a, pageSha256: undefined } }), false, "no recorded page hash");
    assert.equal(await judge({ data: { ...a, legacy: undefined } }), false, "no flag: a new-format page");
    assert.equal(await judge({ data: a, catalog: null }), false, "no old catalog here");
    inSet = false;
    assert.equal(await judge({ data: a }), false, "the card changed since the draw: re-checked now");
    inSet = true;
    assert.equal(await judge({ data: a, catalog: { isExemptSha256: async () => { throw new Error("down"); } } }), false, "a failed read exempts nothing");
    // The switch off, or no revision, or a malformed hash: never.
    assert.equal(await judge({ mode: false }), false);
    assert.equal(await judge({ mode: false, data: a }), false, "a recorded flag is ignored when off");
    assert.equal(await judge({ eventRev: 0 }), false);
    assert.equal(await judge({ mintedRev: null }), false, "a minted revision that could not be read (review L2-F2)");
    assert.equal(await judge({ pageSha256: "nope" }), false);
    assert.equal(sdk.canvasRevisionIsLegacy, canvasRevisionIsLegacy);
});

test("mintedCanvasRevStrict: the table row; a known-absent row is the event's revision; a failed read is null (review L2-F2)", async () => {
    assert.equal(await mintedCanvasRevStrict({ getSessionCanvases: async () => [{ slot: 1, latestRev: 8 }] }, "s", 1, 7), 8, "a redraw is minted");
    assert.equal(await mintedCanvasRevStrict({ getSessionCanvases: async () => [{ slot: 2, latestRev: 8 }] }, "s", 1, 7), 7, "no row for this slot: drawn before the table");
    assert.equal(await mintedCanvasRevStrict({ getSessionCanvases: async () => { throw new Error("db down"); } }, "s", 1, 7), null, "a failed read never falls back to the event");
    assert.equal(await mintedCanvasRevStrict({}, "s", 1, 7), null, "no table on this catalog");
    assert.equal(await mintedCanvasRevStrict(null, "s", 1, 7), null);
});

test("canvasPageLabelFor: only owner, agent or a verified legacy decision go unlabelled (review L2-F4)", () => {
    assert.deepEqual(canvasPageLabelFor({ found: false }), { trust: "unknown" });
    assert.equal(canvasPageLabelFor({ found: true, trust: "owner" }), null);
    assert.equal(canvasPageLabelFor({ found: true, trust: "agent" }), null);
    assert.deepEqual(canvasPageLabelFor({ found: true, trust: "cross-owner", app: "bobs" }), { trust: "cross-owner", app: "bobs" });
    assert.deepEqual(canvasPageLabelFor({ found: true, trust: "cross-owner" }), { trust: "cross-owner" });
    assert.equal(canvasPageLabelFor({ found: true, trust: "cross-owner", legacy: true }), null);
    assert.deepEqual(canvasPageLabelFor({ found: true }), { trust: "unknown" }, "no trust recorded");
    assert.deepEqual(canvasPageLabelFor({ found: true, trust: "mystery" }), { trust: "unknown" });
    assert.equal(canvasPageLabelFor({ found: true, legacy: true }), null);
});

test("canvasPageLabel: every read bound to one draw event; any failure is labelled, never exempted (review L2-F3/F4)", async () => {
    const catalog = { isExemptSha256: async (sha) => sha === SHA_A };
    const run = (over) => canvasPageLabel({
        mode: true, catalog,
        readLatest: async () => ({ rev: 4, data: { trust: "cross-owner", legacy: true, pageSha256: SHA_A, app: { name: "old-board" } } }),
        readPageSha256: async () => SHA_A,
        readMintedRev: async () => 4,
        ...over,
    });
    assert.equal(await run({}), null, "an old app's page, the bytes stored are the ones recorded and in the set");
    assert.deepEqual(await run({ readPageSha256: async () => SHA_B }), { trust: "cross-owner", app: "old-board" },
        "upload-before-event: the stored page is already another page; the event's flag does not exempt it");
    assert.deepEqual(await run({ readPageSha256: async () => { throw new Error("blob down"); } }), { trust: "cross-owner", app: "old-board" }, "page unreadable");
    assert.deepEqual(await run({ mode: false }), { trust: "cross-owner", app: "old-board" }, "switch off");
    assert.deepEqual(await run({ readLatest: async () => { throw new Error("db down"); } }), { trust: "unknown" }, "event read failed");
    assert.deepEqual(await run({ readLatest: async () => ({ rev: 0 }) }), { trust: "unknown" }, "no draw event found");
    assert.deepEqual(await run({ readLatest: async () => ({ rev: 4, data: { trust: "mystery" } }) }), { trust: "unknown" });
    // (b) drawn before the registry.
    const pre = { readLatest: async () => ({ rev: 4, data: {} }) };
    assert.equal(await run(pre), null, "no trust, no redraw in flight, switch on: as on main");
    assert.deepEqual(await run({ ...pre, readMintedRev: async () => 5 }), { trust: "unknown" }, "a redraw is in flight");
    assert.deepEqual(await run({ ...pre, readMintedRev: async () => null }), { trust: "unknown" }, "the minted revision cannot be read");
    assert.deepEqual(await run({ ...pre, mode: false }), { trust: "unknown" }, "switch off: labelled unknown");
    // Owner and agent pages need no further reads.
    let reads = 0;
    const counted = { readPageSha256: async () => { reads++; return SHA_A; }, readMintedRev: async () => { reads++; return 4; } };
    assert.equal(await run({ ...counted, readLatest: async () => ({ rev: 4, data: { trust: "owner" } }) }), null);
    assert.equal(reads, 0);
    assert.equal(sdk.canvasPageLabel, canvasPageLabel);
    assert.equal(sdk.canvasPageLabelFor, canvasPageLabelFor);
});
