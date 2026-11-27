import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { loadSkillsSync } from "../../dist/skills.js";
import { WORKFLOW_SKILLS_DIR, WORKFLOW_TEST_MODE_SKILLS_DIR } from "../../dist/workflow/guidance.js";
import { resolveDeleteTarget } from "../../dist/workflow/session-definitions.js";
import { WorkflowStoreError } from "../../dist/workflow/store.js";
import { WORKFLOW_DEFINITION_TOOLS_REFUSED } from "../../dist/workflow/input-policy.js";

const SIMPLE_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: ping-flow
  version: "1.0.0"
initial: hold
states:
  hold:
    type: wait
    seconds: 10
    transition:
      next:
        elapsed: done
  done:
    type: terminal
    outcome: succeeded
    output: {}
`;

function makeMockMgmt(overrides = {}) {
    const mgmt = Object.create(PilotSwarmManagementClient.prototype);
    mgmt._started = true;
    mgmt.config = {
        store: "postgres://unused",
        workflowCommands: {},
        ...(overrides.config ?? {}),
    };
    mgmt._modelProviders = overrides.modelProviders ?? null;
    mgmt._catalog = overrides.catalog ?? {
        getSession: async () => ({ sessionId: "owner-1", owner: { provider: "test", subject: "alice" }, deletedAt: null }),
        workflowStore: () => overrides.store ?? {
            readWorkflowLineage: async (id) => ({
                sessionId: id,
                level: id === "inside-wf" ? 1 : 0,
                hasWorkflow: id === "inside-wf",
                agentRoot: id === "inside-wf"
                    ? { childSessionId: id, nodeExecutionId: "nx-1", workflowSessionId: "wf-1", controllingSessionId: "root-1", distance: 1 }
                    : null,
            }),
        },
        providers: null,
    };
    if (overrides.sessionForDefinitions) {
        mgmt._sessionForDefinitions = overrides.sessionForDefinitions;
    }
    return mgmt;
}

test("Task 2: createSessionForWorkflow runs prepare -> createSession -> attach -> send, separates principal vs owner", async () => {
    const events = [];
    let createSessionOpts = null;
    let prepareViewer = null;
    let attachPrincipal = null;
    let onSessionCalledWith = null;

    const mgmt = makeMockMgmt();
    mgmt.prepareSessionForWorkflow = async (ref, viewer) => {
        events.push("prepare");
        prepareViewer = viewer;
        return {
            ref,
            semver: "1.2.0",
            packageId: "pkg-1",
            sha256: "sha-1",
            model: null,
            title: "echo · demo",
            systemMessage: "sys",
            kickoff: "greet",
        };
    };
    mgmt.attachSessionWorkflowPackage = async (sessionId, req, opts) => {
        events.push("attach");
        attachPrincipal = opts?.principal ?? null;
        assert.equal(req.packageId, "pkg-1");
        assert.equal(req.sha256, "sha-1");
        return { definitionId: "def-1", revision: 1 };
    };
    mgmt.deleteSession = async () => { events.push("delete"); };
    mgmt.getSession = async (id) => ({ sessionId: id, model: "azure:gpt-5", reasoningEffort: "high" });

    const client = {
        createSession: async (opts) => {
            events.push("createSession");
            createSessionOpts = opts;
            return {
                sessionId: "coord-1",
                send: async (msg, sendOpts) => {
                    events.push("send");
                    assert.equal(msg, "greet");
                    assert.equal(sendOpts.bootstrap, true);
                },
            };
        },
    };

    const res = await mgmt.createSessionForWorkflow("demo/echo", {
        principal: { provider: "local", subject: "default", displayName: "Local" },
        client,
        onSession: (s) => { onSessionCalledWith = s; },
    });

    assert.deepEqual(events, ["prepare", "createSession", "attach", "send"]);
    assert.deepEqual(prepareViewer, { provider: "local", subject: "default", displayName: "Local" });
    assert.deepEqual(attachPrincipal, { provider: "local", subject: "default", displayName: "Local" });
    assert.equal(Object.hasOwn(createSessionOpts, "owner"), false, "owner must not be passed to createSession when omitted");
    assert.equal(onSessionCalledWith?.sessionId, "coord-1");
    assert.equal(res.sessionId, "coord-1");
    assert.equal(res.workflowRef, "demo/echo");
    assert.equal(res.title, "echo · demo");
});

test("Task 2: createSessionForWorkflow S2SF-F3 deletes session on attach failure and skips onSession and kickoff", async () => {
    const events = [];
    let onSessionCalled = false;

    const mgmt = makeMockMgmt();
    mgmt.prepareSessionForWorkflow = async (ref) => {
        events.push("prepare");
        return { ref, semver: "1.0.0", packageId: "p1", sha256: "s1", model: null, title: "t", systemMessage: "sys", kickoff: "k" };
    };
    mgmt.attachSessionWorkflowPackage = async () => {
        events.push("attach");
        throw new WorkflowStoreError("PACKAGE_VERSION_CHANGED", "changed");
    };
    mgmt.deleteSession = async (id) => {
        events.push(`delete:${id}`);
    };

    const client = {
        createSession: async () => {
            events.push("createSession");
            return {
                sessionId: "coord-orphan",
                send: async () => { events.push("send"); },
            };
        },
    };

    await assert.rejects(
        mgmt.createSessionForWorkflow("demo/echo", {
            client,
            onSession: () => { onSessionCalled = true; },
        }),
        err => err.code === "PACKAGE_VERSION_CHANGED",
    );
    assert.deepEqual(events, ["prepare", "createSession", "attach", "delete:coord-orphan"]);
    assert.equal(onSessionCalled, false);
});

test("Task 2: readWorkflowSkills matches WORKFLOW_SKILLS_DIR dynamically, respects testMode, exact name match, identical 404", async () => {
    const mgmt = makeMockMgmt({ config: { workflowCommands: { testMode: false } } });
    const expectedBase = loadSkillsSync(WORKFLOW_SKILLS_DIR).map(s => s.name).sort((a, b) => a.localeCompare(b));
    const listed = await mgmt.readWorkflowSkills();
    assert.deepEqual(listed.skills.map(s => s.name), expectedBase);
    assert.equal(listed.skills.some(s => s.name === "workflow-testing"), false);

    const authoring = await mgmt.readWorkflowSkills({ name: "workflow-authoring" });
    assert.equal(authoring.name, "workflow-authoring");
    assert.ok(authoring.content.length > 100);

    let errUnknown;
    try { await mgmt.readWorkflowSkills({ name: "no-such-skill" }); } catch (e) { errUnknown = e; }
    let errTraversal;
    try { await mgmt.readWorkflowSkills({ name: "../workflow-authoring" }); } catch (e) { errTraversal = e; }
    let errHidden;
    try { await mgmt.readWorkflowSkills({ name: "workflow-testing" }); } catch (e) { errHidden = e; }

    for (const err of [errUnknown, errTraversal, errHidden]) {
        assert.equal(err?.code, "WORKFLOW_SKILL_NOT_FOUND");
        assert.equal(err?.status, 404);
    }
    // Same error template for unknown and hidden workflow-testing (no leakage of test-mode skill existence)
    assert.equal(errHidden.message.replace("'workflow-testing'", "'X'"), errUnknown.message.replace("'no-such-skill'", "'X'"));

    const mgmtTest = makeMockMgmt({ config: { workflowCommands: { testMode: true } } });
    const listedTest = await mgmtTest.readWorkflowSkills();
    const expectedTestSkills = loadSkillsSync(WORKFLOW_TEST_MODE_SKILLS_DIR).map(s => s.name);
    for (const name of expectedTestSkills) {
        assert.ok(listedTest.skills.some(s => s.name === name), `expected ${name} when testMode is on`);
    }
    const testingSkill = await mgmtTest.readWorkflowSkills({ name: "workflow-testing" });
    assert.equal(testingSkill.name, "workflow-testing");
    assert.ok(testingSkill.content.length > 50);
});

test("Task 2: validateWorkflowDefinition delegates to validateWorkflowYaml with host scripts setting", async () => {
    const mgmt = makeMockMgmt({ config: { workflowScripts: true } });
    const res = await mgmt.validateWorkflowDefinition(SIMPLE_YAML);
    assert.equal(res.valid, true);
    assert.equal(res.name, "ping-flow");
    assert.ok(res.graph);

    await assert.rejects(
        mgmt.validateWorkflowDefinition(123),
        err => err.code === "WORKFLOW_COMMAND_INVALID" && err.status === 400,
    );
});

test("Task 2: readSessionWorkflowCard returns package card view for owning session", async () => {
    const mgmt = makeMockMgmt({
        sessionForDefinitions: async () => ({
            store: {
                sessionDefinitions: {
                    readDefinitionByName: async () => null,
                },
            },
            packageWorkflows: {
                find: async (parsed) => ({
                    ref: `${parsed.packageName}/${parsed.name}`,
                    packageName: parsed.packageName,
                    semver: "1.0.0",
                    packageId: "pkg-1",
                    sha256: "sha-1",
                    workflow: {
                        name: parsed.name,
                        cardDigest: "dig-1",
                        interface: { inputSchema: { type: "object" }, outputSchema: null, outcomes: { done: "succeeded" }, asks: [], sends: [] },
                        card: {
                            name: parsed.name,
                            description: "Echo flow",
                            whenToUse: "Testing",
                            inputs: { example: {}, schema: { type: "object" } },
                            outcomes: { done: "finished" },
                            output: { about: "The echo result.", schema: null },
                            asks: {},
                            sends: {},
                            effects: "None.",
                            model: null,
                            modelHints: {},
                            notes: "",
                        },
                    },
                }),
                readFacts: async () => ({ scripts: [], agents: [] }),
            },
        }),
    });

    const card = await mgmt.readSessionWorkflowCard("owner-1", { name: "demo/echo" });
    assert.equal(card.name, "demo/echo");
    assert.equal(card.package, "demo");
    assert.equal(card.version, "1.0.0");
    assert.equal(card.attached, false);
    assert.equal(typeof card.card, "string");
});

test("Task 2: SF-2 refuses save/start/delete/copy/updateSessionWorkflowPackage when originatingSessionId is inside a Workflow", async () => {
    const insideStore = {
        readWorkflowLineage: async (id) => ({
            sessionId: id,
            level: id === "inside-wf" ? 1 : 0,
            hasWorkflow: id === "inside-wf",
            agentRoot: id === "inside-wf"
                ? { childSessionId: id, nodeExecutionId: "nx-1", workflowSessionId: "wf-1", controllingSessionId: "root-1", distance: 1 }
                : null,
        }),
        sessionDefinitions: {},
    };
    const mgmt = makeMockMgmt({
        sessionForDefinitions: async () => ({ store: insideStore, catalog: {} }),
    });

    const opts = { originatingSessionId: "inside-wf" };
    for (const [label, fn] of [
        ["save", () => mgmt.saveSessionWorkflowDefinition("owner-1", { name: "x", yaml: SIMPLE_YAML, operationId: "op-1" }, opts)],
        ["start", () => mgmt.startSessionWorkflowDefinition("owner-1", { definitionId: "d1", operationId: "op-2" }, opts)],
        ["delete", () => mgmt.deleteSessionWorkflowDefinition("owner-1", { definitionId: "d1", operationId: "op-3" }, opts)],
        ["copy", () => mgmt.copySessionWorkflowDefinition("owner-1", { definitionId: "d1", operationId: "op-4" }, opts)],
        ["update-package", () => mgmt.updateSessionWorkflowPackage("owner-1", { definitionId: "d1", operationId: "op-5" }, opts)],
    ]) {
        await assert.rejects(
            fn(),
            err => err.code === WORKFLOW_DEFINITION_TOOLS_REFUSED && err.status === 403,
            `SF-2 must refuse ${label}`,
        );
    }
});

test("Task 2: resolveDeleteTarget handles receipt-first replay, mismatch, live, deleted, and allowLocked", async () => {
    const hostOf = (sd) => ({ store: { sessionDefinitions: sd } });

    // Receipt-first replay by name
    const replayId = await resolveDeleteTarget(
        hostOf({
            readStoredOperation: async () => ({ kind: "delete", receipt: { operation: "delete", definitionId: "def-old", name: "my-wf", deletedAt: "2026-11-27T00:00:00Z" } }),
        }),
        "owner-1",
        { name: "my-wf" },
        "op-1",
    );
    assert.equal(replayId, "def-old");

    // Receipt conflict on wrong name
    await assert.rejects(
        resolveDeleteTarget(
            hostOf({
                readStoredOperation: async () => ({ kind: "delete", receipt: { operation: "delete", definitionId: "def-old", name: "other-wf", deletedAt: "2026-11-27T00:00:00Z" } }),
            }),
            "owner-1",
            { name: "my-wf" },
            "op-1",
        ),
        err => err.code === "OPERATION_CONFLICT",
    );

    // Mismatched definitionId + name -> 400 WORKFLOW_COMMAND_INVALID
    await assert.rejects(
        resolveDeleteTarget(
            hostOf({
                readStoredOperation: async () => null,
                readDefinition: async () => ({ definitionId: "d1", ownerSessionId: "owner-1", name: "alpha", deletedAt: null, locked: false }),
            }),
            "owner-1",
            { definitionId: "d1", name: "beta" },
            "op-2",
        ),
        err => err.code === "WORKFLOW_COMMAND_INVALID",
    );

    // allowLocked: false refuses package name with slash
    await assert.rejects(
        resolveDeleteTarget(
            hostOf({
                readStoredOperation: async () => null,
                readDefinitionByName: async () => null,
            }),
            "owner-1",
            { name: "pkg/flow" },
            "op-3",
            { allowLocked: false },
        ),
        err => err.code === "DEFINITION_LOCKED",
    );

    // allowLocked unset resolves live package name (person delete allowed)
    const livePkgId = await resolveDeleteTarget(
        hostOf({
            readStoredOperation: async () => null,
            readDefinitionByName: async () => ({ definitionId: "d-pkg", ownerSessionId: "owner-1", name: "pkg/flow", deletedAt: null, locked: true }),
        }),
        "owner-1",
        { name: "pkg/flow" },
        "op-4",
    );
    assert.equal(livePkgId, "d-pkg");

    // Deleted definition found for name -> returns newest deleted definitionId so store reports DEFINITION_DELETED
    const delId = await resolveDeleteTarget(
        hostOf({
            readStoredOperation: async () => null,
            readDefinitionByName: async () => null,
            listDefinitions: async () => [
                { definitionId: "d-old", ownerSessionId: "owner-1", name: "gone", deletedAt: "2026-11-26T00:00:00Z" },
                { definitionId: "d-new", ownerSessionId: "owner-1", name: "gone", deletedAt: "2026-11-27T00:00:00Z" },
            ],
        }),
        "owner-1",
        { name: "gone" },
        "op-5",
    );
    assert.equal(delId, "d-new");
});
