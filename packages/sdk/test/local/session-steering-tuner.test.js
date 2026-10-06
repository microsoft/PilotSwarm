/**
 * Session steering: tuner inspect tool `read_session_steering` (§11.3, ST-U09 part).
 * Seeded durable records through the real procedures; the actual handler;
 * visibility applied per call; no message text in the default response.
 *
 * Needs PostgreSQL: PS_TEST_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createInspectTools } from "../../src/inspect-tools.ts";
import { steeringContentHash } from "../../src/steering.ts";
import { TEST_ADMIN_VIEWER, testUserViewer } from "../helpers/inspect-viewer.js";

const url = process.env.PS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || "postgres://postgres:postgres@localhost:5432/pilotswarm";
const schema = `ps_test_steer_tuner_${randomUUID().replaceAll("-", "")}`;
const pool = new pg.Pool({ connectionString: url, max: 2 });
let catalog;
let sessionId;
const SECRET = "secret guidance text";

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
    sessionId = randomUUID();
    await catalog.createSession(sessionId, { model: "m", owner: { provider: "test", subject: "owner-1" } });
    const t = { epoch: 0, turnIndex: 2, incarnation: randomUUID() };
    const owner = randomUUID();
    await catalog.steerWindowOpen(sessionId, t, owner, 10_000);
    for (const text of [SECRET, "second"]) {
        await catalog.steerAccept({ sessionId, requestId: `steer_${randomUUID()}`, idempotencyKey: randomUUID(),
            actor: { kind: "user", provider: "test", subject: "owner-1" }, content: text, contentHash: steeringContentHash(text),
            epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation });
    }
    const [row] = await catalog.steerClaim(sessionId, owner, 1);
    const att = await catalog.steerMarkSubmitting(row.requestId, owner);
    await catalog.steerMarkSubmitted(att, owner, "sdk-1");
    await catalog.steerMarkDelivered(att, "sdk-1", "steering");
});

afterAll(async () => {
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

const tool = (tools) => tools.find((t) => t.name === "read_session_steering");

describe("read_session_steering", () => {
    it("is registered only in the tuner diagnostic bundle", () => {
        expect(tool(createInspectTools({ resolveViewer: TEST_ADMIN_VIEWER, catalog }))).toBeUndefined();
        expect(tool(createInspectTools({ resolveViewer: TEST_ADMIN_VIEWER, catalog, agentIdentity: "agent-tuner" }))).toBeDefined();
    });

    it("returns state, aggregates and attempt evidence without message text", async () => {
        const t = tool(createInspectTools({ resolveViewer: TEST_ADMIN_VIEWER, catalog, agentIdentity: "agent-tuner" }));
        const out = await t.handler({ session_id: sessionId, include_requests: true }, {});
        expect(out.supported).toBe(true);
        expect(out.state).toMatchObject({ steerable: true, unresolved: 2 });
        expect(out.stats.requests.accepted).toBe(2);
        expect(out.stats.attempts).toMatchObject({ deliveries: 1, deliveredByKind: { steering: 1 } });
        expect(out.requests.items).toHaveLength(2);
        expect(out.requests.items[0].attempts.items[0]).toMatchObject({ deliveryKind: "steering", outcome: "delivered" });
        expect(out.requests.truncated).toBe(false);
        expect(JSON.stringify(out)).not.toContain(SECRET);
    });

    it("applies the viewer's visibility on every call", async () => {
        const t = tool(createInspectTools({ resolveViewer: testUserViewer("someone-else"), catalog, agentIdentity: "agent-tuner" }));
        const out = await t.handler({ session_id: sessionId }, {});
        expect(out.error).toMatch(/not found/);
    });
});
