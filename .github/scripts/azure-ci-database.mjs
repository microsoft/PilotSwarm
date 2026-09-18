// Private configuration stays in the protected GitHub environment and Key Vault.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHorizonDbParameterGroup } from '../../deploy/scripts/lib/horizondb.mjs';

const api = '2026-01-20-preview';
export function validateConfig(c) {
  for (const key of ['subscription', 'resourceGroup', 'location', 'cluster', 'appCluster', 'parameterGroup', 'vault', 'passwordSecret', 'urlSecret', 'embeddingUrl', 'embeddingKeySecret', 'foundryAccount']) {
    if (typeof c[key] !== 'string' || !c[key]) throw new Error(`CI database configuration requires ${key}.`);
  }
  if (c.cluster.toLowerCase() === c.appCluster.toLowerCase()) throw new Error('CI must use a dedicated cluster, separate from the portal.');
  if (!c.passwordSecret.startsWith('ci-') || !c.urlSecret.startsWith('ci-')) throw new Error('CI credentials must have dedicated ci- secret names.');
  if (new URL(c.embeddingUrl).protocol !== 'https:') throw new Error('Embeddings require HTTPS.');
  for (const key of ['resourceGroup', 'cluster', 'appCluster', 'parameterGroup', 'vault', 'passwordSecret', 'urlSecret', 'embeddingKeySecret', 'foundryAccount']) {
    if (!/^[a-zA-Z0-9._-]+$/.test(c[key])) throw new Error(`Invalid CI ${key}.`);
  }
  return c;
}
export function firewallUrl(c, runId, attempt) {
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error('Expected a GitHub Actions run ID and attempt.');
  return `https://management.azure.com/subscriptions/${c.subscription}/resourceGroups/${c.resourceGroup}/providers/Microsoft.HorizonDb/clusters/${c.cluster}/pools/DefaultPool/firewallRules/ci-${runId}-${attempt}?api-version=${api}`;
}
function az(args, { optional = false } = {}) {
  const r = spawnSync('az', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    if (optional && /SecretNotFound|ResourceNotFound|NotFound/.test(r.stderr || '')) return undefined;
    throw new Error(`Azure CI operation failed (${args.slice(0, 2).join(' ')}); private CLI output withheld.`);
  }
  return r.stdout.trim();
}
function mask(value) {
  if (typeof value === 'string' && value.length >= 4) console.log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}
