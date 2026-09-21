import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveTestTarget, verifyTestTarget, validatePullRequest, testContext, resultStatus,
  selectionSummary, githubApi, main } from '../pr-test-target.mjs';
import { executionIdentity } from '../../../scripts/vitest-run-health-reporter.mjs';

const repository = 'microsoft/PilotSwarm';
const workflowSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const pr = { number: 84, state: 'open', base: { ref: 'main', repo: { full_name: repository } },
  head: { sha: candidateSha, repo: { full_name: 'contributor/PilotSwarm' } } };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ps-pr-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('blank PR input preserves the captured main source without GitHub lookups', async () => {
  const target = await resolveTestTarget({ repository, workflowSha, prNumber: ' ',
    api() { throw new Error('Unexpected lookup'); } });
  assert.deepEqual(target, { pr: '', sha: workflowSha, repository, directory: '.' });
});

test('fork and same-repository PRs resolve to their head SHA, never merge refs', async () => {
  for (const sourceRepository of ['contributor/PilotSwarm', repository]) {
    const calls = [];
    const target = await resolveTestTarget({ repository, workflowSha, prNumber: '84', actor: 'maintainer',
      triggeringActor: 'rerunner', api: async path => {
        calls.push(path);
        return path.includes('/collaborators/') ? { permission: 'write' }
          : { ...pr, head: { ...pr.head, repo: { full_name: sourceRepository } } };
      } });
    assert.deepEqual(target, { pr: '84', sha: candidateSha, repository: sourceRepository, directory: 'candidate' });
    assert.deepEqual(calls, [`repos/${repository}/collaborators/maintainer/permission`,
      `repos/${repository}/collaborators/rerunner/permission`, `repos/${repository}/pulls/84`]);
    const summary = selectionSummary(target, repository, workflowSha, testContext('all'));
    assert(summary.includes(candidateSha) && summary.includes(workflowSha));
    assert.match(summary, /Azure CI identity/);
    assert.match(summary, /not a sandbox/);
    assert.match(summary, /not a synthetic merge commit/);
  }
});

test('invalid PR inputs and workflow identities fail before API access', async () => {
  for (const prNumber of ['-1', '0', '084', 'refs/pull/84/head', '84\nsource_sha=bad', '9007199254740992']) {
    await assert.rejects(resolveTestTarget({ repository, workflowSha, prNumber,
      api() { throw new Error('Unexpected lookup'); } }), /positive pull request number/);
  }
  for (const input of [{ repository: '../invalid' }, { workflowSha: 'main' }]) {
    await assert.rejects(resolveTestTarget({ repository, workflowSha, ...input }), /captured full main/);
  }
});

test('both original and rerun actors need repository write permission', async () => {
  for (const deniedActor of ['maintainer', 'rerunner']) {
    await assert.rejects(resolveTestTarget({ repository, workflowSha, prNumber: '84', actor: 'maintainer',
      triggeringActor: 'rerunner', api: async path => {
        assert(path.includes('/collaborators/'), 'No candidate lookup before authorization');
        return { permission: path.includes(`/${deniedActor}/`) ? 'read' : 'admin' };
      } }), /writer or maintainer/);
  }
});

test('closed, wrong-target and missing-source PRs fail closed', () => {
  for (const candidate of [
    { ...pr, number: 85 }, { ...pr, state: 'closed' },
    { ...pr, base: { ...pr.base, ref: 'release' } },
    { ...pr, base: { ref: 'main', repo: { full_name: 'other/repository' } } },
  ]) assert.throws(() => validatePullRequest(candidate, repository, '84'), /open pull request/);
  for (const head of [null, { ...pr.head, sha: 'branch' }, { ...pr.head, repo: null },
    { ...pr.head, repo: { full_name: 'fork/repo\nextra=value' } }]) {
    assert.throws(() => validatePullRequest({ ...pr, head }, repository, '84'), /source repository/);
  }
});

