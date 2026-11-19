/**
 * The package capability policy itself (issue 311): option and environment
 * parsing, and the one evaluator that publishing and worker loading share.
 */
import { it, expect, vi } from 'vitest';
import {
    resolveAgentPackageCapabilities, evaluateAgentPackageCapabilities, agentPackageCapabilityEnvVar,
    agentPackageCapabilitiesRestrict, AGENT_PACKAGE_CAPABILITY_VALUES, PACKAGE_CAPABILITY_REFUSED,
} from '../../src/agent-package-capability-policy.ts';

const policy = values => resolveAgentPackageCapabilities(values, {});

// ─── Options and environment ────────────────────────────────────

it('unset means enabled for every capability, and nothing is restricted', () => {
    expect(policy(undefined)).toEqual({ mcpServers: 'enabled', workerModules: 'enabled' });
    expect(agentPackageCapabilitiesRestrict(policy(undefined))).toBe(false);
});

it('exactly two capabilities exist, each with one environment variable', () => {
    expect(Object.keys(AGENT_PACKAGE_CAPABILITY_VALUES)).toEqual(['mcpServers', 'workerModules']);
    expect(agentPackageCapabilityEnvVar('mcpServers')).toBe('PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS');
    expect(agentPackageCapabilityEnvVar('workerModules')).toBe('PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES');
});

it('reads the environment case-insensitively after trimming', () => {
    expect(resolveAgentPackageCapabilities(undefined, {
        PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS: '  Deployment-Only ',
        PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES: 'DEPLOYMENT-ONLY',
    })).toEqual({ mcpServers: 'deployment-only', workerModules: 'deployment-only' });
});

it('the SDK option overrides the environment', () => {
    expect(resolveAgentPackageCapabilities({ mcpServers: 'enabled' }, {
        PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS: 'deployment-only',
    }).mcpServers).toBe('enabled');
});

it('an invalid value fails with an error naming the setting, never echoing the value', () => {
    expect(() => resolveAgentPackageCapabilities(undefined, { PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS: 'sort-of-secret' }))
        .toThrow(/PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS must be one of: enabled, deployment-only/);
    expect(() => resolveAgentPackageCapabilities(undefined, { PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS: 'sort-of-secret' }))
        .not.toThrow(/sort-of-secret/);
    expect(() => resolveAgentPackageCapabilities({ workerModules: 'off' }, {}))
        .toThrow(/agentPackages\.capabilities\.workerModules must be one of: enabled, deployment-only/);
    // `disabled` is not a value of either setting; it fails like any other unknown value.
    expect(() => resolveAgentPackageCapabilities({ mcpServers: 'disabled' }, {})).toThrow(/mcpServers/);
    expect(() => resolveAgentPackageCapabilities({ workerModules: 'disabled' }, {})).toThrow(/workerModules must be one of: enabled, deployment-only/);
    expect(() => resolveAgentPackageCapabilities(undefined, { PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES: 'disabled' }))
        .toThrow(/PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES must be one of: enabled, deployment-only/);
});

it.each(['PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS', 'PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES'])(
    'a blank or whitespace-only %s fails instead of meaning enabled', variable => {
        for (const blank of ['', '   ', '\t']) {
            expect(() => resolveAgentPackageCapabilities(undefined, { [variable]: blank })).toThrow(new RegExp(`${variable} is set but blank`));
        }
    });

it('a blank environment value fails worker start', async () => {
    const { PilotSwarmWorker } = await import('../../src/worker.ts');
    for (const variable of ['PILOTSWARM_AGENT_PACKAGES_MCP_SERVERS', 'PILOTSWARM_AGENT_PACKAGES_WORKER_MODULES']) {
        vi.stubEnv(variable, ' ');
        try {
            expect(() => new PilotSwarmWorker({ store: 'sqlite::memory:', disableManagementAgents: true }))
                .toThrow(new RegExp(`${variable} is set but blank`));
        } finally { vi.unstubAllEnvs(); }
    }
});

it('an unknown capability fails rather than being silently ignored', () => {
    expect(() => resolveAgentPackageCapabilities({ agents: 'disabled' }, {})).toThrow(/agents is not a known capability/);
});

// ─── The evaluator ──────────────────────────────────────────────

const MCP = policy({ mcpServers: 'deployment-only' });
const MODULES = policy({ workerModules: 'deployment-only' });

it.each([
    ['.mcp.json at the root', ['plugin.json', '.mcp.json']],
    ['an mcp-servers/ folder with files', ['mcp-servers/', 'mcp-servers/server.js']],
    ['an EMPTY mcp-servers/ folder', ['plugin.json', 'mcp-servers/']],
    ['a file under mcp-servers/ without its folder entry', ['mcp-servers/server.js']],
    ['a spelling that only a case-insensitive disk would load', ['.MCP.json']],
    ['a path written with ./ and backslashes', ['./.\\.mcp.json']],
])('deployment-only refuses %s', (_label, paths) => {
    const refusal = evaluateAgentPackageCapabilities(MCP, paths);
    expect(refusal).toMatchObject({ code: PACKAGE_CAPABILITY_REFUSED, capability: 'mcpServers', setting: 'deployment-only' });
    expect(refusal.reason).toContain('mcpServers');
});

it.each([
    ['no MCP content', ['plugin.json', 'agents/a.agent.md', 'skills/s/SKILL.md']],
    ['a .mcp.json that is not at the root', ['agents/.mcp.json', 'docs/mcp-servers.md']],
])('deployment-only allows %s', (_label, paths) => {
    expect(evaluateAgentPackageCapabilities(MCP, paths)).toBeNull();
});

it('mcp-servers counts only as a folder: a plain file of that name defines nothing', () => {
    expect(evaluateAgentPackageCapabilities(MCP, ['plugin.json', 'mcp-servers'])).toBeNull();
    expect(evaluateAgentPackageCapabilities(MCP, ['plugin.json', 'MCP-SERVERS'])).toBeNull();
    expect(evaluateAgentPackageCapabilities(MCP, ['mcp-servers/'])).toMatchObject({ capability: 'mcpServers', path: 'mcp-servers' });
});

it('workerModules deployment-only refuses tools/worker-module.js and nothing else', () => {
    expect(evaluateAgentPackageCapabilities(MODULES, ['tools/', 'tools/worker-module.js']))
        .toMatchObject({ code: PACKAGE_CAPABILITY_REFUSED, capability: 'workerModules', path: 'tools/worker-module.js' });
    expect(evaluateAgentPackageCapabilities(MODULES, ['tools/', 'tools/helper.json', '.mcp.json'])).toBeNull();
});

it('an enabled policy refuses nothing, whatever the package holds', () => {
    expect(evaluateAgentPackageCapabilities(policy({}), ['.mcp.json', 'mcp-servers/', 'tools/worker-module.js'])).toBeNull();
});
