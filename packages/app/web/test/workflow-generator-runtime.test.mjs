import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";

const SENSITIVE = "fleet-secret-canary";

const alice = {
    principal: {
        provider: "dev",
        subject: "alice",
        email: "alice@example.test",
        displayName: "Alice",
    },
    authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
};

const bob = {
    principal: {
        provider: "dev",
        subject: "bob",
        email: "bob@example.test",
        displayName: "Bob",
    },
    authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
};

const admin = {
    principal: {
        provider: "dev",
        subject: "admin",
        email: "admin@example.test",
        displayName: "Admin",
    },
    authorization: { allowed: true, role: "admin", reason: "test", matchedGroups: [] },
};

function createRuntime() {
    const calls = [];
    const deletedGeneratorIds = new Set();
    const deletedWorkflowRunIds = new Set();
    const generators = new Map([
        ["g-alice", {
            workflowGeneratorId: "g-alice",
            name: "Alice Generator",
            owner: { provider: "dev", subject: "alice" },
            activeDefinitionId: "d-alice",
            sourceType: "ado_wiql",
            sourceConfig: { wiql: `SELECT '${SENSITIVE}'` },
            watermark: { continuationToken: SENSITIVE },
            lastError: SENSITIVE,
        }],
        ["g-bob", {
            workflowGeneratorId: "g-bob",
            name: "Bob Generator",
            owner: { provider: "dev", subject: "bob" },
            activeDefinitionId: "d-bob",
            sourceType: "ado_wiql",
            sourceConfig: { wiql: `SELECT '${SENSITIVE}'` },
            watermark: { continuationToken: SENSITIVE },
            lastError: SENSITIVE,
        }],
    ]);
    const sessions = [
        {
            sessionId: "s-alice",
            title: "Alice Session",
            owner: { provider: "dev", subject: "alice", displayName: "Alice" },
            status: "running",
            createdAt: 1,
            updatedAt: 2,
            shortSummary: SENSITIVE,
            summaryState: { secret: SENSITIVE },
            pendingQuestion: { question: SENSITIVE },
            result: SENSITIVE,
            contextUsage: { secret: SENSITIVE },
            routing: { repo: "safe-repo", gitRef: SENSITIVE, ownerAffinityRequired: true },
        },
        {
            sessionId: "s-bob",
            title: "Bob Session",
            owner: { provider: "dev", subject: "bob", displayName: "Bob" },
            status: "waiting",
            createdAt: 3,
            updatedAt: 4,
            shortSummary: SENSITIVE,
            summaryState: { secret: SENSITIVE },
            pendingQuestion: { question: SENSITIVE },
            result: SENSITIVE,
            contextUsage: { secret: SENSITIVE },
            routing: { repo: "safe-repo", gitRef: SENSITIVE, ownerAffinityRequired: true },
        },
    ];
    const workflowRuns = [
        {
            workflowRunId: "j-alice",
            workflowDefinitionId: "d-alice",
            workflowType: "test",
            workflowRunKey: "alice-run",
            owner: { provider: "system", subject: "system" },
            requestedBy: { provider: "dev", subject: "alice", displayName: "Alice" },
            lifecycleState: "active",
            currentState: "Build",
            stateRevision: 1,
            effectiveConfig: {
                affinities: { repo: "safe-repo", compute: "devbox" },
                secret: SENSITIVE,
            },
            input: { secret: SENSITIVE },
            sessionError: SENSITIVE,
            inductionLeaseOwner: SENSITIVE,
            createdAt: new Date(1),
            updatedAt: new Date(2),
        },
        {
            workflowRunId: "j-bob",
            workflowDefinitionId: "d-bob",
            workflowType: "test",
            workflowRunKey: "bob-run",
            owner: { provider: "system", subject: "system" },
            requestedBy: { provider: "dev", subject: "bob", displayName: "Bob" },
            lifecycleState: "blocked",
            currentState: "Review",
            stateRevision: 2,
            effectiveConfig: {
                affinities: { repo: "safe-repo", compute: "cluster" },
                secret: SENSITIVE,
            },
            sessionComputeAffinity: "cluster",
            input: { secret: SENSITIVE },
            sessionError: SENSITIVE,
            inductionLeaseOwner: SENSITIVE,
            createdAt: new Date(3),
            updatedAt: new Date(4),
        },
    ];
    const runtime = Object.create(PortalRuntime.prototype);
    runtime.started = true;
    runtime.startPromise = null;
    runtime.authz = { enforce: true, defaultVisibility: "private", systemVisibility: "read" };
    runtime._breakGlassSeen = new Map();
    runtime.transport = {
        mgmt: {
            async listSessions(placement) {
                calls.push({ method: "listSessions", placement });
                return sessions;
            },
            async listSessionsVisible(viewer, placement) {
                calls.push({ method: "listSessionsVisible", viewer, placement });
                return sessions.filter((session) => session.owner.subject === viewer.subject);
            },
            async listSessionsPage(options) {
                calls.push({ method: "listSessionsPage", options });
                return { sessions, hasMore: false, nextCursor: null };
            },
            async getSession(sessionId) {
                return sessions.find((session) => session.sessionId === sessionId) ?? null;
            },
        },
        async listWorkflowGenerators(owner) {
            calls.push({ method: "listWorkflowGenerators", owner });
            return [...generators.values()].filter((generator) => (
                !deletedGeneratorIds.has(generator.workflowGeneratorId)
                && (
                    !owner
                    || (generator.owner.provider === owner.provider && generator.owner.subject === owner.subject)
                )
            ));
        },
        async listWorkflowGeneratorsPage(options) {
            calls.push({ method: "listWorkflowGeneratorsPage", options });
            return {
                generators: [...generators.values()],
                hasMore: true,
                nextCursor: { updatedAt: 4, id: "g-bob" },
            };
        },
        async createWorkflowGenerator(input) {
            calls.push({ method: "createWorkflowGenerator", input });
            return {
                generator: {
                    workflowGeneratorId: "g-created",
                    name: input.name,
                    owner: input.owner,
                    activeDefinitionId: input.workflowDefinitionId,
                },
                definition: { workflowDefinitionId: input.workflowDefinitionId, version: 1 },
            };
        },
        async createWorkflowDefinition(input) {
            calls.push({ method: "createWorkflowDefinition", input });
            return {
                workflowDefinition: {
                    workflowDefinitionId: "d-created",
                    workflowType: input.workflowType,
                    name: input.name,
                    owner: input.owner,
                    version: 1,
                },
                created: true,
            };
        },
        async createWorkflowRun(input) {
            calls.push({ method: "createWorkflowRun", input });
            return {
                workflowRun: {
                    workflowRunId: "j-direct",
                    workflowDefinitionId: input.workflowDefinitionId,
                    owner: { provider: "system", subject: "system" },
                    input: input.input,
                },
                sessionAssociation: { sessionId: "s-direct", status: "reserved" },
                created: true,
            };
        },
        async getWorkflowGenerator(workflowGeneratorId, includeDeleted = false) {
            if (deletedGeneratorIds.has(workflowGeneratorId) && !includeDeleted) return null;
            return generators.get(workflowGeneratorId) ?? null;
        },
        async getWorkflowDefinition(workflowDefinitionId) {
            if (workflowDefinitionId === "d-direct-alice") {
                return {
                    workflowDefinitionId,
                    owner: { provider: "dev", subject: "alice" },
                    version: 1,
                    workflowDefinition: { prompt: SENSITIVE },
                    affinities: { repo: "safe-repo", secret: SENSITIVE },
                    validationGates: [{ secret: SENSITIVE }],
                    guardrails: { secret: SENSITIVE },
                };
            }
            const workflowGeneratorId = workflowDefinitionId === "d-alice" ? "g-alice" : workflowDefinitionId === "d-bob" ? "g-bob" : null;
            if (!workflowGeneratorId) throw new Error("not found");
            return {
                workflowDefinitionId,
                workflowType: "test",
                name: `${workflowDefinitionId} definition`,
                owner: { provider: "dev", subject: workflowDefinitionId === "d-alice" ? "alice" : "bob" },
                version: 1,
                workflowDefinition: { prompt: SENSITIVE },
                affinities: { repo: "safe-repo", secret: SENSITIVE },
                validationGates: [{ secret: SENSITIVE }],
                guardrails: { secret: SENSITIVE },
            };
        },
        async getWorkflowRun(workflowRunId, includeDeleted = false) {
            if (deletedWorkflowRunIds.has(workflowRunId) && !includeDeleted) return null;
            if (workflowRunId === "j-alice") {
                return { ...workflowRuns[0], workflowGeneratorId: "g-alice" };
            }
            if (workflowRunId === "j-bob") {
                return { ...workflowRuns[1], workflowGeneratorId: "g-bob" };
            }
            if (workflowRunId === "j-direct") {
                return {
                    workflowRunId,
                    workflowGeneratorId: null,
                    owner: { provider: "system", subject: "system" },
                    requestedBy: { provider: "dev", subject: "alice" },
                };
            }
            return null;
        },
        async listWorkflowDefinitions() { return []; },
        async listWorkflowRuns(options, viewer) {
            calls.push({ method: "listWorkflowRuns", options, viewer });
            return workflowRuns.filter((workflowRun) => (
                !viewer || workflowRun.requestedBy.subject === viewer.subject
            ));
        },
        async listWorkflowRunsPage(options) {
            calls.push({ method: "listWorkflowRunsPage", options });
            return {
                workflowRuns,
                hasMore: true,
                nextCursor: { updatedAt: 4, id: "j-bob" },
            };
        },
        async listWorkflowGeneratorRuns(workflowGeneratorId) {
            return workflowRuns.filter((workflowRun) => (
                workflowRun.workflowRunId === (workflowGeneratorId === "g-alice" ? "j-alice" : "j-bob")
            ));
        },
        async listWorkflowGeneratorCycles() { return []; },
        async listWorkflowRunSessions(workflowRunId) {
            calls.push({ method: "listWorkflowRunSessions", workflowRunId });
            return workflowRunId === "j-bob" ? [{
                associationId: "a-bob",
                workflowRunId,
                sessionId: "s-bob",
                stateRunId: "sr-bob",
                ordinal: 1,
                isCurrent: true,
                status: "attached",
                error: SENSITIVE,
                reservedAt: new Date(3),
                attachedAt: new Date(4),
                endedAt: null,
            }] : [];
        },
        async listWorkflowRunStateRuns(workflowRunId) {
            calls.push({ method: "listWorkflowRunStateRuns", workflowRunId });
            return workflowRunId === "j-bob" ? [{
                stateRunId: "sr-bob",
                workflowRunId,
                workflowDefinitionId: "d-bob",
                stateName: "Review",
                stateRevision: 2,
                stateOwner: "platform",
                status: "waiting",
                sessionId: "s-bob",
                sourcePath: "workflow.md",
                sourceCommit: "abc123",
                allowedOutcomes: [{ outcome: SENSITIVE, toState: "Done" }],
                terminal: false,
                leaseOwner: "worker-1",
                error: SENSITIVE,
                createdAt: new Date(3),
                updatedAt: new Date(4),
            }] : [];
        },
        async listWorkflowRunWaits(workflowRunId) {
            calls.push({ method: "listWorkflowRunWaits", workflowRunId });
            return workflowRunId === "j-bob" ? [{
                waitId: "wait-bob",
                workflowRunId,
                stateRunId: "sr-bob",
                workflowDefinitionId: "d-bob",
                sessionId: "s-bob",
                kind: "response",
                status: "pending",
                detectionMode: "response_event",
                prompt: { question: SENSITIVE },
                responseSchema: { secret: SENSITIVE },
                responderPolicy: { secret: SENSITIVE },
                provider: null,
                target: { secret: SENSITIVE },
                predicate: { kind: "required_reviewers", secret: SENSITIVE },
                latestObservation: { secret: SENSITIVE },
                response: { secret: SENSITIVE },
                satisfactionEvidence: { secret: SENSITIVE },
                createdAt: new Date(3),
                updatedAt: new Date(4),
            }] : [];
        },
        async listWorkflowRunJournal(workflowRunId) {
            calls.push({ method: "listWorkflowRunJournal", workflowRunId });
            return workflowRunId === "j-bob" ? [{
                journalEntryId: "journal-bob",
                workflowRunId,
                sequence: 1,
                entryKind: "state_transition",
                workflowDefinitionId: "d-bob",
                fromState: "Build",
                toState: "Review",
                fromRevision: 1,
                toRevision: 2,
                stateRunId: "sr-bob",
                sessionId: "s-bob",
                outcome: "ready",
                summary: SENSITIVE,
                idempotencyKey: SENSITIVE,
                transitionedAt: new Date(4),
            }] : [];
        },
        async setWorkflowRunWaitConditionOverride(workflowRunId, waitId, conditionKey, overridden) {
            calls.push({
                method: "setWorkflowRunWaitConditionOverride",
                workflowRunId,
                waitId,
                conditionKey,
                overridden,
            });
            return { workflowRunId, waitId, conditionKey, overridden };
        },
        async getWorkerTimeline(workerNodeId, options) {
            calls.push({ method: "getWorkerTimeline", workerNodeId, options });
            return [{ timelineId: "event:1", workerNodeId }];
        },
        async deleteWorkflowGenerator(workflowGeneratorId, actor, isAdmin) {
            calls.push({ method: "deleteWorkflowGenerator", workflowGeneratorId, actor, isAdmin });
            const alreadyDeleted = deletedGeneratorIds.has(workflowGeneratorId);
            deletedGeneratorIds.add(workflowGeneratorId);
            return {
                aggregateType: "generator",
                aggregateId: workflowGeneratorId,
                alreadyDeleted,
                deletedSessionCount: 0,
            };
        },
        async deleteWorkflowRun(workflowRunId, actor, isAdmin) {
            calls.push({ method: "deleteWorkflowRun", workflowRunId, actor, isAdmin });
            const alreadyDeleted = deletedWorkflowRunIds.has(workflowRunId);
            deletedWorkflowRunIds.add(workflowRunId);
            return {
                aggregateType: "workflowRun",
                aggregateId: workflowRunId,
                alreadyDeleted,
                deletedSessionCount: 0,
            };
        },
        async recordAuthzAudit(entry) { calls.push({ method: "audit", entry }); },
    };
    return { runtime, calls };
}

