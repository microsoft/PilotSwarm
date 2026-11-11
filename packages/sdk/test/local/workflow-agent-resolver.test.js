/**
 * Workflow publication pins from the agent registry (workflow/agent-resolver.ts;
 * design 03 package agents, 02 publication; R09, R18), on real PostgreSQL,
 * on every host that publishes: a management client that takes a person's
 * commands, and a worker turn.
 *
 * - A person's publication (the management client's updateWorkflow): each
 *   named agent state is pinned to the registry package that the workflow's
 *   owner sees, at its exact revision (the content hash of its active
 *   version): the owner's own copy first, and the named package's agent when
 *   the state names one. The pins are frozen with the publication; a
 *   republished package is pinned only by a later publication. An agent the
 *   owner cannot use (another owner's private package, a disabled package,
 *   or a deployment agent, which this client cannot see), and a registry
 *   that cannot be read, refuse the publication with AGENT_UNAVAILABLE (409):
 *   the draft stays a draft, and the refusal does not repeat the registry
 *   failure's own text.
 * - A state that names its package agent's workflow interface
 *   (`interface: name@version`) is published only when the agent exports
 *   that interface at the pinned revision and the state's outcomes and
 *   schemas are exactly the interface's; the pin then also holds the
 *   interface's name, version and digest. A mismatch, an agent that exports
 *   no interface, or an export whose digest does not match refuses the
 *   publication with CONTRACT_MISMATCH (409) and every problem; so does a
 *   real-agent test of the draft, before anything is written. A republish
 *   with another interface changes nothing published.
 * - A worker's publication (its update_workflow tool in a real 1.0.83 turn,
 *   the model scripted): a package agent is pinned at the registry's exact
 *   revision, never from the worker's installed copy; the worker's own
 *   deployment agent is pinned by name; another owner's private agent
 *   refuses the publication.
 *
 * Test doubles: the scripted model session of the native fixture
 * (workflow-intake-native-fixture.js), and one injected registry read
 * failure. No agent state runs here (a worker's agent host runs one in
 * workflow-agent-worker.test.js). Not an activation proof.
 */
import { describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { workflowInterfaceDigest } from "../../src/workflow/package-interface.ts";
import { intakeNativeCase, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-intake-native-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-agent-resolver-test" };
const PERSON = { provider: "test", subject: "alice" };
const OTHER = { provider: "test", subject: "bob" };
const ADMIN = { provider: "test", subject: "registry-admin" };
const hex = () => randomBytes(32).toString("hex");

/** A registry package's publication: shared ones by an admin, user ones by their owner. */
function packageInput(name, semver, sha256, agents, { owner = ADMIN, scope = "user" } = {}) {
    return {
        name, scope, owner, sourceId: null, semver, sha256, sizeBytes: 1024, artifactFilename: `${name}@${semver}.tar.gz`, commitSha: null,
        manifest: { name, version: semver, agents, skills: [], mcpServers: [] }, createdBy: "workflow-agent-resolver-test", isAdmin: scope === "shared",
    };
}

/** The output schema of every agent state `naming` writes. */
const REVIEW_SCHEMA = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } }, additionalProperties: false };

/** A package agent's exported workflow interface review_change@1, as the package validator writes it into the manifest. */
function exportOf(outcomes, outputSchema = REVIEW_SCHEMA) {
    const body = { name: "review_change", version: "1", inputSchema: null, outputSchema, outcomes };
    return { ...body, digest: workflowInterfaceDigest(body) };
}

/** A workflow whose agent states name `agents` ({ stateId: { name, package?, interface? } }), in order. As a document (JSON is YAML). */
function naming(agents) {
    const ids = Object.keys(agents);
    const states = Object.fromEntries(ids.map((id, index) => [id, {
        type: "agent", invoke: { agent: agents[id] }, outputSchema: { $ref: "#/schemas/Review" }, timeoutSeconds: 3600,
        transition: { next: { accepted: ids[index + 1] ?? "done", failure: "failed" } },
    }]));
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "pinned", version: "1.0.0" }, initial: ids[0],
        schemas: { Review: REVIEW_SCHEMA },
        states: { ...states, done: { type: "terminal", outcome: "succeeded" }, failed: { type: "terminal", outcome: "failed" } },
    }, null, 2);
}

/** A draft workflow of `parent` (revision 1), compiled as a host compiles it. */
async function draftOf(catalog, store, parent, yaml) {
    const workflowSessionId = randomUUID();
    const compiled = compileWorkflow(yaml);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect((await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflow: { requestSha256: "agent-resolver" } } })).created).toBe(true);
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR, operationId: "create",
        requestSha256: "agent-resolver", publish: false, title: `Workflow: ${compiled.name}`, start: null,
    });
    return { workflowSessionId, definitionHash: compiled.yamlSha256 };
}

