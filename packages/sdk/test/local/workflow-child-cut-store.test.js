/**
 * Child Workflow CW-1 minimal store tests (R1–R3, R11).
 *
 * Exercises the real store cut paths on PostgreSQL under the minimal CW-1 rule:
 * a receive with no `from` never takes `WorkflowEnded@1` from a cut branch's child,
 * while a receive that names the child with `from` keeps working and T4 still stores the row.
 *
 * - R1: Cut of a three-branch fork (winner terminal, errored unrouted error, loser cut):
 *   T4 accepts loser's notice, two no-`from` receives take only winner and errored, and a
 *   third no-`from` receive stays pending.
 * - R2: Notice stored BEFORE the cut is not taken by a later no-`from` receive across
 *   `cancelBranchScopes`, `decideParallelJoin`, and `elapseParallelNode`; a claim made
 *   before the cut stands.
 * - R3: Between-states loser (`ended = finished`, no pending row, no terminal row, no own error)
 *   after its fork is decided (`F.state = 'completed'`, rule 2).
 * - R11 (V3-C1): Branch `spawn` started -> pending `receive` whose ONLY route is `received`
 *   (no `failure` route) -> cut cancels that receive -> branch classified `cancelled` (not `error`)
 *   -> no-`from` receive stays pending while an independently admitted named `from` receive takes it.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { WORKFLOW_ENDED_CONTRACT } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { branchScopeId, parallelBranchStates } from "../../src/workflow/parallel.ts";
import {
    nodeExecutionIdFor, typedInputRequestSha256, WORKFLOW_INBOX_LIMITS, WORKFLOW_INPUT_TTL_SECONDS,
} from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "child-cut-store" };
const ENGINE = { kind: "system", name: "child-cut-store-test" };

const CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: cut-child, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

/** Named fork with two branches (fast, slow), join first 1, and a time limit for elapseParallelNode. */
const NAMED_FORK_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-named-fork, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    join: { first: 1 }
    timeoutSeconds: 60
    branches:
      fast:
        initial: f_spawn
        states:
          f_spawn:
            type: spawn
            definition: cut-child
            inputs: {}
            transition: { next: { started: f_done, failure: f_fail } }
          f_done: { type: terminal, outcome: succeeded, output: { branch: "fast" } }
          f_fail: { type: terminal, outcome: failed }
      slow:
        initial: s_spawn
        states:
          s_spawn:
            type: spawn
            definition: cut-child
            inputs: {}
            transition: { next: { started: s_hold, failure: s_fail } }
          s_hold: { type: wait, seconds: 600, transition: { next: { elapsed: s_done } } }
          s_done: { type: terminal, outcome: succeeded, output: { branch: "slow" } }
          s_fail: { type: terminal, outcome: failed }
    transition: { next: { joined: after_recv, blocked: after_recv, timed_out: after_recv, failure: failed } }
  after_recv:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** Three-branch named fork with an unrouted-error branch, a terminal branch, and a cut branch. */
const THREE_BRANCH_FORK_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-three-branch, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    join: { first: 1 }
    branches:
      winner:
        initial: w_spawn
        states:
          w_spawn:
            type: spawn
            definition: cut-child
            inputs: {}
            transition: { next: { started: w_done } }
          w_done: { type: terminal, outcome: succeeded, output: { branch: "winner" } }
      errored:
        initial: e_spawn
        states:
          e_spawn:
            type: spawn
            definition: cut-child
            inputs: {}
            transition: { next: { started: e_step } }
          e_step:
            type: script
            source: "await setResult('ok', {});"
            transition: { next: { ok: e_done } }
          e_done: { type: terminal, outcome: succeeded }
      loser:
        initial: l_spawn
        states:
          l_spawn:
            type: spawn
            definition: cut-child
            inputs: {}
            transition: { next: { started: l_hold } }
          l_hold: { type: wait, seconds: 600, transition: { next: { elapsed: l_done } } }
          l_done: { type: terminal, outcome: succeeded }
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