test("WorkflowGenerator registration stamps the authenticated owner", async () => {
    const { runtime, calls } = createRuntime();
    const result = await runtime.call("createWorkflowGenerator", {
        name: "HelloWorld",
        cadenceSeconds: 300,
        controllerComputeAffinity: "devbox",
        workflowDefinitionId: "d-alice",
        source: {
            type: "external-items",
            config: { filter: "active" },
        },
    }, alice);
    assert.equal(result.generator.workflowGeneratorId, "g-created");
    const create = calls.find((call) => call.method === "createWorkflowGenerator");
    assert.deepEqual(create.input.owner, alice.principal);
    assert.equal(create.input.controllerComputeAffinity, "devbox");
    assert.equal(create.input.workflowDefinitionId, "d-alice");
    assert.equal(create.input.sourceType, "external-items");
    assert.deepEqual(create.input.sourceConfig, { filter: "active" });
});

test("Workflow Definition publication normalizes Session compute placement", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("createWorkflowDefinition", {
        workflowType: "hello-world",
        name: "Hello World",
        definition: {
            sessionComputeAffinity: "devbox",
            workflowDefinition: { lifecycle: { initialState: "Initial" } },
        },
    }, alice);

    const create = calls.find((call) => call.method === "createWorkflowDefinition");
    assert.equal(create.input.sessionComputeAffinity, "devbox");
    assert.deepEqual(create.input.owner, alice.principal);
});

