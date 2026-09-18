import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const routingKeys = [
  'PILOTSWARM_RUNTIME_PROVIDER', 'PILOTSWARM_RUNTIME_URL',
  'PILOTSWARM_SESSION_CATALOG_URL', 'PILOTSWARM_RUNTIME_SESSION_CATALOG_URL',
  'PILOTSWARM_FACTSTORE_URL', 'PILOTSWARM_RUNTIME_FACTS_URL',
  'PILOTSWARM_DUROXIDE_URL', 'PILOTSWARM_DUROXIDE_PROVIDER',
  'PILOTSWARM_GRAPH_URL', 'PILOTSWARM_GRAPH_ENABLED',
];

export function testStorageEnvironment(mode, input) {
  const env = { ...input };
  for (const key of routingKeys) delete env[key];
  if (mode === 'baseline') {
    for (const key of Object.keys(env)) {
      if (key.startsWith('HORIZON_') || key.startsWith('PILOTSWARM_EMBED_')) delete env[key];
    }
    if (!env.DATABASE_URL) throw new Error('Baseline tests require DATABASE_URL for stock PostgreSQL.');
    env.PILOTSWARM_RUNTIME_PROVIDER = 'postgres';
  } else if (mode === 'horizondb') {
    if (!env.HORIZON_DATABASE_URL) throw new Error('HorizonDB tests require HORIZON_DATABASE_URL.');
    const url = new URL(env.HORIZON_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('HorizonDB requires a PostgreSQL connection URL.');
    if (url.searchParams.get('sslmode') === 'require' && !url.searchParams.has('uselibpqcompat')) {
      url.searchParams.set('uselibpqcompat', 'true');
    }
    // Only missing-extension negative controls use a separate plain server.
    if (!env.PLAIN_DATABASE_URL && env.DATABASE_URL !== env.HORIZON_DATABASE_URL) env.PLAIN_DATABASE_URL = env.DATABASE_URL;
    env.DATABASE_URL = url.href;
    env.HORIZON_DATABASE_URL = url.href;
    env.HORIZON_GRAPH_DATABASE_URL = url.href;
    env.PILOTSWARM_RUNTIME_PROVIDER = 'horizondb';
  } else throw new Error(`Unknown test storage mode: ${mode}`);
  env.PS_TEST_DATABASE_URL = env.DATABASE_URL;
  env.TEST_DATABASE_URL = env.DATABASE_URL;
  return env;
}

export function horizonSdkFiles(repoRoot = root) {
  const sdk = resolve(repoRoot, 'packages/sdk');
  const files = readdirSync(resolve(sdk, 'test/local'), { recursive: true })
    .filter(f => f.endsWith('.test.js')).map(f => `test/local/${f.replaceAll('\\', '/')}`).sort();
  const plan = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/provider-test-coverage.json'), 'utf8'));
  const excluded = new Set(plan.baselineOnly);
  if (excluded.size !== plan.baselineOnly.length || [...excluded].some(f => !files.includes(f))) {
    throw new Error('Provider coverage inventory contains duplicate or stale exclusions. Review provider-test-coverage.json.');
  }
  const selected = files.filter(f => !excluded.has(f));
  if (!selected.length) throw new Error('HorizonDB SDK coverage must not be empty.');
  return selected;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === 'list') console.log(horizonSdkFiles().join('\n'));
  else if (process.argv[2] === 'env') {
    // Shell-quote every value, including credentials; output is consumed via
    // eval by the runner and is never logged. No input is interpreted as code.
    const env = testStorageEnvironment(process.argv[3], process.env);
    for (const key of [...routingKeys, ...Object.keys(process.env).filter(k => k.startsWith('HORIZON_') || k.startsWith('PILOTSWARM_EMBED_'))]) {
      if (!(key in env)) console.log(`unset ${key}`);
    }
    for (const [key, value] of Object.entries(env)) {
      if (env[key] !== process.env[key] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`);
      }
    }
  } else throw new Error('Expected list or env MODE.');
}
