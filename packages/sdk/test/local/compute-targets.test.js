/**
 * Compute targets — the schema and stored procedures of migration 0088
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
import { PgSessionCatalog } from "../../src/cms.ts";
import { treeComputeTarget } from "../../src/client.ts";

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
        const denied = await rejects(store.create({ name: "shared/pool-a", kind: "sandbox" }, alice, false));
        expect(denied).toBeInstanceOf(ComputeTargetError);
        expect(denied.code).toBe("COMPUTE_TARGET_FORBIDDEN");

        const created = await store.create({ name: "shared/pool-a", kind: "sandbox", displayName: "Pool A", config: { size: "m" } }, null, true);
        expect(created).toMatchObject({ name: "shared/pool-a", kind: "sandbox", class: "shared", displayName: "Pool A", config: { size: "m" }, enabled: true });

        expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

        const seen = await store.list(alice, false);
        expect(seen.map((t) => [t.name, t.manageable])).toEqual([["shared/pool-a", false]]);
        expect(seen[0].config, "provider config is shown only to managers").toEqual({});
        const asAdmin = await store.list(null, true);
        expect(asAdmin.map((t) => [t.name, t.manageable])).toEqual([["shared/pool-a", true]]);
        expect(asAdmin[0].config).toEqual({ size: "m" });
    });

    it("refuses bad names, kinds, configs and duplicates", async () => {
        expect((await rejects(store.create({ name: "shared/a:b", kind: "x" }, null, true))).code).toBe("COMPUTE_TARGET_INVALID");
        expect((await rejects(store.create({ name: "shared/ok", kind: "Bad Kind" }, null, true))).code).toBe("COMPUTE_TARGET_INVALID");
        const notObject = await rejects(sql(`SELECT * FROM @cms_compute_target_create('shared/ok','x',NULL,'[1]'::jsonb,NULL,TRUE)`));
        expect(String(notObject.message)).toMatch(/COMPUTE_TARGET_INVALID/);
        await store.create({ name: "shared/dup", kind: "x" }, null, true);
        expect((await rejects(store.create({ name: "shared/dup", kind: "x" }, null, true))).code).toBe("COMPUTE_TARGET_CONFLICT");
    });

    it("updates keep unspecified fields; only a manager may update", async () => {
        const alice = await makeUser("alice");
        await store.create({ name: "shared/pool-b", kind: "sandbox", displayName: "B", config: { a: 1 } }, null, true);
        expect((await rejects(store.update("shared/pool-b", { enabled: false }, alice, false))).code).toBe("COMPUTE_TARGET_FORBIDDEN");
        const updated = await store.update("shared/pool-b", { enabled: false }, null, true);
        expect(updated).toMatchObject({ displayName: "B", config: { a: 1 }, enabled: false });
        const renamed = await store.update("shared/pool-b", { displayName: "", config: { b: 2 } }, null, true);
        expect(renamed).toMatchObject({ displayName: null, config: { b: 2 }, enabled: false });
    });

    it("the session check accepts an existing, enabled target only", async () => {
        await store.create({ name: "shared/shared-1", kind: "sandbox" }, null, true);
        const assertSession = (name) => sql(`SELECT @cms_compute_target_assert_session($1) AS ok`, [name]);
        const uuid = /^[0-9a-f-]{36}$/;

        expect((await assertSession("shared/shared-1"))[0].ok).toMatch(uuid);
        expect(String((await rejects(assertSession("shared/gone"))).message)).toMatch(/COMPUTE_TARGET_NOT_FOUND/);

        await store.update("shared/shared-1", { enabled: false }, null, true);
        expect(String((await rejects(assertSession("shared/shared-1"))).message)).toMatch(/COMPUTE_TARGET_DISABLED/);
    });

    it("the worker resolves by id, and a reused name never takes old sessions", async () => {
        const shared = await store.create({ name: "shared/pool-c", kind: "sandbox", config: { region: "x" } }, null, true);
        expect(await store.resolveForSession(shared.id)).toMatchObject({ id: shared.id, name: "shared/pool-c", config: { region: "x" } });
        expect(await store.resolveForSession("not-a-uuid")).toBeNull();

        await sql(`INSERT INTO @sessions (session_id, state, creation_config)
                   VALUES ('s-open', 'idle', $1::jsonb), ('s-done', 'completed', $1::jsonb)`,
        [JSON.stringify({ computeTarget: "shared/pool-c", computeTargetId: shared.id })]);
        expect(await store.delete("shared/pool-c", null, true)).toBe(1);
        expect(await store.resolveForSession(shared.id)).toBeNull();

        // The same name again is a different target: old sessions stay blocked.
        const reused = await store.create({ name: "shared/pool-c", kind: "sandbox" }, null, true);
        expect(reused.id).not.toBe(shared.id);
        expect(await store.resolveForSession(shared.id)).toBeNull();
    });

    it("a deployment's default target is recorded at creation, and sub-agents keep inheriting", async () => {
        const target = await store.create({ name: "shared/default-pool", kind: "sandbox" }, null, true);
        const catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        try {
            catalog.defaultComputeTarget = "shared/default-pool";

            // A new root session that names none is given the default, and
            // records its id exactly as a named one would.
            await catalog.createSession("s-default", { creationConfig: {} });
            const root = await catalog.getSessionCreationConfig("s-default");
            expect(root).toMatchObject({ computeTarget: "shared/default-pool", computeTargetId: target.id });

            // A sub-agent records nothing of its own: it inherits its
            // tree's target through the root, and a target of its own
            // could disagree with it.
            await catalog.createSession("s-child", { parentSessionId: "s-default", creationConfig: {} });
            const child = await catalog.getSessionCreationConfig("s-child");
            expect(child?.computeTarget).toBeUndefined();
            expect(child?.computeTargetId).toBeUndefined();

            // A session that names one still gets what it asked for.
            const other = await store.create({ name: "shared/named-pool", kind: "sandbox" }, null, true);
            await catalog.createSession("s-named", { creationConfig: { computeTarget: "shared/named-pool" } });
            expect(await catalog.getSessionCreationConfig("s-named"))
                .toMatchObject({ computeTarget: "shared/named-pool", computeTargetId: other.id });

            // And with no default set, a session that names none records
            // none — which is every deployment that has not turned this on.
            catalog.defaultComputeTarget = "";
            await catalog.createSession("s-plain", { creationConfig: {} });
            expect((await catalog.getSessionCreationConfig("s-plain"))?.computeTarget).toBeUndefined();
        } finally {
            await catalog.close?.();
            await sql(`DELETE FROM @sessions WHERE session_id LIKE 's-%'`);
        }
    });

    it("every turn of a compute tree carries its target, including a sub-agent's and a default root's", async () => {
        // The tag that keeps these turns away from workers that would run
        // the agent on the worker is chosen from this. Reading the
        // caller's own field instead left exactly these two cases
        // untagged: nobody passes a target for either of them.
        const target = await store.create({ name: "shared/routing-pool", kind: "sandbox" }, null, true);
        const catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        try {
            catalog.defaultComputeTarget = "shared/routing-pool";
            await catalog.createSession("r-root", { creationConfig: {} });
            await catalog.createSession("r-child", { parentSessionId: "r-root", creationConfig: {} });
            await catalog.createSession("r-grandchild", { parentSessionId: "r-child", creationConfig: {} });

            // A root that was given the deployment's default: it is in the
            // catalog and nowhere else.
            const rootRow = await catalog.getSession("r-root");
            expect(await treeComputeTarget(catalog, "r-root", rootRow)).toBe("shared/routing-pool");

            // A sub-agent, and a sub-agent of a sub-agent: neither records
            // a target of its own, and both read the tree's.
            for (const sessionId of ["r-child", "r-grandchild"]) {
                const row = await catalog.getSession(sessionId);
                expect((await catalog.getSessionCreationConfig(sessionId))?.computeTarget).toBeUndefined();
                expect(await treeComputeTarget(catalog, sessionId, row), sessionId).toBe("shared/routing-pool");
            }

            // A tree with no target reads none, so an ordinary session is
            // routed exactly as it was before.
            catalog.defaultComputeTarget = "";
            await catalog.createSession("r-plain", { creationConfig: {} });
            await catalog.createSession("r-plain-child", { parentSessionId: "r-plain", creationConfig: {} });
            for (const sessionId of ["r-plain", "r-plain-child"]) {
                const row = await catalog.getSession(sessionId);
                expect(await treeComputeTarget(catalog, sessionId, row), sessionId).toBeUndefined();
            }

            // And a tree whose root named one explicitly behaves the same way.
            await store.create({ name: "shared/named-routing", kind: "sandbox" }, null, true);
            await catalog.createSession("r-named", { creationConfig: { computeTarget: "shared/named-routing" } });
            await catalog.createSession("r-named-child", { parentSessionId: "r-named", creationConfig: {} });
            const namedChildRow = await catalog.getSession("r-named-child");
            expect(await treeComputeTarget(catalog, "r-named-child", namedChildRow)).toBe("shared/named-routing");
            expect(target.id).toBeTruthy();
        } finally {
            await catalog.close?.();
            await sql(`DELETE FROM @sessions WHERE session_id LIKE 'r-%'`);
        }
    });

    it("every target lives in the shared space, and a name is always two parts", async () => {
        // A target outside the shared space is refused, so adding targets
        // with another owner later renames nothing that exists.
        expect((await rejects(store.create({ name: "alice@example.test/not-shared", kind: "x" }, null, true))).code)
            .toBe("COMPUTE_TARGET_INVALID");

        for (const name of ["bare", "/leading", "trailing/", "shared/has space", "shared/a:b"]) {
            expect((await rejects(store.create({ name, kind: "x" }, null, true))).code, name)
                .toBe("COMPUTE_TARGET_INVALID");
        }
    });
});
