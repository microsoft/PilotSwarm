import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentTestRequest, verifyCommentRequest, writeOutputs, main } from '../pr-test-target.mjs';

const repository = 'microsoft/PilotSwarm';
const workflowSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const event = { action: 'created', repository: { full_name: repository }, sender: { login: 'maintainer' },
  issue: { number: 84, pull_request: { url: `https://api.github.com/repos/${repository}/pulls/84` } },
  comment: { id: 456, body: '/test all', user: { login: 'maintainer' } } };
const liveComment = { ...event.comment, issue_url: `https://api.github.com/repos/${repository}/issues/84` };
const pr = { number: 84, state: 'open', base: { ref: 'main', repo: { full_name: repository } },
  head: { sha: candidateSha, repo: { full_name: 'contributor/PilotSwarm' } } };

function outputs(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const result = {};
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    if (lines[i].includes('<<')) {
      const [name, delimiter] = lines[i].split('<<');
      const value = [];
      while (lines[++i] !== delimiter) {
        assert(i < lines.length, 'Unterminated output');
        value.push(lines[i]);
      }
      result[name] = value.join('\n');
    } else {
      const eq = lines[i].indexOf('=');
      result[lines[i].slice(0, eq)] = lines[i].slice(eq + 1);
    }
  }
  return result;
}

