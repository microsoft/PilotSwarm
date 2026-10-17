/**
 * Canvas app registry: CMS procedures (migration 0084, issue 181). No LLM turns.
 *
 * Personas: Alice (owner), Bob (another user), Dev (contributor on a shared
 * app), Ada (unrestricted admin: resourceAdmin=true), Cara (cluster-scoped
 * admin: resourceAdmin=false, the same as Bob for private apps).
 *
 * Run: npx vitest run test/local/canvas-app-registry-cms.test.js
 */

import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { compareSemver } from "../../src/agent-package-format.ts";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "ca-alice" };
const BOB = { provider: "test", subject: "ca-bob" };
const DEV = { provider: "test", subject: "ca-dev" };
const ADA = { provider: "test", subject: "ca-ada" };
const CARA = { provider: "test", subject: "ca-cara" };
const as = (principal, resourceAdmin = false) => ({ principal, resourceAdmin });
const V = {
    alice: as(ALICE), bob: as(BOB), dev: as(DEV), ada: as(ADA, true), cara: as(CARA, false), none: as(null),
};

async function withPg(env, fn) {
    const client = new pg.Client({ connectionString: env.store });
    await client.connect();
    try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

async function registerUsers(env) {
    await withPg(env, async (client) => {
        for (const u of [ALICE, BOB, DEV, ADA, CARA]) {
            await client.query(`SELECT "${env.cmsSchema}".cms_register_user($1, $2, $3, $4)`, [u.provider, u.subject, `${u.subject}@example.invalid`, u.subject]);
        }
    });
}

async function expectCode(promise, code) {
    try {
        await promise;
    } catch (error) {
        assertEqual(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
        return error;
    }
    throw new Error(`expected ${code}, but the call succeeded`);
}

/** reserve + commit, the way the service publishes; returns the reserve result. */
async function publish(store, viewer, name, sha, opts = {}) {
    const res = await store.reserve({
        newAppId: randomUUID(), newVersionId: randomUUID(), artifactSessionId: `space-${randomUUID()}`,
        name, scope: opts.scope ?? "user", viewer, allowOwnerless: opts.allowOwnerless ?? false,
        sha256: sha, sizeBytes: 100, version: opts.version ?? null,
        card: { name }, workspaceKey: opts.workspaceKey ?? null,
        description: opts.description ?? "Use when testing the canvas app registry procedures.",
        tags: opts.tags ?? ["test"], sourceSessionId: null, sourceSlot: null, createdBy: "test",
        mode: opts.mode ?? "publish",
    });
    if (res.status === "reserved" && !opts.leavePending) {
        const mayActivate = (opts.mode ?? "publish") === "publish" || res.appCreated || Boolean(opts.importCreated);
        await store.commit(res.versionId, mayActivate);
    }
    return res;
}

async function activeVersion(store, viewer, target) {
    const detail = await store.get(target, viewer);
    return detail.versions.find((v) => v.versionId === detail.activeVersionId)?.version ?? null;
}

describe("canvas app registry: CMS procedures", () => {
    it("SemVer precedence key orders exactly like compareSemver; build metadata is ignored", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const corpus = [
            "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11",
            "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "1.10.0", "2.0.0-0", "2.0.0-1", "2.0.0-10", "2.0.0-a",
            "2.0.0-a-b", "2.0.0-a.b", "2.0.0", "10.0.0", "1.0.0-x.7.z.92", "1.0.0-x-y-z.--", "0.0.1",
        ];
        await withPg(env, async (client) => {
            const keyOf = async (v) => (await client.query(`SELECT "${env.cmsSchema}".cms_canvas_app_precedence_key($1) AS k`, [v])).rows[0].k;
            const keys = new Map();
            for (const v of corpus) keys.set(v, await keyOf(v));
            const byKey = [...corpus].sort((a, b) => (keys.get(a) < keys.get(b) ? -1 : keys.get(a) > keys.get(b) ? 1 : 0));
            const bySemver = [...corpus].sort(compareSemver);
            assertEqual(byKey.join(" "), bySemver.join(" "), "precedence key order must equal SemVer precedence");
            assertEqual(await keyOf("1.2.3+build.1"), await keyOf("1.2.3"), "build metadata does not change precedence");
            assertEqual(await keyOf("1.2"), null, "not SemVer");
            const next = async (v) => (await client.query(`SELECT "${env.cmsSchema}".cms_canvas_app_semver_next_patch($1) AS n`, [v])).rows[0].n;
            assertEqual(await next("1.4.2"), "1.4.3");
            assertEqual(await next("2.0.0-rc.1"), "2.0.0");
            assertEqual(await next("1.4.2+build"), "1.4.3");
        });
        await catalog.close();
    });

    it("publish rules: auto version, same bytes, explicit versions, lower versions, conflicts, build metadata", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const store = catalog.canvasApps;
            const name = `ca-pub-${env.runId}`;
            const t = { name };

            const first = await publish(store, V.alice, name, "sha-1");
            assertEqual(first.status, "reserved");
            assertEqual(first.version, "1.0.0");
            assert(first.appCreated, "first publish creates the app");
            assertEqual(first.artifactFilename, `${name}@1.0.0.sha-1.html`);

            const second = await publish(store, V.alice, name, "sha-2");
            assertEqual(second.version, "1.0.1", "auto patch bump of the latest");
            assertEqual(await activeVersion(store, V.alice, t), "1.0.1");

            const same = await publish(store, V.alice, name, "sha-1");
            assertEqual(same.status, "noop");
            assertEqual(same.version, "1.0.0");
            assertEqual(await activeVersion(store, V.alice, t), "1.0.0", "publishing the same bytes re-activates that version");

            const pre = await publish(store, V.alice, name, "sha-3", { version: "2.0.0-rc.1" });
            assertEqual(pre.version, "2.0.0-rc.1");
            assertEqual(await activeVersion(store, V.alice, t), "2.0.0-rc.1", "highest precedence becomes active");

            const lower = await publish(store, V.alice, name, "sha-4", { version: "1.5.0" });
            assertEqual(lower.status, "reserved");
            assertEqual(await activeVersion(store, V.alice, t), "2.0.0-rc.1", "a lower version does not become active");

            const auto = await publish(store, V.alice, name, "sha-5");
            assertEqual(auto.version, "2.0.0", "patch bump of a prerelease is its release");

            await expectCode(publish(store, V.alice, name, "sha-6", { version: "1.5.0" }), "VERSION_EXISTS");
            await expectCode(publish(store, V.alice, name, "sha-7", { version: "1.5.0+other" }), "VERSION_EXISTS");
            const build = await publish(store, V.alice, name, "sha-8", { version: "3.0.0+build.7" });
            assertEqual(build.version, "3.0.0+build.7", "the publisher's version text is kept");
            await expectCode(publish(store, V.alice, name, "sha-9", { version: "v3" }), "BAD_VERSION");

            await store.pin(t, "1.0.0", V.alice);
            assertEqual(await activeVersion(store, V.alice, t), "1.0.0");
            await expectCode(store.pin(t, "9.9.9", V.alice), "VERSION_NOT_FOUND");
        } finally {
            await catalog.close();
        }
    });

    it("concurrent first publishes yield one app; identical bytes yield one version", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const store = catalog.canvasApps;
            const name = `ca-race-${env.runId}`;
            const results = await Promise.all(Array.from({ length: 6 }, () => publish(store, V.alice, name, "sha-race")));
            const apps = new Set(results.map((r) => r.appId));
            const versions = new Set(results.map((r) => r.versionId));
            assertEqual(apps.size, 1, "one app");
            assertEqual(versions.size, 1, "one version");
            const detail = await store.get({ name }, V.alice);
            assertEqual(detail.versions.length, 1);

            const name2 = `ca-race2-${env.runId}`;
            const diff = await Promise.all(Array.from({ length: 4 }, (_, i) => publish(store, V.alice, name2, `sha-d-${i}`)));
            assertEqual(new Set(diff.map((r) => r.appId)).size, 1, "one app for different bytes too");
            assertEqual(new Set(diff.map((r) => r.version)).size, 4, "four distinct auto versions");
        } finally {
            await catalog.close();
        }
    });

    it("pending versions are invisible and are pruned", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const store = catalog.canvasApps;
            const name = `ca-pend-${env.runId}`;
            await publish(store, V.alice, name, "sha-ready");
            const pending = await publish(store, V.alice, name, "sha-pending", { leavePending: true });
            assertEqual(pending.status, "reserved");
            const detail = await store.get({ name }, V.alice);
            assertEqual(detail.versions.length, 1, "pending row not listed");
            const again = await publish(store, V.alice, name, "sha-pending", { leavePending: true });
            assertEqual(again.status, "in-progress", "a concurrent identical publish sees the reservation");
            const pruned = await store.prunePending(new Date(Date.now() + 60_000));
            assert(pruned.some((p) => p.artifactFilename === pending.artifactFilename), "prune returns the pending file");
            await expectCode(store.commit(pending.versionId, true), "NOT_FOUND");
        } finally {
            await catalog.close();
        }
    });

    it("visibility: private apps are NOT_FOUND to Bob and Cara on every procedure, visible to Ada", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        await registerUsers(env);
        try {
            const store = catalog.canvasApps;
            const name = `ca-priv-${env.runId}`;
            await publish(store, V.alice, name, "sha-p1");
            const mine = { name };
            const alicesCopy = { name, scope: "user", owner: ALICE };
            for (const viewer of [V.bob, V.cara]) {
                for (const target of [mine, alicesCopy]) {
                    await expectCode(store.get(target, viewer), "NOT_FOUND");
                    await expectCode(store.getVersion(target, viewer), "NOT_FOUND");
                    await expectCode(store.setEnabled(target, false, viewer), "NOT_FOUND");
                    await expectCode(store.setMetadata(target, { description: "x" }, viewer), "NOT_FOUND");
                    await expectCode(store.pin(target, "1.0.0", viewer), "NOT_FOUND");
                    await expectCode(store.setScope(target, "shared", viewer), "NOT_FOUND");
                    await expectCode(store.delete(target, viewer), "NOT_FOUND");
                    await expectCode(store.listLoads(target, viewer), "NOT_FOUND");
                }
                assert(!(await store.list(viewer)).some((a) => a.name === name), "not listed");
                assert(!(await store.search(viewer, name, 20)).some((a) => a.name === name), "not found by search");
                assertEqual((await store.matchBySha("sha-p1", viewer)).length, 0, "not matched by bytes");
            }
            const adaSees = await store.get(alicesCopy, V.ada);
            assertEqual(adaSees.name, name);
            assert((await store.list(V.ada)).some((a) => a.name === name), "Ada lists it");

            // No owner: no create.
            await expectCode(publish(store, V.none, `ca-noowner-${env.runId}`, "sha-n"), "NO_OWNER");
            await expectCode(publish(store, as(null, true), `ca-noowner2-${env.runId}`, "sha-n", { scope: "shared" }), "NO_OWNER");
            const legacy = await publish(store, as(null, true), `ca-legacy-${env.runId}`, "sha-l", { scope: "shared", allowOwnerless: true });
            assertEqual(legacy.status, "reserved", "the admin-only ownerless path is the legacy migration");
        } finally {
            await catalog.close();
        }
    });

    it("shadowing, names, scope changes and contributors", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        await registerUsers(env);
        try {
            const store = catalog.canvasApps;
            const name = `ca-share-${env.runId}`;
            await publish(store, V.alice, name, "sha-s1", { scope: "shared" });
            await publish(store, V.bob, name, "sha-b1", { scope: "user" });

            const bobSees = await store.getVersion({ name }, V.bob);
            assertEqual(bobSees.sha256, "sha-b1", "Bob's private copy hides the shared one for Bob");
            const aliceSees = await store.getVersion({ name }, V.alice);
            assertEqual(aliceSees.sha256, "sha-s1", "Alice still gets the shared one");
            const bobList = await store.list(V.bob);
            assert(bobList.find((a) => a.name === name && a.scope === "shared")?.shadowed, "shared copy is marked shadowed for Bob");

            await expectCode(publish(store, V.bob, name, "sha-b2", { scope: "shared" }), "NAME_TAKEN");
            await expectCode(store.setScope({ name, scope: "user" }, "shared", V.bob), "NAME_TAKEN");
            await expectCode(store.setEnabled({ name, scope: "shared" }, false, V.bob), "FORBIDDEN");
            await expectCode(store.delete({ name, scope: "shared" }, V.bob), "FORBIDDEN");

            await expectCode(store.grantEditor(name, DEV, V.bob), "FORBIDDEN");
            await store.grantEditor(name, DEV, V.alice);
            assertEqual((await store.listEditors(name, V.bob)).map((e) => e.subject).join(","), DEV.subject);
            const devPublish = await publish(store, V.dev, name, "sha-dev", { scope: "shared" });
            assertEqual(devPublish.status, "reserved", "a contributor may publish a version");
            await store.setEnabled({ name, scope: "shared" }, false, V.dev);
            await store.setEnabled({ name, scope: "shared" }, true, V.dev);
            await store.setMetadata({ name, scope: "shared" }, { description: "Use when a contributor edits the description." }, V.dev);
            await store.pin({ name, scope: "shared" }, "1.0.0", V.dev);
            await expectCode(store.setScope({ name, scope: "shared" }, "user", V.dev), "FORBIDDEN");
            await expectCode(store.delete({ name, scope: "shared" }, V.dev), "FORBIDDEN");
            await expectCode(store.grantEditor(name, BOB, V.dev), "FORBIDDEN");
            await expectCode(store.listLoads({ name, scope: "shared" }, V.dev), "FORBIDDEN");

            // Disabled: hidden from Bob's list and search, draw refused; still there for Dev.
            await store.setEnabled({ name, scope: "shared" }, false, V.alice);
            assert(!(await store.search(V.cara, name, 20)).some((a) => a.name === name), "disabled app not found by others");
            await expectCode(store.getVersion({ name, scope: "shared" }, V.cara), "APP_DISABLED");
            assert((await store.list(V.dev)).some((a) => a.name === name && a.scope === "shared"), "contributor still lists it");
            await store.setEnabled({ name, scope: "shared" }, true, V.alice);

            // Making it private revokes contributors.
            await store.setScope({ name, scope: "shared" }, "user", V.alice);
            await expectCode(store.listEditors(name, V.alice), "NOT_FOUND");
            await store.setScope({ name, scope: "user" }, "shared", V.alice);
            assertEqual((await store.listEditors(name, V.alice)).length, 0, "contributors do not come back");
        } finally {
            await catalog.close();
        }
    });

    it("import mode never re-activates and never moves an existing app's active version", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const store = catalog.canvasApps;
            const name = `ca-imp-${env.runId}`;
            const t = { name };
            await publish(store, V.alice, name, "sha-3", { version: "3.0.0" });
            const imp1 = await publish(store, V.alice, name, "sha-1", { version: "1.0.0", mode: "import" });
            assertEqual(imp1.status, "reserved");
            assertEqual(await activeVersion(store, V.alice, t), "3.0.0");
            const imp2 = await publish(store, V.alice, name, "sha-1", { version: "1.0.0", mode: "import" });
            assertEqual(imp2.status, "noop");
            assertEqual(await activeVersion(store, V.alice, t), "3.0.0", "a repeat import changes nothing");
            const imp4 = await publish(store, V.alice, name, "sha-4", { version: "4.0.0", mode: "import" });
            assertEqual(imp4.status, "reserved");
            assertEqual(await activeVersion(store, V.alice, t), "3.0.0", "import never moves an existing app's pointer");

            const fresh = `ca-imp-new-${env.runId}`;
            const a = await publish(store, V.alice, fresh, "sha-a", { version: "1.0.0", mode: "import" });
            await publish(store, V.alice, fresh, "sha-b", { version: "2.0.0", mode: "import", importCreated: a.appCreated });
            assertEqual(await activeVersion(store, V.alice, { name: fresh }), "2.0.0", "a new app gets its highest imported version");
        } finally {
            await catalog.close();
        }
    });

    it("loads: owner and admin only, cursor with equal timestamps, total over pages, retention, cascade", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const store = catalog.canvasApps;
            const name = `ca-load-${env.runId}`;
            const res = await publish(store, V.alice, name, "sha-l1", { scope: "shared" });
            for (let i = 0; i < 7; i++) {
                await store.recordLoad({ appId: res.appId, versionId: res.versionId, sessionId: `s-${i}`, user: i % 2 ? BOB : ALICE });
            }
            await withPg(env, async (client) => {
                await client.query(`UPDATE "${env.cmsSchema}".canvas_app_loads SET loaded_at = '2026-01-01T00:00:00Z' WHERE app_id = $1 AND session_id IN ('s-0','s-1','s-2')`, [res.appId]);
                await client.query(`UPDATE "${env.cmsSchema}".canvas_app_loads SET loaded_at = now() - INTERVAL '2 seconds' WHERE app_id = $1 AND session_id IN ('s-3','s-4','s-5','s-6')`, [res.appId]);
            });
            const seen = [];
            let cursor = null;
            let total = null;
            do {
                const page = await store.listLoads({ name, scope: "shared" }, V.alice, { limit: 2, cursor });
                total = page.total30d;
                seen.push(...page.rows.map((r) => r.sessionId));
                cursor = page.nextCursor;
            } while (cursor);
            assertEqual(new Set(seen).size, 7, "every row exactly once across pages");
            assertEqual(seen.length, 7);
            assertEqual(total, 4, "30-day total counts only the recent rows, independent of page size");
            await expectCode(store.listLoads({ name, scope: "shared" }, V.bob), "FORBIDDEN");
            assertEqual((await store.listLoads({ name, scope: "shared" }, V.ada)).rows.length, 7);

            await withPg(env, async (client) => {
                await client.query(`UPDATE "${env.cmsSchema}".canvas_app_loads SET loaded_at = now() - INTERVAL '401 days' WHERE app_id = $1 AND session_id IN ('s-0','s-1','s-2')`, [res.appId]);
            });
            assertEqual((await store.listLoads({ name, scope: "shared" }, V.alice)).rows.length, 4, "expired rows are never returned");
            let pruned = 0;
            for (let n = await store.pruneLoads(new Date(), 2); n > 0; n = await store.pruneLoads(new Date(), 2)) pruned += n;
            assertEqual(pruned, 3, "prune drains expired rows in batches");

            await store.delete({ name, scope: "shared" }, V.alice);
            const leftover = await withPg(env, (client) => client.query(`SELECT count(*)::int AS n FROM "${env.cmsSchema}".canvas_app_loads WHERE app_id = $1`, [res.appId]));
            assertEqual(leftover.rows[0].n, 0, "deleting the app deletes its loads");
            const tombs = await store.listTombstones(100);
            assert(tombs.some((t) => t.appId === res.appId), "delete leaves a tombstone");
            await store.markPurged(res.appId);
            assert(!(await store.listTombstones(100)).some((t) => t.appId === res.appId), "purged tombstone is not listed");
        } finally {
            await catalog.close();
        }
    });

    it("consent rows and session taint", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const store = catalog.canvasApps;
            const sessionId = randomUUID();
            await catalog.createSession(sessionId, {});
            assertEqual(await store.crossOwnerSeen(sessionId), false);
            await store.markCrossOwnerSeen(sessionId);
            assertEqual(await store.crossOwnerSeen(sessionId), true);

            assertEqual(await store.getConsent(sessionId, 1, 3, "sha-page"), null);
            await store.setConsent({ sessionId, slot: 1, rev: 3, pageSha256: "sha-page", decision: "granted", by: ALICE });
            assertEqual(await store.getConsent(sessionId, 1, 3, "sha-page"), "granted");
            assertEqual(await store.getConsent(sessionId, 1, 4, "sha-page"), null, "a new rev asks again");
            assertEqual(await store.getConsent(sessionId, 1, 3, "sha-other"), null, "other bytes ask again");
            await store.setConsent({ sessionId, slot: 1, rev: 3, pageSha256: "sha-page", decision: "denied", by: ALICE });
            assertEqual(await store.getConsent(sessionId, 1, 3, "sha-page"), "denied");
        } finally {
            await catalog.close();
        }
    });

    it("workspace-block match is foreign-only and attribution-free", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const store = catalog.canvasApps;
            await publish(store, V.bob, `ca-ws-bob-${env.runId}`, "sha-wb", { scope: "shared", workspaceKey: `wk-${env.runId}` });
            assertEqual(await store.foreignWorkspaceMatch(`wk-${env.runId}`, V.alice), true, "Bob's shared block is foreign to Alice");
            assertEqual(await store.foreignWorkspaceMatch(`wk-${env.runId}`, V.bob), false, "not foreign to its owner");
            await publish(store, V.alice, `ca-ws-alice-${env.runId}`, "sha-wa", { scope: "shared", workspaceKey: `wk-${env.runId}` });
            assertEqual(await store.foreignWorkspaceMatch(`wk-${env.runId}`, V.alice), true, "still foreign even when Alice owns one with the same block");
            const matches = await store.matchBySha("sha-wb", V.alice);
            assertEqual(matches.length, 1);
            assertEqual(matches[0].owner?.subject, BOB.subject);
        } finally {
            await catalog.close();
        }
    });
});
