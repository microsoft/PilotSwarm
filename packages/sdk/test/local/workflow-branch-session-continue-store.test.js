/**
 * Issue I8 (Task 2): composite visit ordering (COALESCE(p.ordinal, 0), n.ordinal, i.created_at, i.node_execution_id)
 * across all 5 continued-session WorkflowStore queries when an outer loop re-enters a parallel state with named
 * branches (resetting per-scope n.ordinal to 1), plus root-scope (p IS NULL -> 0) regression coverage.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import {
    WORKFLOW_CONTROLLER_VERSION, workflowAgentSessionId, workflowLiveControllerInstanceId,
} from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { branchScopeId } from "../../src/workflow/parallel.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-branch-session-continue-store-test" };

const BRANCH_LOOP_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: branch-loop-store, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    timeoutSeconds: 600
    branches:
      left:
        initial: left_code
        states:
          left_code:
            type: agent
            session: continue
            invoke: { prompt: "Work on left." }
            timeoutSeconds: 300
            outcomes: [again, done]
            transition: { next: { again: left_code, done: left_done, failure: left_failed } }
          left_done: { type: terminal, outcome: succeeded }
          left_failed: { type: terminal, outcome: failed }
    transition: { next: { joined: fan, blocked: failed, timed_out: failed, failure: failed } }
  failed: { type: terminal, outcome: failed }
`;

const ROOT_LOOP_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: root-loop-store, version: "1.0.0" }
initial: talk
states:
  talk:
    type: agent
    session: continue
    invoke: { prompt: "Work at root." }
    timeoutSeconds: 300
    outcomes: [again, done]
    transition: { next: { again: talk, done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

describe("I8 store composite visit ordering (p.ordinal, n.ordinal)", () => {
    it("orders continued branch visits across outer-loop parallel re-entry even when n.ordinal resets to 1 and created_at steps back", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        try {
            await catalog.initialize();
            const store = catalog.workflowStore();
            const compiled = compileWorkflow(BRANCH_LOOP_YAML);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);

            const parent = randomUUID();
            await catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            await catalog.createWorkflowSession(workflowSessionId, {
                parentSessionId: parent, owner: null, creationConfig: { workflow: { requestSha256: "i8-store-1" } },
            });
            await store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: BRANCH_LOOP_YAML, compiled,
                actor: ACTOR, operationId: "create-i8-store-1", requestSha256: "i8-store-1", publish: true, title: "Workflow: branch-loop-store",
                start: {
                    runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION,
                },
            });

            const childSessionId = workflowAgentSessionId(runId, "left_code");
            await catalog.createSession(childSessionId, { parentSessionId: workflowSessionId });

            const admitParallel = async (ordinal, predecessorId) => {
                const nx = nodeExecutionIdFor(runId, "root", "fan", ordinal);
                const res = await store.enterNode({
                    runId, nodeExecutionId: nx, scopeId: "root", nodeId: "fan", ordinal, nodeType: "parallel",
                    predecessorId, arrivalRoute: predecessorId ? "joined" : null, inputText: canonicalJson([null]), kvRevision: 1,
                    waitSeconds: 600, immediate: null,
                });
                expect(res).toMatchObject({ admitted: true });
                return nx;
            };
            const admitBranchAgent = async (scopeId, ordinal, predecessorId, route) => {
                const nx = nodeExecutionIdFor(runId, scopeId, "left_code", ordinal);
                const res = await store.enterNode({
                    runId, nodeExecutionId: nx, scopeId, nodeId: "left_code", ordinal, nodeType: "agent",
                    predecessorId, arrivalRoute: route, inputText: canonicalJson({ scopeId, ordinal }), kvRevision: 1,
                    waitSeconds: null, immediate: null,
                    agent: {
                        childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: "Work on left." },
                        outcomes: ["again", "done"], outputSchema: null, timeoutSeconds: 300,
                    },
                });
                expect(res).toMatchObject({ admitted: true, node: { state: "pending" } });
                return nx;
            };

            // Fork 1 (p.ordinal = 1): two completed visits (n.ordinal = 1, 2)
            const nxFan1 = await admitParallel(1, null);
            const scope1 = branchScopeId(nxFan1, 0);
            const nx11 = await admitBranchAgent(scope1, 1, nxFan1, "branch");
            expect(await store.completeAgentNode({
                childSessionId, operationId: "op-1-1", nodeExecutionId: nx11, call: { outcome: "again", output: { step: "1-1" } },
            })).toMatchObject({ kind: "accepted" });
            const nx12 = await admitBranchAgent(scope1, 2, nx11, "again");
            expect(await store.completeAgentNode({
                childSessionId, operationId: "op-1-2", nodeExecutionId: nx12, call: { outcome: "done", output: { step: "1-2" } },
            })).toMatchObject({ kind: "accepted" });

            // Fork 2 (p.ordinal = 2): visit 1 (n.ordinal resets to 1!), pending, with created_at backdated 5s
            const nxFan2 = await admitParallel(2, nxFan1);
            const scope2 = branchScopeId(nxFan2, 0);
            const nx21 = await admitBranchAgent(scope2, 1, nxFan2, "branch");
            await direct.query(
                `UPDATE "${env.cmsSchema}".workflow_agent_invocations
                    SET created_at = (SELECT created_at - interval '5 seconds' FROM "${env.cmsSchema}".workflow_agent_invocations WHERE node_execution_id = $2)
                  WHERE node_execution_id = $1`,
                [nx21, nx11],
            );

            // 1. readAgentVisitsBefore: nx21 sees 2 prior visits, previous = nx12; null sees 3 visits, previous = nx21
            const before21 = await store.readAgentVisitsBefore(runId, "left_code", nx21);
            expect(before21.count).toBe(2);
            expect(before21.previous?.nodeExecutionId).toBe(nx12);
            const beforeAll = await store.readAgentVisitsBefore(runId, "left_code", null);
            expect(beforeAll.count).toBe(3);
            expect(beforeAll.previous?.nodeExecutionId).toBe(nx21);

            // 2. readAgentInvocationByChild: returns nx21 (pending in fork 2), NOT nx12 (n.ordinal = 2 in fork 1)
            expect((await store.readAgentInvocationByChild(childSessionId))?.nodeExecutionId).toBe(nx21);

            // 3. readTurnVisit: open visit nx21 wins, AND when all are completed nx21 still wins over nx12
            const pid = nx => `workflow:${workflowSessionId}:${runId}:agent:${nx}`;
            await catalog.recordEvents(childSessionId, [{ eventType: "user.message", data: { content: "f1v2", clientMessageIds: [pid(nx12)] } }]);
            await catalog.recordEvents(childSessionId, [{ eventType: "user.message", data: { content: "f2v1", clientMessageIds: [pid(nx21)] } }]);
            expect(await store.readTurnVisit(childSessionId, [pid(nx12), pid(nx21)]))
                .toEqual({ nodeExecutionId: nx21, open: true, inherited: false });
            expect(await store.readTurnVisit(childSessionId, []))
                .toEqual({ nodeExecutionId: nx21, open: true, inherited: true });

            // 4. readWorkflowLineage: binds agentRoot to nx21 both while pending AND after nx21 completes
            expect(await store.readWorkflowLineage(childSessionId))
                .toMatchObject({ sessionId: childSessionId, agentRoot: { childSessionId, nodeExecutionId: nx21, workflowSessionId, distance: 0 } });

            // 5. listAgentInvocationsOfState: chronological [nx11, nx12, nx21]
            expect((await store.listAgentInvocationsOfState(runId, "left_code")).map(item => item.nodeExecutionId))
                .toEqual([nx11, nx12, nx21]);

            // Complete nx21 too: even with no pending visit, readAgentInvocationByChild, readTurnVisit, and readWorkflowLineage must pick nx21 over nx12
            expect(await store.completeAgentNode({
                childSessionId, operationId: "op-2-1", nodeExecutionId: nx21, call: { outcome: "done", output: { step: "2-1" } },
            })).toMatchObject({ kind: "accepted" });
            expect((await store.readAgentInvocationByChild(childSessionId))?.nodeExecutionId).toBe(nx21);
            expect(await store.readTurnVisit(childSessionId, [pid(nx12), pid(nx21)]))
                .toEqual({ nodeExecutionId: nx21, open: false, inherited: false });
            expect(await store.readWorkflowLineage(childSessionId))
                .toMatchObject({ agentRoot: { nodeExecutionId: nx21 } });
        } finally {
            await catalog.close();
            await direct.end();
        }
    });

    it("preserves root-scope continued visit order and cycle numbers (p IS NULL -> 0 regression)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        try {
            await catalog.initialize();
            const store = catalog.workflowStore();
            const compiled = compileWorkflow(ROOT_LOOP_YAML);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);

            const parent = randomUUID();
            await catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            await catalog.createWorkflowSession(workflowSessionId, {
                parentSessionId: parent, owner: null, creationConfig: { workflow: { requestSha256: "i8-store-2" } },
            });
            await store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: ROOT_LOOP_YAML, compiled,
                actor: ACTOR, operationId: "create-i8-store-2", requestSha256: "i8-store-2", publish: true, title: "Workflow: root-loop-store",
                start: {
                    runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION,
                },
            });

            const childSessionId = workflowAgentSessionId(runId, "talk");
            await catalog.createSession(childSessionId, { parentSessionId: workflowSessionId });
            const admitRoot = async (ordinal, predecessorId) => {
                const nx = nodeExecutionIdFor(runId, "root", "talk", ordinal);
                const res = await store.enterNode({
                    runId, nodeExecutionId: nx, scopeId: "root", nodeId: "talk", ordinal, nodeType: "agent",
                    predecessorId, arrivalRoute: predecessorId ? "again" : null, inputText: canonicalJson({ ordinal }), kvRevision: 1,
                    waitSeconds: null, immediate: null,
                    agent: {
                        childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: "Work at root." },
                        outcomes: ["again", "done"], outputSchema: null, timeoutSeconds: 300,
                    },
                });
                expect(res).toMatchObject({ admitted: true });
                return nx;
            };

            const v1 = await admitRoot(1, null);
            expect(await store.completeAgentNode({ childSessionId, operationId: "r-1", nodeExecutionId: v1, call: { outcome: "again", output: 1 } }))
                .toMatchObject({ kind: "accepted" });
            const v2 = await admitRoot(2, v1);
            expect(await store.completeAgentNode({ childSessionId, operationId: "r-2", nodeExecutionId: v2, call: { outcome: "again", output: 2 } }))
                .toMatchObject({ kind: "accepted" });
            const v3 = await admitRoot(3, v2);
            // Step created_at back on v3 so ordinal (not clock) must govern
            await direct.query(
                `UPDATE "${env.cmsSchema}".workflow_agent_invocations
                    SET created_at = (SELECT created_at - interval '10 seconds' FROM "${env.cmsSchema}".workflow_agent_invocations WHERE node_execution_id = $2)
                  WHERE node_execution_id = $1`,
                [v3, v1],
            );

            expect(await store.readAgentVisitsBefore(runId, "talk", v1)).toEqual({ count: 0, previous: null });
            expect(await store.readAgentVisitsBefore(runId, "talk", v2)).toMatchObject({ count: 1, previous: { nodeExecutionId: v1 } });
            expect(await store.readAgentVisitsBefore(runId, "talk", v3)).toMatchObject({ count: 2, previous: { nodeExecutionId: v2 } });
            expect(await store.readAgentVisitsBefore(runId, "talk", null)).toMatchObject({ count: 3, previous: { nodeExecutionId: v3 } });
            expect((await store.readAgentInvocationByChild(childSessionId))?.nodeExecutionId).toBe(v3);
            const pid = nx => `workflow:${workflowSessionId}:${runId}:agent:${nx}`;
            expect(await store.readTurnVisit(childSessionId, [pid(v1), pid(v2), pid(v3)]))
                .toEqual({ nodeExecutionId: v3, open: true, inherited: false });
            expect(await store.readWorkflowLineage(childSessionId)).toMatchObject({ agentRoot: { nodeExecutionId: v3 } });
            expect((await store.listAgentInvocationsOfState(runId, "talk")).map(item => item.nodeExecutionId))
                .toEqual([v1, v2, v3]);

            expect(await store.completeAgentNode({ childSessionId, operationId: "r-3", nodeExecutionId: v3, call: { outcome: "done", output: 3 } }))
                .toMatchObject({ kind: "accepted" });
            expect((await store.readAgentInvocationByChild(childSessionId))?.nodeExecutionId).toBe(v3);
            expect(await store.readTurnVisit(childSessionId, [pid(v2), pid(v3)]))
                .toEqual({ nodeExecutionId: v3, open: false, inherited: false });
            expect(await store.readWorkflowLineage(childSessionId)).toMatchObject({ agentRoot: { nodeExecutionId: v3 } });
        } finally {
            await catalog.close();
            await direct.end();
        }
    });
});