test('approval rechecks the PR head and actual checkout before credentials are used', async () => {
  let gitCalls = 0;
  const input = { repository, prNumber: '84', sha: candidateSha, directory: 'candidate',
    api: async () => pr, git(command, args) {
      assert.equal(command, 'git');
      assert.deepEqual(args, ['-C', 'candidate', 'rev-parse', 'HEAD']);
      gitCalls++;
      return candidateSha + '\n';
    } };
  await verifyTestTarget(input);
  assert.equal(gitCalls, 1);
  await assert.rejects(verifyTestTarget({ ...input, api: async () => ({
    ...pr, head: { ...pr.head, sha: 'c'.repeat(40) },
  }) }), /head changed/);
  assert.equal(gitCalls, 1);
  await assert.rejects(verifyTestTarget({ ...input, git: () => workflowSha }), /checkout does not match/);
  await assert.rejects(verifyTestTarget({ ...input, directory: '../outside' }), /Invalid pinned/);
  await verifyTestTarget({ repository, sha: workflowSha, directory: '.', git: () => workflowSha });
});

test('results distinguish full from filtered coverage and fail closed on non-success', () => {
  assert.equal(testContext('all'), 'Tests / all');
  assert.equal(testContext('baseline', 'smoke'), 'Tests / baseline (filtered)');
  assert.equal(testContext('horizondb', 'test/local/example.test.js'), 'Tests / horizondb (filtered)');
  assert.throws(() => testContext('invalid'), /Unknown/);
  for (const [job, status] of [['success', 'success'], ['failure', 'failure'], ['cancelled', 'error'], ['skipped', 'error']]) {
    assert.equal(resultStatus(job).state, status);
  }
  assert.match(resultStatus('success').description, /initial vs sequential/);
  assert.throws(() => resultStatus(''), /unsupported/);
});

test('main-only manual control resolves and reports on the same pinned commit', async t => {
  const root = fixture(t);
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: repository, GITHUB_SHA: workflowSha, GITHUB_ACTOR: 'maintainer', GITHUB_RUN_ID: '123',
    PR_NUMBER: '84', GITHUB_RUN_ATTEMPT: '1', TEST_PROVIDERS: 'all', TEST_SUITE: '', GITHUB_OUTPUT: join(root, 'outputs'),
    GITHUB_STEP_SUMMARY: join(root, 'summary') };
  const statuses = [];
  const api = async (path, body) => {
    if (body) { statuses.push({ path, body }); return {}; }
    return path.endsWith('/permission') ? { permission: 'maintain' } : pr;
  };
  await main('resolve', env, api);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), new RegExp(`source_sha=${candidateSha}\\n`));
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /source_directory=candidate/);
  await main('report', { ...env, TEST_SOURCE_SHA: candidateSha, TEST_JOB_RESULT: 'success' }, api);
  assert.deepEqual(statuses.map(s => s.path), Array(2).fill(`repos/${repository}/statuses/${candidateSha}`));
  assert.deepEqual(statuses.map(s => s.body.state), ['pending', 'success']);
  assert(statuses.every(s => s.body.context === 'Tests / all' && s.body.target_url.endsWith('/runs/123')));
  await assert.rejects(main('resolve', { ...env, GITHUB_RUN_ATTEMPT: '2' }, api), /Dispatch a new PR test run/);
  for (const patch of [{ GITHUB_REF: 'refs/heads/topic' }, { GITHUB_ACTIONS: 'false' },
    { GITHUB_EVENT_NAME: 'pull_request_target' }]) {
    await assert.rejects(main('resolve', { ...env, ...patch }, api), /manually dispatched main/);
  }
});

test('GitHub API errors never echo response bodies or credentials', async () => {
  const api = githubApi({ token: 'fixture-token', fetchFn: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return { ok: false, status: 403, json() { throw new Error('sensitive body'); } };
  } });
  await assert.rejects(api(`repos/${repository}/pulls/84`), error =>
    /HTTP 403/.test(error.message) && !/fixture-token|sensitive/.test(error.message));
  const unreadable = githubApi({ token: 'fixture-token', fetchFn: async () => ({
    ok: true, json() { throw new Error('sensitive comment body'); },
  }) });
  await assert.rejects(unreadable(`repos/${repository}/issues/comments/456`), error =>
    /unreadable JSON/.test(error.message) && !/sensitive/.test(error.message));
});

