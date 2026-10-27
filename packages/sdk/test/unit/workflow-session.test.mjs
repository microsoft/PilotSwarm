import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/client.js";
import {
    workflowCompiledManifestSha256,
} from "../../dist/workflow-orchestration/compiler.js";
import { workflowCanonicalJsonSha256 } from "../../dist/workflow-orchestration/admission.js";

function registeredDefinition(definitionId, inputSchema, identity) {
    const manifest = {
        compilerVersion: "v1alpha1-4",
        apiVersion: "pilotswarm.dev/v1alpha1",
        kind: "Workflow",
        graphId: `workflow-${definitionId}@1.0.0`,
        packageSha256: "a".repeat(64),
        metadata: { name: `workflow-${definitionId}`, version: "1.0.0" },
        inputSchema,
        ...(identity ? { identity } : {}),
        configuration: {},
        initialState: "done",
        states: [{
            id: "done",
            type: "terminal",
            outcome: "succeeded",
            summary: "Done.",
            hasOutput: false,
        }],
    };
    return {
        definitionId,
        compilerVersion: manifest.compilerVersion,
        graphId: manifest.graphId,
        packageSha256: manifest.packageSha256,
        compiledSha256: workflowCompiledManifestSha256(manifest),
        compiledManifest: manifest,
    };
}

test("createWorkflowSession persists a non-conversational child and returns its durable result", async () => {
    const writes = [];
    const starts = [];
    const updates = [];
    const completedAt = new Date("2026-10-02T13:00:00.000Z");
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async (id, name, input, version) => {
            starts.push({ id, name, input, version });
        },
    };
    // Resolution is mandatory for an explicit workflow model, so the fixture
    // has to stand in for a real provider catalog rather than relying on the
    // raw reference falling through unvalidated.
    client._resolveCreationModel = async () => ({
        model: "team:gpt-5.3-codex",
        reasoning: "high",
        context: "long_context",
        source: "explicit",
    });
    client._catalog = {
        createSession: async (sessionId, options) => writes.push({ sessionId, options }),
        recordEvents: async () => {},
        updateSession: async (sessionId, update) => updates.push({ sessionId, update }),
        getChildOutcome: async childSessionId => ({
            childSessionId,
            parentSessionId: "parent-1",
            contractJson: null,
            resultJson: {
                outcome: "succeeded",
                summary: "Workflow finished.",
                result: { artifact: "report.json" },
                metadata: { revision: 1 },
            },
            verdict: "success",
            summary: "Workflow finished.",
            completedAt,
            createdAt: completedAt,
            updatedAt: completedAt,
        }),
    };

    const workflow = await client.createWorkflowSession({
        sessionId: "workflow-1",
        parentSessionId: "parent-1",
        definition: { kind: "registered", definitionId: "definition-1" },
        inputs: { target: "staging" },
        model: "team:gpt-5.3-codex",
    });

    assert.deepEqual(writes, [{
        sessionId: "workflow-1",
        options: {
            sessionKind: "workflow",
            model: "team:gpt-5.3-codex",
            reasoningEffort: "high",
            contextTier: "long_context",
            modelResolutionSource: "explicit",
            parentSessionId: "parent-1",
            owner: null,
            groupId: null,
            visibility: null,
            creationConfig: {
                workflow: {
                    definition: { kind: "registered", definitionId: "definition-1" },
                    inputs: { target: "staging" },
                    model: "team:gpt-5.3-codex",
                    reasoningEffort: "high",
                    contextTier: "long_context",
                },
            },
        },
    }]);
    assert.deepEqual(starts, [{
        id: "session-workflow-1",
        name: "workflow-session-v1",
        input: {
            sessionId: "workflow-1",
            parentSessionId: "parent-1",
            definition: { kind: "registered", definitionId: "definition-1" },
            inputs: { target: "staging" },
            model: "team:gpt-5.3-codex",
            reasoningEffort: "high",
            contextTier: "long_context",
        },
        version: "1.0.0",
    }]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].sessionId, "workflow-1");
    assert.equal(updates[0].update.orchestrationId, "session-workflow-1");
    assert.equal(updates[0].update.state, "running");
    assert.ok(updates[0].update.lastActiveAt instanceof Date);
    assert.equal("send" in workflow, false, "workflow handles must not expose chat methods");
    assert.deepEqual(await workflow.waitForResult(), {
        sessionId: "workflow-1",
        parentSessionId: "parent-1",
        outcome: "succeeded",
        summary: "Workflow finished.",
        result: { artifact: "report.json" },
        completedAt: completedAt.toISOString(),
        metadata: { revision: 1 },
    });
});

