import test from "node:test";
import assert from "node:assert/strict";
import {
    WorkflowGeneratorController as GeneratorController,
    PilotSwarmInitialSessionFactory,
} from "../dist/controller.js";
import { WorkflowRunInducer } from "../dist/run-inducer.js";
import { runWorkflowGenerator, runWorkflowGeneratorOnce } from "../dist/index.js";
import { compileLifecycleStateMachine } from "pilotswarm-sdk";

const now = new Date();

test("run-once drains every pending Workflow Run before scheduling waits", async () => {
    const calls = [];
    const remainingClaims = [2, 2, 1, 0];
    await runWorkflowGeneratorOnce({
        controller: {
            async runOnce() {
                calls.push("generator");
                return 1;
            },
        },
        runInducer: {
            async runOnce() {
                const claimed = remainingClaims.shift();
                calls.push(`inducer:${claimed}`);
                return claimed;
            },
        },
        waitScheduler: {
            async runOnce() {
                calls.push("waits");
                return 0;
            },
        },
    });

    assert.deepEqual(calls, [
        "generator",
        "inducer:2",
        "inducer:2",
        "inducer:1",
        "inducer:0",
        "waits",
    ]);
    assert.deepEqual(remainingClaims, []);
});

test("run-once stops draining after an induction batch makes no progress", async () => {
    const calls = [];
    await runWorkflowGeneratorOnce({
        controller: {
            async runOnce() {
                calls.push("generator");
                return 0;
            },
        },
        runInducer: {
            async runOnce() {
                calls.push("inducer");
                return 0;
            },
        },
        waitScheduler: {
            async runOnce() {
                calls.push("waits");
                return 0;
            },
        },
    });

    assert.deepEqual(calls, ["generator", "inducer", "waits"]);
});

test("controller runtime requires explicit compute placement", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousControllerCompute = process.env.WORKFLOW_GENERATOR_COMPUTE;
    process.env.DATABASE_URL = "postgres://unused";
    delete process.env.WORKFLOW_GENERATOR_COMPUTE;
    try {
        await assert.rejects(
            runWorkflowGenerator(),
            /WORKFLOW_GENERATOR_COMPUTE is required/,
        );
    } finally {
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
        if (previousControllerCompute === undefined) delete process.env.WORKFLOW_GENERATOR_COMPUTE;
        else process.env.WORKFLOW_GENERATOR_COMPUTE = previousControllerCompute;
    }
});

class WorkflowGeneratorController {
    constructor(options) {
        this.generator = new GeneratorController(options);
        this.inducer = options.induceSessions === false || !options.sessionFactory
            ? null
            : new WorkflowRunInducer(options);
    }

    async runOnce(signal) {
        const claimed = await this.generator.runOnce(signal);
        await this.inducer?.runOnce();
        return claimed;
    }

    async run(signal) {
        const induction = this.inducer?.run(signal);
        await this.generator.run(signal);
        await induction;
    }
}

function generator() {
    return {
        workflowGeneratorId: "generator-1",
        name: "test",
        owner: { provider: "test", subject: "owner" },
        controllerComputeAffinity: null,
        cadenceSeconds: 60,
        sourceType: "ado_wiql",
        sourceConfig: {},
        operationalState: "enabled",
        activeDefinitionId: "definition-1",
        nextRunAt: now,
        watermark: null,
        totalCycles: 0,
        successfulCycles: 0,
        failedCycles: 0,
        materializedWorkflowRuns: 0,
        lastCycleAt: null,
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
    };
}

function definition() {
    return {
        workflowDefinitionId: "definition-1",
        workflowType: "test",
        name: "Test",
        owner: generator().owner,
        version: 1,
        definitionHash: "definition-hash",
        sessionComputeAffinity: null,
        workflowDefinition: {},
        affinities: {},
        validationGates: [],
        guardrails: {},
        createdBy: null,
        createdAt: now,
    };
}

function executionAffinity(subject = "owner") {
    return {
        provider: "test",
        subject,
        email: `${subject}@example.test`,
        displayName: subject,
    };
}