test('workflow uses main controls, a pinned separate candidate and an isolated status reporter', () => {
  const workflow = readFileSync(new URL('../../workflows/tests.yml', import.meta.url), 'utf8');
  const resolver = workflow.split('\n  resolve:\n')[1].split('\n  tests:\n')[0];
  const tests = workflow.split('\n  tests:\n')[1].split('\n  report:\n')[0];
  const report = workflow.split('\n  report:\n')[1];
  assert.match(workflow, /workflow_dispatch:[\s\S]*pr_number:/);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:/);
  assert.match(resolver, /pull-requests: read/);
  assert.doesNotMatch(resolver, /secrets\.|environment:|id-token:|npm ci/);
  assert.match(tests, /environment: azure-deploy/);
  assert.match(tests, /needs\.resolve\.outputs\.pr_number == '' && needs\.resolve\.outputs\.providers == 'horizondb'/);
  assert.match(tests, /name:.*source_sha/);
  assert.match(tests, /ref: \$\{\{ needs\.resolve\.outputs\.source_sha \}\}\s+path: candidate/);
  assert(tests.indexOf('pr-test-target.mjs verify') < tests.indexOf('uses: azure/login'));
  assert.match(tests, /uses: \.\/\.github\/actions\/provider-tests\s+with:\s+working-directory: \$\{\{ needs\.resolve\.outputs\.source_directory \}\}\s+source-sha: \$\{\{ needs\.resolve\.outputs\.source_sha \}\}/);
  assert.doesNotMatch(tests, /statuses: write|contents: write/);
  assert.match(report, /always\(\) && needs\.resolve\.result == 'success'/);
  assert.match(report, /statuses: write/);
  assert.doesNotMatch(report, /path: candidate|environment:|secrets\.|id-token:|npm ci/);
  for (const block of [resolver, tests, report]) {
    assert.match(block, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(block, /persist-credentials: false/);
  }
});

test('composite action executes candidate tests with candidate identity and main control paths', t => {
  const text = readFileSync(new URL('../../actions/provider-tests/action.yml', import.meta.url), 'utf8');
  assert.match(text, /working-directory:\s+default: "\."/);
  for (const script of ['prepare-ci-tests', 'azure-ci-database', 'ci-health', 'run-all-providers']) {
    assert(text.includes(`/scripts/${script}.mjs`) || text.includes(`$CI_CONTROL_SCRIPTS/${script}.mjs`));
  }
  assert.doesNotMatch(text, /node \.github\/scripts\//);
  assert.match(text, /run: GITHUB_SHA="\$TEST_SOURCE_SHA" npm ci/);
  assert.match(text, /run: GITHUB_SHA="\$TEST_SOURCE_SHA" npm run build/);
  const block = text.split('    - name: Run tests\n')[1].split('    - name: Remove temporary')[0];
  const script = block.match(/      run: \|\n((?: {8}.*\n|\n)+)/)[1]
    .split('\n').map(line => line.slice(8)).join('\n');
  const root = fixture(t);
  const candidate = join(root, 'candidate');
  mkdirSync(join(candidate, 'scripts'), { recursive: true });
  writeFileSync(join(candidate, 'scripts/run-tests.sh'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$GITHUB_SHA" "$@" > "$CAPTURE"\n', { mode: 0o755 });
  const capture = join(root, 'capture');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: candidate, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: workflowSha, TEST_SOURCE_SHA: candidateSha,
      TEST_PROVIDERS: 'baseline', TEST_MODE: 'parallel', TEST_SUITE: '', CAPTURE: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  const recorded = readFileSync(capture, 'utf8').trim().split('\n');
  assert.equal(realpathSync(recorded[0]), realpathSync(candidate));
  assert.equal(recorded[1], candidateSha);
  assert.equal(executionIdentity({ GITHUB_SHA: recorded[1] }).sourceSha, candidateSha);
});
