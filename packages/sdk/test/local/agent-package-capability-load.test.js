/**
 * The package capability policy at worker load (issue 311): the guarantee.
 *
 * These drive the real `refreshAgentPackages` with the installer's result
 * faked, so they cover the real load path — the gate, quarantine, plugin
 * registration, the heartbeat and the session surfaces — without a registry
 * or a database. `loadAgentPackageTools` is wrapped to record every attempted
 * worker-module import: a refused module must never be imported, not imported
 * and then ignored.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const installation = vi.hoisted(() => ({ result: null, pinned: null, toolLoads: [] }));
vi.mock('../../src/agent-package-installer.js', async importOriginal => {
    const original = await importOriginal();
    return {
        ...original,
        installAgentPackages: async () => installation.result,
        installAgentPackageEntry: async entry => installation.pinned?.(entry),
        loadAgentPackageTools: async (pkg, ctx) => {
            installation.toolLoads.push(pkg.packageId);
            return original.loadAgentPackageTools(pkg, ctx);
        },
    };
});
import { PilotSwarmWorker } from '../../src/worker.ts';
import { packageAgentKey, BoundAgentPackageUnavailableError, RefusedPackageAgentError } from '../../src/session-manager.ts';
import { resolveAgentDefinitionForCaller } from '../../src/session-proxy.ts';
import { ModelProviderRegistry } from '../../src/model-providers.ts';

let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ps-cap-load-'));
    installation.result = null;
    installation.pinned = null;
    installation.toolLoads = [];
    return () => rmSync(root, { recursive: true, force: true });
});

const ALICE = { provider: 'test', subject: 'alice' };

/** One installed package directory. Every part optional, so each test writes only what it is about. */
function writePackage(id, { agentName = `${id}-agent`, mcp = null, emptyMcpServersDir = false, mcpServersFile = false, workerModule = false, agentFrontmatter = '' } = {}) {
    const dir = join(root, `pkg-${id}`);
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: `package-${id}`, version: '1.0.0' }));
    writeFileSync(join(dir, 'agents', 'a.agent.md'),
        `---\nschemaVersion: 2\nversion: 1.0.0\nname: ${agentName}\ndescription: fixture\n${agentFrontmatter}---\n\nPROMPT_${id}\n`);
    if (mcp) writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcp));
    if (emptyMcpServersDir) mkdirSync(join(dir, 'mcp-servers'), { recursive: true });
    if (mcpServersFile) writeFileSync(join(dir, 'mcp-servers'), 'notes, not servers');
    if (workerModule) {
        mkdirSync(join(dir, 'tools'), { recursive: true });
        writeFileSync(join(dir, 'tools', 'worker-module.js'),
            `export const tools=[{name:'${id.replace(/-/g, '_')}_tool',description:'f',parameters:{type:'object',properties:{}},handler:async()=>'ran'}];`);
    }
    return dir;
}

function entry(id, dir, extra = {}) {
    return {
        packageId: `pkg-${id}`, name: `package-${id}`, dir, scope: 'shared', owner: null, status: 'ok', semver: '1.0.0',
        sha256: id.padEnd(64, '0').slice(0, 64), manifest: { agents: [{ name: `${id}-agent` }] },
        workerModulePath: extra.workerModule ? join(dir, 'tools', 'worker-module.js') : null, ...extra,
    };
}

function deploymentPluginDir() {
    const dir = join(root, 'deployment');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'deployment', version: '1.0.0' }));
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
        approved: { type: 'http', url: 'https://example.invalid/approved', tools: ['*'], allowedAgents: ['package-good:good-agent'] },
    }));
    return dir;
}

/** A worker with this policy, after one real refresh over `packages`. A new worker is a restart. */
async function workerWith(capabilities, packages, { beats = [], warnings, ...options } = {}) {
    const worker = new PilotSwarmWorker({
        store: 'sqlite::memory:', disableManagementAgents: true,
        sessionStateDir: join(root, 'sessions'),
        agentPackages: { cacheDir: join(root, 'cache'), ...(capabilities ? { capabilities } : {}) },
        ...options,
    });
    installation.result = { epoch: 1, packages };
    worker._catalog = {
        agentRegistryEpoch: async () => 1,
        workerHeartbeat: async beat => { beats.push(beat); },
        listWorkers: async () => [],
    };
    worker.artifactStore = {};
    await worker.refreshAgentPackages({ force: true });
    return worker;
}
const shutdown = worker => worker.sessionManager.shutdown();

