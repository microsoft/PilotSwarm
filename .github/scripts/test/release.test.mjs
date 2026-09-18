import { test } from 'node:test';
import assert from 'node:assert/strict';
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