function lifecycleStateRun(overrides = {}) {
    return {
        stateRunId: "state-run-1",
        workflowRunId: "workflowRun-1",
        workflowDefinitionId: "definition-1",
        stateName: "Diagnosed",
        stateRevision: 1,
        stateOwner: null,
        status: "reserved",
        sessionId: "session-1",
        predecessorJournalEntryId: null,
        sourceId: null,
        sourcePath: null,
        sourceCommit: null,
        markdownSha256: null,
        allowedOutcomes: [],
        terminal: null,
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

class FakeStore {
    workflowRuns = new Map();
    sessions = new Map();
    cycles = [];
    activeDefinitionId = "definition-1";
    sourceType = "ado_wiql";
    sourceConfig = {};
    nextCycle = 1;
    nextSession = 1;

    async claimDueWorkflowGenerators() {
        return [{
            ...generator(),
            sourceType: this.sourceType,
            sourceConfig: this.sourceConfig,
        }];
    }

    async beginWorkflowGeneratorCycle() {
        return {
            cycle: {
                cycleId: `cycle-${this.nextCycle++}`,
                workflowGeneratorId: "generator-1",
                workflowDefinitionId: this.activeDefinitionId,
                status: "running",
                claimedBy: "worker",
                watermarkBefore: null,
                watermarkAfter: null,
                discoveredCount: 0,
                createdCount: 0,
                error: null,
                startedAt: now,
                completedAt: null,
            },
            definition: {
                ...definition(),
                workflowDefinitionId: this.activeDefinitionId,
                sourceType: this.sourceType,
                sourceConfig: this.sourceConfig,
            },
        };
    }
    async reconcileWorkflowGeneratorDiscoveries(cycleId, discoveries) {
        return discoveries.map(({ key, payload }) => {
            let workflowRun = this.workflowRuns.get(key);
            const created = !workflowRun;
            if (!workflowRun) {
                workflowRun = {
                    workflowRunId: `workflowRun-${this.workflowRuns.size + 1}`,
                    workflowGeneratorId: "generator-1",
                    workflowDefinitionId: this.activeDefinitionId,
                    workflowRunKey: key,
                    input: payload,
                    lifecycleState: "pending_session",
                    currentState: "Initial",
                    stateRevision: 1,
                    currentStateEnteredAt: now,
                    firstSeenCycleId: cycleId,
                    lastSeenCycleId: cycleId,
                    firstDiscoveredAt: now,
                    lastDiscoveredAt: now,
                    sessionAttempts: 0,
                    sessionError: null,
                    createdAt: now,
                    updatedAt: now,
                };
                this.workflowRuns.set(key, workflowRun);
            }
            workflowRun.lastSeenCycleId = cycleId;
            return { ...workflowRun, created, needsSession: !this.sessions.has(workflowRun.workflowRunId) };
        });
    }
    async reserveWorkflowRunSession(workflowRunId) {
        const existing = this.sessions.get(workflowRunId)?.find((entry) => entry.isCurrent);
        if (existing) return existing;
        const association = {
            associationId: `association-${this.nextSession}`,
            workflowRunId,
            sessionId: `session-${this.nextSession++}`,
            ordinal: 1,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        };
        this.sessions.set(workflowRunId, [association]);
        return association;
    }
    async listWorkflowRunSessions(workflowRunId) {
        return this.sessions.get(workflowRunId) ?? [];
    }
    async listWorkflowRunsNeedingSession() {
        return [...this.workflowRuns.values()].filter((workflowRun) => {
            const current = this.sessions.get(workflowRun.workflowRunId)?.find((entry) => entry.isCurrent);
            return current?.status !== "unacked" && current?.status !== "active";
        });
    }
    async claimWorkflowRunsForInduction() {
        const claims = [];
        for (const workflowRun of await this.listWorkflowRunsNeedingSession()) {
            if (workflowRun.lifecycleState === "completed" || workflowRun.lifecycleState === "cancelled") continue;
            const association = await this.reserveWorkflowRunSession(workflowRun.workflowRunId);
            claims.push({
                workflowRun: { ...workflowRun },
                definition: await this.getWorkflowDefinition(workflowRun.workflowDefinitionId),
                association,
                executionAffinity: generator().owner,
            });
        }
        return claims;
    }
    async getWorkflowRun(workflowRunId) {
        return [...this.workflowRuns.values()].find((workflowRun) => workflowRun.workflowRunId === workflowRunId) ?? null;
    }
    async getWorkflowDefinition(workflowDefinitionId) {
        return { ...definition(), workflowDefinitionId };
    }
    async attachWorkflowRunSession(workflowRunId, sessionId) {
        const current = this.sessions.get(workflowRunId).find((entry) => entry.sessionId === sessionId);
        current.status = "unacked";
        current.attachedAt = now;
    }
    async failWorkflowRunSession(workflowRunId, sessionId, _cycleId, _workerId, error) {
        const current = this.sessions.get(workflowRunId).find((entry) => entry.sessionId === sessionId);
        current.status = "failed";
        current.error = error;
    }
    async completeWorkflowGeneratorCycle(input) {
        this.cycles.push(input);
    }
    replace(workflowRunId, sessionId) {
        const history = this.sessions.get(workflowRunId);
        const current = history.find((entry) => entry.isCurrent);
        current.isCurrent = false;
        current.status = "replaced";
        const next = {
            ...current,
            associationId: `association-${history.length + 1}`,
            sessionId,
            ordinal: history.length + 1,
            isCurrent: true,
            status: "active",
        };
        history.push(next);
        return next;
    }
}

function evaluator() {
    return {
        type: "ado_wiql",
        async evaluate() {
            return { discoveries: [{ key: "stable-1", payload: { id: 1 } }], watermark: "next" };
        },
    };
}

test("direct WorkflowRuns are induced without a WorkflowGenerator cycle", async () => {
    const workflowRun = {
        workflowRunId: "workflowRun-direct",
        workflowDefinitionId: "definition-direct",
        owner: { provider: "test", subject: "direct-owner" },
        effectiveConfig: {},
        workflowRunKey: "direct-1",
        input: { id: 1 },
        lifecycleState: "pending_session",
        currentState: "Initial",
        stateRevision: 1,
    };
    const directDefinition = {
        ...definition(),
        workflowDefinitionId: "definition-direct",
        owner: workflowRun.owner,
        name: "Direct workflow",
    };
    const association = {
        associationId: "association-direct",
        workflowRunId: workflowRun.workflowRunId,
        sessionId: "session-direct",
        stateRunId: "state-run-direct",
        ordinal: 1,
        isCurrent: true,
        status: "reserved",
        error: null,
        reservedAt: now,
        attachedAt: null,
        endedAt: null,
    };
    let claimed = false;
    const attachments = [];
    const store = {
        async claimDueWorkflowGenerators() { return []; },
        async claimWorkflowRunsForInduction() {
            if (claimed) return [];
            claimed = true;
            return [{
                workflowRun,
                definition: directDefinition,
                association,
                executionAffinity: executionAffinity("direct-requester"),
            }];
        },
        async attachWorkflowRunSession(...args) { attachments.push(args); },
        async failWorkflowRunSession() { assert.fail("induction should not fail"); },
    };
    const created = [];
    const inducer = new WorkflowRunInducer({
        store,
        sessionFactory: {
            async createInitialSession(input) {
                created.push(input);
                await input.onSessionCreated?.();
            },
            async deleteInitialSession() { assert.fail("session should not be deleted"); },
        },
        workerId: "inducer-1",
    });

    assert.equal(await inducer.runOnce(), 1);
    assert.equal(created.length, 1);
    assert.equal(Object.hasOwn(created[0].workflowRun, "workflowGeneratorId"), false);
    assert.deepEqual(created[0].workflowRun.owner, workflowRun.owner);
    assert.deepEqual(created[0].executionAffinity, executionAffinity("direct-requester"));
    assert.deepEqual(attachments, [
        [workflowRun.workflowRunId, association.sessionId, null, "inducer-1"],
        [workflowRun.workflowRunId, association.sessionId, null, "inducer-1"],
    ]);
});

test("repeated reconciliation creates one WorkflowRun and one initial session", async () => {
    const store = new FakeStore();
    const createdSessions = [];
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ association }) {
                createdSessions.push(association.sessionId);
            },
        },
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    await controller.runOnce();
    assert.equal(store.workflowRuns.size, 1);
    assert.deepEqual(createdSessions, ["session-1"]);
    assert.equal(store.sessions.get("workflowRun-1").length, 1);
    assert.deepEqual(store.cycles.map((cycle) => cycle.createdCount), [1, 0]);
});