async function refused(call, code, status) {
    let caught;
    try { await call(); } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    expect(caught?.status, caught?.message).toBe(status);
    return caught;
}

describe("workflow: a person's publication pins named agents from the agent registry (management client, inactive)", () => {
    it("pins the owner's registry agents at their exact revisions, frozen with the publication, and refuses what the owner cannot use", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const mgmt = new PilotSwarmManagementClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
            workflowCommands: {},
        });
        await mgmt.start();
        try {
            const store = catalog.workflowStore();
            const tag = randomUUID().slice(0, 8);
            const shared = `review-kit-${tag}`;
            const own = `alice-kit-${tag}`;
            const foreign = `bob-kit-${tag}`;
            const [S1, S2, A1] = [hex(), hex(), hex()];
            const reviewer = [{ name: "reviewer", tools: ["read_file"] }];
            const sharedFirst = await catalog.publishAgentPackage(packageInput(shared, "1.0.0", S1, reviewer, { scope: "shared" }));
            const ownV1 = await catalog.publishAgentPackage(packageInput(own, "0.1.0", A1, [{ name: "reviewer" }], { owner: PERSON }));
            await catalog.publishAgentPackage(packageInput(foreign, "2.0.0", hex(), [{ name: "secret-agent" }], { owner: OTHER }));
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: PERSON });
            const publish = (draft, operationId) => mgmt.updateWorkflow(draft.workflowSessionId, { operation: "publish", operation_id: operationId,
                expected_revision: 1, definition_hash: draft.definitionHash }, { principal: PERSON });

            // The bare name is the owner's own copy; the state that names the shared package gets that package's agent.
            const draft = await draftOf(catalog, store, parent, naming({ mine: { name: "reviewer" }, theirs: { name: "reviewer", package: shared } }));
            expect(await publish(draft, "pub-1")).toMatchObject({ operation: "publish", state: "published", publishedRevision: 1 });
            const pins = {
                mine: { name: "reviewer", package: own, version: "0.1.0", packageId: ownV1.packageId, revision: A1 },
                theirs: { name: "reviewer", package: shared, version: "1.0.0", packageId: sharedFirst.packageId, revision: S1 },
            };
            expect((await store.readDefinition(draft.workflowSessionId)).publishedAgentPins).toEqual(pins);

            // A republished package changes nothing that is published; a later publication pins its new revision.
            const sharedNext = await catalog.publishAgentPackage(packageInput(shared, "1.1.0", S2, reviewer, { scope: "shared" }));
            expect(sharedNext.packageId).toBe(sharedFirst.packageId);
            expect((await store.readDefinition(draft.workflowSessionId)).publishedAgentPins).toEqual(pins);
            expect((await mgmt.readWorkflow(draft.workflowSessionId)).definition.publishedAgentPins).toEqual(pins);
            const later = await draftOf(catalog, store, parent, naming({ theirs: { name: "reviewer", package: shared } }));
            expect(await publish(later, "pub-2")).toMatchObject({ state: "published" });
            const republished = { theirs: { ...pins.theirs, version: "1.1.0", revision: S2 } };
            expect((await store.readDefinition(later.workflowSessionId)).publishedAgentPins).toEqual(republished);

            // What the owner cannot use refuses the publication, and the draft stays a draft.
            const unusable = async (agent, pattern) => {
                const refusedDraft = await draftOf(catalog, store, parent, naming({ only: agent }));
                const error = await refused(() => publish(refusedDraft, "pub-x"), "AGENT_UNAVAILABLE", 409);
                expect(error.details).toMatchObject({ stateId: "only", agent: agent.name, package: agent.package ?? null, registryOnly: true });
                expect(error.message).toMatch(pattern);
                expect(await store.readDefinition(refusedDraft.workflowSessionId))
                    .toMatchObject({ state: "draft", publishedRevision: null, publishedAgentPins: null });
            };
            await unusable({ name: "secret-agent" }, /^State 'only': Agent "secret-agent" is not a published package agent that this workflow's owner can use/);
            await unusable({ name: "secret-agent", package: foreign }, /of package "bob-kit-/);
            // A deployment agent: this client knows the registry, not a worker's agents.
            await unusable({ name: "local-helper" }, /a workflow that names a deployment agent is published by its parent agent/);
            await catalog.setAgentPackageEnabled(shared, false, null, true, { scope: "shared" });
            await unusable({ name: "reviewer", package: shared }, /is not a published package agent/);
            await catalog.setAgentPackageEnabled(shared, true, null, true, { scope: "shared" });

            // A registry that cannot be read refuses too, without its failure's text; the same request then succeeds.
            const retry = await draftOf(catalog, store, parent, naming({ theirs: { name: "reviewer", package: shared } }));
            const registry = mgmt._catalog;
            registry.getAgentPackagesInstallManifest = async () => { throw new Error("connect ECONNREFUSED registry-db.invalid:5432"); };
            try {
                const error = await refused(() => publish(retry, "pub-3"), "AGENT_UNAVAILABLE", 409);
                expect(error.details).toMatchObject({ stateId: "theirs", agent: "reviewer", package: shared, retryable: true });
                expect(error.message).toMatch(/the agent registry could not be read/);
                expect(error.message).not.toContain("registry-db.invalid");
            } finally {
                delete registry.getAgentPackagesInstallManifest;
            }
            expect((await store.readDefinition(retry.workflowSessionId)).state).toBe("draft");
            expect(await publish(retry, "pub-3")).toMatchObject({ state: "published", replayed: false });
            expect((await store.readDefinition(retry.workflowSessionId)).publishedAgentPins).toEqual(republished);
        } finally {
            await mgmt.stop();
            await catalog.close();
        }
    });
});

