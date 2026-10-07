import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { testStorageEnvironment, horizonSdkFiles } from '../../../../scripts/test-provider-plan.mjs';

const pg = 'postgresql://test@localhost/base';
const hdb = 'postgresql://test@hdb.invalid/db?sslmode=require';
const stale = {
  DATABASE_URL: pg, HORIZON_DATABASE_URL: hdb,
  PS_TEST_DATABASE_URL: pg, TEST_DATABASE_URL: pg,
  PILOTSWARM_RUNTIME_PROVIDER: 'horizondb', PILOTSWARM_RUNTIME_URL: 'postgresql://stale/runtime',
  PILOTSWARM_DUROXIDE_URL: 'postgresql://stale/duroxide',
  PILOTSWARM_SESSION_CATALOG_URL: 'postgresql://stale/cms',
  PILOTSWARM_FACTSTORE_URL: 'postgresql://stale/facts',
  PILOTSWARM_GRAPH_URL: 'postgresql://stale/graph', HORIZON_GRAPH_DATABASE_URL: 'postgresql://stale/graph',
  HORIZON_EMBED_API_KEY: 'fixture',
};

test('baseline clears HDB and stale routing overrides', () => {
  const env = testStorageEnvironment('baseline', stale);
  assert.equal(env.PILOTSWARM_RUNTIME_PROVIDER, 'postgres');
  assert.equal(env.DATABASE_URL, pg);
  assert.equal(env.PS_TEST_DATABASE_URL, pg);
  for (const key of ['HORIZON_DATABASE_URL', 'HORIZON_EMBED_API_KEY', 'PILOTSWARM_RUNTIME_URL', 'PILOTSWARM_DUROXIDE_URL', 'PILOTSWARM_SESSION_CATALOG_URL', 'PILOTSWARM_FACTSTORE_URL', 'PILOTSWARM_GRAPH_URL']) assert.equal(env[key], undefined);
});

test('full HDB routes CMS, orchestration and facts to the same real backend', () => {
  const env = testStorageEnvironment('horizondb', stale);
  const url = `${hdb}&uselibpqcompat=true`;
  for (const key of ['DATABASE_URL', 'PS_TEST_DATABASE_URL', 'TEST_DATABASE_URL', 'HORIZON_DATABASE_URL', 'HORIZON_GRAPH_DATABASE_URL']) assert.equal(env[key], url);
  assert.equal(env.PILOTSWARM_RUNTIME_PROVIDER, 'horizondb');
  assert.equal(env.PLAIN_DATABASE_URL, pg, 'plain PG retained only for missing-extension negative controls');
  assert.equal(env.PILOTSWARM_DUROXIDE_URL, undefined);
  assert.equal(env.PILOTSWARM_SESSION_CATALOG_URL, undefined);
  assert.equal(env.HORIZON_EMBED_API_KEY, 'fixture');
  assert.throws(() => testStorageEnvironment('horizondb', {}), /HORIZON_DATABASE_URL/);
});

test('additive coverage contains CMS, facts, compositions, live workers and recovery', () => {
  const files = horizonSdkFiles();
  for (const name of ['cms-state', 'pg-migrator', 'facts', 'facts-access-control', 'facts-provider-selection', 'composition-tiers.integration', 'enhanced-composition.integration', 'contracts', 'smoke-basic', 'durability', 'agent-handoff-routing']) {
    assert.ok(files.includes(`test/local/${name}.test.js`), name);
  }
  assert.ok(!files.includes('test/local/copilot-provider-compatibility.test.js'), 'synthetic HTTP permutations already covered on baseline');
});

test('new SDK suites receive HDB coverage automatically; stale exclusions fail', t => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'packages/sdk/test/local'), { recursive: true });
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'packages/sdk/test/local/new-storage.test.js'), '');
  const plan = join(dir, 'scripts/provider-test-coverage.json');
  writeFileSync(plan, JSON.stringify({ baselineOnly: [] }));
  assert.deepEqual(horizonSdkFiles(dir), ['test/local/new-storage.test.js']);
  writeFileSync(plan, JSON.stringify({ baselineOnly: ['test/local/deleted.test.js'] }));
  assert.throws(() => horizonSdkFiles(dir), /stale exclusions/);
});

test('shell routing treats quotes and substitutions in URLs as literal data', () => {
  const script = fileURLToPath(new URL('../../../../scripts/test-provider-plan.mjs', import.meta.url));
  const env = { ...process.env, DATABASE_URL: "postgresql://user:pa'ss$(false)`false`@localhost/base" };
  const output = execFileSync('bash', ['-c', 'routing="$(node "$1" env baseline)" || exit; eval "$routing"; node -e \'console.log(process.env.PS_TEST_DATABASE_URL)\'', 'test', script], { env, encoding: 'utf8' });
  assert.equal(output.trim(), env.DATABASE_URL);
});