function fixture(t, payload = event) {
  const root = mkdtempSync(join(tmpdir(), 'ps-test-comment-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'issue_comment',
    GITHUB_REPOSITORY: repository, GITHUB_SHA: workflowSha, GITHUB_ACTOR: 'maintainer',
    GITHUB_TRIGGERING_ACTOR: 'maintainer', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_OUTPUT: join(root, 'outputs'),
    GITHUB_STEP_SUMMARY: join(root, 'summary') };
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
  const reads = [], writes = [];
  const api = async (path, body) => {
    if (body !== undefined) { writes.push({ path, body }); return {}; }
    reads.push(path);
    if (path.endsWith('/permission')) return { permission: 'write' };
    if (path.endsWith('/pulls/84')) return pr;
    if (path.endsWith('/issues/comments/456')) return liveComment;
    throw new Error(`Unexpected API read: ${path}`);
  };
  return { root, env, api, reads, writes };
}

test('a standalone PR command selects only the fixed full all-provider profile', () => {
  for (const body of ['/test all', '  /test all\r\n']) {
    assert.deepEqual(commentTestRequest({ ...event, comment: { ...event.comment, body } }, repository, 'maintainer'),
      { prNumber: '84', commentId: '456', providers: 'all', mode: 'parallel', suite: '' });
  }
});

test('unrelated, quoted, edited and ordinary-issue comments do not request tests', () => {
  for (const body of ['Looks good', 'Please run /test all', '> /test all', '```\n/test all\n```',
    '/test all --suite smoke', '/test all\nanother command', '/test ALL', '/test all; exit 0']) {
    assert.equal(commentTestRequest({ ...event, comment: { ...event.comment, body } }, repository, 'maintainer'), null);
  }
  for (const action of ['edited', 'deleted']) {
    assert.equal(commentTestRequest({ ...event, action }, repository, 'maintainer'), null);
  }
  assert.equal(commentTestRequest({ ...event, issue: { number: 84 } }, repository, 'maintainer'), null);
});

test('event repository, commenter, sender and numeric identities must match', () => {
  for (const patch of [
    { repository: { full_name: 'other/repo' } }, { sender: { login: 'outsider' } },
    { comment: { ...event.comment, user: { login: 'outsider' } } },
    { comment: { ...event.comment, id: '../456' } },
    { issue: { ...event.issue, number: -1 } },
  ]) assert.throws(() => commentTestRequest({ ...event, ...patch }, repository, 'maintainer'), /identity/);
});

test('authorized comment posts a run link and SHA, without workflow-dispatching as a bot', async t => {
  const f = fixture(t);
  await main('resolve', { ...f.env, PR_NUMBER: '999', TEST_PROVIDERS: 'baseline',
    TEST_MODE: 'sequential', TEST_SUITE: 'smoke' }, f.api);
  const selected = outputs(f.env.GITHUB_OUTPUT);
  assert.equal(selected.enabled, 'true');
  assert.equal(selected.pr_number, '84');
  assert.equal(selected.source_sha, candidateSha);
  assert.equal(selected.providers, 'all');
  assert.equal(selected.mode, 'parallel');
  assert.equal(selected.suite, '');
  assert.equal(selected.status_context, 'Tests / all');
  assert.deepEqual(f.writes.map(call => call.path), [
    `repos/${repository}/statuses/${candidateSha}`, `repos/${repository}/issues/84/comments`,
  ]);
  assert.match(f.writes[1].body.body, /@maintainer/);
  assert(f.writes[1].body.body.includes(candidateSha));
  assert.match(f.writes[1].body.body, /actions\/runs\/123/);
  assert.match(f.writes[1].body.body, /before approving `azure-deploy`/);
  assert.match(f.writes[1].body.body, /not a sandbox/);
  assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /pull\/84#issuecomment-456/);
  assert(f.reads.includes(`repos/${repository}/issues/comments/456`));
  assert(![...f.reads, ...f.writes.map(c => c.path)].some(path => path.includes('/dispatches')));
});

test('unrecognized comments produce no API calls or candidate outputs', async t => {
  const f = fixture(t, { ...event, comment: { ...event.comment, body: 'Example: /test all' } });
  await main('resolve', f.env, () => { throw new Error('No API calls for an ignored comment'); });
  assert.deepEqual(outputs(f.env.GITHUB_OUTPUT), { enabled: 'false' });
  assert.equal(existsSync(f.env.GITHUB_STEP_SUMMARY), false);
});

test('author association never substitutes for current repository write permission', async t => {
  for (const permission of ['none', 'read', 'triage']) {
    const f = fixture(t, { ...event, comment: { ...event.comment, author_association: 'OWNER' } });
    await assert.rejects(main('resolve', f.env, async (path, body) => {
      assert.equal(body, undefined);
      assert(path.endsWith('/collaborators/maintainer/permission'));
      return { permission };
    }), /writer or maintainer/);
    assert.equal(existsSync(f.env.GITHUB_OUTPUT), false);
    assert.equal(f.writes.length, 0);
  }
});

test('changed, rebound and deleted comments fail closed before approval', async t => {
  const request = commentTestRequest(event, repository, 'maintainer');
  for (const patch of [{ body: 'withdrawn' }, { user: { login: 'other-user' } },
    { issue_url: `https://api.github.com/repos/${repository}/issues/85` }, { id: 457 }]) {
    await assert.rejects(verifyCommentRequest(request, repository, 'maintainer',
      async () => ({ ...liveComment, ...patch })), /no longer authorizes/);
    const f = fixture(t);
    await assert.rejects(main('resolve', f.env, (path, body) => path.endsWith('/issues/comments/456')
      ? { ...liveComment, ...patch } : f.api(path, body)), /no longer authorizes/);
    assert.equal(f.writes.length, 0);
    assert.equal(existsSync(f.env.GITHUB_OUTPUT), false);
  }
  await assert.rejects(verifyCommentRequest(request, repository, 'maintainer',
    async () => { throw new Error('GitHub read failed (HTTP 404)'); }), /HTTP 404/);
});

test('the original command is rechecked after approval before running the candidate', async t => {
  const f = fixture(t);
  const env = { ...f.env, PR_NUMBER: '84', TEST_SOURCE_SHA: candidateSha, TEST_SOURCE_DIRECTORY: 'candidate' };
  await assert.rejects(main('verify', env, async () => ({ ...liveComment, body: 'withdrawn' })), /no longer authorizes/);
  await assert.rejects(main('verify', { ...env, PR_NUMBER: '85' }, f.api), /Comment and selected PR differ/);
  await assert.rejects(main('resolve', { ...f.env, GITHUB_RUN_ATTEMPT: '2' }, f.api), /post a new \/test all comment/);
});

test('comment-launched results still attach only to the resolved head', async t => {
  const f = fixture(t);
  await main('report', { ...f.env, PR_NUMBER: '84', TEST_SOURCE_SHA: candidateSha,
    TEST_PROVIDERS: 'all', TEST_SUITE: '', TEST_JOB_RESULT: 'failure' }, f.api);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].path, `repos/${repository}/statuses/${candidateSha}`);
  assert.equal(f.writes[0].body.state, 'failure');
  assert.equal(f.writes[0].body.context, 'Tests / all');
  await assert.rejects(main('report', { ...f.env, PR_NUMBER: '85' }, f.api), /Comment and selected PR differ/);
});

