import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRelease } from '../release.mjs';
const version = '0.6.0';
const manifests = [{ name: 'pilotswarm-sdk', version, peerDependencies: { 'pilotswarm-horizon-store': version } }, { name: 'pilotswarm-horizon-store', version, peerDependencies: { 'pilotswarm-sdk': version } }, { name: 'pilotswarm', version, dependencies: { 'pilotswarm-sdk': version } }];
const lock = { packages: Object.fromEntries(['sdk', 'horizon-store', 'app'].map(p => [`packages/${p}`, { version }])) };
test('release requires matching versions, lockfile, internal dependencies and changelog', () => {
  assert.doesNotThrow(() => validateRelease(version, manifests, lock, '## 0.6.0 — date'));
  assert.throws(() => validateRelease(version, manifests.map((p, i) => i === 0 ? { ...p, devDependencies: { 'pilotswarm-horizon-store': '0.5.79' } } : p), lock, '## 0.6.0'));
  assert.throws(() => validateRelease('v0.6.0', manifests, lock, '## 0.6.0'));
  assert.throws(() => validateRelease(version, manifests, lock, '## 0.5.79'));
  assert.throws(() => validateRelease(version, manifests.map((p, i) => i === 0 ? { ...p, version: '0.5.79' } : p), lock, '## 0.6.0'));
  assert.throws(() => validateRelease(version, manifests, { packages: {} }, '## 0.6.0'));
  assert.throws(() => validateRelease(version, manifests.map((p, i) => i === 2 ? { ...p, dependencies: { 'pilotswarm-sdk': '0.5.79' } } : p), lock, '## 0.6.0'));
});
test('release and additive coverage use hosted runners; regional routing is full-HDB only', () => {
  const release = readFileSync(new URL('../../workflows/release-tarballs.yml', import.meta.url), 'utf8');
  const tests = readFileSync(new URL('../../workflows/tests.yml', import.meta.url), 'utf8');
  assert.match(release, /^    runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(release, /PROVIDER_TEST_RUNNER/);
  assert.doesNotMatch(release, /hdb-diagnostic:|diagnose-hdb/);
  assert.match(release, /uses: \.\/\.github\/actions\/provider-tests\s+with:\s+providers: all\s+mode: parallel\s+qualify-failures: "true"/);
  for (const workflow of [release, tests]) assert.match(workflow, /image: postgres:16/);
  assert.equal(tests.match(/^    runs-on: (.+)$/m)?.[1],
    "${{ inputs.providers == 'horizondb' && inputs.suite == '' && vars.PROVIDER_TEST_RUNNER || 'ubuntu-latest' }}");
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
  for (const tag of ['', 'main', 'v0.6.0;command']) {
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