test("Workflow compute placement accepts null and rejects unsupported values", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("createWorkflowGenerator", {
        name: "Unpinned",
        cadenceSeconds: 300,
        workflowDefinitionId: "d-alice",
        source: { type: "external-items", config: {} },
    }, alice);
    assert.equal(
        calls.find((call) => call.method === "createWorkflowGenerator").input.controllerComputeAffinity,
        null,
    );

    await assert.rejects(
        runtime.call("createWorkflowGenerator", {
            name: "Bad controller compute",
            cadenceSeconds: 300,
            controllerComputeAffinity: "gpu",
            workflowDefinitionId: "d-alice",
            source: { type: "external-items", config: {} },
        }, alice),
        (error) => error.code === "INVALID_REQUEST" && error.message.includes("controllerComputeAffinity"),
    );
    await assert.rejects(
        runtime.call("createWorkflowDefinition", {
            workflowType: "bad-session-compute",
            name: "Bad Session Compute",
            definition: { sessionComputeAffinity: "local" },
        }, alice),
        (error) => error.code === "INVALID_REQUEST" && error.message.includes("sessionComputeAffinity"),
    );
});

test.skip("legacy direct WorkflowRun creation stamps the authenticated requester", async () => {
    const { runtime, calls } = createRuntime();
    const result = await runtime.call("createWorkflowRun", {
        workflowDefinitionId: "d-direct-alice",
        input: { title: "Fix it" },
        workflowRunKey: "request-1",
    }, alice);
    assert.equal(result.workflowRun.workflowRunId, "j-direct");
    const create = calls.find((call) => call.method === "createWorkflowRun");
    assert.deepEqual(create.input.owner, alice.principal);
    assert.equal(Object.hasOwn(create.input, "provenance"), false);
    assert.equal(Object.hasOwn(create.input, "initialState"), false);
    assert.equal(Object.hasOwn(create.input, "affinities"), false);
    assert.equal(create.input.createdBy, "alice");
});

