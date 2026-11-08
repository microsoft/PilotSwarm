/**
 * Stage 2.1's real-model scenario (spec "Order of work": "edit, save, start, run again"), on a REAL model with Workflows on:
 * 1. the chat is asked to save a Workflow Definition and not start it: it saves (workflow_definition, or the spawn_workflow
 *    compat without start); the chat owns one definition of that name; no Workflow is created;
 * 2. a person edits it (the YAML tab's Save, through the management client): a new revision based on the chat's, and one
 *    note for the chat's next turn (that a save starts no turn is workflow-chat-notes-turn.test.js);
 * 3. the chat is asked to change it and start one Workflow: its save is based on the person's revision (a stale save is
 *    refused and writes nothing, so the model must read and redo); it starts the revision it saved; that Workflow runs to
 *    the end;
 * 4. the person runs that Workflow again (Run again): a second Workflow of the same revision, which also runs to the end.
 *
 * PASS: the definition, revisions, authors, bases and Workflows as above; the person's note consumed; no "No response was
 * returned"; the chat idle at the end. The model's answers and tool calls are recorded, not judged.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_V2_REAL_MODEL=run with PS_WORKFLOW_V2_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_V2_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-v2-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_V2_REAL_MODEL_RECEIPT when set; a summary is printed. Two asked turns, plus
 * the turns the Workflows' ending notices start.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-chat-definitions-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-v2-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "workflow-chat-definitions-real-model" };
const PERSON = { provider: "test", subject: "ada", displayName: "Ada Lovelace" };
const NAME = "five-second-check";
const TURN_MS = 240_000;
const RUN_MS = 120_000;
const TEST_TIMEOUT = 15 * 60_000;
const ACTIVE = new Set(["admitted", "running", "paused"]);

const ASK_SAVE = `Save a Workflow Definition named ${NAME} that waits 5 seconds and then ends successfully. Save it only; do not start it. `
    + "Then tell me in one line what you saved.";
const ASK_CHANGE_AND_START = `Change ${NAME} so that it waits 3 seconds instead, save that change, and then start one Workflow of it. `
    + "Then tell me in one line which revision you started.";
const PERSON_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${NAME}, version: "1.0.1" }
initial: hold
states:
  hold: { type: wait, seconds: 2, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

async function until(read, label, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "a real model saves, a person edits, the model changes and starts, the person runs it again";

describe("Workflow Definitions with revisions (stage 2.1), on a real model", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflow-chat-definitions-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, steps: {}, verdict: null };
        const env = createTestEnv("workflow-chat-definitions-real-model");
        let mgmt = null;
        try {
            const worker = { testOptions: { workflowRequests: true }, workflowScripts: { enabled: true }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema, workflowCommands: { requests: true } });
                await mgmt.start();
                const catalog = client._catalog;
                const chatStore = catalog.workflowStore().chat;
                const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                const events = types => catalog.getSessionEvents(chat.sessionId, 0, 5_000, types);
                const toolCalls = async () => (await events(["tool.execution_start"])).map(event => String(event.data?.toolName ?? event.data?.name ?? ""));
                const workflowChildren = async () => (await catalog.pool.query(
                    `SELECT session_id FROM "${env.cmsSchema}".sessions WHERE parent_session_id = $1 AND session_kind = 'workflow' AND deleted_at IS NULL`,
                    [chat.sessionId])).rows.map(row => row.session_id);
                const definition = async () => chatStore.readDefinitionByName(chat.sessionId, NAME);
                const revisions = async id => (await mgmt.readChatWorkflowDefinition(chat.sessionId, { definitionId: id })).revisions;
                const ended = async workflowId => until(async () => {
                    const row = (await chatStore.listWorkflows({ ownerSessionId: chat.sessionId })).find(item => item.workflowSessionId === workflowId);
                    return row && row.runStatus && !ACTIVE.has(row.runStatus) ? row : null;
                }, `Workflow ${workflowId} ends`, RUN_MS);
                const idle = async label => until(async () => (await catalog.getSession(chat.sessionId))?.state === "idle", label, TURN_MS);

                // 1. Save only.
                await chat.sendAndWait(ASK_SAVE, TURN_MS);
                const saved = await definition();
                const afterSave = { toolCalls: await toolCalls(), definition: saved, workflows: await workflowChildren() };
                receipt.steps.save = { toolCalls: afterSave.toolCalls, revision: saved?.currentRevision ?? null, workflows: afterSave.workflows.length };
                expect(saved, JSON.stringify(receipt)).toBeTruthy();
                expect(afterSave.workflows, JSON.stringify(receipt)).toEqual([]);
                const firstRevisions = await revisions(saved.definitionId);
                expect(firstRevisions.every(item => item.actor.kind === "chat"), JSON.stringify(firstRevisions)).toBe(true);
                expect(firstRevisions.some(item => item.valid), JSON.stringify(firstRevisions)).toBe(true);

                // 2. A person edits it: a new revision on the chat's, and one note for the chat's next turn.
                const personSave = await mgmt.saveChatWorkflowDefinition(chat.sessionId, { name: NAME, yaml: PERSON_YAML, definitionId: saved.definitionId,
                    expectedRevision: saved.currentRevision, operationId: `person-save-${randomUUID()}` }, { principal: PERSON });
                receipt.steps.personSave = { revision: personSave.revision, basedOn: personSave.basedOn };
                expect(personSave.revision).toBe(saved.currentRevision + 1);
                expect(personSave.basedOn).toBe(saved.currentRevision);
                expect((await chatStore.pendingNotes(chat.sessionId)).map(note => note.text))
                    .toEqual([`Ada Lovelace saved ${NAME} revision ${personSave.revision}.`]);

                // 3. The chat changes it (based on the person's revision) and starts the revision it saved.
                await chat.sendAndWait(ASK_CHANGE_AND_START, TURN_MS);
                expect(await chatStore.pendingNotes(chat.sessionId)).toEqual([]);
                const afterChange = await revisions(saved.definitionId);
                const chatsNew = afterChange.filter(item => item.revision > personSave.revision);
                const started = (await chatStore.listWorkflows({ definitionId: saved.definitionId }));
                receipt.steps.change = { toolCalls: (await toolCalls()).slice(afterSave.toolCalls.length),
                    revisions: chatsNew.map(item => ({ revision: item.revision, basedOn: item.basedOn, valid: item.valid, by: item.actor.kind })),
                    workflows: started.map(item => ({ revision: item.revision, status: item.runStatus })) };
                expect(chatsNew.length, JSON.stringify(receipt)).toBeGreaterThan(0);
                expect(chatsNew.every(item => item.actor.kind === "chat" && item.basedOn !== null && item.basedOn >= personSave.revision),
                    JSON.stringify(receipt)).toBe(true);
                expect(started.length, JSON.stringify(receipt)).toBe(1);
                const first = started[0];
                expect(chatsNew.some(item => item.revision === first.revision && item.valid), JSON.stringify(receipt)).toBe(true);
                const shown = await mgmt.readChatWorkflowDefinition(chat.sessionId, { definitionId: saved.definitionId, revision: first.revision });
                receipt.steps.change.startedYamlWaits = /seconds:\s*3\b/.test(String(shown.revision?.yaml ?? "")) ? 3 : "other";
                // Stage 2.1b: the portal's read of that revision draws its graph, and says people may change it.
                receipt.steps.change.graph = Array.isArray(shown.graph?.states) ? shown.graph.states.map(state => state.id) : null;
                expect(shown.personCommands).toBe(true);
                expect(receipt.steps.change.graph?.length ?? 0, JSON.stringify(receipt)).toBeGreaterThan(0);
                const firstEnd = await ended(first.workflowSessionId);
                receipt.steps.change.ended = firstEnd.runStatus;
                expect(firstEnd.runStatus).toBe("completed");

                // 4. Run again: the same revision, a second Workflow.
                const again = await mgmt.startChatWorkflowDefinition(chat.sessionId, { definitionId: saved.definitionId, runAgainOf: first.workflowSessionId,
                    operationId: `person-run-again-${randomUUID()}` }, { principal: PERSON });
                receipt.steps.runAgain = { revision: again.revision };
                expect(again.revision).toBe(first.revision);
                expect(again.workflowId).not.toBe(first.workflowSessionId);
                const secondEnd = await ended(again.workflowId);
                receipt.steps.runAgain.ended = secondEnd.runStatus;
                expect(secondEnd.runStatus).toBe("completed");
                expect((await workflowChildren()).sort()).toEqual([first.workflowSessionId, again.workflowId].sort());

                // The chat settles: the ending notices' turns end without a failed turn.
                await idle("the chat is idle after the Workflows end");
                const errors = (await events(["session.error"])).map(event => String(event.data?.message ?? ""));
                const answers = (await events(["assistant.message"])).map(event => event.data?.content).filter(value => typeof value === "string" && value);
                receipt.errors = errors;
                receipt.answers = answers.map(value => value.slice(0, 300));
                receipt.userMessages = (await events(["user.message"])).length;
                receipt.state = (await catalog.getSession(chat.sessionId))?.state ?? null;
                expect(errors.filter(value => /No response was returned/.test(value)), JSON.stringify(receipt)).toEqual([]);
                expect(receipt.state).toBe("idle");
                receipt.verdict = "PASS";
            });
        } catch (error) {
            receipt.verdict = `FAIL: ${String(error?.message ?? error).slice(0, 500)}`;
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[workflow-chat-definitions-real-model] ${JSON.stringify(receipt)}`);
            const path = process.env.PS_WORKFLOW_V2_REAL_MODEL_RECEIPT;
            if (path) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
            }
            await mgmt?.stop().catch(() => {});
            await env.cleanup();
        }
    });
});
