/**
 * The package capability policy at publish (issue 311): every publish route
 * rejects a refused package with PACKAGE_CAPABILITY_REFUSED before any byte
 * is uploaded or the registry is written. The routes, each through its real
 * entry point with the registry and artifact store faked:
 *
 *  - directory upload (management client `publishAgentPackageDirectory`, which
 *    the portal upload and `pilotswarm agents push` reach);
 *  - packed upload (`publishPackedAgentPackage`);
 *  - republish to another scope (management client `republishAgentPackageVersion`);
 *  - the Agent Manager's `publish_agent_package` tool.
 *
 * The check runs on the canonical archive's layout after staging, so a
 * manifest-declared layout cannot hide the file, and an empty folder counts.
 */
import { it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PilotSwarmManagementClient } from '../../src/management-client.ts';
import { publishAgentPackageDir, publishPackedAgentPackage, prepareAgentPackageDir } from '../../src/agent-package-service.ts';
import { agentPackageArchiveLayout, agentPackagesArtifactSessionId } from '../../src/agent-package-format.ts';
import { createAgentManagerTools, CHANGELOG_PATH } from '../../src/agent-manager-tools.ts';
import { resolveAgentPackageCapabilities } from '../../src/agent-package-capability-policy.ts';

let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ps-cap-publish-'));
    return () => rmSync(root, { recursive: true, force: true });
});

const OWNER = { provider: 'test', subject: 'publisher' };
const MCP_ONLY = { mcpServers: 'deployment-only' };
const NO_MODULES = { workerModules: 'deployment-only' };

/** A registry and artifact store that record every write. Nothing exists yet. */
function recorder(existing = null) {
    const calls = [];
    const artifacts = new Map();
    return {
        calls,
        catalog: {
            async getAgentPackage() { calls.push('getAgentPackage'); return existing; },
            async isAgentPackageEditor() { return false; },
            async getAgentPackagesInstallManifest() { return []; },
            async publishAgentPackage() { calls.push('publishAgentPackage'); return { status: 'published', packageId: 'p1', versionId: 'v1' }; },
            async countAgentPackageArtifactRefs() { return 0; },
        },
        artifactStore: {
            async uploadArtifact(s, name, body) { calls.push(`upload ${name}`); artifacts.set(`${s}/${name}`, body); return { filename: name }; },
            async uploadArtifactFromFile(_s, name) { calls.push(`upload ${name}`); return { filename: name }; },
            async downloadArtifact(s, name) {
                const body = artifacts.get(`${s}/${name}`);
                if (body === undefined) throw new Error('not found');
                return { body: Buffer.isBuffer(body) ? body : Buffer.from(String(body)) };
            },
            async downloadArtifactText(s, name) {
                const body = artifacts.get(`${s}/${name}`);
                if (body === undefined) throw new Error('not found');
                return Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
            },
            async deleteArtifact(s, name) { return artifacts.delete(`${s}/${name}`); },
            artifacts,
        },
    };
}

function writePackage(name, files) {
    const dir = join(root, name);
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'fixture' }));
    writeFileSync(join(dir, 'agents', 'a.agent.md'), '---\nname: a\ndescription: fixture\nschemaVersion: 1\nversion: 1.0.0\n---\n\nPrompt.\n');
    for (const [rel, body] of Object.entries(files)) {
        const target = join(dir, rel);
        if (rel.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, body);
    }
    return dir;
}

/** A management client in direct mode over the recorder, with this host's policy. */
function managementClient(rec, capabilities) {
    const client = new PilotSwarmManagementClient({ store: 'sqlite::memory:', artifactStore: rec.artifactStore,
        ...(capabilities ? { agentPackages: { capabilities } } : {}) });
    client._started = true;
    client._catalog = rec.catalog;
    return client;
}

const expectRefused = async (promise, capability) => {
    const error = await promise.then(() => null, e => e);
    expect(error, 'expected a refusal').not.toBeNull();
    expect(error.code).toBe('PACKAGE_CAPABILITY_REFUSED');
    expect(error.capability).toBe(capability);
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ capability });
    return error;
};

// ─── The layout the check reads ─────────────────────────────────