function expectNothingLoaded(worker, id, dir) {
    expect(worker.loadedAgents.map(a => a.name)).not.toContain(`${id}-agent`);
    expect(worker.config.pluginDirs ?? []).not.toContain(dir);
    expect(installation.toolLoads).not.toContain(`pkg-${id}`);
    expect([...worker.sessionManager.toolRegistry?.keys?.() ?? []]).not.toContain(`${id.replace(/-/g, '_')}_tool`);
    expect(Object.keys(worker.loadedMcpServers)).not.toContain('own');
}

// ─── Control: unset policy changes nothing ──────────────────────

it('with no policy, a package that defines MCP servers and ships a worker module loads as today', async () => {
    const dir = writePackage('open', { mcp: { own: { type: 'http', url: 'https://example.invalid/own' } }, workerModule: true });
    const worker = await workerWith(undefined, [entry('open', dir, { workerModule: true })]);
    try {
        expect(worker.loadedAgents.map(a => a.name)).toContain('open-agent');
        expect(installation.toolLoads).toContain('pkg-open');
        expect(Object.keys(worker.loadedMcpServers)).toContain('own');
        expect(worker.agentPackageRefusal('pkg-open')).toBeNull();
    } finally { await shutdown(worker); }
});

// ─── Refused on install / refresh / cached copy ─────────────────

const REFUSALS = [
    ['.mcp.json, even {}', { mcpServers: 'deployment-only' }, { mcp: {} }, 'mcpServers', '.mcp.json'],
    ['.mcp.json with a server', { mcpServers: 'deployment-only' }, { mcp: { own: { type: 'stdio', command: 'node' } } }, 'mcpServers', '.mcp.json'],
    ['an empty mcp-servers/ folder', { mcpServers: 'deployment-only' }, { emptyMcpServersDir: true }, 'mcpServers', 'mcp-servers'],
    ['tools/worker-module.js', { workerModules: 'disabled' }, { workerModule: true }, 'workerModules', 'tools/worker-module.js'],
];

for (const [label, capabilities, content, capability, path] of REFUSALS) {
    it(`refuses a package with ${label} whole: never imported, nothing registered, reported`, async () => {
        // Every refused fixture also ships a worker module: refusing for MCP
        // must keep its module unimported too.
        const dir = writePackage('bad', { ...content, workerModule: true });
        const pkg = entry('bad', dir, { workerModule: true });
        const beats = [];
        const warn = vi.spyOn(console, 'warn');
        const worker = await workerWith(capabilities, [pkg], { beats });
        try {
            expectNothingLoaded(worker, 'bad', dir);
            expect(pkg.status).toBe('error');
            expect(pkg.error).toContain('PACKAGE_CAPABILITY_REFUSED');
            expect(worker.agentPackageRefusal('pkg-bad')).toMatchObject({ code: 'PACKAGE_CAPABILITY_REFUSED', capability, path });
            // The health report: the installed entry carries the structured refusal.
            const state = beats.at(-1).state['agent-packages'];
            expect(state.installed['package-bad']).toMatchObject({
                status: 'error', refusal: { code: 'PACKAGE_CAPABILITY_REFUSED', capability, path },
            });
            expect(state.capabilities[capability]).toBe(capabilities[capability]);
            // The warning log.
            expect(warn.mock.calls.some(call => String(call[0]).includes('quarantined: PACKAGE_CAPABILITY_REFUSED'))).toBe(true);

            // A refresh reuses the same unpacked copy (the cached copy): refused again, still never imported.
            pkg.status = 'ok'; delete pkg.error;
            await worker.refreshAgentPackages({ force: true });
            expectNothingLoaded(worker, 'bad', dir);
            expect(worker.agentPackageRefusal('pkg-bad')?.capability).toBe(capability);
        } finally { warn.mockRestore(); await shutdown(worker); }
    });
}

