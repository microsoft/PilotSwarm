import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

export function testContext(providers, suite = '') {
  if (!['baseline', 'all', 'horizondb'].includes(providers)) throw new Error('Unknown test provider selection.');
  return `Tests / ${providers}${suite.trim() ? ' (filtered)' : ''}`;
}

export function validatePullRequest(pr, repository, number) {
  if (pr.number !== Number(number) || pr.state !== 'open' ||
      pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() || pr.base?.ref !== 'main') {
    throw new Error('Select an open pull request targeting this repository main branch.');
  }
  if (!shaPattern.test(pr.head?.sha || '') || !repositoryPattern.test(pr.head?.repo?.full_name || '')) {
    throw new Error('The pull request has no accessible source repository and full commit SHA.');
  }
  return { pr: String(pr.number), sha: pr.head.sha, repository: pr.head.repo.full_name };
}

async function requireMaintainer(repository, actor, triggeringActor, api) {
  for (const login of new Set([actor, triggeringActor || actor])) {
    if (!/^[A-Za-z0-9_-]+(?:\[bot\])?$/.test(login || '')) throw new Error('Missing workflow actor.');
    const permission = await api(`repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`);
    if (!['write', 'maintain', 'admin'].includes(permission.permission)) {
      throw new Error('PR integration tests require a repository writer or maintainer, including on reruns.');
    }
  }
}

export async function resolveTestTarget({ repository, workflowSha, prNumber = '', actor, triggeringActor, api }) {
  if (!repositoryPattern.test(repository || '') || !shaPattern.test(workflowSha || '')) {
    throw new Error('Expected the workflow repository and captured full main commit SHA.');
  }
  const number = prNumber.trim();
  if (!number) return { pr: '', sha: workflowSha, repository, directory: '.' };
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) {
    throw new Error('pr_number must be a positive pull request number, not a branch or ref.');
  }
  await requireMaintainer(repository, actor, triggeringActor, api);
  const pr = await api(`repos/${repository}/pulls/${number}`);
  return { ...validatePullRequest(pr, repository, number), directory: 'candidate' };
}

export async function verifyTestTarget({ repository, prNumber = '', sha, directory, api, git = execFileSync }) {
  if (!repositoryPattern.test(repository || '') || !shaPattern.test(sha || '') ||
      directory !== (prNumber ? 'candidate' : '.')) throw new Error('Invalid pinned test target.');
  if (prNumber) {
    if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid pinned PR number.');
    const current = validatePullRequest(await api(`repos/${repository}/pulls/${prNumber}`), repository, prNumber);
    if (current.sha !== sha) throw new Error('PR head changed after selection. Dispatch a new run and approve its new SHA.');
  }
  const actual = git('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== sha) throw new Error('Test checkout does not match the approved candidate SHA.');
}

export function resultStatus(result) {
  const states = { success: 'success', failure: 'failure', cancelled: 'error', skipped: 'error' };
  if (!Object.hasOwn(states, result)) throw new Error('Missing or unsupported test job result.');
  return {
    state: states[result],
    description: result === 'success'
      ? 'Test gate succeeded; inspect the run for initial vs sequential qualification.'
      : `Test gate ${result}; no successful qualification is claimed.`,
  };
}

export function selectionSummary(target, repository, workflowSha, context) {
  return [
    '## Selected integration-test source', '',
    `- Candidate: [\`${target.sha}\`](https://github.com/${repository}/commit/${target.sha})`,
    `- Source repository: \`${target.repository}\``,
    `- Pull request: ${target.pr ? `[#${target.pr}](https://github.com/${repository}/pull/${target.pr})` : 'none (main)'}`,
    `- Trusted workflow/control commit: \`${workflowSha}\``,
    `- Result context: \`${context}\``, '',
    target.pr
      ? '**Approval trusts this exact PR head, including install scripts and tests, with the existing integration runner credentials (model/database credentials and its Azure CI identity). The separate main control checkout is not a sandbox. Review the entire candidate before approving.**'
      : 'Normal protected main-branch integration test run.',
    '',
    'This tests the selected head, not a synthetic merge commit. A newer PR head needs a new run and approval.',
    'This workflow does not publish a release or deploy an application.', '',
  ].join('\n');
}

export function githubApi({ token, fetchFn = fetch } = {}) {
  if (!token) throw new Error('A step-scoped GitHub token is required.');
  return async (path, body) => {
    const response = await fetchFn(`https://api.github.com/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${body === undefined ? 'read' : 'status update'} failed (HTTP ${response.status}); response withheld.`);
    return response.json();
  };
}

export async function main(command, env = process.env, api) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Maintainer test selection runs only in the manually dispatched main workflow.');
  }
  const repository = env.GITHUB_REPOSITORY;
  api ||= githubApi({ token: env.GH_TOKEN });
  if (command === 'resolve') {
    if (env.PR_NUMBER?.trim() && env.GITHUB_RUN_ATTEMPT !== '1') {
      throw new Error('Dispatch a new PR test run instead of rerunning source selection; the selected SHA must not change within a run.');
    }
    const context = testContext(env.TEST_PROVIDERS, env.TEST_SUITE);
    const target = await resolveTestTarget({ repository, workflowSha: env.GITHUB_SHA,
      prNumber: env.PR_NUMBER, actor: env.GITHUB_ACTOR, triggeringActor: env.GITHUB_TRIGGERING_ACTOR, api });
    appendFileSync(env.GITHUB_OUTPUT, `pr_number=${target.pr}\nsource_sha=${target.sha}\nsource_repository=${target.repository}\nsource_directory=${target.directory}\nstatus_context=${context}\n`);
    appendFileSync(env.GITHUB_STEP_SUMMARY, selectionSummary(target, repository, env.GITHUB_SHA, context));
    if (target.pr) await api(`repos/${repository}/statuses/${target.sha}`, {
      state: 'pending', context, description: 'Pinned PR head selected; awaiting approval and integration tests.',
      target_url: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
    });
  } else if (command === 'verify') {
    if (env.PR_NUMBER) await requireMaintainer(repository, env.GITHUB_ACTOR, env.GITHUB_TRIGGERING_ACTOR, api);
    await verifyTestTarget({ repository, prNumber: env.PR_NUMBER, sha: env.TEST_SOURCE_SHA,
      directory: env.TEST_SOURCE_DIRECTORY, api });
    console.log(`Verified test source ${env.TEST_SOURCE_SHA}; trusted controls remain at ${env.GITHUB_SHA}.`);
  } else if (command === 'report') {
    if (!repositoryPattern.test(repository || '') || !shaPattern.test(env.TEST_SOURCE_SHA || '') ||
        !/^[1-9]\d*$/.test(env.PR_NUMBER || '')) throw new Error('Missing resolved PR source for status reporting.');
    const status = resultStatus(env.TEST_JOB_RESULT);
    const context = testContext(env.TEST_PROVIDERS, env.TEST_SUITE);
    await api(`repos/${repository}/statuses/${env.TEST_SOURCE_SHA}`, {
      ...status, context, target_url: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
    });
    appendFileSync(env.GITHUB_STEP_SUMMARY,
      `## PR integration result\n\nPR #${env.PR_NUMBER}, commit \`${env.TEST_SOURCE_SHA}\`: **${env.TEST_JOB_RESULT.toUpperCase()}** (${context}).\n\nSee the test job for coverage and initial/sequential qualification. No newer head is covered by this result.\n`);
  } else throw new Error('Expected resolve, verify or report.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
