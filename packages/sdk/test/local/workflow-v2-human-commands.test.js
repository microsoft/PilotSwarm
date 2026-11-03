/**
 * Workflow v2: a person's workflow command in direct mode (design 04
 * updateWorkflow; R13, R26, D11), on real PostgreSQL, INACTIVE: only a
 * management client created with the test-only option `workflowCommands`
 * takes one.
 *
 * - Without the option the command is refused (501
 *   WORKFLOW_COMMANDS_UNAVAILABLE) and nothing changes.
 * - With it, a person drafts, publishes and starts a workflow, sets its KV,
 *   pauses, resumes and cancels its run, through the update_workflow tool's
 *   own implementation; the receipts are the tool's, and the recorded actor
 *   is the person (a command's own actor field is ignored).
 * - The command targets the session it is sent to; recover stays the
 *   agent's; a session that is missing or not a version 2 workflow is 404;
 *   stop is a milestone operation (refused without controller 1.9.0).
 * - A workflow inside a workflow agent state's subtree takes only a person's
 *   brakes (pause, cancel): anything else is 403 WORKFLOW_HUMAN_INPUT_DENIED,
 *   naming its controlling agent; the workflow container above it takes every
 *   command.
 * - Reading: only a client that takes a person's commands reports which ones
 *   the workflow takes (personCommands: the operations, the subtree's
 *   restriction naming its controlling agent, whether the shown run takes a
 *   graceful stop, and a draft's current YAML); without the option the view
 *   is unchanged.
 * - A person's cancel without a reason ends the run as cancelled by a person,
 *   not by its parent.
 *
 * No controller runs here: the receipts and the store's run state are what a
 * person's command changes. Not an activation proof.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { WORKFLOW_HUMAN_INPUT_DENIED } from "../../src/workflow/v2/input-policy.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-human-commands-test" };
const PERSON = { provider: "test", subject: "alice" };

const YAML = (name, seconds = 3600) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: hold
states:
  hold:
    type: wait
    seconds: ${seconds}
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded }
`;

const AGENT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: reviewer, version: "1.0.0" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "Review it." }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

async function refused(call, code, status) {
    let caught;
    try { await call(); } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    expect(caught?.status, caught?.message).toBe(status);
    return caught;
}

/** A workflow session of `parent` with `yaml`; published and started when `start` (its live run id is returned). */
async function workflowOf(catalog, parent, yaml, { start = false, compile = {}, controllerVersion } = {}) {
    const store = catalog.workflowStore();
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const compiled = compileWorkflowV2(yaml, compile);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflowV2: { requestSha256: "human-commands" } } })).created).toBe(true);
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR, operationId: "create",
        requestSha256: "human-commands", publish: start, title: `Workflow: ${compiled.name}`,
        start: start ? { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null, ...(controllerVersion ? { controllerVersion } : {}) } : null,
    });
    return { workflowSessionId, runId: start ? runId : null, definitionHash: compiled.yamlSha256 };
}

async function commandsClient(env, workflowCommands) {
    const mgmt = new PilotSwarmManagementClient({
        store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, workflowCommands,
    });
    await mgmt.start();
    return mgmt;
}