/** V3-C1: branch has spawn -> receive whose ONLY route is `received` (no failure route). */
const V3_C1_FORK_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-v3c1, version: "1.0.0" }
contracts:
  Ping@1: { schema: { type: object } }
initial: fan
states:
  fan:
    type: parallel
    join: { first: 1 }
    branches:
      winner:
        initial: w_done
        states:
          w_done: { type: terminal, outcome: succeeded, output: { branch: "winner" } }
      cut_recv:
        initial: c_spawn
        states:
          c_spawn:
            type: spawn
            definition: cut-child
            inputs: {}
            transition: { next: { started: c_recv } }
          c_recv:
            type: messaging
            mode: receive
            contract: Ping@1
            transition: { next: { received: c_done } }
          c_done: { type: terminal, outcome: succeeded }
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

async function setupFixture(env) {
    const h = await openWorkflowStore(env);
    const duroxideClient = {
        startOrchestrationVersioned: async () => {},
        getStatus: async () => ({ status: "Running" }),
        enqueueEvent: async () => {},
    };
    const host = { catalog: h.catalog, store: h.store, duroxideClient };
    const chat = randomUUID();
    await h.catalog.createSession(chat, { owner: OWNER });
    for (const [name, yaml] of [
        ["cut-child", CHILD_YAML],
        ["parent-named-fork", NAMED_FORK_YAML],
        ["parent-three-branch", THREE_BRANCH_FORK_YAML],
        ["parent-v3c1", V3_C1_FORK_YAML],
    ]) {
        const saved = await saveSessionWorkflowDefinition(host, {
            ownerSessionId: chat, name, yaml, expected: null,
            actor: { kind: "session", sessionId: chat }, operationId: `save-${name}`, by: "session",
        });
        expect(saved.receipt.valid, JSON.stringify(saved.receipt.diagnostics)).toBe(true);
    }

    const spawnInBranch = async (parent, scopeId, nodeId, ordinal, predecessorId, completeSpawn = true) => {
        const nx = nodeExecutionIdFor(parent.runId, scopeId, nodeId, ordinal);
        await h.store.enterNode({
            runId: parent.runId, nodeExecutionId: nx, scopeId, nodeId, ordinal,
            nodeType: "spawn", predecessorId, arrivalRoute: "branch", inputText: "{}",
            kvRevision: 1, waitSeconds: null, immediate: null,
        });
        const child = await startSessionWorkflowDefinition(host, {
            ownerSessionId: chat, parentSessionId: parent.workflowId, spawn: { nodeExecutionId: nx },
            definition: { name: "cut-child" }, inputs: {},
            actor: ENGINE, operationId: nx, owner: OWNER,
        });
        if (completeSpawn) {
            await h.store.completeNode(nx, {
                outcome: "started", resultKind: "business", winner: "effect",
                valueText: canonicalJson({ workflowId: child.workflowId, runId: child.runId, definition: "cut-child", revision: 1 }),
            });
        }
        return { nx, child };
    };

    const endChildAndAccept = async (parent, child, tag) => {
        await h.q(
            "UPDATE SCHEMA.workflow_runs SET status = 'completed', terminal_outcome = 'succeeded', terminal_node_id = 'done', terminal_output = $2, finished_at = clock_timestamp() WHERE run_id = $1",
            [child.runId, canonicalJson({ tag })],
        );
        const opId = `ended:${child.runId}`;
        const payloadText = canonicalJson({
            workflowId: child.workflowId, definition: "cut-child", revision: 1,
            spawnedBy: null, status: "completed", outcome: "succeeded", stateId: "done",
            output: { tag }, outputTruncated: false, error: null,
        });
        const requestSha256 = typedInputRequestSha256({
            runId: parent.runId, contract: WORKFLOW_ENDED_CONTRACT, correlationText: "{}",
            payloadText, ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS,
        });
        return h.store.acceptInput({
            workflowSessionId: parent.workflowId, runId: parent.runId, messageId: opId,
            senderSessionId: child.workflowId, operationId: opId, requestSha256,
            contract: WORKFLOW_ENDED_CONTRACT, correlationText: "{}", payloadText,
            ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS, limits: WORKFLOW_INBOX_LIMITS,
            bypassInboxLimits: true,
        });
    };

    const enterEndedReceive = async (parent, ordinal, from = null) => {
        const nx = nodeExecutionIdFor(parent.runId, "root", "after_recv", ordinal);
        return h.store.enterNode({
            runId: parent.runId, nodeExecutionId: nx, scopeId: "root", nodeId: "after_recv", ordinal,
            nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null",
            kvRevision: 1, waitSeconds: 60, immediate: null,
            receive: { contract: WORKFLOW_ENDED_CONTRACT, from, refused: from === null ? null : {}, correlationText: "{}" },
        });
    };

    return { h, host, chat, spawnInBranch, endChildAndAccept, enterEndedReceive };
}