it('under deployment-only a package with a plain FILE named mcp-servers loads', async () => {
    const dir = writePackage('plainfile', { mcpServersFile: true });
    const worker = await workerWith({ mcpServers: 'deployment-only' }, [entry('plainfile', dir)]);
    try {
        expect(worker.agentPackageRefusal('pkg-plainfile')).toBeNull();
        expect(worker.loadedAgents.map(a => a.name)).toContain('plainfile-agent');
    } finally { await shutdown(worker); }
});

it('a forced refresh that fails closed on a changed tree is retried by the next ordinary poll at the same epoch', async () => {
    const dir = writePackage('retry');
    const pkg = entry('retry', dir);
    const worker = await workerWith({ workerModules: 'disabled' }, [pkg]);
    try {
        // Epoch E: loaded.
        expect(worker.loadedAgents.map(a => a.name)).toContain('retry-agent');
        // A forced refresh at the same epoch finds the tree gone (another worker is replacing it): refused, fail closed.
        const aside = `${dir}.aside`;
        renameSync(dir, aside);
        pkg.status = 'ok'; delete pkg.error;
        await worker.refreshAgentPackages({ force: true });
        expect(worker.loadedAgents.map(a => a.name)).not.toContain('retry-agent');
        // The tree is back; the registry has not moved. An ORDINARY poll reloads it.
        renameSync(aside, dir);
        pkg.status = 'ok'; delete pkg.error;
        await worker.refreshAgentPackages();
        expect(worker.loadedAgents.map(a => a.name)).toContain('retry-agent');
        expect(worker.agentPackageRefusal('pkg-retry')).toBeNull();
        // And once loaded, the ordinary poll short-circuits again (no reload storm).
        let reloaded = false;
        const original = worker._loadPlugins.bind(worker);
        worker._loadPlugins = () => { reloaded = true; return original(); };
        await worker.refreshAgentPackages();
        expect(reloaded).toBe(false);
    } finally { await shutdown(worker); }
});

it('restarting with the setting off loads the same package again; with it on, refuses it again', async () => {
    const dir = writePackage('toggle', { mcp: {}, workerModule: true });
    const on = await workerWith({ mcpServers: 'deployment-only' }, [entry('toggle', dir, { workerModule: true })]);
    try { expectNothingLoaded(on, 'toggle', dir); } finally { await shutdown(on); }
    const off = await workerWith(undefined, [entry('toggle', dir, { workerModule: true })]);
    try {
        expect(off.loadedAgents.map(a => a.name)).toContain('toggle-agent');
        expect(installation.toolLoads).toContain('pkg-toggle');
    } finally { await shutdown(off); }
    installation.toolLoads = [];
    const again = await workerWith({ workerModules: 'disabled' }, [entry('toggle', dir, { workerModule: true })]);
    try { expectNothingLoaded(again, 'toggle', dir); } finally { await shutdown(again); }
});

it('the policy is read from the environment at start, and an invalid value stops the worker naming the variable', async () => {
    const dir = writePackage('envpkg', { workerModule: true });
    vi.stubEnv('PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES', ' Disabled ');
    try {
        const worker = await workerWith(undefined, [entry('envpkg', dir, { workerModule: true })]);
        try { expectNothingLoaded(worker, 'envpkg', dir); } finally { await shutdown(worker); }
        vi.stubEnv('PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES', 'nope');
        expect(() => new PilotSwarmWorker({ store: 'sqlite::memory:', disableManagementAgents: true, sessionStateDir: join(root, 's2') }))
            .toThrow(/PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES must be one of: enabled, disabled/);
    } finally { vi.unstubAllEnvs(); }
});

