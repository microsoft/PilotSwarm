import assert from "node:assert/strict";
import test from "node:test";
import { PortalRuntime } from "../runtime.js";

const alice = {
    principal: {
        provider: "entra",
        subject: "alice-object-id",
        email: "alice@example.test",
        displayName: "Alice",
    },
    authorization: {
        allowed: true,
        role: "user",
        reason: "test",
        matchedGroups: [],
    },
};

function createRuntime() {
    const creates = [];
    const runtime = Object.create(PortalRuntime.prototype);
    runtime.started = true;
    runtime.startPromise = null;
    runtime.authz = {
        enforce: true,
        adminScope: "unrestricted",
        defaultVisibility: "private",
        systemVisibility: "read",
    };
    runtime._breakGlassSeen = new Map();
    runtime.transport = {
        async listWorkers() {
            return [{
                phase: "ready",
                updatedAt: new Date(),
                owner: alice.principal,
                info: {
                    ownerScopedRepos: ["sample-repo"],
                    routingTags: ["owner:v1:alice|repo:sample-repo"],
                    models: {
                        defaultModel: "github-copilot:gpt-5",
                        available: ["github-copilot:gpt-5"],
                    },
                },
            }, {
                phase: "ready",
                updatedAt: new Date(),
                owner: { provider: "entra", subject: "bob-object-id" },
                info: {
                    ownerScopedRepos: ["sample-repo"],
                    models: {
                        defaultModel: "github-copilot:claude-opus-5",
                        available: ["github-copilot:claude-opus-5"],
                    },
                },
            }, {
                phase: "ready",
                updatedAt: new Date(),
                owner: null,
                info: {
                    repos: ["sample-repo"],
                },
            }];
        },
        async listModels() {
            return [{
                qualifiedName: "github-copilot:gpt-5",
                credentialAvailable: false,
            }, {
                qualifiedName: "github-copilot:claude-opus-5",
                credentialAvailable: false,
            }];
        },
        async createSession(input) {
            creates.push(input);
            return { sessionId: `session-${creates.length}` };
        },
        async recordAuthzAudit() {},
    };
    return { runtime, creates };
}

test("compute=devbox owner-affines a direct session to the authenticated creator", async () => {
    const { runtime, creates } = createRuntime();

    await runtime.call("createSession", {
        model: "github-copilot:gpt-5",
        repo: "sample-repo",
        compute: "devbox",
    }, alice);

    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].owner, alice.principal);
    assert.equal(creates[0].requireOwnerAffinity, true);
    assert.equal(creates[0].repo, "sample-repo");
});

test("compute=devbox lists only models advertised by the creator's matching worker", async () => {
    const { runtime } = createRuntime();

    const models = await runtime.call("listModels", {
        compute: "devbox",
        repo: "sample-repo",
    }, alice);

    assert.deepEqual(models, [{
        qualifiedName: "github-copilot:gpt-5",
        credentialAvailable: true,
        availabilitySource: "worker",
    }]);
});

test("compute=devbox trusts owner-worker models absent from the cluster catalog", async () => {
    const { runtime } = createRuntime();
    runtime.transport.listModels = async () => [];
    runtime.transport.listWorkers = async () => [{
        phase: "ready",
        updatedAt: new Date(),
        owner: alice.principal,
        info: {
            ownerScopedRepos: ["sample-repo"],
            models: {
                defaultModel: "github-copilot-ambient:claude-sonnet-5",
                available: ["github-copilot-ambient:claude-sonnet-5"],
            },
        },
    }];

    const models = await runtime.call("listModels", {
        compute: "devbox",
        repo: "sample-repo",
    }, alice);

    assert.deepEqual(models, [{
        qualifiedName: "github-copilot-ambient:claude-sonnet-5",
        credentialAvailable: true,
        availabilitySource: "worker",
    }]);
});

test("compute=devbox creates a session with an owner-worker ambient model absent from the cluster catalog", async () => {
    const { runtime, creates } = createRuntime();
    runtime.transport.listModels = async () => [];
    runtime.transport.listWorkers = async () => [{
        phase: "ready",
        updatedAt: new Date(),
        owner: alice.principal,
        info: {
            ownerScopedRepos: ["sample-repo"],
            models: {
                defaultModel: "github-copilot-ambient:claude-sonnet-5",
                available: ["github-copilot-ambient:claude-sonnet-5"],
            },
        },
    }];

    await runtime.call("createSession", {
        model: "github-copilot-ambient:claude-sonnet-5",
        repo: "sample-repo",
        compute: "devbox",
    }, alice);

    assert.equal(creates.length, 1);
    assert.equal(
        creates[0].model,
        "github-copilot-ambient:claude-sonnet-5",
    );
    assert.deepEqual(creates[0].owner, alice.principal);
    assert.equal(creates[0].requireOwnerAffinity, true);
});