test.skip("legacy direct WorkflowRun creation requires workflowRunKey", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("createWorkflowRun", {
            workflowDefinitionId: "d-direct-alice",
            input: { title: "Fix it" },
            idempotencyKey: "legacy-request-1",
        }, alice),
        /workflowRunKey is required/,
    );
});

test.skip("legacy direct WorkflowRun creation rejects Definition execution overrides", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("createWorkflowRun", {
            workflowDefinitionId: "d-direct-alice",
            input: {},
            workflowRunKey: "request-override",
            initialState: "SkippedAhead",
        }, alice),
        (error) => (
            error.code === "INVALID_REQUEST"
            && error.message.includes("inherit initialState and affinities")
        ),
    );
});

test.skip("legacy WorkflowRun listing forwards canonical identity filters", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("listWorkflowRuns", {
        workflowType: " MockSmoke ",
        workflowRunKey: " issue:123 ",
        limit: 25,
    }, alice);
    assert.deepEqual(
        calls.find((call) => call.method === "listWorkflowRuns")?.options,
        {
            workflowType: "MockSmoke",
            workflowRunKey: "issue:123",
            limit: 25,
        },
    );
    assert.deepEqual(
        calls.find((call) => call.method === "listWorkflowRuns")?.viewer,
        { provider: "dev", subject: "alice" },
    );
});

test.skip("legacy WorkflowRun listing defaults admins to their visible catalog", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("listWorkflowRuns", {}, admin);
    assert.deepEqual(
        calls.find((call) => call.method === "listWorkflowRuns")?.viewer,
        { provider: "dev", subject: "admin" },
    );
});

test.skip("legacy resource admins can explicitly list the fleet-wide Workflow Run catalog", async () => {
    const { runtime, calls } = createRuntime();
    const rows = await runtime.call("listWorkflowRuns", { scope: "fleet" }, admin);
    assert.equal(calls.find((call) => call.method === "listWorkflowRuns")?.viewer, null);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].repository, "safe-repo");
    assert.equal(rows[0].computePlacement, "devbox");
    assert.equal(Object.hasOwn(rows[0], "input"), false);
    assert.equal(Object.hasOwn(rows[0], "effectiveConfig"), false);
    assert.equal(JSON.stringify(rows).includes(SENSITIVE), false);
});

test.skip("legacy non-admins cannot request the fleet-wide Workflow Run catalog", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("listWorkflowRuns", { scope: "fleet" }, alice),
        (error) => error.code === "FORBIDDEN",
    );
});

test.skip("legacy direct WorkflowRun resources are scoped to their requester", async () => {
    const { runtime } = createRuntime();
    assert.equal(
        (await runtime.call("getWorkflowDefinition", { workflowDefinitionId: "d-direct-alice" }, alice))
            .workflowDefinitionId,
        "d-direct-alice",
    );
    assert.deepEqual(
        await runtime.call("listWorkflowRunSessions", { workflowRunId: "j-direct" }, alice),
        [],
    );
    await assert.rejects(
        runtime.call("listWorkflowRunSessions", { workflowRunId: "j-direct" }, bob),
        (error) => error.code === "NOT_FOUND" && error.status === 404,
    );
});