// Execute the actual shell dispatcher in a disposable workspace. Substitute
// process boundaries only; the mode parser, environment routing and coverage
// selection are real. A missing/misdirected phase cannot hide behind a grep.
function runnerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'provider-dispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const sub of ['scripts', 'bin', 'packages/sdk/test/local', 'packages/app', 'packages/horizon-store']) mkdirSync(join(dir, sub), { recursive: true });
  for (const f of ['run-tests.sh', 'test-provider-plan.mjs', 'provider-test-coverage.json']) copyFileSync(join(root, 'scripts', f), join(dir, 'scripts', f));
  chmodSync(join(dir, 'scripts/run-tests.sh'), 0o755);
  for (const f of readdirSync(join(root, 'packages/sdk/test/local'), { recursive: true }).filter(f => f.endsWith('.test.js'))) {
    const target = join(dir, 'packages/sdk/test/local', f);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, '');
  }
  writeFileSync(join(dir, '.env'), `DATABASE_URL=${pg}\nGITHUB_TOKEN=fixture\n`);
  writeFileSync(join(dir, '.env.horizondb'), `DATABASE_URL=${pg}\nHORIZON_DATABASE_URL=${hdb}\nGITHUB_TOKEN=fixture\n`);
  const fake = `const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2), tool = path.basename(process.argv[1], '.cjs');
if (tool === 'node' && (args[0]?.endsWith('test-provider-plan.mjs') || args[0] === '-' || (args[0] === '-e' && !args[1].includes('show max_connections')))) {
  const r = cp.spawnSync(${JSON.stringify(process.execPath)}, args, {stdio:'inherit'}); process.exit(r.status ?? 1);
}
if (tool === 'node' && args[0] === '-e') { console.log('1500'); process.exit(0); }
if (args[0]?.endsWith('test-model-summary.mjs')) process.exit(0);
fs.appendFileSync(process.env.TRACE, JSON.stringify({tool,args,cwd:process.cwd(),db:process.env.DATABASE_URL,hdb:process.env.HORIZON_DATABASE_URL,workers:process.env.PS_TEST_MAX_WORKERS})+'\\n');
const output = args.find(a=>a.startsWith('--outputFile='));
if(output) fs.writeFileSync(output.slice('--outputFile='.length), JSON.stringify({success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,testResults:[{name:'test/local/smoke-basic.test.js',status:'passed',assertionResults:[{status:'passed'}]}]}));
`;
  const bashNode = process.platform === 'win32'
    ? `/${process.execPath[0].toLowerCase()}${process.execPath.slice(2).replaceAll('\\', '/')}`
    : process.execPath;
  for (const command of ['node', 'npm', 'npx']) {
    writeFileSync(join(dir, 'bin', `${command}.cjs`), fake);
    writeFileSync(join(dir, 'bin', command), `#!/bin/sh\nexec ${JSON.stringify(bashNode)} "$0.cjs" "$@"\n`);
    chmodSync(join(dir, 'bin', command), 0o755);
  }
  const trace = join(dir, 'trace');
  return (args) => {
    writeFileSync(trace, '');
    execFileSync('bash', [join(dir, 'scripts/run-tests.sh'), ...args], {
      cwd: dir, encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME,
        TRACE: trace, PS_TEST_SKIP_STALE_CLEANUP: '1' },
    });
    return readFileSync(trace, 'utf8').trim().split('\n').map(s => JSON.parse(s));
  };
}

test('all-providers executes the baseline once plus HDB selection without duplicate unit/build phases', t => {
  const calls = runnerFixture(t)(['--all-providers']);
  const sdk = calls.filter(c => c.tool === 'npx');
  assert.equal(sdk.length, 2);
  assert.equal(sdk[0].db, pg);
  assert.equal(sdk[0].hdb, undefined);
  assert.ok(!sdk[0].args.some(a => a.endsWith('.test.js')), 'baseline includes every suite');
  assert.equal(sdk[1].db, sdk[1].hdb);
  assert.deepEqual(sdk[1].args.filter(a => a.endsWith('.test.js')), horizonSdkFiles());
  assert.ok(sdk.every(c => c.workers === '8'));
  assert.equal(calls.filter(c => c.tool === 'node' && c.args.includes('--test')).length, 1, 'unit/API stage runs once');
  assert.equal(calls.filter(c => c.tool === 'npm' && c.cwd.endsWith(join('packages', 'sdk')) && c.args.includes('build')).length, 1);
  assert.equal(calls.filter(c => c.args.includes('test/integration')).length, 1);
});

test('both full-HDB spellings run the entire SDK suite on HDB, including CMS', t => {
  const run = runnerFixture(t);
  for (const args of [['--with-horizondb'], ['--with', 'horizondb']]) {
    const calls = run(args), sdk = calls.filter(c => c.tool === 'npx');
    assert.equal(sdk.length, 1);
    assert.equal(sdk[0].db, sdk[0].hdb);
    assert.ok(sdk[0].db.includes('hdb.invalid'));
    assert.ok(!sdk[0].args.some(a => a.endsWith('.test.js')), 'no additive filter in full HDB mode');
    assert.equal(calls.filter(c => c.args.includes('test/integration')).length, 1);
    assert.equal(calls.filter(c => c.tool === 'node' && c.args.includes('--test')).length, 1);
  }
});