test("compute=devbox rejects a model no matching worker advertises", async () => {
    const { runtime } = createRuntime();

    await assert.rejects(
        runtime.call("createSession", {
            model: "github-copilot:claude-opus-5",
            repo: "sample-repo",
            compute: "devbox",
        }, alice),
        /No ready owner-affinitized devbox worker.*advertises model/,
    );
});

test("repo-less devbox discovery requires an explicit generic route", async () => {
    const { runtime } = createRuntime();

    assert.deepEqual(await runtime.call("listModels", {
        compute: "devbox",
    }, alice), []);
});

test("repo-less devbox discovery rejects non-owner tags with a generic suffix", async () => {
    const { runtime } = createRuntime();
    const [worker] = await runtime.transport.listWorkers();
    worker.info.routingTags = ["capability|generic"];
    runtime.transport.listWorkers = async () => [worker];

    assert.deepEqual(await runtime.call("listModels", {
        compute: "devbox",
    }, alice), []);
});

test("owner-affinitized model switching requires a currently advertised model", async () => {
    const { runtime } = createRuntime();
    runtime.transport.getSession = async () => ({
        owner: alice.principal,
        routing: {
            repo: "sample-repo",
            ownerAffinityRequired: true,
        },
    });

    assert.equal(
        await runtime._resolveSessionModelForPlacement(
            "session-1",
            "github-copilot:gpt-5",
        ),
        "github-copilot:gpt-5",
    );
    await assert.rejects(
        runtime._resolveSessionModelForPlacement(
            "session-1",
            "github-copilot:claude-opus-5",
        ),
        /No ready owner-affinitized devbox worker.*advertises model/,
    );
    await assert.rejects(
        runtime._resolveSessionModelForPlacement("session-1", undefined),
        /model is required/,
    );
});

test("cluster and omitted compute retain shared-worker placement", async () => {
    const { runtime, creates } = createRuntime();

    await runtime.call("createSession", {
        model: "github-copilot:gpt-5",
        repo: "sample-repo",
        compute: "cluster",
    }, alice);
    await runtime.call("createSession", {
        model: "github-copilot:gpt-5",
        repo: "sample-repo",
    }, alice);

    assert.equal(creates.length, 2);
    assert.equal("requireOwnerAffinity" in creates[0], false);
    assert.equal("requireOwnerAffinity" in creates[1], false);
});

test("direct session creation rejects unknown compute placement", async () => {
    const { runtime } = createRuntime();

    await assert.rejects(
        runtime.call("createSession", {
            model: "github-copilot:gpt-5",
            repo: "sample-repo",
            compute: "someone-elses-devbox",
        }, alice),
        (error) => (
            error.code === "INVALID_REQUEST"
            && error.message.includes("cluster")
            && error.message.includes("devbox")
        ),
    );
});

test("cluster direct sessions reject delegated caller credentials", async () => {
    const { runtime, creates } = createRuntime();

    await assert.rejects(
        runtime.call("createSession", {
            model: "github-copilot:gpt-5",
            repo: "sample-repo",
            compute: "cluster",
            callerAuth: {
                audienceTokens: { "https://example.test": "caller-token" },
            },
        }, alice),
        (error) => (
            error.code === "INVALID_REQUEST"
            && error.message.includes("must not be sent")
        ),
    );
    assert.equal(creates.length, 0);
});

test("devbox direct sessions reject caller credentials in API requests", async () => {
    const { runtime, creates } = createRuntime();

    await assert.rejects(
        runtime.call("createSession", {
            model: "github-copilot:gpt-5",
            repo: "sample-repo",
            compute: "devbox",
            callerAuth: {
                audienceTokens: { "https://example.test": "caller-token" },
            },
        }, alice),
        (error) => (
            error.code === "INVALID_REQUEST"
            && error.message.includes("must not be sent")
        ),
    );
    assert.equal(creates.length, 0);
});

test("cluster agent sessions reject delegated caller credentials", async () => {
    const { runtime, creates } = createRuntime();

    await assert.rejects(
        runtime.call("createSessionForAgent", {
            agentName: "sample-agent",
            repo: "sample-repo",
            callerAuth: {
                audienceTokens: { "https://example.test": "caller-token" },
            },
        }, alice),
        (error) => (
            error.code === "INVALID_REQUEST"
            && error.message.includes("must not be sent")
        ),
    );
    assert.equal(creates.length, 0);
});