test("WorkflowDefinition publication rejects caller-selected user affinity", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("createWorkflowDefinition", {
            workflowType: "Spoofed",
            name: "Spoofed",
            definition: {
                affinities: { repo: "sample-repo", user: "bob" },
            },
        }, alice),
        (error) => (
            error.code === "INVALID_REQUEST"
            && error.message.includes("server-derived")
        ),
    );
});

test("legacy null Definition user affinity is ignored instead of persisted", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("createWorkflowDefinition", {
        workflowType: "Legacy",
        name: "Legacy",
        definition: {
            affinities: { repo: "sample-repo", user: null },
        },
    }, alice);

    const create = calls.find((call) => call.method === "createWorkflowDefinition");
    assert.deepEqual(create.input.affinities, { repo: "sample-repo" });
});

test("WorkflowDefinition repository affinity uses the canonical routing name", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("createWorkflowDefinition", {
        workflowType: "CanonicalRepo",
        name: "Canonical Repo",
        definition: {
            affinities: { repo: " Example-Service " },
            workflowDefinition: {
                session: { repo: " PilotSwarm " },
                lifecycle: { session: { repo: " Shared-Tools " } },
            },
        },
    }, alice);

    const definition = calls.find((call) => call.method === "createWorkflowDefinition").input;
    assert.equal(definition.affinities.repo, "example-service");
    assert.equal(definition.workflowDefinition.session.repo, "pilotswarm");
    assert.equal(
        definition.workflowDefinition.lifecycle.session.repo,
        "shared-tools",
    );
});

test("WorkflowDefinition publication rejects malformed repository affinity", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("createWorkflowDefinition", {
            workflowType: "BadRepo",
            name: "Bad Repo",
            definition: {
                affinities: { repo: "../private-repo" },
            },
        }, alice),
        (error) => error.code === "INVALID_REQUEST" && error.message.includes("DNS-safe"),
    );
});

test("WorkflowGenerator listing is owner-scoped for users", async () => {
    const { runtime, calls } = createRuntime();
    const rows = await runtime.call("listWorkflowGenerators", {}, alice);
    assert.deepEqual(rows.map((row) => row.workflowGeneratorId), ["g-alice"]);
    assert.deepEqual(calls.find((call) => call.method === "listWorkflowGenerators").owner, alice.principal);
});

test("WorkflowGenerator listing defaults admins to visible scope and requires resource administration for fleet scope", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("listWorkflowGenerators", {}, admin);
    assert.deepEqual(
        calls.find((call) => call.method === "listWorkflowGenerators")?.owner,
        admin.principal,
    );

    calls.length = 0;
    const fleetRows = await runtime.call("listWorkflowGenerators", { scope: "fleet" }, admin);
    assert.equal(calls.find((call) => call.method === "listWorkflowGenerators")?.owner, null);
    assert.equal(fleetRows[0].hasError, true);
    assert.equal(Object.hasOwn(fleetRows[0], "sourceConfig"), false);
    assert.equal(Object.hasOwn(fleetRows[0], "watermark"), false);
    assert.equal(Object.hasOwn(fleetRows[0], "lastError"), false);
    assert.equal(JSON.stringify(fleetRows).includes(SENSITIVE), false);

    await assert.rejects(
        runtime.call("listWorkflowGenerators", { scope: "fleet" }, alice),
        (error) => error.code === "FORBIDDEN",
    );
});

test.skip("legacy WorkflowRun catalog scope rejects unknown values and conflicting parameters", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("listWorkflowRuns", { scope: "admin" }, admin),
        (error) => error.code === "INVALID_REQUEST" && error.status === 400,
    );
    await assert.rejects(
        runtime.call("listWorkflowRuns", { scope: "visible", viewerOnly: false }, admin),
        (error) => error.code === "INVALID_REQUEST" && error.status === 400,
    );
});

test("Session collections default admins to visible scope and gate explicit fleet scope", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("listSessions", {}, admin);
    assert.deepEqual(
        calls.find((call) => call.method === "listSessionsVisible")?.viewer,
        { provider: "dev", subject: "admin", systemVisible: true },
    );

    calls.length = 0;
    const fleetPage = await runtime.call("listSessionsPage", { scope: "fleet", limit: 25 }, admin);
    assert.equal(
        Object.hasOwn(calls.find((call) => call.method === "listSessionsPage")?.options ?? {}, "viewer"),
        false,
    );
    assert.equal(fleetPage.sessions[0].repository, "safe-repo");
    assert.equal(Object.hasOwn(fleetPage.sessions[0], "shortSummary"), false);
    assert.equal(Object.hasOwn(fleetPage.sessions[0], "summaryState"), false);
    assert.equal(Object.hasOwn(fleetPage.sessions[0], "routing"), false);
    assert.equal(JSON.stringify(fleetPage).includes(SENSITIVE), false);

    await assert.rejects(
        runtime.call("listSessions", { scope: "fleet" }, alice),
        (error) => error.code === "FORBIDDEN" && error.status === 403,
    );
    await assert.rejects(
        runtime.call("listSessionsPage", { scope: "fleet" }, alice),
        (error) => error.code === "FORBIDDEN" && error.status === 403,
    );
});

