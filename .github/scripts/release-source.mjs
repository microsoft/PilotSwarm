import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubApi, writeOutputs } from './pr-test-target.mjs';
import { validateRelease } from './release.mjs';

const packagePaths = ['sdk', 'horizon-store', 'app'].map(name => `packages/${name}`);
const shaPattern = /^[a-f0-9]{40}$/;
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();

export function nextDevVersion(tags) {
  let highest = 0n;
  for (const tag of tags) {
    const match = /^v0\.0\.0-dev\.(0|[1-9]\d*)$/.exec(tag);
    if (match && BigInt(match[1]) > highest) highest = BigInt(match[1]);
  }
  return `0.0.0-dev.${highest + 1n}`;
}

export function stampDevVersion(version, manifests, lock) {
  if (!/^0\.0\.0-dev\.(0|[1-9]\d*)$/.test(version)) throw new Error('Expected an allocated 0.0.0-dev.N version.');
  const names = new Set(manifests.map(p => p.name));
  const updateDependencies = p => {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(p[field] || {})) {
        if (names.has(name)) p[field][name] = version;
      }
    }
  };
  for (const [index, manifest] of manifests.entries()) {
    const entry = lock.packages?.[packagePaths[index]];
    if (!entry || entry.name !== manifest.name) throw new Error('Missing or mismatched workspace lockfile entry.');
    manifest.version = version;
    entry.version = version;
    updateDependencies(manifest);
  }
  for (const entry of Object.values(lock.packages)) updateDependencies(entry);
}

export async function resolveReleaseSource({ branch = '', workflowSha,
  workflowRef = 'refs/heads/main', repository, api, gitFn = git }) {
  if (!shaPattern.test(workflowSha || '') || !workflowRef.startsWith('refs/heads/')) throw new Error('Expected a captured branch workflow and full SHA.');
  if (!branch) {
    return { source_branch: workflowRef.slice('refs/heads/'.length), source_sha: workflowSha };
  }
  gitFn(['check-ref-format', `refs/heads/${branch}`]);
  const ref = await api(`repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (ref.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit' || !shaPattern.test(ref.object.sha || '')) {
    throw new Error('Select an existing branch in this repository.');
  }
  return { source_branch: branch, source_sha: ref.object.sha };
}

export function prepareDevSnapshot(version, sourceSha, { root = process.cwd(), gitFn = git } = {}) {
  if (!shaPattern.test(sourceSha || '') || gitFn(['-C', root, 'rev-parse', 'HEAD']) !== sourceSha) {
    throw new Error('Checkout differs from the source commit selected before approval.');
  }
  if (gitFn(['-C', root, 'status', '--porcelain', '--untracked-files=no'])) throw new Error('Snapshot preparation requires a clean source checkout.');
  const manifests = packagePaths.map(path => JSON.parse(readFileSync(resolve(root, path, 'package.json'), 'utf8')));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  stampDevVersion(version, manifests, lock);
  const changelog = `## [${version}]\n\nDevelopment snapshot of source commit ${sourceSha}.\n\n` +
    readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  validateRelease(version, manifests, lock, changelog);
  const files = packagePaths.map(path => `${path}/package.json`);
  for (const [index, path] of files.entries()) writeFileSync(resolve(root, path), JSON.stringify(manifests[index], null, 2) + '\n');
  writeFileSync(resolve(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  writeFileSync(resolve(root, 'CHANGELOG.md'), changelog);
  gitFn(['-C', root, 'add', ...files, 'package-lock.json', 'CHANGELOG.md']);
  gitFn(['-C', root, '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `Prepare development snapshot ${version} from ${sourceSha}`]);
  return gitFn(['-C', root, 'rev-parse', 'HEAD']);
}

export async function main(command, env = process.env, api = githubApi({ token: env.GH_TOKEN })) {
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_REF?.startsWith('refs/heads/') ||
      env.DEV_RELEASE !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Dev source preparation requires a dispatched dev release branch workflow.');
  }
  if (env.GITHUB_RUN_ATTEMPT !== '1') {
    throw new Error('Dispatch a new dev release instead of rerunning selection or allocating a different snapshot within a run.');
  }
  if (command === 'resolve') {
    const target = await resolveReleaseSource({ branch: env.SOURCE_BRANCH || '',
      workflowSha: env.GITHUB_SHA, workflowRef: env.GITHUB_REF,
      repository: env.GITHUB_REPOSITORY, api });
    writeOutputs(env.GITHUB_OUTPUT, target);
    appendFileSync(env.GITHUB_STEP_SUMMARY,
      `## Selected release source\n\nWorkflow: \`${env.GITHUB_REF}\` at \`${env.GITHUB_SHA}\`\n\n` +
      `Branch: \`${target.source_branch}\`\n\nSource commit: \`${target.source_sha}\`\n\n` +
      '**Dev release approval trusts the captured workflow/control code and selected source, including install/build/test code, with CI credentials and the Azure CI identity. Separate checkouts are not a sandbox. A version-only snapshot commit will be created and tested; the source branch is not modified.**\n');
  } else if (command === 'prepare') {
    const tags = git(['ls-remote', '--tags', '--refs', 'origin']).split('\n').map(line => line.split('refs/tags/')[1]);
    const releases = execFileSync('gh', ['api', '--paginate', `repos/${env.GITHUB_REPOSITORY}/releases?per_page=100`,
      '--jq', '.[].tag_name'], { encoding: 'utf8' }).trim().split('\n');
    const version = nextDevVersion([...tags, ...releases]);
    const sha = prepareDevSnapshot(version, env.RELEASE_SOURCE_SHA);
    writeOutputs(env.GITHUB_OUTPUT, { version, snapshot_sha: sha });
    appendFileSync(env.GITHUB_STEP_SUMMARY, `\nAllocated version: \`${version}\`\n\nTested snapshot commit: \`${sha}\`\n`);
  } else throw new Error('Expected resolve or prepare.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
