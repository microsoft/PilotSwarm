import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanText, checkIndex } from '../../../scripts/check-repository-privacy.mjs';

test('privacy check rejects concrete endpoints and Azure identities without returning values', () => {
  const host = ['private-resource', 'azurecr.io'].join('.');
  const id = ['12345678', 'abcd', '4567', '89ab', '123456789abc'].join('-');
  const findings = scanText('config.md', `https://${host}\nAZURE_CLIENT_ID=${id}`);
  assert.deepEqual(findings.map(x => x.rule), ['concrete-azure-host', 'concrete-azure-identity']);
  assert.ok(!JSON.stringify(findings).includes(host));
  assert.ok(!JSON.stringify(findings).includes(id));
});

test('examples, secret names, public Azure IDs and structure remain shareable', () => {
  assert.deepEqual(scanText('example.md', [
    'https://example-foundry.cognitiveservices.azure.com',
    'AZURE_SUBSCRIPTION_ID=<your-subscription-id>',
    'tenantId: 11111111-1111-1111-1111-111111111111',
    'clientId: c632b3df-fb67-4d84-bdcf-b95ad541b5c8',
    'secrets.AZURE_CI_DATABASE_JSON',
    'RESOURCE_GROUP="${RESOURCE_GROUP}"',
    'GITHUB_TOKEN=ghp_' + 'x'.repeat(36),
  ].join('\n')), []);
});

test('credential patterns are rejected without printing the credential', () => {
  for (const value of ['ghp_' + 'Ab1Cd2Ef3Gh4'.repeat(3), 'AccountKey=' + 'aB9/'.repeat(22), '-----BEGIN ' + 'PRIVATE KEY-----']) {
    assert.ok(scanText('bad.txt', value).length > 0);
    assert.ok(!JSON.stringify(scanText('bad.txt', value)).includes(value));
  }
});

test('the staged snapshot is checked and ignored local secrets are never scanned', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'privacy-test-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git('init', '-q');
    writeFileSync(join(cwd, '.gitignore'), '.env\n');
    writeFileSync(join(cwd, '.env'), 'GITHUB_TOKEN=ghp_' + 'Ab1Cd2Ef3Gh4'.repeat(3));
    writeFileSync(join(cwd, 'guide.md'), 'Safe public instructions');
    git('add', '.');
    assert.equal(checkIndex(cwd).findings.length, 0);
    writeFileSync(join(cwd, 'guide.md'), 'https://' + ['private-resource', 'azurecr.io'].join('.'));
    assert.equal(checkIndex(cwd).findings.length, 0);
    git('add', 'guide.md');
    assert.equal(checkIndex(cwd).findings[0].rule, 'concrete-azure-host');
    git('add', '-f', '.env');
    assert.ok(checkIndex(cwd).findings.some(x => x.rule === 'private-config-tracked'));
    mkdirSync(join(cwd, 'nested'));
    writeFileSync(join(cwd, 'nested/.env'), 'DATABASE_URL=private');
    git('add', '-f', 'nested/.env');
    assert.ok(checkIndex(cwd).findings.some(x => x.path === 'nested/.env' && x.rule === 'private-config-tracked'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
