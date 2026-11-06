import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseOptions, validateRelease, validatePackageLicenses, validatePackedLicense, addReleaseLicense } from '../release.mjs';
import { nextDevVersion, stampDevVersion, resolveReleaseSource, prepareDevSnapshot, main as selectRelease } from '../release-source.mjs';
const version = '0.6.0';
const manifests = [{ name: 'pilotswarm-sdk', version, peerDependencies: { 'pilotswarm-horizon-store': version } }, { name: 'pilotswarm-horizon-store', version, peerDependencies: { 'pilotswarm-sdk': version } }, { name: 'pilotswarm', version, dependencies: { 'pilotswarm-sdk': version } }];
const lock = { packages: Object.fromEntries(['sdk', 'horizon-store', 'app'].map(p => [`packages/${p}`, { version }])) };
const license = readFileSync(new URL('../../../LICENSE', import.meta.url), 'utf8');

function licenseFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ps-release-license-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'LICENSE'), license);
  for (const p of ['sdk', 'horizon-store', 'app']) {
    mkdirSync(join(root, 'packages', p), { recursive: true });
    writeFileSync(join(root, 'packages', p, 'LICENSE'), license);
  }
  return root;
}

function releaseFixture(t) {
  const root = licenseFixture(t);
  const paths = ['sdk', 'horizon-store', 'app'];
  const fixtureLock = structuredClone(lock);
  paths.forEach((path, index) => {
    writeFileSync(join(root, 'packages', path, 'package.json'), JSON.stringify(manifests[index], null, 2) + '\n');
    fixtureLock.packages[`packages/${path}`] = structuredClone(manifests[index]);
  });
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(fixtureLock, null, 2) + '\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.6.0]\n');
  const gitFn = args => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  gitFn(['-C', root, 'init', '--quiet']);
  gitFn(['-C', root, 'add', '.']);
  gitFn(['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '--quiet', '-m', 'Source']);
  return { root, gitFn, sourceSha: gitFn(['-C', root, 'rev-parse', 'HEAD']) };
}

test('all workspace packages retain the canonical MIT text and both copyright notices', () => {
  assert.equal(validatePackageLicenses(), license);
  assert.match(license, /Copyright \(c\) Microsoft Corporation/);
  assert.match(license, /Copyright \(c\) 2026 Affan Dar and contributors/);
  assert.match(license, /permission notice shall be included/);
});

test('current public installation guidance uses release assets and installed MCP executables', () => {
  for (const file of ['docs/developer/building/sdk-apps.md', 'docs/developer/building/cli-apps.md',
    'templates/builder-agents/README.md', 'packages/app/web/README.md']) {
    const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.match(text, /(?:packages\.md|\.tgz)/);
    assert.doesNotMatch(text, /^npm install (?:pilotswarm(?:-sdk|-web|-cli)?)(?:\s|$)/m);
  }
  const mcp = readFileSync(new URL('../../../packages/app/mcp/README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(mcp, /npx -.*-p pilotswarm|"command": "npx"/);
  assert.match(mcp, /"command": "pilotswarm-mcp"/);
  const quickstart = readFileSync(new URL('../../../docs/quickstart/local.md', import.meta.url), 'utf8');
  assert.doesNotMatch(quickstart, /sign in to the internal repository/);
});

test('release refuses missing or divergent workspace licenses', t => {
  const root = licenseFixture(t);
  writeFileSync(join(root, 'packages/sdk/LICENSE'), 'MIT');
  assert.throws(() => validatePackageLicenses(root), /must match/);
  rmSync(join(root, 'packages/sdk/LICENSE'));
  assert.throws(() => validatePackageLicenses(root), /ENOENT/);
});

test('actual tarballs must contain the complete canonical license', t => {
  const root = licenseFixture(t);
  const directory = join(root, 'package');
  mkdirSync(directory);
  const tarball = join(root, 'fixture.tgz');
  writeFileSync(join(directory, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  const pack = () => {
    const result = spawnSync('tar', ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  pack();
  assert.throws(() => validatePackedLicense(tarball, license), /complete canonical/);
  writeFileSync(join(directory, 'LICENSE'), 'MIT');
  pack();
  assert.throws(() => validatePackedLicense(tarball, license), /complete canonical/);
  writeFileSync(join(directory, 'LICENSE'), license);
  pack();
  assert.doesNotThrow(() => validatePackedLicense(tarball, license));
});

test('existing-release notice maintenance is additive, verified and idempotent', t => {
  const root = licenseFixture(t);
  const release = { tag_name: 'v0.6.0', target_commitish: 'tested-source', draft: false,
    assets: [{ id: 1, name: 'pilotswarm-sdk-0.6.0.tgz', size: 123, digest: 'sha256:original' }] };
  const calls = [];
  const runFn = (command, args) => {
    assert.equal(command, 'gh');
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify(release);
    assert.deepEqual(args.slice(0, 5), ['release', 'upload', 'v0.6.0', '--repo', 'microsoft/PilotSwarm']);
    assert.equal(readFileSync(args[5], 'utf8'), license);
    release.assets.push({ id: 2, name: 'LICENSE', size: Buffer.byteLength(license),
      digest: `sha256:${createHash('sha256').update(license).digest('hex')}` });
    return '';
  };
  for (let i = 0; i < 2; i++) addReleaseLicense(version, { root, repository: 'microsoft/PilotSwarm', runFn });
  assert.equal(calls.filter(args => args[0] === 'release').length, 1);
  assert.equal(release.assets[0].digest, 'sha256:original');
  assert(!calls.flat().includes('--clobber'));
  release.assets[1].digest = 'sha256:different';
  assert.throws(() => addReleaseLicense(version, { root, repository: 'microsoft/PilotSwarm', runFn }), /never overwrite/);
  release.draft = true;
  assert.throws(() => addReleaseLicense(version, { root, repository: 'microsoft/PilotSwarm', runFn }), /published release/);
});

test('notice maintenance detects changed old assets and is gated independently of deployment', t => {
  const root = licenseFixture(t);
  let reads = 0;
  const runFn = (_command, args) => args[0] === 'api' ? JSON.stringify({
    tag_name: 'v0.6.0', target_commitish: 'tested-source', draft: false,
    assets: [{ id: 1, name: 'original.tgz', size: ++reads, digest: 'sha256:original' },
      ...(reads > 1 ? [{ id: 2, name: 'LICENSE', digest: `sha256:${createHash('sha256').update(license).digest('hex')}` }] : [])],
  }) : '';
  assert.throws(() => addReleaseLicense(version, { root, repository: 'microsoft/PilotSwarm', runFn }), /verification failed/);
  const workflow = readFileSync(new URL('../../workflows/release-notices.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: azure-deploy/);
  assert.match(workflow, /release\.mjs notices/);
  assert.doesNotMatch(workflow, /azure\/login|actions\/deploy-azure|id-token:|npm publish/);
});
test('release requires matching versions, lockfile, internal dependencies and changelog', () => {
  assert.doesNotThrow(() => validateRelease(version, manifests, lock, '## 0.6.0 — date'));
  assert.throws(() => validateRelease(version, manifests.map((p, i) => i === 0 ? { ...p, devDependencies: { 'pilotswarm-horizon-store': '0.5.79' } } : p), lock, '## 0.6.0'));
  assert.throws(() => validateRelease('v0.6.0', manifests, lock, '## 0.6.0'));
  assert.throws(() => validateRelease(version, manifests, lock, '## 0.5.79'));
  assert.throws(() => validateRelease(version, manifests.map((p, i) => i === 0 ? { ...p, version: '0.5.79' } : p), lock, '## 0.6.0'));
  assert.throws(() => validateRelease(version, manifests, { packages: {} }, '## 0.6.0'));
  assert.throws(() => validateRelease(version, manifests.map((p, i) => i === 2 ? { ...p, dependencies: { 'pilotswarm-sdk': '0.5.79' } } : p), lock, '## 0.6.0'));
});
test('dev releases use matching prepared versions and preserve stable publication options', () => {
  assert.deepEqual(releaseOptions(version), { development: false, create: [], publish: ['--latest'] });
  for (const dev of ['0.6.1-dev.0', '0.6.1-dev.1', '0.6.1-dev.42']) {
    assert.deepEqual(releaseOptions(dev), {
      development: true, create: ['--prerelease', '--latest=false'],
      publish: ['--prerelease', '--latest=false'],
    });
    const devManifests = JSON.parse(JSON.stringify(manifests).replaceAll(version, dev));
    const devLock = JSON.parse(JSON.stringify(lock).replaceAll(version, dev));
    assert.doesNotThrow(() => validateRelease(dev, devManifests, devLock, `## [${dev}]`));
    assert.throws(() => validateRelease(dev, manifests, devLock, `## [${dev}]`), /versions must match/);
    assert.throws(() => validateRelease(dev, devManifests, lock, `## [${dev}]`), /versions must match/);
    assert.throws(() => validateRelease(dev, devManifests, devLock, `## [${version}]`), /CHANGELOG/);
    devManifests[2].dependencies['pilotswarm-sdk'] = version;
    assert.throws(() => validateRelease(dev, devManifests, devLock, `## [${dev}]`), /Internal package dependencies/);
  }
  for (const invalid of ['', 'v0.6.1', '00.6.1', '0.6.1-dev', '0.6.1-dev.01',
    '0.6.1-dev.-1', '0.6.1-dev.1.extra', '0.6.1-rc.1', '0.6.1+build', '0.6.1-dev.1;echo']) {
    assert.throws(() => releaseOptions(invalid), /Release version/);
  }
});
test('same workflow retains dev qualification and skips only deployment steps', () => {
  const workflow = readFileSync(new URL('../../workflows/release-tarballs.yml', import.meta.url), 'utf8');
  const condition = "if: needs.resolve.outputs.development == 'false'";
  assert.equal(workflow.split(condition).length - 1, 2);
  for (const name of ['Refresh Azure login for deployment', 'Deploy released source to test environment']) {
    assert(workflow.includes(`- name: ${name}\n        ${condition}`));
  }
  const qualification = workflow.slice(workflow.indexOf('- uses: azure/login@v3'),
    workflow.indexOf('- name: Refresh Azure login for deployment'));
  assert.doesNotMatch(qualification, /if:/);
  assert.match(qualification, /providers: all\s+mode: parallel\s+qualify-failures: "true"/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: azure-deploy/);
  assert.match(workflow, /dev_release:[\s\S]*type: boolean/);
  assert.match(workflow, /source_branch:/);
  assert.match(workflow, /needs: resolve/);
  assert.match(workflow, /ref: \$\{\{ needs.resolve.outputs.source_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(qualification, /source-sha: \$\{\{ steps.snapshot.outputs.snapshot_sha \|\| needs.resolve.outputs.source_sha \}\}/);
  assert.match(workflow, /node "\$GITHUB_WORKSPACE\/\.github\/scripts\/release\.mjs" publish/);
  assert.match(workflow, /group: azure-deploy/);
});
test('dev numbering advances beyond tags and releases, including drafts and gaps', () => {
  assert.equal(nextDevVersion([]), '0.0.0-dev.1');
  assert.equal(nextDevVersion(['v0.0.0-dev.0']), '0.0.0-dev.1');
  assert.equal(nextDevVersion(['v0.0.0-dev.1', 'v0.0.0-dev.3', 'v0.0.0-dev.3']), '0.0.0-dev.4');
  assert.equal(nextDevVersion(['v0.8.9', 'v0.8.10-dev.42', 'v0.0.0-dev.01', 'v0.0.0-dev.1^{}']), '0.0.0-dev.1');
  assert.equal(nextDevVersion(['v0.0.0-dev.9007199254740992']), '0.0.0-dev.9007199254740993');
});
test('dev source pins a repository branch; stable source remains captured main', async () => {
  const workflowSha = 'a'.repeat(40);
  const sourceSha = 'b'.repeat(40);
  const args = { workflowSha, repository: 'microsoft/PilotSwarm', version, development: 'true', branch: 'feature/dev',
    gitFn: argv => assert.deepEqual(argv, ['check-ref-format', 'refs/heads/feature/dev']),
    api: async path => {
      assert.equal(path, 'repos/microsoft/PilotSwarm/git/ref/heads/feature%2Fdev');
      return { ref: 'refs/heads/feature/dev', object: { type: 'commit', sha: sourceSha } };
    } };
  assert.deepEqual(await resolveReleaseSource(args), { development: 'true', source_branch: args.branch,
    source_sha: sourceSha, source_directory: 'candidate', version: '' });
  assert.deepEqual(await resolveReleaseSource({ ...args, development: 'false', branch: 'main' }),
    { development: 'false', source_branch: 'main', source_sha: workflowSha, source_directory: '.', version });
  await assert.rejects(resolveReleaseSource({ ...args, development: 'false' }), /Stable releases require main/);
  await assert.rejects(resolveReleaseSource({ ...args, development: 'false', branch: 'main', version: '0.0.0-dev.1' }), /Stable releases/);
  await assert.rejects(resolveReleaseSource({ ...args, development: 'invalid' }), /boolean/);
  await assert.rejects(resolveReleaseSource({ ...args, api: async () => ({ ref: 'refs/heads/other' }) }), /existing branch/);
  await assert.rejects(resolveReleaseSource({ ...args, gitFn: () => { throw new Error('invalid branch'); } }), /invalid branch/);
});
test('automatic stamping updates all internal dependencies without changing third-party resolution', () => {
  const prepared = structuredClone(manifests);
  prepared[0].optionalDependencies = { 'pilotswarm-horizon-store': version, thirdParty: '^1.0.0' };
  const preparedLock = structuredClone(lock);
  for (const [index, path] of ['sdk', 'horizon-store', 'app'].entries()) {
    preparedLock.packages[`packages/${path}`] = structuredClone(prepared[index]);
  }
  preparedLock.packages['node_modules/thirdParty'] = { version: '1.2.3', integrity: 'unchanged', resolved: 'unchanged' };
  const external = structuredClone(preparedLock.packages['node_modules/thirdParty']);
  stampDevVersion('0.0.0-dev.7', prepared, preparedLock);
  assert.doesNotThrow(() => validateRelease('0.0.0-dev.7', prepared, preparedLock, '## [0.0.0-dev.7]'));
  assert.equal(preparedLock.packages['packages/sdk'].optionalDependencies['pilotswarm-horizon-store'], '0.0.0-dev.7');
  assert.equal(preparedLock.packages['packages/sdk'].optionalDependencies.thirdParty, '^1.0.0');
  assert.deepEqual(preparedLock.packages['node_modules/thirdParty'], external);
  assert.throws(() => stampDevVersion('0.8.10-dev.1', prepared, preparedLock), /allocated/);
  assert.throws(() => stampDevVersion('0.0.0-dev.8', prepared, { packages: {} }), /lockfile entry/);
});
test('dev snapshot commit changes only release metadata and preserves the selected source', t => {
  const { root, gitFn, sourceSha } = releaseFixture(t);
  const snapshotSha = prepareDevSnapshot('0.0.0-dev.1', sourceSha, { root, gitFn });
  assert.notEqual(snapshotSha, sourceSha);
  assert.equal(gitFn(['-C', root, 'rev-parse', 'HEAD^']), sourceSha);
  assert.deepEqual(gitFn(['-C', root, 'diff', '--name-only', 'HEAD^', 'HEAD']).split('\n'),
    ['CHANGELOG.md', 'package-lock.json', 'packages/app/package.json', 'packages/horizon-store/package.json', 'packages/sdk/package.json']);
  assert.equal(JSON.parse(gitFn(['-C', root, 'show', `${sourceSha}:packages/sdk/package.json`])).version, version);
  assert.equal(JSON.parse(readFileSync(join(root, 'packages/sdk/package.json'), 'utf8')).version, '0.0.0-dev.1');
  assert.throws(() => prepareDevSnapshot('0.0.0-dev.2', sourceSha, { root, gitFn }), /selected before approval/);
  writeFileSync(join(root, 'CHANGELOG.md'), 'unexpected edit');
  assert.throws(() => prepareDevSnapshot('0.0.0-dev.2', snapshotSha, { root, gitFn }), /clean source/);
});
test('dev source selection refuses reruns and non-main workflow execution', async () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    DEV_RELEASE: 'true', GITHUB_RUN_ATTEMPT: '2' };
  const api = async () => { assert.fail('No API calls should happen before validation'); };
  for (const command of ['resolve', 'prepare']) await assert.rejects(selectRelease(command, env, api), /new dev release/);
  await assert.rejects(selectRelease('resolve', { ...env, GITHUB_REF: 'refs/heads/feature' }, api), /main workflow/);
});
test('publication packs the tested snapshot, preserves stable flags and stops on incorrect prerelease status', t => {
  for (const mode of ['stable', 'dev', 'wrong-status']) {
    const { root, gitFn, sourceSha } = releaseFixture(t);
    const development = mode !== 'stable';
    const releaseVersion = development ? '0.0.0-dev.1' : version;
    const snapshotSha = development ? prepareDevSnapshot(releaseVersion, sourceSha, { root, gitFn }) : sourceSha;
    const remote = join(root, 'remote.git');
    gitFn(['init', '--bare', '--quiet', remote]);
    gitFn(['-C', root, 'remote', 'add', 'origin', remote]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // GitHub mutations are simulated; tag pushes stay in the fixture's local bare repository.
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync('gh-calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'auth') process.exit(0);
if (args[1] === 'create') {
  fs.writeFileSync('release.json', JSON.stringify({ isDraft: true,
    isPrerelease: ${mode === 'wrong-status' ? 'false' : "args.includes('--prerelease')"},
    assets: args.filter(a => a.startsWith('dist-tarballs/')).map(a => ({ name: path.basename(a) })) }));
} else if (args[1] === 'view') {
  console.log(fs.readFileSync('release.json', 'utf8'));
} else if (args[1] !== 'edit') {
  throw new Error('Unexpected GitHub operation');
}
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../release.mjs', import.meta.url)), 'publish'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sourceSha,
        RELEASE_SOURCE_SHA: snapshotSha, RELEASE_VERSION: releaseVersion, GH_TOKEN: 'fixture-token' },
    });
    const calls = readFileSync(join(root, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    if (mode === 'wrong-status') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /prerelease status/);
      assert(!calls.some(args => args[1] === 'edit'));
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(gitFn(['--git-dir', remote, 'rev-parse', `v${releaseVersion}^{commit}`]), snapshotSha);
    const create = calls.find(args => args[1] === 'create');
    const publish = calls.find(args => args[1] === 'edit');
    assert.equal(create.includes('--prerelease'), development);
    assert.equal(create.includes('--latest=false'), development);
    assert.equal(publish.includes('--latest=false'), development);
    assert.equal(publish.includes('--latest'), !development);
    if (development) {
      assert(create[create.indexOf('--notes') + 1].includes(sourceSha));
      assert(create[create.indexOf('--notes') + 1].includes(snapshotSha));
    }
    for (const manifest of manifests) {
      const tarball = join(root, 'dist-tarballs', `${manifest.name}-${releaseVersion}.tgz`);
      const packed = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' });
      assert.equal(packed.status, 0, packed.stderr);
      assert.equal(JSON.parse(packed.stdout).version, releaseVersion);
    }
  }
});
test('release and additive coverage use hosted runners; regional routing is full-HDB only', () => {
  const release = readFileSync(new URL('../../workflows/release-tarballs.yml', import.meta.url), 'utf8');
  const tests = readFileSync(new URL('../../workflows/tests.yml', import.meta.url), 'utf8');
  assert.match(release, /^    runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(release, /PROVIDER_TEST_RUNNER/);
  assert.doesNotMatch(release, /hdb-diagnostic:|diagnose-hdb/);
  assert.match(release, /uses: \.\/\.github\/actions\/provider-tests\s+with:\s+providers: all\s+mode: parallel\s+qualify-failures: "true"/);
  for (const workflow of [release, tests]) assert.match(workflow, /image: postgres:16/);
  assert.equal(tests.split('\n  tests:\n')[1].match(/^    runs-on: (.+)$/m)?.[1],
    "${{ needs.resolve.outputs.pr_number == '' && needs.resolve.outputs.providers == 'horizondb' && needs.resolve.outputs.suite == '' && vars.PROVIDER_TEST_RUNNER || 'ubuntu-latest' }}");
  assert.match(tests, /Targeted HDB diagnostics \(not a release gate\)/);
});
test('release refreshes Azure authentication after testing and publication, before deployment', () => {
  const release = readFileSync(new URL('../../workflows/release-tarballs.yml', import.meta.url), 'utf8');
  const gate = release.indexOf('- name: Qualify complete all-provider coverage');
  const publish = release.indexOf('- name: Publish verified package tarballs');
  const refresh = release.indexOf('- name: Refresh Azure login for deployment');
  const deploy = release.indexOf('- name: Deploy released source to test environment');
  assert(gate >= 0 && gate < publish && publish < refresh && refresh < deploy);
  assert.match(release.slice(refresh, deploy), /uses: azure\/login@v3/);
  for (const secret of ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID']) {
    assert(release.slice(refresh, deploy).includes(`secrets.${secret}`));
  }
});

function actionStepScript(file, name) {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = text.indexOf(`- name: ${name}`);
  assert(start >= 0);
  const block = text.slice(start).split(/\n {4,6}- name:/)[0];
  const body = block.match(/run: \|\n([\s\S]*)/)[1];
  const indent = body.match(/^ */)[0].length;
  return body.split('\n').map(line => line.slice(indent)).join('\n');
}

function shellFixture(t, script, overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-release-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, RUNNER_TEMP: dir, CAPTURE: join(dir, 'calls'),
    GITHUB_OUTPUT: join(dir, 'output'), ...overrides };
  const stubs = `
    gh() { printf '%s\\n' "\${TEST_RELEASE_DRAFT:-false}"; }
    git() {
      case "$1" in
        merge-base) return "\${TEST_NOT_ANCESTOR:-0}" ;;
        rev-parse) printf '0123456789ab\\n' ;;
        checkout) printf '%s\\n' "$*" >> "$CAPTURE" ;;
        *) return 1 ;;
      esac
    }
    npm() { printf '%s\\n' "$@" >> "$CAPTURE"; }
  `;
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', stubs + script], { env, encoding: 'utf8' });
  return { ...result, calls: existsSync(env.CAPTURE) ? readFileSync(env.CAPTURE, 'utf8') : '',
    output: existsSync(env.GITHUB_OUTPUT) ? readFileSync(env.GITHUB_OUTPUT, 'utf8') : '' };
}

test('configuration reconciliation uses existing image tags and omits build/push', t => {
  const script = actionStepScript('../../actions/deploy-azure/action.yml', 'Deploy');
  const result = shellFixture(t, script, { RECONCILE_RELEASE_CONFIG: 'true', DEPLOY_IMAGE_TAG: '0123456789ab' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.trim().split('\n'), ['run', 'deploy', '--', 'all', 'ci', '--image-tag',
    '0123456789ab', '--steps', 'bicep,seed-secrets,manifests,rollout']);
  for (const tag of ['', 'latest', 'bad;command']) {
    const invalid = shellFixture(t, script, { RECONCILE_RELEASE_CONFIG: 'true', DEPLOY_IMAGE_TAG: tag });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.calls, '');
  }
});

test('normal deployment retains the full pipeline and invalid modes fail closed', t => {
  const script = actionStepScript('../../actions/deploy-azure/action.yml', 'Deploy');
  const normal = shellFixture(t, script, { RECONCILE_RELEASE_CONFIG: 'false', DEPLOY_IMAGE_TAG: '' });
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(normal.calls.includes('--steps'), false);
  const invalid = shellFixture(t, script, { RECONCILE_RELEASE_CONFIG: 'invalid', DEPLOY_IMAGE_TAG: '0123456789ab' });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.calls, '');
});

test('release configuration uses current templates; ordinary redeploy checks out the tag', t => {
  const script = actionStepScript('../../workflows/deploy-azure.yml', 'Select immutable release source when requested');
  for (const mode of ['true', 'false']) {
    const result = shellFixture(t, script, { RELEASE_TAG: 'v0.6.0', RECONCILE_RELEASE_CONFIG: mode });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.trim(), 'image-tag=0123456789ab');
    assert.equal(result.calls.includes('checkout --detach v0.6.0'), mode === 'false');
  }
  for (const tag of ['', 'main', 'v0.6.0-dev.1', 'v0.6.0;command']) {
    const invalid = shellFixture(t, script, { RELEASE_TAG: tag, RECONCILE_RELEASE_CONFIG: 'true' });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.calls, '');
  }
  for (const overrides of [{ TEST_RELEASE_DRAFT: 'true' }, { TEST_NOT_ANCESTOR: '1' }]) {
    const invalid = shellFixture(t, script, { RELEASE_TAG: 'v0.6.0', RECONCILE_RELEASE_CONFIG: 'true', ...overrides });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.calls, '');
  }
});
