/**
 * Workflow v2 real-agent test runs (design 05 agent mode real; R18 to R20,
 * D08, T112, T114; migration 0088): the Workflow controller runs test runs,
 * and every host takes the test operations.
 *
 * - An agent state of a real-agent test gets an ordinary child, created by
 *   the real agent host as a live run's is (the same id, owner, depth and
 *   wrapper prompt), with its deadline on the run's virtual clock; it is not
 *   intercepted as a mocked agent is.
 * - The child's framework tool calls, made through the same functions the
 *   worker's turn bridge uses (its lineage, then its test scope), are
 *   recorded as the agent state's interceptions: a fixture answers one at
 *   once; another waits for the parent, who is told, and its answer
 *   (success or error) is the call's result; a call the parent does not
 *   answer in time fails without running; a call after the state was
 *   decided is refused. The child completes the state with
 *   complete_workflow_node, and is ended as a live run's child is.
 * - Only test_advance times the agent out (no real sleeping); a pending call
 *   then stops; a cancelled test ends the child; retention keeps a
 *   real-agent test run.
 * - Pinned identity (R18): a draft's named agents are pinned at admission
 *   as its publication would pin them (an agent its publication could not
 *   pin refuses the test, and nothing is written), a test of the published
 *   revision takes the publication's pins after a republish, a repeat
 *   returns its receipt; mocked mode pins nothing; a live run's child is
 *   not under a test.
 * - Only a real-agent test run's pending agent state records an agent's tool
 *   call.
 * - A recover of a real-agent test run whose controller died ends its
 *   agent's child (no parent is told); a cleanup interrupted before or after
 *   the send is finished by repeats of that recover and a new one, with one
 *   command id and no new child (verification of RT-3, M-09).
 *
 * The agent host is the real createWorkflowAgentNodeHost with test-double
 * dependencies (a mutable agent catalog and a child double). No model runs:
 * the child double's calls stand for its model's tool calls.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2, recoverWorkflowV2Run } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/v2/agent-node-service.ts";
import { createWorkflowAgentNodeHost } from "../../src/workflow/v2/agent-host.ts";
import { registerWorkflowV2, sessionQueueTransport, workflowAgentChildSessionId, workflowNotifyInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_V2_TEST_NOTICE, WORKFLOW_V2_TEST_REAL_AGENT_NOTICE } from "../../src/workflow/v2/test-mode.ts";
import { authorizeWorkflowTestNotice, workflowTestAgentScope, workflowTestAgentToolCall } from "../../src/workflow/v2/test-agent-tools.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-test-agents-test" };
const CHILD = "test-real-agent-child";
const TASK = "Review the change at the given head.";
const OWNER = { provider: "test", subject: "alice", email: null, displayName: null };
const REVIEW_KIT = { name: "code-reviewer", packageName: "review-kit", packageVersion: "1.2.0", packageId: "pkg-1" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** One agent state (`invoke`: { prompt } or { agent }) with a ten-minute deadline, then terminals. As a document (JSON is YAML). */
function reviewer(invoke) {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "real-agents", version: "1.0.0" },
        initialInput: { head: "abc" }, initial: "review",
        schemas: { Review: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } }, additionalProperties: false } },
        states: {
            review: {
                type: "agent", invoke, session: "new", outputSchema: { $ref: "#/schemas/Review" }, timeoutSeconds: 600,
                transition: { next: { accepted: "done", timed_out: "late", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            late: { type: "terminal", outcome: "blocked", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    }, null, 2);
}

/** The child double: its session's queue, recorded in its custom status. */
function* agentChild(ctx) {
    const received = [];
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        received.push(typeof raw === "string" ? JSON.parse(raw) : raw);
        ctx.setCustomStatus(JSON.stringify(received));
    }
}

/**
 * A worker-equivalent registration whose agent host is
 * the real one over a mutable catalog of visible agents (`visible`) and a
 * child double that creates the child's session row (its lineage) and
 * queue. The parent is owned, so a test's notices to it are authorized; they
 * are recorded in `notices`. The tool host resolves agents from the same
 * catalog.
 */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    runtime.registerOrchestrationVersioned(CHILD, "1.0.0", agentChild);
    const visible = new Map();
    const resolveAgent = async name => visible.get(name) ?? null;
    const children = [];
    const agentNodes = createWorkflowAgentNodeHost({
        getSession: sessionId => catalog.getSession(sessionId),
        resolveAgent,
        createChild: async spec => {
            children.push(spec);
            await catalog.createSession(spec.sessionId, { parentSessionId: spec.parentSessionId, owner: spec.owner });
            const instanceId = `session-${spec.sessionId}`;
            await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: spec.prompt, clientMessageIds: [spec.clientMessageId] }));
        },
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("A test run never opens the live tool executor."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These tests' controller notifies no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        testPollMs: 50,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        agentNodes,
    });
    await runtime.start();
    const parent = randomUUID();
    await catalog.createSession(parent, { owner: OWNER });
    const host = { catalog, store, duroxideClient: client, resolveAgent };
    const notices = [];
    const context = { callerSessionId: parent, host };
    return {
        catalog, store, client, visible, children, parent, host, notices,
        /** A workflow child of `parent` with this agent state; published when `publish`. */
        async workflow(invoke, { publish = false } = {}) {
            const workflowSessionId = randomUUID();
            const created = await createWorkflowV2(host, {
                workflowSessionId, parentSessionId: parent, yaml: reviewer(invoke), actor: ACTOR, operationId: "create", publish,
            });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            return { workflowSessionId, definitionHash: created.receipt.yamlSha256 };
        },
        update: async (workflow, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflow.workflowSessionId, ...args }, context)),
        read: async (workflow, args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflow.workflowSessionId, ...args }, context)),
        /** Start a test run of revision 1 (agent mode real unless `args` says otherwise); its run id. */
        async test(workflow, operationId, args = {}) {
            const started = await this.update(workflow, { operation: "test", operation_id: operationId, expected_revision: 1,
                definition_hash: workflow.definitionHash, inputs: {}, agent_mode: "real", ...args });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "test" } });
            return started.run.runId;
        },
        /**
         * The framework tool calls of `sessionId`, made as the worker's turn bridge makes them: its stored lineage, its test
         * scope, then the interceptor (parent notices authorized by the worker's rule and recorded here).
         */
        async callAs(sessionId, options = {}) {
            const scope = await workflowTestAgentScope(store, await store.readWorkflowLineage(sessionId));
            expect(scope, `${sessionId} is under a test`).not.toBeNull();
            return workflowTestAgentToolCall({
                store, pollMs: 20, ...options,
                authorizeNotice: (workflowSessionId, parentSessionId) => authorizeWorkflowTestNotice(id => catalog.getSession(id), workflowSessionId, parentSessionId),
                notice: async (parentSessionId, prompt, clientMessageId) => { notices.push({ parentSessionId, prompt, clientMessageId }); },
            }, scope, sessionId);
        },
        complete: async (childSessionId, args) => JSON.parse(await completeWorkflowNodeFromTool(args, { callerSessionId: childSessionId, store, client })),
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

