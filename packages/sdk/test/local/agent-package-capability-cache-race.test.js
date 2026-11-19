/**
 * Two installers repairing the same revision in one shared cache must not let
 * the capability check admit a half-replaced tree (issue 311).
 *
 * The interleaving, made deterministic:
 *  1. installer B decides the cached copy needs repair, then waits on its download;
 *  2. worker A, restarted with a restrictive policy, repairs the copy itself;
 *  3. B runs: its file-system changes to the LIVE path are applied only as far
 *     as a real recursive delete gets before the next step — the prohibited
 *     entries are gone, the root still readable — and the rest is held;
 *  4. A runs its capability check on whatever the live path holds;
 *  5. B's held changes complete (the full tree is back) before A imports the
 *     worker module or reads `.mcp.json`.
 *
 * Real installer, real canonical archive, real cache, real worker refresh.
 * Only the registry is a stub, and the `fs` calls that delete or rename are
 * wrapped so B's can be held.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const race = vi.hoisted(() => ({ holding: false, live: null, held: [], real: null, released: false, deletes: [] }));
const fsMock = vi.hoisted(() => async importOriginal => {
    const real = await importOriginal();
    const { join, resolve } = await import('node:path');
    race.real ??= real;
    const rmSync = (target, options) => {
        if (!race.holding) { race.deletes.push(resolve(String(target))); return real.rmSync(target, options); }
        if (race.live && resolve(String(target)) === race.live) {
            // A recursive delete of the live tree, caught part-way: the
            // prohibited entries are already gone, the root is still there.
            for (const entry of ['tools', '.mcp.json', 'mcp-servers']) real.rmSync(join(race.live, entry), { recursive: true, force: true });
        }
        race.held.push(() => real.rmSync(target, options));
    };
    const renameSync = (from, to) => {
        if (!race.holding) return real.renameSync(from, to);
        race.held.push(() => real.renameSync(from, to));
    };
    const mod = { ...real, rmSync, renameSync };
    return { ...mod, default: mod };
});
vi.mock('fs', fsMock);
vi.mock('node:fs', fsMock);

const loads = vi.hoisted(() => ({ calls: [], gate: null }));
vi.mock('../../src/agent-package-installer.js', async importOriginal => {
    const original = await importOriginal();
    return {
        ...original,
        // Step 3 runs right after A's own repair of the raced revision.
        installAgentPackageEntry: async (entry, cacheDir, store) => {
            const installed = await original.installAgentPackageEntry(entry, cacheDir, store);
            if (loads.gate && entry.packageId === loads.gate.packageId) await loads.gate.runB(installed.dir);
            return installed;
        },
        installAgentPackages: async opts => {
            const entries = await opts.catalog.getAgentPackagesInstallManifest();
            const packages = [];
            for (const entry of entries) {
                const installed = await original.installAgentPackageEntry(entry, opts.cacheDir, opts.artifactStore);
                if (loads.gate && entry.packageId === loads.gate.packageId) await loads.gate.runB(installed.dir);
                packages.push(installed);
            }
            return { epoch: 1, packages, pluginDirs: packages.filter(p => p.status === 'ok').map(p => p.dir) };
        },
        // Step 5: B's held changes complete right after A's check read the tree.
        installedAgentPackageLayout: dir => {
            const layout = original.installedAgentPackageLayout(dir);
            if (race.live && resolve(dir) === race.live && !race.released) {
                race.released = true;
                for (const step of race.held.splice(0)) step();
            }
            return layout;
        },
        loadAgentPackageTools: async (pkg, ctx) => {
            loads.calls.push(pkg.packageId);
            return original.loadAgentPackageTools(pkg, ctx);
        },
    };
});

const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } = await import('node:fs');
const { PilotSwarmWorker } = await import('../../src/worker.ts');
const { prepareAgentPackageDir } = await import('../../src/agent-package-service.ts');
// The real installer, for the stale copy and for installer B (which must not re-enter the test's hooks).
const installer = await vi.importActual('../../src/agent-package-installer.ts');

let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ps-cap-race-'));
    Object.assign(race, { holding: false, live: null, held: [], released: false, deletes: [] });
    loads.calls = [];
    loads.gate = null;
    globalThis.__capRaceImports = {};
    return () => rmSync(root, { recursive: true, force: true });
});

const ALICE = { provider: 'test', subject: 'alice' };

async function packedPackage(name, version, kind) {
    const dir = join(root, 'src', `${name}-${version}`);
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version, description: 'race fixture' }));
    writeFileSync(join(dir, 'agents', 'a.agent.md'),
        `---\nname: ${name}-agent\ndescription: fixture\nschemaVersion: 1\nversion: ${version}\n---\n\nPrompt.\n`);
    if (kind === 'module') {
        mkdirSync(join(dir, 'tools'), { recursive: true });
        writeFileSync(join(dir, 'tools', 'worker-module.js'), [
            `globalThis.__capRaceImports[${JSON.stringify(`${name}@${version}`)}] = 1;`,
            `export const tools = [{ name: ${JSON.stringify(`${name.replace(/-/g, '_')}_tool`)}, description: 'f', parameters: { type: 'object', properties: {} }, handler: async () => 'ran' }];`,
            '',
        ].join('\n'));
    } else if (kind === 'mcp') {
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ [`${name.replace(/-/g, '_')}_srv`]: { type: 'http', url: 'https://example.invalid/race' } }));
    }
    const prepared = await prepareAgentPackageDir(dir);
    if (!prepared.ok) throw prepared.error;
    return prepared;
}

function entryOf(prepared, packageId, scope, owner, filename) {
    return { packageId, name: prepared.manifest.name, scope, owner, semver: prepared.manifest.version,
        sha256: prepared.packed.sha256, sizeBytes: prepared.packed.targz.length, artifactFilename: filename, manifest: prepared.manifest };
}

const storeOf = artifacts => ({ async downloadArtifact(_s, filename) { return { body: artifacts.get(filename) }; } });

/** Install `entry` into `cacheDir`, then make the copy look like an older layout, so every installer decides to repair it. */
async function staleCachedCopy(entry, cacheDir, artifacts) {
    const installed = await installer.installAgentPackageEntry(entry, cacheDir, storeOf(artifacts));
    expect(installed.status).toBe('ok');
    const sidecar = join(installed.dir, '.pilotswarm-meta.json');
    const meta = JSON.parse(readFileSync(sidecar, 'utf8'));
    delete meta.layout;
    writeFileSync(sidecar, JSON.stringify(meta));
    return installed.dir;
}