test("registered provider discoveries materialize stable-keyed WorkflowRuns and empty results stay healthy", async () => {
    const store = new FakeStore();
    store.sourceType = "external-items";
    store.sourceConfig = { filter: "active" };
    let evaluation = 0;
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["external-items", {
            type: "external-items",
            async evaluate() {
                evaluation += 1;
                return {
                    discoveries: evaluation === 1
                        ? [{ key: "item-123", payload: { id: "item-123" } }]
                        : [],
                };
            },
        }]]),
        induceSessions: false,
        workerId: "external-provider-worker",
        logger: { info() {}, warn() {}, error() {} },
    });

    await controller.runOnce();
    await controller.runOnce();

    assert.deepEqual([...store.workflowRuns.keys()], ["item-123"]);
    assert.deepEqual(store.cycles.map((cycle) => ({
        status: cycle.status,
        discoveredCount: cycle.discoveredCount,
        createdCount: cycle.createdCount,
    })), [
        { status: "succeeded", discoveredCount: 1, createdCount: 1 },
        { status: "succeeded", discoveredCount: 0, createdCount: 0 },
    ]);
});

test("a bootstrapped session is deleted when the post-send attachment fence fails", async () => {
    const store = new FakeStore();
    const attachWorkflowRunSession = store.attachWorkflowRunSession.bind(store);
    let attachCalls = 0;
    store.attachWorkflowRunSession = async (...args) => {
        attachCalls += 1;
        if (attachCalls === 2) {
            throw new Error("WorkflowGenerator cycle is no longer active");
        }
        return attachWorkflowRunSession(...args);
    };
    const createdSessions = [];
    const deletedSessions = [];
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ association, onSessionCreated }) {
                createdSessions.push(association.sessionId);
                await onSessionCreated();
            },
            async deleteInitialSession(sessionId, reason) {
                deletedSessions.push({ sessionId, reason });
            },
        },
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });

    await controller.runOnce();

    assert.deepEqual(createdSessions, ["session-1"]);
    assert.equal(attachCalls, 2);
    assert.deepEqual(deletedSessions, [{
        sessionId: "session-1",
        reason: "Initial session induction failed: WorkflowGenerator cycle is no longer active",
    }]);
});