describe("workflow: a person's publication matches a state's contract against its package agent's workflow interface (management client, inactive)", () => {
    it("pins the interface's digest with the exact revision on a match, and refuses a mismatch, a missing or forged export, and such a test", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const mgmt = new PilotSwarmManagementClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
            workflowCommands: {},
        });
        await mgmt.start();
        try {
            const store = catalog.workflowStore();
            const kit = `contract-kit-${randomUUID().slice(0, 8)}`;
            const [R1, R2] = [hex(), hex()];
            const contractExport = exportOf(["accepted"]);
            const kitV1 = await catalog.publishAgentPackage(packageInput(kit, "1.0.0", R1, [
                { name: "contract-reviewer", workflowInterface: contractExport },
                { name: "plain-reviewer" },
                { name: "forged-reviewer", workflowInterface: { ...contractExport, digest: "0".repeat(64) } },
                { name: "loose-reviewer", workflowInterface: exportOf(["accepted"], { type: "object" }) },
            ], { scope: "shared" }));
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: PERSON });
            const publish = (draft, operationId) => mgmt.updateWorkflow(draft.workflowSessionId, { operation: "publish", operation_id: operationId,
                expected_revision: 1, definition_hash: draft.definitionHash }, { principal: PERSON });
            const contracted = (agent, iface = "review_change@1") => naming({ only: { name: agent, package: kit, interface: iface } });

            // Its outcomes and output schema are exactly the interface's: published, and the pin holds the interface's digest.
            const matching = await draftOf(catalog, store, parent, contracted("contract-reviewer"));
            expect(await publish(matching, "pub-1")).toMatchObject({ operation: "publish", state: "published", publishedRevision: 1 });
            const pins = { only: { name: "contract-reviewer", package: kit, version: "1.0.0", packageId: kitV1.packageId, revision: R1,
                interface: { name: "review_change", version: "1", digest: contractExport.digest } } };
            expect((await store.readDefinition(matching.workflowSessionId)).publishedAgentPins).toEqual(pins);

            // Anything else refuses the publication with every problem, and the draft stays a draft: nothing is inferred.
            const mismatch = async (agent, iface, problems, operationId) => {
                const draft = await draftOf(catalog, store, parent, contracted(agent, iface));
                const error = await refused(() => publish(draft, operationId), "CONTRACT_MISMATCH", 409);
                expect(error.details).toEqual({ stateId: "only", agent, package: kit, version: null, interface: iface,
                    packageVersion: expect.any(String), problems });
                expect(error.message).toMatch(new RegExp(`^State 'only' does not match the workflow interface ${iface} of agent "${agent}"`));
                expect(await store.readDefinition(draft.workflowSessionId)).toMatchObject({ state: "draft", publishedRevision: null, publishedAgentPins: null });
            };
            await mismatch("plain-reviewer", "review_change@1", ["its agent exports no workflow interface (expected review_change@1)"], "pub-2");
            await mismatch("forged-reviewer", "review_change@1", ["its agent's workflow interface record is not well formed"], "pub-3");
            await mismatch("contract-reviewer", "review_change@2", ["its agent exports review_change@1, not review_change@2"], "pub-4");
            await mismatch("loose-reviewer", "review_change@1", ["its outputSchema is not exactly the interface's output schema"], "pub-5");

            // Republished with another interface: what is published keeps its pin; a new publication is checked against the new export.
            await catalog.publishAgentPackage(packageInput(kit, "1.1.0", R2, [{ name: "contract-reviewer", workflowInterface: exportOf(["accepted", "changes_required"]) }],
                { scope: "shared" }));
            expect((await store.readDefinition(matching.workflowSessionId)).publishedAgentPins).toEqual(pins);
            const changed = ["its outcomes [accepted] are not the interface's [accepted, changes_required]"];
            await mismatch("contract-reviewer", "review_change@1", changed, "pub-6");

            // A real-agent test of a draft is checked as its publication would be, before anything is written.
            const tested = await draftOf(catalog, store, parent, contracted("contract-reviewer"));
            const testError = await refused(() => mgmt.updateWorkflow(tested.workflowSessionId, { operation: "test", operation_id: "test-1", expected_revision: 1,
                definition_hash: tested.definitionHash, inputs: {}, agent_mode: "real" }, { principal: PERSON }), "CONTRACT_MISMATCH", 409);
            expect(testError.details).toMatchObject({ stateId: "only", problems: changed });
            expect((await mgmt.readWorkflow(tested.workflowSessionId)).runs).toEqual([]);
        } finally {
            await mgmt.stop();
            await catalog.close();
        }
    });
});

