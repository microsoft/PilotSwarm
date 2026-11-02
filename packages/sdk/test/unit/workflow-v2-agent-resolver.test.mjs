/**
 * Workflow v2 named agents as a host resolves them (workflow/v2/agent-resolver.ts;
 * design 03 package agents, 02 publication; R09, R18), inactive: only a host
 * that runs controller 1.9.0 resolves them. Over a fake catalog: session rows
 * (the lineage's owner) and the agent registry's install manifest (enabled
 * packages at their active versions, in the registry's order).
 *
 * - A package agent resolves to the registry's package, version and exact
 *   revision (the content hash of the active version), by spawn_agent's own
 *   rule: the owner's own copy first (the owner read from the caller's
 *   lineage), another owner's private package never, a user-scope package
 *   without an owner never.
 * - A state that names a package resolves among that package's agents only.
 * - A worker's deployment and system agents resolve by name, read at each
 *   resolution; a package copy the worker loaded is never used (the registry
 *   is), so a package that is no longer enabled does not resolve.
 * - A host without deployment agents (a management client) refuses any
 *   other name as AGENT_UNAVAILABLE, saying it pins package agents only.
 * - A registry that cannot be read rejects the resolution.
 *
 * Run: node --test test/unit/workflow-v2-agent-resolver.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryWorkflowAgentResolver, createWorkflowAgentResolver } from "../../dist/workflow/v2/agent-resolver.js";
import { WorkflowStoreError } from "../../dist/workflow/v2/store.js";

const ALICE = { provider: "test", subject: "alice" };
const BOB = { provider: "test", subject: "bob" };
const SHARED_REVISION = "a".repeat(64);
const ALICE_REVISION = "b".repeat(64);
const BOB_REVISION = "c".repeat(64);

const SESSIONS = {
    "parent-a": { owner: ALICE, parentSessionId: null },
    "child-of-a": { owner: null, parentSessionId: "parent-a" },
    "parent-b": { owner: BOB, parentSessionId: null },
    orphan: { owner: null, parentSessionId: null },
};

function entry({ packageId, name, scope = "shared", owner = null, semver, sha256, agents }) {
    return { packageId, name, scope, owner, semver, sha256, sizeBytes: 1, artifactFilename: `${name}-${semver}.tgz`,
        manifest: { name, version: semver, agents, skills: [], mcpServers: [] } };
}

/** The registry's enabled packages at their active versions, ordered by name, scope and owner as the registry lists them. */
const PACKAGES = [
    entry({ packageId: "pkg-alice", name: "alice-kit", scope: "user", owner: ALICE, semver: "0.1.0", sha256: ALICE_REVISION,
        agents: [{ name: "reviewer", tools: ["alice_tool"] }] }),
    entry({ packageId: "pkg-bob", name: "bob-kit", scope: "user", owner: BOB, semver: "3.0.0", sha256: BOB_REVISION, agents: [{ name: "secret-agent" }] }),
    entry({ packageId: "pkg-ownerless", name: "ownerless-kit", scope: "user", owner: null, semver: "1.0.0", sha256: "d".repeat(64),
        agents: [{ name: "ghost" }] }),
    entry({ packageId: "pkg-shared", name: "review-kit", semver: "1.2.0", sha256: SHARED_REVISION,
        agents: [{ name: "reviewer", title: "Reviewer", tools: ["read_file"] }, { name: "summarizer" }] }),
];

function catalogOf({ packages = PACKAGES, fail = null } = {}) {
    const reads = { manifest: 0 };
    return {
        reads,
        async getSession(sessionId) { return SESSIONS[sessionId] ?? null; },
        async getAgentPackagesInstallManifest() {
            reads.manifest += 1;
            if (fail) throw fail;
            return packages;
        },
    };
}

const SHARED_REVIEWER = {
    name: "reviewer", namespace: "review-kit", tools: ["read_file"], system: false, creatable: true, title: "Reviewer",
    packageId: "pkg-shared", packageName: "review-kit", packageVersion: "1.2.0", packageRevision: SHARED_REVISION,
};

test("a package agent resolves to the registry's exact revision, the owner's own copy first, never another owner's private one", async () => {
    const resolve = createWorkflowAgentResolver({ catalog: catalogOf() });
    const own = { name: "reviewer", namespace: "alice-kit", tools: ["alice_tool"], system: false, creatable: true,
        packageId: "pkg-alice", packageName: "alice-kit", packageVersion: "0.1.0", packageRevision: ALICE_REVISION };
    assert.deepEqual(await resolve("reviewer", "parent-a"), own);
    // The owner comes from the caller's lineage, as for a spawn.
    assert.deepEqual(await resolve("reviewer", "child-of-a"), own);
    assert.deepEqual(await resolve("reviewer", "parent-b"), SHARED_REVIEWER);
    assert.deepEqual(await resolve("reviewer", "orphan"), SHARED_REVIEWER);
    // Another owner's private package is invisible; so is a user-scope package without an owner (fail closed).
    assert.equal(await resolve("secret-agent", "parent-a"), null);
    assert.equal((await resolve("secret-agent", "parent-b")).packageRevision, BOB_REVISION);
    assert.equal(await resolve("ghost", "parent-a"), null);
    assert.equal(await resolve("ghost", "orphan"), null);
    assert.equal(await resolve("missing", "parent-a"), null);
});

