/**
 * The Claude keep-warm heartbeat's usage record (migration 0097) on PostgreSQL: each ping is a `heartbeat` row with its
 * reported nano AIU and raises the session totals by its tokens; a turn's own rows are not touched.
 *
 * Run: npx vitest run test/local/heartbeat-usage-ledger.integration.test.js
 */
import { describe, it, beforeAll } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";
import { heartbeatUsageMigration } from "../../src/migrations/heartbeat-usage-0097.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

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

const ping = (sessionId, n, extra = {}) => ({
    sessionId,
    model: "claude-opus-4.5",
    ping: n,
    status: 200,
    tokensInput: 9_005 + n, // inclusive: 5 uncached tokens plus the cache read
    tokensOutput: 0,
    tokensCacheRead: 9_000 + n,
    tokensCacheWrite: 0,
    totalNanoAiu: 1_000 * n,
    ...extra,
});

/** `@` stands for the test schema where a schema can go, as in provider-budgets.test.js. */
const q = async (env, text, params = []) =>
    (await directQuery(env, text.replace(/(^|[^\w"'])@([a-z_])/g, `$1"${env.cmsSchema}".$2`), params)).rows;

/** A shared provider and its user, made the way provider-budgets.test.js makes them. */
async function providerFixture(env, { provider = "hb-team", subject = "hb-alice" } = {}) {
    const owner = Number((await q(env,
        `INSERT INTO @users (provider, subject, email, display_name)
         VALUES ('test-idp', $1, $1 || '@example.test', $1)
         ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id`, [subject]))[0].user_id);
    await q(env, `SELECT * FROM @cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`,
        [provider, JSON.stringify({ apiKey: "k" })]);
    return { provider, model: `${provider}:claude-opus-4.5`, owner };
}

async function ownedSession(catalog, env, sid, owner, model) {
    await catalog.createSession(sid, { agentId: "ag-hb", model });
    await q(env, `INSERT INTO @session_owners (session_id, user_id) VALUES ($1, $2)
                  ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id`, [sid, owner]);
}

/** One settled turn, as the runtime settles it (cms_provider_settle_turn, 11 arguments). */
const settleTurn = (env, sid, turnIndex, { provider, model, owner, chargeClass = "user", input = 100, output = 10 }) =>
    q(env, `SELECT @cms_provider_settle_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS first`,
        [sid, turnIndex, provider, model, owner, chargeClass, "ag-hb", input, output, 0, 0]);

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

/** Turns and token totals of one provider from each of the eight counting report functions (admin view, 7 days). */
async function usageFigures(env, provider) {
    const first = async text => (await q(env, text, [provider]))[0];
    const pair = row => ({ total: Number(row.total), turns: Number(row.turns) });
    const fromList = list => ({
        total: list.reduce((sum, item) => sum + Number(item.total ?? 0), 0),
        turns: list.reduce((sum, item) => sum + Number(item.turns ?? 0), 0),
    });
    const summary = (await first(`SELECT @cms_provider_usage_summary(NULL, TRUE, 7, ARRAY[$1]::text[]) AS j`)).j;
    const agents = (await first(`SELECT @cms_provider_usage_agents(NULL, TRUE, 7, ARRAY[$1]::text[]) AS j`)).j;
    const agentsCluster = (await first(`SELECT @cms_provider_usage_agents_cluster(NULL, TRUE, 7, ARRAY[$1]::text[]) AS j`)).j;
    return {
        totals: pair(await first(`SELECT tokens_total AS total, turns FROM @cms_provider_usage_totals(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL)`)),
        daily: pair(await first(`SELECT COALESCE(sum(tokens_total), 0) AS total, COALESCE(sum(turns), 0) AS turns
                                   FROM @cms_provider_usage_daily(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL)`)),
        breakdown: pair(await first(`SELECT COALESCE(sum(tokens_total), 0) AS total, COALESCE(sum(turns), 0) AS turns
                                       FROM @cms_provider_usage_breakdown(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL, 'provider', 40)`)),
        breakdownCluster: pair(await first(`SELECT COALESCE(sum(tokens_total), 0) AS total, COALESCE(sum(turns), 0) AS turns
                                              FROM @cms_provider_usage_breakdown_cluster(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL, 'provider', 40)`)),
        summaryWindow: pair((await first(`SELECT @cms_provider_usage_summary_window(NULL, TRUE, now() - interval '1 day', ARRAY[$1]::text[]) AS j`)).j),
        summaryWeek: pair(summary.windows.week),
        summaryDaily: fromList(summary.daily),
        summaryModels: fromList(summary.models),
        summaryClasses: fromList(summary.classes),
        agents: fromList(agents.agents),
        agentsDaily: fromList(agents.daily),
        agentsCluster: fromList(agentsCluster.agents),
        agentsClusterDaily: fromList(agentsCluster.daily),
    };
}

async function withCatalog(run) {
    const env = getEnv();
    const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    try {
        await run(catalog, env);
    } finally {
        await catalog.close();
    }
}

describe("heartbeat usage ledger integration", () => {
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

    it("N pings make N heartbeat rows with the reported nano AIU, and raise the session totals by their tokens", async () => {
        await withCatalog(async (catalog, env) => {
            const sid = `heartbeat-ledger-${Date.now()}`;
            await catalog.createSession(sid, { agentId: "ag-hb", model: "claude-opus-4.5" });
            const seqs = [];
            for (const n of [1, 2, 3]) seqs.push(await catalog.recordHeartbeatUsage(ping(sid, n)));
            assertEqual(JSON.stringify(seqs), "[1,2,3]", "each ping is numbered in turn");

            const rows = (await directQuery(env, `
                SELECT ping_seq::int AS seq, gap_ping, usage_kind, total_nano_aiu::int AS nano, tokens_input::int AS input,
                       tokens_cache_read::int AS cache_read, http_status
                  FROM "${env.cmsSchema}".provider_heartbeat_usage WHERE session_id = $1 ORDER BY ping_seq`, [sid])).rows;
            assertEqual(rows.length, 3, "one row per ping");
            assertEqual(JSON.stringify(rows.map(row => row.usage_kind)), '["heartbeat","heartbeat","heartbeat"]', "usage_kind");
            assertEqual(JSON.stringify(rows.map(row => row.nano)), "[1000,2000,3000]", "total_nano_aiu is the value the ping reported");
            assertEqual(JSON.stringify(rows.map(row => row.gap_ping)), "[1,2,3]", "the handler's count inside the gap");
            assertEqual(JSON.stringify(rows.map(row => row.cache_read)), "[9001,9002,9003]", "cache read tokens per ping");
            assertEqual(rows[0].http_status, 200, "the ping's status");

            const metrics = (await directQuery(env, `
                SELECT tokens_input::int AS input, tokens_output::int AS output, tokens_cache_read::int AS cache_read,
                       heartbeat_count::int AS pings, heartbeat_nano_aiu::int AS nano
                  FROM "${env.cmsSchema}".session_metrics WHERE session_id = $1`, [sid])).rows[0];
            assertEqual(metrics.input, 27_021, "session input tokens rose by the pings' inclusive input tokens");
            assertEqual(metrics.output, 0, "session output tokens");
            assertEqual(metrics.cache_read, 27_006, "session cache read tokens");
            assertEqual(metrics.pings, 3, "heartbeat_count");
            assertEqual(metrics.nano, 6_000, "heartbeat_nano_aiu");
        });
    }, TIMEOUT);

    it("pings of one session recorded at once get distinct sequence numbers", async () => {
        await withCatalog(async (catalog, env) => {
            const sid = `heartbeat-concurrent-${Date.now()}`;
            await catalog.createSession(sid, { agentId: "ag-hb", model: "claude-opus-4.5" });
            const seqs = await Promise.all([1, 2, 3, 4, 5].map(n => catalog.recordHeartbeatUsage(ping(sid, n))));
            assertEqual(JSON.stringify([...seqs].sort((a, b) => a - b)), "[1,2,3,4,5]", "no two pings share a number");
            const count = (await directQuery(env, `SELECT count(*)::int AS n FROM "${env.cmsSchema}".provider_heartbeat_usage WHERE session_id = $1`, [sid])).rows[0].n;
            assertEqual(count, 5, "every ping has its row");
        });
    }, TIMEOUT);

    it("a turn's own rows are not changed by pings, and a ping never takes a turn's ledger key", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-turn-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            await settleTurn(env, sid, 0, fx);
            const startedAt = new Date(Date.now() - 1_000);
            const endedAt = new Date();
            await catalog.completeTurnWriteback({
                sessionId: sid, agentId: "ag-hb", model: "claude-opus-4.5", reasoningEffort: null, turnIndex: 1,
                startedAt, endedAt, durationMs: 1_000,
                tokensInput: 20, tokensOutput: 5, tokensCacheRead: 3, tokensCacheWrite: 1,
                toolCalls: 0, toolErrors: 0, toolNames: [], resultType: "completed", errorMessage: null, workerNodeId: "wk-hb",
                state: "idle", lastActiveAt: endedAt, lastError: null, waitReason: null, currentIteration: 1,
            });
            const ledger = async () => JSON.stringify((await directQuery(env,
                `SELECT * FROM "${env.cmsSchema}".provider_usage_ledger WHERE session_id = $1 AND usage_kind = 'turn' ORDER BY turn_index`, [sid])).rows);
            const turnRows = async () => JSON.stringify((await catalog.getSessionTurnMetrics(sid)).map(({ id, createdAt, ...row }) => row));
            const turnBefore = await turnRows();
            const ledgerBefore = await ledger();

            await catalog.recordHeartbeatUsage(ping(sid, 1));
            await catalog.recordHeartbeatUsage(ping(sid, 2));

            assertEqual(await turnRows(), turnBefore, "the turn's metrics row is unchanged");
            assertEqual(JSON.parse(ledgerBefore).length, 1, "the settled turn's ledger row is there");
            assertEqual(await ledger(), ledgerBefore, "the turn's ledger row is unchanged and no turn row was added by a ping");
            const pingKeys = (await directQuery(env,
                `SELECT turn_index FROM "${env.cmsSchema}".provider_usage_ledger WHERE session_id = $1 AND usage_kind = 'heartbeat' ORDER BY turn_index DESC`, [sid])).rows.map(row => row.turn_index);
            assertEqual(JSON.stringify(pingKeys), "[-1,-2]", "each ping has exactly one ledger row, on a key below every turn's");
            assert(Math.min(...JSON.parse(ledgerBefore).map(row => row.turn_index)) > Math.max(...pingKeys), "every ping key is below every turn key");
            const summary = await catalog.getSessionMetricSummary(sid);
            assertEqual(summary.tokensInput, 18_033, "the turn's 20 input tokens plus the pings' 18_013");
            assertEqual(summary.tokensOutput, 5, "the turn's output tokens");
        });
    }, TIMEOUT);

    it("a ping writes exactly one heartbeat ledger row, charged like the session's latest turn", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-charge-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            await settleTurn(env, sid, 0, fx);
            const turnRow = async () => JSON.stringify(await q(env,
                `SELECT * FROM @provider_usage_ledger WHERE session_id = $1 AND turn_index = 0`, [sid]));
            const turnBefore = await turnRow();
            const pings = [ping(sid, 1), ping(sid, 2)];
            for (const p of pings) await catalog.recordHeartbeatUsage(p);
            const rows = await q(env, `
                SELECT turn_index, provider_name, model_qualified, owner_user_id::int AS owner, charge_class, agent_id,
                       tokens_input::int AS input, tokens_output::int AS output, tokens_total::int AS total
                  FROM @provider_usage_ledger WHERE session_id = $1 AND usage_kind = 'heartbeat' ORDER BY turn_index DESC`, [sid]);
            assertEqual(JSON.stringify(rows), JSON.stringify(pings.map((p, i) => ({
                turn_index: -(i + 1), provider_name: fx.provider, model_qualified: fx.model, owner: fx.owner,
                charge_class: "user", agent_id: "ag-hb", input: p.tokensInput, output: p.tokensOutput,
                total: p.tokensInput + p.tokensOutput,
            }))), "one heartbeat row per ping, charged like the turn");
            assertEqual(await turnRow(), turnBefore, "the turn's row is unchanged");
        });
    }, TIMEOUT);

    it("a user ping raises the provider meters; a system session's ping is recorded but not metered", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const meters = async () => [await meterOf(env, fx.provider), await meterOf(env, fx.provider, fx.owner)];
            const sid = `heartbeat-meter-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            await settleTurn(env, sid, 0, fx);
            const before = await meters();
            const p = ping(sid, 1);
            await catalog.recordHeartbeatUsage(p);
            const after = await meters();
            const spent = p.tokensInput + p.tokensOutput;
            assertEqual(JSON.stringify(after), JSON.stringify([before[0] + spent, before[1] + spent]),
                "the provider's and the user's day meters rose by the ping's input plus output");

            const sys = `heartbeat-system-${Date.now()}`;
            await ownedSession(catalog, env, sys, fx.owner, fx.model);
            await settleTurn(env, sys, 0, { ...fx, chargeClass: "system" });
            await catalog.recordHeartbeatUsage(ping(sys, 1));
            const classes = await q(env,
                `SELECT charge_class FROM @provider_usage_ledger WHERE session_id = $1 AND usage_kind = 'heartbeat'`, [sys]);
            assertEqual(JSON.stringify(classes), '[{"charge_class":"system"}]', "the system session's ping is recorded as system");
            assertEqual(JSON.stringify(await meters()), JSON.stringify(after), "a system ping raises no meter");
        });
    }, TIMEOUT);

    it("a ping with no model reference and no turn before it is unattributed, keeps the owner and raises no meter", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-unattributed-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            await catalog.recordHeartbeatUsage(ping(sid, 1));
            const rows = await q(env,
                `SELECT turn_index, provider_name, charge_class, owner_user_id::int AS owner FROM @provider_usage_ledger WHERE session_id = $1`, [sid]);
            assertEqual(JSON.stringify(rows), JSON.stringify([{ turn_index: -1, provider_name: null, charge_class: "unattributed", owner: fx.owner }]),
                "one unattributed heartbeat row that keeps the session's owner");
            assertEqual(JSON.stringify([await meterOf(env, fx.provider), await meterOf(env, fx.provider, fx.owner)]), "[0,0]",
                "no meter row");
        });
    }, TIMEOUT);

    it("a ping before the session's first turn is charged to the provider it was sent to; a user ping is metered, a system ping is not", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-firstturn-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            const p = { ...ping(sid, 1), modelQualified: fx.model };
            await catalog.recordHeartbeatUsage(p);
            const rows = await q(env, `
                SELECT turn_index, provider_name, model_qualified, owner_user_id::int AS owner, charge_class, agent_id, usage_kind
                  FROM @provider_usage_ledger WHERE session_id = $1`, [sid]);
            assertEqual(JSON.stringify(rows), JSON.stringify([{
                turn_index: -1, provider_name: fx.provider, model_qualified: fx.model, owner: fx.owner,
                charge_class: "user", agent_id: "ag-hb", usage_kind: "heartbeat",
            }]), "one heartbeat row, charged to the provider of the ping's model");
            const spent = p.tokensInput + p.tokensOutput;
            const meters = async () => JSON.stringify([await meterOf(env, fx.provider), await meterOf(env, fx.provider, fx.owner)]);
            assertEqual(await meters(), JSON.stringify([spent, spent]), "the provider's and the user's day meters rose by the ping");

            const sys = `heartbeat-firstturn-system-${Date.now()}`;
            await catalog.createSession(sys, { agentId: "ag-hb", model: fx.model, isSystem: true });
            await catalog.recordHeartbeatUsage({ ...ping(sys, 1), modelQualified: fx.model });
            const sysRows = await q(env,
                `SELECT provider_name, charge_class FROM @provider_usage_ledger WHERE session_id = $1`, [sys]);
            assertEqual(JSON.stringify(sysRows), JSON.stringify([{ provider_name: fx.provider, charge_class: "system" }]),
                "the system session's ping is charged to the provider as system spend");
            assertEqual(await meters(), JSON.stringify([spent, spent]), "a system ping raises no meter");
        });
    }, TIMEOUT);

    it("after a provider change a ping is charged to the provider it was sent to, not to the latest turn's", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const other = await providerFixture(env, { provider: "hb-other" });
            const sid = `heartbeat-switch-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, other.model);
            await settleTurn(env, sid, 0, fx);
            const p = { ...ping(sid, 1), modelQualified: other.model };
            await catalog.recordHeartbeatUsage(p);
            const rows = await q(env, `
                SELECT provider_name, model_qualified, owner_user_id::int AS owner, charge_class
                  FROM @provider_usage_ledger WHERE session_id = $1 AND usage_kind = 'heartbeat'`, [sid]);
            assertEqual(JSON.stringify(rows), JSON.stringify([{
                provider_name: other.provider, model_qualified: other.model, owner: fx.owner, charge_class: "user",
            }]), "charged to the provider the ping was sent to");
            const spent = p.tokensInput + p.tokensOutput;
            assertEqual(JSON.stringify([await meterOf(env, other.provider), await meterOf(env, fx.provider)]),
                JSON.stringify([spent, 110]), "the new provider's meter rose by the ping; the old one holds only the turn's 100 + 10");
        });
    }, TIMEOUT);

    it("pings change no turn count and no next turn index; the token totals include them", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-reports-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            await settleTurn(env, sid, 0, fx);
            const nextIndex = async () => (await q(env, `SELECT @cms_provider_next_turn_index($1) AS n`, [sid]))[0].n;
            const nextBefore = await nextIndex();
            const before = await usageFigures(env, fx.provider);
            const pings = [ping(sid, 1), ping(sid, 2)];
            for (const p of pings) await catalog.recordHeartbeatUsage(p);
            const spent = pings.reduce((sum, p) => sum + p.tokensInput + p.tokensOutput, 0);
            const after = await usageFigures(env, fx.provider);
            for (const [name, figure] of Object.entries(before)) {
                assertEqual(after[name].turns, figure.turns, `${name}: turns unchanged by pings`);
                assertEqual(after[name].total, figure.total + spent, `${name}: total rose by the pings' input plus output`);
            }
            assertEqual(await nextIndex(), nextBefore, "the next turn index is unchanged");
            const kinds = (await q(env, `
                SELECT usage_kind FROM @cms_provider_usage_summary_rows_cluster(NULL, TRUE, now() - interval '1 day', ARRAY[$1]::text[])
                 ORDER BY turn_index DESC`, [fx.provider])).map(row => row.usage_kind);
            assertEqual(JSON.stringify(kinds), '["turn","heartbeat","heartbeat"]', "the cluster rows carry usage_kind");
        });
    }, TIMEOUT);

    it("a held provider is not clear, also for a session with no turn yet, and the check leaves the pause record as it was", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-paused-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            await settleTurn(env, sid, 0, fx);
            assertEqual(await catalog.heartbeatProviderClear(sid), true, "clear before the hold");
            await q(env, `SELECT @cms_provider_set_hold($1, NULL, TRUE, NULL, TRUE)`, [fx.provider]);
            assertEqual(await catalog.heartbeatProviderClear(sid), false, "not clear while the provider is held");
            const pause = await q(env, `SELECT pause_state FROM @sessions WHERE session_id = $1`, [sid]);
            assertEqual(JSON.stringify(pause), '[{"pause_state":null}]', "the check left the session unpaused");
            const listed = await q(env, `SELECT session_id FROM @cms_provider_paused_for($1)`, [fx.provider]);
            assertEqual(JSON.stringify(listed), "[]", "no budget wake would pick the session up");
            const fresh = `heartbeat-noturn-${Date.now()}`;
            await ownedSession(catalog, env, fresh, fx.owner, fx.model);
            assertEqual(await catalog.heartbeatProviderClear(fresh), false, "a session with no turn row is checked too: not clear while its provider is held");
            assertEqual(JSON.stringify(await q(env, `SELECT pause_state FROM @sessions WHERE session_id = $1`, [fresh])),
                '[{"pause_state":null}]', "the check left that session unpaused too");
        });
    }, TIMEOUT);

    it("no ping for a session that is gone or whose model is no longer the replayed request's", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-model-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            assertEqual(await catalog.heartbeatProviderClear(sid, fx.model), true, "the same model: clear");
            assertEqual(await catalog.heartbeatProviderClear(sid, "hb-elsewhere:claude-opus-4.5"), false, "the session's model changed: no ping");
            assertEqual(await catalog.heartbeatProviderClear(`heartbeat-gone-${Date.now()}`, fx.model), false, "no session: no ping");
        });
    }, TIMEOUT);

    it("a check puts back a pause the session already had, and any model it filled in", async () => {
        await withCatalog(async (catalog, env) => {
            const fx = await providerFixture(env);
            const sid = `heartbeat-restore-${Date.now()}`;
            await ownedSession(catalog, env, sid, fx.owner, fx.model);
            await settleTurn(env, sid, 0, fx);
            const earlier = { kind: "hold", provider: fx.provider, resetsAtUtc: null };
            await q(env, `UPDATE @sessions SET pause_state = $2::jsonb WHERE session_id = $1`, [sid, JSON.stringify(earlier)]);
            assertEqual(await catalog.heartbeatProviderClear(sid, fx.model), true, "the provider admits a turn now");
            const pause = await q(env, `SELECT pause_state FROM @sessions WHERE session_id = $1`, [sid]);
            assertEqual(JSON.stringify(pause), JSON.stringify([{ pause_state: earlier }]), "the pause the session had is back");

            const blank = `heartbeat-nomodel-${Date.now()}`;
            await ownedSession(catalog, env, blank, fx.owner, fx.model);
            await q(env, `UPDATE @users SET default_model = $2 WHERE user_id = $1`, [fx.owner, fx.model]);
            await q(env, `UPDATE @sessions SET model = NULL, reasoning_effort = NULL, context_tier = NULL, model_resolution_source = NULL
                           WHERE session_id = $1`, [blank]);
            const columns = async () => JSON.stringify(await q(env, `
                SELECT pause_state, model, reasoning_effort, context_tier, model_resolution_source, updated_at
                  FROM @sessions WHERE session_id = $1`, [blank]));
            const before = await columns();
            assertEqual(await catalog.heartbeatProviderClear(blank), true, "the provider of the owner's default model admits a turn");
            assertEqual(await columns(), before, "the check filled in no model and changed no column");
        });
    }, TIMEOUT);

    it("migration 0097 run again changes nothing, and the compatibility view shows the new columns", async () => {
        await withCatalog(async (catalog, env) => {
            const sid = `heartbeat-rerun-${Date.now()}`;
            await catalog.createSession(sid, { agentId: "ag-hb", model: "claude-opus-4.5" });
            await catalog.recordHeartbeatUsage(ping(sid, 1));
            await directQuery(env, `BEGIN; ${heartbeatUsageMigration(env.cmsSchema)} COMMIT;`);
            const rows = (await directQuery(env, `
                SELECT m.heartbeat_count::int AS pings, m.heartbeat_nano_aiu::int AS nano,
                       (SELECT count(*)::int FROM "${env.cmsSchema}".provider_heartbeat_usage h WHERE h.session_id = m.session_id) AS rows
                  FROM "${env.cmsSchema}".session_metric_summaries m WHERE m.session_id = $1`, [sid])).rows;
            assertEqual(rows.length, 1, "the view row");
            assertEqual(rows[0].pings, 1, "heartbeat_count through the view");
            assertEqual(rows[0].nano, 1_000, "heartbeat_nano_aiu through the view");
            assertEqual(rows[0].rows, 1, "the ping row survives a second run");
            assert(await catalog.getSession(sid), "the session is still readable");
        });
    }, TIMEOUT);
});
