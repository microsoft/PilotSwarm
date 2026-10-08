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
    assert.deepEqual(
        parseMcpWorkloadIdentityScopes("catalog=auto"),
        [{ serverName: "catalog", scope: "auto" }],
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
            "internal=api://internal-mcp/.default",
        deploymentMcpServers: {
            ado: { type: "http", url: "https://mcp.dev.azure.com/org" },
            boards: { type: "sse", url: "https://mcp.dev.azure.com/org/boards" },
            internal: {
                type: "http",
                url: "http://internal-mcp.platform.svc.cluster.local/mcp",
            },
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
        internal: {
            expectedUrl:
                "http://internal-mcp.platform.svc.cluster.local/mcp",
            headers: {
                Authorization: authorization(
                    "token-for-api://internal-mcp/.default",
                ),
            },
        },
    };
    assert.deepEqual(await provider(), expectedHeaders);
    assert.deepEqual(requestedScopes.sort(), [
        "api://internal-mcp/.default",
        "https://mcp.dev.azure.com/.default",
    ]);
    assert.deepEqual(await provider(), expectedHeaders);
    assert.equal(requestedScopes.length, 4);
});

test("MCP workload identity discovers and caches an RFC 9728 scope", async () => {
    const requestedScopes = [];
    const probes = [];
    const metadataRequests = [];
    const provider = createMcpWorkloadIdentityHeadersProvider({
        scopeBindings: "catalog=auto",
        deploymentMcpServers: {
            catalog: {
                type: "http",
                url: "https://mcp.example.test/",
                headers: {
                    "x-mcp-repository": "example",
                },
            },
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
        http: {
            async probe(url, headers) {
                probes.push({ url, headers });
                return {
                    status: 401,
                    wwwAuthenticate:
                        'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/"',
                };
            },
            async getText(url) {
                metadataRequests.push(url);
                return {
                    status: 200,
                    body: JSON.stringify({
                        resource: "https://mcp.example.test/",
                        authorization_servers: [
                            "https://login.microsoftonline.com/tenant/v2.0",
                        ],
                        scopes_supported: [
                            "api://catalog/.default",
                        ],
                    }),
                };
            },
        },
    });

    assert.ok(provider);
    const expected = {
        catalog: {
            expectedUrl: "https://mcp.example.test/",
            headers: {
                Authorization: authorization(
                    "token-for-api://catalog/.default",
                ),
            },
        },
    };
    assert.deepEqual(await provider(), expected);
    assert.deepEqual(await provider(), expected);
    assert.deepEqual(probes, [{
        url: "https://mcp.example.test/",
        headers: {
            "x-mcp-repository": "example",
        },
    }]);
    assert.deepEqual(metadataRequests, [
        "https://mcp.example.test/.well-known/oauth-protected-resource/",
    ]);
    assert.deepEqual(requestedScopes, [
        "api://catalog/.default",
        "api://catalog/.default",
    ]);
});

test("MCP workload identity fails closed when automatic discovery finds no scope", async () => {
    const provider = createMcpWorkloadIdentityHeadersProvider({
        scopeBindings: "open=auto",
        deploymentMcpServers: {
            open: {
                type: "http",
                url: "https://open.example.test/mcp",
            },
        },
        credential: {
            async getToken() {
                throw new Error("must not request a token");
            },
        },
        http: {
            async probe() {
                return { status: 200 };
            },
            async getText() {
                throw new Error("must not fetch metadata");
            },
        },
    });

    await assert.rejects(
        provider,
        /audience discovery for 'open' returned no bearer scope/,
    );
});

test("MCP workload identity rejects a discovered delegated scope", async () => {
    const provider = createMcpWorkloadIdentityHeadersProvider({
        scopeBindings: "server=auto",
        deploymentMcpServers: {
            server: {
                type: "http",
                url: "https://mcp.example.test/",
            },
        },
        credential: {
            async getToken() {
                throw new Error("must not request a token");
            },
        },
        http: {
            async probe() {
                return {
                    status: 401,
                    wwwAuthenticate:
                        'Bearer scope="api://service/user_impersonation"',
                };
            },
            async getText() {
                throw new Error("must not fetch metadata");
            },
        },
    });

    await assert.rejects(
        provider,
        /returned a non-default scope/,
    );
});

test("MCP workload identity refuses automatic discovery with explicit authorization", () => {
    assert.throws(
        () => createMcpWorkloadIdentityHeadersProvider({
            scopeBindings: "server=auto",
            deploymentMcpServers: {
                server: {
                    type: "http",
                    url: "https://mcp.example.test/",
                    headers: {
                        authorization: "Bearer preconfigured",
                    },
                },
            },
        }),
        /explicit Authorization header/,
    );
});

test("MCP workload identity preserves static binding behavior with existing headers", async () => {
    const provider = createMcpWorkloadIdentityHeadersProvider({
        scopeBindings: "server=api://service/.default",
        deploymentMcpServers: {
            server: {
                type: "http",
                url: "https://mcp.example.test/",
                headers: {
                    authorization: "Bearer preconfigured",
                    invalid: 42,
                },
            },
        },
        credential: {
            async getToken(scope) {
                return {
                    token: `token-for-${scope}`,
                    expiresOnTimestamp: Date.now() + 60_000,
                };
            },
        },
    });

    assert.deepEqual(await provider(), {
        server: {
            expectedUrl: "https://mcp.example.test/",
            headers: {
                Authorization: authorization(
                    "token-for-api://service/.default",
                ),
            },
        },
    });
});

test("MCP workload identity accepts only trusted deployment server URLs", () => {
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
        /must use HTTPS or an in-cluster HTTP service URL/,
    );
    for (const url of [
        "http://internal-mcp.svc.cluster.local/mcp",
        "http://internal-mcp.platform.svc.cluster.local.example.test/mcp",
        "http://10.0.0.10/mcp",
        "http://internal-mcp.platform.svc.cluster.local/mcp#fragment",
    ]) {
        assert.throws(
            () =>
                createMcpWorkloadIdentityHeadersProvider({
                    scopeBindings: "internal=api://internal-mcp/.default",
                    deploymentMcpServers: {
                        internal: { type: "http", url },
                    },
                }),
            /must use HTTPS or an in-cluster HTTP service URL/,
        );
    }
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
