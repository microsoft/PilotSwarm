/**
 * Child Workflows store tests (T5, T6, T7, C1 true race, A2 visit-closed, B1 <package>/<name>):
 * - T5: Start with a Workflow parent (internal spawn mode) writes parent_session_id, session_definition_id,
 *       session_revision, sessionPin.ownerSessionId, start_operation_id ("spawn:<nx>"), and increments parent budget.
 * - T6: Same spawn key twice replays the same child; same key with different inputs throws OPERATION_CONFLICT.
 * - T7: Spawn at 50 running children (CHILD_LIMIT), from level-2 Workflow (WORKFLOW_NESTING_LIMIT), and invalid inputs
 *       (WORKFLOW_INPUT_INVALID) all refuse and leave no child rows.
 * - C1 true race: claim child session -> end parent by real recordSessionCommand("cancel") -> run store.createDefinition
 *       -> refused (RUN_ENDED), zero child definition/run rows; replay of an earlier committed spawn still succeeds.
 * - A2: spawn visit already completed while parent run active -> refused (RUN_ENDED).
 * - B1: spawn of <package>/<name> attached package definition resolves cleanly.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { sha256Hex } from "../../src/workflow/json.ts";
import {
    saveSessionWorkflowDefinition, startSessionWorkflowDefinition, WORKFLOW_START_MAX_RUNNING_CHILDREN,
} from "../../src/workflow/session-definitions.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "child-spawn-store" };
const ENGINE = { kind: "system", name: "child-spawn-store-test" };

const PARENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-wf, version: "1.0.0" }
initial: launch
states:
  launch:
    type: spawn
    definition: child-wf
    transition: { next: { started: hold, failure: failed } }
  hold: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: child-wf, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [cycle]
    properties: { cycle: { type: integer } }
    additionalProperties: false
initial: hold
states:
  hold: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function refused(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

describe("Child Workflows store & Start function (C5, C1 race, A2, B1)", () => {
    it("T5, T6, T7, C1 true race, A2 visit lock, and B1 package definition spawn", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = {
                catalog: h.catalog,
                store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
            };
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });

            const parentDef = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chat, name: "parent-wf", yaml: PARENT_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-parent", by: "session",
            })).receipt;
            const childDef = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chat, name: "child-wf", yaml: CHILD_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-child", by: "session",
            })).receipt;

            const parentWf = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { definitionId: parentDef.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-parent", owner: OWNER,
            });
            expect(await h.store.sessionDefinitions.runningChildren(parentWf.workflowId)).toBe(0);

            const admitSpawnVisit = async (runId, ordinal) => {
                const nx = nodeExecutionIdFor(runId, "root", "launch", ordinal);
                await h.store.enterNode({
                    runId, nodeExecutionId: nx, scopeId: "root", nodeId: "launch", ordinal,
                    nodeType: "spawn", predecessorId: null, arrivalRoute: null, inputText: "{}",
                    kvRevision: 1, waitSeconds: null, immediate: null,
                });
                return nx;
            };
            const nx1 = await admitSpawnVisit(parentWf.runId, 1);

            // T5: Start child in internal spawn mode with parentSessionId = parentWf.workflowId.
            const child1 = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nx1 },
                definition: { name: "child-wf" }, inputs: { cycle: 1 },
                actor: ENGINE, operationId: nx1, owner: OWNER,
            });
            expect(child1.replayed).toBe(false);
            expect(child1.revision).toBe(1);
            expect(await h.store.sessionDefinitions.runningChildren(parentWf.workflowId)).toBe(1);

            const childSession = await h.catalog.getSession(child1.workflowId);
            expect(childSession?.parentSessionId).toBe(parentWf.workflowId);
            expect(childSession?.sessionKind).toBe("workflow");
            const childDefRow = await h.store.readDefinition(child1.workflowId);
            expect(childDefRow?.parentSessionId).toBe(parentWf.workflowId);
            expect(childDefRow?.sessionDefinitionId).toBe(childDef.definitionId);
            expect(childDefRow?.sessionRevision).toBe(1);
            const creation = await h.catalog.getSessionCreationConfig(child1.workflowId);
            expect(creation?.workflow?.sessionPin?.ownerSessionId).toBe(chat);
            const runRows = await h.q("SELECT start_operation_id FROM SCHEMA.workflow_runs WHERE run_id = $1", [child1.runId]);
            expect(runRows[0]?.start_operation_id).toBe(`spawn:${nx1}`);

            // T6: Same spawn key replays same child; different inputs fails OPERATION_CONFLICT.
            const replay1 = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nx1 },
                definition: { name: "child-wf" }, inputs: { cycle: 1 },
                actor: ENGINE, operationId: nx1, owner: OWNER,
            });
            expect(replay1.replayed).toBe(true);
            expect(replay1.workflowId).toBe(child1.workflowId);
            await refused(startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nx1 },
                definition: { name: "child-wf" }, inputs: { cycle: 2 },
                actor: ENGINE, operationId: nx1, owner: OWNER,
            }), "OPERATION_CONFLICT");

            // B1: Attached package definition <package>/<name> resolves in a spawn.
            const pkgCompiled = compileWorkflow(CHILD_YAML);
            await h.store.sessionDefinitions.attachPackage({
                ownerSessionId: chat, name: "pkg-one/child-wf", packageName: "pkg-one",
                yaml: CHILD_YAML, compiled: pkgCompiled,
                package: { packageId: "pkg-1", packageName: "pkg-one", semver: "1.0.0", sha256: sha256Hex("pkg-1"), cardDigest: sha256Hex("card-1") },
                card: { name: "child-wf", summary: "child" }, actor: { kind: "system", name: "test" },
                operationId: "attach-pkg-one", requestSha256: sha256Hex("attach-pkg-one"),
            });
            const nxPkg = await admitSpawnVisit(parentWf.runId, 2);
            const pkgChild = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nxPkg },
                definition: { name: "pkg-one/child-wf" }, inputs: { cycle: 7 },
                actor: ENGINE, operationId: nxPkg, owner: OWNER,
            });
            expect(pkgChild.name).toBe("pkg-one/child-wf");
            expect(pkgChild.revision).toBe(1);

            // A2: Completed spawn visit (e.g. cancelled branch) while parent run is STILL active -> refused RUN_ENDED.
            const nxClosed = await admitSpawnVisit(parentWf.runId, 3);
            await h.q("UPDATE SCHEMA.workflow_node_executions SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = '{\"code\":\"cancelled\",\"message\":\"cut\"}', winner = 'fail_fast', completed_at = now() WHERE node_execution_id = $1", [nxClosed]);
            await refused(startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nxClosed },
                definition: { name: "child-wf" }, inputs: { cycle: 3 },
                actor: ENGINE, operationId: nxClosed, owner: OWNER,
            }), "RUN_ENDED");

            // T7a (I9): 3-deep Workflows allowed (chat 0 -> parentWf 0 -> child1 1 -> grandchild1 2), while 4th Workflow -> WORKFLOW_NESTING_LIMIT, no child row.
            const nxGrand = await admitSpawnVisit(child1.runId, 1);
            const grandchild1 = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: child1.workflowId, spawn: { nodeExecutionId: nxGrand },
                definition: { name: "child-wf" }, inputs: { cycle: 98 },
                actor: ENGINE, operationId: nxGrand, owner: OWNER,
            });
            expect(await h.store.readWorkflowLineage(grandchild1.workflowId)).toMatchObject({ level: 2, hasWorkflow: true });
            const beforeDepth = (await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_definitions WHERE parent_session_id = $1", [grandchild1.workflowId]))[0].c;
            await refused(startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: grandchild1.workflowId, spawn: { nodeExecutionId: "nx-too-deep" },
                definition: { name: "child-wf" }, inputs: { cycle: 99 },
                actor: ENGINE, operationId: "nx-too-deep", owner: OWNER,
            }), "WORKFLOW_NESTING_LIMIT");
            expect((await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_definitions WHERE parent_session_id = $1", [grandchild1.workflowId]))[0].c).toBe(beforeDepth);

            // T7b: Invalid inputs -> WORKFLOW_INPUT_INVALID, no child row.
            const nxBad = await admitSpawnVisit(parentWf.runId, 4);
            const beforeBad = (await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_definitions WHERE parent_session_id = $1", [parentWf.workflowId]))[0].c;
            await refused(startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nxBad },
                definition: { name: "child-wf" }, inputs: { cycle: "not-an-int" },
                actor: ENGINE, operationId: nxBad, owner: OWNER,
            }), "WORKFLOW_INPUT_INVALID");
            expect((await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_definitions WHERE parent_session_id = $1", [parentWf.workflowId]))[0].c).toBe(beforeBad);

            // T7c: Budget limit at 50 running children -> CHILD_LIMIT, no child row.
            for (let i = 0; i < WORKFLOW_START_MAX_RUNNING_CHILDREN - 2; i += 1) {
                const sub = randomUUID();
                await h.catalog.createSession(sub, { parentSessionId: parentWf.workflowId, owner: OWNER });
                await h.q("UPDATE SCHEMA.sessions SET state = 'running' WHERE session_id = $1", [sub]);
            }
            expect(await h.store.sessionDefinitions.runningChildren(parentWf.workflowId)).toBe(50);
            const nxOver = await admitSpawnVisit(parentWf.runId, 5);
            await refused(startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nxOver },
                definition: { name: "child-wf" }, inputs: { cycle: 51 },
                actor: ENGINE, operationId: nxOver, owner: OWNER,
            }), "CHILD_LIMIT");
            expect((await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_definitions WHERE parent_session_id = $1", [parentWf.workflowId]))[0].c).toBe(beforeBad);

            // C1 TRUE RACE: claim child session -> end parent by real recordSessionCommand("cancel") ->
            // run store.createDefinition for that claim -> refused RUN_ENDED, zero child definition/run rows!
            await h.q("UPDATE SCHEMA.sessions SET state = 'completed' WHERE parent_session_id = $1 AND session_kind <> 'workflow'", [parentWf.workflowId]);
            const nxRace = await admitSpawnVisit(parentWf.runId, 6);
            const racedChildId = randomUUID();
            await h.catalog.createWorkflowSession(racedChildId, {
                parentSessionId: parentWf.workflowId, owner: OWNER,
                creationConfig: { workflow: { operationId: `spawn:${nxRace}` } },
            });
            // End the parent via the real store cancel path AFTER the child session claim committed.
            await h.store.recordSessionCommand({
                workflowSessionId: parentWf.workflowId, operationId: "cancel-parent-race",
                requestSha256: sha256Hex("cancel-parent-race"), command: "cancel", reason: "race cancel",
                requestedBy: chat, expectedParentSessionId: chat,
            });
            // Now attempt the child insert under the parent-run lock -> MUST fail RUN_ENDED and write nothing.
            await refused(h.store.createDefinition({
                workflowSessionId: racedChildId, parentSessionId: parentWf.workflowId, notifyParent: true,
                yaml: CHILD_YAML, compiled: pkgCompiled, actor: ENGINE,
                operationId: `spawn:${nxRace}`, requestSha256: sha256Hex("race-req"), publish: true,
                start: { runId: randomUUID(), mode: "live", controllerInstanceId: `session-${racedChildId}`,
                    inputsText: "{\"cycle\":6}", kvText: "{}", testAgentMode: null, controllerVersion: "1.3.0" },
                title: "Workflow: child-wf",
                sessionPin: { ownerSessionId: chat, definitionId: childDef.definitionId, revision: 1 },
                spawn: { nodeExecutionId: nxRace },
            }), "RUN_ENDED");
            expect(await h.store.readDefinition(racedChildId)).toBeNull();
            expect(await h.store.listRuns(racedChildId)).toHaveLength(0);
            // Bare claim is also invisible to listChildWorkflows (A10).
            const listed = await h.store.listChildWorkflows(parentWf.workflowId);
            expect(listed.some(c => c.workflowSessionId === racedChildId)).toBe(false);

            // A4 delete barrier: start a second parent + child, soft-delete parent first via PilotSwarmClient.deleteSession
            // -> post-soft-delete spawn is refused (RUN_ENDED), and pre-existing child is deleted before controller cancel.
            const parentDel = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, definition: { definitionId: parentDef.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-parent-a4", owner: OWNER,
            });
            const nxA4a = await admitSpawnVisit(parentDel.runId, 1);
            const childA4 = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentDel.workflowId, spawn: { nodeExecutionId: nxA4a },
                definition: { name: "child-wf" }, inputs: { cycle: 10 },
                actor: ENGINE, operationId: nxA4a, owner: OWNER,
            });
            const nxA4b = await admitSpawnVisit(parentDel.runId, 2);
            const nxA4c = await admitSpawnVisit(parentDel.runId, 3);
            const preClaimedA4Id = randomUUID();
            await h.catalog.createWorkflowSession(preClaimedA4Id, {
                parentSessionId: parentDel.workflowId, owner: OWNER,
                creationConfig: { workflow: { operationId: `spawn:${nxA4c}` } },
            });
            const deleteOrder = [];
            const { PilotSwarmClient } = await import("../../src/client.ts");
            const fakeClient = Object.create(PilotSwarmClient.prototype);
            fakeClient.sessionConfigs = new Map();
            fakeClient.parentSessionIds = new Map();
            fakeClient.nestingLevels = new Map();
            fakeClient.activeOrchestrations = new Map();
            fakeClient._factStore = null;
            fakeClient.duroxideClient = { cancelInstance: async (id) => { deleteOrder.push("cancel:" + id); } };
            const origSoftDelete = h.catalog.softDeleteSession.bind(h.catalog);
            let interleaveSpawnRefused = false;
            fakeClient._catalog = new Proxy(h.catalog, {
                get(target, prop) {
                    if (prop === "softDeleteSession") {
                        return async (id) => {
                            deleteOrder.push("softDelete:" + id);
                            await origSoftDelete(id);
                            if (id === parentDel.workflowId && !interleaveSpawnRefused) {
                                // New start after softDeleteSession is refused at claim (PARENT_DELETED),
                                // AND an already-claimed in-flight spawn is refused at insert (RUN_ENDED).
                                await refused(startSessionWorkflowDefinition(host, {
                                    ownerSessionId: chat, parentSessionId: parentDel.workflowId, spawn: { nodeExecutionId: nxA4b },
                                    definition: { name: "child-wf" }, inputs: { cycle: 11 },
                                    actor: ENGINE, operationId: nxA4b, owner: OWNER,
                                }), "PARENT_DELETED");
                                await refused(h.store.createDefinition({
                                    workflowSessionId: preClaimedA4Id, parentSessionId: parentDel.workflowId, notifyParent: true,
                                    yaml: CHILD_YAML, compiled: pkgCompiled, actor: ENGINE,
                                    operationId: `spawn:${nxA4c}`, requestSha256: sha256Hex("a4c-req"), publish: true,
                                    start: { runId: randomUUID(), mode: "live", controllerInstanceId: `session-${preClaimedA4Id}`,
                                        inputsText: "{\"cycle\":12}", kvText: "{}", testAgentMode: null, controllerVersion: "1.3.0" },
                                    title: "Workflow: child-wf",
                                    sessionPin: { ownerSessionId: chat, definitionId: childDef.definitionId, revision: 1 },
                                    spawn: { nodeExecutionId: nxA4c },
                                }), "RUN_ENDED");
                                interleaveSpawnRefused = true;
                            }
                        };
                    }
                    const v = target[prop];
                    return typeof v === "function" ? v.bind(target) : v;
                },
            });
            await fakeClient.deleteSession(parentDel.workflowId);
            expect(interleaveSpawnRefused).toBe(true);
            expect((await h.store.readSessionLink(childA4.workflowId))?.deleted).toBe(true);
            expect(deleteOrder.indexOf("softDelete:" + parentDel.workflowId)).toBeLessThan(deleteOrder.indexOf("cancel:session-" + parentDel.workflowId));
            expect(deleteOrder.indexOf("softDelete:" + childA4.workflowId)).toBeLessThan(deleteOrder.indexOf("cancel:session-" + parentDel.workflowId));

            // D2 ancestor-delete race: deleting an ancestor chat where a child Workflow commits AFTER the initial
            // getDescendantSessionIds(chat) scan and BEFORE the parent Workflow's soft-delete -> child IS deleted.
            const chatD2 = randomUUID();
            await h.catalog.createSession(chatD2, { owner: OWNER });
            const pDefD2 = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chatD2, name: "parent-wf", yaml: PARENT_YAML, expected: null,
                actor: { kind: "session", sessionId: chatD2 }, operationId: "save-p-d2", by: "session",
            })).receipt;
            await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chatD2, name: "child-wf", yaml: CHILD_YAML, expected: null,
                actor: { kind: "session", sessionId: chatD2 }, operationId: "save-c-d2", by: "session",
            });
            const parentD2 = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chatD2, definition: { definitionId: pDefD2.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-parent-d2", owner: OWNER,
            });
            const nxD2 = await admitSpawnVisit(parentD2.runId, 1);
            let lateChildD2 = null;
            const origGetDesc = h.catalog.getDescendantSessionIds.bind(h.catalog);
            const fakeClientD2 = Object.create(PilotSwarmClient.prototype);
            fakeClientD2.sessionConfigs = new Map();
            fakeClientD2.parentSessionIds = new Map();
            fakeClientD2.nestingLevels = new Map();
            fakeClientD2.activeOrchestrations = new Map();
            fakeClientD2._factStore = null;
            fakeClientD2.duroxideClient = { cancelInstance: async () => {} };
            fakeClientD2._catalog = new Proxy(h.catalog, {
                get(target, prop) {
                    if (prop === "getDescendantSessionIds") {
                        return async (id) => {
                            const rows = await origGetDesc(id);
                            if (id === chatD2 && !lateChildD2) {
                                // Simulate a spawn committing between the initial chat descendant scan and parentD2's close.
                                lateChildD2 = await startSessionWorkflowDefinition(host, {
                                    ownerSessionId: chatD2, parentSessionId: parentD2.workflowId, spawn: { nodeExecutionId: nxD2 },
                                    definition: { name: "child-wf" }, inputs: { cycle: 77 },
                                    actor: ENGINE, operationId: nxD2, owner: OWNER,
                                });
                            }
                            return rows;
                        };
                    }
                    const v = target[prop];
                    return typeof v === "function" ? v.bind(target) : v;
                },
            });
            await fakeClientD2.deleteSession(chatD2);
            expect(lateChildD2).not.toBeNull();
            expect((await h.store.readSessionLink(lateChildD2.workflowId))?.deleted).toBe(true);

            // Replaying the existing spawn key AFTER the parent ended still returns the existing child (read-only replay).
            const replayAfterEnd = await startSessionWorkflowDefinition(host, {
                ownerSessionId: chat, parentSessionId: parentWf.workflowId, spawn: { nodeExecutionId: nx1 },
                definition: { name: "child-wf" }, inputs: { cycle: 1 },
                actor: ENGINE, operationId: nx1, owner: OWNER,
            });
            expect(replayAfterEnd.replayed).toBe(true);
            expect(replayAfterEnd.workflowId).toBe(child1.workflowId);
        } finally {
            await h.stop();
        }
    });
});
