// Operator tool for the repository's Azure runner machine.
//
// Run it from a shell that is signed in to Azure (`az login`) with rights on
// the runner's resource group. A GitHub-hosted job cannot run it: such a job
// has no Azure sign-in. See README.md in this directory.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = '2025-04-01';
export const OPERATIONS = ['setup', 'start', 'deallocate', 'status'];

export function validateRunnerConfig(c) {
  for (const key of ['name', 'label', 'vmSize']) {
    if (typeof c[key] !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c[key])) throw new Error(`Invalid runner ${key}.`);
  }
  if (!c.name.endsWith('-ci-runner') || c.name.length > 48) throw new Error('Use a dedicated name ending in -ci-runner (maximum 48 characters).');
  if (!c.label.startsWith('ci-') || c.label.length > 128) throw new Error('Use a dedicated ci- runner label.');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(c.repository || '')) throw new Error('Invalid repository.');
  if (!/^[a-f0-9-]{36}$/i.test(c.subscription || '')) throw new Error('Invalid runner subscription.');
  for (const key of ['resourceGroup', 'location']) {
    if (!/^[a-zA-Z0-9._-]+$/.test(c[key] || '')) throw new Error(`Invalid runner ${key}.`);
  }
  const { name, label, vmSize, repository, subscription, resourceGroup, location } = c;
  return { name, label, vmSize, repository, subscription, resourceGroup, location };
}

