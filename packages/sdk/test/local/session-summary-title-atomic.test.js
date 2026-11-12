import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import * as copilotClient from "../../src/copilot-client.ts";
import { useSuiteEnv } from "../helpers/local-env.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
afterEach(() => vi.restoreAllMocks());

describe("atomic CMS summary titles", () => {
    it("updates only live, unlocked, non-system rows and leaves explicit rename/unlock unchanged", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        const db = new pg.Client({ connectionString: env.store });
        try {
            await catalog.initialize();
            await db.connect();
            for (const [id, patch] of [
                ["ordinary", { title: "Old" }],
                ["locked", { title: "Keep", titleLocked: true }],
                ["system", { title: "System", isSystem: true }],
                ["deleted", { title: "Deleted" }],
            ]) {
                await catalog.createSession(id);
                await catalog.updateSession(id, patch);
            }
            await db.query(`UPDATE "${env.cmsSchema}".sessions SET deleted_at = now() WHERE session_id = 'deleted'`);
            expect(await catalog.updateSessionTitleIfUnlocked("ordinary", "New")).toBe(true);
            expect(await catalog.updateSessionTitleIfUnlocked("ordinary", "New")).toBe(false);
            expect(await catalog.getSession("ordinary")).toMatchObject({ title: "New", titleLocked: false });
            for (const id of ["locked", "system", "deleted", "missing"]) {
                expect(await catalog.updateSessionTitleIfUnlocked(id, "Wrong")).toBe(false);
            }
            expect(await catalog.getSession("locked")).toMatchObject({ title: "Keep", titleLocked: true });
            expect(await catalog.getSession("system")).toMatchObject({ title: "System", titleLocked: false });
            expect((await db.query(`SELECT title FROM "${env.cmsSchema}".sessions WHERE session_id = 'deleted'`)).rows[0].title).toBe("Deleted");
            await catalog.updateSession("locked", { title: "Explicit rename", titleLocked: true });
            expect(await catalog.getSession("locked")).toMatchObject({ title: "Explicit rename", titleLocked: true });
            await catalog.updateSession("locked", { titleLocked: false });
            expect(await catalog.getSession("locked")).toMatchObject({ title: "Explicit rename", titleLocked: false });
            expect(await catalog.updateSessionTitleIfUnlocked("locked", "Eligible again")).toBe(true);
            for (const title of [null, "", "   "]) {
                await expect(catalog.updateSessionTitleIfUnlocked("ordinary", title)).rejects.toThrow("summary title must not be empty");
            }
            expect(await catalog.getSession("ordinary")).toMatchObject({ title: "New", titleLocked: false });
        } finally {
            await db.end();
            await catalog.close();
        }
    });

    it("migration 0093 upgrades an existing catalog and can be reapplied without changing explicit titles", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const db = new pg.Pool({ connectionString: env.store, max: 1 });
        const entries = CMS_MIGRATIONS(env.cmsSchema);
        const migration = entries.find(entry => entry.version === "0093");
        try {
            expect(migration?.name).toBe("session_summary_title_guard");
            await runMigrations(db, env.cmsSchema, entries.filter(entry => entry.version < "0093"), 0x63_6D_73);
            await db.query(`INSERT INTO "${env.cmsSchema}".sessions(session_id, title, title_locked) VALUES ('retained', 'Keep', true)`);
            await runMigrations(db, env.cmsSchema, entries, 0x63_6D_73);
            await db.query(migration.sql);
            await runMigrations(db, env.cmsSchema, entries, 0x63_6D_73);
            expect((await db.query(`SELECT title, title_locked FROM "${env.cmsSchema}".sessions WHERE session_id = 'retained'`)).rows)
                .toEqual([{ title: "Keep", title_locked: true }]);
            expect((await db.query(`SELECT count(*)::int AS n FROM "${env.cmsSchema}".schema_migrations WHERE version = '0093'`)).rows[0].n).toBe(1);
            expect((await db.query(`SELECT "${env.cmsSchema}".cms_update_session_title_if_unlocked('retained', 'Wrong') AS updated`)).rows[0].updated).toBe(false);
        } finally {
            await db.end();
        }
    });

    it.each(["rename-first", "summary-first"])("a committed locked rename wins the two-client ordering: %s", { timeout: TIMEOUT }, async order => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        const first = new pg.Client({ connectionString: env.store, statement_timeout: 10_000 });
        const second = new pg.Client({ connectionString: env.store, statement_timeout: 10_000 });
        let pending;
        let transactionOpen = false;
        try {
            await catalog.initialize();
            const id = randomUUID();
            await catalog.createSession(id);
            await catalog.updateSession(id, { title: "Old" });
            await first.connect();
            await second.connect();
            await first.query("BEGIN");
            transactionOpen = true;
            const renameSql = `SELECT "${env.cmsSchema}".cms_update_session($1, '{"title":"Keep","titleLocked":true}'::jsonb)`;
            const summarySql = `SELECT "${env.cmsSchema}".cms_update_session_title_if_unlocked($1, 'Summary') AS updated`;
            if (order === "rename-first") {
                await first.query(renameSql, [id]);
                pending = second.query(summarySql, [id]).then(value => ({ value }), error => ({ error }));
            } else {
                expect((await first.query(summarySql, [id])).rows[0].updated).toBe(true);
                pending = second.query(renameSql, [id]).then(value => ({ value }), error => ({ error }));
            }
            // The first transaction holds the row until COMMIT. The second
            // writer must serialize after it, whichever statement it runs.
            await first.query("COMMIT");
            transactionOpen = false;
            const result = await pending;
            if (result.error) throw result.error;
            if (order === "rename-first") expect(result.value.rows[0].updated).toBe(false);
            expect(await catalog.getSession(id)).toMatchObject({ title: "Keep", titleLocked: true });
        } finally {
            try {
                if (transactionOpen) await first.query("ROLLBACK");
                if (pending) await pending;
            } finally {
                await Promise.all([second.end(), first.end(), catalog.close()]);
            }
        }
    });
});

