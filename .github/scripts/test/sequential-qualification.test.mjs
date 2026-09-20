import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qualifySequentially, MAX_SEQUENTIAL_FAILURES } from '../sequential-qualification.mjs';
import { executionIdentity } from '../../../scripts/vitest-run-health-reporter.mjs';

const sha = 'a'.repeat(40);
function writeEvidence(source, output, cases, overrides = {}) {
  const failed = cases.filter(c => c.status === 'failed').length;
  const report = {
    success: failed === 0, numTotalTests: cases.length, numFailedTests: failed,
    numPassedTests: cases.filter(c => c.status === 'passed').length,
    testResults: [{ name: join(source.cwd, 'test/local/sample.test.js'), status: failed ? 'failed' : 'passed',
      message: '', assertionResults: cases.map(c => ({ fullName: c.name, status: c.status })) }],
  };
  writeFileSync(output, JSON.stringify({ ...report, ...overrides }));
  writeFileSync(`${output}.health.json`, JSON.stringify({
    ...executionIdentity(source.env), unhandledErrors: 0, reason: failed ? 'failed' : 'passed',
  }));
  writeFileSync(`${output}.exit.json`, JSON.stringify({ exitCode: failed ? 1 : 0 }));
}

function fixture(t, counts = [1, 0]) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-qualification-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'packages/sdk');
  mkdirSync(join(cwd, 'test/local'), { recursive: true });
  writeFileSync(join(cwd, 'test/local/sample.test.js'), '');
  const sources = counts.map((count, i) => {
    const phase = i ? 'horizondb' : 'base';
    const source = { id: `${phase}/sdk`, phase, cwd, reportFile: join(dir, `${phase}.sdk.json`),
      env: { GITHUB_SHA: sha, DATABASE_URL: `postgresql://private.invalid/${phase}`,
        PILOTSWARM_RUNTIME_PROVIDER: i ? 'horizondb' : 'postgres' } };
    source.cases = [
      { name: 'already passed', status: 'passed' },
      ...Array.from({ length: count }, (_, index) => ({ name: `case [${index}] (a+b)?`, status: 'failed' })),
    ];
    writeEvidence(source, source.reportFile, source.cases);
    writeFileSync(join(dir, `${phase}.complete.json`), JSON.stringify({ exitCode: count ? 1 : 0 }));
    return source;
  });
  const calls = [];
  const logs = [];
  const input = { sources, initialResult: { status: counts.some(Boolean) ? 1 : 0 }, sourceSha: sha,
    resultsDir: dir, repoRoot: dir, summaryFile: join(dir, 'summary.md'), log: line => logs.push(line) };
  const run = (_command, args, options) => {
    calls.push({ args, options });
    const source = sources.find(s => s.env.DATABASE_URL === options.env.DATABASE_URL);
    assert(source);
    assert.equal(options.cwd, source.cwd);
    assert.equal(options.env.GITHUB_SHA, sha);
    for (const flag of ['--no-file-parallelism', '--maxWorkers=1', '--maxConcurrency=1']) assert(args.includes(flag));
    const pattern = new RegExp(args[args.indexOf('--testNamePattern') + 1]);
    assert.equal(pattern.test('already passed'), false);
    const selected = source.cases.map(c => ({ ...c, status: pattern.test(c.name) ? 'passed' : 'pending' }));
    const output = args.find(a => a.startsWith('--outputFile=')).slice('--outputFile='.length);
    writeEvidence(source, output, selected);
    return { status: 0 };
  };
  return { ...input, run, calls, logs, dir };
}

test('a complete initial pass needs no sequential execution', t => {
  const f = fixture(t, [0, 0]);
  assert.equal(qualifySequentially(f).status, 'passed');
  assert.equal(f.calls.length, 0);
});

test('qualification requires a captured source identity', t => {
  const f = fixture(t);
  assert.throws(() => qualifySequentially({ ...f, sourceSha: null }), /captured source SHA/);
  assert.equal(f.calls.length, 0);
});

