/**
 * Workflow Simplified stage 2.1, on PostgreSQL: a definition belongs to the session (migration 0107; session-definition-store.ts,
 * session-definitions.ts, definition-tool.ts). The rules of the spec and the coordinator's readings Q1–Q10 and F2–F4, each
 * against the real store:
 * - save: revisions 1, 2, 3 with their author and base; a stale save is refused with who saved it and when (E2-3); the
 *   guard names the definition, so a deleted and re-created name does not let a stale save through (Q1); a revision with
 *   errors is saved and cannot start (E2-5); a second first save of a name is refused; two saves at the same moment: one;
 *   a repeated operation answers its receipt; saves only on a live session (Q7);
 * - start: the newest valid revision by default, or a named one, or Run again's (Q10); the Workflow's own definition is
 *   that revision's YAML and stays so after later saves (R1);
 * - R6: a definition with a running Workflow cannot be deleted; a finished Workflow keeps its copy;
 * - R4 (owner 2026-11-11T05:25Z: completing a parent completes its children, active or not): completing a session with a
 *   running Workflow is not refused: the management client's completeSession sends the session its done (which its
 *   orchestration cascades to the Workflow; the cascade's own tests are the owner-cascade suites);
 * - R5, F2: a session that is canceled, fails or completes ends its Workflows' runs; a deleted session's definitions and
 *   Workflows are deleted;
 * - E2-4: a person's save leaves one note for the session; the session's own does not;
 * - spawn_workflow (D2, Q2, F4): saves to the definition the YAML names, guarded by the newest revision the session has seen,
 *   and starts exactly the revision it saved.
 * - stage 2.1b, the portal's read (the management client's): a valid revision's graph, drawn as a Workflow's view draws
 *   it, none for one with errors, and whether the deployment takes a person's save, start and delete; the session's own read
 *   has no graph.
 * No model, no controller: a started run stays admitted (a recording duroxide client stands in for the dispatch).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient, createManagementClient } from "../helpers/local-workers.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { recordSessionRanATurn } from "../helpers/session-first-turn.mjs";
import { controlWorkflowRun, createWorkflow } from "../../src/workflow/service.ts";
import {
    deleteSessionWorkflowDefinition, listSessionWorkflowDefinitions, readSessionWorkflowDefinition, saveSessionWorkflowDefinition,
    startSessionWorkflowDefinition,
} from "../../src/workflow/session-definitions.ts";
import { spawnWorkflowCompatFromTool, workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import { readStoredAgentModels, readWorkflowAgentModels } from "../../src/workflow/agent-models.ts";
import { createWorkflowAgentNodeHost } from "../../src/workflow/agent-host.ts";
import { readWorkflowModel, readWorkflowView } from "../../src/workflow/tools.ts";
import { startSessionWorkflowTest } from "../../src/workflow/definition-test.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "session-definitions" };
const PERSON = { kind: "user", provider: "test", subject: "ada", display: "Ada Lovelace" };
const ENGINE = { kind: "system", name: "session-definitions-test" };

const YAML = (seconds, name = "hn-top-watch", version = "1.0.0") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "${version}" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
const WITH_INPUTS = `
apiVersion: pilotswarm.dev/v1
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
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: nowhere
states:
  done: { type: terminal, outcome: succeeded }
`;

/** A stand-in session orchestration for R4: it returns the first message it is sent. */
const SESSION_STAND_IN = "r4-session-stand-in";

async function until(check, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
}

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
    const session = randomUUID();
    await h.catalog.createSession(session, { owner: OWNER });
    return { h, host, session, dispatched };
}

const save = (host, session, yaml, expected, extra = {}) => saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: extra.name ?? "hn-top-watch", yaml,
    expected, actor: extra.actor ?? { kind: "session", sessionId: session }, operationId: extra.operationId ?? `save-${randomUUID()}`, by: extra.by ?? "session",
    ...(extra.personWords ? { personWords: extra.personWords } : {}) });
const start = (host, session, definitionId, extra = {}) => startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId },
    revision: extra.revision ?? null, runAgainOf: extra.runAgainOf ?? null, inputs: {}, actor: ENGINE, operationId: extra.operationId ?? `start-${randomUUID()}` });

