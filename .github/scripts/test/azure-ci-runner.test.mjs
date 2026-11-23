import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSetupScript, main, runCommandBody, setupCommandName, validateRunnerConfig } from '../../../deploy/providers/azure/ci/runner/manage.mjs';

const runnerFile = name => readFileSync(new URL(`../../../deploy/providers/azure/ci/runner/${name}`, import.meta.url), 'utf8');
const runner = { name: 'example-ci-runner', label: 'ci-example', vmSize: 'Standard_D8s_v5', repository: 'owner/repository',
  subscription: '00000000-0000-0000-0000-000000000000', resourceGroup: 'example-rg', location: 'example-region' };

test('runner configuration keeps its own fields and rejects shell fragments and other targets', () => {
  assert.deepEqual(validateRunnerConfig({ ...runner, extra: 'ignored' }), runner);
  for (const key of ['name', 'label', 'vmSize', 'resourceGroup', 'location']) {
    assert.throws(() => validateRunnerConfig({ ...runner, [key]: 'bad;command' }), new RegExp(`Invalid runner ${key}|dedicated`));
  }
  assert.throws(() => validateRunnerConfig({ ...runner, name: 'application' }), /-ci-runner/);
  assert.throws(() => validateRunnerConfig({ ...runner, label: 'ubuntu-latest' }), /ci- runner label/);
  assert.throws(() => validateRunnerConfig({ ...runner, repository: 'https://example.invalid' }), /Invalid repository/);
  assert.throws(() => validateRunnerConfig({ ...runner, subscription: 'example' }), /Invalid runner subscription/);
});

test('management runs from an operator shell only and stops before any Azure call on bad input', async () => {
  const config = JSON.stringify(runner);
  await assert.rejects(main('setup', { GITHUB_ACTIONS: 'true', AZURE_CI_RUNNER_JSON: config }), /not from a workflow/);
  await assert.rejects(main('deallocate', { GITHUB_ACTIONS: 'true', AZURE_CI_RUNNER_JSON: config }), /not from a workflow/);
  await assert.rejects(main('reset', { AZURE_CI_RUNNER_JSON: config }), /Expected one of: setup, start, deallocate, status/);
  await assert.rejects(main('status', {}), /AZURE_CI_RUNNER_JSON/);
  await assert.rejects(main('status', { AZURE_CI_RUNNER_JSON: JSON.stringify({ ...runner, name: 'application' }) }), /-ci-runner/);
});

test('every setup gets its own Run Command name', () => {
  const first = setupCommandName(new Date('2026-01-02T03:04:05Z'));
  assert.equal(first, 'setup-ci-runner-20260102030405');
  assert.notEqual(setupCommandName(new Date('2026-01-02T03:04:06Z')), first);
});

test('the setup script carries the job hook unchanged, and the token travels only as a protected parameter', () => {
  const script = composeSetupScript();
  const [, encoded, rest] = script.match(/<<'PILOTSWARM_JOB_HOOK'\n([A-Za-z0-9+/=\n]+)\nPILOTSWARM_JOB_HOOK\n([\s\S]*)$/);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), runnerFile('job-hook.sh'));
  assert.equal(rest, runnerFile('setup.sh'));
  assert(script.indexOf('job-hook.sh <<') < script.indexOf('test -s "$HOOKS/job-hook.sh"'));

  const token = 'EXAMPLETOKEN_1234-abcd';
  const body = runCommandBody(runner, { script, token, start: false });
  assert.deepEqual(body.properties.protectedParameters, [{ name: 'RUNNER_TOKEN', value: token }]);
  const visible = JSON.stringify({ ...body, properties: { ...body.properties, protectedParameters: undefined } });
  assert(!visible.includes(token));
  assert.deepEqual(body.properties.parameters, [
    { name: 'RUNNER_REPOSITORY', value: 'owner/repository' }, { name: 'RUNNER_LABEL', value: 'ci-example' },
    { name: 'RUNNER_NAME', value: 'example-ci-runner' }, { name: 'RUNNER_START', value: 'false' },
  ]);
  // Without a token the setup keeps the existing registration.
  assert.equal(runCommandBody(runner, { script }).properties.protectedParameters, undefined);
  assert.throws(() => runCommandBody(runner, { script, token: 'bad token; rm -rf /' }), /unexpected form/);
});

