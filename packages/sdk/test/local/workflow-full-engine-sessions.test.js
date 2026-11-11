/**
 * The full Workflow engine for a person's own session, with no option (owner decision 2026-11-08T15:30Z; this replaces the
 * Workflow test environment switch's test, found in the preview on 792c61e3). A new session starts at the latest
 * version, 1.0.83, whose turns take request, agent and parallel states, so the session's workflow_definition saves a
 * workflow with an agent state as a valid revision. A sub-agent the session spawns (spawn_agent) starts at 1.0.83 too, so an
 * agent can delegate writing such a workflow; so does the sub-agent of a session of the previous release (1.0.82, until its
 * continue-as-new). The session has Workflows on (turned on before its prompt); the sub-agent turns them on itself with
 * enable_workflows, whose next turn starts at once with the Workflow tools (Workflows on demand, owner 2026-11-08T16:55Z).
 *
 * A full worker (PostgreSQL, duroxide and the Copilot CLI) with the model scripted, created with no test option.
 * Nothing runs: the workflow stays a draft.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";
import { sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";

const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "workflow-switch-owner" };
const PROMPT = "Draft a workflow with one agent step that reviews a change.";

const YAML = `
apiVersion: pilotswarm.dev/v1
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

/** A person's session on a worker and client created with no option, asked to draft the workflow: its version and result. */
async function sessionDraftsAgentWorkflow(env) {
    const results = [];
    const respond = (_body, position) => {
        if (!position.lastUserText.includes(PROMPT)) return { content: "ok" };
        if (position.step === 0) return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "preview-review", yaml: YAML } }] };
        results.push(position.toolResults[0]);
        return { content: "Saved the draft." };
    };
    const worker = { workflowScripts: { enabled: true } };
    let outcome = null;
    await withScriptedModel(env, { respond, worker }, async ({ client, qualifiedModel }) => {
        const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
        await turnWorkflowsOn(client._catalog, session.sessionId);
        await session.sendAndWait(PROMPT, TIMEOUT);
        expect(results, "the session's workflow_definition answered").toHaveLength(1);
        outcome = { version: await sessionOrchestrationVersion(client, session.sessionId), result: JSON.parse(results[0]) };
    });
    return outcome;
}

describe("the full engine: where a person's new session starts", () => {
    it("a new session starts at the latest version, 1.0.83, and its workflow_definition saves a workflow with an agent state as a valid revision", { timeout: TIMEOUT }, async () => {
        expect(DURABLE_SESSION_LATEST_VERSION).toBe("1.0.83");
        const { version, result } = await sessionDraftsAgentWorkflow(getEnv());
        expect(version).toBe(DURABLE_SESSION_LATEST_VERSION);
        // Stage 2.1: save makes revision 1 of the session's definition (no Workflow until it is started).
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
 * A person's session that delegates the workflow to a sub-agent (spawn_agent), on a worker created with no option. The session
 * starts at the latest version, or, with `previousRelease`, at 1.0.82 as a session of the previous release: the turn's own
 * client starts its sub-agents at the latest version either way. The session's and the sub-agent's orchestration versions,
 * the sub-agent's parent, and its workflow_definition result. The sub-agent first calls enable_workflows; its next turn
 * starts at once with the Workflow tools (it is told "Workflows are now on in this session").
 */
async function subAgentDraftsAgentWorkflow(env, { previousRelease = false } = {}) {
    const results = [];
    const declared = [];
    const names = body => (body?.tools ?? []).map(tool => tool?.function?.name ?? tool?.name).filter(Boolean);
    const respond = (_body, position) => {
        if (position.firstUserText.includes(CHILD)) {
            if (position.lastUserText.includes(CHILD)) {
                if (position.step === 0) {
                    declared.push(names(_body));
                    return { tools: [{ name: "enable_workflows", args: {} }] };
                }
                return { content: "Turning Workflows on." };
            }
            if (!position.lastUserText.includes("Workflows are now on in this session")) return { content: "ok" };
            if (position.step === 0) {
                declared.push(names(_body));
                return { tools: [{ name: "workflow_definition", args: { operation: "save", name: "preview-review", yaml: YAML } }] };
            }
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
        const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
        await session.sendAndWait(DELEGATE, TIMEOUT);
        await until(() => results.length > 0, "the sub-agent's workflow_definition");
        const result = JSON.parse(results[0]);
        // Stage 2.1: the definition belongs to the sub-agent that saved it.
        const definition = await client._catalog.workflowStore().sessionDefinitions.readDefinition(result.definitionId);
        const subAgent = await client._catalog.getSession(definition.ownerSessionId);
        outcome = { sessionVersion: await sessionOrchestrationVersion(client, session.sessionId), version: await sessionOrchestrationVersion(client, subAgent.sessionId),
            parent: subAgent.parentSessionId, session: session.sessionId, result, declared,
            flag: (await client._catalog.getSessionCapabilities(subAgent.sessionId)).workflows };
    });
    return outcome;
}

describe("the full engine: where a session's sub-agent starts", () => {
    it("a 1.0.83 session's sub-agent starts at 1.0.83, turns Workflows on, and its workflow_definition saves a workflow with an agent state as a valid revision", { timeout: TIMEOUT }, async () => {
        const { sessionVersion, version, parent, session, result, declared, flag } = await subAgentDraftsAgentWorkflow(getEnv());
        expect(sessionVersion).toBe(DURABLE_SESSION_LATEST_VERSION);
        expect(parent).toBe(session);
        expect(version).toBe(DURABLE_SESSION_LATEST_VERSION);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
        // Off at first: enable_workflows and no Workflow tool; on in the next turn: the Workflow tools, and enable_workflows
        // still declared (answered "already on": a call of an undeclared tool is refused by the CLI, a Failed row).
        expect(declared[0]).toContain("enable_workflows");
        expect(declared[0]).not.toContain("workflow_definition");
        expect(declared[1]).toContain("workflow_definition");
        expect(declared[1]).toContain("enable_workflows");
        expect(flag).toBe(true);
    });

    it("a session of the previous release (1.0.82) still gets a 1.0.83 sub-agent, whose draft is valid", { timeout: TIMEOUT }, async () => {
        const { version, parent, session, result } = await subAgentDraftsAgentWorkflow(getEnv(), { previousRelease: true });
        expect(parent).toBe(session);
        expect(version).toBe(DURABLE_SESSION_LATEST_VERSION);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
    });
});