test.skip("legacy fleet WorkflowRun catalog pages forward filters, preserve cursors, and project items", async () => {
    const { runtime, calls } = createRuntime();
    const updatedAfter = new Date("2026-01-01T00:00:00.000Z").toISOString();

    const generatorPage = await runtime.call("listWorkflowGeneratorsPage", {
        scope: "fleet",
        owner: "bob",
        status: "active",
        repository: "safe-repo",
        placement: "cluster",
        updatedAfter,
        limit: 25,
        cursorUpdatedAt: 4,
        cursorId: "g-bob",
    }, admin);
    const generatorCall = calls.find((call) => call.method === "listWorkflowGeneratorsPage");
    assert.deepEqual(generatorCall.options.cursor, { updatedAt: 4, id: "g-bob" });
    assert.equal(generatorCall.options.repository, "safe-repo");
    assert.equal(generatorPage.hasMore, true);
    assert.deepEqual(generatorPage.nextCursor, { updatedAt: 4, id: "g-bob" });
    assert.equal(Object.hasOwn(generatorPage.generators[0], "sourceConfig"), false);

    const runPage = await runtime.call("listWorkflowRunsPage", {
        scope: "fleet",
        owner: "bob",
        status: "blocked",
        repository: "safe-repo",
        placement: "cluster",
        origin: "workflow_generator",
        workflowType: "test",
        runKey: "bob-run",
        updatedAfter,
        limit: 50,
        cursorUpdatedAt: 4,
        cursorId: "j-bob",
    }, admin);
    const runCall = calls.find((call) => call.method === "listWorkflowRunsPage");
    assert.deepEqual(runCall.options.cursor, { updatedAt: 4, id: "j-bob" });
    assert.equal(runCall.options.origin, "workflow_generator");
    assert.equal(runPage.hasMore, true);
    assert.deepEqual(runPage.nextCursor, { updatedAt: 4, id: "j-bob" });
    assert.equal(Object.hasOwn(runPage.workflowRuns[0], "effectiveConfig"), false);
    assert.equal(runPage.workflowRuns[1].computePlacement, "cluster");
    assert.equal(JSON.stringify({ generatorPage, runPage }).includes(SENSITIVE), false);
});

test.skip("legacy WorkflowRun catalog page validation rejects malformed cursors, dates, and origins", async () => {
    const { runtime } = createRuntime();
    for (const [method, params] of [
        ["listWorkflowGeneratorsPage", { cursorUpdatedAt: "later", cursorId: "g-bob" }],
        ["listWorkflowRunsPage", { cursorUpdatedAt: 4 }],
        ["listWorkflowRunsPage", { updatedAfter: "not-a-date" }],
        ["listWorkflowRunsPage", { origin: "scheduled" }],
    ]) {
        await assert.rejects(
            runtime.call(method, { ...params, scope: "fleet" }, admin),
            (error) => error.code === "INVALID_REQUEST" && error.status === 400,
            method,
        );
    }
});

test.skip("legacy fleet detail projections omit sensitive Workflow Run fields", async () => {
    const { runtime } = createRuntime();

    const session = await runtime.call("getSession", { sessionId: "s-bob", scope: "fleet" }, admin);
    assert.equal(session.repository, "safe-repo");
    assert.equal(Object.hasOwn(session, "pendingQuestion"), false);
    assert.equal(Object.hasOwn(session, "result"), false);
    assert.equal(Object.hasOwn(session, "contextUsage"), false);

    const generator = await runtime.call("getWorkflowGenerator", {
        workflowGeneratorId: "g-bob",
        scope: "fleet",
    }, admin);
    assert.equal(generator.hasError, true);
    assert.equal(Object.hasOwn(generator, "sourceConfig"), false);

    const definition = await runtime.call("getWorkflowDefinition", {
        workflowDefinitionId: "d-bob",
        scope: "fleet",
    }, admin);
    assert.deepEqual(definition.affinities, { repo: "safe-repo" });
    assert.equal(Object.hasOwn(definition, "workflowDefinition"), false);
    assert.equal(Object.hasOwn(definition, "validationGates"), false);
    assert.equal(Object.hasOwn(definition, "guardrails"), false);

    const run = await runtime.call("getWorkflowRun", {
        workflowRunId: "j-bob",
        scope: "fleet",
    }, admin);
    assert.equal(run.repository, "safe-repo");
    assert.equal(Object.hasOwn(run, "input"), false);
    assert.equal(Object.hasOwn(run, "effectiveConfig"), false);

    const [sessions, stateRuns, waits, journal] = await Promise.all([
        runtime.call("listWorkflowRunSessions", { workflowRunId: "j-bob", scope: "fleet" }, admin),
        runtime.call("listWorkflowRunStateRuns", { workflowRunId: "j-bob", scope: "fleet" }, admin),
        runtime.call("listWorkflowRunWaits", { workflowRunId: "j-bob", scope: "fleet" }, admin),
        runtime.call("listWorkflowRunJournal", { workflowRunId: "j-bob", scope: "fleet" }, admin),
    ]);
    assert.equal(Object.hasOwn(sessions[0], "error"), false);
    assert.equal(Object.hasOwn(stateRuns[0], "allowedOutcomes"), false);
    assert.equal(Object.hasOwn(stateRuns[0], "error"), false);
    assert.equal(Object.hasOwn(waits[0], "prompt"), false);
    assert.equal(Object.hasOwn(waits[0], "response"), false);
    assert.equal(Object.hasOwn(waits[0], "latestObservation"), false);
    assert.deepEqual(waits[0].predicate, { kind: "required_reviewers" });
    assert.equal(Object.hasOwn(journal[0], "summary"), false);
    assert.equal(Object.hasOwn(journal[0], "idempotencyKey"), false);

    assert.equal(
        JSON.stringify({ session, generator, definition, run, sessions, stateRuns, waits, journal })
            .includes(SENSITIVE),
        false,
    );
});

