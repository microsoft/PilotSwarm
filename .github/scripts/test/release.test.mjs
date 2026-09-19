import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(release, /uses: \.\/\.github\/actions\/provider-tests\s+with:\s+providers: all\s+mode: parallel/);
  for (const workflow of [release, tests]) assert.match(workflow, /image: postgres:16/);
  assert.equal(tests.match(/^    runs-on: (.+)$/m)?.[1],
    "${{ inputs.providers == 'horizondb' && inputs.suite == '' && vars.PROVIDER_TEST_RUNNER || 'ubuntu-latest' }}");
  assert.match(tests, /Targeted HDB diagnostics \(not a release gate\)/);
});