function summaryHarness({ fallback = false, guard, modelTitle = "Generated title", initialRow = {} } = {}) {
    let row = { sessionId: "summary", title: "Old", titleLocked: false, ...initialRow };
    const handlers = {};
    const catalog = {
        getSession: vi.fn(async () => row === null ? null : ({ ...row })),
        getSessionEvents: async () => [{ eventType: "user.message", data: { content: "Analyze replication lag" } }],
        updateSession: vi.fn(async (_id, patch) => { row = { ...row, ...patch }; }),
        updateSessionTitleIfUnlocked: vi.fn(async (id, title) => {
            if (guard) return guard({ id, title, setRow: patch => { row = patch === null ? null : { ...row, ...patch }; } });
            row = { ...row, title };
            return true;
        }),
    };
    const callbacks = {};
    vi.spyOn(copilotClient, "createCopilotClient").mockReturnValue({
        start: async () => {},
        stop: async () => {},
        createSession: async () => ({
            on: (name, fn) => { callbacks[name] = fn; },
            send: () => {
                if (fallback) callbacks["session.error"]({ data: { message: "model unavailable" } });
                else {
                    callbacks["assistant.message"]({ data: { content: modelTitle } });
                    callbacks["session.idle"]();
                }
            },
        }),
    });
    registerActivities({ registerActivity: (name, fn) => { handlers[name] = fn; } },
        { resolveDefaultProvider: () => ({ modelName: "fixture:model", sdkProvider: {} }) },
        null, undefined, catalog);
    return { catalog, row: () => row, run: () => handlers.summarizeSession({ traceInfo() {} }, { sessionId: "summary" }) };
}

describe("summary activity uses the atomic title guard", () => {
    it.each([false, true])("both model and fallback paths persist through the guard (fallback=%j)", async fallback => {
        const h = summaryHarness({ fallback });
        const title = fallback ? "Analyze replication lag" : "Generated title";
        expect(await h.run()).toBe(title);
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledExactlyOnceWith("summary", title);
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });

    it.each([false, true])("a rename in the final read/write gap wins (fallback=%j)", async fallback => {
        const h = summaryHarness({
            fallback,
            guard: ({ setRow }) => {
                setRow({ title: "Concurrent rename", titleLocked: true });
                return false;
            },
        });
        expect(await h.run()).toBe("Concurrent rename");
        expect(h.row()).toMatchObject({ title: "Concurrent rename", titleLocked: true });
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledOnce();
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });

    it.each([false, true])("storage failures propagate without an unguarded fallback (fallback=%j)", async fallback => {
        const h = summaryHarness({ fallback, guard: () => { throw new Error("guard write failed"); } });
        await expect(h.run()).rejects.toThrow("guard write failed");
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledOnce();
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });

    it("a rejected write for a deleted row returns empty without attempting a fallback write", async () => {
        const h = summaryHarness({ guard: ({ setRow }) => { setRow(null); return false; } });
        expect(await h.run()).toBe("");
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledOnce();
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });

    it("an already-equal title returns the stored title rather than overwriting it with fallback text", async () => {
        const h = summaryHarness({ initialRow: { title: "Generated title" }, guard: () => false });
        expect(await h.run()).toBe("Generated title");
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledExactlyOnceWith("summary", "Generated title");
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });

    it("an empty model title uses the guarded fallback once", async () => {
        const h = summaryHarness({ modelTitle: '""' });
        expect(await h.run()).toBe("Analyze replication lag");
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledExactlyOnceWith("summary", "Analyze replication lag");
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });

    it("named summaries preserve the prefix and clean the generated text", async () => {
        const h = summaryHarness({ initialRow: { agentId: "analyst", title: "Analyst: Old" }, modelTitle: '"PostgreSQL &amp; MySQL."' });
        expect(await h.run()).toBe("PostgreSQL & MySQL");
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledExactlyOnceWith("summary", "Analyst: PostgreSQL & MySQL");
    });

    it("failure to read the stored title after a rejected write propagates", async () => {
        const h = summaryHarness({ guard: () => false });
        h.catalog.getSession.mockResolvedValueOnce(h.row()).mockResolvedValueOnce(h.row())
            .mockRejectedValueOnce(new Error("title read failed"));
        await expect(h.run()).rejects.toThrow("title read failed");
        expect(h.catalog.updateSessionTitleIfUnlocked).toHaveBeenCalledOnce();
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });
});
