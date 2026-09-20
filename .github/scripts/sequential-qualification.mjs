import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { executionIdentity } from '../../scripts/vitest-run-health-reporter.mjs';

export const MAX_SEQUENTIAL_FAILURES = 5;
export const SEQUENTIAL_VITEST_ARGS = Object.freeze(['--no-file-parallelism', '--maxWorkers=1', '--maxConcurrency=1']);

function json(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`Missing or invalid ${label}.`); }
}

function evidence(source, reportFile) {
  const report = json(reportFile, `${source.id} test report`);
  const health = json(`${reportFile}.health.json`, `${source.id} run-health report`);
  const exit = json(`${reportFile}.exit.json`, `${source.id} process result`);
  const identity = executionIdentity(source.env);
  if (![0, 1].includes(exit.exitCode) || health.unhandledErrors !== 0 ||
      !['passed', 'failed'].includes(health.reason) ||
      health.sourceSha !== identity.sourceSha || health.environmentHash !== identity.environmentHash) {
    throw new Error(`${source.id}: interrupted, unhandled, or mismatched-source/provider execution cannot qualify.`);
  }
  if (!Array.isArray(report.testResults) || typeof report.success !== 'boolean') {
    throw new Error(`${source.id}: incomplete test results.`);
  }
  const cases = [];
  for (const suite of report.testResults) {
    if (typeof suite.name !== 'string' || !Array.isArray(suite.assertionResults) || suite.message) {
      throw new Error(`${source.id}: a suite-level setup/hook failure cannot qualify.`);
    }
    const file = relative(source.cwd, suite.name).split(sep).join('/');
    if (isAbsolute(file) || !/^test\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.test\.[cm]?[jt]s$/.test(file) ||
        file.split('/').includes('..')) throw new Error(`${source.id}: test file is outside the expected test tree.`);
    const suiteCases = suite.assertionResults.map(test => {
      if (typeof test.fullName !== 'string' || !test.fullName.trim() ||
          !['passed', 'failed', 'pending', 'skipped', 'todo'].includes(test.status)) {
        throw new Error(`${source.id}: incomplete test-case identity or status.`);
      }
      return { file, name: test.fullName, status: test.status };
    });
    const failed = suiteCases.some(test => test.status === 'failed');
    if ((suite.status === 'failed') !== failed) throw new Error(`${source.id}: non-case suite failure or inconsistent report.`);
    cases.push(...suiteCases);
  }
  const failed = cases.filter(test => test.status === 'failed');
  const passed = cases.filter(test => test.status === 'passed');
  if (!cases.length || passed.length + failed.length === 0 ||
      report.numTotalTests !== cases.length || report.numFailedTests !== failed.length ||
      report.numPassedTests !== passed.length || report.success !== (failed.length === 0) ||
      exit.exitCode !== (failed.length ? 1 : 0) || health.reason !== (failed.length ? 'failed' : 'passed')) {
    throw new Error(`${source.id}: empty, incomplete, or inconsistent test execution.`);
  }
  return { cases, failed, passed: passed.length, exitCode: exit.exitCode };
}

function caseKey(test) { return JSON.stringify([test.file, test.name]); }
function publicFailure(source, test) {
  return { source: source.id, file: test.file,
    caseId: createHash('sha256').update(caseKey(test)).digest('hex').slice(0, 16) };
}
function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The initial complete run remains immutable. One sequential verification of
 * at most five failed executions may qualify it; there is no repeat-until-pass.
 */
