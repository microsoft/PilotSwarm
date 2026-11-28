/**
 * Child Workflows ended-message tests (T8, T9/T17 real notifier twice, T10, A6 legacy IR, A7 16KB + unwrappable depth):
 * - T8: WorkflowEnded@1 with a pending receive completes in the same tx; without one, next receive takes it at once.
 * - T9/T17: Running the real workflow.notifyParent activity twice (even after clearing workflow.parent_notified) creates 1 inbox row.
 * - T10: WorkflowEnded@1 accepted at 100 waiting regular messages.
 * - A6: Legacy pinned IR declaring WorkflowEnded@1 still refuses direct sendTypedWorkflowInput (UNSUPPORTED_CONTRACT).
 * - A7: Child output >16 KB sets outputTruncated: true with no output; unwrappable deep output falls back cleanly without throwing.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { sendTypedWorkflowInput } from "../../src/workflow/service.ts";
import { registerWorkflow, WORKFLOW_ACTIVITIES } from "../../src/workflow/runtime.ts";
import { WORKFLOW_ENDED_CONTRACT } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { nodeExecutionIdFor, typedInputRequestSha256, WORKFLOW_INBOX_LIMITS, WORKFLOW_INPUT_TTL_SECONDS } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "child-ended-store" };
const ENGINE = { kind: "system", name: "child-ended-store-test" };

const PARENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-recv, version: "1.0.0" }
contracts:
  Ping@1: { schema: { type: object } }
initial: wait_ended
states:
  wait_ended:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: child-job, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 60, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

describe("Child Workflows WorkflowEnded@1 inbox delivery, A6, A7 & T9/T17", () => {
    it("T8, T9/T17 real notifier dedupe, T10 cap bypass, A6 legacy IR guard, and A7 16KB/depth fallback", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const wakes = [];
            const duroxideClient = {
                startOrchestrationVersioned: async () => {},
                getStatus: async () => ({ status: "Running" }),
                enqueueEvent: async (id, q, data) => { wakes.push({ id, q, data }); },
            };
            const host = { catalog: h.catalog, store: h.store, duroxideClient };
            // Capture real workflow.notifyParent activity handler from registerWorkflow
            const activities = new Map();
            registerWorkflow({
                registerOrchestrationVersioned: () => {},
                registerActivity: (name, fn) => { activities.set(name, fn); },
            }, {
                store: h.store, catalog: h.catalog, enabled: () => true,
                resolveToolBinding: async () => null,
                openToolExecutor: async () => { throw new Error("unused"); },
                authorizeParentNotification: async () => true,
                notifyParent: async () => ({ delivered: true }),
                deleteSession: async () => {},
            });
            const notifyParent = activities.get(WORKFLOW_ACTIVITIES.notifyParent);
            const actx = { getClient: () => duroxideClient, isCancelled: () => false, traceWarn: () => {} };

            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });

            await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chat, name: "parent-recv", yaml: PARENT_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-p", by: "session",
            });
            await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chat, name: "child-job", yaml: CHILD_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-c", by: "session",
            });
            const parent = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-recv" }, inputs: {},
                actor: ENGINE, operationId: "start-p", owner: OWNER,
            });

            const spawnChildDirect = async (ordinal) => {
                const nx = nodeExecutionIdFor(parent.runId, "root", "launch", ordinal);
                await h.store.enterNode({
                    runId: parent.runId, nodeExecutionId: nx, scopeId: "root", nodeId: "launch", ordinal,
                    nodeType: "spawn", predecessorId: null, arrivalRoute: null, inputText: "{}",
                    kvRevision: 1, waitSeconds: null, immediate: null,
                });
                return startSessionWorkflowDefinition(host, {
                    ownerSessionId: chat, parentSessionId: parent.workflowId, spawn: { nodeExecutionId: nx },
                    definition: { name: "child-job" }, inputs: {},
                    actor: ENGINE, operationId: nx, owner: OWNER,
                });
            };

            const child1 = await spawnChildDirect(1);
            const child2 = await spawnChildDirect(2);
            const childLarge = await spawnChildDirect(3);
            const childDeep = await spawnChildDirect(4);

            // T8a: Pending receive exists -> real notifyParent claims it in same tx.
            const recv1 = nodeExecutionIdFor(parent.runId, "root", "wait_ended", 1);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: recv1, scopeId: "root", nodeId: "wait_ended", ordinal: 1,
                nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: 60, immediate: null,
                receive: { contract: WORKFLOW_ENDED_CONTRACT, from: null, refused: null, correlationText: "{}" },
            });
            await h.q("UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done', terminal_output = '{\"ok\":1}', finished_at = now() WHERE run_id = $1", [child1.runId]);
            await notifyParent(actx, { runId: child1.runId });

            const completedRecv1 = await h.store.readNodeExecution(recv1);
            expect(completedRecv1?.state).toBe("completed");
            expect(completedRecv1?.outcome).toBe("received");
            expect(completedRecv1?.output).toMatchObject({ workflowId: child1.workflowId, status: "completed", output: { ok: 1 }, outputTruncated: false });

            // T9/T17: Simulate worker crash between acceptInput and recording workflow.parent_notified, then run real notifyParent again -> still 1 inbox row!
            await h.q("DELETE FROM SCHEMA.session_events WHERE session_id = $1 AND event_type = 'workflow.parent_notified'", [child1.workflowId]);
            await notifyParent(actx, { runId: child1.runId });
            expect((await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND operation_id = $2", [parent.runId, `ended:${child1.runId}`]))[0].c).toBe(1);

            // A7a: Child output > 16 KB (20 KB) -> delivered with outputTruncated: true and no output field!
            const bigOutput = JSON.stringify({ blob: "x".repeat(20 * 1024) });
            await h.q("UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done', terminal_output = $2, finished_at = now() WHERE run_id = $1", [childLarge.runId, bigOutput]);
            await notifyParent(actx, { runId: childLarge.runId });
            const bigRow = (await h.q("SELECT payload FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND operation_id = $2", [parent.runId, `ended:${childLarge.runId}`]))[0];
            const bigMsg = JSON.parse(bigRow.payload);
            expect(bigMsg.outputTruncated).toBe(true);
            expect(Object.hasOwn(bigMsg, "output")).toBe(false);

            // A7b: Output at max JSON nesting depth (cannot be wrapped inside payload) -> falls back to metadata-only notice, never throws!
            let deep = "leaf";
            for (let i = 0; i < 64; i += 1) deep = { a: deep };
            await h.q("UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done', terminal_output = $2, finished_at = now() WHERE run_id = $1", [childDeep.runId, JSON.stringify(deep)]);
            await notifyParent(actx, { runId: childDeep.runId });
            const deepRow = (await h.q("SELECT payload FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND operation_id = $2", [parent.runId, `ended:${childDeep.runId}`]))[0];
            const deepMsg = JSON.parse(deepRow.payload);
            expect(deepMsg.outputTruncated).toBe(true);
            expect(Object.hasOwn(deepMsg, "output")).toBe(false);

            // A6: Legacy pinned IR declaring WorkflowEnded@1 under contracts still refuses direct sendTypedWorkflowInput (UNSUPPORTED_CONTRACT)!
            const legacyParent = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-recv" }, inputs: {},
                actor: ENGINE, operationId: "start-legacy-p", owner: OWNER,
            });
            const revRow = (await h.q("SELECT ir FROM SCHEMA.workflow_revisions WHERE workflow_session_id = $1 AND revision = 1", [legacyParent.workflowId]))[0];
            const patchedIr = JSON.parse(revRow.ir);
            patchedIr.contracts[WORKFLOW_ENDED_CONTRACT] = { schema: "contract.Ping.v1" };
            const patchedIrText = canonicalJson(patchedIr);
            const { sha256Hex } = await import("../../src/workflow/json.ts");
            const patchedSha = sha256Hex(patchedIrText);
            await h.q("UPDATE SCHEMA.workflow_revisions SET ir = $2, ir_sha256 = $3 WHERE workflow_session_id = $1 AND revision = 1", [legacyParent.workflowId, patchedIrText, patchedSha]);
            await h.q("UPDATE SCHEMA.workflow_runs SET ir_sha256 = $2 WHERE run_id = $1", [legacyParent.runId, patchedSha]);
            await expect(sendTypedWorkflowInput(host, {
                workflowSessionId: legacyParent.workflowId, senderSessionId: chat, operationId: "forged-ended",
                contract: WORKFLOW_ENDED_CONTRACT, payload: { workflowId: "fake" },
            })).rejects.toMatchObject({ code: "UNSUPPORTED_CONTRACT" });

            // T10: Fill parent inbox with 100 waiting regular Ping@1 messages (5 senders x 20 each).
            for (let s = 0; s < 5; s += 1) {
                const sender = randomUUID();
                await h.catalog.createSession(sender, { owner: OWNER });
                for (let m = 0; m < 20; m += 1) {
                    const p = canonicalJson({ s, m });
                    const op = `ping-${s}-${m}`;
                    await h.store.acceptInput({
                        workflowSessionId: parent.workflowId, runId: parent.runId, messageId: randomUUID(),
                        senderSessionId: sender, operationId: op,
                        requestSha256: typedInputRequestSha256({ runId: parent.runId, contract: "Ping@1", correlationText: "{}", payloadText: p, ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS }),
                        contract: "Ping@1", correlationText: "{}", payloadText: p,
                        ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS, limits: WORKFLOW_INBOX_LIMITS,
                    });
                }
            }
            const extraSender = randomUUID();
            await h.catalog.createSession(extraSender, { owner: OWNER });
            await expect(h.store.acceptInput({
                workflowSessionId: parent.workflowId, runId: parent.runId, messageId: randomUUID(),
                senderSessionId: extraSender, operationId: "ping-overflow",
                requestSha256: typedInputRequestSha256({ runId: parent.runId, contract: "Ping@1", correlationText: "{}", payloadText: "{}", ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS }),
                contract: "Ping@1", correlationText: "{}", payloadText: "{}",
                ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS, limits: WORKFLOW_INBOX_LIMITS,
            })).rejects.toMatchObject({ code: "INBOX_FULL" });

            // T10 + T8b: Real notifyParent delivers WorkflowEnded@1 at 100 waiting regular messages, and next receive claims immediately.
            await h.q("UPDATE SCHEMA.workflow_runs SET status = 'failed', terminal_error = '{\"code\":\"timed_out\",\"message\":\"deadline passed\"}', finished_at = now() WHERE run_id = $1", [child2.runId]);
            await notifyParent(actx, { runId: child2.runId });
            const recv2 = nodeExecutionIdFor(parent.runId, "root", "wait_ended", 2);
            const entered2 = await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: recv2, scopeId: "root", nodeId: "wait_ended", ordinal: 2,
                nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: 60, immediate: null,
                receive: { contract: WORKFLOW_ENDED_CONTRACT, from: null, refused: null, correlationText: "{}" },
            });
            expect(entered2.admitted).toBe(true);
            expect(entered2.node.state).toBe("completed");
            expect(entered2.node.outcome).toBe("received");
        } finally {
            await h.stop();
        }
    });

    it("R4 (CW-1 T4): cut child's WorkflowEnded@1 stores cleanly, leaves pending no-from receive pending, and wakes a newer named from receive", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const duroxideClient = {
                startOrchestrationVersioned: async () => {},
                getStatus: async () => ({ status: "Running" }),
                enqueueEvent: async () => {},
            };
            const host = { catalog: h.catalog, store: h.store, duroxideClient };
            const activities = new Map();
            registerWorkflow({
                registerOrchestrationVersioned: () => {},
                registerActivity: (name, fn) => { activities.set(name, fn); },
            }, {
                store: h.store, catalog: h.catalog, enabled: () => true,
                resolveToolBinding: async () => null,
                openToolExecutor: async () => { throw new Error("unused"); },
                authorizeParentNotification: async () => true,
                notifyParent: async () => ({ delivered: true }),
                deleteSession: async () => {},
            });
            const notifyParent = activities.get(WORKFLOW_ACTIVITIES.notifyParent);
            const actx = { getClient: () => duroxideClient, isCancelled: () => false, traceWarn: () => {} };

            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            const forkParentYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-r4, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    join: { first: 1 }
    branches:
      a:
        initial: a_done
        states: { a_done: { type: terminal, outcome: succeeded } }
      b:
        initial: b_spawn
        states:
          b_spawn:
            type: spawn
            definition: child-job
            inputs: {}
            transition: { next: { started: b_hold } }
          b_hold: { type: wait, seconds: 600, transition: { next: { elapsed: b_done } } }
          b_done: { type: terminal, outcome: succeeded }
    transition: { next: { joined: after_recv, blocked: after_recv, failure: failed } }
  after_recv:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
            const sC = await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chat, name: "child-job", yaml: CHILD_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-r4-c", by: "session",
            });
            expect(sC.receipt.valid, JSON.stringify(sC.receipt.diagnostics)).toBe(true);
            const sP = await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chat, name: "parent-r4", yaml: forkParentYaml, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-r4-p", by: "session",
            });
            expect(sP.receipt.valid, JSON.stringify(sP.receipt.diagnostics)).toBe(true);

            const makeCutParentWithChild = async (opTag) => {
                const parent = await startSessionWorkflowDefinition(host, {
                    ownerSessionId: chat, definition: { name: "parent-r4" }, inputs: {},
                    actor: ENGINE, operationId: `start-r4-${opTag}`, owner: OWNER,
                });
                await h.store.beginRun(parent.runId);
                const fanNx = nodeExecutionIdFor(parent.runId, "root", "fan", 1);
                await h.store.enterNode({
                    runId: parent.runId, nodeExecutionId: fanNx, scopeId: "root", nodeId: "fan", ordinal: 1,
                    nodeType: "parallel", predecessorId: null, arrivalRoute: null, inputText: JSON.stringify(["a", "b"]),
                    kvRevision: 1, waitSeconds: null, immediate: null,
                });
                const scopeB = `${fanNx}#1`;
                const nxSpawn = nodeExecutionIdFor(parent.runId, scopeB, "b_spawn", 1);
                await h.store.enterNode({
                    runId: parent.runId, nodeExecutionId: nxSpawn, scopeId: scopeB, nodeId: "b_spawn", ordinal: 1,
                    nodeType: "spawn", predecessorId: fanNx, arrivalRoute: "branch", inputText: "{}",
                    kvRevision: 1, waitSeconds: null, immediate: null,
                });
                const child = await startSessionWorkflowDefinition(host, {
                    ownerSessionId: chat, parentSessionId: parent.workflowId, spawn: { nodeExecutionId: nxSpawn },
                    definition: { name: "child-job" }, inputs: {},
                    actor: ENGINE, operationId: nxSpawn, owner: OWNER,
                });
                await h.store.completeNode(nxSpawn, {
                    outcome: "started", resultKind: "business", winner: "effect",
                    valueText: canonicalJson({ workflowId: child.workflowId, runId: child.runId, definition: "child-job", revision: 1 }),
                });
                const nxHold = nodeExecutionIdFor(parent.runId, scopeB, "b_hold", 2);
                await h.store.enterNode({
                    runId: parent.runId, nodeExecutionId: nxHold, scopeId: scopeB, nodeId: "b_hold", ordinal: 2,
                    nodeType: "wait", predecessorId: nxSpawn, arrivalRoute: "started", inputText: "{}",
                    kvRevision: 1, waitSeconds: 600, immediate: null,
                });
                await h.store.cancelBranchScopes({ runId: parent.runId, scopeIds: [scopeB], reason: "join" });
                await h.q("UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done', terminal_output = '{\"ok\":1}', finished_at = now() WHERE run_id = $1", [child.runId]);
                return { parent, child };
            };

            // Case 1: Only a pending no-`from` receive exists -> T4 stores the row, claimedBy is null, receive stays pending.
            const c1 = await makeCutParentWithChild("anon-only");
            const recvAnon = nodeExecutionIdFor(c1.parent.runId, "root", "after_recv", 1);
            await h.store.enterNode({
                runId: c1.parent.runId, nodeExecutionId: recvAnon, scopeId: "root", nodeId: "after_recv", ordinal: 1,
                nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: 60, immediate: null,
                receive: { contract: WORKFLOW_ENDED_CONTRACT, from: null, refused: null, correlationText: "{}" },
            });
            const op1 = `ended:${c1.child.runId}`;
            const payload1 = canonicalJson({ workflowId: c1.child.workflowId, definition: "child-job", revision: 1, spawnedBy: { stateId: "b_spawn", visit: 1 }, status: "completed", outcome: "succeeded", stateId: "done", output: { ok: 1 }, outputTruncated: false, error: null });
            const res1 = await h.store.acceptInput({
                workflowSessionId: c1.parent.workflowId, runId: c1.parent.runId, messageId: op1,
                senderSessionId: c1.child.workflowId, operationId: op1,
                requestSha256: typedInputRequestSha256({ runId: c1.parent.runId, contract: WORKFLOW_ENDED_CONTRACT, correlationText: "{}", payloadText: payload1, ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS }),
                contract: WORKFLOW_ENDED_CONTRACT, correlationText: "{}", payloadText: payload1,
                ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS, limits: WORKFLOW_INBOX_LIMITS, bypassInboxLimits: true,
            });
            expect(res1.receipt.messageId).toBe(op1);
            expect(res1.receipt.claimedBy).toBeNull();
            expect((await h.store.readNodeExecution(recvAnon))?.state).toBe("pending");
            const inbox1 = await h.q("SELECT consumed_by FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND sender_session_id = $2", [c1.parent.runId, c1.child.workflowId]);
            expect(inbox1).toHaveLength(1);
            expect(inbox1[0].consumed_by).toBeNull();

            // Case 2: Older pending no-`from` receive + newer pending named `from` receive -> T4 skips the older
            // senderless waiter and wakes the newer named waiter (via real notifyParent).
            const c2 = await makeCutParentWithChild("named-over-anon");
            const recvOlderAnon = nodeExecutionIdFor(c2.parent.runId, "root", "after_recv", 1);
            await h.store.enterNode({
                runId: c2.parent.runId, nodeExecutionId: recvOlderAnon, scopeId: "root", nodeId: "after_recv", ordinal: 1,
                nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: 60, immediate: null,
                receive: { contract: WORKFLOW_ENDED_CONTRACT, from: null, refused: null, correlationText: "{}" },
            });
            const recvNewerNamed = nodeExecutionIdFor(c2.parent.runId, "root", "after_recv", 2);
            await h.store.enterNode({
                runId: c2.parent.runId, nodeExecutionId: recvNewerNamed, scopeId: "root", nodeId: "after_recv", ordinal: 2,
                nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: 60, immediate: null,
                receive: { contract: WORKFLOW_ENDED_CONTRACT, from: c2.child.workflowId, refused: null, correlationText: "{}" },
            });
            await notifyParent(actx, { runId: c2.child.runId });
            expect((await h.store.readNodeExecution(recvOlderAnon))?.state).toBe("pending");
            const namedAfter = await h.store.readNodeExecution(recvNewerNamed);
            expect(namedAfter?.state).toBe("completed");
            expect(namedAfter?.outcome).toBe("received");
            expect(namedAfter?.output?.workflowId).toBe(c2.child.workflowId);
        } finally {
            await h.stop();
        }
    });
});