test("a stale controller does not delete a session after losing the durable failure fence", async () => {
    const store = new FakeStore();
    const attachWorkflowRunSession = store.attachWorkflowRunSession.bind(store);
    let attachCalls = 0;
    store.attachWorkflowRunSession = async (...args) => {
        attachCalls += 1;
        if (attachCalls === 2) throw new Error("WorkflowGenerator cycle is no longer active");
        return attachWorkflowRunSession(...args);
    };
    store.failWorkflowRunSession = async () => {
        throw new Error("WorkflowGenerator lease is stale");
    };
    const deletedSessions = [];
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ onSessionCreated }) {
                await onSessionCreated();
            },
            async deleteInitialSession(sessionId) {
                deletedSessions.push(sessionId);
            },
        },
        workerId: "stale-worker",
        logger: { info() {}, warn() {}, error() {} },
    });

    await controller.runOnce();

    assert.equal(attachCalls, 2);
    assert.deepEqual(deletedSessions, []);
});

test("induced Session owner affinity depends only on Definition compute placement", async () => {
    const creates = [];
    const sends = [];
    const lifecycleOrder = [];
    const factory = new PilotSwarmInitialSessionFactory({
        async createSession(config) {
            creates.push(config);
            lifecycleOrder.push("created");
            return {
                async send(prompt, options) {
                    sends.push({ prompt, options });
                    lifecycleOrder.push("sent");
                },
            };
        },
    });
    const association = {
        associationId: "association-owned",
        workflowRunId: "workflow-run-owned",
        sessionId: "session-owned",
        ordinal: 1,
        isCurrent: true,
        status: "reserved",
        error: null,
        reservedAt: now,
        attachedAt: null,
        endedAt: null,
    };
    const ownedDefinition = {
        ...definition(),
        workflowDefinition: {
            initialPrompt: "Handle {workflowRun.key}",
            session: { repo: " Sample-Repo ", gitRef: "main" },
        },
        affinities: { user: "spoofed-user" },
    };
    const workflowRun = {
        workflowRunId: "workflow-run-owned",
        workflowGeneratorId: "generator-1",
        workflowDefinitionId: "definition-1",
        owner: { provider: "system", subject: "system", email: null, displayName: "System" },
        workflowRunKey: "owned-1",
        input: { id: 1 },
        lifecycleState: "pending_session",
        currentState: "Initial",
        stateRevision: 1,
        currentStateEnteredAt: now,
        firstSeenCycleId: "cycle-1",
        lastSeenCycleId: "cycle-1",
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
        sessionAttempts: 0,
        sessionError: null,
        createdAt: now,
        updatedAt: now,
    };

    await factory.createInitialSession({
        definition: ownedDefinition,
        workflowRun,
        association,
        executionAffinity: executionAffinity("run-requester"),
        onSessionCreated: async () => {
            lifecycleOrder.push("attached");
        },
    });

    assert.equal(creates.length, 1);
    assert.deepEqual(workflowRun.owner, {
        provider: "system",
        subject: "system",
        email: null,
        displayName: "System",
    });
    assert.deepEqual(creates[0].owner, workflowRun.owner);
    assert.equal(creates[0].requireOwnerAffinity, false);
    assert.equal(creates[0].repo, "sample-repo");
    assert.equal(creates[0].gitRef, "main");
    assert.equal("userAffinity" in creates[0], false);
    assert.equal(sends.length, 1);
    assert.deepEqual(lifecycleOrder, ["created", "attached", "sent"]);

    creates.length = 0;
    await factory.createInitialSession({
        definition: { ...ownedDefinition, sessionComputeAffinity: "devbox" },
        workflowRun,
        association,
        executionAffinity: executionAffinity("run-requester"),
    });
    assert.deepEqual(creates[0].owner, executionAffinity("run-requester"));
    assert.equal(creates[0].requireOwnerAffinity, true);

    creates.length = 0;
    await factory.createInitialSession({
        definition: { ...ownedDefinition, sessionComputeAffinity: "cluster" },
        workflowRun,
        association,
        executionAffinity: executionAffinity("run-requester"),
    });
    assert.deepEqual(creates[0].owner, workflowRun.owner);
    assert.equal(creates[0].requireOwnerAffinity, false);
});

test("induced Sessions qualify bare Definition models from the controller catalog", async () => {
    let created;
    const factory = new PilotSwarmInitialSessionFactory({
        async createSession(config) {
            created = config;
            return { async send() {} };
        },
    }, undefined, {
        normalize(model) {
            return model === "gpt-5.4" ? "azure-foundry:gpt-5.4" : undefined;
        },
    });
    const workflowRun = {
        workflowRunId: "workflow-run-model",
        workflowGeneratorId: "generator-1",
        workflowDefinitionId: "definition-1",
        owner: { provider: "system", subject: "system", email: null, displayName: "System" },
        workflowRunKey: "model-1",
        input: { id: 1 },
        lifecycleState: "pending_session",
        currentState: "Initial",
        stateRevision: 1,
        currentStateEnteredAt: now,
        firstSeenCycleId: "cycle-1",
        lastSeenCycleId: "cycle-1",
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
        sessionAttempts: 0,
        sessionError: null,
        createdAt: now,
        updatedAt: now,
    };

    await factory.createInitialSession({
        definition: {
            ...definition(),
            workflowDefinition: {
                initialPrompt: "Handle {workflowRun.key}",
                session: { model: "gpt-5.4" },
            },
        },
        workflowRun,
        association: {
            associationId: "association-model",
            workflowRunId: workflowRun.workflowRunId,
            sessionId: "session-model",
            ordinal: 1,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        },
        executionAffinity: executionAffinity("run-requester"),
    });

    assert.equal(created.model, "azure-foundry:gpt-5.4");
});