export function qualifySequentially({
  sources, initialResult, resultsDir, repoRoot, sourceSha = null, run, log = console.log, summaryFile,
}) {
  const result = { schemaVersion: 1, sourceSha, status: 'failed', limit: MAX_SEQUENTIAL_FAILURES,
    initialFailed: null, initial: [], failures: [], sequential: [], verified: 0 };
  try {
    if (!/^[a-f0-9]{40}$/i.test(sourceSha || '')) throw new Error('Release qualification requires the captured source SHA.');
    if (initialResult.error || initialResult.signal || ![0, 1].includes(initialResult.status)) {
      throw new Error('The initial complete run did not finish normally.');
    }
    if (!sources.length) throw new Error('The complete coverage plan is empty.');
    if (sources.some(source => (source.env.GITHUB_SHA || null) !== sourceSha)) {
      throw new Error('All provider phases must use the same tested source SHA.');
    }
    const initial = sources.map(source => ({ source, report: evidence(source, source.reportFile) }));
    for (const phase of new Set(sources.map(source => source.phase))) {
      const completion = json(join(resultsDir, `${phase}.complete.json`), `${phase} coverage completion`);
      const expected = initial.some(entry => entry.source.phase === phase && entry.report.exitCode !== 0) ? 1 : 0;
      if (completion.exitCode !== expected) throw new Error(`${phase}: an unresolved prerequisite or coverage failure remains.`);
    }
    for (const { source, report } of initial) {
      result.initial.push({ source: source.id, report: relative(resultsDir, source.reportFile),
        passed: report.passed, failed: report.failed.length });
      result.failures.push(...report.failed.map(test => publicFailure(source, test)));
    }
    const count = result.failures.length;
    result.initialFailed = count;
    if (initialResult.status !== (count ? 1 : 0)) throw new Error('The initial exit status has an unexplained failure.');
    if (count > MAX_SEQUENTIAL_FAILURES) {
      throw new Error(`${count} failed test cases exceed the limit of ${MAX_SEQUENTIAL_FAILURES}; no sequential verification is allowed.`);
    }
    if (count === 0) {
      result.status = 'passed';
      log('Release qualification: PASS on the complete initial run.');
      return result;
    }

    // Validate every selector before launching any verification.
    const groups = [];
    for (const { source, report } of initial) {
      const counts = new Map();
      for (const test of report.cases) counts.set(caseKey(test), (counts.get(caseKey(test)) || 0) + 1);
      const files = new Map();
      for (const test of report.failed) {
        if (counts.get(caseKey(test)) !== 1) throw new Error(`${source.id}: failed case names are ambiguous.`);
        const actual = relative(realpathSync(source.cwd), realpathSync(join(source.cwd, test.file)));
        if (actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new Error('Failed test resolves outside its project.');
        if (!files.has(test.file)) files.set(test.file, []);
        files.get(test.file).push(test);
      }
      for (const [file, tests] of files) groups.push({ source, file, tests });
    }
    log(`Initial run: ${count} failed cases. Verifying only those cases sequentially once.`);
    for (const [index, { source, file, tests }] of groups.entries()) {
      const output = join(resultsDir, `sequential-${index}.json`);
      for (const path of [output, `${output}.health.json`, `${output}.exit.json`]) rmSync(path, { force: true });
      const pattern = `^(?:${tests.map(test => escapeRegex(test.name)).join('|')})$`;
      const attempt = { source: source.id, file, report: relative(resultsDir, output), status: 'failed' };
      result.sequential.push(attempt);
      const execution = run(process.execPath, [
        join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', file,
        ...SEQUENTIAL_VITEST_ARGS, '--testNamePattern', pattern,
        '--reporter=default', '--reporter=json', `--outputFile=${output}`,
        `--reporter=${join(repoRoot, 'scripts/vitest-run-health-reporter.mjs')}`,
      ], { cwd: source.cwd, env: { ...source.env, PILOTSWARM_TEST_HEALTH_FILE: `${output}.health.json` }, stdio: 'inherit' });
      writeFileSync(`${output}.exit.json`, JSON.stringify({ exitCode: execution.status }), { mode: 0o600 });
      if (execution.error || execution.signal || execution.status !== 0) {
        throw new Error(`${source.id}: sequential verification failed; the release does not qualify.`);
      }
      const verified = evidence(source, output);
      const executed = verified.cases.filter(test => ['passed', 'failed'].includes(test.status));
      const expected = new Set(tests.map(caseKey));
      if (executed.length !== tests.length || executed.some(test => test.status !== 'passed' || !expected.delete(caseKey(test))) || expected.size) {
        throw new Error(`${source.id}: sequential results did not pass exactly every selected failed case.`);
      }
      result.verified += tests.length;
      Object.assign(attempt, { status: 'passed', verified: tests.length });
    }
    result.status = 'qualified';
    log(`Release qualification: PASS after sequential verification (${result.verified}/${count}); original failures retained.`);
    return result;
  } catch (error) {
    result.reason = error.message;
    log(`Release qualification: FAIL. ${error.message}`);
    throw error;
  } finally {
    writeFileSync(join(resultsDir, 'qualification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    if (summaryFile) {
      // Raw reports/case names can contain private values. Keep the published
      // summary to fixed labels and aggregate counts.
      appendFileSync(summaryFile, [
        '\n## Release test qualification', '',
        `- Outcome: **${result.status.toUpperCase()}**`,
        `- Initial failed cases: ${result.initialFailed ?? 'unknown (incomplete evidence)'}; limit: ${MAX_SEQUENTIAL_FAILURES}`,
        `- Sequentially verified cases: ${result.verified}`,
        '- Original test failures remain in the job log; private JSON reports are retained on the runner.',
        '',
      ].join('\n'));
    }
  }
}