test.skip("legacy non-admin callers cannot request Workflow Run fleet detail projections", async () => {
    const { runtime } = createRuntime();
    for (const [method, params] of [
        ["getSession", { sessionId: "s-alice" }],
        ["getWorkflowGenerator", { workflowGeneratorId: "g-alice" }],
        ["getWorkflowDefinition", { workflowDefinitionId: "d-alice" }],
        ["getWorkflowRun", { workflowRunId: "j-alice" }],
        ["listWorkflowGeneratorRuns", { workflowGeneratorId: "g-alice" }],
        ["listWorkflowRunSessions", { workflowRunId: "j-alice" }],
        ["listWorkflowRunStateRuns", { workflowRunId: "j-alice" }],
        ["listWorkflowRunWaits", { workflowRunId: "j-alice" }],
        ["listWorkflowRunJournal", { workflowRunId: "j-alice" }],
    ]) {
        await assert.rejects(
            runtime.call(method, { ...params, scope: "fleet" }, alice),
            (error) => error.code === "FORBIDDEN" && error.status === 403,
            method,
        );
    }
});

test.skip("legacy WorkflowGenerators and Runs are private while Definitions remain authenticated-shared", async () => {
    const { runtime } = createRuntime();
    assert.equal((await runtime.call("getWorkflowGenerator", { workflowGeneratorId: "g-alice" }, alice)).workflowGeneratorId, "g-alice");
    await assert.rejects(
        runtime.call("getWorkflowGenerator", { workflowGeneratorId: "g-bob" }, alice),
        (error) => error.code === "NOT_FOUND",
    );
    assert.equal(
        (await runtime.call("getWorkflowDefinition", { workflowDefinitionId: "d-bob" }, alice))
            .workflowDefinitionId,
        "d-bob",
    );
    for (const method of [
        "getWorkflowRun",
        "listWorkflowRunSessions",
        "listWorkflowRunStateRuns",
        "listWorkflowRunWaits",
        "listWorkflowRunJournal",
    ]) {
        await assert.rejects(
            runtime.call(method, { workflowRunId: "j-bob" }, alice),
            (error) => error.code === "NOT_FOUND" && error.status === 404,
        );
    }
    await assert.rejects(
        runtime.call("setWorkflowRunWaitConditionOverride", {
            workflowRunId: "j-bob",
            waitId: "wait-1",
            conditionKey: "approved",
            overridden: true,
        }, alice),
        (error) => error.code === "NOT_FOUND" && error.status === 404,
    );
});

test.skip("legacy WorkflowRun state runs, waits, and journal are exposed for an owned WorkflowRun", async () => {
    const { runtime } = createRuntime();
    assert.deepEqual(
        await runtime.call("listWorkflowRunStateRuns", { workflowRunId: "j-alice" }, alice),
        [],
    );
    assert.deepEqual(
        await runtime.call("listWorkflowRunWaits", { workflowRunId: "j-alice" }, alice),
        [],
    );
    assert.deepEqual(
        await runtime.call("listWorkflowRunJournal", { workflowRunId: "j-alice" }, alice),
        [],
    );
    assert.deepEqual(
        await runtime.call("setWorkflowRunWaitConditionOverride", {
            workflowRunId: "j-alice",
            waitId: "wait-1",
            conditionKey: "approved",
            overridden: true,
        }, alice),
        {
            workflowRunId: "j-alice",
            waitId: "wait-1",
            conditionKey: "approved",
            overridden: true,
        },
    );
});

test.skip("legacy resource admins can inspect another requester's WorkflowRun details", async () => {
    const { runtime, calls } = createRuntime();
    assert.equal(
        (await runtime.call("getWorkflowRun", { workflowRunId: "j-bob" }, admin)).workflowRunId,
        "j-bob",
    );
    for (const method of [
        "listWorkflowRunSessions",
        "listWorkflowRunStateRuns",
        "listWorkflowRunWaits",
        "listWorkflowRunJournal",
    ]) {
        const rows = await runtime.call(method, { workflowRunId: "j-bob" }, admin);
        assert.equal(rows.length, 1);
        assert.equal(JSON.stringify(rows).includes(SENSITIVE), true);
        assert.equal(calls.some((call) => call.method === method && call.workflowRunId === "j-bob"), true);
    }
});

