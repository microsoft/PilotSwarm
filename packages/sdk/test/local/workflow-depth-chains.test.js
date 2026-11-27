/**
 * I9 Session & Workflow Depth Rule — real PostgreSQL integration verification of:
 * - all 14 chains of "Every chain, checked" (including the owner's 3 examples);
 * - all 4 checks (inline spawn_agent via spawnNesting, Start/spawn via requireWorkflowStartLimits,
 *   agent-host via createWorkflowAgentNodeHost + readLineage, and Check 4 fallback captureSpawnToolsV1);
 * - root Workflow (parent_session_id = null), soft-deleted ancestors, is_system = true reset, and broken/cyclic fail-closed.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import {
    SESSION_MAX_NESTING_LEVEL, spawnNesting, spawnNestingRefusal,
} from "../../src/workflow/input-policy.ts";
import { createWorkflowAgentNodeHost } from "../../src/workflow/agent-host.ts";
import {
    requireWorkflowStartLimits, saveSessionWorkflowDefinition, startSessionWorkflowDefinition,
} from "../../src/workflow/session-definitions.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { registerActivities } from "../../src/session-proxy.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "depth-chains" };
const ENGINE = { kind: "system", name: "depth-chains-test" };

const SIMPLE_YAML = (name = "wf") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

const AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: step-wf, version: "1.0.0" }
initial: work
states:
  work:
    type: agent
    invoke: { prompt: "Do work." }
    timeoutSeconds: 3600
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

async function refused(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

describe("I9 depth rule: all 14 chains and PostgreSQL invariants", () => {
    it("verifies all 14 chains across readWorkflowLineage, requireWorkflowStartLimits, agent-host, inline spawnNesting, and Check 4 captureSpawnToolsV1", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = {
                catalog: h.catalog,
                store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
            };

            const createSub = async (parentSessionId, extra = {}) => {
                const id = randomUUID();
                await h.catalog.createSession(id, { parentSessionId, owner: OWNER, ...extra });
                return id;
            };

            const createWf = async (parentSessionId, { withAgentStep = false } = {}) => {
                const yaml = withAgentStep ? AGENT_YAML : SIMPLE_YAML("wf");
                const compiled = compileWorkflow(yaml);
                expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
                const wfId = randomUUID();
                const runId = randomUUID();
                await h.catalog.createWorkflowSession(wfId, {
                    parentSessionId, owner: OWNER, creationConfig: { workflow: { requestSha256: "depth-chains" } },
                });
                await h.store.createDefinition({
                    workflowSessionId: wfId, parentSessionId, notifyParent: false, yaml, compiled, actor: ENGINE,
                    operationId: `create-${wfId}`, requestSha256: `req-${wfId}`, publish: true, title: "Workflow: test",
                    start: {
                        runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(wfId),
                        inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION,
                    },
                });
                if (!withAgentStep) return { wfId, runId, stepId: null };
                const stepId = randomUUID();
                const nxId = nodeExecutionIdFor(runId, "root", "work", 1);
                await h.store.enterNode({
                    runId, nodeExecutionId: nxId, scopeId: "root", nodeId: "work", ordinal: 1, nodeType: "agent",
                    predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
                    agent: {
                        childSessionId: stepId, controllingSessionId: parentSessionId,
                        task: { source: "prompt", prompt: "Do work." }, outcomes: ["ok"], outputSchema: null, timeoutSeconds: 3600,
                    },
                });
                await h.catalog.createSession(stepId, { parentSessionId: wfId, owner: OWNER });
                return { wfId, runId, stepId, nxId };
            };

            // Wire real captureSpawnToolsV1 activity backed by h.catalog (Check 4).
            const handlers = new Map();
            const captureCalls = [];
            const fakeManager = {
                captureSpawnTools: async (parentSessionId) => { captureCalls.push(parentSessionId); return { toolCeiling: [] }; },
                getSessionStateDir: () => "/tmp",
                getWorkspaceProvider: () => null,
            };
            registerActivities(
                { registerActivity: (name, handler) => handlers.set(name, handler) },
                fakeManager, null, undefined, h.catalog, undefined, "in-memory://depth-chains",
                undefined, undefined, [], null, [], [],
            );
            const captureSpawn = (parentSessionId) => handlers.get("captureSpawnToolsV1")({ traceInfo() {} }, {
                parentSessionId, childConfig: {}, agent: null,
            });

            // Wire real agent-host backed by h.catalog + h.store.readWorkflowLineage (Check 3).
            const createdSteps = [];
            const agentHost = createWorkflowAgentNodeHost({
                getSession: id => h.catalog.getSession(id),
                readLineage: id => h.store.readWorkflowLineage(id),
                resolveAgent: async () => null,
                createChild: async spec => { createdSteps.push(spec); },
            });
            const spawnStepOn = (wfId, controllingSessionId = null) => agentHost.spawn({
                childSessionId: randomUUID(), workflowSessionId: wfId, controllingSessionId,
                runId: randomUUID(), nodeExecutionId: `nx-${randomUUID()}`, stateId: "work",
                task: { source: "prompt", prompt: "Do work." }, prompt: "wrapper", clientMessageId: `cm-${randomUUID()}`,
                deadlineAt: "2026-12-01T00:00:00.000Z",
            });

            const checkInlineSpawn = async (parentId) => {
                const lineage = await h.store.readWorkflowLineage(parentId);
                const nesting = spawnNesting(0, SESSION_MAX_NESTING_LEVEL, lineage);
                const allowed = nesting.childNestingLevel <= nesting.maxNestingLevel;
                const refusal = allowed ? null : spawnNestingRefusal(
                    lineage === null ? 0 : lineage.level,
                    nesting.maxNestingLevel,
                    Boolean(lineage?.agentRoot || lineage?.hasWorkflow),
                );
                return { lineage, nesting, allowed, refusal };
            };

            const P = await createSub(null);

            // ── Chain 1 (Example 1): person 0 -> sub 1 -> sub 2 (allowed) ──
            const s1 = await createSub(P);
            const c1 = await checkInlineSpawn(s1);
            expect(c1.lineage).toMatchObject({ level: 1, hasWorkflow: false, agentRoot: null });
            expect(c1.allowed).toBe(true);
            expect(c1.nesting.childNestingLevel).toBe(2);
            await expect(captureSpawn(s1)).resolves.toEqual({ toolCeiling: [] });

            // ── Chain 2: person 0 -> sub 1 -> sub 2 -> sub 3 (refused, ordinary text) ──
            const s2 = await createSub(s1);
            const c2 = await checkInlineSpawn(s2);
            expect(c2.lineage).toMatchObject({ level: 2, hasWorkflow: false, agentRoot: null });
            expect(c2.allowed).toBe(false);
            expect(c2.refusal).toBe(
                "[SYSTEM: spawn_agent failed — you are already at nesting level 2 (max 2). Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]",
            );
            const beforeC2 = captureCalls.length;
            await expect(captureSpawn(s2)).rejects.toThrow("you are already at nesting level 2 (max 2).");
            expect(captureCalls.length).toBe(beforeC2);

            // ── Chain 3: person 0 -> W1 (0) -> step1 (0) -> sub (1) (allowed) ──
            const w1 = await createWf(P, { withAgentStep: true });
            expect(await h.store.readWorkflowLineage(w1.wfId)).toMatchObject({ level: 0, hasWorkflow: true, agentRoot: null });
            const c3 = await checkInlineSpawn(w1.stepId);
            expect(c3.lineage).toMatchObject({ level: 0, hasWorkflow: true });
            expect(c3.allowed).toBe(true);
            expect(c3.nesting.childNestingLevel).toBe(1);

            // ── Chain 4 (Example 2): person 0 -> W1 (0) -> step1 (0) -> sub (1) -> sub (2) (allowed) ──
            const w1Sub1 = await createSub(w1.stepId);
            const c4 = await checkInlineSpawn(w1Sub1);
            expect(c4.lineage).toMatchObject({ level: 1, hasWorkflow: true });
            expect(c4.allowed).toBe(true);
            expect(c4.nesting.childNestingLevel).toBe(2);

            // ── Chain 5: person 0 -> W1 -> step1 -> sub (1) -> sub (2) -> sub (3) (refused, Workflow text) ──
            const w1Sub2 = await createSub(w1Sub1);
            const c5 = await checkInlineSpawn(w1Sub2);
            expect(c5.lineage).toMatchObject({ level: 2, hasWorkflow: true });
            expect(c5.allowed).toBe(false);
            expect(c5.refusal).toContain("this session is at level 2, and nothing goes past level 2");
            expect(c5.refusal).toContain("A sub-agent here would be at level 3.");

            // ── Chain 6: person 0 -> W1 (0) -> W2 (1) -> step2 (1) (allowed via agent-host) ──
            const w2 = await createWf(w1.wfId, { withAgentStep: true });
            expect(await h.store.readWorkflowLineage(w2.wfId)).toMatchObject({ level: 1, hasWorkflow: true });
            createdSteps.length = 0;
            expect(await spawnStepOn(w2.wfId, P)).toEqual({ spawned: true });
            expect(createdSteps[0].nestingLevel).toBe(1);

            // ── Chain 7 (Example 3; the I9 case): person 0 -> W1 (0) -> W2 (1) -> step2 (1) -> sub (2) (allowed inline & Check 4) ──
            const c7 = await checkInlineSpawn(w2.stepId);
            expect(c7.lineage).toMatchObject({ level: 1, hasWorkflow: true });
            expect(c7.allowed).toBe(true);
            expect(c7.nesting.childNestingLevel).toBe(2);
            await expect(captureSpawn(w2.stepId)).resolves.toEqual({ toolCeiling: [] });

            // ── Chain 8: person 0 -> W1 -> W2 -> step2 -> sub (2) -> sub (3) (refused inline & Check 4) ──
            const w2Sub1 = await createSub(w2.stepId);
            const c8 = await checkInlineSpawn(w2Sub1);
            expect(c8.lineage).toMatchObject({ level: 2, hasWorkflow: true });
            expect(c8.allowed).toBe(false);
            expect(c8.refusal).toContain("this session is at level 2, and nothing goes past level 2");
            const beforeC8 = captureCalls.length;
            await expect(captureSpawn(w2Sub1)).rejects.toThrow(/this session is at level 2, and nothing goes past level 2/);
            expect(captureCalls.length).toBe(beforeC8);

            // ── Chain 9: person 0 -> sub 1 -> W (1) -> step (1) -> sub (2) (allowed) ──
            const s1Wf = await createWf(s1, { withAgentStep: true });
            expect(await h.store.readWorkflowLineage(s1Wf.wfId)).toMatchObject({ level: 1, hasWorkflow: true });
            const c9 = await checkInlineSpawn(s1Wf.stepId);
            expect(c9.lineage).toMatchObject({ level: 1, hasWorkflow: true });
            expect(c9.allowed).toBe(true);
            expect(c9.nesting.childNestingLevel).toBe(2);

            // ── Chain 10: person 0 -> sub 1 -> W -> step -> sub (2) -> sub (3) (refused) ──
            const s1WfSub = await createSub(s1Wf.stepId);
            const c10 = await checkInlineSpawn(s1WfSub);
            expect(c10.lineage).toMatchObject({ level: 2, hasWorkflow: true });
            expect(c10.allowed).toBe(false);
            expect(c10.refusal).toContain("A sub-agent here would be at level 3.");

            // ── Chain 11: person 0 -> W1 (0) -> W2 (1) -> W3 (2) (allowed; step at 2 cannot delegate; W4 refused) ──
            await expect(requireWorkflowStartLimits(host, w2.wfId)).resolves.toBeUndefined();
            const w3 = await createWf(w2.wfId, { withAgentStep: true });
            expect(await h.store.readWorkflowLineage(w3.wfId)).toMatchObject({ level: 2, hasWorkflow: true });
            createdSteps.length = 0;
            expect(await spawnStepOn(w3.wfId, P)).toEqual({ spawned: true });
            expect(createdSteps[0].nestingLevel).toBe(2);
            const c11Step = await checkInlineSpawn(w3.stepId);
            expect(c11Step.lineage).toMatchObject({ level: 2, hasWorkflow: true });
            expect(c11Step.allowed).toBe(false);
            const w4Refused = await refused(requireWorkflowStartLimits(host, w3.wfId), "WORKFLOW_NESTING_LIMIT");
            expect(w4Refused.message).toContain("This session is at level 2, and the Workflow it starts would be at level 3.");
            expect(w4Refused.details).toMatchObject({ nestingLevel: 2, workflowLevel: 3, maxNestingLevel: 2 });

            // ── Chain 12: person 0 -> sub 1 -> W1 (1) -> W2 (2) (allowed; step at 2 cannot delegate; W3 refused) ──
            await expect(requireWorkflowStartLimits(host, s1Wf.wfId)).resolves.toBeUndefined();
            const s1Wf2 = await createWf(s1Wf.wfId, { withAgentStep: true });
            expect(await h.store.readWorkflowLineage(s1Wf2.wfId)).toMatchObject({ level: 2, hasWorkflow: true });
            createdSteps.length = 0;
            expect(await spawnStepOn(s1Wf2.wfId, s1)).toEqual({ spawned: true });
            expect(createdSteps[0].nestingLevel).toBe(2);
            expect((await checkInlineSpawn(s1Wf2.stepId)).allowed).toBe(false);
            await refused(requireWorkflowStartLimits(host, s1Wf2.wfId), "WORKFLOW_NESTING_LIMIT");

            // ── Chain 13: person 0 -> sub 1 -> sub 2 -> W1 (2) (allowed via Start; its step at 2 cannot delegate) ──
            const s2Def = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: s2, name: "step-wf", yaml: AGENT_YAML, expected: null,
                actor: { kind: "session", sessionId: s2 }, operationId: "save-s2-wf", by: "session",
            })).receipt;
            const s2Started = await startSessionWorkflowDefinition(host, {
                ownerSessionId: s2, definition: { definitionId: s2Def.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-s2-wf", nestingLevel: 2, owner: OWNER,
            });
            expect(s2Started.revision).toBe(1);
            expect(await h.store.readWorkflowLineage(s2Started.workflowId)).toMatchObject({ level: 2, hasWorkflow: true });
            createdSteps.length = 0;
            expect(await spawnStepOn(s2Started.workflowId, s2)).toEqual({ spawned: true });
            expect(createdSteps[0].nestingLevel).toBe(2);
            const s2StepId = randomUUID();
            await h.store.enterNode({
                runId: s2Started.runId, nodeExecutionId: nodeExecutionIdFor(s2Started.runId, "root", "work", 1),
                scopeId: "root", nodeId: "work", ordinal: 1, nodeType: "agent",
                predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
                agent: {
                    childSessionId: s2StepId, controllingSessionId: s2,
                    task: { source: "prompt", prompt: "Do work." }, outcomes: ["ok"], outputSchema: null, timeoutSeconds: 3600,
                },
            });
            await h.catalog.createSession(s2StepId, { parentSessionId: s2Started.workflowId, owner: OWNER });
            expect((await checkInlineSpawn(s2StepId)).allowed).toBe(false);
            const beforeC13 = captureCalls.length;
            await expect(captureSpawn(s2StepId)).rejects.toThrow(/this session is at level 2, and nothing goes past level 2/);
            expect(captureCalls.length).toBe(beforeC13);

            // ── Chain 14: person 0 -> sub 1 -> sub 2 -> W1 (2) -> W2 (3) (refused WORKFLOW_NESTING_LIMIT, 0 rows) ──
            const c14Refused = await refused(requireWorkflowStartLimits(host, s2Started.workflowId), "WORKFLOW_NESTING_LIMIT");
            expect(c14Refused.message).toContain("This session is at level 2, and the Workflow it starts would be at level 3.");
            const { rows: w2Rows } = await h.pool.query(
                `SELECT count(*)::int AS n FROM "${getEnv().cmsSchema}".sessions WHERE parent_session_id = $1 AND session_kind = 'workflow'`,
                [s2Started.workflowId],
            );
            expect(w2Rows[0].n).toBe(0);
        } finally {
            await h.stop();
        }
    });

    it("handles root Workflows, soft-deleted ancestors, system session resets, and fail-closed broken/cyclic chains", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = {
                catalog: h.catalog,
                store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
            };
            const createWfRow = async (parentSessionId) => {
                const wfId = randomUUID();
                await h.catalog.createWorkflowSession(wfId, {
                    parentSessionId, owner: OWNER, creationConfig: { workflow: { requestSha256: "edge-wf" } },
                });
                return wfId;
            };

            // 1. Root Workflow (parent_session_id = null, session_kind = 'workflow') -> level 0, hasWorkflow true.
            const rootWf = await createWfRow(null);
            expect(await h.store.readWorkflowLineage(rootWf)).toMatchObject({ level: 0, hasWorkflow: true, agentRoot: null, deleted: false });
            const rootChildWf = await createWfRow(rootWf);
            expect(await h.store.readWorkflowLineage(rootChildWf)).toMatchObject({ level: 1, hasWorkflow: true });
            const rootGrandWf = await createWfRow(rootChildWf);
            expect(await h.store.readWorkflowLineage(rootGrandWf)).toMatchObject({ level: 2, hasWorkflow: true });
            await refused(requireWorkflowStartLimits(host, rootGrandWf), "WORKFLOW_NESTING_LIMIT");

            // 2. Soft-deleted ancestors above a live level-2 Workflow: getSession returns null, readLineage still resolves level 2.
            const P = randomUUID();
            await h.catalog.createSession(P, { owner: OWNER });
            const W1 = await createWfRow(P);
            const W2 = await createWfRow(W1);
            const W3 = await createWfRow(W2);
            await h.catalog.softDeleteSession(W1);
            await h.catalog.softDeleteSession(P);
            expect(await h.catalog.getSession(W1)).toBeNull();
            expect(await h.store.readWorkflowLineage(W3)).toMatchObject({ level: 2, hasWorkflow: true, deleted: false });
            const created = [];
            const agentHost = createWorkflowAgentNodeHost({
                getSession: id => h.catalog.getSession(id),
                readLineage: id => h.store.readWorkflowLineage(id),
                resolveAgent: async () => null,
                createChild: async spec => { created.push(spec); },
            });
            expect(await agentHost.spawn({
                childSessionId: randomUUID(), workflowSessionId: W3, controllingSessionId: null,
                runId: randomUUID(), nodeExecutionId: `nx-${randomUUID()}`, stateId: "work",
                task: { source: "prompt", prompt: "Do work." }, prompt: "wrapper", clientMessageId: `cm-${randomUUID()}`,
                deadlineAt: "2026-12-01T00:00:00.000Z",
            })).toEqual({ spawned: true });
            expect(created[0].nestingLevel).toBe(2);

            // 3. System sessions (Rule 8 & owner decision Q2): platform system hierarchy resets to level 0,
            // while a creatable system agent spawned under a user session stays in its parent's delegation chain.
            const sysTop = randomUUID();
            await h.catalog.createSession(sysTop, { isSystem: true });
            expect(await h.store.readWorkflowLineage(sysTop)).toMatchObject({ level: 0, hasWorkflow: false });
            const sysPlatformChild = randomUUID();
            await h.catalog.createSession(sysPlatformChild, { parentSessionId: sysTop, isSystem: true });
            expect(await h.store.readWorkflowLineage(sysPlatformChild)).toMatchObject({ level: 0, hasWorkflow: false });
            const sysWf = await createWfRow(sysPlatformChild);
            expect(await h.store.readWorkflowLineage(sysWf)).toMatchObject({ level: 0, hasWorkflow: true });

            const userRoot = randomUUID();
            await h.catalog.createSession(userRoot, { owner: OWNER });
            const userSub1 = randomUUID();
            await h.catalog.createSession(userSub1, { parentSessionId: userRoot, owner: OWNER });
            const userSpawnedSys = randomUUID();
            await h.catalog.createSession(userSpawnedSys, { parentSessionId: userSub1, owner: OWNER, isSystem: true });
            const userSysLineage = await h.store.readWorkflowLineage(userSpawnedSys);
            expect(userSysLineage).toMatchObject({ level: 2, hasWorkflow: false });
            expect(spawnNesting(2, SESSION_MAX_NESTING_LEVEL, userSysLineage).childNestingLevel).toBe(3);

            // 4. Broken (missing parent) and cyclic lineages fail closed in Start limits and Check 4.
            const orphan = randomUUID();
            await h.catalog.createSession(orphan, { owner: OWNER });
            await h.q("UPDATE SCHEMA.sessions SET parent_session_id = $2 WHERE session_id = $1", [orphan, randomUUID()]);
            const cycA = randomUUID();
            const cycB = randomUUID();
            await h.catalog.createSession(cycA, { owner: OWNER });
            await h.catalog.createSession(cycB, { parentSessionId: cycA, owner: OWNER });
            await h.q("UPDATE SCHEMA.sessions SET parent_session_id = $2 WHERE session_id = $1", [cycA, cycB]);

            const handlers = new Map();
            let badCaptureCalls = 0;
            registerActivities(
                { registerActivity: (name, handler) => handlers.set(name, handler) },
                { captureSpawnTools: async () => { badCaptureCalls += 1; return { toolCeiling: [] }; }, getSessionStateDir: () => "/tmp", getWorkspaceProvider: () => null },
                null, undefined, h.catalog, undefined, "in-memory://depth-broken", undefined, undefined, [], null, [], [],
            );
            await expect(handlers.get("captureSpawnToolsV1")({ traceInfo() {} }, {
                parentSessionId: userSpawnedSys, childConfig: {}, agent: null,
            })).rejects.toThrow("you are already at nesting level 2 (max 2).");
            for (const bad of [orphan, cycA, randomUUID()]) {
                const startErr = await refused(requireWorkflowStartLimits(host, bad), "WORKFLOW_NESTING_LIMIT");
                expect(startErr.message).toContain("delegation chain cannot be verified");
                await expect(handlers.get("captureSpawnToolsV1")({ traceInfo() {} }, {
                    parentSessionId: bad, childConfig: {}, agent: null,
                })).rejects.toThrow(/delegation chain cannot be verified/);
            }
            expect(badCaptureCalls).toBe(0);
        } finally {
            await h.stop();
        }
    });
});