it('the archive layout includes folders even when empty, after staging', async () => {
    const dir = writePackage('layout', { 'mcp-servers/': null });
    const prepared = await prepareAgentPackageDir(dir);
    expect(prepared.ok).toBe(true);
    expect(agentPackageArchiveLayout(prepared.packed.targz)).toContain('mcp-servers/');
});

// ─── Directory upload ───────────────────────────────────────────

const DIRECTORY_CASES = [
    ['.mcp.json, even {}', MCP_ONLY, { '.mcp.json': '{}' }, 'mcpServers'],
    ['an empty mcp-servers/ folder', MCP_ONLY, { 'mcp-servers/': null }, 'mcpServers'],
    ['tools/worker-module.js', NO_MODULES, { 'tools/worker-module.js': 'export const tools = [];' }, 'workerModules'],
];

for (const [label, capabilities, files, capability] of DIRECTORY_CASES) {
    it(`directory upload rejects ${label}, before any upload or registry write`, async () => {
        const rec = recorder();
        const client = managementClient(rec, capabilities);
        const error = await expectRefused(client.publishAgentPackageDirectory(writePackage('dir-pkg', files), 'user', OWNER, false), capability);
        expect(error.message).toContain('dir-pkg@1.0.0');
        expect(rec.calls).toEqual([]);
    });
}

it('a manifest-declared layout cannot hide the MCP config: the check reads the staged result', async () => {
    const dir = writePackage('declared', { 'config/servers.json': '{"own":{"type":"http","url":"https://example.invalid"}}' });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'declared', version: '1.0.0', description: 'fixture',
        agents: ['agents/a.agent.md'], mcpConfig: 'config/servers.json' }));
    const rec = recorder();
    await expectRefused(managementClient(rec, MCP_ONLY).publishAgentPackageDirectory(dir, 'user', OWNER, false), 'mcpServers');
    expect(rec.calls).toEqual([]);
});

it('directory upload under deployment-only publishes a package with a plain FILE named mcp-servers', async () => {
    const rec = recorder();
    const out = await managementClient(rec, MCP_ONLY)
        .publishAgentPackageDirectory(writePackage('plainfile', { 'mcp-servers': 'notes, not servers' }), 'user', OWNER, false);
    expect(out.status).toBe('published');
    expect(rec.calls).toContain('publishAgentPackage');
});

it('a host with no policy publishes the same package (workers still enforce at load)', async () => {
    const rec = recorder();
    const out = await managementClient(rec, undefined)
        .publishAgentPackageDirectory(writePackage('open', { '.mcp.json': '{}', 'tools/worker-module.js': 'export const tools=[];' }), 'user', OWNER, false);
    expect(out.status).toBe('published');
    expect(rec.calls).toContain('publishAgentPackage');
});

it('a compliant package publishes under a restrictive policy', async () => {
    const rec = recorder();
    const out = await managementClient(rec, { ...MCP_ONLY, ...NO_MODULES })
        .publishAgentPackageDirectory(writePackage('fine', { 'skills/s/SKILL.md': '---\nname: s\ndescription: x\n---\nBody.\n' }), 'user', OWNER, false);
    expect(out.status).toBe('published');
});

// ─── Packed upload ──────────────────────────────────────────────

it('packed upload rejects a refused archive before any upload or registry write', async () => {
    const prepared = await prepareAgentPackageDir(writePackage('packed', { 'tools/worker-module.js': 'export const tools=[];' }));
    const rec = recorder();
    await expectRefused(publishPackedAgentPackage({ ...rec, capabilities: resolveAgentPackageCapabilities(NO_MODULES, {}) }, {
        manifest: prepared.manifest, targz: prepared.packed.targz, sha256: prepared.packed.sha256,
        scope: 'user', owner: OWNER, createdBy: null, isAdmin: false, sourceId: null, commitSha: null,
    }), 'workerModules');
    expect(rec.calls).toEqual([]);
});

// ─── Exported direct publishing reads the environment ───────────

