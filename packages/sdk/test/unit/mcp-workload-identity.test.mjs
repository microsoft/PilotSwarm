import test from "node:test";
import assert from "node:assert/strict";

import {
    createMcpWorkloadIdentityHeadersProvider,
    parseMcpWorkloadIdentityScopes,
} from "../../dist/mcp-workload-identity.js";

const authorization = (token) => [["Bear", "er"].join(""), token].join(" ");

test("MCP workload identity scopes parse a deployment server mapping", () => {
    assert.deepEqual(
        parseMcpWorkloadIdentityScopes(
            " ado = https://mcp.dev.azure.com/.default , kusto=https://kusto.kusto.windows.net/.default ",
        ),
        [
            {
                serverName: "ado",
                scope: "https://mcp.dev.azure.com/.default",
            },
            {
                serverName: "kusto",
                scope: "https://kusto.kusto.windows.net/.default",
            },
        ],
    );
});

test("MCP workload identity scopes reject malformed or duplicate entries", () => {
    assert.throws(
        () => parseMcpWorkloadIdentityScopes("ado"),
        /SERVER_NAME=scope/,
    );
    assert.throws(
        () => parseMcpWorkloadIdentityScopes("ado=api://resource"),
        /ending in '\/\.default'/,
    );
    assert.throws(
        () =>
            parseMcpWorkloadIdentityScopes(
                "ado=api://one/.default,ado=api://two/.default",
            ),
        /configured more than once/,
    );
    for (const value of [
        ",",
        "ado=api://one/.default,",
        ",ado=api://one/.default",
        "ado=api://one/.default,,kusto=api://two/.default",
    ]) {
        assert.throws(
            () => parseMcpWorkloadIdentityScopes(value),
            /empty binding/,
        );
    }
    assert.throws(
        () =>
            parseMcpWorkloadIdentityScopes(
                "ado=api://one/.default;kusto=api://two/.default",
            ),
        /semicolons are not allowed/,
    );
    assert.throws(
        () => parseMcpWorkloadIdentityScopes("ado=${ADO_SCOPE}/.default"),
        /single Entra scope/,
    );
});

test("MCP workload identity requests one token per scope and binds deployment URLs", async () => {
    const requestedScopes = [];
    const provider = createMcpWorkloadIdentityHeadersProvider({
        scopeBindings:
            "ado=https://mcp.dev.azure.com/.default," +
            "boards=https://mcp.dev.azure.com/.default," +
            "kusto=https://kusto.kusto.windows.net/.default",
        deploymentMcpServers: {
            ado: { type: "http", url: "https://mcp.dev.azure.com/org" },
            boards: { type: "sse", url: "https://mcp.dev.azure.com/org/boards" },
            kusto: { url: "https://kusto.example.test/mcp" },
        },
        credential: {
            async getToken(scope) {
                requestedScopes.push(scope);
                return {
                    token: `token-for-${scope}`,
                    expiresOnTimestamp: Date.now() + 60_000,
                };
            },
        },
    });

    assert.ok(provider);
    const expectedHeaders = {
        ado: {
            expectedUrl: "https://mcp.dev.azure.com/org",
            headers: {
                Authorization: authorization(
                    "token-for-https://mcp.dev.azure.com/.default",
                ),
            },
        },
        boards: {
            expectedUrl: "https://mcp.dev.azure.com/org/boards",
            headers: {
                Authorization: authorization(
                    "token-for-https://mcp.dev.azure.com/.default",
                ),
            },
        },
        kusto: {
            expectedUrl: "https://kusto.example.test/mcp",
            headers: {
                Authorization: authorization(
                    "token-for-https://kusto.kusto.windows.net/.default",
                ),
            },
        },
    };
    assert.deepEqual(await provider(), expectedHeaders);
    assert.deepEqual(requestedScopes.sort(), [
        "https://kusto.kusto.windows.net/.default",
        "https://mcp.dev.azure.com/.default",
    ]);
    assert.deepEqual(await provider(), expectedHeaders);
    assert.equal(requestedScopes.length, 4);
});

test("MCP workload identity accepts only trusted deployment HTTPS servers", () => {
    assert.throws(
        () =>
            createMcpWorkloadIdentityHeadersProvider({
                scopeBindings: "missing=api://missing/.default",
                deploymentMcpServers: {},
            }),
        /not present in deployment-owned DEFAULT_MCP_JSON/,
    );
    assert.throws(
        () =>
            createMcpWorkloadIdentityHeadersProvider({
                scopeBindings: "local=api://local/.default",
                deploymentMcpServers: {
                    local: { command: "node", url: "https://example.test/mcp" },
                },
            }),
        /deployment-owned remote server/,
    );
    assert.throws(
        () =>
            createMcpWorkloadIdentityHeadersProvider({
                scopeBindings: "plain=api://plain/.default",
                deploymentMcpServers: {
                    plain: { type: "http", url: "http://example.test/mcp" },
                },
            }),
        /must use an HTTPS URL/,
    );
});

test("MCP workload identity fails closed when a scope returns no token", async () => {
    const provider = createMcpWorkloadIdentityHeadersProvider({
        scopeBindings: "ado=https://mcp.dev.azure.com/.default",
        deploymentMcpServers: {
            ado: { type: "http", url: "https://mcp.dev.azure.com/org" },
        },
        credential: {
            async getToken() {
                return null;
            },
        },
    });

    await assert.rejects(provider, /returned no access token/);
});

test("MCP workload identity identifies a scope whose credential request fails", async () => {
    const expected = new Error("credential unavailable");
    const provider = createMcpWorkloadIdentityHeadersProvider({
        scopeBindings:
            "ado=https://mcp.dev.azure.com/.default," +
            "kusto=https://kusto.kusto.windows.net/.default",
        deploymentMcpServers: {
            ado: { type: "http", url: "https://mcp.dev.azure.com/org" },
            kusto: { type: "http", url: "https://kusto.example.test/mcp" },
        },
        credential: {
            async getToken(scope) {
                if (scope.includes("kusto")) throw expected;
                return {
                    token: "ado-token",
                    expiresOnTimestamp: Date.now() + 60_000,
                };
            },
        },
    });

    await assert.rejects(
        provider,
        (error) =>
            error.cause === expected
            && error.message.includes(
                "https://kusto.kusto.windows.net/.default",
            ),
    );
});
