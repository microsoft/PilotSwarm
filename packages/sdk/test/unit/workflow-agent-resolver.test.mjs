/**
 * Workflow named agents as a host resolves them (workflow/agent-resolver.ts;
 * design 03 package agents, 02 publication; R09, R18), inactive: only a host
 * that runs the Workflow controller resolves them. Over a fake catalog: session rows
 * (the lineage's owner) and the agent registry's install manifest (enabled
 * packages at their active versions, in the registry's order).
 *
 * - A package agent resolves to the registry's package, version and exact
 *   revision (the content hash of the active version), by spawn_agent's own
 *   rule: the owner's own copy first (the owner read from the caller's
 *   lineage), another owner's private package never, a user-scope package
 *   without an owner never. It carries the package's scope and owner, which
 *   a Start's tool delegation checks and audits.
 * - A state that names a package resolves among that package's agents only.
 * - A worker's deployment and system agents resolve by name, read at each
 *   resolution; a package copy the worker loaded is never used (the registry
 *   is), so a package that is no longer enabled does not resolve.
 * - A host without deployment agents (a management client) refuses any
 *   other name as AGENT_UNAVAILABLE, saying it pins package agents only.
 * - A registry that cannot be read rejects the resolution.
 * - A package agent's definition carries the workflow interface its manifest
 *   exports at that revision, as the registry keeps it (publication checks
 *   it: workflow-package-interface.test.mjs); one that exports none
 *   carries none.
 *
 * Run: node --test test/unit/workflow-agent-resolver.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryWorkflowAgentResolver, createWorkflowAgentResolver } from "../../dist/workflow/agent-resolver.js";
import { WorkflowStoreError } from "../../dist/workflow/store.js";

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
    packageScope: "shared", packageOwner: null,
};

test("a package agent resolves to the registry's exact revision, the owner's own copy first, never another owner's private one", async () => {
    const resolve = createWorkflowAgentResolver({ catalog: catalogOf() });
    const own = { name: "reviewer", namespace: "alice-kit", tools: ["alice_tool"], system: false, creatable: true,
        packageId: "pkg-alice", packageName: "alice-kit", packageVersion: "0.1.0", packageRevision: ALICE_REVISION,
        packageScope: "user", packageOwner: ALICE };
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
        packageId: "pkg-shared", packageName: "review-kit", packageVersion: "1.2.0", packageRevision: SHARED_REVISION,
        packageScope: "shared", packageOwner: null });
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

test("a package agent's definition carries the workflow interface its manifest exports at that revision, as the registry keeps it", async () => {
    const IFACE = { name: "review_change", version: "1", inputSchema: null, outputSchema: { type: "object" }, outcomes: ["accepted"], digest: "f".repeat(64) };
    const CONTRACT_REVISION = "e".repeat(64);
    const contract = (agents) => entry({ packageId: "pkg-contract", name: "contract-kit", semver: "2.0.0", sha256: CONTRACT_REVISION, agents });
    const resolve = createWorkflowAgentResolver({ catalog: catalogOf({ packages: [...PACKAGES,
        contract([{ name: "contract-reviewer", workflowInterface: IFACE }, { name: "plain-reviewer" }])] }) });
    assert.deepEqual(await resolve("contract-reviewer", "parent-b", "contract-kit"), {
        name: "contract-reviewer", namespace: "contract-kit", system: false, creatable: true,
        packageId: "pkg-contract", packageName: "contract-kit", packageVersion: "2.0.0", packageRevision: CONTRACT_REVISION,
        packageScope: "shared", packageOwner: null, workflowInterface: IFACE,
    });
    assert.equal("workflowInterface" in await resolve("plain-reviewer", "parent-b", "contract-kit"), false);
    // Carried as it is kept: publication, not resolution, decides whether it is well formed.
    const kept = createWorkflowAgentResolver({ catalog: catalogOf({ packages: [contract([{ name: "contract-reviewer", workflowInterface: "not an interface" }])] }) });
    assert.equal((await kept("contract-reviewer", "parent-b")).workflowInterface, "not an interface");
    // Other agents resolve as before.
    assert.deepEqual(await resolve("reviewer", "parent-b", "review-kit"), SHARED_REVIEWER);
});

// Stage 2.3 (A2), fixed in 2.5: the resolution's definition says when the agent it chose names Workflow Definitions (its
// workflows list), so an agent state that uses it is refused (AGENT_HAS_WORKFLOWS). spawn_agent's rule returns a new
// definition without the list; it is read from the candidate it chose (the 0ae6cb93 DEV run: never refused).
test("a resolved agent that names Workflow Definitions says so; the same name in a package whose agent names none does not", async () => {
    const packages = [
        entry({ packageId: "pkg-release", name: "release-tools", semver: "1.0.0", sha256: "e".repeat(64),
            agents: [{ name: "release-watcher", workflows: ["release-watch", "ops-kit/incident-digest"] }, { name: "release-helper" }] }),
        entry({ packageId: "pkg-other", name: "other-tools", semver: "1.0.0", sha256: "f".repeat(64),
            agents: [{ name: "release-watcher" }, { name: "empty-list", workflows: [] }] }),
    ];
    for (const resolve of [createWorkflowAgentResolver({ catalog: catalogOf({ packages }) }), createRegistryWorkflowAgentResolver(catalogOf({ packages }))]) {
        const watcher = await resolve("release-watcher", "parent-a", "release-tools");
        assert.equal(watcher.bringsWorkflows, true);
        assert.equal(watcher.packageId, "pkg-release");
        assert.equal(Object.hasOwn(await resolve("release-helper", "parent-a", "release-tools"), "bringsWorkflows"), false);
        const other = await resolve("release-watcher", "parent-a", "other-tools");
        assert.equal(other.packageId, "pkg-other");
        assert.equal(Object.hasOwn(other, "bringsWorkflows"), false);
        assert.equal(Object.hasOwn(await resolve("empty-list", "parent-a", "other-tools"), "bringsWorkflows"), false);
    }
    // A worker's deployment agent with a workflows list, and one without.
    const resolve = createWorkflowAgentResolver({ catalog: catalogOf({ packages: [] }), deploymentAgents: () => ({
        userAgents: [{ name: "coordinator", prompt: "x", workflows: ["release-tools/release-watch"] }, { name: "plain", prompt: "y" }],
        systemAgents: [{ name: "sweeper", prompt: "z", system: true, workflows: ["x/y"] }] }) });
    assert.equal((await resolve("coordinator", "parent-a")).bringsWorkflows, true);
    assert.equal(Object.hasOwn(await resolve("plain", "parent-a"), "bringsWorkflows"), false);
    assert.equal((await resolve("sweeper", "parent-a")).bringsWorkflows, true);
});