test("controller compute is passed into the locked generator claim", async () => {
    const store = new FakeStore();
    let claimArguments;
    store.claimDueWorkflowGenerators = async (...args) => {
        claimArguments = args;
        return [];
    };
    const controller = new GeneratorController({
        store,
        evaluators: new Map(),
        controllerCompute: "devbox",
        workerId: "devbox-controller",
        logger: { info() {}, warn() {}, error() {} },
    });

    await controller.runOnce();

    assert.deepEqual(claimArguments, ["devbox-controller", 10, 300, "devbox"]);
});

test("materialization-only mode does not reserve sessions when explicitly selected", async () => {
    const store = new FakeStore();
    const messages = [];
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        induceSessions: false,
        workerId: "worker",
        logger: { info(message) { messages.push(message); }, warn() {}, error() {} },
    });
    await controller.runOnce();
    assert.equal(store.workflowRuns.size, 1);
    assert.equal(store.sessions.size, 0);
    assert.ok(messages.some((message) => message === "[workflow-generator] poll claimed=1"));
    assert.ok(messages.some((message) => message.includes("evaluating source=ado_wiql")));
    assert.deepEqual(store.cycles.map((cycle) => ({
        status: cycle.status,
        discoveredCount: cycle.discoveredCount,
        createdCount: cycle.createdCount,
    })), [{ status: "succeeded", discoveredCount: 1, createdCount: 1 }]);
});

test("session failure retries the reserved session without duplicating the WorkflowRun", async () => {
    const store = new FakeStore();
    const attempted = [];
    let fail = true;
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ association }) {
                attempted.push(association.sessionId);
                if (fail) {
                    fail = false;
                    throw new Error("session API unavailable");
                }
            },
        },
        induceSessions: true,
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    await controller.runOnce();
    assert.equal(store.workflowRuns.size, 1);
    assert.deepEqual(attempted, ["session-1", "session-1"]);
    assert.equal(store.sessions.get("workflowRun-1").length, 1);
    assert.equal(store.sessions.get("workflowRun-1")[0].status, "unacked");
    assert.deepEqual(store.cycles.map((cycle) => cycle.status), ["succeeded", "succeeded"]);
});

test("session failure retries even when the source no longer returns the WorkflowRun", async () => {
    const store = new FakeStore();
    let evaluation = 0;
    let attempts = 0;
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", {
            type: "ado_wiql",
            async evaluate() {
                evaluation += 1;
                return {
                    discoveries: evaluation === 1 ? [{ key: "stable-1", payload: { id: 1 } }] : [],
                };
            },
        }]]),
        sessionFactory: {
            async createInitialSession() {
                attempts += 1;
                if (attempts === 1) throw new Error("session API unavailable");
            },
        },
        induceSessions: true,
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    await controller.runOnce();
    assert.equal(attempts, 2);
    assert.equal(store.workflowRuns.size, 1);
    assert.equal(store.sessions.get("workflowRun-1")[0].status, "unacked");
});

test("session retry uses the WorkflowRun's pinned definition after a new version is activated", async () => {
    const store = new FakeStore();
    const attemptedDefinitions = [];
    let fail = true;
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ definition: workflowDefinition }) {
                attemptedDefinitions.push(workflowDefinition.workflowDefinitionId);
                if (fail) {
                    fail = false;
                    throw new Error("session API unavailable");
                }
            },
        },
        induceSessions: true,
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    store.activeDefinitionId = "definition-2";
    await controller.runOnce();
    assert.deepEqual(attemptedDefinitions, ["definition-1", "definition-1"]);
    assert.equal(store.workflowRuns.get("stable-1").workflowDefinitionId, "definition-1");
});

test("session induction refreshes a WorkflowRun that advances after the cycle snapshot", async () => {
    const store = new FakeStore();
    const createdSessions = [];
    const originalReserve = store.reserveWorkflowRunSession.bind(store);
    store.reserveWorkflowRunSession = async (...args) => {
        const association = await originalReserve(...args);
        const current = store.workflowRuns.get("stable-1");
        Object.assign(current, {
            currentState: "Diagnosed",
            stateRevision: 2,
            lifecycleState: "pending_session",
        });
        return association;
    };
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ workflowRun }) {
                createdSessions.push({
                    currentState: workflowRun.currentState,
                    stateRevision: workflowRun.stateRevision,
                });
            },
        },
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });

    await controller.runOnce();

    assert.deepEqual(createdSessions, [{
        currentState: "Diagnosed",
        stateRevision: 2,
    }]);
});

