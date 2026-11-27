/**
 * Issue I8 (Task 3): End-to-end integration tests for `session: continue` in named parallel branches:
 * 1. Concurrent named branches with `session: continue` on a real PilotSwarmWorker + scripted model:
 *    one session per (runId, stateId), I1 memory commit across intra-branch cycles, sibling isolation, run-end close.
 * 2. Branch cuts (`join: { first: 1 }`): cutting a pending continued visit sends `workflow-cycle-stop:<nx>`,
 *    while cutting a branch after the visit already reported (now at a subsequent wait) sends NO cycle Stop.
 * 3. Outer-loop re-entry of `parallel`: fork 1 (2 visits) -> join -> fork 2 (`n.ordinal = 1`) reuses `S_left`
 *    with `CYCLE 3` + `previousResult`, and graceful stop while `left_code` is pending & `right_code` is idle
 *    ends idle `S_right` immediately while leaving `S_left` running to finish fork 2 visit 1 (Q5).
 * 4. Cross-fork session replacement: deleting/ending `S_left` between forks allocates deterministic
 *    `workflowAgentSessionId(runId, "left_code", 3)` with the replacement prompt.
 * 5. Corrupt-scope guard: `WORKFLOW_ACTIVITIES.enter` refuses `session: continue` in a non-named (`forEach`)
 *    branch scope with `WORKFLOW_STORE_CORRUPT`.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { controlWorkflowRun, createWorkflow } from "../../src/workflow/service.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";
import {
    registerWorkflow, sessionQueueTransport, WORKFLOW_CONTROLLER_VERSION, workflowAgentSessionId,
    workflowLiveControllerInstanceId,
} from "../../src/workflow/runtime.ts";
import { BRANCH_ROUTE, WORKFLOW_ACTIVITIES } from "../../src/workflow/controller/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { branchScopeId } from "../../src/workflow/parallel.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "i8-branch-continue-owner", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-branch-session-continue-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(100);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const textOf = message => typeof message?.content === "string" ? message.content
    : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? "").join("") : "";
const visitOf = position => /"nodeExecutionId":"(nx-[0-9a-f]+)"/.exec(position.lastUserText)?.[1] ?? null;
const stateOf = position => /"stateId":"([^"]+)"/.exec(position.lastUserText)?.[1] ?? null;
const cycleOf = position => Number(/WORKFLOW NODE INVOCATION, CYCLE (\d+)\./.exec(position.lastUserText)?.[1] ?? 1);
const isStepRequest = body => (body.tools ?? []).some(tool => tool.function?.name === "complete_workflow_node");

// ─── Real worker test (Test 1: I1 memory commit & sibling isolation) ─────────

describe("I8 named branches with session: continue (real worker + scripted model)", () => {
    it("named branches with session: continue keep one session per (branch, state), commit memory across intra-branch cycles (I1), and isolate sibling branches", { timeout: 240_000 }, async () => {
        const env = getEnv();
        const LEFT_MEMO = "LEFT-MEMO-1: amber-77";
        const RIGHT_MEMO = "RIGHT-MEMO-1: cobalt-19";
        const observations = [];
        const model = await startScriptedModel({
            respond: (body, position) => {
                if (!isStepRequest(body)) return { content: "ok" };
                const stateId = stateOf(position);
                const nx = visitOf(position);
                const cycle = cycleOf(position);
                const allText = (body.messages ?? []).map(textOf).join("\n");
                if (position.step === 0) {
                    observations.push({
                        stateId, nx, cycle,
                        sawLeftMemo: allText.includes(LEFT_MEMO),
                        sawRightMemo: allText.includes(RIGHT_MEMO),
                    });
                    if (stateId === "left_code" && cycle === 1) {
                        return {
                            tools: [{ name: "complete_workflow_node", args: { outcome: "review", output: { rev: 1 }, operation_id: `op-${nx}`, node_execution_id: nx } }],
                        };
                    }
                    if (stateId === "left_code" && cycle === 2) {
                        return {
                            tools: [{ name: "complete_workflow_node", args: { outcome: "ship", output: { rev: 2, recalled: allText.includes(LEFT_MEMO) }, operation_id: `op-${nx}`, node_execution_id: nx } }],
                        };
                    }
                    if (stateId === "right_code") {
                        return {
                            tools: [{ name: "complete_workflow_node", args: { outcome: "ship", output: { side: "right", leakedLeft: allText.includes(LEFT_MEMO) }, operation_id: `op-${nx}`, node_execution_id: nx } }],
                        };
                    }
                }
                if (stateId === "left_code" && cycle === 1) return { content: LEFT_MEMO };
                if (stateId === "right_code") return { content: RIGHT_MEMO };
                return { content: `finished ${stateId} cycle ${cycle}` };
            },
        });
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const client = new PilotSwarmClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, modelProvidersPath,
        });
        const worker = new PilotSwarmWorker({
            store: env.store, githubToken: process.env.GITHUB_TOKEN, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, sessionStateDir: env.sessionStateDir, workerNodeId: "i8-worker-1",
            disableManagementAgents: true, logLevel: "error", modelProvidersPath,
        });
        await client.start();
        await worker.start();
        try {
            const store = catalog.workflowStore();
            const yaml = JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "i8-two-lanes", version: "1.0.0" }, initial: "fan",
                states: {
                    fan: {
                        type: "parallel", timeoutSeconds: 600,
                        branches: {
                            left: {
                                initial: "left_code",
                                states: {
                                    left_code: {
                                        type: "agent", session: "continue", invoke: { prompt: "Build left lane." }, timeoutSeconds: 300,
                                        outcomes: ["review", "ship"],
                                        transition: { next: { review: "left_pause", ship: "left_done", failure: "left_failed" } },
                                    },
                                    left_pause: { type: "wait", seconds: 1, transition: { next: { elapsed: "left_code" } } },
                                    left_done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                                    left_failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                                },
                            },
                            right: {
                                initial: "right_code",
                                states: {
                                    right_code: {
                                        type: "agent", session: "continue", invoke: { prompt: "Build right lane." }, timeoutSeconds: 300,
                                        outcomes: ["ship"],
                                        transition: { next: { ship: "right_done", failure: "right_failed" } },
                                    },
                                    right_done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                                    right_failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                                },
                            },
                        },
                        transition: { next: { joined: "done", blocked: "failed", timed_out: "failed", failure: "failed" } },
                    },
                    done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                    failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                },
            });

            const parent = randomUUID();
            await catalog.createSession(parent, { owner: OWNER });
            const workflowSessionId = randomUUID();
            const created = await createWorkflow(
                { catalog, store, duroxideClient: client._getDuroxideClient() },
                { workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: "create-two-lanes", publish: true, start: { inputs: {} }, notifyParent: false },
            );
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const runId = created.receipt.run.runId;

            const finalRun = await until(async () => {
                const row = await store.readRun(runId);
                return row && ENDED.includes(row.status) ? row : null;
            }, "i8-two-lanes to finish", 180_000);
            expect(finalRun).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });

            const leftSession = workflowAgentSessionId(runId, "left_code");
            const rightSession = workflowAgentSessionId(runId, "right_code");
            expect(leftSession).not.toBe(rightSession);

            const leftInv = await store.listAgentInvocationsOfState(runId, "left_code");
            const rightInv = await store.listAgentInvocationsOfState(runId, "right_code");
            expect(leftInv.map(i => i.childSessionId)).toEqual([leftSession, leftSession]);
            expect(rightInv.map(i => i.childSessionId)).toEqual([rightSession]);

            // Cycle 2 on left_code received cycle 1's committed assistant reply; sibling right_code never saw left's memo
            const leftCycle2 = observations.find(o => o.stateId === "left_code" && o.cycle === 2);
            const rightCycle1 = observations.find(o => o.stateId === "right_code" && o.cycle === 1);
            expect(leftCycle2?.sawLeftMemo).toBe(true);
            expect(leftCycle2?.sawRightMemo).toBe(false);
            expect(rightCycle1?.sawLeftMemo).toBe(false);

            // Both sessions end cleanly when the Workflow finishes (agent_ended with end: "done")
            const events = await until(async () => {
                const list = await catalog.getSessionEvents(workflowSessionId);
                const ends = list.filter(e => e.eventType === "workflow.agent_ended");
                return ends.length >= 2 ? list : null;
            }, "both workflow.agent_ended events", 30_000);
            const cycleEnds = events.filter(e => e.eventType === "workflow.agent_cycle_ended").map(e => e.data);
            expect(cycleEnds.every(d => d.end === "done" && d.turnStopped === false)).toBe(true);
            const sessionEnds = events.filter(e => e.eventType === "workflow.agent_ended").map(e => e.data);
            expect(sessionEnds).toEqual(expect.arrayContaining([
                expect.objectContaining({ childSessionId: leftSession, end: "done", sent: true, session: "continue" }),
                expect.objectContaining({ childSessionId: rightSession, end: "done", sent: true, session: "continue" }),
            ]));
        } finally {
            await worker.stop();
            await client.stop();
            await catalog.close();
            await model.close();
        }
    });
});

// ─── Controller harness (Tests 2-5: cuts, outer loops, replacement, corrupt scope) ─

const CHILD = "test-i8-agent-child";
function* sessionChild(ctx) {
    const received = [];
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        const message = typeof raw === "string" ? JSON.parse(raw) : raw;
        received.push(message);
        ctx.setCustomStatus(JSON.stringify(received));
        if (message?.type === "cmd" && message.cmd === "delete") return "deleted";
    }
}

async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: 8, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    runtime.registerOrchestrationVersioned(CHILD, "1.0.0", sessionChild);
    const spawns = [];
    const stops = [];
    const activities = new Map();
    const agentNodes = {
        async spawn(request) {
            spawns.push(request);
            const instanceId = `session-${request.childSessionId}`;
            const message = JSON.stringify({ prompt: request.prompt, clientMessageIds: [request.clientMessageId] });
            if ((await client.getStatus(instanceId)).status === "NotFound") {
                await catalog.createSession(request.childSessionId, { parentSessionId: request.workflowSessionId }).catch(() => {});
                await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            }
            await client.enqueueEvent(instanceId, "messages", message);
            return { spawned: true };
        },
    };
    const spied = new Proxy(catalog, {
        get(target, key) {
            if (key === "turnControlAdd") {
                return async (sessionId, kind, text, requestId) => {
                    stops.push({ sessionId, kind, text, requestId });
                    return { refused: "no_turn" };
                };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    registerWorkflow({
        registerActivity: (name, fn) => {
            activities.set(name, fn);
            return runtime.registerActivity(name, fn);
        },
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog: spied, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("no tools"); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("no notify"); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        agentNodes,
    });
    await runtime.start();
    return {
        catalog, store, client, spawns, stops, activities,
        host: { catalog, store, duroxideClient: client },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function started(h, yaml) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflow(h.host, {
        workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: `start-${randomUUID()}`, start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parent, workflowSessionId, runId: created.receipt.run.runId };
}

const spawnedFor = (h, stateId, n) => until(() => {
    const matching = h.spawns.filter(s => s.stateId === stateId);
    return matching.length >= n ? matching[n - 1] : null;
}, `spawn #${n} for ${stateId}`);

const completeAs = (h, childSessionId, args) =>
    completeWorkflowNodeFromTool(args, { callerSessionId: childSessionId, store: h.store, client: h.client }).then(JSON.parse);

async function commandsOf(h, childSessionId) {
    const status = await h.client.getStatus(`session-${childSessionId}`);
    if (!status.customStatus) return [];
    return JSON.parse(status.customStatus).filter(m => m?.type === "cmd");
}

const agentSessionEnd = (h, childSessionId) => until(async () => {
    const cmds = await commandsOf(h, childSessionId);
    return cmds[0] ?? null;
}, `end command for ${childSessionId}`);

const ended = (h, runId) => until(async () => {
    const row = await h.store.readRun(runId);
    return row && ENDED.includes(row.status) ? row : null;
}, `run ${runId} to end`);

const eventsOf = async (h, workflowSessionId, type) =>
    (await h.catalog.getSessionEvents(workflowSessionId)).filter(e => e.eventType === type).map(e => e.data);

describe("I8 named branches on the controller (cuts, outer loops, replacements, corrupt scope)", () => {
    it("join: { first: 1 } and failFast branch cuts stop a pending continued visit's turn without killing a completed visit's uncommitted reply", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const cutYaml = (withWaitAfter) => JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: withWaitAfter ? "cut-after" : "cut-pending", version: "1.0.0" },
                initial: "fan",
                states: {
                    fan: {
                        type: "parallel", timeoutSeconds: 600, join: { first: 1 },
                        branches: {
                            fast: {
                                initial: "fast_step",
                                states: {
                                    fast_step: { type: "agent", session: "continue", invoke: { prompt: "Fast." }, timeoutSeconds: 300,
                                        outcomes: ["done"], transition: { next: { done: "fast_done", failure: "fast_failed" } } },
                                    fast_done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                                    fast_failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                                },
                            },
                            deep: {
                                initial: "deep_code",
                                states: {
                                    deep_code: {
                                        type: "agent", session: "continue", invoke: { prompt: "Deep." }, timeoutSeconds: 300,
                                        outcomes: ["done"],
                                        transition: { next: { done: withWaitAfter ? "deep_wait" : "deep_done", failure: "deep_failed" } },
                                    },
                                    ...(withWaitAfter ? { deep_wait: { type: "wait", seconds: 300, transition: { next: { elapsed: "deep_done" } } } } : {}),
                                    deep_done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                                    deep_failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                                },
                            },
                        },
                        transition: { next: { joined: "done", blocked: "failed", timed_out: "failed", failure: "failed" } },
                    },
                    done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                    failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                },
            });

            // (a) Cut while deep_code is pending -> cycle Stop sent for deep_code; S_deep ended at run end
            const runA = await started(h, cutYaml(false));
            const fastA = await spawnedFor(h, "fast_step", 1);
            const deepA = await spawnedFor(h, "deep_code", 1);
            const sDeepA = workflowAgentSessionId(runA.runId, "deep_code");
            expect(deepA.childSessionId).toBe(sDeepA);
            expect(await completeAs(h, fastA.childSessionId, { outcome: "done", output: "won", operation_id: "fast-a", node_execution_id: fastA.nodeExecutionId }))
                .toMatchObject({ ok: true });
            expect(await ended(h, runA.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect(h.stops).toContainEqual(expect.objectContaining({
                sessionId: sDeepA, kind: "stop", requestId: `workflow-cycle-stop:${deepA.nodeExecutionId}`,
            }));
            expect(await agentSessionEnd(h, sDeepA)).toMatchObject({ type: "cmd", cmd: "cancel" });

            // (b) Cut while branch deep is at deep_wait AFTER deep_code already reported -> NO cycle Stop for deep_code!
            const runB = await started(h, cutYaml(true));
            const fastB = await spawnedFor(h, "fast_step", 2);
            const deepB = await spawnedFor(h, "deep_code", 2);
            const sDeepB = workflowAgentSessionId(runB.runId, "deep_code");
            expect(await completeAs(h, sDeepB, { outcome: "done", output: "reported", operation_id: "deep-b", node_execution_id: deepB.nodeExecutionId }))
                .toMatchObject({ ok: true });
            await until(async () => {
                const nodes = await h.store.listNodeExecutions(runB.runId);
                return nodes.find(n => n.nodeId === "deep_wait" && n.state === "pending") ?? null;
            }, "deep_wait pending");
            expect(await completeAs(h, fastB.childSessionId, { outcome: "done", output: "won-b", operation_id: "fast-b", node_execution_id: fastB.nodeExecutionId }))
                .toMatchObject({ ok: true });
            expect(await ended(h, runB.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            // deep_code's cycle ended as done with NO cycle Stop (preserving I1 finishing reply while run was active)
            expect(h.stops.filter(s => s.requestId.startsWith(`workflow-cycle-stop:${deepB.nodeExecutionId}`))).toEqual([]);
            const deepCycleEnds = (await eventsOf(h, runB.workflowSessionId, "workflow.agent_cycle_ended"))
                .filter(d => d.nodeExecutionId === deepB.nodeExecutionId);
            expect(deepCycleEnds).toEqual([expect.objectContaining({ end: "done", turnStopped: false })]);
            expect(await agentSessionEnd(h, sDeepB)).toMatchObject({ type: "cmd", cmd: "done" });
        } finally {
            await h.stop();
        }
    });

    it("outer-loop re-entry of a parallel state reuses each named branch's continued session with cycle 3 and preserves Q5 graceful stop", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const yaml = JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "outer-loop-branches", version: "1.0.0" },
                initial: "fan",
                states: {
                    fan: {
                        type: "parallel", timeoutSeconds: 600,
                        branches: {
                            left: {
                                initial: "left_code",
                                states: {
                                    left_code: {
                                        type: "agent", session: "continue", invoke: { prompt: "Left work." }, timeoutSeconds: 300,
                                        outcomes: ["again", "done"],
                                        transition: { next: { again: "left_code", done: "left_done", failure: "left_failed" } },
                                    },
                                    left_done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                                    left_failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                                },
                            },
                            right: {
                                initial: "right_code",
                                states: {
                                    right_code: {
                                        type: "agent", session: "continue", invoke: { prompt: "Right work." }, timeoutSeconds: 300,
                                        outcomes: ["done"],
                                        transition: { next: { done: "right_done", failure: "right_failed" } },
                                    },
                                    right_done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                                    right_failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                                },
                            },
                        },
                        transition: { next: { joined: "decide_outer", blocked: "failed", timed_out: "failed", failure: "failed" } },
                    },
                    decide_outer: {
                        type: "wait", seconds: 1, maxVisits: 1,
                        transition: { next: { elapsed: "fan", exhausted: "done", failure: "failed" } },
                    },
                    done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                    failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                },
            });

            const run = await started(h, yaml);
            const sLeft = workflowAgentSessionId(run.runId, "left_code");
            const sRight = workflowAgentSessionId(run.runId, "right_code");

            // Fork 1: left_code runs 2 cycles (1, 2); right_code runs 1 cycle (1)
            const l1 = await spawnedFor(h, "left_code", 1);
            const r1 = await spawnedFor(h, "right_code", 1);
            expect(l1.childSessionId).toBe(sLeft);
            expect(r1.childSessionId).toBe(sRight);
            expect(await completeAs(h, sLeft, { outcome: "again", output: { c: 1 }, operation_id: "l1", node_execution_id: l1.nodeExecutionId })).toMatchObject({ ok: true });
            const l2 = await spawnedFor(h, "left_code", 2);
            expect(l2.childSessionId).toBe(sLeft);
            expect(JSON.parse(l2.prompt.split("\n")[1])).toMatchObject({ cycle: 2, previousResult: { outcome: "again", output: { c: 1 } } });
            expect(await completeAs(h, sLeft, { outcome: "done", output: { c: 2 }, operation_id: "l2", node_execution_id: l2.nodeExecutionId })).toMatchObject({ ok: true });
            expect(await completeAs(h, sRight, { outcome: "done", output: { r: 1 }, operation_id: "r1", node_execution_id: r1.nodeExecutionId })).toMatchObject({ ok: true });

            // Fork 2 (n.ordinal resets to 1!): left_code gets CYCLE 3 on the same S_left with previousResult from cycle 2
            const l3 = await spawnedFor(h, "left_code", 3);
            const r2 = await spawnedFor(h, "right_code", 2);
            expect(l3.childSessionId).toBe(sLeft);
            expect(l3.prompt.split("\n")[0]).toMatch(/WORKFLOW NODE INVOCATION, CYCLE 3\./);
            expect(JSON.parse(l3.prompt.split("\n")[1])).toMatchObject({
                cycle: 3, nodeExecutionId: l3.nodeExecutionId, previousResult: { outcome: "done", output: { c: 2 } },
            });
            expect(r2.childSessionId).toBe(sRight);
            expect(JSON.parse(r2.prompt.split("\n")[1])).toMatchObject({ cycle: 2, previousResult: { outcome: "done", output: { r: 1 } } });

            // Complete right_code in fork 2 (so S_right is idle) while left_code fork 2 visit 1 (n.ordinal=1) is STILL pending!
            expect(await completeAs(h, sRight, { outcome: "done", output: { r: 2 }, operation_id: "r2", node_execution_id: r2.nodeExecutionId })).toMatchObject({ ok: true });
            await until(async () => (await h.store.readNodeExecution(r2.nodeExecutionId))?.state === "completed", "r2 completed");

            // Request graceful stop: idle S_right must end immediately; active S_left (fork 2 visit 1 pending!) must stay running!
            await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "stop", runId: null, graceSeconds: 60, reason: "finish work" },
                { actor: ACTOR, operationId: "stop-mixed" });
            expect(await agentSessionEnd(h, sRight)).toMatchObject({ type: "cmd", cmd: "done" });
            await pause(400);
            expect(await commandsOf(h, sLeft)).toEqual([]);

            // Now complete left_code fork 2 visit 1 -> run stops cleanly and ends S_left with cmd: done
            expect(await completeAs(h, sLeft, { outcome: "done", output: { c: 3 }, operation_id: "l3", node_execution_id: l3.nodeExecutionId })).toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "stopped" });
            expect(await agentSessionEnd(h, sLeft)).toMatchObject({ type: "cmd", cmd: "done" });
        } finally {
            await h.stop();
        }
    });

    it("if a named branch's continued session is deleted or ended between forks, the next cycle starts deterministic replacement workflowAgentSessionId(runId, stateId, visit)", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const yaml = JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "cross-fork-replace", version: "1.0.0" },
                initial: "fan",
                states: {
                    fan: {
                        type: "parallel", timeoutSeconds: 600,
                        branches: {
                            left: {
                                initial: "left_code",
                                states: {
                                    left_code: {
                                        type: "agent", session: "continue", invoke: { prompt: "Left replace." }, timeoutSeconds: 300,
                                        outcomes: ["again", "done"],
                                        transition: { next: { again: "left_code", done: "left_done", failure: "left_failed" } },
                                    },
                                    left_done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                                    left_failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                                },
                            },
                        },
                        transition: { next: { joined: "pause", blocked: "failed", timed_out: "failed", failure: "failed" } },
                    },
                    pause: { type: "wait", seconds: 2, maxVisits: 1, transition: { next: { elapsed: "fan", exhausted: "done", failure: "failed" } } },
                    done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                    failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
                },
            });

            const run = await started(h, yaml);
            const s1 = workflowAgentSessionId(run.runId, "left_code");
            const l1 = await spawnedFor(h, "left_code", 1);
            expect(l1.childSessionId).toBe(s1);
            expect(await completeAs(h, s1, { outcome: "again", output: 1, operation_id: "rep-1", node_execution_id: l1.nodeExecutionId })).toMatchObject({ ok: true });
            const l2 = await spawnedFor(h, "left_code", 2);
            expect(l2.childSessionId).toBe(s1);
            expect(await completeAs(h, s1, { outcome: "done", output: 2, operation_id: "rep-2", node_execution_id: l2.nodeExecutionId })).toMatchObject({ ok: true });

            // Wait until outer pause state is pending, then delete S1 before fork 2 admits left_code visit 3
            await until(async () => (await h.store.listNodeExecutions(run.runId)).find(n => n.nodeId === "pause" && n.state === "pending") ?? null, "pause pending");
            await h.catalog.softDeleteSession(s1);
            await h.client.enqueueEvent(`session-${s1}`, "messages", JSON.stringify({ type: "cmd", cmd: "delete" }));

            const l3 = await spawnedFor(h, "left_code", 3);
            const expectedReplacement = workflowAgentSessionId(run.runId, "left_code", 3);
            expect(l3.childSessionId).toBe(expectedReplacement);
            expect(l3.childSessionId).not.toBe(s1);
            expect(l3.prompt.split("\n")[0]).toContain(`The agent session of its earlier cycles ended (session ${s1})`);
            expect(JSON.parse(l3.prompt.split("\n")[1])).toMatchObject({ cycle: 3, previousResult: { outcome: "done", output: 2 } });

            expect(await completeAs(h, expectedReplacement, { outcome: "done", output: 3, operation_id: "rep-3", node_execution_id: l3.nodeExecutionId })).toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect(await agentSessionEnd(h, expectedReplacement)).toMatchObject({ type: "cmd", cmd: "done" });
        } finally {
            await h.stop();
        }
    });

    it("enter refuses corrupt non-named branch scope with session: continue as WORKFLOW_STORE_CORRUPT", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const validForEachYaml = JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "corrupt-foreach", version: "1.0.0" },
                initial: "fan",
                states: {
                    fan: {
                        type: "parallel", forEach: [1],
                        body: {
                            initial: "talk",
                            states: {
                                talk: {
                                    type: "agent", session: "new", invoke: { prompt: "Item." }, timeoutSeconds: 300,
                                    outcomes: ["done"], transition: { next: { done: "item_done", failure: "item_failed" } },
                                },
                                item_done: { type: "terminal", outcome: "succeeded" },
                                item_failed: { type: "terminal", outcome: "failed" },
                            },
                        },
                        transition: { next: { joined: "done", blocked: "failed", failure: "failed" } },
                    },
                    done: { type: "terminal", outcome: "succeeded" },
                    failed: { type: "terminal", outcome: "failed" },
                },
            });
            const compiled = compileWorkflow(validForEachYaml);
            expect(compiled.valid).toBe(true);
            // Tamper the compiled IR so a forEach body agent has session: "continue" (bypassing compiler)
            const corruptIr = JSON.parse(JSON.stringify(compiled.ir));
            corruptIr.nodes.talk.session = "continue";
            const corruptIrText = canonicalJson(corruptIr);
            const corruptIrSha256 = sha256Hex(corruptIrText);

            const parent = randomUUID();
            await h.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            await h.catalog.createWorkflowSession(workflowSessionId, {
                parentSessionId: parent, owner: null, creationConfig: { workflow: { requestSha256: "corrupt-i8" } },
            });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: validForEachYaml,
                compiled: { ...compiled, ir: corruptIr, irText: corruptIrText, irSha256: corruptIrSha256 },
                actor: ACTOR, operationId: "create-corrupt-i8", requestSha256: "corrupt-i8", publish: true, title: "Workflow: corrupt-foreach",
                start: {
                    runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION,
                },
            });
            const nxFan = nodeExecutionIdFor(runId, "root", "fan", 1);
            await h.store.enterNode({
                runId, nodeExecutionId: nxFan, scopeId: "root", nodeId: "fan", ordinal: 1, nodeType: "parallel",
                predecessorId: null, arrivalRoute: null, inputText: canonicalJson([1]), kvRevision: 1, waitSeconds: null, immediate: null,
            });
            const enterFn = h.activities.get(WORKFLOW_ACTIVITIES.enter);
            expect(typeof enterFn).toBe("function");
            await expect(enterFn({ getClient: () => h.client }, {
                runId, scopeId: branchScopeId(nxFan, 0), nodeId: "talk", ordinal: 1, predecessorId: nxFan, arrivalRoute: BRANCH_ROUTE,
            })).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT", message: expect.stringContaining("non-named branch scope") });
        } finally {
            await h.stop();
        }
    });
});