for (let count = 1; count <= 5; count++) {
  test(`${count} total failures qualify only after every failed case passes sequentially`, t => {
    const f = fixture(t, [Math.ceil(count / 2), Math.floor(count / 2)]);
    const original = f.sources.map(s => readFileSync(s.reportFile, 'utf8'));
    const result = qualifySequentially(f);
    assert.equal(result.status, 'qualified');
    assert.equal(result.initialFailed, count);
    assert.equal(result.verified, count);
    assert.equal(f.calls.length, count === 1 ? 1 : 2);
    assert.deepEqual(f.sources.map(s => readFileSync(s.reportFile, 'utf8')), original);
    const summary = readFileSync(f.summaryFile, 'utf8');
    assert.match(summary, /QUALIFIED/);
    assert(!summary.includes('private.invalid') && !summary.includes('case ['));
  });
}

for (const counts of [[6, 0], [3, 3], [5, 1]]) {
  test(`six failures across ${counts.join('+')} fail without any sequential invocation`, t => {
    const f = fixture(t, counts);
    assert.equal(MAX_SEQUENTIAL_FAILURES, 5);
    assert.throws(() => qualifySequentially(f), /6 failed test cases exceed the limit of 5/);
    assert.equal(f.calls.length, 0);
    const result = JSON.parse(readFileSync(join(f.dir, 'qualification.json'), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.sequential.length, 0);
  });
}

test('a remaining failure is not tried again or accepted', t => {
  const f = fixture(t);
  let calls = 0;
  assert.throws(() => qualifySequentially({ ...f, run() { calls++; return { status: 1 }; } }), /sequential verification failed/);
  assert.equal(calls, 1);
});

for (const kind of ['missing target', 'skipped target', 'extra execution', 'unhandled error', 'wrong environment', 'wrong source', 'no report']) {
  test(`sequential ${kind} cannot qualify`, t => {
    const f = fixture(t);
    const source = f.sources[0];
    const output = join(f.dir, 'sequential-0.json');
    // A stale successful report must not hide a verifier that writes nothing.
    writeEvidence(source, output, source.cases.map(c => ({ ...c, status: 'passed' })));
    assert.throws(() => qualifySequentially({ ...f, run(command, args, options) {
      if (kind === 'no report') return { status: 0 };
      f.run(command, args, options);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      const health = JSON.parse(readFileSync(`${output}.health.json`, 'utf8'));
      if (kind === 'missing target') {
        writeEvidence(source, output, [{ name: 'different case', status: 'passed' }]);
      } else if (kind === 'skipped target') {
        writeEvidence(source, output, source.cases.map(c => ({ ...c, status: 'pending' })));
      } else if (kind === 'extra execution') {
        writeEvidence(source, output, source.cases.map(c => ({ ...c, status: 'passed' })));
      } else {
        if (kind === 'unhandled error') health.unhandledErrors = 1;
        if (kind === 'wrong environment') health.environmentHash = 'different';
        if (kind === 'wrong source') health.sourceSha = 'b'.repeat(40);
        writeFileSync(`${output}.health.json`, JSON.stringify(health));
        assert(report.success);
      }
      return { status: 0 };
    } }));
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'qualification.json'), 'utf8')).status, 'failed');
  });
}

for (const kind of ['interrupted', 'unhandled', 'suite hook', 'missing report', 'missing completion', 'bad counts', 'ambiguous names', 'empty coverage']) {
  test(`initial ${kind} fails closed without sequential execution`, t => {
    const f = fixture(t);
    const source = f.sources[0];
    if (kind === 'interrupted') f.initialResult.signal = 'SIGTERM';
    if (kind === 'unhandled') {
      const path = `${source.reportFile}.health.json`;
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), unhandledErrors: 1 }));
    }
    if (kind === 'suite hook') {
      const r = JSON.parse(readFileSync(source.reportFile, 'utf8'));
      r.testResults[0].message = 'beforeAll failed';
      writeFileSync(source.reportFile, JSON.stringify(r));
    }
    if (kind === 'missing report') rmSync(source.reportFile);
    if (kind === 'missing completion') rmSync(join(f.dir, 'base.complete.json'));
    if (kind === 'bad counts') writeEvidence(source, source.reportFile, source.cases, { numFailedTests: 0 });
    if (kind === 'ambiguous names') writeEvidence(source, source.reportFile, [...source.cases, source.cases[1]]);
    if (kind === 'empty coverage') writeEvidence(source, source.reportFile, []);
    assert.throws(() => qualifySequentially(f));
    assert.equal(f.calls.length, 0);
    assert(existsSync(join(f.dir, 'qualification.json')));
  });
}
