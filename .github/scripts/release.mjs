import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const packages = ['sdk', 'horizon-store', 'app'];
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
  const manifests = packages.map(p => JSON.parse(readFileSync(`packages/${p}/package.json`, 'utf8')));
  validateRelease(version, manifests, JSON.parse(readFileSync('package-lock.json', 'utf8')), readFileSync('CHANGELOG.md', 'utf8'));
  const sha = run('git', ['rev-parse', 'HEAD']);
  if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout differs from the workflow candidate commit.');
  const tag = `v${version}`;
  const existing = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  if (existing) throw new Error('Release tag already exists. Use the deploy workflow to retry deployment; never republish an existing version.');
  if (command === 'validate') { console.log(`Candidate ${tag} at ${sha} is ready for full provider testing.`); return; }
  if (command !== 'publish') throw new Error('Expected validate or publish.');
  mkdirSync('dist-tarballs', { recursive: true });
  const expected = manifests.map(p => `${p.name}-${version}.tgz`).sort();
  for (const p of packages) run('npm', ['pack', `./packages/${p}`, '--pack-destination', 'dist-tarballs']);
  const actual = readdirSync('dist-tarballs').filter(f => f.endsWith('.tgz')).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Expected exactly the three release package tarballs.');
  const checksums = actual.map(f => `${createHash('sha256').update(readFileSync(`dist-tarballs/${f}`)).digest('hex')}  ${f}`).join('\n') + '\n';
  writeFileSync('dist-tarballs/SHA256SUMS', checksums);
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['tag', '-a', tag, sha, '-m', `PilotSwarm ${tag}`]);
  run('git', ['push', 'origin', `refs/tags/${tag}`]);
  run('gh', ['release', 'create', tag, '--verify-tag', '--draft', '--title', `PilotSwarm ${tag}`, '--generate-notes', ...actual.map(f => `dist-tarballs/${f}`), 'dist-tarballs/SHA256SUMS']);
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'assets,isDraft']));
  const assets = release.assets.map(a => a.name).sort();
  if (!release.isDraft || JSON.stringify(assets) !== JSON.stringify([...expected, 'SHA256SUMS'].sort())) throw new Error('Draft release assets are incomplete; publication stopped.');
  run('gh', ['release', 'edit', tag, '--draft=false', '--latest']);
  console.log(`Published ${tag} with three npm-format package tarballs and SHA256SUMS. Deploying tested commit ${sha}.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