/** Start installer B: it decides to repair now, and continues only when step 3 releases its download. */
function pendingInstallerB(entry, cacheDir, artifacts) {
    let release;
    const download = new Promise(r => { release = r; });
    const done = installer.installAgentPackageEntry(entry, cacheDir, {
        async downloadArtifact(_s, filename) { await download; return { body: artifacts.get(filename) }; },
    });
    return { release, done };
}

const CASES = [
    ['module', 'active', 'shared', { workerModules: 'deployment-only' }],
    ['module', 'active', 'user', { workerModules: 'deployment-only' }],
    ['module', 'pinned', 'shared', { workerModules: 'deployment-only' }],
    ['mcp', 'active', 'shared', { mcpServers: 'deployment-only' }],
    ['mcp', 'active', 'user', { mcpServers: 'deployment-only' }],
    ['mcp', 'pinned', 'shared', { mcpServers: 'deployment-only' }],
];

for (const [kind, which, scope, capabilities] of CASES) {
    it(`a ${kind === 'module' ? 'worker module' : '.mcp.json'} restored by a concurrent ${which} ${scope} repair is never loaded`, async () => {
        const name = `race-${kind}-${which}-${scope}`;
        const owner = scope === 'user' ? ALICE : null;
        const raced = await packedPackage(name, '1.0.0', kind);
        const artifacts = new Map([['raced.tgz', raced.packed.targz]]);
        const cacheDir = join(root, 'cache');
        let racedId = `pkg-${name}`;
        let entries;
        let retained = null;
        let racedCache = cacheDir;
        if (which === 'active') {
            entries = [entryOf(raced, racedId, scope, owner, 'raced.tgz')];
        } else {
            // The raced revision is a pinned earlier version of an active one.
            const active = await packedPackage(name, '2.0.0', 'none');
            artifacts.set('active.tgz', active.packed.targz);
            entries = [entryOf(active, `pkg-${name}`, scope, owner, 'active.tgz')];
            racedId = `pkg-${name}@${raced.packed.sha256}`;
            retained = { ...entryOf(raced, racedId, scope, owner, 'raced.tgz'), pinnedOf: `pkg-${name}` };
            racedCache = `${cacheDir}-pinned`;
        }
        const racedEntry = which === 'active' ? entries[0] : retained;

        // 1. A stale copy that every installer repairs, and B, already decided.
        await staleCachedCopy(racedEntry, racedCache, artifacts);
        const b = pendingInstallerB(racedEntry, racedCache, artifacts);

        // 3. B runs after A's own repair, holding its changes as described above.
        loads.gate = {
            packageId: racedId,
            runB: async dir => {
                race.live = resolve(dir);
                race.holding = true;
                b.release();
                const installedB = await b.done;
                race.holding = false;
                expect(installedB.status).toBe('ok');
            },
        };

        const worker = new PilotSwarmWorker({
            store: 'sqlite::memory:', disableManagementAgents: true, sessionStateDir: join(root, 'sessions'),
            agentPackages: { cacheDir, refreshIntervalMs: 0, capabilities },
        });
        worker._catalog = { agentRegistryEpoch: async () => 1, getAgentPackagesInstallManifest: async () => entries,
            workerHeartbeat: async () => {}, listWorkers: async () => [] };
        worker.artifactStore = storeOf(artifacts);
        if (retained) worker._retainedPackageRevisions = new Map([[racedId, retained]]);
        try {
            await worker.refreshAgentPackages({ force: true });

            // The race happened: B's held changes ran after A's check read the tree.
            expect(race.released).toBe(true);
            // The full tree is back at the live path.
            const restored = readdirSync(race.live);
            expect(restored).toContain(kind === 'module' ? 'tools' : '.mcp.json');

            // Nothing the policy forbids was loaded.
            expect(loads.calls).not.toContain(racedId);
            expect(globalThis.__capRaceImports[`${name}@1.0.0`]).toBeUndefined();
            const server = `${name.replace(/-/g, '_')}_srv`;
            expect(Object.keys(worker.loadedMcpServers)).not.toContain(server);
            expect(worker._getCapabilitySources().some(source => Object.hasOwn(source.mcpServers ?? {}, server))).toBe(false);
            expect([...worker._pinnedCapabilitySources.values()].some(source => Object.hasOwn(source.mcpServers ?? {}, server))).toBe(false);
            expect([...worker._agentPackageMcpServersByPackage.values()].some(map => Object.hasOwn(map, server))).toBe(false);
            // And the raced revision is refused whole, not partly loaded.
            expect(worker.config.pluginDirs).not.toContain(race.live);
        } finally { await worker.sessionManager.shutdown(); }
    });
}

it('a repair never leaves a partial tree at the live path: the old tree is moved aside whole', async () => {
    const prepared = await packedPackage('race-swap', '1.0.0', 'module');
    const artifacts = new Map([['swap.tgz', prepared.packed.targz]]);
    const cacheDir = join(root, 'swap-cache');
    const entry = entryOf(prepared, 'pkg-race-swap', 'shared', null, 'swap.tgz');
    const dir = await staleCachedCopy(entry, cacheDir, artifacts);
    // Record every delete the repair makes: none may target the live path.
    race.deletes = [];
    const installed = await installer.installAgentPackageEntry(entry, cacheDir, storeOf(artifacts));
    expect(installed.status).toBe('ok');
    expect(race.deletes.length).toBeGreaterThan(0);
    expect(race.deletes).not.toContain(resolve(dir));
    // The tree moved aside is named `.retired-*`, so the cache sweep can find a crash leftover.
    expect(race.deletes.some(target => /^\.retired-/.test(target.split('/').pop()))).toBe(true);
    expect(readdirSync(dir)).toContain('tools');
    // Nothing is left behind next to the cache.
    expect(readdirSync(cacheDir).filter(entry => entry.startsWith('.'))).toEqual([]);
});