test("WorkflowRun identity survives replacement while prior sessions remain history", async () => {
    const store = new FakeStore();
    const association = await store.reserveWorkflowRunSession("workflowRun-1");
    await store.attachWorkflowRunSession("workflowRun-1", association.sessionId);
    store.replace("workflowRun-1", "session-2");
    const history = await store.listWorkflowRunSessions("workflowRun-1");
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((entry) => entry.sessionId), ["session-1", "session-2"]);
    assert.equal(history.filter((entry) => entry.isCurrent).length, 1);
    assert.equal(history[0].status, "replaced");
});

test("continuous mode retries after a transient claim failure", async () => {
    const store = new FakeStore();
    const errors = [];
    const abort = new AbortController();
    let attempts = 0;
    store.claimDueWorkflowGenerators = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database temporarily unavailable");
        abort.abort();
        return [];
    };
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map(),
        induceSessions: false,
        pollIntervalMs: 1,
        logger: { info() {}, warn() {}, error(...args) { errors.push(args); } },
    });

    await controller.run(abort.signal);

    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /polling failed/);
});

test("continuous mode cancels an in-flight provider evaluation on shutdown", async () => {
    const store = new FakeStore();
    const abort = new AbortController();
    let evaluationSignal;
    let markStarted;
    const started = new Promise((resolve) => {
        markStarted = resolve;
    });
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", {
            type: "ado_wiql",
            async evaluate(context) {
                evaluationSignal = context.signal;
                markStarted();
                return await new Promise((_resolve, reject) => {
                    context.signal.addEventListener(
                        "abort",
                        () => reject(new Error("controller stopping")),
                        { once: true },
                    );
                });
            },
        }]]),
        induceSessions: false,
        pollIntervalMs: 1,
        logger: { info() {}, warn() {}, error() {} },
    });

    const run = controller.run(abort.signal);
    await started;
    abort.abort();
    await run;

    assert.equal(evaluationSignal, abort.signal);
    assert.equal(store.cycles.at(-1).status, "failed");
    assert.match(store.cycles.at(-1).error, /controller stopping/);
});

test("a claimed batch starts together so later generators retain their leases", async () => {
    const store = new FakeStore();
    store.claimDueWorkflowGenerators = async () => [
        { ...generator(), workflowGeneratorId: "generator-1", name: "first" },
        { ...generator(), workflowGeneratorId: "generator-2", name: "second" },
    ];
    let startedCount = 0;
    let markAllStarted;
    const allStarted = new Promise((resolve) => {
        markAllStarted = resolve;
    });
    let releaseEvaluations;
    const evaluationsReleased = new Promise((resolve) => {
        releaseEvaluations = resolve;
    });
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", {
            type: "ado_wiql",
            async evaluate() {
                startedCount += 1;
                if (startedCount === 2) markAllStarted();
                await evaluationsReleased;
                return { discoveries: [] };
            },
        }]]),
        induceSessions: false,
        logger: { info() {}, warn() {}, error() {} },
    });

    const run = controller.runOnce();
    await allStarted;
    assert.equal(startedCount, 2);
    releaseEvaluations();
    assert.equal(await run, 2);
});

test("controller rejects invalid continuous-loop settings", () => {
    const store = new FakeStore();
    assert.throws(
        () => new WorkflowGeneratorController({
            store,
            evaluators: new Map(),
            induceSessions: false,
            pollIntervalMs: 0,
        }),
        /pollIntervalMs must be a positive integer/,
    );
});

test("rediscovered terminal WorkflowRuns are not reserved again", async () => {
    const store = new FakeStore();
    store.reconcileWorkflowGeneratorDiscoveries = async () => [{
        ...{
            workflowRunId: "workflowRun-completed",
            workflowGeneratorId: "generator-1",
            workflowDefinitionId: "definition-1",
            workflowRunKey: "stable-1",
            input: { id: 1 },
            lifecycleState: "completed",
            currentState: "Done",
            stateRevision: 2,
            currentStateEnteredAt: now,
            firstSeenCycleId: "cycle-1",
            lastSeenCycleId: "cycle-1",
            firstDiscoveredAt: now,
            lastDiscoveredAt: now,
            sessionAttempts: 1,
            sessionError: null,
            createdAt: now,
            updatedAt: now,
        },
        created: false,
        needsSession: false,
    }];
    store.listWorkflowRunsNeedingSession = async () => [];
    store.reserveWorkflowRunSession = async () => {
        throw new Error("terminal WorkflowRun must not be reserved");
    };
    const controller = new WorkflowGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession() {
                throw new Error("terminal WorkflowRun must not create a session");
            },
        },
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });

    await controller.runOnce();
    assert.equal(store.cycles[0].status, "succeeded");
});

