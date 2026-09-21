import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { requireHorizonConfig } from './run-all-providers.mjs';

function errorCode(error) {
  return /^[A-Z0-9_]{2,40}$/.test(error?.code || '') ? error.code : 'CONNECTION_FAILED';
}

export function loadPg(cwd = process.cwd()) {
  return createRequire(resolve(cwd, 'package.json'))('pg');
}

export async function probeDatabase(connectionString, Client) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  const started = performance.now();
  const result = { ok: false, stage: 'connect' };
  client.on('error', error => { result.socketError = errorCode(error); });
  try {
    await client.connect();
    result.connectMs = Math.round(performance.now() - started);
    result.stage = 'query';
    const queried = performance.now();
    const { rows } = await client.query(`SELECT count(*)::int AS connections,
      current_setting('max_connections')::int AS max_connections FROM pg_stat_activity`);
    result.queryMs = Math.round(performance.now() - queried);
    result.connections = rows[0].connections;
    result.maxConnections = rows[0].max_connections;
    result.ok = true;
    result.stage = 'complete';
  } catch (error) {
    result.code = errorCode(error);
    result.elapsedMs = Math.round(performance.now() - started);
  } finally {
    try { await client.end(); }
    catch (error) { result.cleanupError = errorCode(error); }
  }
  if (result.socketError || result.cleanupError) result.ok = false;
  return result;
}

export function runnerResources(meminfo = readFileSync('/proc/meminfo', 'utf8')) {
  const mb = key => {
    const value = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm'));
    if (!value) throw new Error(`Missing runner memory counter ${key}.`);
    return Math.round(Number(value[1]) / 1024);
  };
  return { cpus: availableParallelism(), load: loadavg(), availableMB: mb('MemAvailable'), swapFreeMB: mb('SwapFree') };
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('CI health sampling runs only in Actions.');
  const config = requireHorizonConfig(process.env.HORIZONDB_TEST_ENV);
  const pg = loadPg();
  let stopping = false, timer, wake;
  const stop = () => { stopping = true; clearTimeout(timer); wake?.(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!stopping) {
      const [local, horizon] = await Promise.all([
        probeDatabase(config.DATABASE_URL, pg.Client),
        probeDatabase(config.HORIZON_DATABASE_URL, pg.Client),
      ]);
      console.log(JSON.stringify({ ciHealth: true, time: new Date().toISOString(), runner: runnerResources(), local, horizon }));
      if (!stopping) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 30_000); });
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('CI health sampler failed; private error details withheld.'); process.exitCode = 1; });
}