it('setting only capabilities, or only the environment variables, does not turn package install on', async () => {
    // A worker that never loaded packages must not start installing them
    // because a restriction was configured.
    const options = { store: 'sqlite::memory:', disableManagementAgents: true, sessionStateDir: join(root, 'sessions') };
    const onlyOption = new PilotSwarmWorker({ ...options, agentPackages: { capabilities: { mcpServers: 'deployment-only' } } });
    vi.stubEnv('PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS', 'deployment-only');
    vi.stubEnv('PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES', 'disabled');
    const onlyEnv = new PilotSwarmWorker(options);
    vi.unstubAllEnvs();
    try {
        expect(onlyOption.agentPackageCapabilities).toEqual({ mcpServers: 'deployment-only', workerModules: 'enabled' });
        expect(onlyEnv.agentPackageCapabilities).toEqual({ mcpServers: 'deployment-only', workerModules: 'disabled' });
        for (const worker of [onlyOption, onlyEnv]) {
            expect(worker._agentPackagesCacheDir).toBeNull();
            // The real refresh is a no-op without install: it never asks the registry.
            worker._catalog = { agentRegistryEpoch: async () => { throw new Error('install must not run'); },
                workerHeartbeat: async () => {}, listWorkers: async () => [] };
            worker.artifactStore = {};
            await worker.refreshAgentPackages({ force: true });
            expect(worker._agentPackagesRefreshError ?? null).toBeNull();
        }
        // With an install option next to it, install is on as before.
        const both = new PilotSwarmWorker({ ...options, agentPackages: { cacheDir: join(root, 'c2'), capabilities: { workerModules: 'disabled' } } });
        try { expect(both._agentPackagesCacheDir).toBe(join(root, 'c2')); } finally { await shutdown(both); }
        const plain = new PilotSwarmWorker({ ...options, agentPackages: {} });
        try { expect(plain._agentPackagesCacheDir).not.toBeNull(); } finally { await shutdown(plain); }
    } finally { await shutdown(onlyOption); await shutdown(onlyEnv); }
});

// ─── Pinned earlier revision ────────────────────────────────────

it('a pinned earlier revision is refused under its own id and reported, while the active version loads', async () => {
    const activeDir = writePackage('pin');
    const oldDir = writePackage('pin-old', { agentName: 'pin-agent', workerModule: true });
    const sha = 'b'.repeat(64);
    const pinnedId = `pkg-pin@${sha}`;
    const beats = [];
    const worker = new PilotSwarmWorker({
        store: 'sqlite::memory:', disableManagementAgents: true, sessionStateDir: join(root, 'sessions'),
        agentPackages: { cacheDir: join(root, 'cache'), capabilities: { workerModules: 'disabled' } },
    });
    try {
        worker._retainedPackageRevisions = new Map([[pinnedId, {
            packageId: pinnedId, pinnedOf: 'pkg-pin', name: 'package-pin', semver: '0.9.0', sha256: sha, artifactFilename: 'x.tgz', sizeBytes: 1,
        }]]);
        installation.pinned = () => ({
            packageId: pinnedId, name: 'package-pin', dir: oldDir, scope: 'shared', owner: null, status: 'ok', semver: '0.9.0', sha256: sha,
            manifest: { agents: [{ name: 'pin-agent' }] }, workerModulePath: join(oldDir, 'tools', 'worker-module.js'),
        });
        installation.result = { epoch: 1, packages: [entry('pin', activeDir)] };
        worker._catalog = { agentRegistryEpoch: async () => 1, workerHeartbeat: async b => { beats.push(b); }, listWorkers: async () => [] };
        worker.artifactStore = {};
        await worker.refreshAgentPackages({ force: true });

        expect(worker.agentPackageRefusal(pinnedId)?.capability).toBe('workerModules');
        expect(worker.agentPackageRefusal('pkg-pin')).toBeNull();
        expect(installation.toolLoads).not.toContain(pinnedId);
        expect(worker.config.pluginDirs).not.toContain(oldDir);
        expect(worker.loadedAgents.map(a => a.name)).toContain('pin-agent');
        const refused = beats.at(-1).state['agent-packages'].refusedRevisions;
        expect(refused).toEqual([expect.objectContaining({ packageId: pinnedId, pinnedOf: 'pkg-pin',
            refusal: expect.objectContaining({ code: 'PACKAGE_CAPABILITY_REFUSED', capability: 'workerModules' }) })]);
        // A Workflow that pins it is told why, not to retry.
        await expect(worker.getWorkflowCapabilitySnapshot({ packagePins: {} }, undefined, true, {
            loadSources: async load => load('pkg-pin', sha),
        })).rejects.toThrow(/PACKAGE_CAPABILITY_REFUSED/);
    } finally { await shutdown(worker); }
});

// ─── A compliant package keeps working ──────────────────────────