describe("Child Workflow CW-1 minimal store tests (R1–R3, R11)", () => {
    it("R1: T4 accepts cut loser's notice, two no-from receives take only winner and own-error children, third no-from receive stays pending", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, spawnInBranch, endChildAndAccept, enterEndedReceive } = await setupFixture(getEnv());
        try {
            const parent = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-three-branch" }, inputs: {},
                actor: ENGINE, operationId: "start-r1", owner: OWNER,
            });
            await h.store.beginRun(parent.runId);
            const fanNx = nodeExecutionIdFor(parent.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: fanNx, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["winner", "errored", "loser"]),
                kvRevision: 1, waitSeconds: null, immediate: null,
            });

            const scopeWinner = branchScopeId(fanNx, 0);
            const scopeError = branchScopeId(fanNx, 1);
            const scopeLoser = branchScopeId(fanNx, 2);

            // Branch 0 (winner): spawn -> terminal succeeded
            const { nx: wSpawn, child: cWinner } = await spawnInBranch(parent, scopeWinner, "w_spawn", 1, fanNx);
            const wDone = nodeExecutionIdFor(parent.runId, scopeWinner, "w_done", 2);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: wDone, scopeId: scopeWinner, nodeId: "w_done", ordinal: 2,
                nodeType: "terminal", predecessorId: wSpawn, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: null, immediate: { outcome: "succeeded", resultKind: "business", winner: "controller", valueText: '{"branch":"winner"}' },
            });

            // Branch 1 (errored): spawn -> script completes with an unrouted runtime error (ended = error)
            const { nx: eSpawn, child: cError } = await spawnInBranch(parent, scopeError, "e_spawn", 1, fanNx);
            const eStep = nodeExecutionIdFor(parent.runId, scopeError, "e_step", 2);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: eStep, scopeId: scopeError, nodeId: "e_step", ordinal: 2,
                nodeType: "script", predecessorId: eSpawn, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: null, immediate: null,
            });
            await h.store.completeNode(eStep, {
                outcome: "runtime_error", resultKind: "runtime_error", winner: "effect",
                valueText: canonicalJson({ code: "script_failed", message: "boom" }),
            });

            // Branch 2 (loser): spawn -> pending wait (cut!)
            const { nx: lSpawn, child: cLoser } = await spawnInBranch(parent, scopeLoser, "l_spawn", 1, fanNx);
            const lHold = nodeExecutionIdFor(parent.runId, scopeLoser, "l_hold", 2);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: lHold, scopeId: scopeLoser, nodeId: "l_hold", ordinal: 2,
                nodeType: "wait", predecessorId: lSpawn, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: 600, immediate: null,
            });

            // Cut all three scopes: only loser has a pending state cancelled; winner (terminal) and errored (error) are not cut.
            const cutRes = await h.store.cancelBranchScopes({ runId: parent.runId, scopeIds: [scopeWinner, scopeError, scopeLoser], reason: "join" });
            expect(cutRes.cancelled.map(c => c.nodeExecutionId)).toEqual([lHold]);

            // T4 accepts loser's notice FIRST (lowest seq), then winner and errored.
            const loserAccepted = await endChildAndAccept(parent, cLoser, "loser");
            expect(loserAccepted.receipt?.messageId).toBeTruthy();
            const loserInbox = await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND sender_session_id = $2", [parent.runId, cLoser.workflowId]);
            expect(loserInbox[0].c).toBe(1);

            await endChildAndAccept(parent, cWinner, "winner");
            await endChildAndAccept(parent, cError, "errored");

            // Two receives with no `from` take ONLY winner and errored (skipping loser despite lower seq).
            const r1 = await enterEndedReceive(parent, 1);
            const r2 = await enterEndedReceive(parent, 2);
            expect(r1.node.state).toBe("completed");
            expect(r2.node.state).toBe("completed");
            expect([r1.node.output.workflowId, r2.node.output.workflowId].sort()).toEqual([cWinner.workflowId, cError.workflowId].sort());

            // A third receive with no `from` stays pending (does not take loser's notice).
            const r3 = await enterEndedReceive(parent, 3);
            expect(r3.node.state).toBe("pending");
        } finally {
            await h.stop();
        }
    });

    it("R2: notice stored before cut is not taken by later no-from receive across cancelBranchScopes, decideParallelJoin, and elapseParallelNode; pre-cut claim stands", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, spawnInBranch, endChildAndAccept, enterEndedReceive } = await setupFixture(getEnv());
        try {
            // Case A: cancelBranchScopes cuts slow branch whose child already stored an unconsumed notice.
            const pScopes = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-named-fork" }, inputs: {},
                actor: ENGINE, operationId: "start-r2-scopes", owner: OWNER,
            });
            await h.store.beginRun(pScopes.runId);
            const fanS = nodeExecutionIdFor(pScopes.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: pScopes.runId, nodeExecutionId: fanS, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["fast", "slow"]),
                kvRevision: 1, waitSeconds: 60, immediate: null,
            });
            const sSlowS = branchScopeId(fanS, 1);
            const { nx: sSpawnS, child: cSlowS } = await spawnInBranch(pScopes, sSlowS, "s_spawn", 1, fanS);
            const sHoldS = nodeExecutionIdFor(pScopes.runId, sSlowS, "s_hold", 2);
            await h.store.enterNode({
                runId: pScopes.runId, nodeExecutionId: sHoldS, scopeId: sSlowS, nodeId: "s_hold", ordinal: 2,
                nodeType: "wait", predecessorId: sSpawnS, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: 600, immediate: null,
            });
            await endChildAndAccept(pScopes, cSlowS, "slow-before-cancel-scopes");
            const cutS = await h.store.cancelBranchScopes({ runId: pScopes.runId, scopeIds: [sSlowS], reason: "failFast" });
            expect(cutS.cancelled.map(c => c.nodeExecutionId)).toEqual([sHoldS]);
            const recvAfterScopes = await enterEndedReceive(pScopes, 1);
            expect(recvAfterScopes.node.state).toBe("pending");

            // Case B: decideParallelJoin (join first 1) cuts slow branch whose child already stored a notice (before fast).
            const pJoin = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-named-fork" }, inputs: {},
                actor: ENGINE, operationId: "start-r2-join", owner: OWNER,
            });
            await h.store.beginRun(pJoin.runId);
            const fanJ = nodeExecutionIdFor(pJoin.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: pJoin.runId, nodeExecutionId: fanJ, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["fast", "slow"]),
                kvRevision: 1, waitSeconds: 60, immediate: null,
            });
            const sFastJ = branchScopeId(fanJ, 0);
            const sSlowJ = branchScopeId(fanJ, 1);
            const { nx: fSpawnJ, child: cFastJ } = await spawnInBranch(pJoin, sFastJ, "f_spawn", 1, fanJ);
            const fDoneJ = nodeExecutionIdFor(pJoin.runId, sFastJ, "f_done", 2);
            await h.store.enterNode({
                runId: pJoin.runId, nodeExecutionId: fDoneJ, scopeId: sFastJ, nodeId: "f_done", ordinal: 2,
                nodeType: "terminal", predecessorId: fSpawnJ, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: null, immediate: { outcome: "succeeded", resultKind: "business", winner: "controller", valueText: '{"branch":"fast"}' },
            });
            const { nx: sSpawnJ, child: cSlowJ } = await spawnInBranch(pJoin, sSlowJ, "s_spawn", 1, fanJ);
            const sHoldJ = nodeExecutionIdFor(pJoin.runId, sSlowJ, "s_hold", 2);
            await h.store.enterNode({
                runId: pJoin.runId, nodeExecutionId: sHoldJ, scopeId: sSlowJ, nodeId: "s_hold", ordinal: 2,
                nodeType: "wait", predecessorId: sSpawnJ, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: 600, immediate: null,
            });
            // Slow delivers FIRST, then fast, BEFORE join cuts slow branch.
            await endChildAndAccept(pJoin, cSlowJ, "slow-notice");
            await endChildAndAccept(pJoin, cFastJ, "fast-notice");

            const decided = await h.store.decideParallelJoin({
                nodeExecutionId: fanJ, notStarted: [],
                joined: output => ({ outcome: "joined", resultKind: "business", winner: "controller", valueText: canonicalJson(output) }),
            });
            expect(decided.result).toBe("won");
            expect(decided.node.outcome).toBe("joined");
            expect(decided.cancelled).toEqual([sHoldJ]);

            const recv1 = await enterEndedReceive(pJoin, 1);
            expect(recv1.node.state).toBe("completed");
            expect(recv1.node.output.workflowId).toBe(cFastJ.workflowId);
            const recv2 = await enterEndedReceive(pJoin, 2);
            expect(recv2.node.state).toBe("pending");

            // Case C: elapseParallelNode (real time limit) cuts slow branch whose child already stored a notice.
            const pTimer = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-named-fork" }, inputs: {},
                actor: ENGINE, operationId: "start-r2-timer", owner: OWNER,
            });
            await h.store.beginRun(pTimer.runId);
            const fanT = nodeExecutionIdFor(pTimer.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: pTimer.runId, nodeExecutionId: fanT, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["fast", "slow"]),
                kvRevision: 1, waitSeconds: 60, immediate: null,
            });
            const sFastT = branchScopeId(fanT, 0);
            const sSlowT = branchScopeId(fanT, 1);
            // Fast branch still pending at f_spawn; slow branch pending at s_hold with child already ended.
            const { nx: fSpawnT } = await spawnInBranch(pTimer, sFastT, "f_spawn", 1, fanT, false);
            const { nx: sSpawnT, child: cSlowT } = await spawnInBranch(pTimer, sSlowT, "s_spawn", 1, fanT);
            const sHoldT = nodeExecutionIdFor(pTimer.runId, sSlowT, "s_hold", 2);
            await h.store.enterNode({
                runId: pTimer.runId, nodeExecutionId: sHoldT, scopeId: sSlowT, nodeId: "s_hold", ordinal: 2,
                nodeType: "wait", predecessorId: sSpawnT, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: 600, immediate: null,
            });
            await endChildAndAccept(pTimer, cSlowT, "slow-before-timeout");
            await h.q("UPDATE SCHEMA.workflow_node_executions SET deadline_at = clock_timestamp() - interval '1 second' WHERE node_execution_id = $1", [fanT]);
            const elapsed = await h.store.elapseParallelNode(fanT);
            expect(elapsed.result).toBe("elapsed");
            expect(elapsed.cancelled.sort()).toEqual([fSpawnT, sHoldT].sort());

            const recvAfterTimer = await enterEndedReceive(pTimer, 1);
            expect(recvAfterTimer.node.state).toBe("pending");

            // Green guard: a claim made BEFORE the cut stands.
            const pGuard = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-named-fork" }, inputs: {},
                actor: ENGINE, operationId: "start-r2-guard", owner: OWNER,
            });
            await h.store.beginRun(pGuard.runId);
            const fanG = nodeExecutionIdFor(pGuard.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: pGuard.runId, nodeExecutionId: fanG, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["fast", "slow"]),
                kvRevision: 1, waitSeconds: 60, immediate: null,
            });
            const sSlowG = branchScopeId(fanG, 1);
            const { nx: sSpawnG, child: cSlowG } = await spawnInBranch(pGuard, sSlowG, "s_spawn", 1, fanG);
            const sHoldG = nodeExecutionIdFor(pGuard.runId, sSlowG, "s_hold", 2);
            await h.store.enterNode({
                runId: pGuard.runId, nodeExecutionId: sHoldG, scopeId: sSlowG, nodeId: "s_hold", ordinal: 2,
                nodeType: "wait", predecessorId: sSpawnG, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: 600, immediate: null,
            });
            await endChildAndAccept(pGuard, cSlowG, "consumed-while-owned");
            const recvOwned = await enterEndedReceive(pGuard, 1);
            expect(recvOwned.node.state).toBe("completed");
            expect(recvOwned.node.output.workflowId).toBe(cSlowG.workflowId);
            await h.store.cancelBranchScopes({ runId: pGuard.runId, scopeIds: [sSlowG], reason: "join" });
            const reread = await h.store.readNodeExecution(recvOwned.node.nodeExecutionId);
            expect(reread?.state).toBe("completed");
            expect(reread?.output?.workflowId).toBe(cSlowG.workflowId);
        } finally {
            await h.stop();
        }
    });

    it("R3: between-states loser after its fork is decided (rule 2: F.state = completed, no terminal row, no own error)", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, spawnInBranch, endChildAndAccept, enterEndedReceive } = await setupFixture(getEnv());
        try {
            const parent = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-named-fork" }, inputs: {},
                actor: ENGINE, operationId: "start-r3-decided", owner: OWNER,
            });
            await h.store.beginRun(parent.runId);
            const fan = nodeExecutionIdFor(parent.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["fast", "slow"]),
                kvRevision: 1, waitSeconds: 60, immediate: null,
            });
            const sFast = branchScopeId(fan, 0);
            const sSlow = branchScopeId(fan, 1);

            // Fast branch reaches terminal f_done (succeeded).
            const { nx: fSpawn, child: cFast } = await spawnInBranch(parent, sFast, "f_spawn", 1, fan, true);
            const fDone = nodeExecutionIdFor(parent.runId, sFast, "f_done", 2);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: fDone, scopeId: sFast, nodeId: "f_done", ordinal: 2,
                nodeType: "terminal", predecessorId: fSpawn, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: null, immediate: { outcome: "succeeded", resultKind: "business", winner: "controller", valueText: '{"branch":"fast"}' },
            });

            // Slow branch completed s_spawn (started), with NO s_hold admitted (between states: zero cancelled rows).
            const { child: cSlow } = await spawnInBranch(parent, sSlow, "s_spawn", 1, fan, true);

            // decideParallelJoin settles the fork (F.state = 'completed', no pending row in slow to cancel).
            const decided = await h.store.decideParallelJoin({
                nodeExecutionId: fan, notStarted: [],
                joined: output => ({ outcome: "joined", resultKind: "business", winner: "controller", valueText: canonicalJson(output) }),
            });
            expect(decided.result).toBe("won");
            expect(decided.node.state).toBe("completed");
            expect(decided.node.outcome).toBe("joined");
            expect(decided.cancelled).toEqual([]);

            // Slow child ends and T4 accepts first; then fast child ends and T4 accepts.
            const slowRes = await endChildAndAccept(parent, cSlow, "between-states-after-decision");
            expect(slowRes.receipt?.messageId).toBeTruthy();
            await endChildAndAccept(parent, cFast, "fast-winner");

            // No-from receive 1 skips cSlow (cut by rule 2) and takes cFast; no-from receive 2 stays pending.
            const recv1 = await enterEndedReceive(parent, 1);
            expect(recv1.node.state).toBe("completed");
            expect(recv1.node.output.workflowId).toBe(cFast.workflowId);
            const recv2 = await enterEndedReceive(parent, 2);
            expect(recv2.node.state).toBe("pending");
        } finally {
            await h.stop();
        }
    });

    it("R11 (V3-C1): cut cancelling a receive with only a received route classifies branch as cancelled; no-from stays pending, named from takes it", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, spawnInBranch, endChildAndAccept, enterEndedReceive } = await setupFixture(getEnv());
        try {
            const parent = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-v3c1" }, inputs: {},
                actor: ENGINE, operationId: "start-r11", owner: OWNER,
            });
            await h.store.beginRun(parent.runId);
            const fan = nodeExecutionIdFor(parent.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["winner", "cut_recv"]),
                kvRevision: 1, waitSeconds: null, immediate: null,
            });
            const sWinner = branchScopeId(fan, 0);
            const sCut = branchScopeId(fan, 1);

            // Branch 0 (winner): immediate terminal succeeded.
            const wDone = nodeExecutionIdFor(parent.runId, sWinner, "w_done", 1);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: wDone, scopeId: sWinner, nodeId: "w_done", ordinal: 1,
                nodeType: "terminal", predecessorId: fan, arrivalRoute: "branch", inputText: "{}",
                kvRevision: 1, waitSeconds: null, immediate: { outcome: "succeeded", resultKind: "business", winner: "controller", valueText: '{"branch":"winner"}' },
            });

            // Branch 1 (cut_recv): spawn started, then receive whose ONLY route is `received` (pending).
            const { nx: cSpawn, child: cCut } = await spawnInBranch(parent, sCut, "c_spawn", 1, fan, true);
            const cRecv = nodeExecutionIdFor(parent.runId, sCut, "c_recv", 2);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: cRecv, scopeId: sCut, nodeId: "c_recv", ordinal: 2,
                nodeType: "messaging", predecessorId: cSpawn, arrivalRoute: "started", inputText: "null",
                kvRevision: 1, waitSeconds: null, immediate: null,
                receive: { contract: "Ping@1", from: null, refused: null, correlationText: "{}" },
            });

            // Winner wins; cut cancels c_recv.
            const decided = await h.store.decideParallelJoin({
                nodeExecutionId: fan, notStarted: [],
                joined: output => ({ outcome: "joined", resultKind: "business", winner: "controller", valueText: canonicalJson(output) }),
            });
            expect(decided.result).toBe("won");
            expect(decided.cancelled).toEqual([cRecv]);

            // Verify classifier reports branch 1 as `cancelled` (not `error`, despite c_recv having no failure route).
            const ir = await h.store.readRevisionIr(parent.workflowId, 1);
            const branchNodes = await h.store.listNodeExecutions(parent.runId);
            const states = parallelBranchStates(ir, fan, 2, branchNodes, new Map(), new Set());
            expect(states[1].ended).toBe("cancelled");

            // Child ends and T4 accepts.
            const accepted = await endChildAndAccept(parent, cCut, "v3c1-cut-child");
            expect(accepted.receipt?.messageId).toBeTruthy();

            // After the fork: no-`from` receive stays pending; an independently admitted named `from` receive takes the notice.
            const recvAnon = await enterEndedReceive(parent, 1, null);
            expect(recvAnon.node.state).toBe("pending");
            const recvNamed = await enterEndedReceive(parent, 2, cCut.workflowId);
            expect(recvNamed.node.state).toBe("completed");
            expect(recvNamed.node.output.workflowId).toBe(cCut.workflowId);
        } finally {
            await h.stop();
        }
    });

    it("CW1-H1: large uncut branch with many visits still delivers to a named receive while T5 skips a stored cut", { timeout: TIMEOUT }, async () => {
        const { h, host, chat, spawnInBranch, endChildAndAccept, enterEndedReceive } = await setupFixture(getEnv());
        try {
            const parent = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { name: "parent-named-fork" }, inputs: {},
                actor: ENGINE, operationId: "start-r12-large-uncut", owner: OWNER,
            });
            await h.store.beginRun(parent.runId);
            const fan = nodeExecutionIdFor(parent.runId, "root", "fan", 1);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1,
                nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: JSON.stringify(["fast", "slow"]),
                kvRevision: 1, waitSeconds: 60, immediate: null,
            });
            const sFast = branchScopeId(fan, 0);
            const sSlow = branchScopeId(fan, 1);

            // Fast uncut branch: spawn child, then 50 chained visits with 16 KiB payloads before terminal succeeded.
            const { nx: fSpawn, child: cFast } = await spawnInBranch(parent, sFast, "f_spawn", 1, fan, true);
            const bigOutput = JSON.stringify({ pad: "x".repeat(16_000) });
            let prev = fSpawn;
            for (let i = 2; i <= 51; i++) {
                const nx = nodeExecutionIdFor(parent.runId, sFast, "f_step", i);
                await h.store.enterNode({
                    runId: parent.runId, nodeExecutionId: nx, scopeId: sFast, nodeId: "f_step", ordinal: i,
                    nodeType: "script", predecessorId: prev, arrivalRoute: "next", inputText: "{}",
                    kvRevision: 1, waitSeconds: null,
                    immediate: { outcome: "next", resultKind: "business", winner: "controller", valueText: bigOutput },
                });
                prev = nx;
            }
            const fDone = nodeExecutionIdFor(parent.runId, sFast, "f_done", 52);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: fDone, scopeId: sFast, nodeId: "f_done", ordinal: 52,
                nodeType: "terminal", predecessorId: prev, arrivalRoute: "next", inputText: "{}",
                kvRevision: 1, waitSeconds: null,
                immediate: { outcome: "succeeded", resultKind: "business", winner: "controller", valueText: '{"branch":"fast"}' },
            });

            // Slow cut branch: spawn child + pending s_hold cancelled by join.
            const { nx: sSpawn, child: cSlow } = await spawnInBranch(parent, sSlow, "s_spawn", 1, fan, true);
            const sHold = nodeExecutionIdFor(parent.runId, sSlow, "s_hold", 2);
            await h.store.enterNode({
                runId: parent.runId, nodeExecutionId: sHold, scopeId: sSlow, nodeId: "s_hold", ordinal: 2,
                nodeType: "wait", predecessorId: sSpawn, arrivalRoute: "started", inputText: "{}",
                kvRevision: 1, waitSeconds: 60, immediate: null,
            });
            const decided = await h.store.decideParallelJoin({
                nodeExecutionId: fan, notStarted: [],
                joined: output => ({ outcome: "joined", resultKind: "business", winner: "controller", valueText: canonicalJson(output) }),
            });
            expect(decided.result).toBe("won");
            expect(decided.cancelled).toEqual([sHold]);

            // Cut child ends first and stays stored in inbox.
            const slowRes = await endChildAndAccept(parent, cSlow, "r12-cut-stored");
            expect(slowRes.receipt?.messageId).toBeTruthy();

            // Named receive for the large uncut branch's child waits, then T4 claims its notice directly.
            const recvFastNamed = await enterEndedReceive(parent, 1, cFast.workflowId);
            expect(recvFastNamed.node.state).toBe("pending");
            const fastRes = await endChildAndAccept(parent, cFast, "r12-large-uncut");
            expect(fastRes.receipt?.claimedBy?.nodeExecutionId).toBe(recvFastNamed.node.nodeExecutionId);

            // Senderless T5 still skips the stored cut notice; named T5 can still claim it.
            const recvAnon = await enterEndedReceive(parent, 2, null);
            expect(recvAnon.node.state).toBe("pending");
            const recvSlowNamed = await enterEndedReceive(parent, 3, cSlow.workflowId);
            expect(recvSlowNamed.node.state).toBe("completed");
            expect(recvSlowNamed.node.output.workflowId).toBe(cSlow.workflowId);
        } finally {
            await h.stop();
        }
    });
});