test('manual selectors and multiline suites survive output transport without injecting fields', async t => {
  const f = fixture(t);
  const suite = 'test/local/one.test.js\nsource_sha=unexpected\nmode=parallel';
  await main('resolve', { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch', PR_NUMBER: '84',
    TEST_PROVIDERS: 'horizondb', TEST_MODE: 'sequential', TEST_SUITE: suite }, f.api);
  const selected = outputs(f.env.GITHUB_OUTPUT);
  assert.equal(selected.providers, 'horizondb');
  assert.equal(selected.mode, 'sequential');
  assert.equal(selected.suite, suite);
  assert.equal(selected.source_sha, candidateSha);
  assert.equal(f.writes.length, 1, 'Manual dispatch does not post a command acknowledgement');
  await assert.rejects(main('resolve', { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch',
    TEST_MODE: 'unexpected' }, f.api), /Unknown test execution mode/);
  assert.throws(() => writeOutputs(join(f.root, 'invalid'), { 'invalid\nkey': 'value' }), /Invalid workflow output/);
});

test('blank manual selection retains main, baseline and parallel defaults', async t => {
  const f = fixture(t);
  await main('resolve', { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' },
    () => { throw new Error('Main requires no PR/comment lookups'); });
  const selected = outputs(f.env.GITHUB_OUTPUT);
  assert.equal(selected.enabled, 'true');
  assert.equal(selected.pr_number, '');
  assert.equal(selected.source_sha, workflowSha);
  assert.equal(selected.source_directory, '.');
  assert.equal(selected.providers, 'baseline');
  assert.equal(selected.mode, 'parallel');
});

test('only enabled test jobs acquire CI concurrency or environment credentials', () => {
  const workflow = readFileSync(new URL('../../workflows/tests.yml', import.meta.url), 'utf8');
  const resolver = workflow.split('\n  resolve:\n')[1].split('\n  tests:\n')[0];
  const tests = workflow.split('\n  tests:\n')[1].split('\n  report:\n')[0];
  const report = workflow.split('\n  report:\n')[1];
  assert.match(workflow, /issue_comment:\s+types: \[created\]/);
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.doesNotMatch(workflow, /pull_request_target:|actions: write/);
  assert.match(resolver, /github\.event\.issue\.pull_request && contains\(github\.event\.comment\.body, '\/test all'\)/);
  assert.match(resolver, /issues: write/);
  assert.doesNotMatch(resolver, /ci-provider-database|secrets\.|environment:|id-token:|npm ci/);
  assert.match(tests, /if: github\.ref == 'refs\/heads\/main' && needs\.resolve\.outputs\.enabled == 'true'/);
  assert.match(tests, /concurrency:\s+group: ci-provider-database\s+cancel-in-progress: false/);
  assert.doesNotMatch(tests, /issues: write|statuses: write|contents: write|inputs\./);
  for (const field of ['providers', 'mode', 'suite']) {
    assert(tests.includes(`${field}: \${{ needs.resolve.outputs.${field} }}`));
  }
  assert.match(tests, /qualify-failures:.*needs\.resolve\.outputs\.providers != 'baseline' && needs\.resolve\.outputs\.suite == ''/);
  assert.match(report, /needs\.resolve\.outputs\.enabled == 'true'/);
  assert.doesNotMatch(report, /inputs\.|issues: write|id-token:|secrets\./);
});
