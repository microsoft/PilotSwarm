import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, firewallUrl, ciParameterGroupName } from '../azure-ci-database.mjs';
const config = { subscription: '00000000-0000-0000-0000-000000000001', resourceGroup: 'test-group', location: 'region', cluster: 'ci-db', appCluster: 'app-db', parameterGroup: 'ci-extensions', vault: 'test-vault', passwordSecret: 'ci-password', urlSecret: 'ci-url', embeddingUrl: 'https://example.invalid/embeddings', embeddingKeySecret: 'model-key', foundryAccount: 'test-foundry' };
test('CI rejects the application cluster and shared credentials', () => {
  assert.deepEqual(validateConfig(config), config);
  for (const patch of [{ cluster: 'APP-db' }, { passwordSecret: 'app-password' }, { urlSecret: 'horizondb-url' }, { embeddingUrl: 'http://example.invalid' }, { cluster: '../app-db' }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
});
test('firewall rules are isolated by run and retry; invalid identifiers are rejected', () => {
  assert.match(firewallUrl(config, '123', '2'), /\/ci-123-2\?api-version=/);
  assert.notEqual(firewallUrl(config, '123', '1'), firewallUrl(config, '124', '1'));
  assert.throws(() => firewallUrl(config, '../app-db', '1'));
});

test('immutable parameter groups use stable distinct names for the desired settings', () => {
  const name = ciParameterGroupName(config);
  assert.notEqual(name, config.parameterGroup, 'never update the existing group in place');
  assert.equal(name, ciParameterGroupName({ ...config }), 'retries reuse the same revision');
  assert.notEqual(name, ciParameterGroupName({ ...config, parameterGroup: 'another-base' }));
  const long = ciParameterGroupName({ ...config, parameterGroup: 'x'.repeat(90) });
  assert.ok(long.length <= 63);
  assert.match(long, /^[a-zA-Z0-9._-]+$/);
});
