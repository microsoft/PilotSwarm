import test from "node:test";
import assert from "node:assert/strict";

import {
    AZURE_DEVOPS_MCP_SCOPE,
    AZURE_DEVOPS_SCOPE,
    azureDevOpsGitAuthorizationHeader,
    azureDevOpsGitConfig,
    azureDevOpsMcpAuthorizationHeader,
    createAzureDevOpsAccessTokenProvider,
    createAzureDevOpsMcpAccessTokenProvider,
    createAzureDevOpsTokenProvider,
    isAzureDevOpsGitAuthenticationFailure,
    isAzureDevOpsPatFallbackEnabled,
    resolveAzureDevOpsCredential,
    takeAzureDevOpsPatFromEnvironment,
} from "../../dist/azure-devops-auth.js";

test("Azure DevOps PAT is consumed without remaining in the environment", () => {
    const environment = {
        ADO_PAT: " fallback-pat ",
        SAFE_VALUE: "preserved",
    };

    assert.equal(takeAzureDevOpsPatFromEnvironment(environment), "fallback-pat");
    assert.deepEqual(environment, { SAFE_VALUE: "preserved" });
    const sentinelEnvironment = { ADO_PAT: "__PS_UNSET__" };
    assert.equal(
        takeAzureDevOpsPatFromEnvironment(sentinelEnvironment),
        undefined,
    );
    assert.deepEqual(sentinelEnvironment, {});
});

test("Azure DevOps PAT fallback requires an affirmative value", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
        assert.equal(isAzureDevOpsPatFallbackEnabled(value), true);
    }
    for (const value of [undefined, "", "0", "false", "no", "off", "enabled"]) {
        assert.equal(isAzureDevOpsPatFallbackEnabled(value), false);
    }
});

test("Azure DevOps token provider requests the workload API scope", async () => {
    const requestedScopes = [];
    const provider = createAzureDevOpsAccessTokenProvider({
        async getToken(scope) {
            requestedScopes.push(scope);
            return { token: "ado-token", expiresOnTimestamp: Date.now() + 60_000 };
        },
    });

    assert.equal(await provider(), "ado-token");
    assert.deepEqual(requestedScopes, [AZURE_DEVOPS_SCOPE]);
});

test("Azure DevOps token provider preserves expiration metadata", async () => {
    const expiresOnTimestamp = Date.now() + 60_000;
    const provider = createAzureDevOpsTokenProvider({
        async getToken() {
            return { token: "ado-token", expiresOnTimestamp };
        },
    });

    assert.deepEqual(await provider(), {
        token: "ado-token",
        expiresOnTimestamp,
    });
});

test("Azure DevOps MCP token provider requests the hosted MCP scope", async () => {
    const requestedScopes = [];
    const provider = createAzureDevOpsMcpAccessTokenProvider({
        async getToken(scope) {
            requestedScopes.push(scope);
            return { token: "mcp-token", expiresOnTimestamp: Date.now() + 60_000 };
        },
    });

    assert.equal(await provider(), "mcp-token");
    assert.deepEqual(requestedScopes, [AZURE_DEVOPS_MCP_SCOPE]);
});

test("Azure DevOps token provider rejects an empty credential result", async () => {
    const provider = createAzureDevOpsAccessTokenProvider({
        async getToken() {
            return null;
        },
    });

    await assert.rejects(provider, /returned no access token/);
});

test("Azure DevOps Git config carries bearer auth outside argv", () => {
    assert.deepEqual(azureDevOpsGitConfig({
        token: "ado-token",
        source: "workload-identity",
    }), {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: "AUTHORIZATION: bearer ado-token",
    });
});

test("Azure DevOps Git config encodes PAT fallback as Basic auth", () => {
    const expected = Buffer.from(":fallback-pat", "utf8").toString("base64");
    assert.equal(
        azureDevOpsGitAuthorizationHeader({
            token: "fallback-pat",
            source: "pat-fallback",
        }),
        `AUTHORIZATION: Basic ${expected}`,
    );
    assert.throws(
        () => azureDevOpsGitConfig({
            token: "",
            source: "workload-identity",
        }),
        /non-empty credential/,
    );
});

test("Azure DevOps hosted MCP auth uses a bearer token", () => {
    assert.equal(
        azureDevOpsMcpAuthorizationHeader("entra-token"),
        "Bearer entra-token",
    );
    assert.throws(
        () => azureDevOpsMcpAuthorizationHeader(""),
        /non-empty access token/,
    );
});

test("Azure DevOps Git authentication failures are narrowly classified", () => {
    assert.equal(
        isAzureDevOpsGitAuthenticationFailure({
            stderr: Buffer.from("fatal: TF401019: repository access denied"),
        }),
        true,
    );
    assert.equal(
        isAzureDevOpsGitAuthenticationFailure(
            new Error("fatal: unable to access repository: connection reset"),
        ),
        false,
    );
});

test("Azure DevOps credential resolution prefers workload identity", async () => {
    let fallbackCalls = 0;

    const credential = await resolveAzureDevOpsCredential({
        accessTokenProvider: async () => "entra-token",
        patFallbackProvider: async () => {
            fallbackCalls += 1;
            return "pat";
        },
    });

    assert.deepEqual(credential, {
        token: "entra-token",
        source: "workload-identity",
    });
    assert.equal(fallbackCalls, 0);
});

test("Azure DevOps credential resolution uses PAT only after workload identity fails", async () => {
    const credential = await resolveAzureDevOpsCredential({
        accessTokenProvider: async () => {
            throw new Error("federated token unavailable");
        },
        patFallbackProvider: async () => " pat ",
    });

    assert.deepEqual(credential, {
        token: "pat",
        source: "pat-fallback",
    });
});

test("Azure DevOps credential resolution rejects an empty workload token before fallback", async () => {
    const credential = await resolveAzureDevOpsCredential({
        accessTokenProvider: async () => " ",
        patFallbackProvider: async () => "fallback-pat",
    });

    assert.deepEqual(credential, {
        token: "fallback-pat",
        source: "pat-fallback",
    });
});

test("Azure DevOps credential resolution preserves the primary error without fallback", async () => {
    const expected = new Error("federated token unavailable");

    await assert.rejects(
        resolveAzureDevOpsCredential({
            accessTokenProvider: async () => {
                throw expected;
            },
            patFallbackProvider: async () => undefined,
        }),
        (error) => error === expected,
    );
});
