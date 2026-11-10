/**
 * Workflow Simplified stage 2.1, on PostgreSQL: a definition belongs to the chat (migration 0107; chat-definition-store.ts,
 * chat-definitions.ts, definition-tool.ts). The rules of the spec and the coordinator's readings Q1–Q10 and F2–F4, each
 * against the real store:
 * - save: revisions 1, 2, 3 with their author and base; a stale save is refused with who saved it and when (E2-3); the
 *   guard names the definition, so a deleted and re-created name does not let a stale save through (Q1); a revision with
 *   errors is saved and cannot start (E2-5); a second first save of a name is refused; two saves at the same moment: one;
 *   a repeated operation answers its receipt; saves only on a live chat (Q7);
 * - start: the newest valid revision by default, or a named one, or Run again's (Q10); the Workflow's own definition is
 *   that revision's YAML and stays so after later saves (R1);
 * - R6: a definition with a running Workflow cannot be deleted; a finished Workflow keeps its copy;
 * - R4: a chat with a running Workflow cannot complete (the management client's completeSession);
 * - R5, F2: a chat that is canceled, fails or completes ends its Workflows' runs; a deleted chat's definitions and
 *   Workflows are deleted;
 * - E2-4: a person's save leaves one note for the chat; the chat's own does not;
 * - spawn_workflow (D2, Q2, F4): saves to the definition the YAML names, guarded by the newest revision the chat has seen,
 *   and starts exactly the revision it saved.
 * - stage 2.1b, the portal's read (the management client's): a valid revision's graph, drawn as a Workflow's view draws
 *   it, none for one with errors, and whether the deployment takes a person's save, start and delete; the chat's own read
 *   has no graph.
 * No model, no controller: a started run stays admitted (a recording duroxide client stands in for the dispatch).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, createManagementClient } from "../helpers/local-workers.js";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import {
    chatCompletionRefusal, deleteChatWorkflowDefinition, listChatWorkflowDefinitions, readChatWorkflowDefinition, saveChatWorkflowDefinition,
    startChatWorkflowDefinition,
} from "../../src/workflow/v2/chat-definitions.ts";
import { spawnWorkflowCompatFromTool, workflowDefinitionFromTool } from "../../src/workflow/v2/definition-tool.ts";
import { readStoredAgentModels, readWorkflowAgentModels } from "../../src/workflow/v2/agent-models.ts";
import { createWorkflowAgentNodeHost } from "../../src/workflow/v2/agent-host.ts";
import { readWorkflowV2 } from "../../src/workflow/v2/tools.ts";
import { startChatWorkflowTest } from "../../src/workflow/v2/chat-test.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/v2/json.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "chat-definitions" };
const PERSON = { kind: "user", provider: "test", subject: "ada", display: "Ada Lovelace" };
const ENGINE = { kind: "system", name: "chat-definitions-test" };

const YAML = (seconds, name = "hn-top-watch", version = "1.0.0") => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "${version}" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const WITH_INPUTS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: hn-top-watch, version: "1.0.0" }
inputs:
  schema: { type: object, required: [topic], properties: { topic: { type: string } } }
initial: hold
states:
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const BROKEN = (name = "hn-top-watch") => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: nowhere
states:
  done: { type: terminal, outcome: succeeded }
`;

async function refused(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

/** The real store with a duroxide client that records the controller starts (no controller runs here). */
async function harness() {
    const h = await openWorkflowStore(getEnv());
    const dispatched = [];
    const host = {
        catalog: h.catalog, store: h.store,
        duroxideClient: {
            startOrchestrationVersioned: async (instanceId) => { dispatched.push(instanceId); },
            getStatus: async () => ({ status: "Running" }),
            enqueueEvent: async () => {},
        },
    };
    const chat = randomUUID();
    await h.catalog.createSession(chat, { owner: OWNER });
    return { h, host, chat, dispatched };
}

const save = (host, chat, yaml, expected, extra = {}) => saveChatWorkflowDefinition(host, { ownerSessionId: chat, name: extra.name ?? "hn-top-watch", yaml,
    expected, actor: extra.actor ?? { kind: "chat", sessionId: chat }, operationId: extra.operationId ?? `save-${randomUUID()}`, by: extra.by ?? "chat",
    ...(extra.personWords ? { personWords: extra.personWords } : {}) });
const start = (host, chat, definitionId, extra = {}) => startChatWorkflowDefinition(host, { ownerSessionId: chat, definition: { definitionId },
    revision: extra.revision ?? null, runAgainOf: extra.runAgainOf ?? null, inputs: {}, actor: ENGINE, operationId: extra.operationId ?? `start-${randomUUID()}` });