it.each([
    ['PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS', 'deployment-only', { '.mcp.json': '{}' }, 'mcpServers'],
    ['PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES', 'deployment-only', { 'tools/worker-module.js': 'export const tools=[];' }, 'workerModules'],
])('direct publishing with no policy passed obeys %s=%s from the environment', async (variable, value, files, capability) => {
    const dir = writePackage(`env-${capability.toLowerCase()}`, files);
    const prepared = await prepareAgentPackageDir(dir);
    vi.stubEnv(variable, value);
    try {
        // publishAgentPackageDir, exported, with no capabilities in its context.
        const direct = recorder();
        await expectRefused(publishAgentPackageDir({ catalog: direct.catalog, artifactStore: direct.artifactStore },
            { dir, scope: 'user', owner: OWNER, isAdmin: false }), capability);
        expect(direct.calls).toEqual([]);
        // publishPackedAgentPackage, exported, likewise.
        const packed = recorder();
        await expectRefused(publishPackedAgentPackage({ catalog: packed.catalog, artifactStore: packed.artifactStore }, {
            manifest: prepared.manifest, targz: prepared.packed.targz, sha256: prepared.packed.sha256,
            scope: 'user', owner: OWNER, createdBy: null, isAdmin: false, sourceId: null, commitSha: null,
        }), capability);
        expect(packed.calls).toEqual([]);
        // An explicit policy from an SDK option still wins.
        const explicit = recorder();
        const out = await publishAgentPackageDir({ catalog: explicit.catalog, artifactStore: explicit.artifactStore,
            capabilities: resolveAgentPackageCapabilities({ [capability]: 'enabled' }, {}) },
            { dir, scope: 'user', owner: OWNER, isAdmin: false });
        expect(out.status).toBe('published');
    } finally { vi.unstubAllEnvs(); }
    // Fully unset: enabled, nothing refused.
    const unset = recorder();
    expect((await publishAgentPackageDir({ catalog: unset.catalog, artifactStore: unset.artifactStore },
        { dir, scope: 'user', owner: OWNER, isAdmin: false })).status).toBe('published');
});

// ─── Republish to another scope ─────────────────────────────────

it('republish to another scope rejects a package published before the setting, as a client error', async () => {
    // Published earlier, to the user scope, with no policy.
    const prepared = await prepareAgentPackageDir(writePackage('earlier', { '.mcp.json': '{}' }));
    const filename = 'earlier.tgz';
    const existing = {
        packageId: 'p-earlier', name: 'earlier', scope: 'user', owner: OWNER, enabled: true, activeVersionId: 'v1',
        versions: [{ versionId: 'v1', semver: '1.0.0', sha256: prepared.packed.sha256, artifactFilename: filename,
            sizeBytes: prepared.packed.targz.length, manifest: prepared.manifest }],
    };
    const rec = recorder(existing);
    rec.artifactStore.artifacts.set(`${agentPackagesArtifactSessionId()}/${filename}`, prepared.packed.targz);
    const client = managementClient(rec, MCP_ONLY);
    await expectRefused(client.republishAgentPackageVersion('earlier', '1.0.0', 'shared', OWNER, true), 'mcpServers');
    expect(rec.calls.filter(call => call !== 'getAgentPackage')).toEqual([]);
});

// ─── The Agent Manager's publish tool ───────────────────────────

it('publish_agent_package rejects a staged package that ships a worker module, with the stable code', async () => {
    const rec = recorder();
    const tools = new Map(createAgentManagerTools({
        catalog: rec.catalog, artifactStore: rec.artifactStore, sessionId: 'author',
        resolveViewer: async () => ({ provider: 'test', subject: 'publisher', isAdmin: false, isSystemPrincipal: false }),
        agentPackageCapabilities: resolveAgentPackageCapabilities(NO_MODULES, {}),
    }).map(tool => [tool.name, tool]));
    await tools.get('stage_agent_package_edit').handler({ package: 'authored', files: {
        'plugin.json': JSON.stringify({ name: 'authored', version: '1.0.0', description: 'A package.' }),
        [CHANGELOG_PATH]: '## 1.0.0\n- first',
        'tools/worker-module.js': 'export const tools = [];',
    } });
    rec.calls.length = 0;
    const out = await tools.get('publish_agent_package').handler({ package: 'authored', semver: '1.0.0', approved_by: 'publisher' });
    expect(out).toMatchObject({ refused: true, code: 'PACKAGE_CAPABILITY_REFUSED', capability: 'workerModules' });
    expect(rec.calls.filter(call => call.startsWith('upload') || call === 'publishAgentPackage')).toEqual([]);
});