test("worker timeline forwards bounded filters for administrators", async () => {
    const { runtime, calls } = createRuntime();
    const result = await runtime.call("getWorkerTimeline", {
        workerNodeId: "pod-a",
        since: "2026-08-29T00:00:00.000Z",
        limit: 50,
    }, admin);

    assert.deepEqual(result, [{ timelineId: "event:1", workerNodeId: "pod-a" }]);
    assert.deepEqual(calls.find((call) => call.method === "getWorkerTimeline"), {
        method: "getWorkerTimeline",
        workerNodeId: "pod-a",
        options: {
            since: "2026-08-29T00:00:00.000Z",
            limit: 50,
        },
    });
});

test("publishing a Definition stamps the authenticated principal", async () => {
    const { runtime, calls } = createRuntime();
    const result = await runtime.call("createWorkflowDefinition", {
        workflowType: "FixBug",
        name: "Fix Bug",
        definition: {
            workflowDefinition: { states: {} },
            affinities: {},
            validationGates: [],
            guardrails: {},
        },
    }, alice);
    assert.equal(result.workflowDefinition.version, 1);
    const publish = calls.find((call) => call.method === "createWorkflowDefinition");
    assert.equal(publish.input.createdBy, "alice");
    assert.deepEqual(publish.input.owner, alice.principal);
});

test("WorkflowGenerator registration rejects malformed definition contracts", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("createWorkflowGenerator", {
            name: "Bad",
            cadenceSeconds: 300,
            workflowDefinitionId: "d-alice",
            source: { type: "../shell", config: {} },
        }, alice),
        (error) => error.code === "INVALID_REQUEST",
    );
});

test("WorkflowGenerator registration accepts an opaque source provider id", async () => {
    const { runtime, calls } = createRuntime();
    await runtime.call("createWorkflowGenerator", {
        name: "External source",
        cadenceSeconds: 300,
        workflowDefinitionId: "d-alice",
        source: {
            type: "vendor.items-v1",
            config: { filter: "active" },
        },
    }, alice);

    const create = calls.find((call) => call.method === "createWorkflowGenerator");
    assert.equal(create.input.sourceType, "vendor.items-v1");
});

test("owners can delete WorkflowGenerators idempotently while cross-owner callers see not found", async () => {
    const { runtime, calls } = createRuntime();

    const first = await runtime.call("deleteWorkflowGenerator", { workflowGeneratorId: "g-alice" }, alice);
    assert.equal(first.aggregateType, "generator");
    assert.equal(first.alreadyDeleted, false);

    const second = await runtime.call("deleteWorkflowGenerator", { workflowGeneratorId: "g-alice" }, alice);
    assert.equal(second.alreadyDeleted, true);

    await assert.rejects(
        runtime.call("deleteWorkflowGenerator", { workflowGeneratorId: "g-bob" }, alice),
        (error) => error.code === "NOT_FOUND",
    );
    await assert.rejects(
        runtime.call("deleteWorkflowGenerator", { workflowGeneratorId: "g-alice" }, bob),
        (error) => error.code === "NOT_FOUND",
    );

    const deletes = calls.filter((call) => call.method === "deleteWorkflowGenerator");
    assert.equal(deletes.length, 2);
    assert.deepEqual(deletes[0], {
        method: "deleteWorkflowGenerator",
        workflowGeneratorId: "g-alice",
        actor: alice.principal,
        isAdmin: false,
    });
});

test.skip("legacy WorkflowRun requesters can delete their Runs while cross-owner callers see not found", async () => {
    const { runtime, calls } = createRuntime();

    const ownerResult = await runtime.call("deleteWorkflowRun", { workflowRunId: "j-alice" }, alice);
    assert.equal(ownerResult.aggregateType, "workflowRun");
    assert.equal(ownerResult.alreadyDeleted, false);

    await assert.rejects(
        runtime.call("deleteWorkflowRun", { workflowRunId: "j-bob" }, alice),
        (error) => error.code === "NOT_FOUND" && error.status === 404,
    );
    const adminResult = await runtime.call("deleteWorkflowRun", { workflowRunId: "j-bob" }, admin);
    assert.equal(adminResult.aggregateId, "j-bob");
    assert.deepEqual(calls.filter((call) => call.method === "deleteWorkflowRun"), [
        {
            method: "deleteWorkflowRun",
            workflowRunId: "j-alice",
            actor: alice.principal,
            isAdmin: false,
        },
        {
            method: "deleteWorkflowRun",
            workflowRunId: "j-bob",
            actor: admin.principal,
            isAdmin: true,
        },
    ]);
});

test("trusted anonymous deployments use a synthetic cleanup actor", async () => {
    const { runtime, calls } = createRuntime();
    const anonymous = {
        principal: null,
        authorization: { allowed: true, role: "anonymous", reason: "no-auth", matchedGroups: [] },
    };

    await runtime.call("deleteWorkflowGenerator", { workflowGeneratorId: "g-alice" }, anonymous);

    const deletion = calls.find((call) => call.method === "deleteWorkflowGenerator");
    assert.deepEqual(deletion.actor, {
        provider: "anonymous",
        subject: "anonymous",
        email: null,
        displayName: "Anonymous",
    });
    assert.equal(deletion.isAdmin, true);
});