test("startWorkflow validates, admits, and starts a registered definition", async () => {
    const admitted = [];
    const created = [];
    const started = [];
    const marked = [];
    const placements = [];
    const client = new PilotSwarmClient({});
    const resolvedModels = [];
    client.duroxideClient = {
        startOrchestrationVersioned: async (...args) => started.push(args),
    };
    client._resolveCreationModel = async config => {
        resolvedModels.push(config);
        return { model: "team:gpt-5.3-codex" };
    };
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(
            definitionId,
            {
                repository: { type: "string", required: true },
                changeId: { type: "integer", required: true },
            },
            {
                primaryKey: ["inputs.repository", "inputs.changeId"],
            },
        ),
        admitWorkflow: async input => {
            admitted.push(input);
            return {
                sessionId: "workflow-admitted",
                definitionId: input.definitionId,
                primaryKeyValues: input.primaryKeyValues,
                primaryKeySha256: input.primaryKeySha256,
                attempt: 1,
                inputs: input.inputs,
                parentSessionId: null,
                owner: input.owner,
                groupId: null,
                visibility: "private",
                rerunReason: null,
                orchestrationId: "session-workflow-admitted",
                requestedModel: input.requestedModel ?? null,
                created: true,
                deduplicated: false,
                needsStart: true,
            };
        },
        createSession: async (...args) => created.push(args),
        recordEvents: async () => {},
        updateSession: async () => {},
        getChildOutcome: async () => null,
        markWorkflowAdmissionStarted: async (...args) => marked.push(args),
        placeSessionsInGroup: async (...args) => placements.push(args),
    };

    const result = await client._startWorkflow({
        definitionId: "definition-1",
        inputs: {
            repository: "microsoft/PilotSwarm",
            changeId: 28,
        },
        model: " gpt-5.3-codex ",
        idempotencyKey: "request-1",
        groupId: "group-1",
        visibility: "private",
    }, {
        owner: {
            provider: "entra",
            subject: "user-1",
            email: "user@example.test",
            displayName: "User One",
        },
    });

    assert.deepEqual(result, {
        sessionId: "workflow-admitted",
        definitionId: "definition-1",
        attempt: 1,
        primaryKeyValues: ["microsoft/PilotSwarm", 28],
        created: true,
        deduplicated: false,
        rerun: false,
    });
    assert.deepEqual(admitted[0].primaryKeyValues, ["microsoft/PilotSwarm", 28]);
    assert.match(admitted[0].primaryKeySha256, /^[a-f0-9]{64}$/);
    assert.equal(resolvedModels[0].model, "gpt-5.3-codex");
    // The trimmed reference the caller asked for is what admission stores, so
    // a later recovery start can rebuild the same run configuration.
    assert.equal(admitted[0].requestedModel, "gpt-5.3-codex");
    assert.equal(created[0][1].model, "team:gpt-5.3-codex");
    assert.equal(started[0][2].model, "team:gpt-5.3-codex");
    assert.equal(created.length, 1);
    assert.equal(started.length, 1);
    assert.deepEqual(marked, [[
        "workflow-admitted",
        "session-workflow-admitted",
    ]]);
    assert.deepEqual(placements, [[
        {
            provider: "entra",
            subject: "user-1",
            isAdmin: false,
        },
        ["workflow-admitted"],
        "group-1",
    ]]);
});

test("startWorkflow includes the resolved model in the idempotency contract", async () => {
    const requestHashes = [];
    const client = new PilotSwarmClient({});
    client.duroxideClient = {};
    client._resolveCreationModel = async config => ({
        model: `team:${config.model}`,
    });
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(
            definitionId,
            {},
        ),
        admitWorkflow: async input => {
            requestHashes.push(input.requestSha256);
            return {
                sessionId: `workflow-${requestHashes.length}`,
                definitionId: input.definitionId,
                primaryKeyValues: null,
                primaryKeySha256: null,
                attempt: 1,
                inputs: input.inputs,
                parentSessionId: null,
                owner: input.owner,
                groupId: null,
                visibility: "private",
                rerunReason: null,
                orchestrationId: `session-workflow-${requestHashes.length}`,
                created: false,
                deduplicated: true,
                needsStart: false,
            };
        },
        placeSessionsInGroup: async () => {},
    };

    for (const model of ["gpt-5.3-codex", "claude-opus-5"]) {
        await client._startWorkflow({
            definitionId: "definition-1",
            inputs: {},
            model,
            idempotencyKey: "request-1",
        });
    }

    assert.equal(requestHashes.length, 2);
    assert.notEqual(requestHashes[0], requestHashes[1]);
});