describe("workflow v2: a person's workflow command (direct management client, inactive)", () => {
    it("is refused without the test-only option, and with it drafts, publishes, starts and controls a run as the person", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const plain = await createManagementClient(env);
        const mgmt = await commandsClient(env, { requests: false });
        try {
            const store = catalog.workflowStore();
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: PERSON });
            const draft = await workflowOf(catalog, parent, YAML("person-draft"));
            // Reading: only a client that takes a person's commands says which ones the workflow takes.
            expect(Object.hasOwn(await plain.readWorkflow(draft.workflowSessionId), "personCommands")).toBe(false);
            // A draft a person may change also comes with its current YAML, the text they edit.
            expect((await mgmt.readWorkflow(draft.workflowSessionId)).personCommands).toEqual({
                operations: ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel"],
                restriction: null, run: null, draft: { revision: 1, definitionHash: draft.definitionHash, yaml: YAML("person-draft") } });

            // Inactive: refused, and nothing changes.
            await refused(() => plain.updateWorkflow(draft.workflowSessionId, { operation: "publish", operation_id: "p-0", expected_revision: 1,
                definition_hash: draft.definitionHash }, { principal: PERSON }), "WORKFLOW_COMMANDS_UNAVAILABLE", 501);
            expect((await store.readDefinition(draft.workflowSessionId)).state).toBe("draft");

            // The tool's own commands and receipts, as the person.
            const yaml2 = YAML("person-draft", 600);
            const replaced = await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "replace_definition", operation_id: "edit-1",
                expected_revision: 1, yaml: yaml2 }, { principal: PERSON });
            expect(replaced).toMatchObject({ workflowId: draft.workflowSessionId, operation: "replace_definition", replayed: false, state: "draft", revision: 2, valid: true });
            expect(replaced.ok).toBeUndefined();
            const published = await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "publish", operation_id: "pub-1", expected_revision: 2,
                definition_hash: replaced.definitionHash }, { principal: PERSON });
            expect(published).toMatchObject({ operation: "publish", state: "published", publishedRevision: 2 });
            const started = await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "start", operation_id: "start-1",
                definition_hash: replaced.definitionHash, inputs: {} }, { principal: PERSON });
            expect(started).toMatchObject({ operation: "start", run: { mode: "live", revision: 2 } });
            const runId = started.run.runId;
            // The shown run: this host stops no run gracefully (controller 1.8.0), so it offers no stop; a published
            // definition has no draft to edit.
            const publishedCommands = (await mgmt.readWorkflow(draft.workflowSessionId)).personCommands;
            expect(publishedCommands.run).toEqual({ runId, stop: false });
            expect(Object.hasOwn(publishedCommands, "draft")).toBe(false);
            // A repeat of an operation id returns its receipt.
            expect(await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "start", operation_id: "start-1",
                definition_hash: replaced.definitionHash, inputs: {} }, { principal: PERSON })).toMatchObject({ replayed: true, run: { runId } });

            expect(await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "set_vars", operation_id: "kv-1", set: { threshold: 3 },
                expected_kv_revision: 1 }, { principal: PERSON })).toMatchObject({ operation: "set_vars", runId, kvRevision: 2 });
            // A command's own actor field is not its actor: the person is.
            expect(await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "pause", operation_id: "pause-1", reason: "look first",
                actor: { kind: "agent", sessionId: parent } }, { principal: PERSON })).toMatchObject({ operation: "pause", runId, status: "paused" });
            expect(await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "resume", operation_id: "resume-1" }, { principal: PERSON }))
                .toMatchObject({ operation: "resume", runId, status: "admitted" });
            // Without a principal, the client itself is the actor.
            expect(await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "set_vars", operation_id: "kv-2", set: { threshold: 4 },
                expected_kv_revision: 2 })).toMatchObject({ kvRevision: 3 });
            // An operation id used for another request is a conflict (409), as for the tool.
            await refused(() => mgmt.updateWorkflow(draft.workflowSessionId, { operation: "set_vars", operation_id: "kv-1", set: { threshold: 9 },
                expected_kv_revision: 3 }, { principal: PERSON }), "OPERATION_CONFLICT", 409);
            expect(await mgmt.updateWorkflow(draft.workflowSessionId, { operation: "cancel", operation_id: "cancel-1" }, { principal: PERSON }))
                .toMatchObject({ operation: "cancel", runId });
            const events = await catalog.getSessionEvents(draft.workflowSessionId, 0, 500);
            // Without a reason, the run's end says a person cancelled it (the agent tool's default names its parent).
            expect(events.find(event => event.eventType === "workflow.cancelled")?.data).toMatchObject({ runId, reason: "Cancelled by a person" });
            expect((await store.readRun(runId)).terminalError).toMatchObject({ code: "cancelled", message: "Cancelled by a person" });
            const actors = events.filter(event => ["workflow.vars_set", "workflow.paused", "workflow.resumed"].includes(event.eventType))
                .map(event => [event.eventType, event.data.actor]);
            expect(actors).toEqual([["workflow.vars_set", { kind: "user", ...PERSON }], ["workflow.paused", { kind: "user", ...PERSON }],
                ["workflow.resumed", { kind: "user", ...PERSON }], ["workflow.vars_set", { kind: "system", name: "management-client" }]]);

            // The command's target, recover, missing sessions and milestone operations.
            await refused(() => mgmt.updateWorkflow(draft.workflowSessionId, { workflow_id: randomUUID(), operation: "pause", operation_id: "x-1" }),
                "WORKFLOW_COMMAND_INVALID", 400);
            await refused(() => mgmt.updateWorkflow(draft.workflowSessionId, { operation: "recover", operation_id: "x-2" }), "WORKFLOW_COMMAND_INVALID", 400);
            await refused(() => mgmt.updateWorkflow(draft.workflowSessionId, { operation: "stop", operation_id: "x-3" }), "WORKFLOW_COMMAND_INVALID", 400);
            await refused(() => mgmt.updateWorkflow(draft.workflowSessionId, []), "WORKFLOW_COMMAND_INVALID", 400);
            await refused(() => mgmt.updateWorkflow(randomUUID(), { operation: "pause", operation_id: "x-5" }), "NOT_FOUND", 404);
            await refused(() => mgmt.updateWorkflow(parent, { operation: "pause", operation_id: "x-6" }), "WORKFLOW_NOT_FOUND", 404);
        } finally {
            await mgmt.stop();
            await plain.stop();
            await catalog.close();
        }
    });

    it("lets a person only brake a workflow inside a workflow agent state's subtree, and command the container above it", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const mgmt = await commandsClient(env, { requests: true });
        try {
            const store = catalog.workflowStore();
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: PERSON });
            // The container: a workflow of the person's agent whose agent state was admitted with its child C.
            const container = await workflowOf(catalog, parent, AGENT_YAML, { start: true, compile: { enableRequests: true, enableAgents: true },
                controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION });
            const child = randomUUID();
            const nodeExecutionId = nodeExecutionIdFor(container.runId, "root", "review", 1);
            expect(await store.enterNode({
                runId: container.runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null,
                arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
                agent: { childSessionId: child, controllingSessionId: parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
                    outputSchema: "ReviewResult", timeoutSeconds: 3600 },
            })).toMatchObject({ admitted: true, inserted: true });
            await catalog.createSession(child, { parentSessionId: container.workflowSessionId });
            // The agent's own workflow, in the agent state's subtree.
            const nested = await workflowOf(catalog, child, YAML("nested"), { start: true, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION });

            // What it takes from a person, as its read model says: the brakes, with the reason and its controlling agent.
            expect((await mgmt.readWorkflow(nested.workflowSessionId)).personCommands).toEqual({
                operations: ["pause", "stop", "cancel"],
                restriction: { reason: "This workflow was started by an agent step of another workflow: people can pause, stop or cancel it; only its controlling agent changes, resumes or tests it.",
                    workflowSessionId: container.workflowSessionId, controllingSessionId: parent },
                run: { runId: nested.runId, stop: true },
            });
            const denied = await refused(() => mgmt.updateWorkflow(nested.workflowSessionId, { operation: "set_vars", operation_id: "kv-1", set: { a: 1 },
                expected_kv_revision: 1 }, { principal: PERSON }), WORKFLOW_HUMAN_INPUT_DENIED, 403);
            expect(denied.details).toMatchObject({ sessionId: nested.workflowSessionId, action: "workflow", workflowSessionId: container.workflowSessionId,
                nodeExecutionId, controllingSessionId: parent });
            for (const command of [
                { operation: "resume", operation_id: "r-1" },
                { operation: "replace_definition", operation_id: "e-1", expected_revision: 1, yaml: YAML("nested", 60) },
                { operation: "test", operation_id: "t-1", expected_revision: 1, definition_hash: nested.definitionHash, inputs: {} },
            ]) {
                await refused(() => mgmt.updateWorkflow(nested.workflowSessionId, command, { principal: PERSON }), WORKFLOW_HUMAN_INPUT_DENIED, 403);
            }
            expect((await store.readRun(nested.runId)).kvRevision).toBe(1);
            // Its brakes stay available.
            expect(await mgmt.updateWorkflow(nested.workflowSessionId, { operation: "pause", operation_id: "p-1" }, { principal: PERSON }))
                .toMatchObject({ operation: "pause", runId: nested.runId, status: "paused" });
            expect(await mgmt.updateWorkflow(nested.workflowSessionId, { operation: "stop", operation_id: "s-1", grace_seconds: 0 }, { principal: PERSON }))
                .toMatchObject({ operation: "stop", runId: nested.runId });

            // The container is not in an agent state's subtree: the person commands it, every operation of a 1.9.0 host.
            expect((await mgmt.readWorkflow(container.workflowSessionId)).personCommands).toEqual({
                operations: ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel",
                    "stop", "test", "test_respond", "test_advance"],
                restriction: null, run: { runId: container.runId, stop: true },
            });
            expect(await mgmt.updateWorkflow(container.workflowSessionId, { operation: "set_vars", operation_id: "kv-1", set: { note: "go" },
                expected_kv_revision: 1 }, { principal: PERSON })).toMatchObject({ operation: "set_vars", runId: container.runId, kvRevision: 2 });
            expect(await mgmt.updateWorkflow(container.workflowSessionId, { operation: "pause", operation_id: "p-1" }, { principal: PERSON }))
                .toMatchObject({ operation: "pause", status: "paused" });
        } finally {
            await mgmt.stop();
            await catalog.close();
        }
    });
});
