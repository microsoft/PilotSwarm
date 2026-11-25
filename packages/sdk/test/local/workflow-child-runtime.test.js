/**
 * Child Workflows end-to-end runtime tests on real Duroxide Runtime + PostgreSQL 16:
 * - T11 & T13 (C3): Out-of-order completion (2, 3, 1); failed, timed_out, and tool-cancelled children deliver WorkflowEnded@1.
 * - A1 (T16): Child controller START fails once then succeeds -> effect 1.2.0 retries via storeTagged, one child, started once.
 * - A5: Tool cancel of child BEFORE child begin -> still delivers one WorkflowEnded@1 (status cancelled) to Workflow parent.
 * - C2 (T14): Parameterized over complete, fail, cancel, stop, timeout, delete -> both children end AND parent gets 0 WorkflowEnded@1 after its end.
 * - C4 (T15 + T12): Real chat-end trigger (no manual enqueue!) ends parent + both children; poll loop stays on schedule while child runs.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerWorkflow, WORKFLOW_CONTROLLER_NAME } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { applyOperatorCommandToWorkflow } from "../../src/workflow/service.ts";
import { childWorkflowsFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "child-runtime" };
const ENGINE = { kind: "system", name: "child-runtime-test" };

async function startHarness(env, options = {}) {
    const tag = randomUUID().slice(0, 8);
    const duroxideSchema = `duroxide_cw_${tag}`;
    const cmsSchema = `cms_cw_${tag}`;
    const provider = await PostgresProvider.connectWithSchema(env.store, duroxideSchema);
    const rawClient = new Client(provider);
    const client = options.wrapClient ? options.wrapClient(rawClient) : rawClient;
    const catalog = await PgSessionCatalog.create(env.store, cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const pool = new pg.Pool({ connectionString: env.store });
    const runtime = new Runtime(provider, {
        orchestrationConcurrency: 8,
        workerConcurrency: 8,
        dispatcherPollIntervalMs: 20,
        workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        logLevel: "error",
    });
    const host = { catalog, store, duroxideClient: client, scripts: true };
    registerWorkflow(runtime, {
        store,
        catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => ({ call: async () => { throw new Error("no tools"); }, close: async () => {} }),
        authorizeParentNotification: async () => true,
        notifyParent: async () => ({ delivered: true }),
        deleteSession: async (id) => { await catalog.softDeleteSession(id); },
        wakeBackstopMs: 200,
        spawnChildHost: () => host,
    });
    await runtime.start();
    const waitForRunStatus = async (runId, statuses, timeoutMs = 40_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const run = await store.readRun(runId);
            if (run && statuses.includes(run.status)) return run;
            await new Promise(r => setTimeout(r, 80));
        }
        const last = await store.readRun(runId);
        throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join("|")}; last=${last?.status}`);
    };
    const waitChildren = async (wfId, count, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const list = await store.listChildWorkflows(wfId);
            if (list.length >= count && list.every(c => c.runId)) return list;
            await new Promise(r => setTimeout(r, 80));
        }
        throw new Error(`Expected ${count} children under ${wfId}`);
    };
    return {
        provider, client: rawClient, wrappedClient: client, catalog, store, pool, runtime, host, cmsSchema, waitForRunStatus, waitChildren,
        q: async (sql, params = []) => (await pool.query(sql.replaceAll("SCHEMA", `"${cmsSchema}"`), params)).rows,
        stop: async () => {
            await runtime.shutdown();
            await catalog.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${duroxideSchema}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${cmsSchema}" CASCADE`);
            await pool.end();
        },
    };
}

const SLEEP_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sleep-child, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [id, seconds]
    properties:
      id: { type: integer }
      seconds: { type: integer }
    additionalProperties: false
initial: pause
states:
  pause:
    type: wait
    seconds: "\${inputs.seconds}"
    transition: { next: { elapsed: done } }
  done:
    type: terminal
    outcome: succeeded
    output: { id: "\${inputs.id}" }
`;

const PARENT_THREE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-three, version: "1.0.0" }
initial: s1
states:
  s1:
    type: spawn
    definition: sleep-child
    inputs: { id: 1, seconds: 4 }
    transition: { next: { started: s2, failure: failed } }
  s2:
    type: spawn
    definition: sleep-child
    inputs: { id: 2, seconds: 1 }
    transition: { next: { started: s3, failure: failed } }
  s3:
    type: spawn
    definition: sleep-child
    inputs: { id: 3, seconds: 2 }
    transition: { next: { started: r1, failure: failed } }
  r1:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 30 }
    transition: { next: { received: r2, elapsed: failed, failure: failed } }
  r2:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    carry: { first: "\${input.output.id}" }
    wait: { seconds: 30 }
    transition: { next: { received: r3, elapsed: failed, failure: failed } }
  r3:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    carry: { first: "\${input.carry.first}", second: "\${input.result.output.id}" }
    wait: { seconds: 30 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output:
      order:
        - "\${input.carry.first}"
        - "\${input.carry.second}"
        - "\${input.result.output.id}"
  failed:
    type: terminal
    outcome: failed
`;

const FAIL_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: fail-child, version: "1.0.0" }
initial: wait_short
states:
  wait_short: { type: wait, seconds: 1, transition: { next: { elapsed: boom } } }
  boom: { type: terminal, outcome: failed, output: { reason: "broke" } }
`;

const TIMEOUT_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: timeout-child, version: "1.0.0" }
limits: { timeoutSeconds: 1 }
initial: wait_long
states:
  wait_long: { type: wait, seconds: 60, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

const PARENT_ERRORS_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-errors, version: "1.0.0" }
initial: s_fail
states:
  s_fail:
    type: spawn
    definition: fail-child
    transition: { next: { started: s_timeout, failure: failed } }
  s_timeout:
    type: spawn
    definition: timeout-child
    transition: { next: { started: r1, failure: failed } }
  r1:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 30 }
    transition: { next: { received: r2, elapsed: failed, failure: failed } }
  r2:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    carry: { e1: "\${input}" }
    wait: { seconds: 30 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output: { first: "\${input.carry.e1}", second: "\${input.result}" }
  failed:
    type: terminal
    outcome: failed
`;

const PARENT_POLL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-poll, version: "1.0.0" }
initial: spawn_bg
states:
  spawn_bg:
    type: spawn
    definition: sleep-child
    inputs: { id: 99, seconds: 3 }
    transition: { next: { started: tick, failure: failed } }
  tick:
    type: script
    outcomes: [poll, finish]
    source: |
      const prev = context.input?.carry ?? context.input ?? {};
      const polls = (prev.polls ?? 0) + 1;
      const gotEnded = prev.gotEnded || (context.input?.result?.workflowId ? true : false);
      const endedId = prev.endedId ?? context.input?.result?.output?.id ?? null;
      if (polls >= 3 && gotEnded) {
        await setResult("finish", { polls, endedId });
      } else {
        await setResult("poll", { polls, gotEnded, endedId });
      }
    transition: { next: { poll: wait_or_recv, finish: done, failure: failed } }
  wait_or_recv:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    carry: { polls: "\${input.polls}", gotEnded: "\${input.gotEnded}", endedId: "\${input.endedId}" }
    wait: { seconds: 1 }
    transition: { next: { received: tick, elapsed: tick, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
`;

const PARENT_HOLD_YAML = (name, waitSeconds, terminalOutcome = "succeeded", runTimeout = null) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
${runTimeout ? `limits: { timeoutSeconds: ${runTimeout} }` : ""}
initial: s1
states:
  s1:
    type: spawn
    definition: sleep-child
    inputs: { id: 1, seconds: 300 }
    transition: { next: { started: s2, failure: failed } }
  s2:
    type: spawn
    definition: sleep-child
    inputs: { id: 2, seconds: 300 }
    transition: { next: { started: hold, failure: failed } }
  hold:
    type: wait
    seconds: ${waitSeconds}
    transition: { next: { elapsed: end_state } }
  end_state:
    type: terminal
    outcome: ${terminalOutcome}
  failed:
    type: terminal
    outcome: failed
`;

describe("Child Workflows end-to-end runtime (T11-T16, A1, A5, C2-C4)", () => {
    it("T11, T12, T13: out-of-order (2,3,1), poll loop schedule with background child, and failed/timed_out children", { timeout: TIMEOUT }, async () => {
        const h = await startHarness(getEnv());
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            for (const [name, yaml] of [
                ["sleep-child", SLEEP_CHILD_YAML],
                ["parent-three", PARENT_THREE_YAML],
                ["fail-child", FAIL_CHILD_YAML],
                ["timeout-child", TIMEOUT_CHILD_YAML],
                ["parent-errors", PARENT_ERRORS_YAML],
                ["parent-poll", PARENT_POLL_YAML],
            ]) {
                const saved = await saveSessionWorkflowDefinition(h.host, {
                    ownerSessionId: chat, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: chat }, operationId: `save-${name}`, by: "session",
                });
                expect(saved.receipt.valid, JSON.stringify(saved.receipt.diagnostics)).toBe(true);
            }

            // T11: spawn 3 children (4s, 1s, 2s) -> received in order 2, 3, 1.
            const p1 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "parent-three" }, inputs: {},
                actor: ENGINE, operationId: "start-t11", owner: OWNER,
            });
            const p1End = await h.waitForRunStatus(p1.runId, ["completed", "failed"]);
            expect(p1End.status).toBe("completed");
            expect(p1End.terminalOutput).toEqual({ order: [2, 3, 1] });

            // T13: failed child + timed_out child each deliver WorkflowEnded@1 with status & error.
            const p2 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "parent-errors" }, inputs: {},
                actor: ENGINE, operationId: "start-t13", owner: OWNER,
            });
            const p2End = await h.waitForRunStatus(p2.runId, ["completed", "failed"]);
            expect(p2End.status).toBe("completed");
            const msgs = [p2End.terminalOutput.first, p2End.terminalOutput.second];
            expect(msgs.find(m => m.definition === "fail-child")).toMatchObject({ status: "failed", outcome: "failed", stateId: "boom", output: { reason: "broke" } });
            expect(msgs.find(m => m.definition === "timeout-child")).toMatchObject({ status: "failed", error: { code: "timed_out" } });

            // T12: poll loop runs on schedule while background child runs 3s, then collects its ended message once.
            const pPoll = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "parent-poll" }, inputs: {},
                actor: ENGINE, operationId: "start-t12", owner: OWNER,
            });
            const pPollEnd = await h.waitForRunStatus(pPoll.runId, ["completed", "failed"]);
            expect(pPollEnd.status).toBe("completed");
            expect(pPollEnd.terminalOutput.polls).toBeGreaterThanOrEqual(3);
            expect(pPollEnd.terminalOutput.endedId).toBe(99);
            const pollChildren = await h.store.listChildWorkflows(pPoll.workflowId);
            expect(pollChildren).toHaveLength(1);
            const childEndedAt = pollChildren[0].endedAt;
            expect(childEndedAt).not.toBeNull();
            const pollsBeforeChildEnd = (await h.q(
                "SELECT count(*)::int AS c FROM SCHEMA.workflow_node_executions WHERE run_id = $1 AND node_id = 'tick' AND state = 'completed' AND completed_at < $2",
                [pPoll.runId, childEndedAt],
            ))[0].c;
            expect(pollsBeforeChildEnd).toBeGreaterThanOrEqual(2);
            const pollInboxCount = (await h.q(
                "SELECT count(*)::int AS c FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND contract = 'WorkflowEnded@1'",
                [pPoll.runId],
            ))[0].c;
            expect(pollInboxCount).toBe(1);
        } finally {
            await h.stop();
        }
    });

    it("A1 (T16) & A5: spawn retries transient controller START failure once -> one child started; pre-begin tool cancel still delivers WorkflowEnded@1", { timeout: TIMEOUT }, async () => {
        let failedFirstChildStart = false;
        let childStarts = 0;
        let parentWorkflowId = null;
        const h = await startHarness(getEnv(), {
            wrapClient: (raw) => new Proxy(raw, {
                get(target, prop) {
                    if (prop === "startOrchestrationVersioned") {
                        return async (instanceId, name, input, version) => {
                            if (name === WORKFLOW_CONTROLLER_NAME && parentWorkflowId && instanceId !== `session-${parentWorkflowId}`) {
                                childStarts += 1;
                                if (!failedFirstChildStart) {
                                    failedFirstChildStart = true;
                                    throw new Error("Simulated transient duroxide START failure");
                                }
                            }
                            return target.startOrchestrationVersioned(instanceId, name, input, version);
                        };
                    }
                    const val = target[prop];
                    return typeof val === "function" ? val.bind(target) : val;
                },
            }),
        });
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            const oneSpawnYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-retry, version: "1.0.0" }
initial: s1
states:
  s1:
    type: spawn
    definition: sleep-child
    inputs: { id: 7, seconds: 1 }
    transition: { next: { started: r1, failure: failed } }
  r1:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 30 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;
            await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "sleep-child", yaml: SLEEP_CHILD_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-c", by: "session",
            });
            await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "parent-retry", yaml: oneSpawnYaml, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-p", by: "session",
            });
            const p = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "parent-retry" }, inputs: {},
                actor: ENGINE, operationId: "start-a1", owner: OWNER,
            });
            parentWorkflowId = p.workflowId;
            const end = await h.waitForRunStatus(p.runId, ["completed", "failed"]);
            expect(end.status).toBe("completed");
            expect(failedFirstChildStart).toBe(true);
            expect(childStarts).toBeGreaterThanOrEqual(2);
            const children = await h.store.listChildWorkflows(p.workflowId);
            expect(children).toHaveLength(1);
            expect(end.terminalOutput).toMatchObject({ workflowId: children[0].workflowSessionId, status: "completed", output: { id: 7 } });

            // A5: cancel child via child_workflows tool BEFORE child controller begins -> parent still receives WorkflowEnded@1!
            const parentRecv = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "parent-retry" }, inputs: {},
                actor: ENGINE, operationId: "start-a5-parent", owner: OWNER,
            });
            // Create a child whose controller is NOT dispatched (stays admitted / pre-begin)
            const noDispatchHost = {
                catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "NotFound" }), enqueueEvent: async () => {} },
            };
            const nxA5 = `nx-a5-${randomUUID()}`;
            await h.store.enterNode({
                runId: parentRecv.runId, nodeExecutionId: nxA5, scopeId: "root", nodeId: "go", ordinal: 99,
                nodeType: "spawn", predecessorId: null, arrivalRoute: null, inputText: "{}",
                kvRevision: 1, waitSeconds: null, immediate: null,
            });
            const preBeginChild = await startSessionWorkflowDefinition(noDispatchHost, {
                ownerSessionId: chat, parentSessionId: parentRecv.workflowId, spawn: { nodeExecutionId: nxA5 },
                definition: { name: "sleep-child" }, inputs: { id: 88, seconds: 60 },
                actor: ENGINE, operationId: nxA5, owner: OWNER,
            });
            expect((await h.store.readRun(preBeginChild.runId))?.status).toBe("admitted");
            // Cancel before begin through child_workflows tool with the REAL client (so notifier orchestration runs!)
            const cancelAns = JSON.parse(await childWorkflowsFromTool({
                operation: "cancel", workflow_id: preBeginChild.workflowId, operation_id: "cancel-pre-begin", reason: "too early",
            }, { callerWorkflowSessionId: parentRecv.workflowId, host: h.host }));
            expect(cancelAns.ok).toBe(true);
            // Wait for notifier to deliver WorkflowEnded@1 to parentRecv\x27s inbox!
            const deadline = Date.now() + 20_000;
            let endedRows = [];
            while (Date.now() < deadline) {
                endedRows = await h.q("SELECT payload FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND sender_session_id = $2", [parentRecv.runId, preBeginChild.workflowId]);
                if (endedRows.length > 0) break;
                await new Promise(r => setTimeout(r, 80));
            }
            expect(endedRows).toHaveLength(1);
            expect(JSON.parse(endedRows[0].payload)).toMatchObject({ workflowId: preBeginChild.workflowId, status: "cancelled" });
        } finally {
            await h.stop();
        }
    });

    it("C2 (T14 all 6 parent end modes) & C4 (T15 real chat-end trigger): children end and parent gets zero WorkflowEnded@1 after end", { timeout: TIMEOUT }, async () => {
        const h = await startHarness(getEnv());
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "sleep-child", yaml: SLEEP_CHILD_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-sleep", by: "session",
            });
            for (const [name, yaml] of [
                ["p-complete", PARENT_HOLD_YAML("p-complete", 1, "succeeded")],
                ["p-fail", PARENT_HOLD_YAML("p-fail", 1, "failed")],
                ["p-timeout", PARENT_HOLD_YAML("p-timeout", 300, "succeeded", 2)],
                ["p-long", PARENT_HOLD_YAML("p-long", 300, "succeeded")],
            ]) {
                const s = await saveSessionWorkflowDefinition(h.host, {
                    ownerSessionId: chat, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: chat }, operationId: `save-${name}`, by: "session",
                });
                expect(s.receipt.valid, JSON.stringify(s.receipt.diagnostics)).toBe(true);
            }

            // Parameterized over all 6 parent end modes: complete, fail, timeout, cancel, stop, delete
            for (const mode of ["complete", "fail", "timeout", "cancel", "stop", "delete"]) {
                const defName = mode === "complete" ? "p-complete" : mode === "fail" ? "p-fail" : mode === "timeout" ? "p-timeout" : "p-long";
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: chat, definition: { name: defName }, inputs: {},
                    actor: ENGINE, operationId: `start-t14-${mode}`, owner: OWNER,
                });
                const children = await h.waitChildren(parent.workflowId, 2);
                if (mode === "cancel") {
                    const res = await applyOperatorCommandToWorkflow(h.host, {
                        targetSessionId: parent.workflowId, command: { type: "cmd", cmd: "cancel", id: `op-${mode}`, reason: "t14" },
                    });
                    if (res.action === "enqueue") {
                        await h.client.enqueueEvent(`session-${parent.workflowId}`, "messages", JSON.stringify({ type: "cmd", cmd: "cancel", reason: "t14" }));
                    }
                    await h.waitForRunStatus(parent.runId, ["cancelled"]);
                } else if (mode === "stop") {
                    const stopAns = JSON.parse(await updateWorkflowFromTool({
                        operation: "stop", workflow_id: parent.workflowId, operation_id: `op-stop-${mode}`, grace_seconds: 1, reason: "t14 stop",
                    }, { callerSessionId: chat, host: h.host }));
                    expect(stopAns.ok, JSON.stringify(stopAns)).toBe(true);
                    await h.waitForRunStatus(parent.runId, ["stopped"]);
                } else if (mode === "delete") {
                    await applyOperatorCommandToWorkflow(h.host, {
                        targetSessionId: parent.workflowId, command: { type: "cmd", cmd: "delete", id: `op-${mode}`, reason: "t14 delete" },
                    });
                    await h.waitForRunStatus(parent.runId, ["cancelled"]);
                } else if (mode === "complete") {
                    await h.waitForRunStatus(parent.runId, ["completed"]);
                } else {
                    await h.waitForRunStatus(parent.runId, ["failed"]);
                }

                for (const c of children) {
                    expect((await h.waitForRunStatus(c.runId, ["cancelled"])).status).toBe("cancelled");
                    if (mode === "delete") {
                        expect((await h.store.readSessionLink(c.workflowSessionId))?.deleted).toBe(true);
                    }
                }
                // Wait for every child controller and notifier orchestration to reach a terminal or NotFound state before asserting zero notices.
                const waitTerminalInstance = async (instanceId) => {
                    const deadline = Date.now() + 15_000;
                    while (Date.now() < deadline) {
                        const st = await h.client.getStatus(instanceId);
                        if (!st || ["Completed", "Failed", "Terminated", "NotFound"].includes(st.status)) return;
                        await new Promise(r => setTimeout(r, 50));
                    }
                    throw new Error(`Instance ${instanceId} did not reach terminal state`);
                };
                for (const c of children) {
                    await waitTerminalInstance(`session-${c.workflowSessionId}`);
                    await waitTerminalInstance(`wfn-${c.runId}`);
                }
                const inboxCount = (await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND contract = 'WorkflowEnded@1'", [parent.runId]))[0].c;
                expect(inboxCount, `mode=${mode} should receive zero WorkflowEnded@1`).toBe(0);
            }

            // C4 / T15: real chat-end trigger (ONLY SQL UPDATE on chat session, NO manual enqueue!) ends parent + both children!
            const chat2 = randomUUID();
            await h.catalog.createSession(chat2, { owner: OWNER });
            await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat2, name: "sleep-child", yaml: SLEEP_CHILD_YAML, expected: null,
                actor: { kind: "session", sessionId: chat2 }, operationId: "save-c2", by: "session",
            });
            await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat2, name: "p-long", yaml: PARENT_HOLD_YAML("p-long", 300, "succeeded"), expected: null,
                actor: { kind: "session", sessionId: chat2 }, operationId: "save-p2", by: "session",
            });
            const pChat = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat2, definition: { name: "p-long" }, inputs: {},
                actor: ENGINE, operationId: "start-t15-trigger", owner: OWNER,
            });
            const childrenT15 = await h.waitChildren(pChat.workflowId, 2);
            // Fire ONLY the real workflow_on_owner_session_ended DB trigger (no manual enqueueEvent!).
            await h.q("UPDATE SCHEMA.sessions SET state = 'completed', updated_at = now() WHERE session_id = $1", [chat2]);
            expect((await h.waitForRunStatus(pChat.runId, ["cancelled"])).status).toBe("cancelled");
            for (const c of childrenT15) {
                expect((await h.waitForRunStatus(c.runId, ["cancelled"])).status).toBe("cancelled");
            }
        } finally {
            await h.stop();
        }
    });
});