it('under deployment-only a package without MCP definitions loads and its agent gets a deployment server allowedAgents permits', async () => {
    const dir = writePackage('good', { agentFrontmatter: 'mcpServers: [approved]\n' });
    const worker = await workerWith({ mcpServers: 'deployment-only', workerModules: 'disabled' },
        [entry('good', dir)], { pluginDirs: [deploymentPluginDir()] });
    try {
        expect(worker.agentPackageRefusal('pkg-good')).toBeNull();
        expect(worker.loadedAgents.map(a => a.name)).toContain('good-agent');
        expect(Object.keys(worker.agentMcpServers[packageAgentKey('pkg-good', 'good-agent')] ?? {})).toEqual(['approved']);
    } finally { await shutdown(worker); }
});

// ─── Sessions that use a refused package ────────────────────────

async function prepareBoundSession(worker, packageId, agentName) {
    const opened = [];
    const manager = worker.sessionManager;
    manager.workerDefaults.modelProviders = new ModelProviderRegistry({ providers: [{
        id: 'fixture', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'synthetic', models: ['fixture-model'],
    }] });
    manager.setSessionCatalog({
        getSession: async () => ({ sessionId: 'bound', owner: ALICE, isSystem: false }),
        getUserRole: async () => ({ role: 'user', seenAt: new Date() }),
        recordEvents: async () => {},
    });
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    manager.ensureClient = async () => {
        const open = config => {
            mkdirSync(join(root, 'sessions', config.sessionId), { recursive: true });
            opened.push(config);
            return { sessionId: config.sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn(),
                rpc: { tasks: { list: vi.fn(async () => ({ tasks: [] })) } } };
        };
        return { createSession: async c => open(c), resumeSession: async (_id, c) => open(c), deleteSession: async () => {} };
    };
    try {
        await manager.getOrCreate('bound', { model: 'fixture:fixture-model', boundAgentName: agentName, boundAgentPackageId: packageId }, { turnIndex: 0 });
        return { opened, error: null };
    } catch (error) { return { opened, error }; }
}

it('a session bound to the package before a restart gets the refusal on its next turn, with no session opened', async () => {
    const dir = writePackage('bound', { workerModule: true });
    // Before: no policy, the session's agent works.
    const before = await workerWith(undefined, [entry('bound', dir, { workerModule: true })]);
    try {
        const { error } = await prepareBoundSession(before, 'pkg-bound', 'bound-agent');
        expect(error).toBeNull();
    } finally { await shutdown(before); }
    // After a restart with the setting on: the next turn is refused, explicitly.
    installation.toolLoads = [];
    const after = await workerWith({ workerModules: 'disabled' }, [entry('bound', dir, { workerModule: true })]);
    try {
        const { error, opened } = await prepareBoundSession(after, 'pkg-bound', 'bound-agent');
        expect(error).toBeInstanceOf(BoundAgentPackageUnavailableError);
        expect(error.code).toBe('BOUND_AGENT_PACKAGE_UNAVAILABLE');
        expect(error.refusal).toMatchObject({ code: 'PACKAGE_CAPABILITY_REFUSED', capability: 'workerModules' });
        expect(error.message).toContain('PACKAGE_CAPABILITY_REFUSED');
        expect(opened).toEqual([]);
        expect(installation.toolLoads).not.toContain('pkg-bound');
    } finally { await shutdown(after); }
});

