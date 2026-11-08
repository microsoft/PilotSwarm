/**
 * The full Workflow engine for a person's own chat, with no option (owner decision 2026-11-08T15:30Z; this replaces the
 * Workflow V2 test environment switch's test, found in the preview on 792c61e3). A new session starts at the latest
 * version, 1.0.83, whose turns take request, agent and parallel states, so the chat's spawn_workflow saves a workflow
 * with an agent state as a valid draft. A sub-agent the chat spawns (spawn_agent) starts at 1.0.83 too, so an agent can
 * delegate writing such a workflow; so does the sub-agent of a chat of the previous release (1.0.82, until its
 * continue-as-new).
 *
 * A full worker (PostgreSQL, duroxide and the Copilot CLI) with the model scripted, created with no test option.
 * Nothing runs: the workflow stays a draft.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";

const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "workflow-v2-switch-owner" };
const PROMPT = "Draft a workflow with one agent step that reviews a change.";

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

/** A person's chat on a worker and client created with no option, asked to draft the workflow: its version and result. */
async function chatDraftsAgentWorkflow(env) {
    const results = [];
    const respond = (_body, position) => {
        if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
        if (position.step === 0) return { tools: [{ name: "spawn_workflow", args: { yaml: YAML, key: "preview-agent-step" } }] };
        results.push(position.toolResults[0]);
        return { content: "Saved the draft." };
    };
    const worker = { workflowScripts: { enabled: true } };
    let outcome = null;
    await withScriptedModel(env, { respond, worker }, async ({ client, qualifiedModel }) => {
        const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
        await chat.sendAndWait(PROMPT, TIMEOUT);
        expect(results, "the chat's spawn_workflow answered").toHaveLength(1);
        outcome = { version: await sessionOrchestrationVersion(client, chat.sessionId), result: JSON.parse(results[0]) };
    });
    return outcome;
}

describe("the full engine: where a person's new chat starts", () => {
    it("a new chat starts at the latest version, 1.0.83, and its spawn_workflow saves a workflow with an agent state as a valid draft", { timeout: TIMEOUT }, async () => {
        expect(DURABLE_SESSION_LATEST_VERSION).toBe("1.0.83");
        const { version, result } = await chatDraftsAgentWorkflow(getEnv());
        expect(version).toBe(DURABLE_SESSION_LATEST_VERSION);
        // Stage 2.1: spawn_workflow saves revision 1 of the chat's definition (no Workflow until it is started).
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
        expect(result.errors).toEqual([]);
    });
});

const DELEGATE = "Ask a sub-agent to draft a workflow with one agent step.";
const CHILD = "DELEGATED-WORKFLOW-AUTHOR: draft a workflow with one agent step that reviews a change.";

async function until(check, label, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/**
 * A person's chat that delegates the workflow to a sub-agent (spawn_agent), on a worker created with no option. The chat
 * starts at the latest version, or, with `previousRelease`, at 1.0.82 as a chat of the previous release: the turn's own
 * client starts its sub-agents at the latest version either way. The chat's and the sub-agent's orchestration versions,
 * the sub-agent's parent, and its spawn_workflow result.
 */
async function subAgentDraftsAgentWorkflow(env, { previousRelease = false } = {}) {
    const results = [];
    const respond = (_body, position) => {
        if (position.firstUserText.includes(CHILD)) {
            if (!position.lastUserText.includes(CHILD)) return { content: "ok" };
            if (position.step === 0) return { tools: [{ name: "spawn_workflow", args: { yaml: YAML, key: "delegated-agent-step" } }] };
            results.push(position.toolResults[0]);
            return { content: "Saved the draft." };
        }
        if (!position.lastUserText.includes(DELEGATE)) return { content: "ok" };
        if (position.step === 0) return { tools: [{ name: "spawn_agent", args: { task: CHILD } }] };
        return { content: "Delegated." };
    };
    const worker = { workflowScripts: { enabled: true } };
    let outcome = null;
    await withScriptedModel(env, { respond, worker }, async ({ client, qualifiedModel }) => {
        if (previousRelease) client._startSessionsAt("1.0.82");
        const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
        await chat.sendAndWait(DELEGATE, TIMEOUT);
        await until(() => results.length > 0, "the sub-agent's spawn_workflow");
        const result = JSON.parse(results[0]);
        // Stage 2.1: the definition belongs to the sub-agent that saved it.
        const definition = await client._catalog.workflowStore().chat.readDefinition(result.definitionId);
        const subAgent = await client._catalog.getSession(definition.ownerSessionId);
        outcome = { chatVersion: await sessionOrchestrationVersion(client, chat.sessionId), version: await sessionOrchestrationVersion(client, subAgent.sessionId),
            parent: subAgent.parentSessionId, chat: chat.sessionId, result };
    });
    return outcome;
}

describe("the full engine: where a chat's sub-agent starts", () => {
    it("a 1.0.83 chat's sub-agent starts at 1.0.83, and its spawn_workflow saves a workflow with an agent state as a valid draft", { timeout: TIMEOUT }, async () => {
        const { chatVersion, version, parent, chat, result } = await subAgentDraftsAgentWorkflow(getEnv());
        expect(chatVersion).toBe(DURABLE_SESSION_LATEST_VERSION);
        expect(parent).toBe(chat);
        expect(version).toBe(DURABLE_SESSION_LATEST_VERSION);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
    });

    it("a chat of the previous release (1.0.82) still gets a 1.0.83 sub-agent, whose draft is valid", { timeout: TIMEOUT }, async () => {
        const { version, parent, chat, result } = await subAgentDraftsAgentWorkflow(getEnv(), { previousRelease: true });
        expect(parent).toBe(chat);
        expect(version).toBe(DURABLE_SESSION_LATEST_VERSION);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
    });
});
