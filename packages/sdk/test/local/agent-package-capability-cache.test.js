/**
 * A cached package cannot evade the capability policy by changing its own
 * installed tree (issue 311).
 *
 * A package that ran while worker modules were allowed can replace its
 * installed `tools/` folder with a link to another folder and keep the valid
 * sidecar. The layout then shows `tools` but no `tools/worker-module.js`,
 * while an import follows the link. A worker that restarts with
 * `workerModules: "deployment-only"` and keeps the cache must still never import it.
 *
 * Real installer, real canonical archive, real cache; only the registry is a
 * stub, and `loadAgentPackageTools` is wrapped to count attempted imports.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, readdirSync, lstatSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loads = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../src/agent-package-installer.js', async importOriginal => {
    const original = await importOriginal();
    return {
        ...original,
        loadAgentPackageTools: async (pkg, ctx) => {
            loads.calls.push(pkg.packageId);
            return original.loadAgentPackageTools(pkg, ctx);
        },
    };
});
import { PilotSwarmWorker } from '../../src/worker.ts';
import { prepareAgentPackageDir } from '../../src/agent-package-service.ts';
import { agentPackagesArtifactSessionId } from '../../src/agent-package-format.ts';
import { installedAgentPackageLayout, installAgentPackages } from '../../src/agent-package-installer.ts';

let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ps-cap-cache-'));
    loads.calls = [];
    globalThis.__capCacheImports = {};
    return () => rmSync(root, { recursive: true, force: true });
});

const ALICE = { provider: 'test', subject: 'alice' };

/** A real canonical archive of a package that ships a worker module with an import-time marker. */
async function packedPackage(name, version) {
    const dir = join(root, 'src', `${name}-${version}`);
    mkdirSync(join(dir, 'agents'), { recursive: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version, description: 'cache fixture' }));
    writeFileSync(join(dir, 'agents', 'a.agent.md'),
        `---\nname: ${name}-agent\ndescription: fixture\nschemaVersion: 1\nversion: ${version}\n---\n\nPrompt.\n`);
    writeFileSync(join(dir, 'tools', 'worker-module.js'), [
        `globalThis.__capCacheImports[${JSON.stringify(`${name}@${version}`)}] = (globalThis.__capCacheImports[${JSON.stringify(`${name}@${version}`)}] ?? 0) + 1;`,
        `export const tools = [{ name: ${JSON.stringify(`${name.replace(/-/g, '_')}_tool`)}, description: 'f', parameters: { type: 'object', properties: {} }, handler: async () => 'ran' }];`,
        '',
    ].join('\n'));
    const prepared = await prepareAgentPackageDir(dir);
    if (!prepared.ok) throw prepared.error;
    return prepared;
}

function registry(entries, artifacts) {
    return {
        catalog: {
            agentRegistryEpoch: async () => 1,
            getAgentPackagesInstallManifest: async () => entries,
            workerHeartbeat: async () => {},
            listWorkers: async () => [],
        },
        artifactStore: {
            async downloadArtifact(sessionId, filename) {
                expect(sessionId).toBe(agentPackagesArtifactSessionId());
                return { body: artifacts.get(filename) };
            },
        },
    };
}

function installEntry(prepared, packageId, scope, owner) {
    const filename = `${packageId}.tgz`;
    return {
        filename,
        entry: {
            packageId, name: prepared.manifest.name, scope, owner, semver: prepared.manifest.version,
            sha256: prepared.packed.sha256, sizeBytes: prepared.packed.targz.length, artifactFilename: filename,
            manifest: prepared.manifest,
        },
    };
}

async function startWorker(cacheDir, capabilities, { entries, artifacts, retained } = {}) {
    const worker = new PilotSwarmWorker({
        store: 'sqlite::memory:', disableManagementAgents: true, sessionStateDir: join(root, 'sessions'),
        agentPackages: { cacheDir, refreshIntervalMs: 0, ...(capabilities ? { capabilities } : {}) },
    });
    const { catalog, artifactStore } = registry(entries, artifacts);
    worker._catalog = catalog;
    worker.artifactStore = artifactStore;
    if (retained) worker._retainedPackageRevisions = new Map([[retained.packageId, retained]]);
    await worker.refreshAgentPackages({ force: true });
    return worker;
}

/** Turn `<dir>/tools` into an in-root link to `<dir>/payload`, keeping the sidecar. */
function linkToolsAway(dir) {
    expect(existsSync(join(dir, '.pilotswarm-meta.json'))).toBe(true);
    renameSync(join(dir, 'tools'), join(dir, 'payload'));
    symlinkSync('payload', join(dir, 'tools'), 'dir');
    expect(lstatSync(join(dir, 'tools')).isSymbolicLink()).toBe(true);
}

const cachedDirOf = (cacheDir, name) => join(cacheDir, readdirSync(cacheDir).find(entry => entry.startsWith(`${name}@`)));

