import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_SCRIPTS, OPERATIONS, composeSetupScript, grantArguments, main, runCommandBody, setupCommandName, validateRunnerConfig } from '../../../deploy/providers/azure/ci/runner/manage.mjs';

const runnerFile = name => readFileSync(new URL(`../../../deploy/providers/azure/ci/runner/${name}`, import.meta.url), 'utf8');
const runner = { name: 'example-ci-runner', label: 'ci-example', vmSize: 'Standard_D8s_v5', repository: 'owner/repository',
  subscription: '00000000-0000-0000-0000-000000000000', resourceGroup: 'example-rg', location: 'example-region' };

test('runner configuration keeps its own fields and rejects shell fragments and other targets', () => {
  assert.deepEqual(validateRunnerConfig({ ...runner, extra: 'ignored' }), { ...runner, horizonDb: true });
  assert.equal(validateRunnerConfig({ ...runner, horizonDb: false }).horizonDb, false);
  assert.throws(() => validateRunnerConfig({ ...runner, horizonDb: 'no' }), /horizonDb must be true or false/);
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
  await assert.rejects(main('grant', { GITHUB_ACTIONS: 'true', AZURE_CI_RUNNER_JSON: config }), /not from a workflow/);
  await assert.rejects(main('reset', { AZURE_CI_RUNNER_JSON: config }), /Expected one of: setup, grant, start, deallocate, status/);
  await assert.rejects(main('status', {}), /AZURE_CI_RUNNER_JSON/);
  await assert.rejects(main('status', { AZURE_CI_RUNNER_JSON: JSON.stringify({ ...runner, name: 'application' }) }), /-ci-runner/);
});

