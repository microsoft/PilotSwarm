/**
 * The Workflow V2 test environment switch and a person's own chat (test-only; test-environment.ts; found in the preview
 * on 792c61e3). With the switch on, the session clients the deployed entry points build (the portal's NodeSdkTransport,
 * the MCP server's direct mode) start new sessions at the durable intake's orchestration (1.0.83), which every worker
 * of the environment serves. Its turns take request, agent and parallel states, so the chat's spawn_workflow saves a
 * workflow with an agent state as a valid draft. With the switch off, sessions start at the latest version (1.0.82)
 * and the agent state is refused (WORKFLOW_NODE_TYPE_UNSUPPORTED), exactly as before.
 *
 * A full worker (PostgreSQL, duroxide and the Copilot CLI) with the model scripted. The worker's options and the
 * client's start version are what the switch gives the entry points (workerOptionsForWorkflowV2TestEnvironment,
 * workflowV2TestEnvironmentFromEnv(...).sessionStartVersion, passed to PilotSwarmClient._startSessionsAt as
 * NodeSdkTransport.start and the MCP context do). Nothing runs: the workflow stays a draft.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { DURABLE_SESSION_INTAKE_VERSION, DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";
import { workerOptionsForWorkflowV2TestEnvironment, workflowV2TestEnvironmentFromEnv } from "../../src/index.ts";

const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "workflow-v2-switch-owner" };
const PROMPT = "Draft a workflow with one agent step that reviews a change.";
const ON = { PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" };
const OFF = {};

const YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: preview-review, version: "1.0.0" }
initialInput: { head: "abc" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "Review the change at the given head." }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

const getEnv = useSuiteEnv(import.meta.url);

/**
 * A person's chat in a deployment whose environment is `processEnv`: the worker and the client configured as the
 * switch configures them, the chat asked to draft the workflow. The chat's orchestration version and its spawn_workflow
 * result.
 */
async function chatDraftsAgentWorkflow(env, processEnv) {
    const results = [];
    const respond = (_body, position) => {
        if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
        if (position.step === 0) return { tools: [{ name: "spawn_workflow", args: { yaml: YAML, key: "preview-agent-step" } }] };
        results.push(position.toolResults[0]);
        return { content: "Saved the draft." };
    };
    const worker = workerOptionsForWorkflowV2TestEnvironment({ workflowScripts: { enabled: true } }, processEnv);
    const test = workflowV2TestEnvironmentFromEnv(processEnv);
    let outcome = null;
    await withScriptedModel(env, { respond, worker }, async ({ client, qualifiedModel }) => {
        if (test) client._startSessionsAt(test.sessionStartVersion);
        const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
        await chat.sendAndWait(PROMPT, TIMEOUT);
        expect(results, "the chat's spawn_workflow answered").toHaveLength(1);
        outcome = { version: await sessionOrchestrationVersion(client, chat.sessionId), result: JSON.parse(results[0]) };
    });
    return outcome;
}

describe("the Workflow V2 test environment switch: where a person's new chat starts", () => {
    it("on: a new chat starts at 1.0.83, and its spawn_workflow saves a workflow with an agent state as a valid draft", { timeout: TIMEOUT }, async () => {
        expect(workflowV2TestEnvironmentFromEnv(ON)?.sessionStartVersion).toBe(DURABLE_SESSION_INTAKE_VERSION);
        const { version, result } = await chatDraftsAgentWorkflow(getEnv(), ON);
        expect(version).toBe(DURABLE_SESSION_INTAKE_VERSION);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: "draft", revision: 1, valid: true, run: null });
        expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
    });

    it("off: a new chat starts at the latest version, 1.0.82, and the agent state is refused as before", { timeout: TIMEOUT }, async () => {
        expect(workflowV2TestEnvironmentFromEnv(OFF)).toBeNull();
        const { version, result } = await chatDraftsAgentWorkflow(getEnv(), OFF);
        expect(version).toBe(DURABLE_SESSION_LATEST_VERSION);
        expect(DURABLE_SESSION_LATEST_VERSION).toBe("1.0.82");
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: "draft", valid: false });
        expect(result.diagnostics.filter(item => item.severity === "error").map(item => [item.code, item.path]))
            .toEqual([["WORKFLOW_NODE_TYPE_UNSUPPORTED", "states.review.type"]]);
    });
});