describe("a definition belongs to the chat (stage 2.1)", () => {
    it("revisions with author and base; a stale save refused with who and when; errors saved; start pins a revision (R1, E2-3, E2-5, Q10)", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        try {
            const first = (await save(host, chat, YAML(30), null)).receipt;
            expect(first).toMatchObject({ name: "hn-top-watch", revision: 1, basedOn: null, created: true, valid: true, semver: "1.0.0" });
            const id = first.definitionId;
            // The person saves revision 2 on revision 1; the chat's save based on revision 1 is now stale.
            const second = (await save(host, chat, YAML(45), { definitionId: id, revision: 1 }, { by: "person", actor: PERSON, personWords: "Ada Lovelace" })).receipt;
            expect(second).toMatchObject({ revision: 2, basedOn: 1, created: false });
            const stale = await refused(save(host, chat, YAML(60), { definitionId: id, revision: 1 }), "REVISION_STALE");
            expect(stale.message).toMatch(/^Revision 2 was saved by Ada Lovelace at .+\. Reload to edit it\. Nothing was saved\.$/);
            expect(stale.details).toMatchObject({ definitionId: id, currentRevision: 2, expectedRevision: 1 });
            // A revision with errors is saved, and cannot start.
            const broken = (await save(host, chat, BROKEN(), { definitionId: id, revision: 2 })).receipt;
            expect(broken).toMatchObject({ revision: 3, valid: false });
            expect(broken.diagnostics.length).toBeGreaterThan(0);
            await refused(start(host, chat, id, { revision: 3 }), "DEFINITION_INVALID");
            // Start without a revision: the newest valid (2). Its Workflow's own definition is revision 2's YAML.
            const started = await start(host, chat, id);
            expect(started).toMatchObject({ revision: 2, replayed: false });
            const own = await h.store.readDefinition(started.workflowId);
            expect(own).toMatchObject({ state: "published", parentSessionId: chat });
            expect((await h.store.readRevision(started.workflowId, 1)).yaml).toBe(YAML(45));
            // A later save never changes it (R1).
            await save(host, chat, YAML(90), { definitionId: id, revision: 3 });
            expect((await h.store.readRevision(started.workflowId, 1)).yaml).toBe(YAML(45));
            // An explicit revision; Run again pins the same revision as the Workflow it repeats.
            expect((await start(host, chat, id, { revision: 1 })).revision).toBe(1);
            expect((await start(host, chat, id, { runAgainOf: started.workflowId })).revision).toBe(2);
            // The same operation again: its receipt, no second Workflow.
            const op = `start-${randomUUID()}`;
            const once = await start(host, chat, id, { operationId: op });
            const twice = await start(host, chat, id, { operationId: op });
            expect(twice).toMatchObject({ workflowId: once.workflowId, replayed: true });
            const view = await readChatWorkflowDefinition(host, chat, { definitionId: id });
            expect(view.revisions.map(item => [item.revision, item.valid, item.basedOn, item.actor.kind])).toEqual([
                [1, true, null, "chat"], [2, true, 1, "user"], [3, false, 2, "chat"], [4, true, 3, "chat"]]);
            expect(view.workflows.map(item => item.revision)).toEqual([2, 1, 2, 4]);
            expect(view.newestValidRevision).toBe(4);
        } finally {
            await h.stop();
        }
    });

    it("a second first save of a name is refused; the YAML's name must be the definition's; two saves at once: exactly one", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        try {
            const first = (await save(host, chat, YAML(30), null)).receipt;
            const again = await refused(save(host, chat, YAML(31), null), "DEFINITION_EXISTS");
            expect(again.details).toMatchObject({ definitionId: first.definitionId, currentRevision: 1 });
            await refused(save(host, chat, YAML(30, "other-name"), { definitionId: first.definitionId, revision: 1 }), "WORKFLOW_NAME_MISMATCH");
            for (let round = 0; round < 5; round += 1) {
                const current = (await h.store.chat.readDefinition(first.definitionId)).currentRevision;
                const results = await Promise.allSettled([40, 50].map(seconds => save(host, chat, YAML(seconds + round), { definitionId: first.definitionId, revision: current })));
                expect(results.map(result => result.status).sort(), JSON.stringify(results.map(result => result.reason?.message ?? null))).toEqual(["fulfilled", "rejected"]);
                expect(results.find(result => result.status === "rejected").reason.code).toBe("REVISION_STALE");
            }
            // Two first saves of a new name at once: one definition.
            const named = await Promise.allSettled([1, 2].map(n => save(host, chat, YAML(n, "twin"), null, { name: "twin" })));
            expect(named.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
            expect(named.find(result => result.status === "rejected").reason.code).toBe("DEFINITION_EXISTS");
            expect((await listChatWorkflowDefinitions(host, chat)).map(view => view.name).sort()).toEqual(["hn-top-watch", "twin"]);
        } finally {
            await h.stop();
        }
    });

    it("delete: refused while a Workflow runs (R6); a deleted and re-created name refuses a stale save (Q1); the old copy stays", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        try {
            const id = (await save(host, chat, YAML(30), null)).receipt.definitionId;
            const started = await start(host, chat, id);
            const deleting = { ownerSessionId: chat, definitionId: id, actor: PERSON };
            const inUse = await refused(deleteChatWorkflowDefinition(host, { ...deleting, operationId: "delete-1" }), "DEFINITION_IN_USE");
            expect(inUse.details.workflowSessionIds).toEqual([started.workflowId]);
            await controlWorkflowV2Run(host, started.workflowId, { operation: "cancel", runId: null, reason: "test" }, { actor: ENGINE, operationId: "cancel-1" });
            expect((await deleteChatWorkflowDefinition(host, { ...deleting, operationId: "delete-2" })).receipt).toMatchObject({ definitionId: id, name: "hn-top-watch" });
            // Its Workflow keeps its copy; a save or a start of the deleted definition is refused.
            expect((await h.store.readRevision(started.workflowId, 1)).yaml).toBe(YAML(30));
            await refused(save(host, chat, YAML(31), { definitionId: id, revision: 1 }), "DEFINITION_DELETED");
            await refused(start(host, chat, id), "DEFINITION_DELETED");
            // The name is re-created: revision 1 of a new definition. A save still based on the old one's revision 1 is refused.
            const again = (await save(host, chat, YAML(32), null)).receipt;
            expect(again).toMatchObject({ revision: 1, created: true });
            expect(again.definitionId).not.toBe(id);
            await refused(save(host, chat, YAML(33), { definitionId: id, revision: 1 }), "DEFINITION_DELETED");
            expect((await h.store.chat.readDefinition(again.definitionId)).currentRevision).toBe(1);
        } finally {
            await h.stop();
        }
    });

    it("the portal's read (2.1b): a valid revision's graph as a Workflow's view draws it, none for one with errors, and personCommands", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        const env = getEnv();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {} });
        await mgmt.start();
        try {
            const id = (await save(host, chat, WITH_INPUTS, null)).receipt.definitionId;
            await save(host, chat, BROKEN(), { definitionId: id, revision: 1 });
            const valid = await mgmt.readChatWorkflowDefinition(chat, { definitionId: id, revision: 1 });
            expect(valid.personCommands).toBe(true);
            expect(valid.revision).toMatchObject({ revision: 1, valid: true });
            expect(valid.graph).toMatchObject({ revision: 1, initial: "hold" });
            expect(valid.graph.states.map(state => state.id).sort()).toEqual(["done", "hold"]);
            expect(valid.graph.inputsSchema).toMatchObject({ type: "object", required: ["topic"], properties: { topic: { type: "string" } } });
            // The newest revision (default) has errors: no graph; its diagnostics say why.
            const broken = await mgmt.readChatWorkflowDefinition(chat, { definitionId: id });
            expect(broken.revision).toMatchObject({ revision: 2, valid: false });
            expect(broken.revision.diagnostics.length).toBeGreaterThan(0);
            expect(broken.graph).toBeNull();
            // The chat's own read (its tool) has no graph: it reads the YAML.
            expect("graph" in await readChatWorkflowDefinition(host, chat, { definitionId: id })).toBe(false);
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    it("R4: a chat with a running Workflow cannot complete; R5 and F2: an ended chat ends its Workflows; a deleted chat deletes them", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        const mgmt = await createManagementClient(getEnv());
        try {
            const id = (await save(host, chat, YAML(30), null)).receipt.definitionId;
            const running = await start(host, chat, id);
            const refusal = await chatCompletionRefusal(host, chat);
            expect(refusal?.code).toBe("WORKFLOW_ACTIVE");
            expect(refusal.message).toMatch(/^This chat cannot complete while its Workflow hn-top-watch is still running\. Stop it first, or cancel the chat, which cancels them\.$/);
            const completing = await refused(mgmt.completeSession(chat, "test", { wait: false }), "WORKFLOW_ACTIVE");
            expect(completing.status).toBe(409);
            // Each terminal state of a chat ends its Workflows' runs (the trigger, in the same transaction).
            for (const state of ["cancelled", "failed", "completed"]) {
                const other = randomUUID();
                await h.catalog.createSession(other, { owner: OWNER });
                const otherId = (await save(host, other, YAML(30), null)).receipt.definitionId;
                const workflow = await start(host, other, otherId);
                await h.q("UPDATE SCHEMA.sessions SET state = $2 WHERE session_id = $1", [other, state]);
                expect((await h.store.readRun(workflow.runId)).status, state).toBe("cancelled");
                expect((await h.catalog.getSession(workflow.workflowId)).state, state).toBe("cancelled");
                // Its definitions are read-only now (Q7).
                await refused(save(host, other, YAML(31), { definitionId: otherId, revision: 1 }), "CHAT_NOT_LIVE");
                await refused(start(host, other, otherId), "CHAT_NOT_LIVE");
            }
            // The first chat is deleted: its definitions and its Workflow are deleted with it.
            await h.catalog.softDeleteSession(chat);
            expect((await h.store.chat.readDefinition(id)).deletedAt).not.toBeNull();
            expect(await h.catalog.getSession(running.workflowId)).toBeNull();
            expect((await h.store.readRun(running.runId)).status).toBe("cancelled");
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    it("E2-4: a person's save leaves one note for the chat, consumed once; the chat's own save leaves none and marks what it has seen", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        try {
            const id = (await save(host, chat, YAML(30), null)).receipt.definitionId;
            expect(await h.store.chat.pendingNotes(chat)).toEqual([]);
            expect(await h.store.chat.seenRevision(chat, id)).toBe(1);
            await save(host, chat, YAML(45), { definitionId: id, revision: 1 }, { by: "person", actor: PERSON, personWords: "Ada Lovelace" });
            const notes = await h.store.chat.pendingNotes(chat);
            expect(notes.map(note => note.text)).toEqual(["Ada Lovelace saved hn-top-watch revision 2."]);
            expect(await h.store.chat.seenRevision(chat, id)).toBe(1, "a person's save is not something the chat has seen");
            await h.store.chat.consumeNotes(chat, notes.map(note => note.noteId));
            await h.store.chat.consumeNotes(chat, notes.map(note => note.noteId));
            expect(await h.store.chat.pendingNotes(chat)).toEqual([]);
            // The chat reads it with its tool: it has seen revision 2.
            const read = JSON.parse(await workflowDefinitionFromTool({ operation: "read", name: "hn-top-watch" },
                { callerSessionId: chat, host, toolCallId: "call-read", owner: null, binding: async () => null }));
            expect(read).toMatchObject({ ok: true, definitionId: id, currentRevision: 2, shown: { revision: 2, savedBy: "Ada Lovelace" } });
            expect(await h.store.chat.seenRevision(chat, id)).toBe(2);
        } finally {
            await h.stop();
        }
    });

    it("the workflow_definition tool: save, a save over a name without its guard told how, start; answers are JSON with codes", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        try {
            const tool = (args, call) => workflowDefinitionFromTool(args, { callerSessionId: chat, host, toolCallId: call, owner: null, binding: async () => null })
                .then(text => JSON.parse(text));
            const saved = await tool({ operation: "save", name: "hn-top-watch", yaml: YAML(30) }, "c1");
            expect(saved).toMatchObject({ ok: true, operation: "save", revision: 1, valid: true });
            const unguarded = await tool({ operation: "save", name: "hn-top-watch", yaml: YAML(31) }, "c2");
            expect(unguarded).toMatchObject({ ok: false, error: { code: "REVISION_REQUIRED" } });
            expect(unguarded.error.message).toContain(`definition_id ${saved.definitionId} and expected_revision 1`);
            const second = await tool({ operation: "save", name: "hn-top-watch", definition_id: saved.definitionId, expected_revision: 1, yaml: YAML(31) }, "c3");
            expect(second).toMatchObject({ ok: true, revision: 2 });
            const started = await tool({ operation: "start", name: "hn-top-watch" }, "c4");
            expect(started).toMatchObject({ ok: true, operation: "start", revision: 2 });
            expect((await tool({ operation: "start", name: "hn-top-watch" }, "c4")).replayed).toBe(true);
            const listed = await tool({ operation: "list" }, "c5");
            expect(listed.definitions).toEqual([expect.objectContaining({ definitionId: saved.definitionId, currentRevision: 2,
                workflows: [expect.objectContaining({ workflowId: started.workflowId, revision: 2 })] })]);
            expect((await tool({ operation: "explode" }, "c6")).error.code).toBe("WORKFLOW_COMMAND_INVALID");
        } finally {
            await h.stop();
        }
    });

    // OF-S2-5: the session list's flag, read in one query on the owner index: a chat with a live definition is an owner; one
    // whose only definition is deleted, and one with none, are not.
    it("OF-S2-5: listWorkflowDefinitionOwnersFor names the chats with a live definition; a deleted one does not count", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        try {
            const deletedOwner = randomUUID();
            const none = randomUUID();
            await h.catalog.createSession(deletedOwner, { owner: OWNER });
            await h.catalog.createSession(none, { owner: OWNER });
            await save(host, chat, YAML(30), null);
            const gone = (await save(host, deletedOwner, YAML(30), null)).receipt.definitionId;
            await deleteChatWorkflowDefinition(host, { ownerSessionId: deletedOwner, definitionId: gone, actor: PERSON, operationId: "delete-owner-flag" });
            const owners = await h.catalog.listWorkflowDefinitionOwnersFor([chat, deletedOwner, none]);
            expect([...owners]).toEqual([chat]);
            expect((await h.catalog.listWorkflowDefinitionOwnersFor([])).size).toBe(0);
        } finally {
            await h.stop();
        }
    });

    it("spawn_workflow (D2): saves to the definition its YAML names, guarded by what the chat has seen (Q2), and starts what it saved (F4)", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        try {
            const spawn = (yaml, extra = {}) => spawnWorkflowCompatFromTool({ yaml, ...extra }, { callerSessionId: chat, operationId: `spawn:${randomUUID()}`,
                owner: async () => null, binding: async () => null, host }).then(text => JSON.parse(text));
            const first = await spawn(YAML(30), { state: "published", start: true });
            expect(first).toMatchObject({ ok: true, operation: "save_and_start", revision: 1 });
            // A changed YAML: the next revision (the chat saw its own revision 1), started.
            const changed = await spawn(YAML(45), { state: "published", start: true });
            expect(changed).toMatchObject({ ok: true, revision: 2 });
            expect((await h.store.readRevision(changed.workflowId, 1)).yaml).toBe(YAML(45));
            // A person saves revision 3; the chat's next spawn_workflow is refused, told to read and redo.
            await save(host, chat, YAML(50), { definitionId: first.definitionId, revision: 2 }, { by: "person", actor: PERSON, personWords: "Ada Lovelace" });
            const stale = await spawn(YAML(60), { state: "published", start: true });
            expect(stale).toMatchObject({ ok: false, error: { code: "REVISION_STALE" } });
            expect(stale.error.message).toMatch(/Read hn-top-watch with workflow_definition \(operation read\), redo your change/);
            // Without start: a save only.
            await workflowDefinitionFromTool({ operation: "read", name: "hn-top-watch" }, { callerSessionId: chat, host, toolCallId: "r", owner: null, binding: async () => null });
            const saved = await spawn(YAML(70));
            expect(saved).toMatchObject({ ok: true, operation: "save", revision: 4 });
            expect((await listChatWorkflowDefinitions(host, chat))[0].workflows.map(item => item.revision)).toEqual([1, 2]);
        } finally {
            await h.stop();
        }
    });
    it("OF-S2-7: a start's agent node models are checked against the revision and the catalog, stored with the run, reused by Run again, and read at spawn", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        const AGENTS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: triage, version: "1.0.0" }