test('the identity\'s rights are code: two roles on the resource group, and Reader on the HorizonDB location', () => {
  assert(OPERATIONS.includes('grant'));
  const roles = runnerFile('roles.bicep');
  assert.match(roles, /^targetScope = 'resourceGroup'$/m);
  // Contributor and Role Based Access Control Administrator, each named by scope, identity and role:
  // applying the file again changes nothing.
  for (const [variable, roleId] of [['contributorRoleId', 'b24988ac-6180-42a0-ab88-20f7382dd24c'], ['rbacAdministratorRoleId', 'f58310d9-a9f6-439a-9e8d-f62e7b41a168']]) {
    assert(roles.includes(`var ${variable} = '${roleId}'`), variable);
    assert(roles.includes(`name: guid(resourceGroup().id, principalId, ${variable})`), variable);
    assert(roles.includes(`roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', ${variable})`), variable);
  }
  // Exactly these two here; the stamp's own Bicep gives the identity its other roles.
  assert.equal(roles.match(/^resource \w+ 'Microsoft\.Authorization\/roleAssignments@/gm).length, 2);
  assert.doesNotMatch(roles, /8e3af657-a8ff-443c-a75c-2fe8c4bcb635/); // never Owner
  // The HorizonDB location is outside the resource group, and optional.
  assert.match(roles, /module horizonDbReader '\.\/roles-horizondb\.bicep' = if \(!empty\(horizonDbLocation\)\) \{\n  name: [^\n]+\n  scope: subscription\(\)\n/);
  const location = runnerFile('roles-horizondb.bicep');
  assert.match(location, /^targetScope = 'subscription'$/m);
  assert(location.includes("var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'"));
  assert.match(location, /resource horizonDbLocation 'Microsoft\.HorizonDb\/locations@[^']+' existing = \{\s+name: location\s+\}/);
  assert.match(location, /scope: horizonDbLocation\s+name: guid\(horizonDbLocation\.id, principalId, readerRoleId\)/);
  for (const file of [roles, location]) assert.equal(file.match(/principalType: 'ServicePrincipal'/g).length, file.match(/roleAssignments@/g).length);

  // The command applies that file for the machine's own identity.
  const principalId = '11111111-2222-3333-4444-555555555555';
  const args = grantArguments({ ...runner, horizonDb: true }, principalId);
  assert.deepEqual(args.slice(0, 9), ['deployment', 'group', 'create', '--subscription', runner.subscription, '--resource-group', runner.resourceGroup, '--name', 'example-ci-runner-roles']);
  assert.match(args[args.indexOf('--template-file') + 1], /deploy\/providers\/azure\/ci\/runner\/roles\.bicep$/);
  assert.deepEqual(args.slice(args.indexOf('--parameters') + 1), [`principalId=${principalId}`, 'horizonDbLocation=example-region', '-o', 'none']);
  assert(grantArguments({ ...runner, horizonDb: false }, principalId).includes('horizonDbLocation='));
  for (const missing of [undefined, '', 'not-an-id']) assert.throws(() => grantArguments({ ...runner, horizonDb: true }, missing), /no managed identity yet/);

  // The guide lists every role the identity ends up with, and who grants it.
  const guide = runnerFile('README.md');
  for (const role of ['Contributor', 'Role Based Access Control Administrator', 'Reader', 'AcrPush', 'Key Vault Secrets Officer',
    'Storage Blob Data Contributor', 'Azure Kubernetes Service RBAC Cluster Admin']) {
    assert.match(guide, new RegExp(`^   \\| [^|]*\\(${role}\\) \\| [^|]+ \\| (\`manage\\.mjs grant\`|The stamp's Bicep) \\|$`, 'm'), role);
  }
});

test('every setup gets its own Run Command name', () => {
  const first = setupCommandName(new Date('2026-01-02T03:04:05Z'));
  assert.equal(first, 'setup-ci-runner-20260102030405');
  assert.notEqual(setupCommandName(new Date('2026-01-02T03:04:06Z')), first);
});

test('the setup script carries the machine scripts unchanged, and the token travels only as a protected parameter', () => {
  const script = composeSetupScript();
  assert.deepEqual(MACHINE_SCRIPTS, ['job-hook.sh', 'maintenance.sh']);
  const carried = [...script.matchAll(/base64 -d > \/usr\/local\/lib\/pilotswarm-ci-runner\/([a-z-]+\.sh) <<'PILOTSWARM_SCRIPT'\n([A-Za-z0-9+/=\n]+)\nPILOTSWARM_SCRIPT\n/g)];
  assert.deepEqual(carried.map(match => match[1]), MACHINE_SCRIPTS);
  for (const [, name, encoded] of carried) assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), runnerFile(name), name);
  // The setup itself follows, unchanged, after the scripts it checks for.
  assert(script.endsWith(`PILOTSWARM_SCRIPT\n${runnerFile('setup.sh')}`));
  for (const name of MACHINE_SCRIPTS) assert.match(runnerFile('setup.sh'), new RegExp(`^test -s "\\$HOOKS/${name.replace('.', '\\.')}"$`, 'm'));
  assert.throws(() => composeSetupScript({ setup: '', scripts: { '../evil.sh': '' } }), /Unexpected machine script name/);

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

test('the machine\'s OS updates cannot cut a running job', () => {
  const setup = runnerFile('setup.sh');
  // 1. The updater restarts none of the three services a job depends on.
  for (const service of ['pilotswarm-ci-runner', 'docker', 'containerd']) {
    assert(setup.includes(`$nrconf{override_rc}{qr(^${service}\\.service$)} = 0;`), service);
  }
  assert.match(setup, /cat > \/etc\/needrestart\/conf\.d\/pilotswarm-ci-runner\.conf <<'NEEDRESTART'/);
  // 2. The daily update is skipped while a job runs: the condition fails when a job's worker process exists.
  assert.match(setup, /cat > \/etc\/systemd\/system\/apt-daily-upgrade\.service\.d\/pilotswarm-ci-runner\.conf <<'DROPIN'/);
  assert(setup.includes(`ExecCondition=/bin/sh -c '! /usr/bin/pgrep -u runner -f "Runner\\.Worker" >/dev/null'`));
  // 3. A timer runs the maintenance script, which updates and reboots only while the runner is idle.
  assert.match(setup, /^ExecStart=\$HOOKS\/maintenance\.sh$/m);
  assert.match(setup, /^OnUnitActiveSec=15min$/m);
  assert.match(setup, /^systemctl enable --now pilotswarm-ci-runner-maintenance\.timer$/m);
});

// The maintenance script has fixed absolute paths, like the hook. Copy it with
// those paths pointed at recording stand-ins.
function maintenanceFixture(t, { jobRunning = [], rebootPending = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-runner-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, 'calls');
  const answers = join(root, 'job-running');
  writeFileSync(calls, '');
  // One line per check: "yes" means a job is running. No line left means no job.
  writeFileSync(answers, jobRunning.map(running => (running ? 'yes' : 'no')).join('\n') + (jobRunning.length ? '\n' : ''));
  const script = (name, body) => {
    const path = join(root, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const paths = {
    REBOOT_FLAG: join(root, 'reboot-required'),
    PGREP: script('pgrep', `echo "pgrep $*" >> "${calls}"\nanswer="$(head -1 "${answers}")"; sed -i.bak 1d "${answers}"\n[ "$answer" = yes ]`),
    SYSTEMCTL: script('systemctl', `echo "systemctl $*" >> "${calls}"`),
    LOGGER: script('logger', `echo "logger $*" >> "${calls}"`),
  };
  if (rebootPending) writeFileSync(paths.REBOOT_FLAG, '');
  let text = runnerFile('maintenance.sh');
  for (const [name, value] of Object.entries(paths)) {
    assert.match(text, new RegExp(`^${name}=/.+$`, 'm'));
    text = text.replace(new RegExp(`^${name}=.+$`, 'm'), `${name}=${value}`);
  }
  const file = join(root, 'maintenance.sh');
  writeFileSync(file, text);
  const result = spawnSync('bash', [file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

test('maintenance installs OS updates and reboots only while no job runs', t => {
  // A job is running: nothing happens.
  const busy = maintenanceFixture(t, { jobRunning: [true], rebootPending: true });
  assert.equal(busy.status, 0, busy.output);
  assert.deepEqual(busy.calls, ['pgrep -u runner -f Runner\\.Worker']);

  // Idle, no reboot pending: the daily update is started, and nothing else.
  const idle = maintenanceFixture(t);
  assert.equal(idle.status, 0, idle.output);
  assert.deepEqual(idle.calls.filter(call => call.startsWith('systemctl')), ['systemctl start apt-daily-upgrade.service']);

  // Idle with a pending reboot: stop taking jobs, then reboot.
  const reboot = maintenanceFixture(t, { rebootPending: true });
  assert.equal(reboot.status, 0, reboot.output);
  assert.deepEqual(reboot.calls.filter(call => !call.startsWith('pgrep')), [
    'systemctl start apt-daily-upgrade.service',
    'logger -t pilotswarm-ci-runner OS updates need a reboot and the runner is idle. Rebooting.',
    'systemctl stop pilotswarm-ci-runner.service',
    'systemctl reboot',
  ]);

  // A job that starts while the update is being installed keeps the machine up.
  const arrived = maintenanceFixture(t, { jobRunning: [false, true], rebootPending: true });
  assert.equal(arrived.status, 0, arrived.output);
  assert.deepEqual(arrived.calls.filter(call => call.startsWith('systemctl')), ['systemctl start apt-daily-upgrade.service']);
});

// The hook has fixed absolute paths. For a test, copy it with those paths
// pointed at a temporary directory and at recording stand-ins for the tools.
function hookFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-runner-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, 'calls');
  const stub = (name, extra = '') => {
    const path = join(root, name);
    writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${extra}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  // What the stand-ins answer: the containers left on the machine, and how
  // many more times the OS update reports that it is still being installed.
  const containers = join(root, 'containers');
  const updating = join(root, 'updating');
  const paths = { ALLOWED: join(root, 'allowed-workflows'), WORK_ROOT: join(root, 'work'), TMP_ROOT: join(root, 'tmp'),
    PKILL: stub('pkill'), LOGGER: stub('logger'), SLEEP: stub('sleep'),
    DOCKER: stub('docker', `if [ "$1" = ps ]; then cat "${containers}" 2>/dev/null; fi`),
    SYSTEMCTL: stub('systemctl', `left="$(cat "${updating}" 2>/dev/null || echo 0)"; if [ "$left" -gt 0 ]; then echo $((left - 1)) > "${updating}"; echo activating; else echo inactive; fi`) };
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
    for (const dir of [join(home, '.azure'), join(home, '.kube'), join(home, '.config', 'gh'), join(home, 'keep'), join(workspace, 'deploy', '.tmp'),
      join(paths.TMP_ROOT, 'left-by-a-test', 'nested')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(workspace, '.env'), 'left behind');
    writeFileSync(join(paths.TMP_ROOT, 'left-file'), 'left behind');
    writeFileSync(calls, '');
  };
  const run = (mode, env = {}, { goneFolder = false, leftContainers = '', updateChecks = 0 } = {}) => {
    seed();
    writeFileSync(containers, leftContainers);
    writeFileSync(updating, String(updateChecks));
    // The runner program may start the hook from any folder, also one that no longer exists.
    const cwd = mkdtempSync(join(root, 'start-'));
    const result = spawnSync('bash', ['-c', `${goneFolder ? 'rmdir "$PWD"; ' : ''}exec bash "$0" "$@"`, hook, ...(mode ? [mode] : [])], { encoding: 'utf8', cwd,
      env: { PATH: process.env.PATH, HOME: home, GITHUB_WORKSPACE: workspace, ...env } });
    return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(calls, 'utf8'),
      signIns: existsSync(join(home, '.azure')) || existsSync(join(home, '.kube')) || existsSync(join(home, '.config', 'gh')),
      checkout: readdirSync(workspace), temp: readdirSync(paths.TMP_ROOT) };
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
    assert.doesNotMatch(ok.calls, /^docker rm/m);
    assert.doesNotMatch(ok.calls, /^sleep/m);
    assert.equal(ok.signIns, false);
    assert.deepEqual(ok.checkout, []);
    assert.deepEqual(ok.temp, []);
    assert(existsSync(join(f.home, 'keep')));
  }
});

test('before a job, the hook removes containers that a cut-off job left, running ones too', t => {
  const f = hookFixture(t);
  const ok = f.run('started', { GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/tests.yml@refs/heads/main' },
    { leftContainers: 'aaa111\nbbb222\n' });
  assert.equal(ok.status, 0, ok.output);
  const docker = ok.calls.split('\n').filter(call => call.startsWith('docker'));
  assert.deepEqual(docker, ['docker ps --all --quiet', 'docker rm --force aaa111 bbb222', 'docker system prune --all --force --volumes']);
});

test('before a job, the hook waits while the machine installs OS updates', t => {
  const f = hookFixture(t);
  const waited = f.run('started', { GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/tests.yml@refs/heads/main' }, { updateChecks: 2 });
  assert.equal(waited.status, 0, waited.output);
  assert.match(waited.output, /The runner machine is installing OS updates\. This job waits until that is done\./);
  const order = waited.calls.split('\n').filter(call => /^(systemctl|sleep|docker ps)/.test(call));
  assert.deepEqual(order, ['systemctl is-active apt-daily-upgrade.service', 'sleep 10', 'systemctl is-active apt-daily-upgrade.service', 'sleep 10',
    'systemctl is-active apt-daily-upgrade.service', 'docker ps --all --quiet']);
  // A refused job does not wait and does not ask.
  const refused = f.run('started', { GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/tests.yml@refs/heads/feature' }, { updateChecks: 2 });
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.calls, /systemctl|sleep/);
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
  assert.doesNotMatch(done.calls, /pkill|systemctl|sleep/);
  assert.deepEqual(done.temp, []);
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
