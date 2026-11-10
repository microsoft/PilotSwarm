/**
 * Review PRS-002 (security review of a00f9c32): a session that runs a Workflow's agent step, or a descendant of one,
 * takes no person's definition change. Its owner's direct management calls (save, start, copy, a package's update,
 * delete) and the service's test are refused with the human-input refusal (WORKFLOW_HUMAN_INPUT_DENIED, 403), and no
 * definition, revision or note is written; reads still answer. The ordinary controlling chat still saves.
 * (The HTTP save route is covered in packages/app/web/test/workflow-chat-definitions-runtime.test.mjs.)
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { startChatWorkflowTest } from "../../src/workflow/v2/chat-test.ts";
import { WORKFLOW_V2_CONTROLLER_VERSION, workflowAgentChildSessionId, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: `step-guard-${randomUUID()}` };
const PERSON = { provider: OWNER.provider, subject: OWNER.subject, displayName: "Ada Lovelace" };
const STEP_YAML = `
apiVersion: pilotswarm.dev/v2-draft
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
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: waiter, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

/** A chat whose Workflow's agent step runs in its own session (`step`), and a session below it (`below`). */
async function stepFixture(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const chat = randomUUID();
    await catalog.createSession(chat, { owner: OWNER });
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const compiled = compileWorkflowV2(STEP_YAML, { enableRequests: true, enableAgents: true });
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: chat, owner: OWNER,
        creationConfig: { workflowV2: { requestSha256: "step-guard" } } })).created).toBe(true);
    await store.createDefinition({
        workflowSessionId, parentSessionId: chat, notifyParent: false, yaml: STEP_YAML, compiled, actor: { kind: "system", name: "step-guard-test" },
        operationId: "create", requestSha256: "step-guard", publish: true, title: "Workflow: stepper",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null, controllerVersion: WORKFLOW_V2_CONTROLLER_VERSION },
    });
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "talk", 1);
    const step = workflowAgentChildSessionId(nodeExecutionId);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "talk", ordinal: 1, nodeType: "agent", predecessorId: null, arrivalRoute: null,
        inputText: canonicalJson({}), kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId: step, controllingSessionId: chat, task: { source: "prompt", prompt: "Say one thing." }, outcomes: ["said"],
            outputSchema: null, timeoutSeconds: 600 },
    })).toMatchObject({ admitted: true });
    await catalog.createSession(step, { parentSessionId: workflowSessionId, owner: OWNER });
    const below = randomUUID();
    await catalog.createSession(below, { parentSessionId: step, owner: OWNER });
    expect((await store.readWorkflowLineage(step))?.agentRoot).toMatchObject({ workflowSessionId, controllingSessionId: chat });
    return { catalog, store, chat, step, below, workflowSessionId };
}

describe("a chat's Workflow Definitions change only outside a Workflow (PRS-002)", () => {
    it("refuses its owner's save, start, copy, update, delete and test for an agent step's session and one below it; nothing is written; reads answer; the controlling chat saves", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const f = await stepFixture(env);
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {} });
        await mgmt.start();
        try {
            for (const session of [f.step, f.below]) {
                const refusals = [
                    () => mgmt.saveChatWorkflowDefinition(session, { name: "waiter", yaml: SAVED_YAML, operationId: `save-${session}` }, { principal: PERSON }),
                    () => mgmt.startChatWorkflowDefinition(session, { definitionId: "def-any", operationId: `start-${session}` }, { principal: PERSON }),
                    () => mgmt.copyChatWorkflowDefinition(session, { definitionId: "def-any", operationId: `copy-${session}` }, { principal: PERSON }),
                    () => mgmt.updateChatWorkflowPackage(session, { definitionId: "def-any", operationId: `update-${session}` }, { principal: PERSON }),
                    () => mgmt.deleteChatWorkflowDefinition(session, { definitionId: "def-any", operationId: `delete-${session}` }, { principal: PERSON }),
                    () => startChatWorkflowTest({ catalog: f.catalog, store: f.store, duroxideClient: null }, {
                        ownerSessionId: session, definition: { name: "waiter" }, inputs: {}, fixtures: [], operationId: `test-${session}`,
                        actor: { kind: "agent", sessionId: session }, owner: async () => OWNER, binding: async () => null }),
                ];
                for (const [index, refused] of refusals.entries()) {
                    const error = await refused().then(() => null, e => e);
                    expect(error, `${session === f.step ? "step" : "below"} #${index}`).toMatchObject({ code: "WORKFLOW_HUMAN_INPUT_DENIED" });
                    expect(error.message).toContain(`runs a step of workflow ${f.workflowSessionId}: people cannot save, start, test, copy, update or delete its Workflow Definitions.`);
                    if (index < 5) expect(error.status, `#${index}`).toBe(403);
                }
                expect(await f.store.chat.listDefinitions(session, { includeDeleted: true })).toEqual([]);
                expect(await f.store.chat.pendingNotes(session)).toEqual([]);
                // Reads still answer.
                expect(await mgmt.listChatWorkflowDefinitions(session)).toEqual([]);
            }
            // Control: the chat that controls the Workflow saves, and its note is pending for its next turn.
            const saved = await mgmt.saveChatWorkflowDefinition(f.chat, { name: "waiter", yaml: SAVED_YAML, operationId: "save-chat" }, { principal: PERSON });
            expect(saved).toMatchObject({ name: "waiter", revision: 1, valid: true });
            expect(await f.store.chat.pendingNotes(f.chat)).toHaveLength(1);
        } finally {
            await mgmt.stop();
            await f.catalog.close();
        }
    });
});
