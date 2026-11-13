import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { observeBlocked, openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);

describe("strict deletion and child creation share the parent row lock", () => {
    it("refuses to delete a parent with an undeleted child", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const root = randomUUID(), child = randomUUID();
            await h.catalog.createSession(root);
            await h.catalog.createSession(child, { parentSessionId: root });
            await expect(h.catalog.softDeleteSession(root, { requireNoLiveChildren: true }))
                .rejects.toThrow("live children");
            expect(await h.catalog.getSession(root)).not.toBeNull();
            expect(await h.catalog.getDescendantSessionIds(root)).toEqual([child]);
        } finally { await h.stop(); }
    });

    it("reads a child committed after enumeration and refuses the parent delete", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const root = randomUUID(), child = randomUUID();
            await h.catalog.createSession(root);
            expect(await h.catalog.getDescendantSessionIds(root)).toEqual([]);
            await h.catalog.createSession(child, { parentSessionId: root });
            await expect(h.catalog.softDeleteSession(root, { requireNoLiveChildren: true }))
                .rejects.toThrow("live children");
            expect(await h.catalog.getSession(root)).not.toBeNull();
        } finally { await h.stop(); }
    });

    it("preserves the explicit legacy unchecked deletion path", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const root = randomUUID(), child = randomUUID();
            await h.catalog.createSession(root);
            await h.catalog.createSession(child, { parentSessionId: root });
            await h.catalog.softDeleteSession(root);
            expect(await h.catalog.getSession(root)).toBeNull();
            expect(await h.catalog.getSession(child)).not.toBeNull();
        } finally { await h.stop(); }
    });

    it("every installed session creator refuses a deleted parent, including overloads and resurrection", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const functions = await h.q(`SELECT p.proname, p.proargnames, p.pronargs
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = $1 AND p.proname IN ('cms_create_session', 'cms_create_workflow_session')
                ORDER BY p.proname, p.pronargs`, [h.schema]);
            expect(functions.length).toBeGreaterThanOrEqual(6);
            for (const fn of functions) {
                const parent = randomUUID(), child = randomUUID();
                await h.catalog.createSession(parent);
                await h.catalog.createSession(child, { parentSessionId: parent });
                await h.catalog.softDeleteSession(child);
                await h.catalog.softDeleteSession(parent);
                const names = fn.proargnames.slice(0, fn.pronargs);
                expect(names).toContain("p_parent_session_id");
                const values = names.map(name => name === "p_session_id" ? child
                    : name === "p_parent_session_id" ? parent : name === "p_is_system" ? false
                        : name === "p_creation_config" ? "{}" : null);
                await expect(h.q(`SELECT SCHEMA.${fn.proname}(${values.map((_, index) => `$${index + 1}`).join(",")})`, values))
                    .rejects.toThrow("PARENT_DELETED");
            }
        } finally { await h.stop(); }
    });

    it("sees the child when creation holds the parent lock first", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        const creator = await h.pool.connect();
        let deleting, connectSpy;
        try {
            const root = randomUUID(), child = randomUUID();
            await h.catalog.createSession(root);
            await creator.query("BEGIN");
            await creator.query(`SELECT "${h.schema}".cms_create_session($1,NULL,NULL,$2,FALSE,NULL,NULL,NULL,NULL,NULL)`,
                [child, root]);
            const connected = Promise.withResolvers();
            const connect = h.catalog.pool.connect.bind(h.catalog.pool);
            connectSpy = vi.spyOn(h.catalog.pool, "connect").mockImplementationOnce(async () => {
                const connection = await connect();
                connected.resolve(connection.processID);
                return connection;
            });
            deleting = h.catalog.softDeleteSession(root, { requireNoLiveChildren: true })
                .then(() => null, error => error);
            const pid = await connected.promise;
            expect((await observeBlocked(h, pid, creator.processID)).blocked).toBe(true);
            await creator.query("COMMIT");
            expect(await deleting).toMatchObject({ message: expect.stringContaining("live children") });
            expect(await h.catalog.getSession(root)).not.toBeNull();
            expect(await h.catalog.getSession(child)).not.toBeNull();
        } finally {
            await creator.query("ROLLBACK");
            if (deleting) await deleting;
            connectSpy?.mockRestore();
            creator.release();
            await h.stop();
        }
    });

    it("an aborted lock waiter does not delete its target after the blocker releases", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        const blocker = await h.pool.connect();
        let deleting, connectSpy;
        try {
            const root = randomUUID();
            await h.catalog.createSession(root);
            await blocker.query("BEGIN");
            await blocker.query(`SELECT session_id FROM "${h.schema}".sessions WHERE session_id = $1 FOR SHARE`, [root]);
            const connected = Promise.withResolvers(), controller = new AbortController();
            const connect = h.catalog.pool.connect.bind(h.catalog.pool);
            connectSpy = vi.spyOn(h.catalog.pool, "connect").mockImplementationOnce(async () => {
                const connection = await connect();
                connected.resolve(connection.processID);
                return connection;
            });
            deleting = h.catalog.softDeleteSession(root, { requireNoLiveChildren: true, signal: controller.signal })
                .then(() => null, error => error);
            const pid = await connected.promise;
            expect((await observeBlocked(h, pid, blocker.processID)).blocked).toBe(true);
            controller.abort(new Error("request deadline"));
            expect(await deleting).toMatchObject({ message: "request deadline" });
            await blocker.query("COMMIT");
            // A new lock acquisition waits for the aborted transaction to leave.
            await blocker.query("BEGIN");
            await blocker.query(`SELECT session_id FROM "${h.schema}".sessions WHERE session_id = $1 FOR NO KEY UPDATE`, [root]);
            expect(await h.catalog.getSession(root)).not.toBeNull();
            await blocker.query("COMMIT");
        } finally {
            await blocker.query("ROLLBACK");
            if (deleting) await deleting;
            connectSpy?.mockRestore();
            blocker.release();
            await h.stop();
        }
    });

    it("refuses creation when strict deletion holds the parent lock first", { timeout: 120_000 }, async () => {
        const h = await openWorkflowStore(getEnv());
        const creator = await h.pool.connect();
        const locked = Promise.withResolvers(), resume = Promise.withResolvers();
        let deleting, creating, connectSpy;
        try {
            const root = randomUUID(), child = randomUUID();
            await h.catalog.createSession(root);
            const connect = h.catalog.pool.connect.bind(h.catalog.pool);
            connectSpy = vi.spyOn(h.catalog.pool, "connect").mockImplementationOnce(async () => {
                const connection = await connect();
                const query = connection.query.bind(connection);
                connection.query = async (...args) => {
                    const result = await query(...args);
                    const text = typeof args[0] === "string" ? args[0] : args[0].text;
                    if (text.includes("FOR NO KEY UPDATE")) {
                        connection.query = query;
                        locked.resolve(connection.processID);
                        await resume.promise;
                    }
                    return result;
                };
                return connection;
            });
            deleting = h.catalog.softDeleteSession(root, { requireNoLiveChildren: true });
            const pid = await locked.promise;
            creating = creator.query(`SELECT "${h.schema}".cms_create_session($1,NULL,NULL,$2,FALSE,NULL,NULL,NULL,NULL,NULL)`,
                [child, root]).then(() => null, error => error);
            expect((await observeBlocked(h, creator.processID, pid)).blocked).toBe(true);
            resume.resolve();
            await deleting;
            expect(await creating).toMatchObject({ message: expect.stringContaining("PARENT_DELETED") });
            expect(await h.catalog.getSession(root)).toBeNull();
            expect(await h.catalog.getSession(child)).toBeNull();
        } finally {
            resume.resolve();
            if (deleting) await deleting.catch(() => {});
            if (creating) await creating;
            connectSpy?.mockRestore();
            creator.release();
            await h.stop();
        }
    });
});