test("a state that names a package resolves among that package's agents only", async () => {
    const deploymentReviewer = { name: "reviewer", prompt: "deployment reviewer", namespace: "app", tools: ["deploy_tool"] };
    const resolve = createWorkflowAgentResolver({ catalog: catalogOf(), deploymentAgents: () => ({ userAgents: [deploymentReviewer] }) });
    // Alice's own copy is in another package: the named package's agent is the one pinned.
    assert.deepEqual(await resolve("reviewer", "parent-a", "review-kit"), SHARED_REVIEWER);
    // A deployment agent of the same name never takes a package's place.
    assert.deepEqual(await resolve("reviewer", "parent-b", "review-kit"), SHARED_REVIEWER);
    assert.equal(await resolve("reviewer", "parent-a", "bob-kit"), null);
    assert.equal(await resolve("secret-agent", "parent-a", "bob-kit"), null);
    assert.equal((await resolve("secret-agent", "parent-b", "bob-kit")).packageName, "bob-kit");
    assert.equal(await resolve("summarizer", "parent-b", "alice-kit"), null);
    assert.equal((await resolve("summarizer", "parent-b", "review-kit")).packageRevision, SHARED_REVISION);
    // Without a package, the worker's order: its deployment agent first, unless the owner has a copy of their own.
    assert.deepEqual(await resolve("reviewer", "parent-b"), { name: "reviewer", namespace: "app", tools: ["deploy_tool"], system: false, creatable: true });
    assert.equal((await resolve("reviewer", "parent-a")).packageId, "pkg-alice");
});

test("a worker's deployment and system agents resolve by name, read each time; its own package copies never stand in for the registry", async () => {
    const userAgents = [
        { name: "local-helper", prompt: "help", namespace: "app", tools: ["x"] },
        // The worker's installed copy of a package agent lags a republish, and one of a package that is no longer enabled.
        { name: "summarizer", prompt: "stale", packageId: "pkg-shared", packageScope: "shared", namespace: "review-kit", tools: ["stale_tool"] },
        { name: "retired", prompt: "old", packageId: "pkg-retired", packageScope: "shared", namespace: "old-kit" },
    ];
    const systemAgents = [{ name: "sweeper", prompt: "sweep", system: true }];
    const resolve = createWorkflowAgentResolver({ catalog: catalogOf(), deploymentAgents: () => ({ userAgents, systemAgents }) });
    assert.deepEqual(await resolve("local-helper", "parent-b"), { name: "local-helper", namespace: "app", tools: ["x"], system: false, creatable: true });
    assert.deepEqual(await resolve("summarizer", "parent-b"), { name: "summarizer", namespace: "review-kit", system: false, creatable: true,
        packageId: "pkg-shared", packageName: "review-kit", packageVersion: "1.2.0", packageRevision: SHARED_REVISION });
    assert.equal(await resolve("retired", "parent-b"), null);
    assert.deepEqual(await resolve("sweeper", "parent-b"), { name: "sweeper", system: true, creatable: false });
    // The lists are read at each resolution (a worker refreshes them in place).
    assert.equal(await resolve("later", "parent-b"), null);
    userAgents.push({ name: "later", prompt: "later", namespace: "app" });
    assert.deepEqual(await resolve("later", "parent-b"), { name: "later", namespace: "app", system: false, creatable: true });
});

test("a host without deployment agents pins package agents only and refuses any other name clearly", async () => {
    const resolve = createRegistryWorkflowAgentResolver(catalogOf());
    assert.deepEqual(await resolve("reviewer", "parent-b"), SHARED_REVIEWER);
    for (const [name, packageName] of [["local-helper", null], ["secret-agent", "bob-kit"]]) {
        await assert.rejects(resolve(name, "parent-a", packageName), error => {
            assert.ok(error instanceof WorkflowStoreError);
            assert.equal(error.code, "AGENT_UNAVAILABLE");
            assert.deepEqual(error.details, { agent: name, package: packageName, registryOnly: true });
            assert.match(error.message, /pins package agents from the agent registry only/);
            return true;
        });
    }
});

test("a registry that cannot be read rejects the resolution", async () => {
    const fail = new Error("registry read failed");
    const catalog = catalogOf({ fail });
    const resolve = createWorkflowAgentResolver({ catalog, deploymentAgents: () => ({ userAgents: [{ name: "local-helper", prompt: "x" }] }) });
    await assert.rejects(resolve("local-helper", "parent-b"), fail);
    await assert.rejects(createRegistryWorkflowAgentResolver(catalog)("reviewer", "parent-b"), fail);
    assert.equal(catalog.reads.manifest, 2);
});