test('the machine accepts exactly the workflows that sign in to Azure, registers once and runs the hook', () => {
  const setup = runnerFile('setup.sh');
  const accepted = setup.match(/^for workflow in (.+); do$/m)[1].split(' ').map(name => `${name}.yml`).sort();
  const workflows = new URL('../../workflows/', import.meta.url);
  const signIn = readdirSync(workflows).filter(name => readFileSync(new URL(name, workflows), 'utf8').includes('uses: azure/login@')).sort();
  assert.deepEqual(accepted, signIn);
  assert.match(setup, /\$\{RUNNER_REPOSITORY\}\/\.github\/workflows\/\$\{workflow\}\.yml@refs\/heads\/main/);
  assert.match(setup, /^RUNNER_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(setup, /^RUNNER_SHA256=[0-9a-f]{64}$/m);
  assert.match(setup, /sha256sum --check --status/);
  // Registered once, not for one job: nothing can register it again without an administrator's token.
  assert.doesNotMatch(setup, /--ephemeral/);
  assert.match(setup, /^Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=\$HOOKS\/job-started\.sh$/m);
  assert.match(setup, /^Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=\$HOOKS\/job-completed\.sh$/m);
  assert.match(setup, /chown -R root:root "\$HOOKS"/);
  assert.doesNotMatch(setup, /set -[a-z]*x|echo[^\n]*RUNNER_TOKEN/);
  // Package installs wait for the machine's automatic updates, and a failed setup puts the runner back.
  assert.doesNotMatch(setup, /^\s*apt-get /m);
  assert.match(setup, /apt-get -o DPkg::Lock::Timeout=\d+ "\$@"/);
  assert(setup.indexOf('trap restore_on_failure EXIT') < setup.indexOf('systemctl stop "$UNIT"'));
  assert.match(runnerFile('main.bicep'), /identity: \{ type: 'SystemAssigned' \}/);
});

// The hook has fixed absolute paths. For a test, copy it with those paths
// pointed at a temporary directory and at recording stand-ins for the tools.
function hookFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-runner-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, 'calls');
  const stub = name => {
    const path = join(root, name);
    writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const paths = { ALLOWED: join(root, 'allowed-workflows'), WORK_ROOT: join(root, 'work'),
    PKILL: stub('pkill'), DOCKER: stub('docker'), LOGGER: stub('logger') };
  let text = runnerFile('job-hook.sh');
  for (const [name, value] of Object.entries(paths)) {
    assert.match(text, new RegExp(`^${name}=/.+$`, 'm'));
    text = text.replace(new RegExp(`^${name}=.+$`, 'm'), `${name}=${value}`);
  }
  const hook = join(root, 'job-hook.sh');
  writeFileSync(hook, text);
  writeFileSync(paths.ALLOWED, ['tests', 'deploy-azure'].map(name => `owner/repository/.github/workflows/${name}.yml@refs/heads/main`).join('\n') + '\n');
  const home = join(root, 'home');
  const workspace = join(paths.WORK_ROOT, 'repository', 'repository');
  const seed = () => {
    for (const dir of [join(home, '.azure'), join(home, '.kube'), join(home, '.config', 'gh'), join(home, 'keep'), join(workspace, 'deploy', '.tmp')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(workspace, '.env'), 'left behind');
    writeFileSync(calls, '');
  };
  const run = (mode, env = {}, { goneFolder = false } = {}) => {
    seed();
    // The runner program may start the hook from any folder, also one that no longer exists.
    const cwd = mkdtempSync(join(root, 'start-'));
    const result = spawnSync('bash', ['-c', `${goneFolder ? 'rmdir "$PWD"; ' : ''}exec bash "$0" "$@"`, hook, ...(mode ? [mode] : [])], { encoding: 'utf8', cwd,
      env: { PATH: process.env.PATH, HOME: home, GITHUB_WORKSPACE: workspace, ...env } });
    return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(calls, 'utf8'),
      signIns: existsSync(join(home, '.azure')) || existsSync(join(home, '.kube')) || existsSync(join(home, '.config', 'gh')),
      checkout: readdirSync(workspace) };
  };
  return { run, home, workspace, paths, root };
}