test("lifecycle session loads exact state Markdown, journal, and completion tool", async () => {
    const created = [];
    const sent = [];
    const prepared = [];
    const client = {
        async createSession(config) {
            created.push(config);
            return {
                async send(prompt, options) {
                    sent.push({ prompt, options });
                },
            };
        },
    };
    const factory = new PilotSwarmInitialSessionFactory(client, {
        reader: {
            async readStateMarkdown(source, sourcePath) {
                if (source.sourceId !== "user-lifecycle") return null;
                assert.equal(sourcePath, "automation/Example.Diagnosed.md");
                return [
                    "# Diagnose",
                    "",
                    "Use the repository evidence.",
                    "",
                    "## Possible next states",
                    "- [Fixed](./Example.Fixed.md)",
                ].join("\n");
            },
        },
        store: {
            async listWorkflowRunJournal(workflowRunId) {
                assert.equal(workflowRunId, "workflowRun-1");
                return [{
                    sequence: 1,
                    fromState: "Initial",
                    toState: "Diagnosed",
                    outcome: "Diagnosed",
                    sessionId: "session-previous",
                    summary: "Collected the failing query and logs.",
                }];
            },
            async listWorkflowRunStateRuns(workflowRunId) {
                assert.equal(workflowRunId, "workflowRun-1");
                return [lifecycleStateRun({
                    stateRunId: "state-run-2",
                    stateRevision: 2,
                    sessionId: "session-2",
                })];
            },
            async prepareWorkflowRunStateRun(input) {
                prepared.push(input);
                return {};
            },
        },
    });

    await factory.createInitialSession({
        generator: generator(),
        executionAffinity: executionAffinity(),
        definition: {
            ...definition(),
            workflowDefinition: {
                name: "Example",
                initialState: "Initial",
                sources: [{
                    sourceId: "user-lifecycle",
                    owner: "user",
                    filePrefix: "Example",
                    basePath: "automation",
                    repositoryUrl: "https://github.com/example/repository",
                    resolvedCommit: "abc123",
                }],
                session: { toolNames: ["read_file"] },
            },
        },
        workflowRun: {
            workflowRunId: "workflowRun-1",
            workflowGeneratorId: "generator-1",
            workflowDefinitionId: "definition-1",
            workflowRunKey: "source-42",
            input: { id: 42 },
            lifecycleState: "pending_session",
            currentState: "Diagnosed",
            stateRevision: 2,
            currentStateEnteredAt: now,
            firstSeenCycleId: "cycle-1",
            lastSeenCycleId: "cycle-1",
            firstDiscoveredAt: now,
            lastDiscoveredAt: now,
            sessionAttempts: 1,
            sessionError: null,
            createdAt: now,
            updatedAt: now,
        },
        association: {
            associationId: "association-1",
            workflowRunId: "workflowRun-1",
            sessionId: "session-2",
            stateRunId: "state-run-2",
            ordinal: 2,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        },
    });

    assert.deepEqual(created[0].toolNames, [
        "read_file",
        "read_workflow_run_source_session",
        "start_external_operation",
        "get_external_operation",
        "complete_state",
    ]);
    assert.equal(prepared[0].sessionId, "session-2");
    assert.equal(prepared[0].sourcePath, "automation/Example.Diagnosed.md");
    assert.deepEqual(prepared[0].allowedOutcomes, [{ outcome: "Fixed", toState: "Fixed" }]);
    assert.equal(prepared[0].terminal, false);
    assert.match(sent[0].prompt, /Collected the failing query and logs/);
    assert.match(sent[0].prompt, /call read_workflow_run_source_session with its Session ID/);
    assert.match(sent[0].prompt, /instead of creating a duplicate/);
    assert.match(sent[0].prompt, /For a human decision, call ask_user/);
    assert.match(sent[0].prompt, /call system_wait with the exact signalKey/);
    assert.match(sent[0].prompt, /preserve the outcome, evidence, durable identifiers or references/);
    assert.match(sent[0].prompt, /Use the repository evidence/);
    assert.match(sent[0].prompt, /Allowed outcomes: Fixed/);
    assert.deepEqual(sent[0].options.clientMessageIds, ["workflow-generator:workflowRun-1:state:2"]);
});