describe("a definition belongs to the session (stage 2.1)", () => {
    it("numbers only started Workflows in definition order and in the Workflow overview", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const yaml = YAML(30);
            const { definitionId } = (await save(host, session, yaml, null)).receipt;
            const draftId = randomUUID();
            await h.catalog.createWorkflowSession(draftId, { parentSessionId: session, owner: OWNER, creationConfig: { workflow: {} } });
            await h.store.createDefinition({ workflowSessionId: draftId, parentSessionId: session, notifyParent: false, yaml, compiled: compileWorkflow(yaml),
                actor: ENGINE, operationId: "draft", requestSha256: "draft", publish: false, start: null,
                sessionPin: { ownerSessionId: session, definitionId, revision: 1 } });
            const first = await start(host, session, definitionId);
            const second = await start(host, session, definitionId);
            const [view] = await listSessionWorkflowDefinitions(host, session);
            expect(view.workflows).toMatchObject([
                { workflowSessionId: draftId, number: null }, { workflowSessionId: first.workflowId, number: 1 },
                { workflowSessionId: second.workflowId, number: 2 },
            ]);
            expect((await readWorkflowView(h.store, second.workflowId)).number).toBe(2);
            expect((await readWorkflowView(h.store, draftId)).number).toBeNull();
        } finally {
            await h.stop();
        }
    });

    it("shows revision summaries, started Workflows and requested deleted definitions to the agent", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const { definitionId } = (await save(host, session, YAML(30), null, { actor: PERSON, by: "person" })).receipt;
            const workflow = await start(host, session, definitionId);
            const test = await startSessionWorkflowTest(host, { ownerSessionId: session, definition: { definitionId },
                revision: 1, inputs: {}, fixtures: [], operationId: "test-parity", actor: ENGINE, owner: async () => OWNER, binding: async () => null });
            await save(host, session, BROKEN(), { definitionId, revision: 1 });
            const gone = (await save(host, session, YAML(30, "gone"), null, { name: "gone" })).receipt;
            const call = async args => JSON.parse(await workflowDefinitionFromTool(args,
                { callerSessionId: session, host, toolCallId: randomUUID(), owner: OWNER, binding: async () => null }));
            expect(await call({ operation: "delete", definition_id: gone.definitionId })).toMatchObject({ ok: true });
            const list = await call({ operation: "list", include_deleted: true });
            const read = await call({ operation: "read", definition_id: definitionId });
            const listed = list.definitions.find(item => item.definitionId === definitionId);
            expect(list.definitions.find(item => item.definitionId === gone.definitionId)).toMatchObject({ deletedAt: expect.any(String) });
            for (const view of [listed, read]) {
                expect(view.revisions).toMatchObject([
                    { revision: 1, valid: true, errorCount: 0, savedBy: "Ada Lovelace",
                        lastTest: { testId: test.testId, verdict: "running", at: expect.any(String) } },
                    { revision: 2, valid: false, errorCount: 1 },
                ]);
                expect(view.workflows).toMatchObject([{ workflowId: workflow.workflowId, workflowSessionId: workflow.workflowId,
                    revision: 1, status: "admitted", runStatus: "admitted", createdAt: expect.any(String), number: 1 }]);
                expect(view.revisions[0]).not.toHaveProperty("actor");
            }
            expect(listed.revisions[0]).not.toHaveProperty("yaml");
            expect(read.shown.yaml).toContain("initial: nowhere");
        } finally {
            await h.stop();
        }
    });

    it("revisions with author and base; a stale save refused with who and when; errors saved; start pins a revision (R1, E2-3, E2-5, Q10)", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const first = (await save(host, session, YAML(30), null)).receipt;
            expect(first).toMatchObject({ name: "hn-top-watch", revision: 1, basedOn: null, created: true, valid: true, semver: "1.0.0" });
            const id = first.definitionId;
            // The person saves revision 2 on revision 1; the session's save based on revision 1 is now stale.
            const second = (await save(host, session, YAML(45), { definitionId: id, revision: 1 }, { by: "person", actor: PERSON, personWords: "Ada Lovelace" })).receipt;
            expect(second).toMatchObject({ revision: 2, basedOn: 1, created: false });
            const stale = await refused(save(host, session, YAML(60), { definitionId: id, revision: 1 }), "REVISION_STALE");
            expect(stale.message).toMatch(/^Revision 2 was saved by Ada Lovelace at .+\. Reload to edit it\. Nothing was saved\.$/);
            expect(stale.details).toMatchObject({ definitionId: id, currentRevision: 2, expectedRevision: 1 });
            // A revision with errors is saved, and cannot start.
            const broken = (await save(host, session, BROKEN(), { definitionId: id, revision: 2 })).receipt;
            expect(broken).toMatchObject({ revision: 3, valid: false });
            expect(broken.diagnostics.length).toBeGreaterThan(0);
            await refused(start(host, session, id, { revision: 3 }), "DEFINITION_INVALID");
            // Start without a revision: the newest valid (2). Its Workflow's own definition is revision 2's YAML.
            const started = await start(host, session, id);
            expect(started).toMatchObject({ revision: 2, replayed: false });
            const own = await h.store.readDefinition(started.workflowId);
            expect(own).toMatchObject({ state: "published", parentSessionId: session });
            expect((await h.store.readRevision(started.workflowId, 1)).yaml).toBe(YAML(45));
            const readStarted = () => readWorkflowModel(host, started.workflowId, {}, "tool");
            const startedView = await readStarted();
            expect(startedView.definition).toMatchObject({
                currentRevision: 1, publishedRevision: 1,
                source: { ownerSessionId: session, definitionId: id, revision: 2 },
            });
            expect(startedView.runs).toEqual(expect.arrayContaining([expect.objectContaining({ mode: "live", revision: 1 })]));
            // A later save never changes it (R1).
            await save(host, session, YAML(90), { definitionId: id, revision: 3 });
            expect((await h.store.readRevision(started.workflowId, 1)).yaml).toBe(YAML(45));
            expect((await readStarted()).definition.source).toEqual(startedView.definition.source);
            // An explicit revision; Run again pins the same revision as the Workflow it repeats.
            expect((await start(host, session, id, { revision: 1 })).revision).toBe(1);
            expect((await start(host, session, id, { runAgainOf: started.workflowId })).revision).toBe(2);
            // The same operation again: its receipt, no second Workflow.
            const op = `start-${randomUUID()}`;
            const once = await start(host, session, id, { operationId: op });
            const twice = await start(host, session, id, { operationId: op });
            expect(twice).toMatchObject({ workflowId: once.workflowId, replayed: true });
            const view = await readSessionWorkflowDefinition(host, session, { definitionId: id });
            expect(view.revisions.map(item => [item.revision, item.valid, item.basedOn, item.actor.kind])).toEqual([
                [1, true, null, "session"], [2, true, 1, "user"], [3, false, 2, "session"], [4, true, 3, "session"]]);
            expect(view.workflows.map(item => item.revision)).toEqual([2, 1, 2, 4]);
            expect(view.newestValidRevision).toBe(4);
        } finally {
            await h.stop();
        }
    });

    it("a second first save of a name is refused; the YAML's name must be the definition's; two saves at once: exactly one", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const first = (await save(host, session, YAML(30), null)).receipt;
            const again = await refused(save(host, session, YAML(31), null), "DEFINITION_EXISTS");
            expect(again.details).toMatchObject({ definitionId: first.definitionId, currentRevision: 1 });
            await refused(save(host, session, YAML(30, "other-name"), { definitionId: first.definitionId, revision: 1 }), "WORKFLOW_NAME_MISMATCH");
            for (let round = 0; round < 5; round += 1) {
                const current = (await h.store.sessionDefinitions.readDefinition(first.definitionId)).currentRevision;
                const results = await Promise.allSettled([40, 50].map(seconds => save(host, session, YAML(seconds + round), { definitionId: first.definitionId, revision: current })));
                expect(results.map(result => result.status).sort(), JSON.stringify(results.map(result => result.reason?.message ?? null))).toEqual(["fulfilled", "rejected"]);
                expect(results.find(result => result.status === "rejected").reason.code).toBe("REVISION_STALE");
            }
            // Two first saves of a new name at once: one definition.
            const named = await Promise.allSettled([1, 2].map(n => save(host, session, YAML(n, "twin"), null, { name: "twin" })));
            expect(named.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
            expect(named.find(result => result.status === "rejected").reason.code).toBe("DEFINITION_EXISTS");
            expect((await listSessionWorkflowDefinitions(host, session)).map(view => view.name).sort()).toEqual(["hn-top-watch", "twin"]);
        } finally {
            await h.stop();
        }
    });

    it("delete: refused while a Workflow runs (R6); a deleted and re-created name refuses a stale save (Q1); the old copy stays", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const id = (await save(host, session, YAML(30), null)).receipt.definitionId;
            const started = await start(host, session, id);
            const deleting = { ownerSessionId: session, definitionId: id, actor: PERSON };
            const inUse = await refused(deleteSessionWorkflowDefinition(host, { ...deleting, operationId: "delete-1" }), "DEFINITION_IN_USE");
            expect(inUse.details.workflowSessionIds).toEqual([started.workflowId]);
            await controlWorkflowRun(host, started.workflowId, { operation: "cancel", runId: null, reason: "test" }, { actor: ENGINE, operationId: "cancel-1" });
            expect((await deleteSessionWorkflowDefinition(host, { ...deleting, operationId: "delete-2" })).receipt).toMatchObject({ definitionId: id, name: "hn-top-watch" });
            // Its Workflow keeps its copy; a save or a start of the deleted definition is refused.
            expect((await h.store.readRevision(started.workflowId, 1)).yaml).toBe(YAML(30));
            await refused(save(host, session, YAML(31), { definitionId: id, revision: 1 }), "DEFINITION_DELETED");
            await refused(start(host, session, id), "DEFINITION_DELETED");
            // The name is re-created: revision 1 of a new definition. A save still based on the old one's revision 1 is refused.
            const again = (await save(host, session, YAML(32), null)).receipt;
            expect(again).toMatchObject({ revision: 1, created: true });
            expect(again.definitionId).not.toBe(id);
            await refused(save(host, session, YAML(33), { definitionId: id, revision: 1 }), "DEFINITION_DELETED");
            expect((await h.store.sessionDefinitions.readDefinition(again.definitionId)).currentRevision).toBe(1);
        } finally {
            await h.stop();
        }
    });

    it("the portal's read (2.1b): a valid revision's graph as a Workflow's view draws it, none for one with errors, and personCommands", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        const env = getEnv();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {} });
        await mgmt.start();
        try {
            const id = (await save(host, session, WITH_INPUTS, null)).receipt.definitionId;
            await save(host, session, BROKEN(), { definitionId: id, revision: 1 });
            const valid = await mgmt.readSessionWorkflowDefinition(session, { definitionId: id, revision: 1 });
            expect(valid.personCommands).toBe(true);
            expect(valid.revision).toMatchObject({ revision: 1, valid: true });
            expect(valid.graph).toMatchObject({ revision: 1, initial: "hold" });
            expect(valid.graph.states.map(state => state.id).sort()).toEqual(["done", "hold"]);
            expect(valid.graph.inputsSchema).toMatchObject({ type: "object", required: ["topic"], properties: { topic: { type: "string" } } });
            // The newest revision (default) has errors: no graph; its diagnostics say why.
            const broken = await mgmt.readSessionWorkflowDefinition(session, { definitionId: id });
            expect(broken.revision).toMatchObject({ revision: 2, valid: false });
            expect(broken.revision.diagnostics.length).toBeGreaterThan(0);
            expect(broken.graph).toBeNull();
            // The session's own read (its tool) has no graph: it reads the YAML.
            expect("graph" in await readSessionWorkflowDefinition(host, session, { definitionId: id })).toBe(false);
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    it("R4: completing a session with a running Workflow is not refused, its done is sent; R5 and F2: an ended session ends its Workflows; a deleted session deletes them", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        const mgmt = await createManagementClient(getEnv());
        // The session's orchestration, as the management client reads it: running, recording the commands it is sent.
        const provider = await PostgresProvider.connectWithSchema(getEnv().store, getEnv().duroxideSchema);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        runtime.registerOrchestration(SESSION_STAND_IN, function* (ctx) {
            const received = yield ctx.dequeueEvent("messages");
            return received;
        });
        await runtime.start();
        const duroxide = new Client(provider);
        try {
            const id = (await save(host, session, YAML(30), null)).receipt.definitionId;
            const running = await start(host, session, id);
            await duroxide.startOrchestration(`session-${session}`, SESSION_STAND_IN, "{}");
            await until(async () => (await duroxide.getStatus(`session-${session}`)).status === "Running", "the session's orchestration to run");
            // Not refused (no WORKFLOW_ACTIVE): the done reaches the session's orchestration, which is what ends its Workflow.
            await mgmt.completeSession(session, "test", { wait: false });
            const ended = await duroxide.waitForOrchestration(`session-${session}`, 30_000);
            expect(ended.status, JSON.stringify(ended)).toBe("Completed");
            const output = typeof ended.output === "string" ? JSON.parse(ended.output) : ended.output;
            expect(typeof output === "string" ? JSON.parse(output) : output).toMatchObject({ type: "cmd", cmd: "done", args: { reason: "test" } });
            expect((await h.catalog.getSessionEvents(session, 0, 50, ["session.end_requested"])).length).toBe(1);
            // Nothing in the store refused or ended it on the way: the run waits for the session's own cascade.
            expect((await h.store.readRun(running.runId)).status).toBe("admitted");
            // Each terminal state of a session ends its Workflows' runs (the trigger, in the same transaction).
            for (const state of ["cancelled", "failed", "completed"]) {
                const other = randomUUID();
                await h.catalog.createSession(other, { owner: OWNER });
                const otherId = (await save(host, other, YAML(30), null)).receipt.definitionId;
                const workflow = await start(host, other, otherId);
                await h.q("UPDATE SCHEMA.sessions SET state = $2 WHERE session_id = $1", [other, state]);
                expect((await h.store.readRun(workflow.runId)).status, state).toBe("cancelled");
                expect((await h.catalog.getSession(workflow.workflowId)).state, state).toBe("cancelled");
                // Its definitions are read-only now (Q7).
                await refused(save(host, other, YAML(31), { definitionId: otherId, revision: 1 }), "SESSION_NOT_LIVE");
                await refused(start(host, other, otherId), "SESSION_NOT_LIVE");
            }
            // The first session is deleted: its definitions and its Workflow are deleted with it.
            await h.catalog.softDeleteSession(session);
            expect((await h.store.sessionDefinitions.readDefinition(id)).deletedAt).not.toBeNull();
            expect(await h.catalog.getSession(running.workflowId)).toBeNull();
            expect((await h.store.readRun(running.runId)).status).toBe("cancelled");
        } finally {
            await runtime.shutdown(100);
            await mgmt.stop();
            await h.stop();
        }
    });

    it("literal definition, state and route notes round-trip through saved-definition and Workflow tool reads", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const yaml = YAML(30).replace("initial: hold", 'notes: "Why this process exists."\ninitial: hold')
                .replace("hold: { type: wait,", 'hold: { description: "Check the build", notes: "Keep ${unknown.value} literally.", type: wait,')
                .replace("transition: { next: { elapsed: done } }", 'transition: { next: { elapsed: done }, notes: { elapsed: "Check again." } }');
            const id = (await save(host, session, yaml, null)).receipt.definitionId;
            const read = JSON.parse(await workflowDefinitionFromTool({ operation: "read", definition_id: id },
                { callerSessionId: session, host, toolCallId: "read-notes", owner: null, binding: async () => null }));
            expect(read.graph.notes).toBe("Why this process exists.");
            expect(read.graph.states.find(state => state.id === "hold")).toMatchObject({
                about: { description: "Check the build", notes: "Keep ${unknown.value} literally." },
                routeNotes: { elapsed: "Check again." }, next: { elapsed: "done" },
            });
            const running = await start(host, session, id);
            const workflow = await readWorkflowView(h.store, running.workflowId);
            expect(workflow.graph.notes).toBe(read.graph.notes);
            expect(Object.fromEntries(workflow.graph.states.map(state => [state.id, state])))
                .toEqual(Object.fromEntries(read.graph.states.map(state => [state.id, state])));
        } finally {
            await h.stop();
        }
    });

    it("E2-4: a person's save leaves one note for the session, consumed once; the session's own save leaves none and marks what it has seen", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const id = (await save(host, session, YAML(30), null)).receipt.definitionId;
            expect(await h.store.sessionDefinitions.pendingNotes(session)).toEqual([]);
            expect(await h.store.sessionDefinitions.seenRevision(session, id)).toBe(1);
            await save(host, session, YAML(45), { definitionId: id, revision: 1 }, { by: "person", actor: PERSON, personWords: "Ada Lovelace" });
            const notes = await h.store.sessionDefinitions.pendingNotes(session);
            expect(notes.map(note => note.text)).toEqual(["Ada Lovelace saved hn-top-watch revision 2."]);
            expect(await h.store.sessionDefinitions.seenRevision(session, id)).toBe(1, "a person's save is not something the session has seen");
            await h.store.sessionDefinitions.consumeNotes(session, notes.map(note => note.noteId));
            await h.store.sessionDefinitions.consumeNotes(session, notes.map(note => note.noteId));
            expect(await h.store.sessionDefinitions.pendingNotes(session)).toEqual([]);
            // The session reads it with its tool: it has seen revision 2.
            const read = JSON.parse(await workflowDefinitionFromTool({ operation: "read", name: "hn-top-watch" },
                { callerSessionId: session, host, toolCallId: "call-read", owner: null, binding: async () => null }));
            expect(read).toMatchObject({ ok: true, definitionId: id, currentRevision: 2, shown: { revision: 2, savedBy: "Ada Lovelace" } });
            expect(await h.store.sessionDefinitions.seenRevision(session, id)).toBe(2);
        } finally {
            await h.stop();
        }
    });

    it("the workflow_definition tool: save, a save over a name without its guard told how, start; answers are JSON with codes", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const tool = (args, call) => workflowDefinitionFromTool(args, { callerSessionId: session, host, toolCallId: call, owner: null, binding: async () => null })
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

    // OF-S2-5: the session list's flag, read in one query on the owner index: a session with a live definition is an owner; one
    // whose only definition is deleted, and one with none, are not.
    it("OF-S2-5: listWorkflowDefinitionOwnersFor names the sessions with a live definition; a deleted one does not count", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const deletedOwner = randomUUID();
            const none = randomUUID();
            await h.catalog.createSession(deletedOwner, { owner: OWNER });
            await h.catalog.createSession(none, { owner: OWNER });
            await save(host, session, YAML(30), null);
            const gone = (await save(host, deletedOwner, YAML(30), null)).receipt.definitionId;
            await deleteSessionWorkflowDefinition(host, { ownerSessionId: deletedOwner, definitionId: gone, actor: PERSON, operationId: "delete-owner-flag" });
            const owners = await h.catalog.listWorkflowDefinitionOwnersFor([session, deletedOwner, none]);
            expect([...owners]).toEqual([session]);
            expect((await h.catalog.listWorkflowDefinitionOwnersFor([])).size).toBe(0);
        } finally {
            await h.stop();
        }
    });

    it("spawn_workflow (D2): saves to the definition its YAML names, guarded by what the session has seen (Q2), and starts what it saved (F4)", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const spawn = (yaml, extra = {}) => spawnWorkflowCompatFromTool({ yaml, ...extra }, { callerSessionId: session, operationId: `spawn:${randomUUID()}`,
                owner: async () => null, binding: async () => null, host }).then(text => JSON.parse(text));
            const first = await spawn(YAML(30), { state: "published", start: true });
            expect(first).toMatchObject({ ok: true, operation: "save_and_start", revision: 1 });
            // A changed YAML: the next revision (the session saw its own revision 1), started.
            const changed = await spawn(YAML(45), { state: "published", start: true });
            expect(changed).toMatchObject({ ok: true, revision: 2 });
            expect((await h.store.readRevision(changed.workflowId, 1)).yaml).toBe(YAML(45));
            // A person saves revision 3; the session's next spawn_workflow is refused, told to read and redo.
            await save(host, session, YAML(50), { definitionId: first.definitionId, revision: 2 }, { by: "person", actor: PERSON, personWords: "Ada Lovelace" });
            const stale = await spawn(YAML(60), { state: "published", start: true });
            expect(stale).toMatchObject({ ok: false, error: { code: "REVISION_STALE" } });
            expect(stale.error.message).toMatch(/Read hn-top-watch with workflow_definition \(operation read\), redo your change/);
            // Without start: a save only.
            await workflowDefinitionFromTool({ operation: "read", name: "hn-top-watch" }, { callerSessionId: session, host, toolCallId: "r", owner: null, binding: async () => null });
            const saved = await spawn(YAML(70));
            expect(saved).toMatchObject({ ok: true, operation: "save", revision: 4 });
            expect((await listSessionWorkflowDefinitions(host, session))[0].workflows.map(item => item.revision)).toEqual([1, 2]);
        } finally {
            await h.stop();
        }
    });
    it("OF-S2-7: a start's agent node models are checked against the revision and the catalog, stored with the run, reused by Run again, and read at spawn", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        const AGENTS = `
apiVersion: pilotswarm.dev/v1
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
            const saved = (await saveSessionWorkflowDefinition(agentsHost, { ownerSessionId: session, name: "triage", yaml: AGENTS, expected: null,
                actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            expect(saved.valid).toBe(true);
            const startWith = (agentModels, extra = {}) => startSessionWorkflowDefinition(agentsHost, { ownerSessionId: session, definition: { definitionId: saved.definitionId },
                revision: null, runAgainOf: extra.runAgainOf ?? null, inputs: {}, actor: ENGINE, operationId: `start-${randomUUID()}`, owner: OWNER,
                ...(agentModels !== undefined ? { agentModels } : {}) });
            // Refused in words, and nothing is started: an unknown id, a node that is not an agent node, a model the owning session's catalog does not have.
            expect((await refused(startWith({ summarize: { model: "test:a" } }), "AGENT_MODELS_INVALID")).message)
                .toBe("agentModels names summarize, which is not a node of revision 1 of triage. Use the agent nodes' ids (their keys under states:).");
            expect((await refused(startWith({ hold: { model: "test:a" } }), "AGENT_MODELS_INVALID")).message)
                .toBe("agentModels names hold, a wait node of revision 1 of triage; only agent nodes take a model.");
            expect((await refused(startWith({ classify: { model: "test:gone" } }), "AGENT_MODEL_UNAVAILABLE")).message)
                .toBe("The model chosen for classify, test:gone, cannot be used with the owning session's catalog: it is not in your catalog. "
                    + "Choose one from list_available_models, or leave the node out so it uses the session's model.");
            expect((await readSessionWorkflowDefinition(agentsHost, session, { definitionId: saved.definitionId })).workflows).toEqual([]);
            // Started with a choice: checked against the starter (the session's owner), stored with the run, shown by the read.
            const chosen = { classify: { model: "test:fast", reasoningEffort: "low", contextTier: "long_context" } };
            const started = await startWith(chosen);
            expect(started.agentModels).toEqual(chosen);
            expect(checked.at(-1)).toEqual(["test:fast", OWNER.subject]);
            const live = (await h.store.listRuns(started.workflowId)).find(run => run.mode === "live");
            expect(readWorkflowAgentModels(live.agentModels)).toEqual(chosen);
            const view = await readWorkflowModel(agentsHost, started.workflowId, {}, "tool");
            expect(view.run.agentModels).toEqual(chosen);
            // Run again reuses it; a start without one has none, and its read shows none.
            const again = await startWith(undefined, { runAgainOf: started.workflowId });
            expect(again.agentModels).toEqual(chosen);
            expect(readWorkflowAgentModels((await h.store.listRuns(again.workflowId)).find(run => run.mode === "live").agentModels)).toEqual(chosen);
            // The start receipt the session reads names each chosen model with its effort and context tier (DEV at ead83d68).
            const told = JSON.parse(await workflowDefinitionFromTool({ operation: "start", definition_id: saved.definitionId,
                agent_models: { classify: { model: "test:fast", reasoning_effort: "low", context_tier: "long_context" } } },
            { callerSessionId: session, host: agentsHost, toolCallId: `call-${randomUUID()}`, owner: OWNER, binding: async () => null }));
            expect(told.ok, JSON.stringify(told)).toBe(true);
            expect(told.agentModels).toEqual(chosen);
            expect(told.message).toContain("Agent nodes with a model chosen at start: classify: test:fast · low · long context; "
                + "the others use this session's model.");
            const plain = await startWith(undefined);
            expect(plain.agentModels).toBeUndefined();
            expect((await h.store.listRuns(plain.workflowId)).find(run => run.mode === "live").agentModels).toBe(null);
            expect(Object.hasOwn((await readWorkflowModel(agentsHost, plain.workflowId, {}, "tool")).run, "agentModels")).toBe(false);
            // At spawn, over the real session rows: a node left out inherits the session's model, effort AND context tier.
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
    // The review of ead83d68 (fact pse/wfs/reviews/of-s2-7-ead83d68/rulings): OF7-R1 the owning session's catalog (the identity
    // that spends), never the caller's; OF7-R2 a person's real-agent test checks before anything is admitted; OF7-R3 the
    // update_workflow start and publish_and_start take the map; OF7-R4 an explicit {} clears Run again's choices through the
    // management API; a host that cannot check refuses a map.
    it("OF-S2-7 review: the owning session's catalog whoever starts; real-agent tests and legacy starts take the map; {} clears Run again; no checker, no map", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        // The owning session has run a turn (no worker runs here): people start its definition through the management client.
        await recordSessionRanATurn(h.catalog, session);
        const env = getEnv();
        const AGENTS = `
apiVersion: pilotswarm.dev/v1
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
            const saved = (await saveSessionWorkflowDefinition(agentsHost, { ownerSessionId: session, name: "triage", yaml: AGENTS, expected: null,
                actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            expect(saved.valid, JSON.stringify(saved.diagnostics)).toBe(true);
            const chosen = { classify: { model: "test:fast", reasoningEffort: "low" } };
            const mgmtStart = (request, principal) => mgmt.startSessionWorkflowDefinition(session, { definitionId: saved.definitionId,
                operationId: `start-${randomUUID()}`, ...request }, { principal });

            // OF7-R1: an administrator starts the session owner's definition: checked against the owner's catalog, not theirs.
            const byAdmin = await mgmtStart({ agentModels: chosen }, ADMIN);
            expect(byAdmin.agentModels).toEqual(chosen);
            expect(checked).toEqual([["test:fast", OWNER.subject]]);
            // Run again by another person: the same choices, checked against the owner's catalog again.
            const again = await mgmtStart({ runAgainOf: byAdmin.workflowId }, CAROL);
            expect(again.agentModels).toEqual(chosen);
            expect(await liveModels(again.workflowId)).toEqual(chosen);
            expect(checked.at(-1)).toEqual(["test:fast", OWNER.subject]);
            // OF7-R4: an explicit {} through the management API clears them: every agent node takes the session's model.
            const cleared = await mgmtStart({ runAgainOf: byAdmin.workflowId, agentModels: {} }, CAROL);
            expect(cleared.agentModels).toBeUndefined();
            expect(await liveModels(cleared.workflowId)).toBe(null);
            // A model the owner's catalog does not have: refused in words, nothing started.
            const before = (await readSessionWorkflowDefinition(agentsHost, session, { definitionId: saved.definitionId })).workflows.length;
            const gone = await refused(mgmtStart({ agentModels: { classify: { model: "test:gone" } } }, ADMIN), "AGENT_MODEL_UNAVAILABLE");
            expect(gone.message).toMatch(/^The model chosen for classify, test:gone, cannot be used with the owning session's catalog: it is not in the catalog\./);
            expect((await readSessionWorkflowDefinition(agentsHost, session, { definitionId: saved.definitionId })).workflows.length).toBe(before);

            // A Workflow of the session's that is not a session revision's: a person's real-agent test, publish_and_start and start.
            const draft = randomUUID();
            const made = await createWorkflow(agentsHost, { workflowSessionId: draft, parentSessionId: session, yaml: AGENTS, actor: ENGINE,
                operationId: `draft-${randomUUID()}`, publish: false });
            const hash = made.receipt.yamlSha256;
            const command = (sessionId, args) => mgmt.updateWorkflow(sessionId, { operation_id: `cmd-${randomUUID()}`, ...args }, { principal: ADMIN });
            // OF7-R2: refused before anything is admitted.
            const test = await refused(command(draft, { operation: "test", expected_revision: 1, definition_hash: hash, inputs: {}, agent_mode: "real",
                agent_models: { classify: { model: "test:gone" } } }), "AGENT_MODEL_UNAVAILABLE");
            expect(test.message).toMatch(/owning session's catalog/);
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
            await createWorkflow(agentsHost, { workflowSessionId: published, parentSessionId: session, yaml: AGENTS, actor: ENGINE,
                operationId: `published-${randomUUID()}`, publish: true });
            await command(published, { operation: "start", definition_hash: hash, inputs: {}, agent_models: { classify: { model: "test:other" } } });
            expect(await liveModels(published)).toEqual({ classify: { model: "test:other" } });
            expect(checked.at(-1)).toEqual(["test:other", OWNER.subject]);

            // Review D4: a repeat of an admitted start answers its receipt even when the owner can no longer use the model.
            const lost = { classify: { model: "test:lost" } };
            const opStart = `start-${randomUUID()}`;
            const once = await mgmt.startSessionWorkflowDefinition(session, { definitionId: saved.definitionId, operationId: opStart, agentModels: lost },
                { principal: ADMIN });
            const pulled = mgmt._checkWorkflowAgentModel;
            mgmt._checkWorkflowAgentModel = async (choice, owner) => (choice.model === "test:lost" ? "it was removed from the catalog." : pulled(choice, owner));
            const twice = await mgmt.startSessionWorkflowDefinition(session, { definitionId: saved.definitionId, operationId: opStart, agentModels: lost },
                { principal: ADMIN });
            expect(twice).toMatchObject({ workflowId: once.workflowId, replayed: true });
            // A new start with it is refused.
            await refused(mgmtStart({ agentModels: lost }, ADMIN), "AGENT_MODEL_UNAVAILABLE");
            // The same for update_workflow start and publish_and_start, and a real-agent test.
            mgmt._checkWorkflowAgentModel = pulled;
            const replayDraft = randomUUID();
            const replayMade = await createWorkflow(agentsHost, { workflowSessionId: replayDraft, parentSessionId: session, yaml: AGENTS, actor: ENGINE,
                operationId: `draft-${randomUUID()}`, publish: false });
            const testArgs = { operation: "test", operation_id: `test-${randomUUID()}`, expected_revision: 1, definition_hash: replayMade.receipt.yamlSha256,
                inputs: {}, agent_mode: "real", agent_models: lost };
            const pasArgs = { operation: "publish_and_start", operation_id: `pas-${randomUUID()}`, expected_revision: 1,
                definition_hash: replayMade.receipt.yamlSha256, inputs: {}, agent_models: lost };
            let lostChecks = 0;
            const lose = () => {
                mgmt._checkWorkflowAgentModel = async (choice, owner) => {
                    if (choice.model !== "test:lost") return pulled(choice, owner);
                    lostChecks++;
                    return "it was removed from the catalog.";
                };
            };
            const firstTest = await mgmt.updateWorkflow(replayDraft, testArgs, { principal: ADMIN });
            lose();
            expect(await mgmt.updateWorkflow(replayDraft, testArgs, { principal: ADMIN })).toMatchObject({ replayed: true, run: { runId: firstTest.run.runId } });
            mgmt._checkWorkflowAgentModel = pulled;
            const firstPas = await mgmt.updateWorkflow(replayDraft, pasArgs, { principal: ADMIN });
            const replayPublished = randomUUID();
            await createWorkflow(agentsHost, { workflowSessionId: replayPublished, parentSessionId: session, yaml: AGENTS, actor: ENGINE,
                operationId: `published-${randomUUID()}`, publish: true });
            const startArgs = { operation: "start", operation_id: `ls-${randomUUID()}`, definition_hash: replayMade.receipt.yamlSha256, inputs: {},
                agent_models: lost };
            const firstStart = await mgmt.updateWorkflow(replayPublished, startArgs, { principal: ADMIN });
            lose();
            expect(lostChecks).toBe(0);
            expect(await mgmt.updateWorkflow(replayDraft, pasArgs, { principal: ADMIN })).toMatchObject({ replayed: true, run: { runId: firstPas.run.runId } });
            expect(await mgmt.updateWorkflow(replayPublished, startArgs, { principal: ADMIN })).toMatchObject({ replayed: true, run: { runId: firstStart.run.runId } });
            expect(lostChecks).toBe(0);
            // A new one is refused.
            await refused(mgmt.updateWorkflow(replayPublished, { ...startArgs, operation_id: `ls-${randomUUID()}` }, { principal: ADMIN }), "AGENT_MODEL_UNAVAILABLE");
            expect(lostChecks).toBe(1);
            mgmt._checkWorkflowAgentModel = pulled;

            // Review D8: Run again of a Workflow whose stored map cannot be read is refused in words; it never drops the map.
            const damaged = await mgmtStart({ agentModels: chosen }, ADMIN);
            await h.store.pool.query(`UPDATE ${h.store.t.runs} SET agent_models = $1 WHERE workflow_session_id = $2`, ['{"classify":', damaged.workflowId]);
            const unreadable = await refused(mgmtStart({ runAgainOf: damaged.workflowId }, CAROL), "AGENT_MODELS_INVALID");
            expect(unreadable.message).toMatch(/^The agent models stored with this run cannot be read \(AGENT_MODELS_INVALID\): .+ Give agentModels \(an empty map: the session's models\) to run it again\.$/);
            // An explicit map (here: none) runs it again.
            expect((await mgmtStart({ runAgainOf: damaged.workflowId, agentModels: {} }, CAROL)).agentModels).toBeUndefined();

            // Fail closed: a host that cannot check models refuses any map (and starts as before without one).
            const unchecked = { ...host };
            const closed = await refused(startSessionWorkflowDefinition(unchecked, { ownerSessionId: session, definition: { definitionId: saved.definitionId },
                revision: null, inputs: {}, actor: ENGINE, operationId: `start-${randomUUID()}`, agentModels: chosen }), "AGENT_MODEL_UNAVAILABLE");
            expect(closed.message).toMatch(/^This host cannot check models against the owning session's catalog/);
            expect((await startSessionWorkflowDefinition(unchecked, { ownerSessionId: session, definition: { definitionId: saved.definitionId },
                revision: null, inputs: {}, actor: ENGINE, operationId: `start-${randomUUID()}` })).agentModels).toBeUndefined();
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
    // Owner 2026-11-09T05:38Z: an agent state that sets no session continues its agent session by default; 07:03Z, (a): a revision
    // saved before that, without the key, starts with continue (a Start compiles its YAML again), and the definition's graph
    // says so; a re-save compiles to continue. 06:30Z: a revision saved with the old key `session` no longer starts; it says why.
    it("continue default: a revision saved before without session starts continued, and its graph says so; one saved with session: is refused in words", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        const AGENTS = `
apiVersion: pilotswarm.dev/v1
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
        const modeOf = graph => graph.states.find(state => state.id === "classify").session ?? "new";
        const workflowMode = async workflowId => modeOf((await readWorkflowModel(agentsHost, workflowId, {}, "tool")).graph);
        /** `yaml` as a build before the default changed stored it: its IR with no session mode (a new session each visit). */
        const storedBefore = (yaml, compiledFrom = yaml) => {
            const fresh = compileWorkflow(compiledFrom);
            const ir = JSON.parse(JSON.stringify(fresh.ir));
            delete ir.nodes.classify.session;
            return { ...fresh, ir, irSha256: sha256Hex(canonicalJson(ir)), yamlSha256: sha256Hex(yaml) };
        };
        try {
            const before = storedBefore(AGENTS);
            const old = (await saveSessionWorkflowDefinition(agentsHost, { ownerSessionId: session, name: "triage", yaml: AGENTS, expected: null, compiled: before,
                actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            expect(old).toMatchObject({ revision: 1, valid: true, irSha256: before.irSha256 });
            // Its graph is compiled as a Start compiles it: the agent session continues (its Agent session line says so).
            expect(modeOf((await readSessionWorkflowDefinition(agentsHost, session, { definitionId: old.definitionId, revision: 1 }, { graph: true })).graph))
                .toBe("continue");
            // A Start, and a Run again, of that revision continue one agent session across the step's visits.
            const first = await start(agentsHost, session, old.definitionId, { revision: 1 });
            expect(await workflowMode(first.workflowId)).toBe("continue");
            expect(await workflowMode((await start(agentsHost, session, old.definitionId, { runAgainOf: first.workflowId })).workflowId)).toBe("continue");
            // The same YAML saved again (revision 2) compiles to continue.
            const resaved = (await save(agentsHost, session, AGENTS, { definitionId: old.definitionId, revision: 1 }, { name: "triage" })).receipt;
            expect(resaved).toMatchObject({ revision: 2, valid: true });
            expect(resaved.irSha256).toBe(compileWorkflow(AGENTS).irSha256);
            expect(resaved.irSha256).not.toBe(before.irSha256);
            // A revision whose YAML this build no longer compiles (here: a field it does not know) does not start: its words say why.
            const OLD_KEY = AGENTS.replace("    timeoutSeconds: 600", "    memory: new\n    timeoutSeconds: 600");
            const keyed = (await saveSessionWorkflowDefinition(agentsHost, { ownerSessionId: session, name: "triage", yaml: OLD_KEY,
                expected: { definitionId: old.definitionId, revision: 2 }, compiled: storedBefore(OLD_KEY, AGENTS),
                actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
            expect(keyed).toMatchObject({ revision: 3, valid: true });
            const refusal = await start(agentsHost, session, old.definitionId, { revision: 3 }).then(() => null, error => error);
            expect(refusal?.message).toContain("'memory' is not a field of states.");
            // Its graph is the stored one (its YAML no longer compiles).
            expect(modeOf((await readSessionWorkflowDefinition(agentsHost, session, { definitionId: old.definitionId, revision: 3 }, { graph: true })).graph)).toBe("new");
            // Review PRA-F1: a test of that revision is refused in the same words, before a bench is made; a test of revision 1
            // (saved before the default changed) runs its YAML as this build compiles it, continued.
            const testOf = (revision, operationId) => startSessionWorkflowTest(agentsHost, { ownerSessionId: session, definition: { definitionId: old.definitionId },
                revision, inputs: {}, fixtures: [], operationId, actor: ENGINE, owner: async () => OWNER, binding: async () => null });
            const testRefusal = await testOf(3, "test-3").then(() => null, error => error);
            expect(testRefusal).toMatchObject({ code: "DEFINITION_INVALID",
                message: expect.stringContaining("'memory' is not a field of states.") });
            expect(testRefusal.message).toContain("Nothing was tested.");
            const tested = await testOf(1, "test-1");
            expect(tested).toMatchObject({ definitionId: old.definitionId, revision: 1, runId: expect.any(String) });
            expect(await workflowMode(tested.testId)).toBe("continue");
        } finally {
            await h.stop();
        }
    });

    it("workflow_definition delete: own definitions, DEFINITION_IN_USE naming active Workflows, package refusal, cross-session refusal, operation_id replay, DEFINITION_DELETED, list omits deleted, inside-Workflow refusal", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        const otherSession = randomUUID();
        await h.catalog.createSession(otherSession, { owner: OWNER });
        try {
            const callTool = (caller, args, toolCallId = `call-${randomUUID()}`) =>
                workflowDefinitionFromTool(args, { callerSessionId: caller, host, toolCallId, owner: OWNER, binding: async () => null })
                    .then(text => JSON.parse(text));

            // 1. Delete own definition by definition_id; actor is the calling session; list no longer shows it.
            const first = (await save(host, session, YAML(10, "throwaway-a"), null, { name: "throwaway-a" })).receipt;
            const deletedA = await callTool(session, { operation: "delete", definition_id: first.definitionId, operation_id: "del-a-1" }, null);
            expect(deletedA).toMatchObject({
                ok: true,
                operation: "delete",
                definitionId: first.definitionId,
                name: "throwaway-a",
                replayed: false,
            });
            expect(typeof deletedA.deletedAt).toBe("string");
            const [storedRowA] = await h.q(`SELECT deleted_at, deleted_by FROM SCHEMA.session_workflow_definitions WHERE definition_id = $1`, [first.definitionId]);
            expect(storedRowA.deleted_at).not.toBeNull();
            expect(JSON.parse(storedRowA.deleted_by)).toEqual({ kind: "session", sessionId: session });
            const listedAfterA = await callTool(session, { operation: "list" });
            expect(listedAfterA.definitions.some(d => d.definitionId === first.definitionId)).toBe(false);

            // 2. Replay by operation_id returns the same receipt with replayed: true.
            const replayA = await callTool(session, { operation: "delete", definition_id: first.definitionId, operation_id: "del-a-1" });
            expect(replayA).toMatchObject({
                ok: true,
                operation: "delete",
                definitionId: first.definitionId,
                name: "throwaway-a",
                deletedAt: deletedA.deletedAt,
                replayed: true,
            });
            // Reusing operation_id for a different definition (by id or by name) or for another operation kind refuses with OPERATION_CONFLICT.
            const otherOwn = (await save(host, session, YAML(10, "keep-me"), null, { name: "keep-me", operationId: "save-op-conflict" })).receipt;
            const conflict = await callTool(session, { operation: "delete", definition_id: otherOwn.definitionId, operation_id: "del-a-1" });
            expect(conflict).toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            const conflictByName = await callTool(session, { operation: "delete", name: "keep-me", operation_id: "del-a-1" });
            expect(conflictByName).toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            const conflictByKind = await callTool(session, { operation: "delete", definition_id: otherOwn.definitionId, operation_id: "save-op-conflict" });
            expect(conflictByKind).toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            // Mismatched definition_id and name for own definition is refused with WORKFLOW_COMMAND_INVALID.
            const mismatchedRef = await callTool(session, { operation: "delete", definition_id: otherOwn.definitionId, name: "wrong-name", operation_id: "del-mismatch-1" });
            expect(mismatchedRef).toMatchObject({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID" } });
            expect((await h.store.sessionDefinitions.readDefinition(otherOwn.definitionId)).deletedAt).toBeNull();

            // 3. Second delete with a new operation_id gets DEFINITION_DELETED (both by definition_id and by name).
            const secondA = await callTool(session, { operation: "delete", definition_id: first.definitionId, operation_id: "del-a-2" });
            expect(secondA).toMatchObject({ ok: false, error: { code: "DEFINITION_DELETED" } });
            const secondAByName = await callTool(session, { operation: "delete", name: "throwaway-a", operation_id: "del-a-3" });
            expect(secondAByName).toMatchObject({ ok: false, error: { code: "DEFINITION_DELETED" } });

            // 4. Delete by name, replay by name even after recreating the same name, and omit operation_id (falls back to toolCallId).
            const byName = (await save(host, session, YAML(15, "throwaway-b"), null, { name: "throwaway-b" })).receipt;
            const delByName = await callTool(session, { operation: "delete", name: "throwaway-b" }, "call-del-b");
            expect(delByName).toMatchObject({ ok: true, operation: "delete", definitionId: byName.definitionId, name: "throwaway-b", replayed: false });
            const recreated = (await save(host, session, YAML(20, "throwaway-b"), null, { name: "throwaway-b" })).receipt;
            expect(recreated.definitionId).not.toBe(byName.definitionId);
            const replayByName = await callTool(session, { operation: "delete", name: "throwaway-b" }, "call-del-b");
            expect(replayByName).toMatchObject({ ok: true, operation: "delete", definitionId: byName.definitionId, name: "throwaway-b", deletedAt: delByName.deletedAt, replayed: true });
            // Recreated definition must remain live.
            expect((await h.store.sessionDefinitions.readDefinition(recreated.definitionId)).deletedAt).toBeNull();
            // Clean up recreated with a fresh call id.
            expect((await callTool(session, { operation: "delete", name: "throwaway-b" }, "call-del-b2")).ok).toBe(true);

            // 5. DEFINITION_IN_USE while a Workflow is active: refusal text names the active Workflow(s) and says to stop or cancel first.
            const liveDef = (await save(host, session, YAML(60, "active-watch"), null, { name: "active-watch" })).receipt;
            const wf1 = await start(host, session, liveDef.definitionId);
            const inUse = await callTool(session, { operation: "delete", definition_id: liveDef.definitionId, operation_id: "del-inuse-1" });
            expect(inUse).toMatchObject({ ok: false, error: { code: "DEFINITION_IN_USE" } });
            expect(inUse.error.details.workflowSessionIds).toEqual([wf1.workflowId]);
            expect(inUse.error.message).toContain(wf1.workflowId);
            expect(inUse.error.message).toMatch(/stop or cancel/i);
            expect(inUse.error.message).toMatch(/ask the person/i);
            // Person-facing deleteSessionWorkflowDefinition keeps the store wording without the agent-only caveat.
            const personInUse = await refused(deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: liveDef.definitionId, actor: PERSON, operationId: "person-inuse-1",
            }), "DEFINITION_IN_USE");
            expect(personInUse.message).toContain(wf1.workflowId);
            expect(personInUse.message).toMatch(/stop or cancel/i);
            expect(personInUse.message).not.toMatch(/ask the person/i);
            // Cancel the Workflow, then delete succeeds and finished Workflow keeps its revision copy.
            await controlWorkflowRun(host, wf1.workflowId, { operation: "cancel", runId: null, reason: "test" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            const deletedAfterCancel = await callTool(session, { operation: "delete", name: "active-watch", operation_id: "del-inuse-2" });
            expect(deletedAfterCancel).toMatchObject({ ok: true, operation: "delete", definitionId: liveDef.definitionId, name: "active-watch", replayed: false });
            expect((await h.store.readRevision(wf1.workflowId, 1)).yaml).toBe(YAML(60, "active-watch"));

            // 6. Package definitions (<package>/<name>, locked) are refused with DEFINITION_LOCKED (both unattached by name, and attached by name or definition_id).
            const unattachedPkg = await callTool(session, { operation: "delete", name: "release-tools/release-watch", operation_id: "del-pkg-1" });
            expect(unattachedPkg).toMatchObject({ ok: false, error: { code: "DEFINITION_LOCKED" } });
            expect(unattachedPkg.error.message).toMatch(/package/i);
            const pkgYaml = YAML(30, "release-watch");
            const attachedPkg = (await h.store.sessionDefinitions.attachPackage({
                ownerSessionId: session,
                name: "release-tools/release-watch",
                yaml: pkgYaml,
                compiled: compileWorkflow(pkgYaml),
                package: { packageId: "pkg-1", packageName: "release-tools", semver: "1.0.0", sha256: "a".repeat(64), cardDigest: "b".repeat(64) },
                card: null,
                actor: { kind: "session", sessionId: session },
                operationId: `attach-${randomUUID()}`,
                requestSha256: sha256Hex("attach-pkg-test"),
                seenBySession: true,
            })).receipt;
            const lockedByName = await callTool(session, { operation: "delete", name: "release-tools/release-watch", operation_id: "del-pkg-2" });
            expect(lockedByName).toMatchObject({ ok: false, error: { code: "DEFINITION_LOCKED" } });
            expect(lockedByName.error.message).toContain("release-tools");
            const lockedById = await callTool(session, { operation: "delete", definition_id: attachedPkg.definitionId, operation_id: "del-pkg-3" });
            expect(lockedById).toMatchObject({ ok: false, error: { code: "DEFINITION_LOCKED" } });
            expect(lockedById.error.message).toContain("release-tools");
            expect((await h.store.sessionDefinitions.readDefinition(attachedPkg.definitionId)).deletedAt).toBeNull();
            // A person can still delete an attached package definition via deleteSessionWorkflowDefinition.
            expect((await deleteSessionWorkflowDefinition(host, { ownerSessionId: session, definitionId: attachedPkg.definitionId, actor: PERSON, operationId: "person-del-pkg" })).receipt.definitionId)
                .toBe(attachedPkg.definitionId);

            // 7. Another session's definition is refused with DEFINITION_NOT_FOUND (unlocked and locked alike, no cross-session metadata leak).
            const foreign = (await save(host, otherSession, YAML(10, "foreign-wf"), null, { name: "foreign-wf" })).receipt;
            const foreignRefused = await callTool(session, { operation: "delete", definition_id: foreign.definitionId, operation_id: "del-foreign-1" });
            expect(foreignRefused).toMatchObject({ ok: false, error: { code: "DEFINITION_NOT_FOUND" } });
            expect(foreignRefused.error.message).not.toContain("foreign-wf");
            const foreignWithName = await callTool(session, { operation: "delete", definition_id: foreign.definitionId, name: "probe-name", operation_id: "del-foreign-name" });
            expect(foreignWithName).toMatchObject({ ok: false, error: { code: "DEFINITION_NOT_FOUND" } });
            expect(foreignWithName.error.message).not.toContain("foreign-wf");
            expect((await h.store.sessionDefinitions.readDefinition(foreign.definitionId)).deletedAt).toBeNull();
            const foreignPkg = (await h.store.sessionDefinitions.attachPackage({
                ownerSessionId: otherSession,
                name: "other-pkg/watch",
                yaml: pkgYaml,
                compiled: compileWorkflow(pkgYaml),
                package: { packageId: "pkg-2", packageName: "other-pkg", semver: "1.0.0", sha256: "c".repeat(64), cardDigest: "d".repeat(64) },
                card: null,
                actor: { kind: "session", sessionId: otherSession },
                operationId: `attach-${randomUUID()}`,
                requestSha256: sha256Hex("attach-foreign-pkg-test"),
                seenBySession: true,
            })).receipt;
            const foreignPkgRefused = await callTool(session, { operation: "delete", definition_id: foreignPkg.definitionId, operation_id: "del-foreign-2" });
            expect(foreignPkgRefused).toMatchObject({ ok: false, error: { code: "DEFINITION_NOT_FOUND" } });
            expect(foreignPkgRefused.error.message).not.toContain("other-pkg");

            // 8. A Workflow session cannot own definitions; calling delete as a Workflow session is refused with SESSION_NOT_FOUND.
            const wfCallerRefused = await callTool(wf1.workflowId, { operation: "delete", definition_id: otherOwn.definitionId, operation_id: "del-wf-caller-1" });
            expect(wfCallerRefused).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
            expect((await h.store.sessionDefinitions.readDefinition(otherOwn.definitionId)).deletedAt).toBeNull();

            // 9. Inside-a-Workflow session (agent step child) is refused with WORKFLOW_HUMAN_INPUT_DENIED (same guard as save/start).
            const agentWfYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: agent-parent, version: "1.0.0" }
initial: step
states:
  step:
    type: agent
    invoke: { prompt: "Work." }
    timeoutSeconds: 600
    transition: { next: { done: end, failure: fail } }
  end: { type: terminal, outcome: succeeded }
  fail: { type: terminal, outcome: failed }
`;
            const agentDef = (await save(host, session, agentWfYaml, null, { name: "agent-parent" })).receipt;
            const agentWf = await start(host, session, agentDef.definitionId);
            const stepChild = randomUUID();
            await h.store.enterNode({
                runId: agentWf.runId, nodeExecutionId: `nx-${randomUUID()}`, scopeId: "root", nodeId: "step", ordinal: 1, nodeType: "agent",
                predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
                agent: { childSessionId: stepChild, controllingSessionId: session, task: { source: "prompt", prompt: "Work." }, outcomes: ["done"],
                    outputSchema: null, timeoutSeconds: 600 },
            });
            await h.catalog.createSession(stepChild, { parentSessionId: agentWf.workflowId, owner: OWNER });
            const insideRefused = await callTool(stepChild, { operation: "delete", definition_id: otherOwn.definitionId, operation_id: "del-inside-1" });
            expect(insideRefused).toMatchObject({ ok: false, error: { code: "WORKFLOW_HUMAN_INPUT_DENIED" } });
            const insidePkgRefused = await callTool(stepChild, { operation: "delete", name: "release-tools/release-watch", operation_id: "del-inside-2" });
            expect(insidePkgRefused).toMatchObject({ ok: false, error: { code: "WORKFLOW_HUMAN_INPUT_DENIED" } });
        } finally {
            await h.stop();
        }
    });

    it("delete refused with DEFINITION_IN_USE when an active Workflow's spawn state names the target (by name, by id, parallel lanes, spawned child Workflow, person delete, concurrent Start, allowed after end)", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        const otherSession = randomUUID();
        await h.catalog.createSession(otherSession, { owner: OWNER });
        const mgmt = await createManagementClient(getEnv(), { workflowCommands: {} });
        const callTool = (caller, args, toolCallId = `call-${randomUUID()}`) =>
            workflowDefinitionFromTool(args, { callerSessionId: caller, host, toolCallId, owner: OWNER, binding: async () => null })
                .then(text => JSON.parse(text));
        const parentSpawnYaml = (name, spawnDef, stateId = "launch_child") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: ${stateId}
states:
  ${stateId}:
    type: spawn
    definition: "${spawnDef}"
    transition: { next: { started: hold, failure: fail } }
  hold: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
  fail: { type: terminal, outcome: failed }
`;
        const parallelForEachSpawnYaml = (name, spawnDef) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    forEach: [1, 2]
    concurrency: 2
    join: all_required
    failFast: false
    body:
      initial: lane_spawn
      states:
        lane_spawn:
          type: spawn
          definition: "${spawnDef}"
          transition: { next: { started: lane_done, failure: lane_fail } }
        lane_done: { type: terminal, outcome: succeeded }
        lane_fail: { type: terminal, outcome: failed }
    transition: { next: { joined: done, blocked: fail, failure: fail } }
  done: { type: terminal, outcome: succeeded }
  fail: { type: terminal, outcome: failed }
`;
        const parallelBranchesSpawnYaml = (name, spawnDef) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: fork
states:
  fork:
    type: parallel
    concurrency: 2
    join: all_required
    failFast: false
    branches:
      left:
        initial: left_spawn
        states:
          left_spawn:
            type: spawn
            definition: "${spawnDef}"
            transition: { next: { started: l_done, failure: l_fail } }
          l_done: { type: terminal, outcome: succeeded }
          l_fail: { type: terminal, outcome: failed }
      right:
        initial: r_wait
        states:
          r_wait: { type: wait, seconds: 600, transition: { next: { elapsed: r_done } } }
          r_done: { type: terminal, outcome: succeeded }
    transition: { next: { joined: done, blocked: fail, failure: fail } }
  done: { type: terminal, outcome: succeeded }
  fail: { type: terminal, outcome: failed }
`;
        try {
            // 1. Running parent whose spawn names target by NAME -> refused on agent tool AND person management client.
            const targetByName = (await save(host, session, YAML(30, "leaf-by-name"), null, { name: "leaf-by-name" })).receipt;
            const parentDef = (await save(host, session, parentSpawnYaml("parent-by-name", "leaf-by-name", "launch_leaf"), null, { name: "parent-by-name" })).receipt;
            // Start workflow #1 (and cancel it) then start workflow #2 so we also verify workflow number (#2) is accurate.
            const parentWf1 = await start(host, session, parentDef.definitionId);
            await controlWorkflowRun(host, parentWf1.workflowId, { operation: "cancel", runId: null, reason: "make #2 active" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            const parentWf2 = await start(host, session, parentDef.definitionId);

            // Saving a newer revision (rev 2) of parent-by-name WITHOUT the spawn must NOT unblock deletion while #2 runs rev 1.
            await save(host, session, YAML(60, "parent-by-name"), { definitionId: parentDef.definitionId, revision: 1 }, { name: "parent-by-name" });

            // Agent tool delete is refused with DEFINITION_IN_USE naming parent-by-name #2, id, launch_leaf, stop/cancel/wait, and ask the person.
            const toolRefused = await callTool(session, { operation: "delete", name: "leaf-by-name", operation_id: "del-ref-name-1" });
            expect(toolRefused).toMatchObject({ ok: false, error: { code: "DEFINITION_IN_USE" } });
            expect(toolRefused.error.details.workflowSessionIds).toEqual([parentWf2.workflowId]);
            expect(toolRefused.error.details.referencedBy).toEqual([
                { workflowSessionId: parentWf2.workflowId, name: "parent-by-name", number: 2, spawnStates: ["launch_leaf"] },
            ]);
            expect(toolRefused.error.message).toContain("parent-by-name #2");
            expect(toolRefused.error.message).toContain(parentWf2.workflowId);
            expect(toolRefused.error.message).toContain("launch_leaf");
            expect(toolRefused.error.message).toMatch(/stop or cancel/i);
            expect(toolRefused.error.message).toMatch(/wait for .* to end/i);
            expect(toolRefused.error.message).toMatch(/ask the person/i);

            // Person / Portal management client delete also gets 409 DEFINITION_IN_USE without the agent-only caveat.
            let mgmtErr = null;
            try {
                await mgmt.deleteSessionWorkflowDefinition(session, { definitionId: targetByName.definitionId, operationId: "mgmt-ref-name-1" }, { principal: PERSON });
            } catch (error) { mgmtErr = error; }
            expect(mgmtErr?.code).toBe("DEFINITION_IN_USE");
            expect(mgmtErr?.status).toBe(409);
            expect(mgmtErr?.message).toContain("parent-by-name #2");
            expect(mgmtErr?.message).toContain("launch_leaf");
            expect(mgmtErr?.message).toMatch(/stop or cancel/i);
            expect(mgmtErr?.message).toMatch(/wait for .* to end/i);
            expect(mgmtErr?.message).not.toMatch(/ask the person/i);
            expect(mgmtErr?.details?.referencedBy).toEqual([
                { workflowSessionId: parentWf2.workflowId, name: "parent-by-name", number: 2, spawnStates: ["launch_leaf"] },
            ]);

            // Another session's active Workflow spawning "leaf-by-name" does NOT block unrelated session's delete after our parent ends.
            const foreignParentDef = (await save(host, otherSession, parentSpawnYaml("foreign-parent", "leaf-by-name", "foreign_launch"), null, { name: "foreign-parent" })).receipt;
            await start(host, otherSession, foreignParentDef.definitionId);

            // Once parentWf2 ends, even with rev 2 active (which has no spawn) and foreign-parent active, leaf-by-name can be deleted.
            await controlWorkflowRun(host, parentWf2.workflowId, { operation: "cancel", runId: null, reason: "done" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            const parentWf3Rev2 = await start(host, session, parentDef.definitionId, { revision: 2 });
            const deletedName = await callTool(session, { operation: "delete", name: "leaf-by-name", operation_id: "del-ref-name-2" });
            expect(deletedName).toMatchObject({ ok: true, operation: "delete", definitionId: targetByName.definitionId, name: "leaf-by-name", replayed: false });
            await controlWorkflowRun(host, parentWf3Rev2.workflowId, { operation: "cancel", runId: null, reason: "cleanup" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });

            // 2. Running parent whose spawn names target by DEFINITION ID -> refused, then allowed after parent ends.
            const targetById = (await save(host, session, YAML(30, "leaf-by-id"), null, { name: "leaf-by-id" })).receipt;
            const parentByIdDef = (await save(host, session, parentSpawnYaml("parent-by-id", targetById.definitionId, "spawn_by_uuid"), null, { name: "parent-by-id" })).receipt;
            const parentByIdWf = await start(host, session, parentByIdDef.definitionId);
            const idRefused = await refused(deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: targetById.definitionId, actor: PERSON, operationId: "del-ref-id-1",
            }), "DEFINITION_IN_USE");
            expect(idRefused.message).toContain("parent-by-id #1");
            expect(idRefused.message).toContain("spawn_by_uuid");
            expect(idRefused.details.referencedBy).toEqual([
                { workflowSessionId: parentByIdWf.workflowId, name: "parent-by-id", number: 1, spawnStates: ["spawn_by_uuid"] },
            ]);
            await controlWorkflowRun(host, parentByIdWf.workflowId, { operation: "cancel", runId: null, reason: "done" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            expect((await deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: targetById.definitionId, actor: PERSON, operationId: "del-ref-id-2",
            })).receipt.definitionId).toBe(targetById.definitionId);

            // 3. Running parents whose spawn states sit inside parallel lanes (both forEach body AND named branches) -> refused naming both.
            const targetPar = (await save(host, session, YAML(30, "leaf-parallel"), null, { name: "leaf-parallel" })).receipt;
            const forEachDef = (await save(host, session, parallelForEachSpawnYaml("par-foreach", "leaf-parallel"), null, { name: "par-foreach" })).receipt;
            const branchesDef = (await save(host, session, parallelBranchesSpawnYaml("par-branches", "leaf-parallel"), null, { name: "par-branches" })).receipt;
            const forEachWf = await start(host, session, forEachDef.definitionId);
            const branchesWf = await start(host, session, branchesDef.definitionId);
            const parRefused = await refused(deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: targetPar.definitionId, actor: PERSON, operationId: "del-ref-par-1",
            }), "DEFINITION_IN_USE");
            expect(parRefused.message).toContain("par-foreach #1");
            expect(parRefused.message).toContain("lane_spawn");
            expect(parRefused.message).toContain("par-branches #1");
            expect(parRefused.message).toContain("left_spawn");
            expect(parRefused.details.workflowSessionIds).toEqual([forEachWf.workflowId, branchesWf.workflowId]);
            await controlWorkflowRun(host, forEachWf.workflowId, { operation: "cancel", runId: null, reason: "done" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            // Still refused while branchesWf is active.
            const stillRefused = await refused(deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: targetPar.definitionId, actor: PERSON, operationId: "del-ref-par-2",
            }), "DEFINITION_IN_USE");
            expect(stillRefused.details.workflowSessionIds).toEqual([branchesWf.workflowId]);
            await controlWorkflowRun(host, branchesWf.workflowId, { operation: "cancel", runId: null, reason: "done" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            expect((await deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: targetPar.definitionId, actor: PERSON, operationId: "del-ref-par-3",
            })).receipt.definitionId).toBe(targetPar.definitionId);

            // 4. Spawned child Workflow (parent_session_id = rootWf, definition owner = session) whose spawn names leaf -> refused even after rootWf ends.
            const leafChild = (await save(host, session, YAML(30, "grandchild-leaf"), null, { name: "grandchild-leaf" })).receipt;
            const midDef = (await save(host, session, parentSpawnYaml("mid-spawner", "grandchild-leaf", "spawn_grandchild"), null, { name: "mid-spawner" })).receipt;
            const rootDef = (await save(host, session, parentSpawnYaml("root-spawner", "mid-spawner", "spawn_mid"), null, { name: "root-spawner" })).receipt;
            const rootWf = await start(host, session, rootDef.definitionId);
            const nxMid = `nx-mid-${randomUUID()}`;
            await h.store.enterNode({
                runId: rootWf.runId, nodeExecutionId: nxMid, scopeId: "root", nodeId: "spawn_mid", ordinal: 1,
                nodeType: "spawn", predecessorId: null, arrivalRoute: null, inputText: "{}", kvRevision: 1, waitSeconds: null, immediate: null,
            });
            const midWf = await startSessionWorkflowDefinition(host, {
                ownerSessionId: session, parentSessionId: rootWf.workflowId, spawn: { nodeExecutionId: nxMid },
                definition: { definitionId: midDef.definitionId }, inputs: {}, actor: ENGINE, operationId: nxMid, owner: OWNER,
            });
            // End rootWf so ONLY the spawned child Workflow (midWf) remains active.
            await controlWorkflowRun(host, rootWf.workflowId, { operation: "cancel", runId: null, reason: "end root" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            const childRefused = await refused(deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: leafChild.definitionId, actor: PERSON, operationId: "del-ref-child-1",
            }), "DEFINITION_IN_USE");
            expect(childRefused.message).toContain("mid-spawner #1");
            expect(childRefused.message).toContain(midWf.workflowId);
            expect(childRefused.message).toContain("spawn_grandchild");
            expect(childRefused.details.workflowSessionIds).toEqual([midWf.workflowId]);
            await controlWorkflowRun(host, midWf.workflowId, { operation: "cancel", runId: null, reason: "end mid" }, { actor: ENGINE, operationId: `cancel-${randomUUID()}` });
            expect((await deleteSessionWorkflowDefinition(host, {
                ownerSessionId: session, definitionId: leafChild.definitionId, actor: PERSON, operationId: "del-ref-child-2",
            })).receipt.definitionId).toBe(leafChild.definitionId);

            // 5. Concurrency: an in-flight Start (holding sessions(owner) FOR SHARE while admitting a parent run)
            //    must serialize against deleteDefinition so delete blocks until Start commits and then refuses DEFINITION_IN_USE.
            const raceTarget = (await save(host, session, YAML(30, "race-leaf"), null, { name: "race-leaf" })).receipt;
            const raceParent = (await save(host, session, parentSpawnYaml("race-parent", "race-leaf", "race_spawn"), null, { name: "race-parent" })).receipt;
            const raceParentCompiled = compileWorkflow(parentSpawnYaml("race-parent", "race-leaf", "race_spawn"));
            const raceWfId = randomUUID();
            await h.catalog.createSession(raceWfId, { parentSessionId: session, owner: OWNER, sessionKind: "workflow" });

            const txClient = await h.pool.connect();
            let deleteResolvedEarly = false;
            try {
                await txClient.query("BEGIN");
                // Mirror requireSessionStartLocked: hold FOR SHARE on the owner session row.
                await txClient.query(`SELECT state FROM "${h.store.schema}".sessions WHERE session_id = $1 FOR SHARE`, [session]);
                const deletePromise = deleteSessionWorkflowDefinition(host, {
                    ownerSessionId: session, definitionId: raceTarget.definitionId, actor: PERSON, operationId: "del-race-1",
                }).then(
                    res => { deleteResolvedEarly = true; return { ok: true, res }; },
                    err => ({ ok: false, err }),
                );
                // Give deleteDefinition time to reach the owner session lock; it MUST still be waiting (not committed).
                await new Promise(resolve => setTimeout(resolve, 150));
                expect(deleteResolvedEarly).toBe(false);
                // Now insert the parent Workflow definition, revision, and active live run inside the same transaction and commit.
                await txClient.query(
                    `INSERT INTO "${h.store.schema}".workflow_definitions
                        (workflow_session_id, parent_session_id, api_version, semver, state, current_revision, published_revision,
                         published_yaml_sha256, published_ir_sha256, notify_parent, session_definition_id, session_revision)
                     VALUES ($1, $2, 'pilotswarm.dev/v1', '1.0.0', 'published', 1, 1, $3, $4, true, $5, 1)`,
                    [raceWfId, session, raceParentCompiled.yamlSha256, raceParentCompiled.irSha256, raceParent.definitionId],
                );
                await txClient.query(
                    `INSERT INTO "${h.store.schema}".workflow_revisions
                        (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, name, semver, ir, ir_sha256, actor)
                     VALUES ($1, 1, $2, $3, true, '[]', 'race-parent', '1.0.0', $4, $5, '{"kind":"system","name":"test"}')`,
                    [raceWfId, parentSpawnYaml("race-parent", "race-leaf", "race_spawn"), raceParentCompiled.yamlSha256,
                        canonicalJson(raceParentCompiled.ir), raceParentCompiled.irSha256],
                );
                await txClient.query(
                    `INSERT INTO "${h.store.schema}".workflow_runs
                        (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, start_operation_id, status)
                     VALUES ($1, $2, 'live', 1, $3, $4, '{}', $5, 'start:race', 'admitted')`,
                    [`run-${randomUUID()}`, raceWfId, raceParentCompiled.yamlSha256, raceParentCompiled.irSha256, `wf-${raceWfId}`],
                );
                await txClient.query("COMMIT");
                const outcome = await deletePromise;
                expect(outcome.ok).toBe(false);
                expect(outcome.err?.code).toBe("DEFINITION_IN_USE");
                expect(outcome.err?.message).toContain("race-parent #1");
                expect(outcome.err?.message).toContain("race_spawn");
                // Target must remain live (not deleted).
                expect((await h.store.sessionDefinitions.readDefinition(raceTarget.definitionId)).deletedAt).toBeNull();
            } finally {
                await txClient.query("ROLLBACK").catch(() => {});
                txClient.release();
            }
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
});
