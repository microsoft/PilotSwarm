import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
        turn_high, turn_base_seq, active_turn_index, title_locked, creation_config
        FROM SCHEMA.sessions WHERE session_id = ANY($1::text[]) ORDER BY session_id`, [ids]);
}

describe("FB-046: resurrection must not move a live subtree", () => {
    it.each(["catalog", 6, 7, 8, 9, 10])("refuses a parent-changing resurrection through %s", { timeout: TIMEOUT }, async overload => {
        const h = await openWorkflowStore(getEnv());
        try {
            const t = await tree(h);
            const before = await snapshot(h, [t.connector, t.leaf]);
            const caught = await createThrough(h, overload, t.connector, t.newRoot)
                .then(() => null, error => error);
            const after = await snapshot(h, [t.connector, t.leaf]);
            expect({ refused: caught !== null, rows: after }).toEqual({ refused: true, rows: before });
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

    it("preserves same-parent resurrection with live descendants", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const t = await tree(h);
            await createThrough(h, 10, t.connector, t.oldRoot);
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
});
