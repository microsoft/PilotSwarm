import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PilotSwarmClient } from "../../src/client.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { observeBlocked, openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "resurrection-guard" };

async function createThrough(h, overload, id, parent) {
    if (overload === "catalog") {
        return h.catalog.createSession(id, { parentSessionId: parent, owner: OWNER });
    }
    const params = overload === 6
        ? [id, null, parent, false, null, null]
        : [id, null, null, parent, false, null, null, ...Array(overload - 7).fill(null)];
    return h.q(`SELECT SCHEMA.cms_create_session(${params.map((_, i) => `$${i + 1}`).join(",")})`, params);
}

async function tree(h, deletedIntermediate = false) {
    const oldRoot = randomUUID();
    const newRoot = randomUUID();
    const connector = randomUUID();
    const intermediate = deletedIntermediate ? randomUUID() : null;
    const leaf = randomUUID();
    await h.catalog.createSession(oldRoot, { owner: OWNER });
    await h.catalog.createSession(newRoot, { owner: OWNER });
    await h.catalog.createSession(connector, { parentSessionId: oldRoot, owner: OWNER });
    if (intermediate) await h.catalog.createSession(intermediate, { parentSessionId: connector, owner: OWNER });
    await h.catalog.createSession(leaf, { parentSessionId: intermediate ?? connector, owner: OWNER });
    // Model the existing best-effort deletion residual without transferring
    // anything or relying on a cascade failing by chance.
    await h.catalog.softDeleteSession(connector);
    if (intermediate) await h.catalog.softDeleteSession(intermediate);
    return { oldRoot, newRoot, connector, intermediate, leaf };
}

async function snapshot(h, ids) {
    return h.q(`SELECT session_id, parent_session_id, root_session_id, deleted_at, state,
        turn_high, turn_base_seq, active_turn_index, title_locked, creation_config,
        model, reasoning_effort, group_id, visibility, splash, splash_mobile, is_system, agent_id
        FROM SCHEMA.sessions WHERE session_id = ANY($1::text[]) ORDER BY session_id`, [ids]);
}

async function metrics(h, id) {
    return {
        summaries: await h.q("SELECT * FROM SCHEMA.session_metric_summaries WHERE session_id = $1", [id]),
        legacy: await h.q("SELECT * FROM SCHEMA.session_metrics WHERE session_id = $1", [id]),
    };
}

