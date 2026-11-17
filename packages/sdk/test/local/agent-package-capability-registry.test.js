/**
 * The package capability policy against a real registry and the real
 * installer (issue 311): a package published BEFORE the setting was turned on
 * is refused by a worker that restarts with it, from the archive the
 * installer really unpacks (an empty mcp-servers/ folder included), and a
 * worker that reuses the same cached copy with the setting off loads it again.
 *
 * Run: npx vitest run test/local/agent-package-capability-registry.test.js
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useSuiteEnv } from '../helpers/local-env.js';
import { createCatalog } from '../helpers/cms-helpers.js';
import { withClient } from '../helpers/local-workers.js';
import { FilesystemArtifactStore, publishAgentPackageDir } from '../../src/index.ts';

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: 'test', subject: 'cap-registry-owner' };

function writePackage(dir, name) {
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mcp-servers'), { recursive: true }); // empty on purpose
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'capability fixture' }));
    fs.writeFileSync(path.join(dir, 'agents', 'cap-agent.agent.md'),
        '---\nname: cap-agent\ndescription: fixture\nschemaVersion: 1\nversion: 1.0.0\n---\n\nYou are the capability fixture.\n');
    fs.writeFileSync(path.join(dir, 'tools', 'worker-module.js'), [
        'globalThis.__capFixtureImports = (globalThis.__capFixtureImports ?? 0) + 1;',
        'export const tools = [{ name: "cap_fixture_tool", description: "f", parameters: { type: "object", properties: {} }, handler: async () => "ran" }];',
        '',
    ].join('\n'));
    return dir;
}

describe('package capability policy with a real registry', () => {
    it('refuses a package published before the setting, after a restart, and loads it again with the setting off', { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const artifactStore = new FilesystemArtifactStore(path.join(path.dirname(env.sessionStateDir), 'artifacts'));
        const cacheDir = path.join(env.baseDir, 'cap-cache');
        try {
            // Published with no policy on the publishing host.
            const name = `cap-fixture-${env.runId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
            await publishAgentPackageDir({ catalog, artifactStore }, {
                dir: writePackage(path.join(env.baseDir, 'cap-pkg'), name), scope: 'shared', owner: OWNER, createdBy: 'test', isAdmin: false,
            });
            globalThis.__capFixtureImports = 0;

            // Restart with the setting on: install, refused, never imported.
            await withClient(env, {
                workerNodeId: `cap-on-${env.runId}`,
                worker: { agentPackages: { cacheDir, refreshIntervalMs: 0, capabilities: { mcpServers: 'deployment-only' } } },
            }, async (_client, worker) => {
                expect(worker.loadedAgents.some(agent => agent.name === 'cap-agent')).toBe(false);
                expect(globalThis.__capFixtureImports).toBe(0);
                expect(worker.sessionManager.toolRegistry?.get?.('cap_fixture_tool')).toBeUndefined();
                const installed = fs.readdirSync(cacheDir).find(dir => dir.startsWith(`${name}@`));
                // The empty folder is part of the unpacked layout.
                expect(fs.existsSync(path.join(cacheDir, installed, 'mcp-servers'))).toBe(true);
                const state = (await catalog.listAgentWorkerState()).find(row => row.workerNodeId === `cap-on-${env.runId}`);
                expect(state.installed[name]).toMatchObject({ status: 'error',
                    refusal: { code: 'PACKAGE_CAPABILITY_REFUSED', capability: 'mcpServers', path: 'mcp-servers' } });
            });

            // Restart with the setting off, reusing the cached copy: it loads.
            await withClient(env, {
                workerNodeId: `cap-off-${env.runId}`,
                worker: { agentPackages: { cacheDir, refreshIntervalMs: 0 } },
            }, async (_client, worker) => {
                expect(worker.loadedAgents.some(agent => agent.name === 'cap-agent')).toBe(true);
                expect(globalThis.__capFixtureImports).toBe(1);
            });
        } finally {
            await catalog.close();
        }
    });
});