test("published state-machine snapshot survives source changes, session replacement, and later states", async () => {
    const prepared = [];
    const resolvedCommits = [];
    const readCommits = [];
    let latestCommit = "commit-one";
    const lifecycleReader = {
        async resolveSourceCommit(source) {
            resolvedCommits.push(source.requestedRef);
            return latestCommit;
        },
        async readStateMarkdown(source, sourcePath) {
            readCommits.push([source.resolvedCommit, sourcePath]);
            return sourcePath.endsWith(".Diagnosed.md")
                ? [
                    "# Diagnose",
                    "",
                    "## Possible next states",
                    "- [Fixed](./Example.Fixed.md)",
                ].join("\n")
                : "# Fixed\n\nDelivery is complete.\n";
        },
    };
    const stateMachineSnapshot = await compileLifecycleStateMachine({
        lifecycleName: "Example",
        initialState: "Diagnosed",
        sources: [{
            sourceId: "user-lifecycle",
            owner: "user",
            filePrefix: "Example",
            repositoryUrl: "https://github.com/example/repository",
            requestedRef: "main",
            resolvedCommit: "stale-definition-commit",
        }],
        reader: lifecycleReader,
    });
    const runs = [
        lifecycleStateRun(),
        lifecycleStateRun({
            stateRunId: "state-run-2",
            stateName: "Fixed",
            stateRevision: 2,
            sessionId: "session-2",
        }),
    ];
    const factory = new PilotSwarmInitialSessionFactory({
        async createSession() {
            return {
                async send() {},
            };
        },
    }, {
        reader: {
            async resolveSourceCommit() {
                throw new Error("published lifecycle snapshot must not resolve source refs during execution");
            },
            async readStateMarkdown() {
                throw new Error("published lifecycle snapshot must not read source Markdown during execution");
            },
        },
        store: {
            async listWorkflowRunJournal() {
                return [];
            },
            async listWorkflowRunStateRuns() {
                return runs;
            },
            async prepareWorkflowRunStateRun(input) {
                prepared.push(input);
                const run = runs.find((candidate) => candidate.stateRevision === input.expectedRevision);
                Object.assign(run, {
                    stateOwner: input.stateOwner,
                    sourceId: input.sourceId,
                    sourcePath: input.sourcePath,
                    sourceCommit: input.sourceCommit,
                    markdownSha256: input.markdownSha256,
                    allowedOutcomes: input.allowedOutcomes,
                    terminal: input.terminal,
                });
                return run;
            },
        },
    });
    const workflowDefinition = {
        name: "Example",
        initialState: "Diagnosed",
        sources: [{
            sourceId: "user-lifecycle",
            owner: "user",
            filePrefix: "Example",
            repositoryUrl: "https://github.com/example/repository",
            requestedRef: "main",
            resolvedCommit: "stale-definition-commit",
        }],
        stateMachineSnapshot,
    };
    const baseWorkflowRun = {
        workflowRunId: "workflowRun-1",
        workflowGeneratorId: "generator-1",
        workflowDefinitionId: "definition-1",
        workflowRunKey: "source-42",
        input: { id: 42 },
        lifecycleState: "pending_session",
        currentState: "Diagnosed",
        stateRevision: 1,
        currentStateEnteredAt: now,
        firstSeenCycleId: "cycle-1",
        lastSeenCycleId: "cycle-1",
        firstDiscoveredAt: now,
        lastDiscoveredAt: now,
        sessionAttempts: 1,
        sessionError: null,
        createdAt: now,
        updatedAt: now,
    };
    const definitionWithLifecycle = {
        ...definition(),
        workflowDefinition,
    };

    await factory.createInitialSession({
        generator: generator(),
        executionAffinity: executionAffinity(),
        definition: definitionWithLifecycle,
        workflowRun: baseWorkflowRun,
        association: {
            associationId: "association-1",
            workflowRunId: "workflowRun-1",
            sessionId: "session-1",
            stateRunId: "state-run-1",
            ordinal: 1,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        },
    });

    // Source changes after publication do not affect same-session resume.
    latestCommit = "commit-two";
    await factory.createInitialSession({
        generator: generator(),
        executionAffinity: executionAffinity(),
        definition: definitionWithLifecycle,
        workflowRun: baseWorkflowRun,
        association: {
            associationId: "association-1",
            workflowRunId: "workflowRun-1",
            sessionId: "session-1",
            stateRunId: "state-run-1",
            ordinal: 1,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        },
    });

    // A new session takes over the state run after its per-attempt preparation is
    // cleared. The published state-machine snapshot remains authoritative.
    const reactivatedRun = runs.find((candidate) => candidate.stateRunId === "state-run-1");
    Object.assign(reactivatedRun, {
        stateOwner: null,
        sourceId: null,
        sourcePath: null,
        sourceCommit: null,
        markdownSha256: null,
        allowedOutcomes: [],
        terminal: null,
    });
    await factory.createInitialSession({
        generator: generator(),
        executionAffinity: executionAffinity(),
        definition: definitionWithLifecycle,
        workflowRun: baseWorkflowRun,
        association: {
            associationId: "association-1-replacement",
            workflowRunId: "workflowRun-1",
            sessionId: "session-1-replacement",
            stateRunId: "state-run-1",
            ordinal: 2,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        },
    });
    await factory.createInitialSession({
        generator: generator(),
        executionAffinity: executionAffinity(),
        definition: definitionWithLifecycle,
        workflowRun: {
            ...baseWorkflowRun,
            currentState: "Fixed",
            stateRevision: 2,
        },
        association: {
            associationId: "association-2",
            workflowRunId: "workflowRun-1",
            sessionId: "session-2",
            stateRunId: "state-run-2",
            ordinal: 3,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        },
    });

    assert.equal(latestCommit, "commit-two");
    assert.deepEqual(resolvedCommits, ["main"]);
    assert.deepEqual(readCommits, [
        ["commit-one", "Example.Diagnosed.md"],
        ["commit-one", "Example.Fixed.md"],
    ]);
    assert.deepEqual(
        prepared.map((entry) => entry.sourceCommit),
        ["commit-one", "commit-one", "commit-one", "commit-one"],
    );
    assert.deepEqual(prepared[1].allowedOutcomes, [{ outcome: "Fixed", toState: "Fixed" }]);
    assert.equal(prepared[3].terminal, true);
});