test("a recovery start uses the admitted model, not the later caller's", async () => {
    // Two requests, one logical entity, different idempotency keys. The first
    // admission never finished starting, so the second request recovers it.
    // Request identity is never compared on that branch, so nothing but the
    // admission row itself can keep the run configuration stable.
    const created = [];
    const started = [];
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async (...args) => started.push(args),
    };
    client._resolveCreationModel = async config => ({
        model: `team:${config.model}`,
        source: "explicit",
    });
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(
            definitionId,
            { changeId: { type: "integer", required: true } },
            { primaryKey: ["inputs.changeId"] },
        ),
        admitWorkflow: async input => ({
            sessionId: "workflow-admitted",
            definitionId: input.definitionId,
            primaryKeyValues: input.primaryKeyValues,
            primaryKeySha256: input.primaryKeySha256,
            attempt: 1,
            inputs: input.inputs,
            parentSessionId: null,
            owner: input.owner,
            groupId: null,
            visibility: null,
            rerunReason: null,
            orchestrationId: "session-workflow-admitted",
            // The first caller's selection, already on the row.
            requestedModel: "gpt-5.3-codex",
            created: false,
            deduplicated: true,
            needsStart: true,
        }),
        createSession: async (...args) => created.push(args),
        recordEvents: async () => {},
        updateSession: async () => {},
        getChildOutcome: async () => null,
        markWorkflowAdmissionStarted: async () => {},
    };

    await client._startWorkflow({
        definitionId: "definition-1",
        inputs: { changeId: 7 },
        model: "claude-opus-5",
        idempotencyKey: "request-2",
    });

    assert.equal(created.length, 1);
    assert.equal(created[0][1].model, "team:gpt-5.3-codex");
    assert.equal(started[0][2].model, "team:gpt-5.3-codex");
});

test("a request without a model keeps the pre-model request digest", async () => {
    // Admission request rows written before run-level models existed must stay
    // matchable, or an unchanged retry across the upgrade is rejected as a
    // different request.
    const hashes = [];
    const client = new PilotSwarmClient({});
    client.duroxideClient = {};
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(definitionId, {}),
        admitWorkflow: async input => {
            hashes.push(input.requestSha256);
            return {
                sessionId: "workflow-1",
                definitionId: input.definitionId,
                primaryKeyValues: null,
                primaryKeySha256: null,
                attempt: 1,
                inputs: input.inputs,
                parentSessionId: null,
                owner: input.owner,
                groupId: null,
                visibility: null,
                rerunReason: null,
                orchestrationId: "session-workflow-1",
                requestedModel: null,
                created: false,
                deduplicated: true,
                needsStart: false,
            };
        },
    };

    await client._startWorkflow({
        definitionId: "definition-1",
        inputs: { target: "staging" },
        idempotencyKey: "request-1",
    });

    assert.equal(hashes.length, 1);
    assert.equal(hashes[0], workflowCanonicalJsonSha256({
        definitionId: "definition-1",
        inputs: { target: "staging" },
        visibility: null,
        rerunReason: null,
    }));
});

test("a non-string model is refused with a client error, not a type error", async () => {
    const client = new PilotSwarmClient({});
    client.duroxideClient = {};
    client._catalog = {};

    for (const model of [42, true, { name: "gpt-5.3-codex" }, ["gpt-5.3-codex"]]) {
        await assert.rejects(
            () => client._startWorkflow({
                definitionId: "definition-1",
                inputs: {},
                model,
                idempotencyKey: "request-1",
            }),
            error => error.code === "WORKFLOW_MODEL_INVALID" && error.status === 400,
            `model ${JSON.stringify(model)} must be refused as a client error`,
        );
    }
});

test("an explicit model is refused when no provider catalog can resolve it", async () => {
    // _resolveCreationModel answers null when the catalog carries no provider
    // store. Persisting the raw reference would also skip the database check,
    // which is gated on a resolution source.
    const client = new PilotSwarmClient({});
    client.duroxideClient = {};
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(definitionId, {}),
    };

    await assert.rejects(
        () => client._startWorkflow({
            definitionId: "definition-1",
            inputs: {},
            model: "gpt-5.3-codex",
            idempotencyKey: "request-1",
        }),
        error => error.code === "WORKFLOW_MODEL_UNRESOLVABLE",
    );
});

test("workflow model references reject blank values before admission", async () => {
    const client = new PilotSwarmClient({});
    client.duroxideClient = {};
    client._catalog = {};

    await assert.rejects(
        () => client._startWorkflow({
            definitionId: "definition-1",
            inputs: {},
            model: "  ",
            idempotencyKey: "request-1",
        }),
        error => error.code === "WORKFLOW_MODEL_INVALID",
    );
});

