/**
 * Claude keep-warm pings in the provider ledger: each ping is one keep_warm inference operation, claimed before it is sent
 * and settled with its reply's tokens.
 *
 * - A user session's ping moves the provider's day meter and the user's meter; a system session's is recorded and moves none.
 * - A ping is not a turn: the usage totals count its tokens, and the turn count and the chat ledger stay as they were.
 * - A provider created again under the same name after the request was captured: the claim is refused and leaves no row.
 * - A provider replaced between the claim and the settle: the settle succeeds and no meter of the new provider moves.
 * - The admission check of a ping (previewTurn) names a held provider as paused and a clear one with its name, and leaves the
 *   session row (pause_state, model, updated_at) as it was; the gate admits a running session and records its claim.
 * - A check that waits on a session row another transaction holds is given up by the database before the client deadline,
 *   and the gate refuses the ping and claims nothing.
 * - A settled ping and a stop are written as session.keepwarm_ping and session.keepwarm_stopped events, read back through
 *   the management client and the read_agent_events tool.
 *
 * Run: npx vitest run test/local/claude-keepwarm.integration.test.js
 */
import { describe, it, beforeAll, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { TEST_ADMIN_VIEWER } from "../helpers/inspect-viewer.js";
import { PgSessionCatalogProvider, PilotSwarmManagementClient, createInspectTools } from "../../src/index.ts";
import { KeepWarmLedger } from "../../src/keepwarm-ledger.ts";
import { SessionManager } from "../../src/session-manager.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const MODEL = "claude-opus-4.5";

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

/** `@` stands for the test schema where a schema can go, as in provider-budgets.test.js. */
const q = async (env, text, params = []) =>
    (await directQuery(env, text.replace(/(^|[^\w"'])@([a-z_])/g, `$1"${env.cmsSchema}".$2`), params)).rows;

const createProvider = (env, name, key) =>
    q(env, `SELECT * FROM @cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`, [name, JSON.stringify({ apiKey: key })]);

const instanceOf = async (env, name) =>
    (await q(env, `SELECT provider_instance_id::text AS id FROM @provider_instances WHERE name = $1`, [name]))[0].id;

/** A provider and its user, made the way provider-budgets.test.js makes them. */
async function providerFixture(env, { provider, subject }) {
    const owner = Number((await q(env,
        `INSERT INTO @users (provider, subject, email, display_name)
         VALUES ('test-idp', $1, $1 || '@example.test', $1)
         ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id`, [subject]))[0].user_id);
    await createProvider(env, provider, "k");
    return { provider, model: `${provider}:${MODEL}`, owner, instanceId: await instanceOf(env, provider) };
}

async function ownedSession(catalog, env, sid, fx, { isSystem = false, noModel = false } = {}) {
    await catalog.createSession(sid, noModel ? { agentId: "ag-kw" } : { agentId: "ag-kw", model: fx.model });
    await q(env, `INSERT INTO @session_owners (session_id, user_id) VALUES ($1, $2)
                  ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id`, [sid, fx.owner]);
    if (isSystem) await q(env, `UPDATE @sessions SET is_system = TRUE WHERE session_id = $1`, [sid]);
}

/** The day meter of a provider (scope '*'), or of one user on it; 0 when there is no row. */
async function meterOf(env, provider, owner = null) {
    const rows = owner === null
        ? await q(env, `SELECT m.used_tokens FROM @provider_meters m
                         CROSS JOIN LATERAL @cms_provider_window_bounds('day', now()) wb
                         WHERE m.provider_name = $1 AND m.period = 'day' AND m.scope = '*' AND m.window_key_utc = wb.window_key`,
            [provider])
        : await q(env, `SELECT m.used_tokens FROM @provider_meters_user m
                         CROSS JOIN LATERAL @cms_provider_window_bounds('day', now()) wb
                         WHERE m.provider_name = $1 AND m.user_id = $2 AND m.period = 'day' AND m.scope = '*'
                           AND m.window_key_utc = wb.window_key`,
            [provider, owner]);
    return rows.length === 0 ? 0 : Number(rows[0].used_tokens);
}

/** Tokens and turns of one provider as the usage report sees them (admin view, 7 days). */
const totalsOf = async (env, provider) => {
    const row = (await q(env, `SELECT tokens_total, turns FROM @cms_provider_usage_totals(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL)`, [provider]))[0];
    return { tokens: Number(row?.tokens_total ?? 0), turns: Number(row?.turns ?? 0) };
};

const ledgerRows = async (env, provider) =>
    Number((await q(env, `SELECT count(*)::int AS n FROM @provider_usage_ledger WHERE provider_name = $1`, [provider]))[0].n);

const operations = (env, provider) => q(env,
    `SELECT operation_id, capability, purpose, charge_class, provider_instance_id::text AS provider_instance_id,
            tokens_input, tokens_output, tokens_total, settled_at IS NOT NULL AS settled
       FROM @provider_inference_operations WHERE provider_name = $1 ORDER BY operation_id`, [provider]);

const reply = (n, extra = {}) => ({
    sessionId: "x", model: MODEL, ping: n, capturedAt: 1_700_000_000_000, status: 200, latencyMs: 12,
    usage: { input: 9_005, output: 3, cacheRead: 9_000, cacheWrite: 0 },
    ...extra,
});

async function withCatalog(run) {
    const env = getEnv();
    const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    try {
        await run(new KeepWarmLedger(catalog.providers), catalog, env);
    } finally {
        await catalog.close();
    }
}

/** One ping as the heartbeat makes it: the claim before the send, the settle with the reply. */
async function ping(ledger, fx, sessionId, n, extra = {}) {
    const claim = { sessionId, capturedAt: 1_700_000_000_000, ping: n, providerName: fx.provider, modelQualified: fx.model, providerInstanceId: fx.instanceId };
    const claimed = await ledger.claim(claim);
    const settled = claimed ? await ledger.settle(reply(n, { sessionId, ...extra })) : false;
    return { claimed, settled };
}

async function withLockedHeldSession(label, run) {
    const env = getEnv();
    const { default: pg } = await import("pg");
    const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const holder = new pg.Client({ connectionString: env.store });
    let closed = false;
    try {
        const fx = await providerFixture(env, { provider: `kw-lock-${label}`, subject: `kw-lock-${label}` });
        const sid = `kw-lock-${label}-${Date.now()}`;
        await ownedSession(catalog, env, sid, fx);
        // A held provider makes the check write the pause onto the session row, which the second connection has locked.
        await q(env, `SELECT @cms_provider_set_hold($1, NULL, TRUE, NULL, TRUE)`, [fx.provider]);
        await holder.connect();
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 FROM "${env.cmsSchema}".sessions WHERE session_id = $1 FOR UPDATE`, [sid]);
        await run(catalog, fx, sid, env);
        await catalog.close();
        closed = true;
    } finally {
        try { await holder.query("ROLLBACK"); } catch {}
        try { await holder.end(); } catch {}
        if (!closed) { try { await catalog.close(); } catch {} }
    }
}

describe("claude keep-warm provider ledger integration", () => {
    beforeAll(async () => {
        const env = getEnv();
        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString: env.store, connectionTimeoutMillis: 4000 });
        try {
            await client.connect();
            await client.query("SELECT 1");
        } finally {
            try { await client.end(); } catch {}
        }
    });

    it("a user session's ping is a keep_warm operation that raises the provider meter and the user's meter by its input plus output", async () => {
        await withCatalog(async (ledger, catalog, env) => {
            const fx = await providerFixture(env, { provider: "kw-user", subject: "kw-alice" });
            const sid = `kw-user-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx);
            const before = { team: await meterOf(env, fx.provider), user: await meterOf(env, fx.provider, fx.owner) };
            assertEqual(JSON.stringify(await ping(ledger, fx, sid, 1)), JSON.stringify({ claimed: true, settled: true }), "claimed and settled");
            const [row] = await operations(env, fx.provider);
            assertEqual(row.operation_id, `keepwarm:${sid}:1700000000000:1`, "the key names the session, the capture and the ping");
            assertEqual(`${row.capability}/${row.purpose}/${row.charge_class}`, "keep_warm/prompt_cache_ping/user", "recorded as a user keep_warm ping");
            assertEqual(row.provider_instance_id, fx.instanceId, "bound to the provider row captured with the request");
            assertEqual(Number(row.tokens_total), 9_008, "input plus output, the cache counts are not added");
            assertEqual(await meterOf(env, fx.provider), before.team + 9_008, "the provider's day meter moved");
            assertEqual(await meterOf(env, fx.provider, fx.owner), before.user + 9_008, "the user's day meter moved");
        });
    }, TIMEOUT);

    it("a system session's ping is recorded as a system operation and moves no meter", async () => {
        await withCatalog(async (ledger, catalog, env) => {
            const fx = await providerFixture(env, { provider: "kw-system", subject: "kw-sys" });
            const sid = `kw-system-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx, { isSystem: true });
            const before = { team: await meterOf(env, fx.provider), user: await meterOf(env, fx.provider, fx.owner) };
            assertEqual((await ping(ledger, fx, sid, 1)).settled, true, "settled");
            const [row] = await operations(env, fx.provider);
            assertEqual(row.charge_class, "system", "charged as a system session");
            assertEqual(Number(row.tokens_total), 9_008, "its tokens are recorded");
            assertEqual(await meterOf(env, fx.provider), before.team, "no provider meter");
            assertEqual(await meterOf(env, fx.provider, fx.owner), before.user, "no user meter");
        });
    }, TIMEOUT);

    it("a ping is not a turn: the usage totals count its tokens, and the turn count and the chat ledger stay as they were", async () => {
        await withCatalog(async (ledger, catalog, env) => {
            const fx = await providerFixture(env, { provider: "kw-turns", subject: "kw-carol" });
            const sid = `kw-turns-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx);
            await q(env, `SELECT @cms_provider_settle_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS first`,
                [sid, 0, fx.provider, fx.model, fx.owner, "user", "ag-kw", 100, 10, 0, 0]);
            const before = { totals: await totalsOf(env, fx.provider), rows: await ledgerRows(env, fx.provider) };
            await ping(ledger, fx, sid, 1);
            await ping(ledger, fx, sid, 2);
            const after = { totals: await totalsOf(env, fx.provider), rows: await ledgerRows(env, fx.provider) };
            assertEqual(after.totals.tokens, before.totals.tokens + 2 * 9_008, "the totals include both pings");
            assertEqual(after.totals.turns, before.totals.turns, "the turn count is the chat ledger's");
            assertEqual(after.rows, before.rows, "the chat ledger has no row for a ping");
            assert((await operations(env, fx.provider)).length === 2, "each ping is its own operation");
        });
    }, TIMEOUT);

    it("a provider created again under the same name after the request was captured is refused at the claim and leaves no row", async () => {
        await withCatalog(async (ledger, catalog, env) => {
            const fx = await providerFixture(env, { provider: "kw-recreate", subject: "kw-bob" });
            const sid = `kw-recreate-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx);
            await q(env, `DELETE FROM @provider_instances WHERE name = $1`, [fx.provider]);
            await createProvider(env, fx.provider, "k2");
            assert(await instanceOf(env, fx.provider) !== fx.instanceId, "the provider is a new incarnation");
            const result = await ping(ledger, fx, sid, 1);
            assertEqual(result.claimed, false, "the claim names the captured incarnation, which is gone");
            assertEqual((await operations(env, fx.provider)).length, 0, "no operation row");
            assertEqual(await meterOf(env, fx.provider), 0, "no meter");
        });
    }, TIMEOUT);

    it("a provider replaced between the claim and the settle: the settle succeeds and no meter of the new provider moves", async () => {
        await withCatalog(async (ledger, catalog, env) => {
            const fx = await providerFixture(env, { provider: "kw-swap", subject: "kw-dave" });
            const sid = `kw-swap-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx);
            assertEqual(await ledger.claim({ sessionId: sid, capturedAt: 1_700_000_000_000, ping: 1, providerName: fx.provider, modelQualified: fx.model, providerInstanceId: fx.instanceId }), true, "claimed");
            await q(env, `DELETE FROM @provider_instances WHERE name = $1`, [fx.provider]);
            await createProvider(env, fx.provider, "k2");
            const before = { team: await meterOf(env, fx.provider), user: await meterOf(env, fx.provider, fx.owner) };
            assertEqual(await ledger.settle(reply(1, { sessionId: sid })), true, "settled");
            const [row] = await operations(env, fx.provider);
            assertEqual(`${row.settled}/${Number(row.tokens_total)}`, "true/9008", "the ping's own row holds its tokens");
            assertEqual(row.provider_instance_id, fx.instanceId, "the row stays bound to the old incarnation");
            assertEqual(await meterOf(env, fx.provider), before.team, "the new provider's meter did not move");
            assertEqual(await meterOf(env, fx.provider, fx.owner), before.user, "the user's meter on it did not move");
        });
    }, TIMEOUT);

    it("previewTurn names a held provider as paused and leaves the session row as it was, while the real check records the pause", async () => {
        await withCatalog(async (ledger, catalog, env) => {
            const fx = await providerFixture(env, { provider: "kw-held", subject: "kw-erin" });
            const withModel = `kw-held-${Date.now()}`;
            const withoutModel = `kw-held-nomodel-${Date.now()}`;
            await ownedSession(catalog, env, withModel, fx);
            await ownedSession(catalog, env, withoutModel, fx, { noModel: true });
            const snapshot = async sid => JSON.stringify((await q(env,
                `SELECT pause_state, model, updated_at::text AS updated_at FROM @sessions WHERE session_id = $1`, [sid]))[0]);
            await q(env, `SELECT @cms_provider_set_hold($1, NULL, TRUE, NULL, TRUE)`, [fx.provider]);
            const preview = async sid => {
                const before = await snapshot(sid);
                const admission = await catalog.providers.previewTurn(sid, fx.model);
                assertEqual(await snapshot(sid), before, `the preview changed nothing on ${sid}`);
                return admission.verdict;
            };
            assertEqual(await preview(withModel), "paused", "a held provider is paused");
            // The database gives a session that has no model no provider, and would record that on the row; the preview does not.
            assertEqual(await preview(withoutModel), "no_provider", "a session with no model has no provider");
            assertEqual((await catalog.providers.checkTurn(withModel, fx.model)).verdict, "paused", "the real check is paused too");
            assert((await snapshot(withModel)).includes('"kind":"hold"'), "the real check is what records the pause, so the preview above kept the row only by rolling back");
        });
    }, TIMEOUT);

    it("previewTurn names a provider that is clear, and the gate admits a running session and records its claim", async () => {
        await withCatalog(async (ledger, catalog, env) => {
            const fx = await providerFixture(env, { provider: "kw-clear", subject: "kw-frank" });
            const sid = `kw-clear-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx);
            const admission = await catalog.providers.previewTurn(sid, fx.model);
            assertEqual(`${admission.verdict}/${admission.providerName}`, `clear/${fx.provider}`, "clear, with the provider's name");
            await q(env, `UPDATE @sessions SET state = 'running' WHERE session_id = $1`, [sid]);
            const manager = new SessionManager(undefined, null, {});
            manager.setSessionCatalog(catalog);
            const event = { sessionId: sid, model: MODEL, modelRef: fx.model, providerInstanceId: fx.instanceId, capturedAt: 1_700_000_000_000, ping: 1 };
            assertEqual(await manager.keepWarmAdmit(event), true, "a running session is admitted");
            const [row] = await operations(env, fx.provider);
            assertEqual(`${row.operation_id}/${row.settled}`, `keepwarm:${sid}:1700000000000:1/false`, "the claim is recorded and not yet settled");
        });
    }, TIMEOUT);

    it("previewTurn gives up on a session row another transaction holds, before the 6 s client deadline, and the catalog then closes", async () => {
        await withLockedHeldSession("preview", async (catalog, fx, sid) => {
            const started = performance.now();
            const error = await catalog.providers.previewTurn(sid, fx.model).then(() => null, caught => caught);
            const elapsed = performance.now() - started;
            assert(error !== null && ["55P03", "57014"].includes(error.code), `the check was refused by the database: ${error?.code ?? "it returned"} ${error?.message ?? ""}`);
            assert(elapsed < 6_000, `the lock gave way before the client deadline (${Math.round(elapsed)} ms)`);
        });
    }, 30_000);

    it("the gate refuses a ping when its admission check times out, and no operation is claimed", async () => {
        await withLockedHeldSession("gate", async (catalog, fx, sid, env) => {
            const manager = new SessionManager(undefined, null, {});
            manager.setSessionCatalog(catalog);
            const event = { sessionId: sid, model: MODEL, modelRef: fx.model, providerInstanceId: fx.instanceId, capturedAt: 1_700_000_000_000, ping: 1 };
            assertEqual(await manager.keepWarmAdmit(event), false, "a check that timed out is a refusal");
            assertEqual((await operations(env, fx.provider)).length, 0, "nothing was claimed");
        });
    }, 30_000);

    it("a settled ping and a stop are session events that the management client and read_agent_events return", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await mgmt.start();
        const savedFlag = process.env.PILOTSWARM_CLAUDE_KEEPWARM;
        process.env.PILOTSWARM_CLAUDE_KEEPWARM = "1";
        const manager = new SessionManager(undefined, null, {});
        try {
            const fx = await providerFixture(env, { provider: "kw-events", subject: "kw-grace" });
            const parent = `kw-events-parent-${Date.now()}`;
            const sid = `kw-events-${Date.now()}`;
            await catalog.createSession(parent, { agentId: "ag-kw" });
            await ownedSession(catalog, env, sid, fx);
            await q(env, `UPDATE @sessions SET state = 'running', parent_session_id = $2 WHERE session_id = $1`, [sid, parent]);
            // The manager does not wait for an event write, so each write's promise is kept to be awaited here.
            const writes = [];
            const recordEvents = catalog.recordEvents.bind(catalog);
            catalog.recordEvents = (...args) => { const write = recordEvents(...args); writes.push(write); return write; };
            manager.setSessionCatalog(catalog);
            const client = await manager.ensureClient(undefined, false, undefined, true);
            const { onPingUsage, onStop } = client.requestHandler.options;
            const capturedAt = 1_700_000_000_000;
            assertEqual(await manager.keepWarmAdmit({ sessionId: sid, model: MODEL, modelRef: fx.model, providerInstanceId: fx.instanceId, capturedAt, ping: 1 }), true);
            await onPingUsage({ sessionId: sid, model: MODEL, ping: 1, capturedAt, status: 200, latencyMs: 12, totalNanoAiu: 250_000, modelRef: fx.model, providerInstanceId: fx.instanceId,
                usage: { input: 9_005, output: 3, cacheRead: 9_000, cacheWrite: 0 } });
            onStop({ sessionId: sid, reason: "max-pings", pings: 1 });
            await Promise.all(writes);

            const expected = [
                { eventType: "session.keepwarm_ping", data: { ping: 1, status: 200, ok: true, model: MODEL, tokensInput: 9_005, tokensOutput: 3, tokensCacheRead: 9_000, tokensCacheWrite: 0, totalNanoAiu: 250_000, latencyMs: 12 } },
                { eventType: "session.keepwarm_stopped", data: { reason: "max-pings", pings: 1 } },
            ];
            const pick = rows => rows.map(({ eventType, data }) => ({ eventType, data }));
            expect(pick(await mgmt.getSessionEvents(sid, undefined, 100, ["session.keepwarm_ping", "session.keepwarm_stopped"]))).toEqual(expected);
            const tool = createInspectTools({ resolveViewer: TEST_ADMIN_VIEWER, catalog }).find(candidate => candidate.name === "read_agent_events");
            const read = await tool.handler({ agent_id: sid, event_types: ["session.keepwarm_ping", "session.keepwarm_stopped"] }, { sessionId: parent });
            expect(read.error).toBeUndefined();
            expect(pick(read.events)).toEqual(expected);
        } finally {
            manager.stopKeepWarmHeartbeats();
            if (savedFlag === undefined) delete process.env.PILOTSWARM_CLAUDE_KEEPWARM; else process.env.PILOTSWARM_CLAUDE_KEEPWARM = savedFlag;
            await mgmt.stop();
            await catalog.close();
        }
    }, TIMEOUT);
});