it('another owner\u2019s private agent, refused or loaded, never changes how a qualified name resolves', async () => {
    const BOB = 'test\u0001bob';
    const shared = { name: 'analyst', prompt: 'shared', namespace: 'shared-kit', packageId: 'pkg-shared-kit', packageScope: 'shared', packageOwner: null };
    const systemAgent = { name: 'sweeper', id: 'sweeper', prompt: 'system', system: true };
    const refusedPrivate = { name: 'analyst', namespace: 'confidential', packageId: 'pkg-confidential', packageScope: 'user', packageOwner: ALICE,
        refusal: { code: 'PACKAGE_CAPABILITY_REFUSED', capability: 'workerModules', setting: 'disabled', path: 'tools/worker-module.js', reason: 'r' } };
    const loadedPrivate = { name: 'analyst', prompt: 'private', namespace: 'confidential', packageId: 'pkg-confidential', packageScope: 'user', packageOwner: ALICE };
    const resolve = (ownerKey, agentName, { userAgents = [shared], refused = [] } = {}) => resolveAgentDefinitionForCaller({
        agentName, userAgents, systemAgents: [systemAgent], getCallerOwnerKey: async () => ownerKey, refusedPackageAgents: refused,
    });
    const outcome = promise => promise.then(def => ({ resolved: def?.packageId ?? def?.name ?? null }), error => ({ error: error.code ?? error.message }));

    // Bob's qualified guess has the same outcome with and without Alice's hidden private agent.
    const without = await outcome(resolve(BOB, 'confidential:analyst'));
    expect(without).toEqual({ resolved: 'pkg-shared-kit' });
    expect(await outcome(resolve(BOB, 'confidential:analyst', { refused: [refusedPrivate] }))).toEqual(without);
    expect(await outcome(resolve(BOB, 'confidential:analyst', { userAgents: [shared, loadedPrivate] }))).toEqual(without);
    // Alice still gets her own refusal, and her own loaded agent, under that name.
    expect(await outcome(resolve('test\u0001alice', 'confidential:analyst', { refused: [refusedPrivate] }))).toEqual({ error: 'AGENT_PACKAGE_REFUSED' });
    expect(await outcome(resolve('test\u0001alice', 'confidential:analyst', { userAgents: [shared, loadedPrivate] }))).toEqual({ resolved: 'pkg-confidential' });
    // Shared and system agents still resolve, and an unknown bare name is still nothing.
    expect(await outcome(resolve(BOB, 'shared-kit:analyst', { refused: [refusedPrivate] }))).toEqual({ resolved: 'pkg-shared-kit' });
    expect(await outcome(resolve(BOB, 'sweeper', { refused: [refusedPrivate] }))).toEqual({ resolved: 'sweeper' });
    expect(await outcome(resolve(BOB, 'nobody-here', { refused: [refusedPrivate] }))).toEqual({ resolved: null });
});

it('a refused user-scope package is logged by id only, never by name, version or owner', async () => {
    const mineDir = writePackage('secretkit', { workerModule: true });
    const sharedDir = writePackage('openkit', { workerModule: true });
    const mine = entry('secretkit', mineDir, { scope: 'user', owner: ALICE, semver: '7.7.7', workerModule: true });
    const shared = entry('openkit', sharedDir, { workerModule: true });
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    const worker = await workerWith({ workerModules: 'disabled' }, [mine, shared]);
    try {
        const lines = [...warn.mock.calls, ...log.mock.calls].map(call => call.map(String).join(' '));
        const about = lines.filter(line => line.includes('pkg-secretkit'));
        expect(about.some(line => line.includes('quarantined') && line.includes('workerModules'))).toBe(true);
        for (const line of lines) {
            expect(line).not.toContain('package-secretkit');
            expect(line).not.toContain('7.7.7');
            expect(line).not.toContain('alice');
        }
        // A shared package keeps its name.
        expect(lines.some(line => line.includes('"package-openkit@1.0.0" quarantined'))).toBe(true);
        // The structured health report is unchanged.
        expect(worker.agentPackageRefusal('pkg-secretkit')?.capability).toBe('workerModules');
    } finally { warn.mockRestore(); log.mockRestore(); await shutdown(worker); }
});

