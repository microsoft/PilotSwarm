/**
 * Compute targets — the schema and stored procedures of migration 0084
 * (docs/proposals/compute-providers.md), and the create-time session check.
 *
 * Like provider-budgets.test.js, the file migrates one schema and truncates
 * between tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { runCmsMigrations } from "../../src/cms-migrator.ts";
import { ComputeTargetStore, ComputeTargetError } from "../../src/compute-target-store.ts";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const SCHEMA = `ps_test_cms_computetargets_${randomBytes(4).toString("hex")}`;

let pool;
let store;

async function sql(text, params = []) {
    const q = text.replace(/(^|[^\w"'])@([a-z_])/g, `$1"${SCHEMA}".$2`);
    return (await pool.query(q, params)).rows;
}

async function makeUser(subject) {
    const rows = await sql(
        `INSERT INTO @users (provider, subject, email, display_name)
         VALUES ('test-idp', $1, $1 || '@example.test', $1)
         ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id`, [subject]);
    return Number(rows[0].user_id);
}

async function rejects(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error("expected a refusal");
}

beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await runCmsMigrations(pool, SCHEMA);
    store = new ComputeTargetStore(pool, SCHEMA);
}, 180_000);

afterAll(async () => {
    if (pool) {
        await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await pool.end();
    }
});

beforeEach(async () => {
    await sql(`TRUNCATE @compute_targets`);
});

describe("compute targets", () => {
    it("only an admin creates a shared target; everyone sees it", async () => {
        const alice = await makeUser("alice");
        const denied = await rejects(store.create({ name: "pool-a", kind: "sandbox", class: "shared" }, alice, false));
        expect(denied).toBeInstanceOf(ComputeTargetError);
        expect(denied.code).toBe("COMPUTE_TARGET_FORBIDDEN");

        const created = await store.create({ name: "pool-a", kind: "sandbox", class: "shared", displayName: "Pool A", config: { size: "m" } }, null, true);
        expect(created).toMatchObject({ name: "pool-a", kind: "sandbox", class: "shared", ownerUserId: null, displayName: "Pool A", config: { size: "m" }, enabled: true });

        expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

        const seen = await store.list(alice, false);
        expect(seen.map((t) => [t.name, t.manageable])).toEqual([["pool-a", false]]);
        expect(seen[0].config, "provider config is shown only to managers").toEqual({});
        const asAdmin = await store.list(null, true);
        expect(asAdmin.map((t) => [t.name, t.manageable])).toEqual([["pool-a", true]]);
        expect(asAdmin[0].config).toEqual({ size: "m" });
    });

    it("a personal target belongs to its creator and is invisible to others, admins included", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await store.create({ name: "alice-box", kind: "user-machine", class: "personal" }, alice, false);

        expect((await store.list(alice, false)).map((t) => t.name)).toEqual(["alice-box"]);
        expect(await store.list(bob, false)).toEqual([]);
        expect(await store.list(bob, true)).toEqual([]);

        const adminDelete = await rejects(store.delete("alice-box", bob, true));
        expect(adminDelete.code).toBe("COMPUTE_TARGET_NOT_FOUND");
        expect(await store.delete("alice-box", alice, false)).toBe(0);
    });

    it("refuses bad names, kinds, configs and duplicates", async () => {
        expect((await rejects(store.create({ name: "a:b", kind: "x", class: "shared" }, null, true))).code).toBe("COMPUTE_TARGET_INVALID");
        expect((await rejects(store.create({ name: "ok", kind: "Bad Kind", class: "shared" }, null, true))).code).toBe("COMPUTE_TARGET_INVALID");
        const notObject = await rejects(sql(`SELECT * FROM @cms_compute_target_create('ok','x','shared',NULL,'[1]'::jsonb,NULL,TRUE)`));
        expect(String(notObject.message)).toMatch(/COMPUTE_TARGET_INVALID/);
        await store.create({ name: "dup", kind: "x", class: "shared" }, null, true);
        expect((await rejects(store.create({ name: "dup", kind: "x", class: "shared" }, null, true))).code).toBe("COMPUTE_TARGET_CONFLICT");
    });

    it("updates keep unspecified fields; only a manager may update", async () => {
        const alice = await makeUser("alice");
        await store.create({ name: "pool-b", kind: "sandbox", class: "shared", displayName: "B", config: { a: 1 } }, null, true);
        expect((await rejects(store.update("pool-b", { enabled: false }, alice, false))).code).toBe("COMPUTE_TARGET_FORBIDDEN");
        const updated = await store.update("pool-b", { enabled: false }, null, true);
        expect(updated).toMatchObject({ displayName: "B", config: { a: 1 }, enabled: false });
        const renamed = await store.update("pool-b", { displayName: "", config: { b: 2 } }, null, true);
        expect(renamed).toMatchObject({ displayName: null, config: { b: 2 }, enabled: false });
    });

    it("the session check accepts shared or own, enabled targets only", async () => {
        const alice = await makeUser("alice");
        await makeUser("bob");
        await store.create({ name: "shared-1", kind: "sandbox", class: "shared" }, null, true);
        await store.create({ name: "alice-box", kind: "user-machine", class: "personal" }, alice, false);
        const assertSession = (name, subject, isSystem = false) =>
            sql(`SELECT @cms_compute_target_assert_session($1,'test-idp',$2,$3) AS ok`, [name, subject, isSystem]);
        const uuid = /^[0-9a-f-]{36}$/;

        expect((await assertSession("shared-1", "bob"))[0].ok).toMatch(uuid);
        expect((await assertSession("alice-box", "alice"))[0].ok).toMatch(uuid);
        expect(String((await rejects(assertSession("alice-box", "bob"))).message)).toMatch(/COMPUTE_TARGET_NOT_FOUND/);
        expect(String((await rejects(assertSession("alice-box", null, true))).message)).toMatch(/COMPUTE_TARGET_NOT_FOUND/);
        expect((await assertSession("shared-1", null, true))[0].ok).toMatch(uuid);

        await store.update("shared-1", { enabled: false }, null, true);
        expect(String((await rejects(assertSession("shared-1", "bob"))).message)).toMatch(/COMPUTE_TARGET_DISABLED/);
    });

    it("the worker resolves by id for the session's owner, and a reused name never takes old sessions", async () => {
        const alice = await makeUser("alice");
        await makeUser("bob");
        const shared = await store.create({ name: "pool-c", kind: "sandbox", class: "shared", config: { region: "x" } }, null, true);
        const bobs = { provider: "test-idp", subject: "bob" };
        expect(await store.resolveForSession(shared.id, bobs, false)).toMatchObject({ id: shared.id, name: "pool-c", config: { region: "x" } });
        expect(await store.resolveForSession(shared.id, null, true)).toMatchObject({ name: "pool-c" });
        expect(await store.resolveForSession("not-a-uuid", bobs, false)).toBeNull();

        const own = await store.create({ name: "alice-box", kind: "user-machine", class: "personal" }, alice, false);
        expect(await store.resolveForSession(own.id, { provider: "test-idp", subject: "alice" }, false)).toMatchObject({ name: "alice-box" });
        expect(await store.resolveForSession(own.id, bobs, false), "another user's personal target").toBeNull();
        expect(await store.resolveForSession(own.id, null, true), "system sessions use shared targets only").toBeNull();

        await sql(`INSERT INTO @sessions (session_id, state, creation_config)
                   VALUES ('s-open', 'idle', $1::jsonb), ('s-done', 'completed', $1::jsonb)`,
        [JSON.stringify({ computeTarget: "pool-c", computeTargetId: shared.id })]);
        expect(await store.delete("pool-c", null, true)).toBe(1);
        expect(await store.resolveForSession(shared.id, bobs, false)).toBeNull();

        // The same name again is a different target: old sessions stay blocked.
        const reused = await store.create({ name: "pool-c", kind: "sandbox", class: "shared" }, null, true);
        expect(reused.id).not.toBe(shared.id);
        expect(await store.resolveForSession(shared.id, bobs, false)).toBeNull();
    });
});
