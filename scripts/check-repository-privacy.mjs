#!/usr/bin/env node
// Scan the current Git index, never ignored local configuration or old commits.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const policy = JSON.parse(readFileSync(new URL('./repository-privacy-policy.json', import.meta.url)));
const azureHost = /\b(?:[a-z0-9_-]+\.)+(?:azurecr\.io|cloudapp\.azure\.com|postgres\.database\.azure\.com|cognitiveservices\.azure\.com|openai\.azure\.com|services\.ai\.azure\.com|vault\.azure\.net|(?:blob|file|queue|table)\.core\.windows\.net|azurewebsites\.net)\b/gi;
const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
const identityContext = /(?:^|[^a-z0-9])(?:subscription(?:[_ -]?id)?|tenant(?:[_ -]?id)?|client[_ -]?id|app(?:lication)?[_ -]?id|principal[_ -]?id|ExistingAppId|serviceManagementReference)\b/i;
const tokens = /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,}|sk-(?:proj-|ant-api\d+-)?[a-zA-Z0-9_-]{32,})\b/g;
const placeholderToken = value => /^(?:gh[pousr]_|github_pat_|sk-(?:proj-|ant-api\d+-)?)[xX0]+$/.test(value);
const placeholderId = value => new Set(value.replaceAll('-', '')).size <= 2 || value.split('-').every(part => new Set(part).size === 1);

export function scanText(path, text) {
  const findings = [];
  const add = (line, rule) => findings.push({ path, line, rule });
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    for (const match of line.matchAll(azureHost)) {
      const host = match[0].toLowerCase();
      if (!policy.exampleAzureHosts.includes(host) && !policy.publicAzureHosts.includes(host) && !/^__[a-z0-9_]+__\./.test(host)) add(number, 'concrete-azure-host');
    }
    {
      for (const match of line.matchAll(uuid)) {
        if (!identityContext.test(line.slice(Math.max(0, match.index - 100), match.index))) continue;
        const id = match[0].toLowerCase();
        if (!placeholderId(id) && !Object.hasOwn(policy.publicAzureIds, id)) add(number, 'concrete-azure-identity');
      }
    }
    for (const match of line.matchAll(/\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\//gi)) {
      if (!placeholderId(match[1])) add(number, 'literal-azure-resource-id');
    }
    for (const match of line.matchAll(tokens)) {
      if (!placeholderToken(match[0])) add(number, 'credential-token');
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) add(number, 'private-key');
    if (/AccountKey=[a-zA-Z0-9+/]{70,}={0,2}/.test(line)) add(number, 'storage-account-key');
    if (/[?&]sig=[a-zA-Z0-9%+/]{30,}/.test(line)) add(number, 'signed-url');
    // Flag literal cloud configuration assignments; variable references and
    // explicit examples remain useful documentation for external operators.
    const assignment = line.match(/^\s*(?:export\s+)?(?:ACR_NAME|ACR_REGISTRY|K8S_CONTEXT|RESOURCE_GROUP|SUBSCRIPTION_ID|AZURE_SUBSCRIPTION_ID|PORTAL_HOST(?:NAME)?)\s*=\s*["']?([^\s"'`#]+)/);
    if (assignment) {
      const value = assignment[1];
      if (value && !/[$<{}]|placeholder|example|^your[-_]|^my[-_]|^test[-_]|^__|^0{8}-|^unused$|^\.\.\.$/.test(value)) add(number, 'literal-deployment-setting');
    }
  }
  return findings;
}

export function checkIndex(cwd = process.cwd()) {
  const entries = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd }).toString().split('\0').filter(Boolean).map(entry => {
    const match = entry.match(/^\d+ ([a-f0-9]+) (\d)\t([\s\S]+)$/);
    if (!match || match[2] !== '0') throw new Error('Resolve index conflicts before checking repository privacy.');
    return { oid: match[1], path: match[3] };
  });
  const findings = [];
  // One Git process reads the indexed blobs; no filesystem config is loaded.
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    cwd, input: entries.map(x => x.oid).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  for (const { path } of entries) {
    const isOverlayTemplate = /^deploy\/providers\/azure\/gitops\/[^/]+\/overlays\/[^/]+\/\.env$/.test(path);
    if (path.startsWith('deploy/envs/local/') || (!isOverlayTemplate && /(?:^|\/)\.env(?:$|\.(?!example$|horizondb\.example$))/.test(path)) || /(?:^|\/)\.model_providers\.json$/.test(path)) {
      findings.push({ path, line: 1, rule: 'private-config-tracked' });
    }
    const end = blobs.indexOf(10, offset);
    const [, type, size] = blobs.subarray(offset, end).toString().split(' ');
    const content = blobs.subarray(end + 1, end + 1 + Number(size));
    offset = end + 2 + Number(size);
    if (type !== 'blob') continue;
    if (content.includes(0)) continue; // Binary files require separate review.
    findings.push(...scanText(path, content.toString('utf8')));
  }
  return { count: entries.length, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { count, findings } = checkIndex();
  for (const { path, line, rule } of findings) {
    // Never echo the matched value: logs must not amplify a leaked credential.
    console.error(`${path}:${line}: ${rule}`);
  }
  console.log(`Repository privacy: ${count} indexed files; ${findings.length} finding(s).`);
  if (findings.length) process.exitCode = 1;
}
