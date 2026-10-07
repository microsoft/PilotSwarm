import { loadDefaultMcpConfig } from "./mcp-loader.js";
import { createMcpWorkloadIdentityHeadersProvider } from "./mcp-workload-identity.js";
import type { WorkerStartupResult } from "./worker-startup-module.js";

type StartupWorkerOptions = NonNullable<WorkerStartupResult["workerOptions"]>;

export function resolveDeploymentMcpWorkerOptions(options: {
    env: NodeJS.ProcessEnv;
    startupWorkerOptions?: StartupWorkerOptions;
    trace?: (message: string) => void;
}): StartupWorkerOptions {
    if (options.startupWorkerOptions !== undefined) {
        return options.startupWorkerOptions;
    }

    const rawConfig = options.env.DEFAULT_MCP_JSON;
    const rawScopeBindings = options.env.MCP_WORKLOAD_IDENTITY_SCOPES;
    if (!rawConfig?.trim() && !rawScopeBindings?.trim()) {
        return {};
    }

    const mcpServers = loadDefaultMcpConfig(rawConfig, {
        trace: options.trace,
    });
    const mcpServerHeadersProvider =
        createMcpWorkloadIdentityHeadersProvider({
            scopeBindings: rawScopeBindings,
            deploymentMcpServers: mcpServers,
            trace: options.trace,
        });

    return {
        mcpServers,
        ...(mcpServerHeadersProvider
            ? { mcpServerHeadersProvider }
            : {}),
    };
}
