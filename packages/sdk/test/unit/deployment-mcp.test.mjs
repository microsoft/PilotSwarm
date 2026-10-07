import assert from "node:assert/strict";
import test from "node:test";

import { resolveDeploymentMcpWorkerOptions } from "../../dist/deployment-mcp.js";

const httpsConfig = JSON.stringify({
    servers: {
        internal: {
            type: "http",
            url: "https://mcp.example.invalid/mcp",
        },
    },
});

test("deployment MCP options are absent when the environment is unconfigured", () => {
    assert.deepEqual(resolveDeploymentMcpWorkerOptions({ env: {} }), {});
});

test("deployment MCP options load repo-independent servers without auth mappings", () => {
    const options = resolveDeploymentMcpWorkerOptions({
        env: { DEFAULT_MCP_JSON: httpsConfig },
    });

    assert.equal(
        options.mcpServers.internal.url,
        "https://mcp.example.invalid/mcp",
    );
    assert.equal(options.mcpServers.internal.optional, true);
    assert.equal(options.mcpServerHeadersProvider, undefined);
});

test("deployment MCP options add workload identity for configured servers", () => {
    const options = resolveDeploymentMcpWorkerOptions({
        env: {
            DEFAULT_MCP_JSON: httpsConfig,
            MCP_WORKLOAD_IDENTITY_SCOPES:
                "internal=api://example/.default",
        },
    });

    assert.equal(
        options.mcpServers.internal.url,
        "https://mcp.example.invalid/mcp",
    );
    assert.equal(options.mcpServers.internal.optional, true);
    assert.equal(typeof options.mcpServerHeadersProvider, "function");
});

test("startup module MCP options take precedence over deployment fallback", () => {
    const customHeadersProvider = async () => ({});
    const startupWorkerOptions = {
        mcpServers: {
            custom: {
                type: "http",
                url: "https://custom.example.invalid/mcp",
            },
        },
        mcpServerHeadersProvider: customHeadersProvider,
    };

    const options = resolveDeploymentMcpWorkerOptions({
        env: {
            DEFAULT_MCP_JSON: "{ malformed",
            MCP_WORKLOAD_IDENTITY_SCOPES: "invalid",
        },
        startupWorkerOptions,
    });

    assert.equal(options, startupWorkerOptions);
    assert.equal(options.mcpServerHeadersProvider, customHeadersProvider);
});

test("deployment MCP workload identity fails closed without a matching server", () => {
    assert.throws(
        () => resolveDeploymentMcpWorkerOptions({
            env: {
                DEFAULT_MCP_JSON: httpsConfig,
                MCP_WORKLOAD_IDENTITY_SCOPES:
                    "missing=api://example/.default",
            },
        }),
        /is not present in deployment-owned DEFAULT_MCP_JSON/,
    );
});