// An unchanged Run Command can return an earlier run's result without running
// again, so every setup gets its own command name.
export function setupCommandName(now = new Date()) {
  return `setup-ci-runner-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
}

// One script for Run Command: it writes the job hook to disk, then runs the
// setup. The hook travels as base64 so its text cannot end the here-document.
export function composeSetupScript({
  setup = readFileSync(join(here, 'setup.sh'), 'utf8'),
  hook = readFileSync(join(here, 'job-hook.sh'), 'utf8'),
} = {}) {
  const encoded = Buffer.from(hook, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n').trimEnd();
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'install -d -m 0755 /usr/local/lib/pilotswarm-ci-runner',
    "base64 -d > /usr/local/lib/pilotswarm-ci-runner/job-hook.sh <<'PILOTSWARM_JOB_HOOK'",
    encoded,
    'PILOTSWARM_JOB_HOOK',
    setup,
  ].join('\n');
}

// The registration token is the only secret. It goes into protectedParameters,
// which Azure does not return or log.
export function runCommandBody(c, { script, token, start = true }) {
  if (token !== undefined && !/^[A-Za-z0-9_=-]+$/.test(token)) throw new Error('The runner registration token has an unexpected form.');
  return { location: c.location, properties: {
    source: { script },
    timeoutInSeconds: 1800, asyncExecution: false, treatFailureAsDeploymentFailure: true,
    parameters: [
      { name: 'RUNNER_REPOSITORY', value: c.repository }, { name: 'RUNNER_LABEL', value: c.label },
      { name: 'RUNNER_NAME', value: c.name }, { name: 'RUNNER_START', value: start ? 'true' : 'false' },
    ],
    ...(token ? { protectedParameters: [{ name: 'RUNNER_TOKEN', value: token }] } : {}),
  } };
}

function command(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`${bin} ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  return r.stdout.trim();
}
const az = args => command('az', args);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function main(operation, env = process.env) {
  // A hosted job has no Azure sign-in, and a job on the runner must not
  // reconfigure the machine it runs on.
  if (env.GITHUB_ACTIONS === 'true') throw new Error('Runner management runs from an operator shell that is signed in to Azure, not from a workflow.');
  if (!OPERATIONS.includes(operation)) throw new Error(`Expected one of: ${OPERATIONS.join(', ')}.`);
  let parsed;
  try { parsed = JSON.parse(env.AZURE_CI_RUNNER_JSON || ''); } catch { throw new Error('Set AZURE_CI_RUNNER_JSON to the runner configuration (see README.md).'); }
  const c = validateRunnerConfig(parsed);
  const base = `https://management.azure.com/subscriptions/${c.subscription}/resourceGroups/${c.resourceGroup}`;
  const vmUrl = `${base}/providers/Microsoft.Compute/virtualMachines/${c.name}`;
  const vmArgs = ['--subscription', c.subscription, '--resource-group', c.resourceGroup, '--name', c.name];
  const existing = JSON.parse(az(['vm', 'list', '--subscription', c.subscription, '--resource-group', c.resourceGroup, '-o', 'json'])).find(vm => vm.name === c.name);
  if (existing && (existing.tags?.purpose !== 'pilotswarm-ci-runner' || existing.tags?.repository !== c.repository)) throw new Error('The existing machine is not owned by this runner configuration.');
  if (operation !== 'setup' && !existing) throw new Error('The runner machine does not exist. Run the setup first.');

  if (operation === 'status') {
    const power = az(['vm', 'get-instance-view', ...vmArgs, '--query', "instanceView.statuses[?starts_with(code, 'PowerState/')].displayStatus | [0]", '-o', 'tsv']);
    console.log(`Machine: ${power}`);
    console.log(`Identity (object ID) to grant roles to: ${existing.identity?.principalId || 'none; run the setup'}`);
    return;
  }
  if (operation === 'start') {
    az(['vm', 'start', ...vmArgs, '-o', 'none']);
    console.log('Runner machine started. The runner service starts at boot.');
    return;
  }
  if (operation === 'deallocate') {
    az(['vm', 'deallocate', ...vmArgs, '-o', 'none']);
    console.log('Runner machine deallocated. Disk and outbound address are kept. Queued Azure jobs wait until it starts again.');
    return;
  }

  const token = env.CI_RUNNER_REGISTRATION_TOKEN || undefined;
  const temp = mkdtempSync(join(tmpdir(), 'azure-ci-runner-'));
  const url = `${vmUrl}/runCommands/${setupCommandName()}?api-version=${api}`;
  try {
    if (!existing) {
      if (!token) throw new Error('A new machine needs CI_RUNNER_REGISTRATION_TOKEN: a fresh repository runner registration token.');
      command('ssh-keygen', ['-q', '-t', 'rsa', '-b', '3072', '-N', '', '-f', join(temp, 'unused-ssh-key')]);
      const group = JSON.parse(az(['group', 'show', '--subscription', c.subscription, '--name', c.resourceGroup, '-o', 'json']));
      const params = { location: c.location, name: c.name, vmSize: c.vmSize,
        sshPublicKey: readFileSync(join(temp, 'unused-ssh-key.pub'), 'utf8').trim(),
        tags: { ...(group.tags || {}), purpose: 'pilotswarm-ci-runner', repository: c.repository } };
      const file = join(temp, 'parameters.json');
      writeFileSync(file, JSON.stringify({ parameters: Object.fromEntries(Object.entries(params).map(([k, value]) => [k, { value }])) }), { mode: 0o600 });
      az(['deployment', 'group', 'create', '--subscription', c.subscription, '--resource-group', c.resourceGroup,
        '--name', `ci-runner-${Date.now()}`, '--template-file', join(here, 'main.bicep'), '--parameters', `@${file}`, '-o', 'none']);
    } else {
      if (existing.location.toLowerCase() !== c.location.toLowerCase()) throw new Error('The existing runner machine is in a different region.');
      az(['vm', 'start', ...vmArgs, '-o', 'none']);
    }
    const file = join(temp, 'run-command.json');
    writeFileSync(file, JSON.stringify(runCommandBody(c, { script: composeSetupScript(), token, start: env.CI_RUNNER_START !== 'false' })), { mode: 0o600 });
    az(['rest', '--method', 'put', '--url', url, '--body', `@${file}`, '-o', 'none']);
    const deadline = Date.now() + 32 * 60_000;
    while (Date.now() < deadline) {
      const state = JSON.parse(az(['rest', '--method', 'get', '--url', `${url}&$expand=instanceView`, '-o', 'json']));
      const view = state.properties.instanceView;
      if (view?.executionState === 'Succeeded' && view.exitCode === 0) {
        console.log((view.output || '').trim().split('\n').slice(-4).join('\n'));
        console.log('Runner machine is set up.');
        return;
      }
      if (['Failed', 'TimedOut', 'Canceled'].includes(view?.executionState) || state.properties.provisioningState === 'Failed'
        || (view?.executionState === 'Succeeded' && view.exitCode !== 0)) {
        throw new Error(`Runner setup failed: ${(view?.error || view?.output || '').trim().split('\n').slice(-6).join(' | ')}`);
      }
      await sleep(10_000);
    }
    throw new Error('Runner setup did not finish before its deadline.');
  } finally {
    rmSync(temp, { recursive: true, force: true });
    // The command resource holds the script text. Remove it once it has run.
    spawnSync('az', ['rest', '--method', 'delete', '--url', url, '-o', 'none'], { encoding: 'utf8' });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
