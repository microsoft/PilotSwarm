/**
 * Issue 311, second allowedAgents fix: a plugin `.mcp.json` and an inline
 * worker-config server share a name. The inline definition wins the catalog
 * and restricts the name with `allowedAgents`, but the plugin's capability
 * source still exports its own unrestricted copy. Selecting that copy with
 * `use_package` must not get around the deployment's final allowlist — at
 * selection, at the next turn's rebind, or at a call.
 *
 * Driven through the real worker plugin load and the real SessionManager
 * preparation, with only the SDK client stubbed.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PilotSwarmWorker } from '../../src/worker.ts';
import { ModelProviderRegistry } from '../../src/model-providers.ts';
import { capabilityRef } from '../../src/capability-catalog.ts';

const OWNER = { provider: 'test', subject: 'shadow-owner' };
let root;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ps-mcp-shadow-'));
    return () => rmSync(root, { recursive: true, force: true });
});

function workerWithShadowedServer() {
    const plugin = join(root, 'plugin');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'ops', version: '1.0.0' }));
    // The plugin's copy: no allowlist.
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({
        secrets: { type: 'http', url: 'https://example.invalid/plugin-copy', tools: ['*'] },
    }));
    return new PilotSwarmWorker({
        store: 'sqlite::memory:', disableManagementAgents: true,
        sessionStateDir: join(root, 'sessions'),
        pluginDirs: [plugin],
        // The deployment's winning definition: only ops-analyst may use it.
        mcpServers: { secrets: { type: 'http', url: 'https://example.invalid/inline', tools: ['*'], allowedAgents: ['ops-analyst'] } },
    });
}

function harness(worker, selections) {
    const manager = worker.sessionManager;
    const opened = [];
    const state = { revision: 1, selections };
    manager.workerDefaults.modelProviders = new ModelProviderRegistry({ providers: [{
        id: 'fixture', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'synthetic', models: ['fixture-model'],
    }] });
    manager.setSessionCatalog({
        getSession: async () => ({ sessionId: 'shadow', owner: OWNER, isSystem: false }),
        getUserRole: async () => ({ role: 'user', seenAt: new Date() }),
        recordEvents: async () => {},
        getSessionCapabilities: async () => state,
        saveSessionCapabilities: async (_id, revision, next) => {
            if (revision !== state.revision) return false;
            Object.assign(state, next);
            return true;
        },
    });
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    manager.ensureClient = async () => {
        const open = config => {
            mkdirSync(join(root, 'sessions', config.sessionId), { recursive: true });
            opened.push(config);
            return { sessionId: config.sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn(),
                rpc: { tasks: { list: vi.fn(async () => ({ tasks: [] })) } } };
        };
        return { createSession: async config => open(config), resumeSession: async (_id, config) => open(config), deleteSession: async () => {} };
    };
    return { manager, opened, state };
}

const pluginSource = worker => worker._getCapabilitySources()
    .find(source => Object.hasOwn(source.mcpServers ?? {}, 'secrets'));

it('the deployment restricts the name, and the plugin source still exports an unrestricted copy (precondition)', () => {
    const worker = workerWithShadowedServer();
    expect(worker.restrictedMcpServers.secrets).toEqual(['ops-analyst']);
    expect(pluginSource(worker)?.mcpServers.secrets.allowedAgents).toBeUndefined();
    expect(worker.sessionManager.workerDefaults.baseMcpServers?.secrets).toBeUndefined();
});

it('use_package cannot select the shadowed copy for an agent the deployment allowlist excludes', async () => {
    const worker = workerWithShadowedServer();
    const source = pluginSource(worker);
    const h = harness(worker, []);
    try {
        const session = await h.manager.getOrCreate('shadow', { model: 'fixture:fixture-model' }, { turnIndex: 0 });
        await expect(session.config.capabilityServices.use({
            source_ref: capabilityRef(source.id, source.revision, 'source'), mcp_servers: ['secrets'], expected_revision: 1, request_id: 'r1',
        })).rejects.toThrow('MCP server is restricted to an authorized bound agent');
        expect(h.state.selections).toEqual([]);
    } finally { await worker.sessionManager.shutdown(); }
});

it('a selection saved earlier is not attached at the next turn', async () => {
    const worker = workerWithShadowedServer();
    const source = pluginSource(worker);
    const h = harness(worker, [{ sourceId: source.id, tools: [], mcpServers: ['secrets'] }]);
    try {
        const session = await h.manager.getOrCreate('shadow', { model: 'fixture:fixture-model' }, { turnIndex: 0 });
        expect(Object.keys(h.opened.at(-1).mcpServers ?? {})).not.toContain('secrets');
        const listed = await session.config.capabilityServices.list();
        expect(listed.unavailable).toContain(source.id);
    } finally { await worker.sessionManager.shutdown(); }
});