initial: classify
states:
  classify:
    type: agent
    invoke: { prompt: "Classify it." }
    timeoutSeconds: 600
    transition: { next: { done: hold, failure: failed } }
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
        const checked = [];
        const agentsHost = { ...host,
            checkAgentModel: async (choice, owner) => { checked.push([choice.model, owner?.subject ?? null]); return choice.model === "test:gone" ? "it is not in your catalog." : null; } };
        try {
            const saved = (await saveChatWorkflowDefinition(agentsHost, { ownerSessionId: chat, name: "triage", yaml: AGENTS, expected: null,
                actor: { kind: "chat", sessionId: chat }, operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
            expect(saved.valid).toBe(true);
            const startWith = (agentModels, extra = {}) => startChatWorkflowDefinition(agentsHost, { ownerSessionId: chat, definition: { definitionId: saved.definitionId },
                revision: null, runAgainOf: extra.runAgainOf ?? null, inputs: {}, actor: ENGINE, operationId: `start-${randomUUID()}`, owner: OWNER,
                ...(agentModels !== undefined ? { agentModels } : {}) });
            // Refused in words, and nothing is started: an unknown id, a node that is not an agent node, a model the owning chat's catalog does not have.
            expect((await refused(startWith({ summarize: { model: "test:a" } }), "AGENT_MODELS_INVALID")).message)
                .toBe("agentModels names summarize, which is not a node of revision 1 of triage. Use the agent nodes' ids (their keys under states:).");
            expect((await refused(startWith({ hold: { model: "test:a" } }), "AGENT_MODELS_INVALID")).message)
                .toBe("agentModels names hold, a wait node of revision 1 of triage; only agent nodes take a model.");
            expect((await refused(startWith({ classify: { model: "test:gone" } }), "AGENT_MODEL_UNAVAILABLE")).message)
                .toBe("The model chosen for classify, test:gone, cannot be used with the owning chat's catalog: it is not in your catalog. "
                    + "Choose one from list_available_models, or leave the node out so it uses the chat's model.");
            expect((await readChatWorkflowDefinition(agentsHost, chat, { definitionId: saved.definitionId })).workflows).toEqual([]);
            // Started with a choice: checked against the starter (the chat's owner), stored with the run, shown by the read.
            const chosen = { classify: { model: "test:fast", reasoningEffort: "low", contextTier: "long_context" } };
            const started = await startWith(chosen);
            expect(started.agentModels).toEqual(chosen);
            expect(checked.at(-1)).toEqual(["test:fast", OWNER.subject]);
            const live = (await h.store.listRuns(started.workflowId)).find(run => run.mode === "live");
            expect(readWorkflowAgentModels(live.agentModels)).toEqual(chosen);
            const view = await readWorkflowV2(agentsHost, started.workflowId, {}, "tool");
            expect(view.run.agentModels).toEqual(chosen);
            // Run again reuses it; a start without one has none, and its read shows none.
            const again = await startWith(undefined, { runAgainOf: started.workflowId });
            expect(again.agentModels).toEqual(chosen);
            expect(readWorkflowAgentModels((await h.store.listRuns(again.workflowId)).find(run => run.mode === "live").agentModels)).toEqual(chosen);
            // The start receipt the chat reads names each chosen model with its effort and context tier (DEV at ead83d68).
            const told = JSON.parse(await workflowDefinitionFromTool({ operation: "start", definition_id: saved.definitionId,
                agent_models: { classify: { model: "test:fast", reasoning_effort: "low", context_tier: "long_context" } } },
            { callerSessionId: chat, host: agentsHost, toolCallId: `call-${randomUUID()}`, owner: OWNER, binding: async () => null }));
            expect(told.ok, JSON.stringify(told)).toBe(true);
            expect(told.agentModels).toEqual(chosen);
            expect(told.message).toContain("Agent nodes with a model chosen at start: classify: test:fast · low · long context; the others use this chat's model.");
            const plain = await startWith(undefined);
            expect(plain.agentModels).toBeUndefined();
            expect((await h.store.listRuns(plain.workflowId)).find(run => run.mode === "live").agentModels).toBe(null);
            expect(Object.hasOwn((await readWorkflowV2(agentsHost, plain.workflowId, {}, "tool")).run, "agentModels")).toBe(false);
            // At spawn, over the real session rows: a node left out inherits the chat's model, effort AND context tier.
            const parent = randomUUID();
            await h.catalog.createSession(parent, { owner: OWNER, model: "test:chat-model", reasoningEffort: "medium", contextTier: "long_context" });
            const created = [];
            const agents = createWorkflowAgentNodeHost({ getSession: id => h.catalog.getSession(id), resolveAgent: async () => null,
                createChild: async spec => { created.push(spec); } });
            const spawn = agentModel => agents.spawn({ childSessionId: randomUUID(), workflowSessionId: started.workflowId, controllingSessionId: parent,
                runId: live.runId, nodeExecutionId: `nx-${randomUUID()}`, stateId: "classify", task: { source: "prompt", prompt: "Classify it." }, prompt: "{}",
                clientMessageId: `m-${randomUUID()}`, deadlineAt: new Date(Date.now() + 600_000).toISOString(), ...(agentModel ? { agentModel } : {}) });
            await spawn(null);
            await spawn(readWorkflowAgentModels(live.agentModels).classify);
            expect(created.map(spec => [spec.model, spec.reasoningEffort, spec.contextTier]))
                .toEqual([["test:chat-model", "medium", "long_context"], ["test:fast", "low", "long_context"]]);
        } finally {
            await h.stop();
        }
    });
    // The review of ead83d68 (fact pse/wfs/reviews/of-s2-7-ead83d68/rulings): OF7-R1 the owning chat's catalog (the identity
    // that spends), never the caller's; OF7-R2 a person's real-agent test checks before anything is admitted; OF7-R3 the
    // update_workflow start and publish_and_start take the map; OF7-R4 an explicit {} clears Run again's choices through the
    // management API; a host that cannot check refuses a map.
    it("OF-S2-7 review: the owning chat's catalog whoever starts; real-agent tests and legacy starts take the map; {} clears Run again; no checker, no map", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        const env = getEnv();
        const AGENTS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: triage, version: "1.0.0" }
initial: classify
states:
  classify:
    type: agent
    invoke: { prompt: "Classify it." }
    timeoutSeconds: 600
    transition: { next: { done: hold, failure: failed } }
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
        const ADMIN = { provider: "test", subject: "an-admin" };
        const CAROL = { provider: "test", subject: "carol" };
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: { testMode: true } });
        await mgmt.start();
        // The catalog check, recorded: who it is asked for, and test:gone is not in the catalog.
        const checked = [];
        mgmt._checkWorkflowAgentModel = async (choice, owner) => {
            checked.push([choice.model, owner?.subject ?? null]);
            return choice.model === "test:gone" ? "it is not in the catalog." : null;
        };
        // The live run's stored choices, as a spawn reads them (the row keeps the stored text: DEV at fed7e7ac); null for none.
        const liveModels = async workflowId => {
            const read = readStoredAgentModels((await h.store.listRuns(workflowId)).find(run => run.mode === "live")?.agentModels ?? null);
            if ("error" in read) throw new Error(read.error);
            return read.models;
        };
        try {
            const agentsHost = { ...host, checkAgentModel: async () => null };
            const saved = (await saveChatWorkflowDefinition(agentsHost, { ownerSessionId: chat, name: "triage", yaml: AGENTS, expected: null,
                actor: { kind: "chat", sessionId: chat }, operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
            expect(saved.valid, JSON.stringify(saved.diagnostics)).toBe(true);
            const chosen = { classify: { model: "test:fast", reasoningEffort: "low" } };
            const mgmtStart = (request, principal) => mgmt.startChatWorkflowDefinition(chat, { definitionId: saved.definitionId,
                operationId: `start-${randomUUID()}`, ...request }, { principal });

            // OF7-R1: an administrator starts the chat owner's definition: checked against the owner's catalog, not theirs.
            const byAdmin = await mgmtStart({ agentModels: chosen }, ADMIN);
            expect(byAdmin.agentModels).toEqual(chosen);
            expect(checked).toEqual([["test:fast", OWNER.subject]]);
            // Run again by another person: the same choices, checked against the owner's catalog again.
            const again = await mgmtStart({ runAgainOf: byAdmin.workflowId }, CAROL);
            expect(again.agentModels).toEqual(chosen);
            expect(await liveModels(again.workflowId)).toEqual(chosen);
            expect(checked.at(-1)).toEqual(["test:fast", OWNER.subject]);
            // OF7-R4: an explicit {} through the management API clears them: every agent node takes the chat's model.
            const cleared = await mgmtStart({ runAgainOf: byAdmin.workflowId, agentModels: {} }, CAROL);
            expect(cleared.agentModels).toBeUndefined();
            expect(await liveModels(cleared.workflowId)).toBe(null);
            // A model the owner's catalog does not have: refused in words, nothing started.
            const before = (await readChatWorkflowDefinition(agentsHost, chat, { definitionId: saved.definitionId })).workflows.length;
            const gone = await refused(mgmtStart({ agentModels: { classify: { model: "test:gone" } } }, ADMIN), "AGENT_MODEL_UNAVAILABLE");
            expect(gone.message).toMatch(/^The model chosen for classify, test:gone, cannot be used with the owning chat's catalog: it is not in the catalog\./);
            expect((await readChatWorkflowDefinition(agentsHost, chat, { definitionId: saved.definitionId })).workflows.length).toBe(before);

            // A Workflow of the chat's that is not a chat revision's: a person's real-agent test, publish_and_start and start.
            const draft = randomUUID();
            const made = await createWorkflowV2(agentsHost, { workflowSessionId: draft, parentSessionId: chat, yaml: AGENTS, actor: ENGINE,
                operationId: `draft-${randomUUID()}`, publish: false });
            const hash = made.receipt.yamlSha256;
            const command = (sessionId, args) => mgmt.updateWorkflow(sessionId, { operation_id: `cmd-${randomUUID()}`, ...args }, { principal: ADMIN });
            // OF7-R2: refused before anything is admitted.
            const test = await refused(command(draft, { operation: "test", expected_revision: 1, definition_hash: hash, inputs: {}, agent_mode: "real",
                agent_models: { classify: { model: "test:gone" } } }), "AGENT_MODEL_UNAVAILABLE");
            expect(test.message).toMatch(/owning chat's catalog/);
            expect(await h.store.listRuns(draft)).toEqual([]);
            expect(checked.at(-1)).toEqual(["test:gone", OWNER.subject]);
            // OF7-R3: never ignored: a node that is not an agent node, a malformed map; then a valid one is stored with the run.
            await refused(command(draft, { operation: "publish_and_start", expected_revision: 1, definition_hash: hash, inputs: {},
                agent_models: { hold: { model: "test:fast" } } }), "AGENT_MODELS_INVALID");
            await refused(command(draft, { operation: "publish_and_start", expected_revision: 1, definition_hash: hash, inputs: {},
                agent_models: { classify: { model: "test:fast", reasoningEffort: ["low"] } } }), "AGENT_MODELS_INVALID");
            await refused(command(draft, { operation: "publish", expected_revision: 1, definition_hash: hash, agent_models: chosen }), "AGENT_MODELS_INVALID");
            expect(await h.store.listRuns(draft)).toEqual([]);
            await command(draft, { operation: "publish_and_start", expected_revision: 1, definition_hash: hash, inputs: {}, agent_models: chosen });
            expect(await liveModels(draft)).toEqual(chosen);
            const published = randomUUID();
            await createWorkflowV2(agentsHost, { workflowSessionId: published, parentSessionId: chat, yaml: AGENTS, actor: ENGINE,
                operationId: `published-${randomUUID()}`, publish: true });
            await command(published, { operation: "start", definition_hash: hash, inputs: {}, agent_models: { classify: { model: "test:other" } } });
            expect(await liveModels(published)).toEqual({ classify: { model: "test:other" } });
            expect(checked.at(-1)).toEqual(["test:other", OWNER.subject]);

            // Review D4: a repeat of an admitted start answers its receipt even when the owner can no longer use the model.
            const lost = { classify: { model: "test:lost" } };
            const opStart = `start-${randomUUID()}`;
            const once = await mgmt.startChatWorkflowDefinition(chat, { definitionId: saved.definitionId, operationId: opStart, agentModels: lost },
                { principal: ADMIN });
            const pulled = mgmt._checkWorkflowAgentModel;
            mgmt._checkWorkflowAgentModel = async (choice, owner) => (choice.model === "test:lost" ? "it was removed from the catalog." : pulled(choice, owner));
            const twice = await mgmt.startChatWorkflowDefinition(chat, { definitionId: saved.definitionId, operationId: opStart, agentModels: lost },
                { principal: ADMIN });
            expect(twice).toMatchObject({ workflowId: once.workflowId, replayed: true });
            // A new start with it is refused.
            await refused(mgmtStart({ agentModels: lost }, ADMIN), "AGENT_MODEL_UNAVAILABLE");
            // The same for update_workflow start and publish_and_start, and a real-agent test.
            mgmt._checkWorkflowAgentModel = pulled;
            const replayDraft = randomUUID();
            const replayMade = await createWorkflowV2(agentsHost, { workflowSessionId: replayDraft, parentSessionId: chat, yaml: AGENTS, actor: ENGINE,
                operationId: `draft-${randomUUID()}`, publish: false });
            const testArgs = { operation: "test", operation_id: `test-${randomUUID()}`, expected_revision: 1, definition_hash: replayMade.receipt.yamlSha256,
                inputs: {}, agent_mode: "real", agent_models: lost };
            const pasArgs = { operation: "publish_and_start", operation_id: `pas-${randomUUID()}`, expected_revision: 1,
                definition_hash: replayMade.receipt.yamlSha256, inputs: {}, agent_models: lost };
            const lose = () => { mgmt._checkWorkflowAgentModel = async (choice, owner) => (choice.model === "test:lost" ? "it was removed from the catalog." : pulled(choice, owner)); };
            const firstTest = await mgmt.updateWorkflow(replayDraft, testArgs, { principal: ADMIN });
            lose();
            expect(await mgmt.updateWorkflow(replayDraft, testArgs, { principal: ADMIN })).toMatchObject({ replayed: true, run: { runId: firstTest.run.runId } });
            mgmt._checkWorkflowAgentModel = pulled;
            const firstPas = await mgmt.updateWorkflow(replayDraft, pasArgs, { principal: ADMIN });
            const replayPublished = randomUUID();
            await createWorkflowV2(agentsHost, { workflowSessionId: replayPublished, parentSessionId: chat, yaml: AGENTS, actor: ENGINE,
                operationId: `published-${randomUUID()}`, publish: true });
            const startArgs = { operation: "start", operation_id: `ls-${randomUUID()}`, definition_hash: replayMade.receipt.yamlSha256, inputs: {},
                agent_models: lost };
            const firstStart = await mgmt.updateWorkflow(replayPublished, startArgs, { principal: ADMIN });
            lose();
            expect(await mgmt.updateWorkflow(replayDraft, pasArgs, { principal: ADMIN })).toMatchObject({ replayed: true, run: { runId: firstPas.run.runId } });
            expect(await mgmt.updateWorkflow(replayPublished, startArgs, { principal: ADMIN })).toMatchObject({ replayed: true, run: { runId: firstStart.run.runId } });
            // A new one is refused.
            await refused(mgmt.updateWorkflow(replayPublished, { ...startArgs, operation_id: `ls-${randomUUID()}` }, { principal: ADMIN }), "AGENT_MODEL_UNAVAILABLE");
            mgmt._checkWorkflowAgentModel = pulled;

            // Review D8: Run again of a Workflow whose stored map cannot be read is refused in words; it never drops the map.
            const damaged = await mgmtStart({ agentModels: chosen }, ADMIN);
            await h.store.pool.query(`UPDATE ${h.store.t.runs} SET agent_models = $1 WHERE workflow_session_id = $2`, ['{"classify":', damaged.workflowId]);
            const unreadable = await refused(mgmtStart({ runAgainOf: damaged.workflowId }, CAROL), "AGENT_MODELS_INVALID");
            expect(unreadable.message).toMatch(/^The agent models stored with this run cannot be read \(AGENT_MODELS_INVALID\): .+ Give agentModels \(an empty map: the chat's models\) to run it again\.$/);
            // An explicit map (here: none) runs it again.
            expect((await mgmtStart({ runAgainOf: damaged.workflowId, agentModels: {} }, CAROL)).agentModels).toBeUndefined();

            // Fail closed: a host that cannot check models refuses any map (and starts as before without one).
            const unchecked = { ...host };
            const closed = await refused(startChatWorkflowDefinition(unchecked, { ownerSessionId: chat, definition: { definitionId: saved.definitionId },
                revision: null, inputs: {}, actor: ENGINE, operationId: `start-${randomUUID()}`, agentModels: chosen }), "AGENT_MODEL_UNAVAILABLE");
            expect(closed.message).toMatch(/^This host cannot check models against the owning chat's catalog/);
            expect((await startChatWorkflowDefinition(unchecked, { ownerSessionId: chat, definition: { definitionId: saved.definitionId },
                revision: null, inputs: {}, actor: ENGINE, operationId: `start-${randomUUID()}` })).agentModels).toBeUndefined();
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
    // Owner 2026-11-09T05:38Z: an agent state that sets no session continues its agent session by default; 07:03Z, (a): a revision
    // saved before that, without the key, starts with continue (a Start compiles its YAML again), and the definition's graph
    // says so; a re-save compiles to continue. 06:30Z: a revision saved with the old key `chat` no longer starts; it says why.
    it("continue default: a revision saved before without session starts continued, and its graph says so; one saved with chat: is refused in words", { timeout: TIMEOUT }, async () => {
        const { h, host, chat } = await harness();
        const AGENTS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: triage, version: "1.0.0" }
initial: classify
states:
  classify:
    type: agent
    invoke: { prompt: "Classify it." }
    timeoutSeconds: 600
    transition: { next: { again: hold, done: done, failure: failed } }
  hold: { type: wait, seconds: 30, transition: { next: { elapsed: classify } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
        const agentsHost = { ...host };
        const FLAGS = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true, enableClockWaits: true };
        const modeOf = graph => graph.states.find(state => state.id === "classify").chat ?? "new";
        const workflowMode = async workflowId => modeOf((await readWorkflowV2(agentsHost, workflowId, {}, "tool")).graph);
        /** `yaml` as a build before the default changed stored it: its IR with no session mode (a new session each visit). */
        const storedBefore = (yaml, compiledFrom = yaml) => {
            const fresh = compileWorkflowV2(compiledFrom, FLAGS);
            const ir = JSON.parse(JSON.stringify(fresh.ir));
            delete ir.nodes.classify.chat;
            return { ...fresh, ir, irSha256: sha256Hex(canonicalJson(ir)), yamlSha256: sha256Hex(yaml) };
        };
        try {
            const before = storedBefore(AGENTS);
            const old = (await saveChatWorkflowDefinition(agentsHost, { ownerSessionId: chat, name: "triage", yaml: AGENTS, expected: null, compiled: before,
                actor: { kind: "chat", sessionId: chat }, operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
            expect(old).toMatchObject({ revision: 1, valid: true, irSha256: before.irSha256 });
            // Its graph is compiled as a Start compiles it: the agent session continues (its Agent session line says so).
            expect(modeOf((await readChatWorkflowDefinition(agentsHost, chat, { definitionId: old.definitionId, revision: 1 }, { graph: true })).graph))
                .toBe("continue");
            // A Start, and a Run again, of that revision continue one agent session across the step's visits.
            const first = await start(agentsHost, chat, old.definitionId, { revision: 1 });
            expect(await workflowMode(first.workflowId)).toBe("continue");
            expect(await workflowMode((await start(agentsHost, chat, old.definitionId, { runAgainOf: first.workflowId })).workflowId)).toBe("continue");
            // The same YAML saved again (revision 2) compiles to continue.
            const resaved = (await save(agentsHost, chat, AGENTS, { definitionId: old.definitionId, revision: 1 }, { name: "triage" })).receipt;
            expect(resaved).toMatchObject({ revision: 2, valid: true });
            expect(resaved.irSha256).toBe(compileWorkflowV2(AGENTS, FLAGS).irSha256);
            expect(resaved.irSha256).not.toBe(before.irSha256);
            // A revision a build before the rename stored with `chat: new` does not start now: its words say what to write.
            const OLD_KEY = AGENTS.replace("    timeoutSeconds: 600", "    chat: new\n    timeoutSeconds: 600");
            const keyed = (await saveChatWorkflowDefinition(agentsHost, { ownerSessionId: chat, name: "triage", yaml: OLD_KEY,
                expected: { definitionId: old.definitionId, revision: 2 }, compiled: storedBefore(OLD_KEY, AGENTS),
                actor: { kind: "chat", sessionId: chat }, operationId: `save-${randomUUID()}`, by: "chat" })).receipt;
            expect(keyed).toMatchObject({ revision: 3, valid: true });
            const refusal = await start(agentsHost, chat, old.definitionId, { revision: 3 }).then(() => null, error => error);
            expect(refusal?.message).toContain("`chat` is now `session`: write `session: continue` or `session: new`.");
            // Its graph is the stored one (its YAML no longer compiles).
            expect(modeOf((await readChatWorkflowDefinition(agentsHost, chat, { definitionId: old.definitionId, revision: 3 }, { graph: true })).graph)).toBe("new");
            // Review PRA-F1: a test of that revision is refused in the same words, before a bench is made; a test of revision 1
            // (saved before the default changed) runs its YAML as this build compiles it, continued.
            const testOf = (revision, operationId) => startChatWorkflowTest(agentsHost, { ownerSessionId: chat, definition: { definitionId: old.definitionId },
                revision, inputs: {}, fixtures: [], operationId, actor: ENGINE, owner: async () => OWNER, binding: async () => null });
            const testRefusal = await testOf(3, "test-3").then(() => null, error => error);
            expect(testRefusal).toMatchObject({ code: "DEFINITION_INVALID",
                message: expect.stringContaining("`chat` is now `session`: write `session: continue` or `session: new`.") });
            expect(testRefusal.message).toContain("Nothing was tested.");
            const tested = await testOf(1, "test-1");
            expect(tested).toMatchObject({ definitionId: old.definitionId, revision: 1, runId: expect.any(String) });
            expect(await workflowMode(tested.testId)).toBe("continue");
        } finally {
            await h.stop();
        }
    });
});
