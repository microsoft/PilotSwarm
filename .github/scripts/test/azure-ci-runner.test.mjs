import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunnerConfig, registrationCommandName, main } from '../../../deploy/providers/azure/ci/runner/manage.mjs';
const runner = { name: 'example-ci-runner', label: 'ci-example', vmSize: 'Standard_D8s_v5' };
const database = { subscription: '00000000-0000-0000-0000-000000000000', resourceGroup: 'example-rg', location: 'example-region', cluster: 'example-ci-db', appCluster: 'example-app-db' };
test('runner placement and Azure target derive from dedicated CI configuration', () => {
  const c = validateRunnerConfig({ ...runner, location: 'wrong', subscription: 'wrong' }, database, 'owner/repository');
  assert.equal(c.location, database.location);
  assert.equal(c.subscription, database.subscription);
  assert.equal(c.resourceGroup, database.resourceGroup);
});
test('runner configuration rejects shell fragments and application targets', () => {
  for (const key of ['name', 'label', 'vmSize']) assert.throws(() => validateRunnerConfig({ ...runner, [key]: 'bad;command' }, database, 'owner/repository'));
  assert.throws(() => validateRunnerConfig({ ...runner, name: 'application' }, database, 'owner/repository'));
  assert.throws(() => validateRunnerConfig(runner, { ...database, cluster: database.appCluster }, 'owner/repository'));
  assert.throws(() => validateRunnerConfig(runner, database, 'https://example.invalid'));
});
test('local invocation cannot mutate Azure', async () => {
  await assert.rejects(main('register'), /protected main-branch Action/);
});
test('registration cannot reuse completion evidence from another workflow run or attempt', () => {
  const commands = new Set([
    registrationCommandName('100', '1'),
    registrationCommandName('101', '1'),
    registrationCommandName('100', '2'),
  ]);
  assert.equal(commands.size, 3);
  for (const args of [[undefined, '1'], ['100', undefined], ['100/old', '1'], ['100', '1?old']]) {
    assert.throws(() => registrationCommandName(...args), /run ID and attempt/);
  }
});