test('before a job, the hook lets only the listed main-branch workflows continue and then removes leftovers', t => {
  const f = hookFixture(t);
  for (const name of ['tests', 'deploy-azure']) {
    const ok = f.run('started', { GITHUB_WORKFLOW_REF: `owner/repository/.github/workflows/${name}.yml@refs/heads/main` });
    assert.equal(ok.status, 0, ok.output);
    assert.doesNotMatch(ok.calls, /pkill/);
    assert.match(ok.calls, /^docker system prune --all --force --volumes$/m);
    assert.equal(ok.signIns, false);
    assert.deepEqual(ok.checkout, []);
    assert(existsSync(join(f.home, 'keep')));
  }
});

test('before a job, the hook refuses every other workflow and stops the job so that no step can run', t => {
  const f = hookFixture(t);
  const uid = String(process.getuid());
  for (const workflow of [
    'owner/repository/.github/workflows/tests.yml@refs/heads/feature',          // an allowed file from a branch
    'owner/repository/.github/workflows/tests.yml@refs/pull/7/merge',           // an allowed file from a pull request
    'owner/repository/.github/workflows/other.yml@refs/heads/main',             // another file on main
    'someone/fork/.github/workflows/tests.yml@refs/heads/main',                 // the same file in another repository
    'owner/repository/.github/workflows/tests.yml@refs/heads/main-extra',       // a longer name that starts the same
    'owner/repository/.github/workflows/tests.yml@refs/heads/mai',              // a shorter name
    '.*',                                                                       // a pattern, not a name
    undefined,                                                                  // no workflow at all
  ]) {
    const refused = f.run('started', workflow === undefined ? {} : { GITHUB_WORKFLOW_REF: workflow });
    assert.equal(refused.status, 1, String(workflow));
    assert.match(refused.output, /::error::This runner accepts only the protected Azure workflows on main\. Refused: /);
    assert.match(refused.calls, new RegExp(`^pkill -KILL -u ${uid} -f Runner\\\\\\.Worker$`, 'm'), String(workflow));
    assert.match(refused.calls, /^logger -t pilotswarm-ci-runner This runner accepts only/m);
    // A refused job changes nothing on the machine.
    assert.doesNotMatch(refused.calls, /docker/);
    assert.deepEqual(refused.checkout.sort(), ['.env', 'deploy']);
  }
  // No list on the machine means nothing is accepted.
  rmSync(f.paths.ALLOWED);
  const closed = f.run('started', { GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/tests.yml@refs/heads/main' });
  assert.equal(closed.status, 1);
  assert.match(closed.calls, /^pkill /m);
});

test('after a job, the hook removes sign-ins, the checkout and Docker state, and nothing outside its own folders', t => {
  const f = hookFixture(t);
  const done = f.run('completed', { GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/other.yml@refs/heads/main' });
  assert.equal(done.status, 0, done.output);
  assert.equal(done.signIns, false);
  assert.deepEqual(done.checkout, []);
  assert.match(done.calls, /^docker system prune --all --force --volumes$/m);
  assert.doesNotMatch(done.calls, /pkill/);
  assert(existsSync(join(f.home, 'keep')));

  // A checkout folder outside the runner's work folder is never emptied.
  const outside = join(f.root, 'elsewhere');
  mkdirSync(outside);
  writeFileSync(join(outside, 'file'), 'keep');
  assert.equal(f.run('completed', { GITHUB_WORKSPACE: outside }).status, 0);
  assert.deepEqual(readdirSync(outside), ['file']);
  assert.equal(f.run('completed', { GITHUB_WORKSPACE: f.paths.WORK_ROOT }).status, 0);
  assert(existsSync(join(f.workspace, '.env')));

  // Cleanup does not depend on the folder the hook is started from.
  const gone = f.run('completed', {}, { goneFolder: true });
  assert.equal(gone.status, 0, gone.output);
  assert.deepEqual(gone.checkout, []);
  assert.equal(gone.signIns, false);
  assert.match(runnerFile('job-hook.sh'), /^cd \/ \|\| exit 1$/m);

  assert.equal(f.run(undefined).status, 2);
  assert.equal(f.run('unknown').status, 2);
});
