/**
 * Review PRS-002 (security review of a00f9c32): a session that runs a Workflow's agent step, or a descendant of one,
 * takes no person's definition change. Its owner's direct management calls (save, start, copy, a package's update,
 * delete) and the service's test are refused with the human-input refusal (WORKFLOW_HUMAN_INPUT_DENIED, 403), and no
 * definition, revision or note is written; reads still answer. The ordinary controlling session still saves.
 * (The HTTP save route is covered in packages/app/web/test/workflow-session-definitions-runtime.test.mjs.)
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { startSessionWorkflowTest } from "../../src/workflow/definition-test.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowAgentChildSessionId, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: `step-guard-${randomUUID()}` };
const PERSON = { provider: OWNER.provider, subject: OWNER.subject, displayName: "Ada Lovelace" };
const STEP_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: stepper, version: "1.0.0" }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "Say one thing." }
    timeoutSeconds: 600
    transition: { next: { said: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`;
const SAVED_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: waiter, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

/** A session whose Workflow's agent step runs in its own session (`step`), and a session below it (`below`). */
async function stepFixture(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const ownerSession = randomUUID();
    await catalog.createSession(ownerSession, { owner: OWNER });
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const compiled = compileWorkflow(STEP_YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect((await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: ownerSession, owner: OWNER,
        creationConfig: { workflow: { requestSha256: "step-guard" } } })).created).toBe(true);
    await store.createDefinition({
        workflowSessionId, parentSessionId: ownerSession, notifyParent: false, yaml: STEP_YAML, compiled, actor: { kind: "system", name: "step-guard-test" },
        operationId: "create", requestSha256: "step-guard", publish: true, title: "Workflow: stepper",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "talk", 1);
    const step = workflowAgentChildSessionId(nodeExecutionId);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "talk", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: canonicalJson({}), kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId: step, controllingSessionId: ownerSession, task: { source: "prompt", prompt: "Say one thing." }, outcomes: ["said"],
            outputSchema: null, timeoutSeconds: 600 },
    })).toMatchObject({ admitted: true });
    await catalog.createSession(step, { parentSessionId: workflowSessionId, owner: OWNER });
    const below = randomUUID();
    await catalog.createSession(below, { parentSessionId: step, owner: OWNER });
    expect((await store.readWorkflowLineage(step))?.agentRoot).toMatchObject({ workflowSessionId, controllingSessionId: ownerSession });
    return { catalog, store, ownerSession, step, below, workflowSessionId };
}

describe("a session's Workflow Definitions change only outside a Workflow (PRS-002)", () => {
    it("refuses its owner's save, start, copy, update, delete and test for an agent step's session and one below it; nothing is written; reads answer; the controlling session saves", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const f = await stepFixture(env);
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {} });
        await mgmt.start();
        try {
            for (const session of [f.step, f.below]) {
                const refusals = [
                    () => mgmt.saveSessionWorkflowDefinition(session, { name: "waiter", yaml: SAVED_YAML, operationId: `save-${session}` }, { principal: PERSON }),
                    () => mgmt.startSessionWorkflowDefinition(session, { definitionId: "def-any", operationId: `start-${session}` }, { principal: PERSON }),
                    () => mgmt.copySessionWorkflowDefinition(session, { definitionId: "def-any", operationId: `copy-${session}` }, { principal: PERSON }),
                    () => mgmt.updateSessionWorkflowPackage(session, { definitionId: "def-any", operationId: `update-${session}` }, { principal: PERSON }),
                    () => mgmt.deleteSessionWorkflowDefinition(session, { definitionId: "def-any", operationId: `delete-${session}` }, { principal: PERSON }),
                    () => startSessionWorkflowTest({ catalog: f.catalog, store: f.store, duroxideClient: null }, {
                        ownerSessionId: session, definition: { name: "waiter" }, inputs: {}, fixtures: [], operationId: `test-${session}`,
                        actor: { kind: "agent", sessionId: session }, owner: async () => OWNER, binding: async () => null }),
                ];
                for (const [index, refused] of refusals.entries()) {
                    const error = await refused().then(() => null, e => e);
                    expect(error, `${session === f.step ? "step" : "below"} #${index}`).toMatchObject({ code: "WORKFLOW_HUMAN_INPUT_DENIED" });
                    expect(error.message).toContain(`runs a step of workflow ${f.workflowSessionId}: people cannot save, start, test, copy, update or delete its Workflow Definitions.`);
                    if (index < 5) expect(error.status, `#${index}`).toBe(403);
                }
                expect(await f.store.sessionDefinitions.listDefinitions(session, { includeDeleted: true })).toEqual([]);
                expect(await f.store.sessionDefinitions.pendingNotes(session)).toEqual([]);
                // Reads still answer.
                expect(await mgmt.listSessionWorkflowDefinitions(session)).toEqual([]);
            }
            // Control: the session that controls the Workflow saves, and its note is pending for its next turn.
            const saved = await mgmt.saveSessionWorkflowDefinition(f.ownerSession, { name: "waiter", yaml: SAVED_YAML, operationId: "save-owner" }, { principal: PERSON });
            expect(saved).toMatchObject({ name: "waiter", revision: 1, valid: true });
            expect(await f.store.sessionDefinitions.pendingNotes(f.ownerSession)).toHaveLength(1);
        } finally {
            await mgmt.stop();
            await f.catalog.close();
        }
    });
});