const spawned = (h, nodeExecutionId) => until(async () => {
    const invocation = await h.store.readAgentInvocation(nodeExecutionId);
    return invocation?.spawnedAt ? invocation : null;
}, `the child of ${nodeExecutionId}`);

const awaiting = (h, interceptionId) => until(async () => {
    const record = await h.store.readInterception(interceptionId);
    return record?.state === "awaiting_parent" ? record : null;
}, `interception ${interceptionId}`);

/** The messages the child double's queue got. */
async function childMessages(h, childSessionId) {
    const status = await h.client.getStatus(`session-${childSessionId}`);
    return typeof status.customStatus === "string" && status.customStatus ? JSON.parse(status.customStatus) : [];
}

const lifecycleCommand = (h, childSessionId) => until(async () => {
    const messages = await childMessages(h, childSessionId);
    return messages.find(message => message?.type === "cmd") ?? null;
}, `the lifecycle command of ${childSessionId}`);

describe("workflow v2 real-agent test runs: the controller", () => {
    it("gives the agent state an ordinary child whose framework tool calls the test answers, and ends it as a live run's", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const workflow = await h.workflow({ prompt: TASK });
            const started = await h.update(workflow, { operation: "test", operation_id: "real-1", expected_revision: 1, definition_hash: workflow.definitionHash,
                inputs: {}, agent_mode: "real", scenario: "real-review",
                fixtures: [{ tool: "read_build", arguments: { buildId: 101 }, response: { kind: "success", value: { state: "green" } } }] });
            expect(started).toMatchObject({ ok: true, run: { mode: "test" },
                test: { agentMode: "real", scenario: "real-review", notice: WORKFLOW_V2_TEST_NOTICE, agentNotice: WORKFLOW_V2_TEST_REAL_AGENT_NOTICE } });
            const runId = started.run.runId;
            const review = nodeExecutionIdFor(runId, "root", "review", 1);

            // An ordinary child, created by the real agent host as a live run's: its stable id, the workflow as its parent one
            // level down, the lineage's owner and the wrapper prompt. Its deadline is on the virtual clock. No mocked agent.
            const invocation = await spawned(h, review);
            const child = invocation.childSessionId;
            expect(child).toBe(workflowAgentChildSessionId(review));
            expect(invocation.deadlineAt.toISOString()).toBe("9000-01-01T00:10:00.000Z");
            expect(h.children).toHaveLength(1);
            expect(h.children[0]).toMatchObject({ sessionId: child, parentSessionId: workflow.workflowSessionId, nestingLevel: 2,
                owner: { provider: "test", subject: "alice" } });
            expect(h.children[0].prompt).toContain(TASK);
            expect(await h.store.readInterception(`${review}/agent`)).toBeNull();

            const call = await h.callAs(child);
            // A fixture answers a call at once, with its value; the parent is not asked.
            expect(await call("read_build", { buildId: 101 })).toEqual({ state: "green" });
            expect(await h.store.readInterception(`${review}/call-1`)).toMatchObject({ operation: "tool.call", tool: "read_build", state: "responded",
                response: { disposition: "fixture" } });
            expect(h.notices).toEqual([]);

            // A call no fixture answers (a wait here: a durable operation is a framework call too) waits for the parent, who is
            // told; the parent's answer is the call's result.
            const waiting = call("wait", { seconds: 60, reason: "cool off" });
            const second = await awaiting(h, `${review}/call-2`);
            expect(second).toMatchObject({ tool: "wait", arguments: { seconds: 60, reason: "cool off" } });
            expect(await h.update(workflow, { operation: "test_respond", operation_id: "answer-2", run_id: runId, interception_id: second.interceptionId,
                response: { kind: "success", value: "waited" } })).toMatchObject({ ok: true });
            expect(await waiting).toBe("waited");
            expect(h.notices.map(notice => [notice.parentSessionId, notice.clientMessageId])).toEqual([[h.parent, `workflow-test:${review}/call-2`]]);
            expect(h.notices[0].prompt).toContain("test_respond");
            expect(h.notices[0].prompt).toContain(child);

            // An error answer fails the call.
            const failing = call("read_logs", { buildId: 101 });
            failing.catch(() => {});
            const third = await awaiting(h, `${review}/call-3`);
            expect(await h.update(workflow, { operation: "test_respond", operation_id: "answer-3", run_id: runId, interception_id: third.interceptionId,
                response: { kind: "error", value: { code: "not_found", message: "no logs" } } })).toMatchObject({ ok: true });
            await expect(failing).rejects.toThrow("not_found: no logs");

            // A call the parent does not answer in time fails, and nothing ran; a later answer changes nothing.
            const impatient = await h.callAs(child, { waitMs: 300 });
            await expect(impatient("read_logs", { buildId: 102 })).rejects.toThrow(/did not answer .*\/call-4 \(read_logs\) within/);
            expect(await h.store.readInterception(`${review}/call-4`)).toMatchObject({ state: "awaiting_parent" });

            // The child completes the state as in a live run, and is told done.
            expect(await h.complete(child, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "done-1" })).toMatchObject({ ok: true, outcome: "accepted" });
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { verdict: "ok" } });
            expect(await lifecycleCommand(h, child)).toMatchObject({ type: "cmd", cmd: "done", id: `workflow-agent-end:${review}` });
            // After the state was decided, a call is refused, and nothing runs.
            await expect(call("read_build", { buildId: 101 })).rejects.toMatchObject({ code: "NODE_CLOSED" });

            // Evidence: the mode and its notice, each intercepted call under the agent state, the one left unanswered.
            const view = await h.read(workflow, { run_id: runId });
            expect(view.run.test).toMatchObject({ agentMode: "real", agentNotice: WORKFLOW_V2_TEST_REAL_AGENT_NOTICE, agentPins: null,
                coverage: { unanswered: [`${review}/call-4`] } });
            expect(view.run.test.interceptions.map(item => [item.interceptionId, item.stateId, item.tool, item.response?.disposition ?? null])).toEqual([
                [`${review}/call-1`, "review", "read_build", "fixture"], [`${review}/call-2`, "review", "wait", "parent"],
                [`${review}/call-3`, "review", "read_logs", "parent"], [`${review}/call-4`, "review", "read_logs", null],
            ]);
            expect(view.run.nodeExecutions.find(node => node.stateId === "review")).toMatchObject({ outcome: "accepted", winner: "agent",
                agent: { childSessionId: child, spawned: true, end: "done", endSent: true } });
            const events = await h.catalog.getSessionEvents(workflow.workflowSessionId, 0, 500);
            expect(events.filter(event => event.eventType === "workflow.test_intercepted").map(event => event.data.realAgent))
                .toEqual(Array(4).fill({ agentSessionId: child, callerSessionId: child }));
            expect(events.filter(event => event.eventType === "workflow.agent_spawned")).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });

    it("times the agent out only on the virtual clock, stops a waiting call, ends the child of a cancelled test, and keeps the run from retention", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const workflow = await h.workflow({ prompt: TASK });
            const runId = await h.test(workflow, "real-1");
            const review = nodeExecutionIdFor(runId, "root", "review", 1);
            const invocation = await spawned(h, review);
            const call = await h.callAs(invocation.childSessionId);
            const pending = call("read_build", { buildId: 9 });
            pending.catch(() => {});
            const open = await awaiting(h, `${review}/call-1`);

            // Real time never times the agent out; an advance to its virtual deadline does, and the waiting call stops.
            expect(await h.update(workflow, { operation: "test_advance", operation_id: "adv-1", run_id: runId, seconds: 599 }))
                .toMatchObject({ ok: true, decided: [] });
            expect((await h.store.readNodeExecution(review)).state).toBe("pending");
            expect(await h.update(workflow, { operation: "test_advance", operation_id: "adv-2", run_id: runId, seconds: 1 }))
                .toMatchObject({ ok: true, decided: [{ stateId: "review", outcome: "timed_out" }] });
            await expect(pending).rejects.toThrow(/stopped waiting/);
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "late" });
            expect(await lifecycleCommand(h, invocation.childSessionId)).toMatchObject({ type: "cmd", cmd: "cancel" });
            expect(await h.update(workflow, { operation: "test_respond", operation_id: "late-1", run_id: runId, interception_id: open.interceptionId,
                response: { kind: "success", value: { state: "green" } } })).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });

            // A cancelled test ends its agent's child as a cancelled live run does (T114).
            const cancelled = await h.test(workflow, "real-2");
            const second = await spawned(h, nodeExecutionIdFor(cancelled, "root", "review", 1));
            expect(await h.update(workflow, { operation: "cancel", operation_id: "cancel-1", run_id: cancelled, reason: "enough" })).toMatchObject({ ok: true });
            expect(await ended(h, cancelled)).toMatchObject({ status: "cancelled" });
            expect(await lifecycleCommand(h, second.childSessionId)).toMatchObject({ type: "cmd", cmd: "cancel" });

            // Retention keeps a real-agent test run: its children's lineage is read from its invocation records.
            expect(await h.store.listPrunableTestRuns(workflow.workflowSessionId, { keep: 0, graceSeconds: 0 })).toEqual([]);
            expect(await h.store.pruneTestRun(cancelled, { graceSeconds: 0 })).toEqual({ pruned: false, reason: "live_records" });
            expect(await h.store.readRun(runId)).toMatchObject({ status: "completed" });
        } finally {
            await h.stop();
        }
    });

    it("pins a real-agent test's named agents when it is admitted, as its publication would, and binds its child to the pinned revision", { timeout: TIMEOUT }, async () => {
        const OLD = "a".repeat(64);
        const NEW = "b".repeat(64);
        const h = await harness(getEnv());
        try {
            h.visible.set("code-reviewer", { ...REVIEW_KIT, packageRevision: OLD });
            const pinned = { review: { name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "pkg-1", revision: OLD } };

            // A draft is pinned as its publication would be; its child runs the pinned revision with that revision's own tools.
            const draft = await h.workflow({ agent: { name: "code-reviewer" } });
            const runId = await h.test(draft, "pin-1");
            expect((await h.store.readRun(runId)).testAgentPins).toEqual(pinned);
            const invocation = await spawned(h, nodeExecutionIdFor(runId, "root", "review", 1));
            expect(invocation.task).toEqual({ source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "pkg-1", revision: OLD });
            expect(h.children.at(-1)).toMatchObject({ boundAgentName: "code-reviewer", boundAgentPackageId: `pkg-1@${OLD}`, toolNames: [] });
            expect((await h.read(draft, { run_id: runId })).run.test.agentPins).toEqual(pinned);
            // A repeat returns its receipt and pins nothing again, even once the agent is gone.
            h.visible.delete("code-reviewer");
            expect(await h.update(draft, { operation: "test", operation_id: "pin-1", expected_revision: 1, definition_hash: draft.definitionHash,
                inputs: {}, agent_mode: "real" })).toMatchObject({ ok: true, replayed: true, run: { runId } });
            // An agent its publication could not pin refuses the test, and nothing is written: unavailable, or a system agent.
            const gone = await h.workflow({ agent: { name: "code-reviewer" } });
            expect(await h.update(gone, { operation: "test", operation_id: "pin-2", expected_revision: 1, definition_hash: gone.definitionHash,
                inputs: {}, agent_mode: "real" })).toMatchObject({ ok: false, error: { code: "AGENT_UNAVAILABLE" } });
            h.visible.set("sweeper", { name: "sweeper", system: true, creatable: false });
            const system = await h.workflow({ agent: { name: "sweeper" } });
            expect(await h.update(system, { operation: "test", operation_id: "pin-3", expected_revision: 1, definition_hash: system.definitionHash,
                inputs: {}, agent_mode: "real" })).toMatchObject({ ok: false, error: { code: "AGENT_UNAVAILABLE" } });
            expect((await h.read(gone)).runs).toEqual([]);
            expect((await h.read(system)).runs).toEqual([]);
            // Mocked mode pins nothing: its agent is mocked.
            h.visible.set("code-reviewer", { ...REVIEW_KIT, packageRevision: OLD });
            const mocked = await h.test(draft, "mock-1", { agent_mode: "mocked" });
            expect((await h.store.readRun(mocked)).testAgentPins).toBeNull();
            expect(await h.complete(invocation.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "done-1" })).toMatchObject({ ok: true });
            expect(await ended(h, runId)).toMatchObject({ status: "completed" });

            // A published revision is not tested (of-06): the test is refused, and nothing is written. Its live run's child runs the
            // revision its publication pinned, also after the package is republished, and is not under a test.
            const published = await h.workflow({ agent: { name: "code-reviewer" } }, { publish: true });
            expect((await h.store.readDefinition(published.workflowSessionId)).publishedAgentPins).toEqual(pinned);
            h.visible.set("code-reviewer", { ...REVIEW_KIT, packageVersion: "1.3.0", packageRevision: NEW });
            expect(await h.update(published, { operation: "test", operation_id: "pin-4", expected_revision: 1, definition_hash: published.definitionHash,
                inputs: {}, agent_mode: "real" })).toMatchObject({ ok: false, error: { code: "TEST_NEEDS_DRAFT" } });
            expect((await h.read(published)).runs).toEqual([]);

            const live = await h.update(published, { operation: "start", operation_id: "start-1", definition_hash: published.definitionHash, inputs: {} });
            expect(live).toMatchObject({ ok: true, run: { mode: "live" } });
            const liveChild = await spawned(h, nodeExecutionIdFor(live.run.runId, "root", "review", 1));
            expect(liveChild.task).toMatchObject({ packageId: "pkg-1", revision: OLD });
            expect(await workflowTestAgentScope(h.store, await h.store.readWorkflowLineage(liveChild.childSessionId))).toBeNull();
        } finally {
            await h.stop();
        }
    });

    it("records an agent's tool call only for a real-agent test run's pending agent state", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const workflow = await h.workflow({ prompt: TASK });
            // A mocked test run's agent state is intercepted itself; it has no child, and takes no agent tool call.
            const mocked = await h.test(workflow, "mock-1", { agent_mode: "mocked" });
            const review = nodeExecutionIdFor(mocked, "root", "review", 1);
            await awaiting(h, `${review}/agent`);
            await expect(h.store.interceptAgentToolCall({ runId: mocked, nodeExecutionId: review, tool: "read_build", argumentsText: "{}", fixture: null }))
                .rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
            expect(await h.store.readAgentInvocation(review)).toBeNull();
            // A session outside every agent state has no test scope.
            expect(await workflowTestAgentScope(h.store, await h.store.readWorkflowLineage(h.parent))).toBeNull();
        } finally {
            await h.stop();
        }
    });

    // Verification of RT-3 (M-09) on the real provider, for a real-agent test run (the live run's case is in
    // workflow-v2-agent-node): the same interrupted cleanup, finished by repeats of the recover and a new one.
    it("M-09: a recover of a real-agent test run whose controller died ends its agent's child once, through an interrupted cleanup, with no new child", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const workflow = await h.workflow({ prompt: TASK });
            const runId = await h.test(workflow, "real-1");
            const review = nodeExecutionIdFor(runId, "root", "review", 1);
            const child = (await spawned(h, review)).childSessionId;
            const { controllerInstanceId } = await h.store.readRun(runId);
            await h.client.cancelInstance(controllerInstanceId, "terminated by the test");
            await until(async () => (await h.client.getStatus(controllerInstanceId)).status === "Failed" || null, "the controller to end");
            expect((await h.store.readRun(runId)).status).toBe("running");

            // The end commands the child double has taken (it records one only after it took it from its queue): waited for,
            // bounded; after a settle where none more should come.
            const commandsSent = count => until(async () => {
                const sent = (await childMessages(h, child)).filter(message => message?.type === "cmd");
                return sent.length >= count ? sent : null;
            }, `${count} end command(s) at the child`, 10_000);
            const commandsSettled = async () => {
                await pause(1_500);
                return (await childMessages(h, child)).filter(message => message?.type === "cmd");
            };

            // The recover ends the run, but the child's queue cannot be reached.
            const unreachable = { ...h.host, duroxideClient: failingFor(h.client, child) };
            await expect(recoverWorkflowV2Run(unreachable, runId, { requestedBy: null, operationId: "recover-1" })).rejects.toThrow(/were not ended yet/);
            expect(await h.store.readRun(runId)).toMatchObject({ mode: "test", status: "failed", terminalError: { code: "controller_ended" } });
            expect(await h.store.readAgentInvocation(review)).toMatchObject({ endRequested: "cancel", endSentAt: null });
            expect(await commandsSettled()).toEqual([]);

            // Its repeat sends the end, and the record of it is lost once; the next repeat sends it again with the same id.
            const markAgentEndSent = h.store.markAgentEndSent.bind(h.store);
            let lose = 1;
            h.store.markAgentEndSent = async (...args) => {
                if (lose > 0) {
                    lose -= 1;
                    throw new Error("The store is not available (test).");
                }
                return await markAgentEndSent(...args);
            };
            await expect(recoverWorkflowV2Run(h.host, runId, { requestedBy: null, operationId: "recover-1" })).rejects.toThrow(/were not ended yet/);
            expect(await recoverWorkflowV2Run(h.host, runId, { requestedBy: null, operationId: "recover-1" }))
                .toMatchObject({ replayed: true, receipt: { action: "ended", status: "failed" } });
            const command = { type: "cmd", cmd: "cancel", id: `workflow-agent-end:${review}`, requestedBy: workflow.workflowSessionId };
            expect(await commandsSent(2)).toEqual([expect.objectContaining(command), expect.objectContaining(command)]);
            expect(await h.store.readAgentInvocation(review)).toMatchObject({ endSentAt: expect.any(Date), endChildStatus: "Running" });

            // A new recover finds nothing owed. No child was created again, and no parent was told of a test run's end.
            expect(await recoverWorkflowV2Run(h.host, runId, { requestedBy: null, operationId: "recover-2" }))
                .toMatchObject({ replayed: false, receipt: { action: "none", status: "failed" } });
            expect(await commandsSettled()).toHaveLength(2);
            expect(h.children).toHaveLength(1);
            expect(await h.store.readAgentInvocation(review)).toMatchObject({ spawnAttempts: 1 });
            expect((await h.client.getStatus(workflowNotifyInstanceId(runId))).status).toBe("NotFound");
        } finally {
            await h.stop();
        }
    });
});

/** A duroxide client that fails `method` for the session instance of `childSessionId` and passes everything else on. */
function failingFor(client, childSessionId, method = "enqueueEvent") {
    return new Proxy(client, {
        get(target, property) {
            if (property === method) {
                return async (instanceId, ...rest) => {
                    if (instanceId === `session-${childSessionId}`) throw new Error("The child's session is not reachable (test).");
                    return await target[method](instanceId, ...rest);
                };
            }
            const value = target[property];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
