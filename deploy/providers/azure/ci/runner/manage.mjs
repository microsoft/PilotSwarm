import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = '2025-04-01';
export function registrationCommandName(runId, attempt) {
  if (!/^\d+$/.test(runId || '') || !/^\d+$/.test(attempt || '')) throw new Error('A workflow run ID and attempt are required for registration.');
  return `register-ci-runner-${runId}-${attempt}`;
}
export function validateRunnerConfig(c, database, repository) {
  for (const key of ['name', 'label', 'vmSize']) {
    if (typeof c[key] !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c[key])) throw new Error(`Invalid runner ${key}.`);
  }
  if (!c.name.endsWith('-ci-runner') || c.name.length > 48) throw new Error('Use a dedicated name ending in -ci-runner (maximum 48 characters).');
  if (!c.label.startsWith('ci-') || c.label.length > 128) throw new Error('Use a dedicated ci- runner label.');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid repository.');
  if (!/^[a-f0-9-]{36}$/i.test(database.subscription || '')) throw new Error('Invalid CI subscription.');
  for (const key of ['resourceGroup', 'location', 'cluster']) {
    if (!/^[a-zA-Z0-9._-]+$/.test(database[key] || '')) throw new Error(`Invalid CI database ${key}.`);
  }
  if (database.cluster === database.appCluster) throw new Error('Runner must target the dedicated CI database.');
  return { ...c, subscription: database.subscription, resourceGroup: database.resourceGroup, location: database.location, repository };
}
function mask(value) {
  console.log(`::add-mask::${String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}
function command(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${bin} ${args.slice(0, 2).join(' ')} failed; private command output withheld.`);
  return r.stdout.trim();
}
const az = args => command('az', args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function main(operation) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || !process.env.RUNNER_TEMP) throw new Error('Runner management runs only in the protected main-branch Action.');
  if (!['register', 'deallocate'].includes(operation)) throw new Error('Expected register or deallocate.');
  const registrationName = operation === 'register'
    ? registrationCommandName(process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT) : undefined;
  const db = JSON.parse(process.env.AZURE_CI_DATABASE_JSON || '{}');
  const c = validateRunnerConfig(JSON.parse(process.env.AZURE_CI_RUNNER_JSON || '{}'), db, process.env.GITHUB_REPOSITORY);
  for (const value of Object.values(c)) mask(value);
  const base = `https://management.azure.com/subscriptions/${c.subscription}/resourceGroups/${c.resourceGroup}`;
  const vmUrl = `${base}/providers/Microsoft.Compute/virtualMachines/${c.name}`;
  const vmArgs = ['--subscription', c.subscription, '--resource-group', c.resourceGroup, '--name', c.name];
  // Fail closed on a mismatched private configuration: placement follows the
  // existing CI database, never a separate hard-coded region in source control.
  const database = JSON.parse(az(['rest', '--method', 'get', '--url', `${base}/providers/Microsoft.HorizonDb/clusters/${db.cluster}?api-version=2026-01-20-preview`]));
  if (database.location.toLowerCase() !== c.location.toLowerCase()) throw new Error('Configured runner and actual CI database regions differ.');
  const existing = JSON.parse(az(['vm', 'list', '--subscription', c.subscription, '--resource-group', c.resourceGroup, '-o', 'json'])).find(vm => vm.name === c.name);
  if (existing && (existing.tags?.purpose !== 'pilotswarm-ci-runner' || existing.tags?.repository !== c.repository)) throw new Error('Existing VM is not owned by this CI runner configuration.');
  if (operation === 'deallocate') {
    if (!existing) throw new Error('CI runner VM does not exist.');
    // The shared concurrency group prevents management while the protected
    // provider/release job is using the VM. No application resources are touched.
    az(['vm', 'deallocate', ...vmArgs, '-o', 'none']);
    console.log('CI runner VM deallocated; disk and outbound address are retained.');
    return;
  }
  const token = process.env.CI_RUNNER_REGISTRATION_TOKEN;
  if (!token || !/^[A-Za-z0-9_=-]+$/.test(token)) throw new Error('Provide a fresh repository runner registration token.');
  mask(token);
  const temp = mkdtempSync(join(process.env.RUNNER_TEMP, 'azure-ci-runner-'));
  try {
    if (!existing) {
      command('ssh-keygen', ['-q', '-t', 'rsa', '-b', '3072', '-N', '', '-f', join(temp, 'unused-ssh-key')]);
      const group = JSON.parse(az(['group', 'show', '--subscription', c.subscription, '--name', c.resourceGroup, '-o', 'json']));
      const params = { location: c.location, name: c.name, vmSize: c.vmSize,
        sshPublicKey: readFileSync(join(temp, 'unused-ssh-key.pub'), 'utf8').trim(),
        tags: { ...(group.tags || {}), purpose: 'pilotswarm-ci-runner', repository: c.repository } };
      const file = join(temp, 'parameters.json');
      writeFileSync(file, JSON.stringify({ parameters: Object.fromEntries(Object.entries(params).map(([k, value]) => [k, { value }])) }), { mode: 0o600 });
      az(['deployment', 'group', 'create', '--subscription', c.subscription, '--resource-group', c.resourceGroup,
        '--name', `ci-runner-${process.env.GITHUB_RUN_ID}`, '--template-file', join(here, 'main.bicep'), '--parameters', `@${file}`, '-o', 'none']);
    } else {
      if (existing.location.toLowerCase() !== c.location.toLowerCase()) throw new Error('Existing runner is in a different region.');
      az(['vm', 'start', ...vmArgs, '-o', 'none']);
    }
    const body = { location: c.location, properties: {
      source: { script: readFileSync(join(here, 'register.sh'), 'utf8') },
      timeoutInSeconds: 1800, asyncExecution: false, treatFailureAsDeploymentFailure: true,
      parameters: [
        { name: 'RUNNER_REPOSITORY', value: c.repository }, { name: 'RUNNER_LABEL', value: c.label },
        { name: 'RUNNER_NAME', value: c.name },
      ],
      protectedParameters: [{ name: 'RUNNER_TOKEN', value: token }],
    } };
    const file = join(temp, 'run-command.json');
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    // An unchanged PUT can return the previous command's successful instance
    // view without executing again. Each workflow attempt needs its own command
    // so registration and its completion evidence belong to this invocation.
    const url = `${vmUrl}/runCommands/${registrationName}?api-version=${api}`;
    az(['rest', '--method', 'put', '--url', url, '--body', `@${file}`, '-o', 'none']);
    const deadline = Date.now() + 32 * 60_000;
    while (Date.now() < deadline) {
      const state = JSON.parse(az(['rest', '--method', 'get', '--url', `${url}&$expand=instanceView`, '-o', 'json']));
      const view = state.properties.instanceView;
      if (view?.executionState === 'Succeeded' && view.exitCode === 0) {
        console.log('Runner provisioned in the CI database region and registered for one job.');
        return;
      }
      if (view?.executionState === 'Failed' || state.properties.provisioningState === 'Failed') throw new Error('Runner bootstrap failed; inspect the private Azure Run Command instance view.');
      await sleep(10_000);
    }
    throw new Error('Runner bootstrap did not finish before its deadline.');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env.RUNNER_OPERATION).catch(error => { console.error(error.message); process.exitCode = 1; });
}
