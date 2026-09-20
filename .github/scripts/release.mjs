import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const packages = ['sdk', 'horizon-store', 'app'];
export function validatePackageLicenses(root = process.cwd()) {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  for (const p of packages) {
    if (readFileSync(join(root, 'packages', p, 'LICENSE'), 'utf8') !== license) {
      throw new Error(`packages/${p}/LICENSE must match the root copyright and permission notice.`);
    }
  }
  return license;
}
export function validatePackedLicense(tarball, license) {
  const files = run('tar', ['-tzf', tarball]).split('\n');
  if (files.filter(file => file === 'package/LICENSE').length !== 1 ||
      run('tar', ['-xOzf', tarball, 'package/LICENSE']) !== license.trim()) {
    throw new Error(`${tarball} must contain the complete canonical package/LICENSE.`);
  }
}
export function addReleaseLicense(version, { repository, root = process.cwd(), runFn = run } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[\w.-]+\/[\w.-]+$/.test(repository || '')) {
    throw new Error('A stable release version and owner/repository are required.');
  }
  const license = validatePackageLicenses(root);
  const digest = `sha256:${createHash('sha256').update(license).digest('hex')}`;
  const tag = `v${version}`;
  const readRelease = () => JSON.parse(runFn('gh', ['api', `repos/${repository}/releases/tags/${tag}`]));
  const before = readRelease();
  if (before.draft || before.tag_name !== tag) throw new Error('License maintenance requires an existing published release.');
  const existing = before.assets.find(asset => asset.name === 'LICENSE');
  if (existing && existing.digest !== digest) throw new Error('Existing release LICENSE differs; never overwrite published assets.');
  const directory = join(root, 'dist-tarballs');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'LICENSE');
  writeFileSync(file, license);
  if (!existing) runFn('gh', ['release', 'upload', tag, '--repo', repository, file]);
  const after = readRelease();
  const identity = asset => JSON.stringify([asset.id, asset.name, asset.size, asset.digest]);
  if (after.draft || after.tag_name !== before.tag_name || after.target_commitish !== before.target_commitish ||
      before.assets.some(asset => !after.assets.some(candidate => identity(asset) === identity(candidate))) ||
      after.assets.find(asset => asset.name === 'LICENSE')?.digest !== digest) {
    throw new Error('Release asset verification failed; inspect the release without replacing any assets.');
  }
  console.log(`Verified ${tag} LICENSE; existing package assets and checksums are unchanged.`);
}
export function validateRelease(version, manifests, lock, changelog) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Release version must be a stable major.minor.patch version.');
  const names = new Set(manifests.map(p => p.name));
  for (let i = 0; i < manifests.length; i++) {
    const p = manifests[i];
    if (p.version !== version || lock.packages[`packages/${packages[i]}`]?.version !== version) throw new Error('Package and lockfile versions must match the prepared release.');
    for (const dependencies of [p.dependencies, p.devDependencies, p.peerDependencies, p.optionalDependencies]) {
      for (const [name, range] of Object.entries(dependencies || {})) {
        if (names.has(name) && range !== version) throw new Error('Internal package dependencies must match the release version.');
      }
    }
  }
  if (!changelog.includes(`## [${version}]`) && !changelog.includes(`## ${version}`)) throw new Error('Add the prepared release version to CHANGELOG.md.');
}
function run(command, args, { optional = false } = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || r.error) {
    if (optional) return undefined;
    throw new Error(`${command} ${args[0]} failed: ${r.stderr || r.error || r.status}`);
  }
  return r.stdout.trim();
}
export function main(command) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Release publication runs only through the main-branch GitHub Action.');
  const version = process.env.RELEASE_VERSION;
  if (command === 'notices') {
    addReleaseLicense(version, { repository: process.env.GITHUB_REPOSITORY });
    return;
  }
  const manifests = packages.map(p => JSON.parse(readFileSync(`packages/${p}/package.json`, 'utf8')));
  validateRelease(version, manifests, JSON.parse(readFileSync('package-lock.json', 'utf8')), readFileSync('CHANGELOG.md', 'utf8'));
  const license = validatePackageLicenses();
  const sha = run('git', ['rev-parse', 'HEAD']);
  if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout differs from the workflow candidate commit.');
  const tag = `v${version}`;
  const existing = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  if (existing) throw new Error('Release tag already exists. Use the deploy workflow to retry deployment; never republish an existing version.');
  if (command === 'validate') { console.log(`Candidate ${tag} at ${sha} is ready for full provider testing.`); return; }
  if (command !== 'publish') throw new Error('Expected validate, publish or notices.');
  mkdirSync('dist-tarballs', { recursive: true });
  const expected = manifests.map(p => `${p.name}-${version}.tgz`).sort();
  for (const p of packages) run('npm', ['pack', `./packages/${p}`, '--pack-destination', 'dist-tarballs']);
  const actual = readdirSync('dist-tarballs').filter(f => f.endsWith('.tgz')).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Expected exactly the three release package tarballs.');
  for (const f of actual) validatePackedLicense(`dist-tarballs/${f}`, license);
  copyFileSync('LICENSE', 'dist-tarballs/LICENSE');
  const checksums = actual.map(f => `${createHash('sha256').update(readFileSync(`dist-tarballs/${f}`)).digest('hex')}  ${f}`).join('\n') + '\n';
  writeFileSync('dist-tarballs/SHA256SUMS', checksums);
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['tag', '-a', tag, sha, '-m', `PilotSwarm ${tag}`]);
  run('git', ['push', 'origin', `refs/tags/${tag}`]);
  run('gh', ['release', 'create', tag, '--verify-tag', '--draft', '--title', `PilotSwarm ${tag}`, '--generate-notes', ...actual.map(f => `dist-tarballs/${f}`), 'dist-tarballs/SHA256SUMS', 'dist-tarballs/LICENSE']);
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'assets,isDraft']));
  const assets = release.assets.map(a => a.name).sort();
  if (!release.isDraft || JSON.stringify(assets) !== JSON.stringify([...expected, 'SHA256SUMS', 'LICENSE'].sort())) throw new Error('Draft release assets are incomplete; publication stopped.');
  run('gh', ['release', 'edit', tag, '--draft=false', '--latest']);
  console.log(`Published ${tag} with three npm-format package tarballs, SHA256SUMS and LICENSE. Deploying tested commit ${sha}.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