it('a user-scope package whose layout cannot be read is logged without its name, version, owner or cache path', async () => {
    // Real missing folders, named the way the installer names a private package's cache copy.
    const cache = join(root, 'cache');
    mkdirSync(cache, { recursive: true });
    const activeDir = join(cache, 'package-hushkit@7.7.7.abcdefabcdef.upkghushkit');
    const pinnedDir = join(cache + '-pinned', 'package-hushkit@6.6.6.fedcbafedcba.upkghushkit');
    const sharedDir = join(cache, 'package-openkit@1.0.0.aaaaaaaaaaaa');
    const sha = 'f'.repeat(64);
    const pinnedId = `pkg-hushkit@${sha}`;
    const active = entry('hushkit', activeDir, { scope: 'user', owner: ALICE, semver: '7.7.7' });
    const shared = entry('openkit', sharedDir);
    const worker = new PilotSwarmWorker({
        store: 'sqlite::memory:', disableManagementAgents: true, sessionStateDir: join(root, 'sessions'),
        agentPackages: { cacheDir: cache, capabilities: { workerModules: 'disabled' } },
    });
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    try {
        worker._retainedPackageRevisions = new Map([[pinnedId, {
            packageId: pinnedId, pinnedOf: 'pkg-hushkit', name: 'package-hushkit', scope: 'user', owner: ALICE,
            semver: '6.6.6', sha256: sha, artifactFilename: 'x.tgz', sizeBytes: 1,
        }]]);
        installation.pinned = () => ({
            packageId: pinnedId, name: 'package-hushkit', dir: pinnedDir, scope: 'user', owner: ALICE, status: 'ok',
            semver: '6.6.6', sha256: sha, manifest: { agents: [] }, workerModulePath: null,
        });
        installation.result = { epoch: 1, packages: [active, shared] };
        worker._catalog = { agentRegistryEpoch: async () => 1, workerHeartbeat: async () => {}, listWorkers: async () => [] };
        worker.artifactStore = {};
        await worker.refreshAgentPackages({ force: true });

        // The structured fields keep the real error, path and all.
        expect(active.status).toBe('error');
        expect(active.error).toContain('ENOENT');
        expect(active.error).toContain(activeDir);

        const lines = [...warn.mock.calls, ...log.mock.calls].map(call => call.map(String).join(' '));
        const activeLine = lines.find(line => line.includes('pkg-hushkit') && line.includes('quarantined'));
        const pinnedLine = lines.find(line => line.includes(pinnedId) && line.includes('not served'));
        for (const line of [activeLine, pinnedLine]) {
            expect(line).toBeDefined();
            expect(line).toContain('package layout could not be read');
            expect(line).toContain('ENOENT');
        }
        for (const line of lines.filter(l => l.includes('hushkit'))) {
            expect(line).not.toContain('package-hushkit');
            expect(line).not.toContain('7.7.7');
            expect(line).not.toContain('6.6.6');
            expect(line).not.toContain('alice');
            expect(line).not.toContain(cache);
        }
        // A shared package keeps its name and its error text.
        expect(lines.some(line => line.includes('"package-openkit@1.0.0" quarantined') && line.includes(sharedDir))).toBe(true);
    } finally { warn.mockRestore(); log.mockRestore(); await shutdown(worker); }
});

it('a refused personal copy is refused by name and never falls back to the shared namesake', async () => {
    const sharedDir = writePackage('shared', { agentName: 'analyst' });
    const mineDir = writePackage('mine', { agentName: 'analyst', workerModule: true });
    const shared = entry('shared', sharedDir, { manifest: { agents: [{ name: 'analyst' }] } });
    const mine = entry('mine', mineDir, { scope: 'user', owner: ALICE, workerModule: true, manifest: { agents: [{ name: 'analyst' }] } });
    const worker = await workerWith({ workerModules: 'disabled' }, [shared, mine]);
    try {
        const resolve = ownerKey => resolveAgentDefinitionForCaller({
            agentName: 'analyst', userAgents: worker.loadedAgents, getCallerOwnerKey: async () => ownerKey,
            refusedPackageAgents: worker.sessionManager.refusedPackageAgents(),
        });
        // Alice's own copy is the one "analyst" means for her: refused, not replaced.
        await expect(resolve('test\u0001alice')).rejects.toBeInstanceOf(RefusedPackageAgentError);
        await expect(resolve('test\u0001alice')).rejects.toMatchObject({ code: 'AGENT_PACKAGE_REFUSED',
            refusal: expect.objectContaining({ capability: 'workerModules' }) });
        // Naming the refused package explicitly is refused too.
        await expect(resolveAgentDefinitionForCaller({
            agentName: 'package-mine:analyst', userAgents: worker.loadedAgents, getCallerOwnerKey: async () => 'test\u0001alice',
            refusedPackageAgents: worker.sessionManager.refusedPackageAgents(),
        })).rejects.toBeInstanceOf(RefusedPackageAgentError);
        // Someone else's refused private copy does not hide the shared agent from Bob.
        expect((await resolve('test\u0001bob'))?.packageId).toBe('pkg-shared');
    } finally { await shutdown(worker); }
});