function getSecret(c, name, optional = false) {
  const value = az(['keyvault', 'secret', 'show', '--vault-name', c.vault, '--name', name, '--query', 'value', '-o', 'tsv'], { optional });
  mask(value);
  return value;
}
function putSecret(c, name, value) {
  const file = join(process.env.RUNNER_TEMP, 'ci-secret');
  try {
    writeFileSync(file, value, { mode: 0o600 });
    az(['keyvault', 'secret', 'set', '--vault-name', c.vault, '--name', name, '--file', file, '-o', 'none']);
  } finally { rmSync(file, { force: true }); }
}
function resource(c, type, name, optional = false) {
  const result = az(['rest', '--method', 'get', '--url', `https://management.azure.com/subscriptions/${c.subscription}/resourceGroups/${c.resourceGroup}/providers/Microsoft.HorizonDb/${type}/${name}?api-version=${api}`, '-o', 'json'], { optional });
  return result ? JSON.parse(result) : undefined;
}
async function provision(c) {
  const cluster = resource(c, 'clusters', c.cluster, true);
  let password = getSecret(c, c.passwordSecret, true);
  if (!password && cluster) throw new Error('Existing CI cluster has no saved administrator password; refusing to replace credentials.');
  if (!password) { password = randomBytes(36).toString('base64url'); mask(password); putSecret(c, c.passwordSecret, password); }
  const values = {
    location: c.location, clusterName: c.cluster, parameterGroupName: c.parameterGroup,
    administratorLogin: 'pilotswarmci', administratorLoginPassword: password,
    vCores: 4, replicaCount: 1, clusterCreate: !cluster,
    parameterGroupCreate: !resource(c, 'parameterGroups', c.parameterGroup, true),
  };
  const file = join(process.env.RUNNER_TEMP, 'ci-hdb-parameters.json');
  try {
    writeFileSync(file, JSON.stringify({ parameters: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])) }), { mode: 0o600 });
    az(['deployment', 'group', 'create', '--subscription', c.subscription, '--resource-group', c.resourceGroup,
      '--name', `ci-horizondb-${process.env.GITHUB_RUN_ID}`, '--template-file', 'deploy/providers/azure/services/horizondb/bicep/main.bicep', '--parameters', `@${file}`, '-o', 'none']);
  } finally { rmSync(file, { force: true }); }
  await ensureHorizonDbParameterGroup({ HORIZONDB_ENABLED: 'true', SUBSCRIPTION_ID: c.subscription, RESOURCE_GROUP: c.resourceGroup, HORIZONDB_CLUSTER_NAME: c.cluster, HORIZONDB_PARAMETER_GROUP_NAME: c.parameterGroup }, {
    runFn: (_command, args) => ({ stdout: az(args), status: 0 }),
  });
  const fqdn = resource(c, 'clusters', c.cluster).properties.fullyQualifiedDomainName;
  mask(fqdn);
  if (!fqdn) throw new Error('CI database has no endpoint.');
  const url = new URL(`postgresql://${fqdn}/postgres?sslmode=require&uselibpqcompat=true`);
  url.username = 'pilotswarmci'; url.password = password;
  putSecret(c, c.urlSecret, url.href);
  az(['deployment', 'group', 'create', '--subscription', c.subscription, '--resource-group', c.resourceGroup,
    '--name', `ci-embeddings-${process.env.GITHUB_RUN_ID}`, '--template-file', 'deploy/providers/azure/ci/embeddings.bicep',
    '--parameters', `accountName=${c.foundryAccount}`, '-o', 'none']);
  console.log('Dedicated CI HorizonDB and both live embedding deployments are ready.');
}
async function open(c) {
  const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error('Cannot determine runner IP.');
  const ip = (await r.text()).trim();
  if (isIP(ip) !== 4) throw new Error('Runner firewall requires one IPv4 address.');
  mask(ip);
  az(['rest', '--method', 'put', '--url', firewallUrl(c, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT), '--body', JSON.stringify({ properties: { startIpAddress: ip, endIpAddress: ip, description: 'Temporary GitHub Actions CI runner' } }), '-o', 'none']);
  const baseline = JSON.parse(process.env.CI_TEST_ENV_JSON || '{}');
  if (!baseline.GITHUB_TOKEN) throw new Error('CI_TEST_ENV_JSON requires a Copilot-enabled GITHUB_TOKEN.');
  const url = getSecret(c, c.urlSecret);
  const expected = resource(c, 'clusters', c.cluster).properties.fullyQualifiedDomainName;
  if (new URL(url).hostname !== expected) throw new Error('CI connection does not match the dedicated cluster.');
  const config = { ...baseline, DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/durable_copilot',
    PS_TEST_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/durable_copilot',
    TEST_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/durable_copilot',
    HORIZON_DATABASE_URL: url, HORIZON_GRAPH_DATABASE_URL: url,
    HORIZON_EMBED_URL: c.embeddingUrl, HORIZON_EMBED_API_KEY: getSecret(c, c.embeddingKeySecret),
    HORIZON_EMBED_MODEL: 'text-embedding-3-small', HORIZON_EMBED_DIM: '1536', HORIZON_EMBED_API_KEY_HEADER: 'api-key',
    PS_TEST_SKIP_STALE_CLEANUP: '1' };
  const text = Object.entries(config).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n"']/.test(value)) throw new Error('Invalid CI environment value.');
    mask(value);
    try { const u = new URL(value); mask(u.hostname); mask(decodeURIComponent(u.password)); } catch {}
    return `${key}="${value}"`;
  }).join('\n');
  const marker = `ci_${randomBytes(16).toString('hex')}`;
  appendFileSync(process.env.GITHUB_ENV, `HORIZONDB_TEST_ENV<<${marker}\n${text}\n${marker}\n`);
  console.log('Temporary runner access and full HorizonDB test configuration are ready.');
}
export async function main(command) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw new Error('Azure CI database operations run only in GitHub Actions.');
  const c = validateConfig(JSON.parse(process.env.AZURE_CI_DATABASE_JSON || '{}'));
  Object.values(c).forEach(mask);
  if (command === 'provision') return provision(c);
  if (command === 'open') return open(c);
  if (command === 'close') {
    az(['rest', '--method', 'delete', '--url', firewallUrl(c, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT), '-o', 'none'], { optional: true });
    console.log('Temporary CI firewall access removed.'); return;
  }
  throw new Error('Expected provision, open or close.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
