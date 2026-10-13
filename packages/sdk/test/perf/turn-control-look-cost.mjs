#!/usr/bin/env node
/**
 * Session turn control, phase A5: the cost of the worker's periodic look
 * and of its notification connection (design 7.1, 7.8; plan A5). Run by
 * hand against a disposable PostgreSQL database; it is not part of a suite
 * and has no pass/fail threshold. Results go into Docs.md with these
 * parameters.
 *
 *   npm run build   # the script uses dist/
 *   node --env-file=../../.env test/perf/turn-control-look-cost.mjs
 *
 * Environment:
 *   DATABASE_URL               the PostgreSQL database (required)
 *   PERF_TURNS                 live-turn counts, default "1,10,50"
 *   PERF_ITERATIONS            looks per count, default 200
 *   PERF_STEER_EVERY           one open steer per this many turns, default 5 (0: none)
 *   PERF_PORTAL_CONNECTIONS    connections the portal holds, default CMS + facts pool max
 *   PERF_CPU_PID               check this PID instead of the connection's backend (negative
 *                              control for the identity check: it must not report a number)
 *
 * It measures, for each live-turn count:
 *   - the look as the hub makes it: one batched turnLook round trip;
 *   - the server-side execution time of the same look (EXPLAIN ANALYZE
 *     execution time, all rows, no network), and pg_stat_statements time
 *     when the extension is installed;
 *   - database CPU per look: the same look on a dedicated connection, with
 *     that backend's CPU time read from /proc/<pid>/schedstat (nanoseconds;
 *     /proc/<pid>/stat ticks as a fallback). Only when the database runs on
 *     this host; otherwise the column says so.
 * then one hub's connections (exactly one LISTEN connection), and the
 * connection budget per worker from the deployment defaults.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { PgSessionCatalog, PgSessionCatalogProvider, PgFactStore } from "../../dist/index.js";
import { TurnControlHub } from "../../dist/turn-control.js";

const url = process.env.DATABASE_URL;
if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
}
const counts = (process.env.PERF_TURNS ?? "1,10,50").split(",").map((v) => Number.parseInt(v, 10)).filter((n) => n > 0);
const iterations = Number.parseInt(process.env.PERF_ITERATIONS ?? "200", 10);
const steerEvery = Number.parseInt(process.env.PERF_STEER_EVERY ?? "5", 10);
const schema = `perf_turn_control_${Date.now().toString(36)}`;

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), max: sorted.at(-1) };
};
const ms = (v) => v.toFixed(2);

const admin = new pg.Client({ connectionString: url });
await admin.connect();
const catalog = await PgSessionCatalogProvider.create(url, schema);
await catalog.initialize();

/**
 * Where the database CPU comes from. CPU is read from /proc only when the
 * sampled PID is provably the backend of this connection: its command line
 * (the PostgreSQL process title) names the same user, database and client
 * port that pg_stat_activity reports for pg_backend_pid(). Every other case
 * is reported by name, never as a number.
 */