for (const [label, scope, owner] of [['shared', 'shared', null], ['user-scope', 'user', ALICE]]) {
    it(`an active ${label} package whose cached tools/ became a link is never imported after a restrictive restart`, async () => {
        const name = `cache-${scope}`;
        const prepared = await packedPackage(name, '1.0.0');
        const { filename, entry } = installEntry(prepared, `pkg-${name}`, scope, owner);
        const artifacts = new Map([[filename, prepared.packed.targz]]);
        const cacheDir = join(root, 'cache');

        // While allowed, it installs and its module runs once.
        const allowed = await startWorker(cacheDir, undefined, { entries: [entry], artifacts });
        await allowed.sessionManager.shutdown();
        expect(globalThis.__capCacheImports[`${name}@1.0.0`]).toBe(1);

        // It rewrites its own cached tree.
        linkToolsAway(cachedDirOf(cacheDir, name));
        loads.calls = [];

        // Restart with workerModules deployment-only, keeping the cache.
        const restricted = await startWorker(cacheDir, { workerModules: 'deployment-only' }, { entries: [entry], artifacts });
        try {
            expect(loads.calls).toEqual([]);
            expect(globalThis.__capCacheImports[`${name}@1.0.0`]).toBe(1);
            expect(restricted.loadedAgents.map(agent => agent.name)).not.toContain(`${name}-agent`);
            expect([...restricted.sessionManager.toolRegistry?.keys?.() ?? []]).not.toContain(`${name.replace(/-/g, '_')}_tool`);
            expect(restricted.agentPackageRefusal(`pkg-${name}`)).toMatchObject({ code: 'PACKAGE_CAPABILITY_REFUSED', capability: 'workerModules' });
            // The tampered copy was not trusted: it was unpacked again.
            expect(lstatSync(join(cachedDirOf(cacheDir, name), 'tools')).isSymbolicLink()).toBe(false);
        } finally { await restricted.sessionManager.shutdown(); }
    });
}

it('a pinned earlier revision whose cached tools/ became a link is never imported after a restrictive restart', async () => {
    const name = 'cache-pinned';
    const active = await packedPackage(name, '2.0.0');
    const earlier = await packedPackage(name, '1.0.0');
    const { filename: activeFile, entry } = installEntry(active, `pkg-${name}`, 'shared', null);
    const earlierFile = `pkg-${name}-1.tgz`;
    const artifacts = new Map([[activeFile, active.packed.targz], [earlierFile, earlier.packed.targz]]);
    const pinnedId = `pkg-${name}@${earlier.packed.sha256}`;
    const retained = {
        packageId: pinnedId, pinnedOf: `pkg-${name}`, name, scope: 'shared', owner: null, semver: '1.0.0',
        sha256: earlier.packed.sha256, sizeBytes: earlier.packed.targz.length, artifactFilename: earlierFile, manifest: earlier.manifest,
    };
    const cacheDir = join(root, 'cache');

    const allowed = await startWorker(cacheDir, undefined, { entries: [entry], artifacts, retained });
    await allowed.sessionManager.shutdown();
    expect(globalThis.__capCacheImports[`${name}@1.0.0`]).toBe(1);

    linkToolsAway(cachedDirOf(`${cacheDir}-pinned`, name));
    loads.calls = [];

    const restricted = await startWorker(cacheDir, { workerModules: 'deployment-only' }, { entries: [entry], artifacts, retained });
    try {
        expect(loads.calls).toEqual([]);
        expect(globalThis.__capCacheImports[`${name}@1.0.0`]).toBe(1);
        expect(restricted.agentPackageRefusal(pinnedId)).toMatchObject({ code: 'PACKAGE_CAPABILITY_REFUSED', capability: 'workerModules' });
    } finally { await restricted.sessionManager.shutdown(); }
});

it('the cache sweep removes crash leftovers older than an hour and keeps younger ones and live packages', async () => {
    const prepared = await packedPackage('sweep', '1.0.0');
    const { filename, entry } = installEntry(prepared, 'pkg-sweep', 'shared', null);
    const artifacts = new Map([[filename, prepared.packed.targz]]);
    const cacheDir = join(root, 'sweep-cache');
    mkdirSync(cacheDir, { recursive: true });
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    const leftovers = { '.tmp-abandoned': old, '.retired-abandoned': old, '.tmp-active': null, '.retired-active': null, '.other-dot-dir': old };
    for (const [name, mtime] of Object.entries(leftovers)) {
        mkdirSync(join(cacheDir, name, 'tools'), { recursive: true });
        writeFileSync(join(cacheDir, name, 'tools', 'worker-module.js'), '');
        if (mtime !== null) utimesSync(join(cacheDir, name), mtime, mtime);
    }
    const { catalog, artifactStore } = registry([entry], artifacts);
    const result = await installAgentPackages({ catalog, artifactStore, cacheDir });
    expect(result.packages[0].status).toBe('ok');
    const left = readdirSync(cacheDir);
    expect(left).not.toContain('.tmp-abandoned');
    expect(left).not.toContain('.retired-abandoned');
    // Younger ones may belong to a repair still running here or on another worker.
    expect(left).toContain('.tmp-active');
    expect(left).toContain('.retired-active');
    // Only the installer's own leftovers are swept.
    expect(left).toContain('.other-dot-dir');
    // The live package is untouched.
    expect(existsSync(join(cachedDirOf(cacheDir, 'sweep'), 'tools', 'worker-module.js'))).toBe(true);
});

it('the installed layout refuses to read past a link anywhere in the tree', () => {
    const dir = join(root, 'tree');
    mkdirSync(join(dir, 'agents', 'nested'), { recursive: true });
    mkdirSync(join(dir, 'payload'), { recursive: true });
    writeFileSync(join(dir, 'payload', 'worker-module.js'), '');
    expect(installedAgentPackageLayout(dir)).toContain('payload/worker-module.js');
    symlinkSync('../../payload', join(dir, 'agents', 'nested', 'tools'), 'dir');
    expect(() => installedAgentPackageLayout(dir)).toThrow(/link or special file \(agents\/nested\/tools\)/);
});