describe("FB-046: resurrection must not move a live subtree", () => {
    it.each(["catalog", 6, 7, 8, 9, 10])("refuses a parent-changing resurrection through %s", { timeout: TIMEOUT }, async overload => {
        const h = await openWorkflowStore(getEnv());
        try {
            const t = await tree(h);
            const before = await snapshot(h, [t.connector, t.leaf]);
            const metricsBefore = await metrics(h, t.connector);
            const caught = await createThrough(h, overload, t.connector, t.newRoot)
                .then(() => null, error => error);
            const after = await snapshot(h, [t.connector, t.leaf]);
            expect({ refused: caught !== null, rows: after }).toEqual({ refused: true, rows: before });
            expect(await metrics(h, t.connector)).toEqual(metricsBefore);
        } finally {
            await h.stop();
        }
    });

    it("finds live descendants through deleted intermediate rows", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const t = await tree(h, true);
            const before = await snapshot(h, [t.connector, t.intermediate, t.leaf]);
            const caught = await createThrough(h, 10, t.connector, t.newRoot)
                .then(() => null, error => error);
            expect({ refused: caught !== null, rows: await snapshot(h, [t.connector, t.intermediate, t.leaf]) })
                .toEqual({ refused: true, rows: before });
        } finally {
            await h.stop();
        }
    });

    it.each([6, 7, 8, 9, 10])("preserves same-parent resurrection with live descendants through %s", { timeout: TIMEOUT }, async overload => {
        const h = await openWorkflowStore(getEnv());
        try {
            const t = await tree(h);
            await createThrough(h, overload, t.connector, t.oldRoot);
            expect(await h.q("SELECT deleted_at, parent_session_id, root_session_id FROM SCHEMA.sessions WHERE session_id = $1",
                [t.connector])).toEqual([{ deleted_at: null, parent_session_id: t.oldRoot, root_session_id: t.oldRoot }]);
            expect(await h.q("SELECT root_session_id FROM SCHEMA.sessions WHERE session_id = $1",
                [t.leaf])).toEqual([{ root_session_id: t.oldRoot }]);
        } finally {
            await h.stop();
        }
    });

    it("preserves a childless resurrection and never reparents a live id", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const a = randomUUID(), b = randomUUID(), child = randomUUID();
            await h.catalog.createSession(a, { owner: OWNER });
            await h.catalog.createSession(b, { owner: OWNER });
            await createThrough(h, 10, child, a);
            await createThrough(h, 10, child, b);
            expect(await h.q("SELECT parent_session_id FROM SCHEMA.sessions WHERE session_id = $1",
                [child])).toEqual([{ parent_session_id: a }]);
            await h.catalog.softDeleteSession(child);
            await createThrough(h, 10, child, b);
            expect(await h.q("SELECT deleted_at, parent_session_id, root_session_id FROM SCHEMA.sessions WHERE session_id = $1",
                [child])).toEqual([{ deleted_at: null, parent_session_id: b, root_session_id: b }]);
        } finally {
            await h.stop();
        }
    });

    it.each([6, 7, 8, 9, 10])("preserves allowed resurrections and stamps changed-parent roots through %s", { timeout: TIMEOUT }, async overload => {
        const h = await openWorkflowStore(getEnv());
        try {
            const a = randomUUID(), b = randomUUID(), child = randomUUID(), legacy = randomUUID();
            await h.catalog.createSession(a, { owner: OWNER });
            await h.catalog.createSession(b, { owner: OWNER });
            await h.catalog.createSession(child, { parentSessionId: a, owner: OWNER });
            await h.catalog.softDeleteSession(child);
            await createThrough(h, overload, child, a);
            expect(await h.q("SELECT root_session_id, deleted_at FROM SCHEMA.sessions WHERE session_id = $1", [child]))
                .toEqual([{ root_session_id: a, deleted_at: null }]);
            await h.catalog.softDeleteSession(child);
            await createThrough(h, overload, child, b);
            expect(await h.q("SELECT root_session_id, parent_session_id, deleted_at FROM SCHEMA.sessions WHERE session_id = $1", [child]))
                .toEqual([{ root_session_id: b, parent_session_id: b, deleted_at: null }]);
            await h.catalog.softDeleteSession(child);
            await createThrough(h, overload, child, null);
            expect(await h.q("SELECT root_session_id, parent_session_id FROM SCHEMA.sessions WHERE session_id = $1", [child]))
                .toEqual([{ root_session_id: child, parent_session_id: null }]);
            await createThrough(h, overload, legacy, a);
            // Legacy new inserts did not stamp a root before 0094. Repairing
            // that separate compatibility gap is not part of resurrection.
            expect(await h.q("SELECT root_session_id FROM SCHEMA.sessions WHERE session_id = $1", [legacy]))
                .toEqual([{ root_session_id: overload === 10 ? a : null }]);
        } finally {
            await h.stop();
        }
    });

    it.each([6, 7, 8, 9, 10, "workflow"])("allows an absent parent and refuses a deleted parent through %s", { timeout: TIMEOUT }, async overload => {
        const h = await openWorkflowStore(getEnv());
        try {
            const missing = randomUUID(), parent = randomUUID(), allowed = randomUUID(), refused = randomUUID();
            const create = (id, p) => overload === "workflow"
                ? h.q("SELECT SCHEMA.cms_create_workflow_session($1, $2, '{}'::jsonb)", [id, p])
                : createThrough(h, overload, id, p);
            await create(allowed, missing);
            expect(await h.q("SELECT parent_session_id FROM SCHEMA.sessions WHERE session_id = $1", [allowed]))
                .toEqual([{ parent_session_id: missing }]);
            await h.catalog.createSession(parent, { owner: OWNER });
            await h.catalog.softDeleteSession(parent);
            const caught = await create(refused, parent).then(() => null, error => error);
            expect(caught).not.toBeNull();
            expect(await h.q("SELECT session_id FROM SCHEMA.sessions WHERE session_id = $1", [refused])).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it.each([null, "new-root"])("refuses a parent change to %s while descendants remain", { timeout: TIMEOUT }, async target => {
        const h = await openWorkflowStore(getEnv());
        try {
            const t = await tree(h);
            const before = await snapshot(h, [t.connector, t.leaf]);
            const caught = await createThrough(h, 10, t.connector, target === null ? null : t.newRoot)
                .then(() => null, error => error);
            expect({ refused: caught !== null, rows: await snapshot(h, [t.connector, t.leaf]) })
                .toEqual({ refused: true, rows: before });
        } finally {
            await h.stop();
        }
    });

    it.each([10, "workflow"])("locks the SQL parent before a concurrent deletion through %s", { timeout: TIMEOUT }, async overload => {
        const h = await openWorkflowStore(getEnv());
        let deleting, creator, creating;
        try {
            const parent = randomUUID(), child = randomUUID();
            await h.catalog.createSession(parent, { owner: OWNER });
            deleting = await h.pool.connect();
            creator = await h.pool.connect();
            await deleting.query("BEGIN");
            await deleting.query(`UPDATE "${h.schema}".sessions SET deleted_at = now() WHERE session_id = $1`, [parent]);
            creating = creator.query(overload === "workflow"
                ? `SELECT "${h.schema}".cms_create_workflow_session($1, $2, '{}'::jsonb)`
                : `SELECT "${h.schema}".cms_create_session($1, NULL, NULL, $2, FALSE, NULL, NULL, NULL, NULL, NULL)`,
            [child, parent]).then(() => null, error => error);
            const observed = await observeBlocked(h, creator.processID, deleting.processID);
            await deleting.query("COMMIT");
            const caught = await creating;
            expect(observed.blocked).toBe(true);
            expect(caught).not.toBeNull();
            expect(await h.q("SELECT session_id FROM SCHEMA.sessions WHERE session_id = $1", [child])).toEqual([]);
        } finally {
            try {
                if (deleting) await deleting.query("ROLLBACK");
                if (creating) await creating;
            } finally {
                deleting?.release();
                creator?.release();
                await h.stop();
            }
        }
    });

    it("refuses a root-to-parent resurrection and a move beneath its own live child", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const root = randomUUID(), child = randomUUID(), other = randomUUID();
            await h.catalog.createSession(root, { owner: OWNER });
            await h.catalog.createSession(child, { parentSessionId: root, owner: OWNER });
            await h.catalog.createSession(other, { owner: OWNER });
            await h.catalog.softDeleteSession(root);
            const before = await snapshot(h, [root, child]);
            for (const parent of [other, child]) {
                await expect(createThrough(h, 10, root, parent)).rejects.toThrow("SESSION_RESURRECTION_HAS_LIVE_DESCENDANTS");
                expect(await snapshot(h, [root, child])).toEqual(before);
            }
            await expect(createThrough(h, 10, root, root)).rejects.toThrow("PARENT_DELETED");
        } finally {
            await h.stop();
        }
    });

    it("reads descendants after a concurrent existing-target lifetime commits", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        let lifetime, mover, moving;
        try {
            const a = randomUUID(), b = randomUUID(), connector = randomUUID(), leaf = randomUUID();
            await h.catalog.createSession(a, { owner: OWNER });
            await h.catalog.createSession(b, { owner: OWNER });
            await h.catalog.createSession(connector, { parentSessionId: a, owner: OWNER });
            await h.catalog.softDeleteSession(connector);
            lifetime = await h.pool.connect();
            mover = await h.pool.connect();
            await lifetime.query("BEGIN");
            await lifetime.query(`SELECT session_id FROM "${h.schema}".sessions WHERE session_id = $1 FOR UPDATE`, [connector]);
            moving = mover.query(`SELECT "${h.schema}".cms_create_session($1,NULL,NULL,$2,FALSE,NULL,NULL,NULL,NULL,NULL)`,
                [connector, b]).then(() => null, error => error);
            const observed = await observeBlocked(h, mover.processID, lifetime.processID);
            await lifetime.query(`SELECT "${h.schema}".cms_create_session($1,NULL,NULL,$2,FALSE,NULL,NULL,NULL,NULL,NULL)`, [connector, a]);
            await lifetime.query(`SELECT "${h.schema}".cms_create_session($1,NULL,NULL,$2,FALSE,NULL,NULL,NULL,NULL,NULL)`, [leaf, connector]);
            await lifetime.query(`UPDATE "${h.schema}".sessions SET deleted_at = now() WHERE session_id = $1`, [connector]);
            await lifetime.query("COMMIT");
            const caught = await moving;
            expect(observed.blocked).toBe(true);
            expect(caught).not.toBeNull();
            expect(await h.q("SELECT parent_session_id, root_session_id, deleted_at IS NOT NULL AS deleted FROM SCHEMA.sessions WHERE session_id = $1",
                [connector])).toEqual([{ parent_session_id: a, root_session_id: a, deleted: true }]);
            expect(await h.q("SELECT root_session_id FROM SCHEMA.sessions WHERE session_id = $1", [leaf]))
                .toEqual([{ root_session_id: a }]);
        } finally {
            try {
                if (lifetime) await lifetime.query("ROLLBACK");
                if (moving) await moving;
            } finally {
                lifetime?.release();
                mover?.release();
                await h.stop();
            }
        }
    });

    it("refuses atomically before closing old-lifetime controls or resetting turn state", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const t = await tree(h);
            await createThrough(h, 10, t.connector, t.oldRoot);
            await h.catalog.turnStart(t.connector, 3);
            await h.catalog.turnControlAdd(t.connector, "steer", "retain the old lifetime", randomUUID(), null);
            await h.catalog.softDeleteSession(t.connector);
            const rowsBefore = await snapshot(h, [t.connector, t.leaf]);
            const eventsBefore = await h.q("SELECT * FROM SCHEMA.session_events WHERE session_id = $1 ORDER BY seq", [t.connector]);
            await expect(createThrough(h, 10, t.connector, t.newRoot)).rejects.toThrow("SESSION_RESURRECTION_HAS_LIVE_DESCENDANTS");
            expect(await snapshot(h, [t.connector, t.leaf])).toEqual(rowsBefore);
            expect(await h.q("SELECT * FROM SCHEMA.session_events WHERE session_id = $1 ORDER BY seq", [t.connector])).toEqual(eventsBefore);
        } finally {
            await h.stop();
        }
    });

    it("rechecks an initially absent target after a concurrent lifetime leaves live descendants", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        let gate, mover, moving;
        try {
            const oldRoot = randomUUID(), newRoot = randomUUID(), connector = randomUUID(), leaf = randomUUID();
            const gateKey = `fb046-before-insert:${connector}`;
            const application = `fb046-mover:${connector}`;
            await h.catalog.createSession(oldRoot, { owner: OWNER });
            await h.catalog.createSession(newRoot, { owner: OWNER });
            // Pause only this caller's INSERT, after its absent-target read.
            // The production creation functions themselves remain unchanged.
            await h.q(`CREATE FUNCTION SCHEMA.fb046_before_insert() RETURNS trigger AS $$
                BEGIN
                    IF NEW.session_id = TG_ARGV[0] AND current_setting('application_name') = TG_ARGV[2] THEN
                        PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[1], 0));
                    END IF;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;
                CREATE TRIGGER fb046_before_insert BEFORE INSERT ON SCHEMA.sessions
                    FOR EACH ROW EXECUTE FUNCTION SCHEMA.fb046_before_insert('${connector}', '${gateKey}', '${application}');`);
            gate = await h.pool.connect();
            mover = await h.pool.connect();
            await gate.query("BEGIN");
            await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gateKey]);
            await mover.query("BEGIN");
            await mover.query("SELECT set_config('application_name', $1, true)", [application]);
            moving = mover.query(`SELECT "${h.schema}".cms_create_session($1, NULL, NULL, $2, FALSE, NULL, NULL, NULL, NULL, NULL)`,
                [connector, newRoot]).then(() => null, error => error);
            const observed = await observeBlocked(h, mover.processID, gate.processID);
            expect(observed.blocked).toBe(true);

            await h.catalog.createSession(connector, { parentSessionId: oldRoot, owner: OWNER });
            await h.catalog.createSession(leaf, { parentSessionId: connector, owner: OWNER });
            await h.catalog.softDeleteSession(connector);
            const before = await snapshot(h, [connector, leaf]);

            await gate.query("ROLLBACK");
            const caught = await moving;
            await mover.query(caught ? "ROLLBACK" : "COMMIT");
            expect({ refused: caught !== null, rows: await snapshot(h, [connector, leaf]) })
                .toEqual({ refused: true, rows: before });
        } finally {
            try {
                if (gate) await gate.query("ROLLBACK");
                if (moving) await moving;
                if (mover) await mover.query("ROLLBACK");
            } finally {
                gate?.release();
                mover?.release();
                await h.stop();
            }
        }
    });

    it("keeps the winning fresh insert's parent when a second creator waited for its claim", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        let winner, loser, losing;
        try {
            const a = randomUUID(), b = randomUUID(), connector = randomUUID(), leaf = randomUUID();
            await h.catalog.createSession(a, { owner: OWNER });
            await h.catalog.createSession(b, { owner: OWNER });
            winner = await h.pool.connect();
            loser = await h.pool.connect();
            const sql = `SELECT "${h.schema}".cms_create_session($1,NULL,NULL,$2,FALSE,NULL,NULL,NULL,NULL,NULL)`;
            await winner.query("BEGIN");
            await winner.query(sql, [connector, b]);
            losing = loser.query(sql, [connector, a]).then(() => null, error => error);
            const observed = await observeBlocked(h, loser.processID, winner.processID);
            await winner.query("COMMIT");
            expect(await losing).toBeNull();
            expect(observed.blocked).toBe(true);
            await h.catalog.createSession(leaf, { parentSessionId: connector, owner: OWNER });
            expect(await h.q("SELECT parent_session_id, root_session_id FROM SCHEMA.sessions WHERE session_id = $1", [connector]))
                .toEqual([{ parent_session_id: b, root_session_id: b }]);
            expect(await h.q("SELECT root_session_id FROM SCHEMA.sessions WHERE session_id = $1", [leaf]))
                .toEqual([{ root_session_id: b }]);
        } finally {
            try {
                if (winner) await winner.query("ROLLBACK");
                if (losing) await losing;
            } finally {
                winner?.release();
                loser?.release();
                await h.stop();
            }
        }
    });

    it("refuses a target purged between its insert conflict and row lock without recreating metrics", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        let purger, creator, creating;
        try {
            const id = randomUUID();
            await h.catalog.createSession(id, { owner: OWNER });
            await h.catalog.softDeleteSession(id);
            purger = await h.pool.connect();
            creator = await h.pool.connect();
            await purger.query("BEGIN");
            await purger.query(`SELECT session_id FROM "${h.schema}".sessions WHERE session_id = $1 FOR UPDATE`, [id]);
            creating = creator.query(`SELECT "${h.schema}".cms_create_session($1,NULL,NULL,NULL,FALSE,NULL,NULL,NULL,NULL,NULL)`,
                [id]).then(() => null, error => error);
            const observed = await observeBlocked(h, creator.processID, purger.processID);
            await purger.query(`DELETE FROM "${h.schema}".sessions WHERE session_id = $1`, [id]);
            await purger.query(`DELETE FROM "${h.schema}".session_metric_summaries WHERE session_id = $1`, [id]);
            await purger.query(`DELETE FROM "${h.schema}".session_metrics WHERE session_id = $1`, [id]);
            await purger.query("COMMIT");
            const caught = await creating;
            expect(observed.blocked).toBe(true);
            expect(caught?.message).toContain("SESSION_DISAPPEARED");
            expect(await snapshot(h, [id])).toEqual([]);
            expect(await metrics(h, id)).toEqual({ summaries: [], legacy: [] });
        } finally {
            try {
                if (purger) await purger.query("ROLLBACK");
                if (creating) await creating;
            } finally {
                purger?.release();
                creator?.release();
                await h.stop();
            }
        }
    });

    it("keeps active orphan continuation, resume and child admission without recreating the orphan", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        let create;
        try {
            const parent = randomUUID(), orphan = randomUUID(), grandchild = randomUUID();
            await h.catalog.createSession(parent, { owner: OWNER });
            await h.catalog.createSession(orphan, { parentSessionId: parent, owner: OWNER });
            await h.catalog.updateSession(orphan, { state: "idle", orchestrationId: `session-${orphan}` });
            const messages = [];
            const clientFor = () => {
                const client = new PilotSwarmClient({});
                client._catalog = h.catalog;
                // Persistence and public client paths are real; no model turn
                // is needed to observe continuation queueing.
                client._resolveCreationModel = async () => null;
                client.duroxideClient = {
                    getInstanceInfo: async () => ({ status: "Running" }),
                    getStatus: async () => ({ status: "Running", customStatusVersion: 1,
                        customStatus: JSON.stringify({ iteration: 1, responseVersion: 1 }) }),
                    enqueueEvent: async (id, queue, text) => messages.push({ id, queue, value: JSON.parse(text) }),
                    startOrchestrationVersioned: async () => { throw new Error("The existing orchestration must not be recreated."); },
                };
                return client;
            };
            const first = clientFor();
            const handle = await first.resumeSession(orphan);
            await h.catalog.softDeleteSession(parent);
            create = vi.spyOn(h.catalog, "createSession");
            await handle.send("Continue after parent deletion");
            const reopened = clientFor();
            await (await reopened.resumeSession(orphan)).send("Resume on another client");
            expect(create).not.toHaveBeenCalled();
            expect(messages.map(message => message.value.prompt))
                .toEqual(["Continue after parent deletion", "Resume on another client"]);
            expect(messages.every(message => message.id === `session-${orphan}` && message.queue === "messages")).toBe(true);

            const spawned = await reopened.createSession({ sessionId: grandchild, parentSessionId: orphan, nestingLevel: 2 });
            expect(await h.q("SELECT parent_session_id, deleted_at FROM SCHEMA.sessions WHERE session_id = $1", [grandchild]))
                .toEqual([{ parent_session_id: orphan, deleted_at: null }]);
            // Existing cold-start behavior is distinct from child admission:
            // starting a new orchestration refuses a missing/deleted ancestor.
            await expect(spawned.send("Start the new child")).rejects.toMatchObject({ code: "SESSION_LINEAGE_INVALID" });
            expect(messages).toHaveLength(2);
            expect((await h.q("SELECT deleted_at FROM SCHEMA.sessions WHERE session_id = $1", [parent]))[0].deleted_at).not.toBeNull();
        } finally {
            create?.mockRestore();
            await h.stop();
        }
    });
});
