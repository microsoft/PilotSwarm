import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateRunnerConfig, registrationCommandName } from '../../../deploy/providers/azure/ci/runner/manage.mjs';
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
for (const [name, environment] of [
  ['local invocation', { GITHUB_ACTIONS: 'false', GITHUB_REF: 'refs/heads/main', RUNNER_TEMP: '/tmp' }],
  ['untrusted branch', { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature/example', RUNNER_TEMP: '/tmp' }],
  ['missing runner directory', { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', RUNNER_TEMP: '' }],
]) {
  test(`${name} cannot mutate Azure regardless of the test host environment`, () => {
    const moduleUrl = new URL('../../../deploy/providers/azure/ci/runner/manage.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { main } from ${JSON.stringify(moduleUrl)};
      await assert.rejects(main('register'), /protected main-branch Action/);
    `], { encoding: 'utf8', env: { ...process.env, ...environment } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
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