describe("workflow: a worker's publication pins named agents from the agent registry (a real 1.0.83 turn, test-only switch)", () => {
    it("pins a package agent at the registry's exact revision, not the worker's installed copy, and the worker's deployment agent by name", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const tag = randomUUID().slice(0, 8);
        const shared = `worker-kit-${tag}`;
        // Names of this case only: the suite's registry also holds the other case's packages.
        const checker = `checker-${tag}`;
        const S1 = hex();
        // The agents the worker loaded: a deployment agent (the package agent's installed copy is added below).
        const userAgents = [{ name: "local-helper", prompt: "Help.", namespace: "app", tools: ["read_file"] }];
        const drafts = {};
        const outcomes = {};
        const script = async (_call, _prompt, opts) => {
            const bridge = opts.controlToolBridge;
            const publish = (draft, operationId) => bridge.updateWorkflow({ workflow_id: draft.workflowSessionId, operation: "publish",
                operation_id: operationId, expected_revision: 1, definition_hash: draft.definitionHash });
            try {
                outcomes.published = JSON.parse(await publish(drafts.pinned, "pub-1"));
                outcomes.refused = JSON.parse(await publish(drafts.foreign, "pub-2"));
            } catch (error) {
                outcomes.error = String(error?.message ?? error);
            } finally {
                outcomes.finished = true;
            }
            return { type: "completed", content: "done", events: [] };
        };
        await intakeNativeCase(getEnv(), "worker publication pins", script, { inlineClient: true, userAgents },
            async h => {
                const sharedFirst = await h.catalog.publishAgentPackage(packageInput(shared, "1.0.0", S1, [{ name: checker, tools: ["read_file"] }],
                    { scope: "shared" }));
                // The worker's installed copy of that agent: never what a publication pins.
                userAgents.push({ name: checker, prompt: "An older checker.", namespace: shared, packageId: sharedFirst.packageId,
                    packageScope: "shared", tools: ["old_tool"] });
                await h.catalog.publishAgentPackage(packageInput(`foreign-kit-${tag}`, "1.0.0", hex(), [{ name: `secret-${tag}` }],
                    { owner: { provider: "test", subject: `foreign-${tag}` } }));
                drafts.pinned = await draftOf(h.catalog, h.store, h.sessionId, naming({ helper: { name: "local-helper" }, review: { name: checker } }));
                drafts.foreign = await draftOf(h.catalog, h.store, h.sessionId, naming({ only: { name: `secret-${tag}` } }));
                await h.start();
                await h.until(({ history }) => history.some(event => event.kind === "QueueSubscribed"), "the session waits for its messages");
                await h.say("publish the workflows", "cm-publish-1");
                await h.until(async () => outcomes.finished === true, "the turn publishes both workflows");
                expect(outcomes.error).toBeUndefined();
                expect(outcomes.published).toMatchObject({ ok: true, operation: "publish", state: "published", publishedRevision: 1 });
                expect((await h.store.readDefinition(drafts.pinned.workflowSessionId)).publishedAgentPins).toEqual({
                    helper: { name: "local-helper", package: null, version: null, packageId: null },
                    review: { name: checker, package: shared, version: "1.0.0", packageId: sharedFirst.packageId, revision: S1 },
                });
                expect(outcomes.refused).toMatchObject({ ok: false, error: { code: "AGENT_UNAVAILABLE",
                    details: { stateId: "only", agent: `secret-${tag}` } } });
                expect(await h.store.readDefinition(drafts.foreign.workflowSessionId)).toMatchObject({ state: "draft", publishedAgentPins: null });
            });
    });
});
