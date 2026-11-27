/**
 * Issue I1, design review D-2 (whole-PR review P-5): the store's record of a continued visit whose conversation was lost
 * after its report (recordAgentCycleMemoryLost) and the reads of it, on PostgreSQL. Recorded only for a continued session's
 * visit its agent decided while the run is active, and once; read back by the Workflow (read_workflow) and by the next
 * cycle's turn (readAgentCyclesLostBefore), which names the lost cycles before its own.
 *
 * Run: npx vitest run test/local/workflow-agent-memory-store.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { workflowAgentChildSessionId, workflowAgentSessionId } from "../../src/workflow/agent-ids.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-agent-memory-store-test" };
const OWNER = { provider: "test", subject: "memory-store-owner" };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: memory-store, version: "1.0.0" }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "Talk." }
    session: continue
    timeoutSeconds: 3600
    transition: { next: { again: talk, finish: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

async function runOf(h) {
    const compiled = compileWorkflow(YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const parent = randomUUID();
    await h.catalog.createSession(parent, { owner: OWNER });
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: OWNER,
        creationConfig: { workflow: { requestSha256: "memory-store" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: YAML, compiled, actor: ACTOR, operationId: "create",
        requestSha256: "memory-store", publish: true, title: "Workflow: memory-store",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    return { workflowSessionId, runId, parent };
}

/** Visit `ordinal` of the agent state, its child session `child` (null: the visit's own session, as session: new gives). */
async function visitOf(h, run, ordinal, child) {
    const nodeExecutionId = nodeExecutionIdFor(run.runId, "root", "talk", ordinal);
    const childSessionId = child ?? workflowAgentChildSessionId(nodeExecutionId);
    expect(await h.store.enterNode({
        runId: run.runId, nodeExecutionId, scopeId: "root", nodeId: "talk", ordinal, nodeType: "agent", predecessorId: null,
        arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId, controllingSessionId: run.parent, task: { source: "prompt", prompt: "Talk." }, outcomes: ["again", "finish"],
            outputSchema: null, timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true });
    return { nodeExecutionId, childSessionId };
}

const decide = (h, nodeExecutionId, winner) => h.q(`UPDATE SCHEMA.workflow_node_executions SET state = 'completed', outcome = 'again',
    result_kind = 'business', output = 'null', winner = $2, completed_at = now() WHERE node_execution_id = $1`, [nodeExecutionId, winner]);

describe("I1 D-2: the record of a continued visit whose conversation was lost after its report", () => {
    it("is written once, for a continued visit its agent decided while the run is active, and read back by cycle", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await runOf(h);
            const child = workflowAgentSessionId(run.runId, "talk");
            const record = (visit, reason = "reply_limit", childSessionId = child) =>
                h.store.recordAgentCycleMemoryLost({ nodeExecutionId: visit.nodeExecutionId, childSessionId, reason });
            const v1 = await visitOf(h, run, 1, child);
            // A visit still open, and a visit its time limit decided (winner controller), record nothing.
            expect(await record(v1)).toEqual({ recorded: false });
            await decide(h, v1.nodeExecutionId, "controller");
            expect(await record(v1)).toEqual({ recorded: false });
            // A visit its agent decided records once; another session's claim and a repeat record nothing.
            const v2 = await visitOf(h, run, 2, child);
            await decide(h, v2.nodeExecutionId, "agent");
            expect(await record(v2, "reply_limit", randomUUID())).toEqual({ recorded: false });
            expect(await record(v2)).toEqual({ recorded: true });
            expect(await record(v2, "session_lost")).toEqual({ recorded: false });
            const lost = await h.store.readAgentCycleMemoryLost(run.workflowSessionId);
            expect([...lost.keys()]).toEqual([v2.nodeExecutionId]);
            expect(lost.get(v2.nodeExecutionId)).toMatchObject({ cycle: 2, reason: "reply_limit", childSessionId: child });
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 100, ["workflow.agent_cycle_memory_lost"]);
            expect(events.map(event => event.data)).toEqual([{ runId: run.runId, nodeExecutionId: v2.nodeExecutionId, stateId: "talk",
                childSessionId: child, cycle: 2, reason: "reply_limit" }]);
            // The next cycle's turn reads its own cycle and the lost ones before it; the lost visit itself reads none.
            const v3 = await visitOf(h, run, 3, child);
            expect(await h.store.readAgentCyclesLostBefore(child, v3.nodeExecutionId)).toEqual({ cycle: 3, lost: [2] });
            expect(await h.store.readAgentCyclesLostBefore(child, v2.nodeExecutionId)).toEqual({ cycle: 0, lost: [] });
            expect(await h.store.readAgentCyclesLostBefore(randomUUID(), v3.nodeExecutionId)).toBeNull();
            // A run that ended has no later cycle: nothing is recorded.
            await decide(h, v3.nodeExecutionId, "agent");
            await h.q("UPDATE SCHEMA.workflow_runs SET status = 'completed', finished_at = now() WHERE run_id = $1", [run.runId]);
            expect(await record(v3)).toEqual({ recorded: false });
        } finally {
            await h.stop();
        }
    });

    it("records nothing for a session: new visit (its own session, no later cycle in it)", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await runOf(h);
            const visit = await visitOf(h, run, 1, null);
            await decide(h, visit.nodeExecutionId, "agent");
            expect(await h.store.recordAgentCycleMemoryLost({ nodeExecutionId: visit.nodeExecutionId, childSessionId: visit.childSessionId,
                reason: "reply_limit" })).toEqual({ recorded: false });
            expect((await h.store.readAgentCycleMemoryLost(run.workflowSessionId)).size).toBe(0);
        } finally {
            await h.stop();
        }
    });
});