function backendCpuSource(pid, identity) {
    if (!identity) return { status: "unknown: pg_stat_activity row not readable" };
    if (!existsSync(`/proc/${pid}`)) return { status: "not on this host" };
    let cmdline;
    try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch (err) {
        return { status: `unknown: procfs not readable (${err?.code ?? err?.message ?? err})` };
    }
    if (!cmdline.startsWith("postgres:")) return { status: "not the selected server (local PID is not a postgres backend)" };
    const title = `postgres: ${identity.user} ${identity.database} `;
    const port = `(${identity.port})`;
    if (identity.port == null) return { status: "unknown: no client port (unix socket); cannot verify the backend" };
    if (!cmdline.startsWith(title) || !cmdline.includes(port)) {
        return { status: `not the selected server (local PID ${pid} is "${cmdline.slice(0, 80)}")` };
    }
    const schedstat = existsSync(`/proc/${pid}/schedstat`);
    const read = () => {
        if (schedstat) {
            const ns = Number(readFileSync(`/proc/${pid}/schedstat`, "utf8").split(" ")[0]);
            if (!Number.isFinite(ns)) throw new Error("malformed /proc/<pid>/schedstat");
            return ns / 1e6;
        }
        const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
        const ticks = Number(fields[11]) + Number(fields[12]);              // utime + stime
        if (!Number.isFinite(ticks)) throw new Error("malformed /proc/<pid>/stat");
        return ticks * 10;                                                    // 100 ticks per second
    };
    try {
        read();
    } catch (err) {
        return { status: `unknown: ${err?.code ?? err?.message ?? err}` };
    }
    return { status: "ok", source: schedstat ? "/proc/<pid>/schedstat" : "/proc/<pid>/stat", read };
}
const cpuClient = new pg.Client({ connectionString: url });
await cpuClient.connect();
const cpuPid = (await cpuClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
const identity = await cpuClient.query(
    "SELECT usename AS user, datname AS database, client_port AS port FROM pg_stat_activity WHERE pid = pg_backend_pid()",
).then((r) => r.rows[0] ?? null).catch(() => null);
const cpu = backendCpuSource(process.env.PERF_CPU_PID ? Number(process.env.PERF_CPU_PID) : cpuPid, identity);

const hasStatements = (await admin.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'")).rowCount > 0;
const rows = [];
try {
    for (const n of counts) {
        const turns = [];
        for (let i = 0; i < n; i++) {
            const sessionId = randomUUID();
            await catalog.createSession(sessionId, { model: "perf" });
            await catalog.turnStart(sessionId, 1);
            if (steerEvery > 0 && i % steerEvery === 0) {
                await catalog.turnControlAdd(sessionId, "steer", "perf guidance", randomUUID(), null);
            }
            turns.push({ sessionId, turn: 1, after: 0 });
        }
        for (let i = 0; i < 10; i++) await catalog.turnLook(turns);     // warm the plan and the cache

        const roundTrip = [];
        for (let i = 0; i < iterations; i++) {
            const t0 = process.hrtime.bigint();
            await catalog.turnLook(turns);
            roundTrip.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }

        const lookArg = JSON.stringify(turns.map((t) => ({ session: t.sessionId, turn: t.turn, after: t.after })));
        const server = [];
        for (let i = 0; i < Math.min(iterations, 100); i++) {
            const { rows: r } = await admin.query(
                `EXPLAIN (ANALYZE, FORMAT JSON) SELECT sum(length(controls::text)) FROM ${schema}.cms_turn_look($1::jsonb)`,
                [lookArg],
            );
            const plan = r[0]["QUERY PLAN"][0];
            server.push(Number(plan["Execution Time"]));
        }
        // Database CPU: the same look on one known backend.
        const lookSql = `SELECT * FROM ${schema}.cms_turn_look($1::jsonb)`;
        for (let i = 0; i < 10; i++) await cpuClient.query(lookSql, [lookArg]);
        const cpuBefore = cpu.status === "ok" ? cpu.read() : null;
        for (let i = 0; i < iterations; i++) await cpuClient.query(lookSql, [lookArg]);
        const cpuPerLook = cpuBefore === null ? null : (cpu.read() - cpuBefore) / iterations;
        rows.push({ n, roundTrip: stats(roundTrip), server: stats(server), cpuPerLook });
    }

    let statementsLine = "pg_stat_statements: not installed";
    if (hasStatements) {
        const { rows: s } = await admin.query(
            `SELECT calls, total_exec_time, mean_exec_time FROM pg_stat_statements WHERE query ILIKE $1 ORDER BY calls DESC LIMIT 1`,
            [`%${schema}.cms_turn_look%`],
        );
        if (s[0]) statementsLine = `pg_stat_statements: ${s[0].calls} calls, mean ${ms(Number(s[0].mean_exec_time))} ms`;
    }

    // One hub: the connections it opens, by application_name.
    const hub = new TurnControlHub({ catalog, schema, createClient: () => catalog.createTurnControlListener() });
    await hub.start();
    const countListen = async () => Number((await admin.query(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'pilotswarm-turn-control'",
    )).rows[0].n);
    const listenWhileRunning = await countListen();
    await hub.stop();
    const listenAfterStop = await countListen();

    const setting = async (name) => {
        const r = await admin.query("SELECT setting FROM pg_settings WHERE name = $1", [name]);
        return r.rows[0] ? Number(r.rows[0].setting) : 0;
    };
    const maxConnections = await setting("max_connections");
    const reserved = (await setting("superuser_reserved_connections")) + (await setting("reserved_connections"));
    const cmsMax = Number.parseInt(process.env.PILOTSWARM_CMS_PG_POOL_MAX ?? "", 10) || PgSessionCatalog.DEFAULT_POOL_MAX;
    const factsMax = Number.parseInt(process.env.PILOTSWARM_FACTS_PG_POOL_MAX ?? "", 10) || PgFactStore.DEFAULT_POOL_MAX;
    const duroxideMax = Number.parseInt(process.env.DUROXIDE_PG_POOL_MAX ?? "", 10) || 10;
    const portal = Number.parseInt(process.env.PERF_PORTAL_CONNECTIONS ?? "", 10) || (cmsMax + factsMax);
    const perWorkerBefore = cmsMax + factsMax + duroxideMax;
    const perWorker = perWorkerBefore + 1;
    const available = maxConnections - reserved - portal;
    const { rows: version } = await admin.query("SHOW server_version");

    console.log(`# Turn control look cost (${new Date().toISOString()})`);
    console.log(`PostgreSQL ${version[0].server_version}; ${iterations} looks per count; one open steer per ${steerEvery || "no"} turns.`);
    console.log("");
    console.log("| Live turns | Round trip mean | p50 | p95 | max | Server mean | Server p95 | DB CPU per look |");
    console.log("|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const r of rows) {
        const cpuCell = r.cpuPerLook === null ? "n/a" : `${ms(r.cpuPerLook)} ms`;
        console.log(`| ${r.n} | ${ms(r.roundTrip.mean)} ms | ${ms(r.roundTrip.p50)} ms | ${ms(r.roundTrip.p95)} ms | ${ms(r.roundTrip.max)} ms | ${ms(r.server.mean)} ms | ${ms(r.server.p95)} ms | ${cpuCell} |`);
    }
    console.log("");
    console.log(cpu.status === "ok"
        ? `DB CPU: backend pid ${cpuPid} (verified: its process title names ${identity.user}, ${identity.database} and client port ${identity.port}), ${iterations} looks per count, source ${cpu.source}. At the 5 s look interval one worker's looks cost (CPU per look / 5,000 ms) of one core.`
        : `DB CPU: not measured, ${cpu.status} (backend pid ${cpuPid}).`);
    console.log("");
    console.log(statementsLine);
    console.log(`LISTEN connections: ${listenWhileRunning} while one hub runs, ${listenAfterStop} after stop.`);
    console.log("");
    console.log("| Connection budget | Value |");
    console.log("|---|---:|");
    console.log(`| max_connections | ${maxConnections} |`);
    console.log(`| reserved (superuser + reserved) | ${reserved} |`);
    console.log(`| portal | ${portal} |`);
    console.log(`| per worker before (CMS ${cmsMax} + facts ${factsMax} + duroxide ${duroxideMax}) | ${perWorkerBefore} |`);
    console.log(`| per worker with turn control (+1 listener) | ${perWorker} |`);
    console.log(`| workers that fit before | ${Math.floor(available / perWorkerBefore)} |`);
    console.log(`| workers that fit with turn control | ${Math.floor(available / perWorker)} |`);
} finally {
    await catalog.close?.();
    await cpuClient.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
}
