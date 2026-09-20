import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualifySequentially } from '../sequential-qualification.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sha = 'a'.repeat(40);

function fixture(t, { failedCount = 1, unhandled = false, cleanupFailure = false, hookFailure = false } = {}) {
  mkdirSync(join(repoRoot, '.tmp'), { recursive: true });
  const cwd = mkdtempSync(join(repoRoot, '.tmp/qualification-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'test'), { recursive: true });
  const resultsDir = join(cwd, 'results');
  mkdirSync(resultsDir);
  writeFileSync(join(cwd, 'vitest.config.mjs'), 'export default { test: { include: ["test/*.test.mjs"], pool: "forks", maxConcurrency: 32 } };');
  writeFileSync(join(cwd, 'test/sample.test.mjs'), `
    import { test, expect, beforeAll } from 'vitest';
    import { appendFileSync } from 'node:fs';
    let active = 0;
    ${hookFailure ? "beforeAll(() => { throw new Error('suite hook fixture'); });" : ''}
    test('already passed', () => { appendFileSync('executions', 'passed\\n'); expect(true).toBe(true); });
    ${Array.from({ length: failedCount ? failedCount + 1 : 0 }, (_, i) => `
      test.concurrent('candidate [${i}] (a+b)?', async () => {
        appendFileSync('executions', 'candidate-${i}\\n');
        active++;
        try {
          await new Promise(resolve => setImmediate(resolve));
          expect(active).toBe(1);
        } finally { active--; }
      });`).join('\n')}
    ${unhandled ? "test('unhandled fixture', async () => { queueMicrotask(() => { throw new Error('unhandled fixture'); }); await new Promise(resolve => setImmediate(resolve)); });" : ''}
  `);
  const env = { ...process.env, GITHUB_SHA: sha };
  delete env.GITHUB_STEP_SUMMARY;
  const reportFile = join(resultsDir, 'base.sdk.json');
  const source = { id: 'base/sdk', phase: 'base', cwd, reportFile, env };
  const script = readFileSync(join(repoRoot, 'scripts/run-tests.sh'), 'utf8');
  const recordFunction = script.match(/^run_recorded_vitest\(\) \{[\s\S]*?^\}/m)[0];
  const sdkFunction = script.match(/^run_sdk_vitest_and_summarize\(\) \{[\s\S]*?^\}/m)[0];
  const initialResult = spawnSync('bash', ['-c', `
    set -euo pipefail
    VITEST_PHASE_FAILED=0
    TEST_REPORT_PHASE=base
    SDK_DIR="$FIXTURE_SDK_DIR"
    VITEST_ARGS=(run)
    print_run_summary() { :; }
    cleanup_test_state() { printf 'cleanup\\n' >> "$CLEANUP_LOG"; return "$CLEANUP_FAILURE"; }
    trap cleanup_test_state EXIT
    ${recordFunction}
    ${sdkFunction}
    run_sdk_vitest_and_summarize
  `], { cwd, env: { ...env, REPO_ROOT: repoRoot, FIXTURE_SDK_DIR: relative(repoRoot, cwd),
    PILOTSWARM_TEST_RESULTS_DIR: resultsDir, CLEANUP_LOG: join(cwd, 'cleanup'),
    CLEANUP_FAILURE: cleanupFailure ? '1' : '0' }, encoding: 'utf8' });
  assert.equal(initialResult.status, failedCount || unhandled || cleanupFailure || hookFailure ? 1 : 0, initialResult.stdout + initialResult.stderr);
  assert.equal(readFileSync(join(cwd, 'cleanup'), 'utf8'), 'cleanup\n');
  return { source, cwd, resultsDir, initialResult };
}

for (const count of [1, 5]) {
test(`real Vitest verifies exactly ${count} failed cases sequentially and preserves the initial report`, { timeout: 60_000 }, t => {
  const f = fixture(t, { failedCount: count });
  const original = readFileSync(f.source.reportFile, 'utf8');
  let calls = 0;
  const result = qualifySequentially({
    sources: [f.source], initialResult: f.initialResult, resultsDir: f.resultsDir, repoRoot, sourceSha: sha,
    log() {},
    run(command, args, options) {
      calls++;
      for (const flag of ['--no-file-parallelism', '--maxWorkers=1', '--maxConcurrency=1']) assert(args.includes(flag));
      return spawnSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8' });
    },
  });
  assert.equal(result.status, 'qualified');
  assert.equal(result.verified, count);
  assert.equal(calls, 1);
  assert.equal(readFileSync(f.source.reportFile, 'utf8'), original);
  const executions = readFileSync(join(f.cwd, 'executions'), 'utf8').trim().split('\n');
  assert.equal(executions.filter(v => v === 'passed').length, 1);
  const cases = JSON.parse(original).testResults[0].assertionResults;
  assert.equal(cases.filter(c => c.status === 'failed').length, count);
  for (let i = 0; i <= count; i++) {
    const failed = cases.find(c => c.fullName === `candidate [${i}] (a+b)?`).status === 'failed';
    assert.equal(executions.filter(v => v === `candidate-${i}`).length, failed ? 2 : 1);
  }
});
}

test('real Vitest six-case failure never starts sequential verification', { timeout: 60_000 }, t => {
  const f = fixture(t, { failedCount: 6 });
  let calls = 0;
  assert.throws(() => qualifySequentially({
    sources: [f.source], initialResult: f.initialResult, resultsDir: f.resultsDir, repoRoot, sourceSha: sha,
    log() {}, run() { calls++; throw new Error('must not execute'); },
  }), /6 failed test cases exceed the limit of 5/);
  assert.equal(calls, 0);
});

test('real Vitest unhandled errors cannot be hidden by case verification', { timeout: 60_000 }, t => {
  const f = fixture(t, { unhandled: true });
  const health = JSON.parse(readFileSync(`${f.source.reportFile}.health.json`, 'utf8'));
  assert.equal(health.unhandledErrors, 1);
  assert.throws(() => qualifySequentially({
    sources: [f.source], initialResult: f.initialResult, resultsDir: f.resultsDir, repoRoot, sourceSha: sha,
    log() {}, run() { throw new Error('must not execute'); },
  }), /unhandled/);
});

test('real initial pass needs no verification, and cleanup failures never produce complete evidence', { timeout: 60_000 }, t => {
  const passed = fixture(t, { failedCount: 0 });
  assert.equal(qualifySequentially({
    sources: [passed.source], initialResult: passed.initialResult, resultsDir: passed.resultsDir, repoRoot, sourceSha: sha,
    log() {}, run() { throw new Error('must not execute'); },
  }).status, 'passed');
  const failed = fixture(t, { failedCount: 0, cleanupFailure: true });
  assert.equal(existsSync(join(failed.resultsDir, 'base.complete.json')), false);
  assert.throws(() => qualifySequentially({
    sources: [failed.source], initialResult: failed.initialResult, resultsDir: failed.resultsDir, repoRoot, sourceSha: sha,
    log() {}, run() { throw new Error('must not execute'); },
  }), /coverage completion/);
});

test('real suite-level hook failures cannot qualify as failed cases', { timeout: 60_000 }, t => {
  const f = fixture(t, { hookFailure: true });
  assert.throws(() => qualifySequentially({
    sources: [f.source], initialResult: f.initialResult, resultsDir: f.resultsDir, repoRoot, sourceSha: sha,
    log() {}, run() { throw new Error('must not execute'); },
  }), /suite-level setup\/hook/);
});