test("startWorkflow returns an already-started logical duplicate without restarting it", async () => {
    const client = new PilotSwarmClient({});
    let startCount = 0;
    client.duroxideClient = {
        startOrchestrationVersioned: async () => {
            startCount += 1;
        },
    };
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(
            definitionId,
            {
                entityId: { type: "string", required: true },
            },
            {
                primaryKey: ["inputs.entityId"],
            },
        ),
        admitWorkflow: async input => ({
            sessionId: "workflow-existing",
            definitionId: input.definitionId,
            primaryKeyValues: input.primaryKeyValues,
            primaryKeySha256: input.primaryKeySha256,
            attempt: 1,
            inputs: input.inputs,
            parentSessionId: null,
            owner: input.owner,
            groupId: null,
            visibility: "private",
            rerunReason: null,
            orchestrationId: "session-workflow-existing",
            created: false,
            deduplicated: true,
            needsStart: false,
        }),
    };

    const result = await client.startWorkflow({
        definitionId: "definition-1",
        inputs: { entityId: "entity-1" },
        idempotencyKey: "request-2",
    });

    assert.equal(result.sessionId, "workflow-existing");
    assert.equal(result.deduplicated, true);
    assert.equal(startCount, 0);
});

test("startWorkflow rejects reruns for definitions without a primary key", async () => {
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async () => {},
    };
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(
            definitionId,
            {
                target: { type: "string", required: true },
            },
        ),
        admitWorkflow: async () => {
            assert.fail("admission must not run for an invalid rerun");
        },
    };

    await assert.rejects(
        client.startWorkflow({
            definitionId: "definition-1",
            inputs: { target: "staging" },
            idempotencyKey: "request-rerun",
            rerun: { reason: "Retry after repairing the target." },
        }),
        error => error?.code === "WORKFLOW_RERUN_REQUIRED",
    );
});

test("startWorkflow passes an explicit keyed rerun to atomic admission", async () => {
    const admitted = [];
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async () => {},
    };
    client._catalog = {
        getWorkflowDefinition: async definitionId => registeredDefinition(
            definitionId,
            {
                entityId: { type: "string", required: true },
            },
            {
                primaryKey: ["inputs.entityId"],
            },
        ),
        admitWorkflow: async input => {
            admitted.push(input);
            return {
                sessionId: "workflow-rerun",
                definitionId: input.definitionId,
                primaryKeyValues: input.primaryKeyValues,
                primaryKeySha256: input.primaryKeySha256,
                attempt: 2,
                inputs: input.inputs,
                parentSessionId: null,
                owner: input.owner,
                groupId: null,
                visibility: "private",
                rerunReason: input.rerunReason,
                orchestrationId: "session-workflow-rerun",
                created: true,
                deduplicated: false,
                needsStart: false,
            };
        },
    };

    const result = await client._startWorkflow({
        definitionId: "definition-1",
        inputs: { entityId: "entity-1" },
        idempotencyKey: "request-rerun",
        rerun: { reason: " Retry after repairing the target. " },
    }, {
        owner: {
            provider: "entra",
            subject: "admin-1",
            email: "admin@example.test",
            displayName: "Admin One",
        },
        isAdmin: true,
    });

    assert.equal(admitted[0].forceRerun, true);
    assert.equal(admitted[0].rerunReason, "Retry after repairing the target.");
    assert.equal(admitted[0].isAdmin, true);
    assert.equal(result.attempt, 2);
    assert.equal(result.rerun, true);
});

test("startWorkflow rejects a tampered persisted definition before admission", async () => {
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async () => {},
    };
    client._catalog = {
        getWorkflowDefinition: async definitionId => ({
            ...registeredDefinition(
                definitionId,
                {
                    entityId: { type: "string", required: true },
                },
                {
                    primaryKey: ["inputs.entityId"],
                },
            ),
            compiledSha256: "0".repeat(64),
        }),
        admitWorkflow: async () => {
            assert.fail("admission must not run for a tampered definition");
        },
    };

    await assert.rejects(
        client.startWorkflow({
            definitionId: "definition-1",
            inputs: { entityId: "entity-1" },
            idempotencyKey: "request-tampered",
        }),
        error => error?.code === "WORKFLOW_COMPILED_MANIFEST_HASH_MISMATCH",
    );
});

test("root workflow sessions do not pretend to return a child result", async () => {
    const client = new PilotSwarmClient({});
    client.duroxideClient = {
        startOrchestrationVersioned: async () => {},
    };
    client._catalog = {
        createSession: async () => {},
        updateSession: async () => {},
        getChildOutcome: async () => null,
    };
    const workflow = await client.createWorkflowSession({
        sessionId: "workflow-root",
        definition: { kind: "registered", definitionId: "definition-1" },
    });

    await assert.rejects(
        workflow.waitForResult(),
        error => error?.code === "WORKFLOW_RESULT_PARENT_REQUIRED",
    );
});

test("workflow sessions cannot be resumed as LLM conversations", async () => {
    const client = new PilotSwarmClient({});
    client._catalog = {
        getSession: async () => ({ sessionId: "workflow-1", sessionKind: "workflow", state: "pending" }),
    };

    await assert.rejects(
        client.resumeSession("workflow-1"),
        error => error?.code === "WORKFLOW_SESSION_NOT_CONVERSATIONAL",
    );
});
