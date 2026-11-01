/**
 * Workflow v2 admission at the session-row creation boundary, on real
 * PostgreSQL through the production entry points: createWorkflowV2, the
 * catalog's createSession call that legacy workflows and agent sessions use,
 * and the ordinary PilotSwarmClient (createSession and its session handle).
 *
 * A v2 creation claims the session row exclusively. It never changes a row
 * another creator made (legacy workflow, agent session, a different v2
 * request), whether that row existed first or was inserted concurrently.
 * No other creator can take a workflow's id: the catalog refuses it, so the
 * ordinary client returns no handle, and a send on a workflow session starts
 * and enqueues nothing at session-<id>, which the workflow controller owns.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmClient, PilotSwarmSession } from "../../src/client.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { registerWorkflowV2 } from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "workflow-v2-admission" };
const ACTOR = { kind: "agent", sessionId: "parent" };

const DRAFT = (name) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: step
states:
  step:
    type: script
    source: |
      await setResult("ok", {});
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;

/** Drafts start no run, so these tests need no durable runtime; a dispatch would be a defect. */
const NO_DISPATCH = {
    startOrchestrationVersioned: async () => { throw new Error("A draft creation must not dispatch a run."); },
};

async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const parentId = randomUUID();
    await catalog.createSession(parentId, { owner: OWNER });
    return { catalog, store, parentId, host: { catalog, store, duroxideClient: NO_DISPATCH } };
}

/** The exact catalog call the legacy createWorkflowSession makes for a new admission. */
function legacyCreate(h, id) {
    return h.catalog.createSession(id, {
        sessionKind: "workflow",
        parentSessionId: h.parentId,
        owner: OWNER,
        creationConfig: {
            workflowToolBinding: { policy: "node-parent-tools-v1", parentSessionId: h.parentId },
            workflowAdmission: { policy: "node-parent-tools-v1", workflowName: "legacy", input: { sessionId: id } },
        },
    });
}

function v2Create(h, id, name = "v2", operationId = "create") {
    return createWorkflowV2(h.host, {
        workflowSessionId: id, parentSessionId: h.parentId, owner: OWNER, yaml: DRAFT(name),
        actor: ACTOR, operationId,
    });
}

async function snapshot(h, id) {
    const [row, creation, definition] = await Promise.all([
        h.catalog.getSession(id), h.catalog.getSessionCreationConfig(id), h.store.readDefinition(id),
    ]);
    return {
        kind: row?.sessionKind ?? null, title: row?.title ?? null, parent: row?.parentSessionId ?? null,
        owner: row?.owner ? { provider: row.owner.provider, subject: row.owner.subject } : null,
        root: row?.rootSessionId ?? null, state: row?.state ?? null, orchestrationId: row?.orchestrationId ?? null,
        creation, definition: definition ? { state: definition.state, revision: definition.currentRevision } : null,
    };
}

describe("workflow v2 admission at the session creation boundary", () => {
    it("refuses an existing legacy workflow or agent session and leaves it unchanged", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const legacyId = randomUUID();
            await legacyCreate(h, legacyId);
            const legacyBefore = await snapshot(h, legacyId);
            await expect(v2Create(h, legacyId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            expect(await snapshot(h, legacyId)).toEqual(legacyBefore);
            expect(legacyBefore.definition).toBeNull();

            const agentId = randomUUID();
            await h.catalog.createSession(agentId, { parentSessionId: h.parentId, owner: OWNER, creationConfig: { systemMessage: "agent" } });
            const agentBefore = await snapshot(h, agentId);
            await expect(v2Create(h, agentId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            const agentAfter = await snapshot(h, agentId);
            expect(agentAfter).toEqual(agentBefore);
            expect(agentAfter.kind).toBe("agent");
            expect(agentAfter.creation).toEqual({ systemMessage: "agent" });

            // A v2 workflow of another parent, or the same parent's workflow created for another owner, is not ours.
            const otherParent = randomUUID();
            await h.catalog.createSession(otherParent, { owner: OWNER });
            const foreignId = randomUUID();
            await createWorkflowV2(h.host, { workflowSessionId: foreignId, parentSessionId: otherParent, owner: OWNER,
                yaml: DRAFT("foreign"), actor: ACTOR, operationId: "create" });
            const foreignBefore = await snapshot(h, foreignId);
            await expect(v2Create(h, foreignId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            await expect(createWorkflowV2(h.host, { workflowSessionId: foreignId, parentSessionId: otherParent,
                owner: { provider: "test", subject: "someone-else" }, yaml: DRAFT("foreign"), actor: ACTOR, operationId: "create" }))
                .rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await snapshot(h, foreignId)).toEqual(foreignBefore);

            const legacyAfterV2 = randomUUID();
            await v2Create(h, legacyAfterV2);
            const v2Before = await snapshot(h, legacyAfterV2);
            await expect(legacyCreate(h, legacyAfterV2)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            await expect(h.catalog.createSession(legacyAfterV2, { owner: OWNER })).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            expect(await snapshot(h, legacyAfterV2)).toEqual(v2Before);
            expect(v2Before.creation.workflowAdmission).toBeUndefined();
            expect(v2Before.owner).toEqual(OWNER);
            expect(v2Before.root).toBe(h.parentId);

            // A legacy workflow's retry still meets its own row; an ordinary creator is refused.
            const legacyAgain = randomUUID();
            await legacyCreate(h, legacyAgain);
            const legacyRow = await snapshot(h, legacyAgain);
            await legacyCreate(h, legacyAgain);
            await expect(h.catalog.createSession(legacyAgain, { owner: OWNER })).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            expect(await snapshot(h, legacyAgain)).toEqual(legacyRow);
        } finally { await h.catalog.close(); }
    });

    it("refuses the second creator in both orders, whichever kind comes first", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const legacyFirst = randomUUID();
            await legacyCreate(h, legacyFirst);
            const legacyState = await snapshot(h, legacyFirst);
            await expect(v2Create(h, legacyFirst)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            expect(await snapshot(h, legacyFirst)).toEqual(legacyState);
            expect(legacyState).toMatchObject({ kind: "workflow", owner: OWNER, root: h.parentId, definition: null });

            const v2First = randomUUID();
            await v2Create(h, v2First);
            const v2State = await snapshot(h, v2First);
            await expect(legacyCreate(h, v2First)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            expect(await snapshot(h, v2First)).toEqual(v2State);
            expect(v2State).toMatchObject({ kind: "workflow", owner: OWNER, root: h.parentId, definition: { state: "draft", revision: 1 } });
        } finally { await h.catalog.close(); }
    });

    it("lets exactly one of concurrent legacy and v2 creators own each id, with no mixed state", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const outcomes = { legacy: 0, v2: 0 };
            for (let round = 0; round < 16; round += 1) {
                const id = randomUUID();
                // Alternate which creator starts first; both run concurrently.
                let legacyCall, v2Call;
                if (round % 2 === 0) { legacyCall = legacyCreate(h, id); v2Call = v2Create(h, id); }
                else { v2Call = v2Create(h, id); legacyCall = legacyCreate(h, id); }
                const [legacy, v2] = await Promise.allSettled([legacyCall, v2Call]);
                const state = await snapshot(h, id);
                expect(state.kind).toBe("workflow");
                const isV2 = Boolean(state.creation.workflowV2);
                const isLegacy = Boolean(state.creation.workflowAdmission);
                expect(isV2 !== isLegacy, JSON.stringify(state)).toBe(true);
                expect(state).toMatchObject({ owner: OWNER, root: h.parentId });
                if (isV2) {
                    outcomes.v2 += 1;
                    expect(v2.status).toBe("fulfilled");
                    expect(legacy.status).toBe("rejected");
                    expect(legacy.reason.code).toBe("SESSION_EXISTS");
                    expect(state.definition).toEqual({ state: "draft", revision: 1 });
                    expect(state.title).toBe("Workflow: v2");
                } else {
                    outcomes.legacy += 1;
                    expect(legacy.status, String(legacy.reason)).toBe("fulfilled");
                    expect(v2.status).toBe("rejected");
                    expect(v2.reason.code).toBe("SESSION_EXISTS");
                    expect(state.definition).toBeNull();
                    expect(state.creation.workflowToolBinding.parentSessionId).toBe(h.parentId);
                }
            }
            expect(outcomes.legacy + outcomes.v2).toBe(16);
        } finally { await h.catalog.close(); }
    });

    it("lets one of two different concurrent v2 requests win an id; the other changes nothing", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            for (let round = 0; round < 10; round += 1) {
                const id = randomUUID();
                const results = await Promise.allSettled([v2Create(h, id, "first", "op-a"), v2Create(h, id, "second", "op-b")]);
                const won = results.filter(result => result.status === "fulfilled");
                const lost = results.filter(result => result.status === "rejected");
                expect(won, JSON.stringify(lost.map(result => result.reason?.message))).toHaveLength(1);
                expect(lost[0].reason.code).toBe("WORKFLOW_EXISTS");
                const state = await snapshot(h, id);
                const winner = won[0].value.receipt;
                const revision = await h.store.readRevision(id, 1);
                expect(revision.yamlSha256).toBe(winner.yamlSha256);
                // The row's claim, its definition and its title all belong to the same request.
                expect(state.creation.workflowV2.operationId).toBe(revision.name === "first" ? "op-a" : "op-b");
                expect(state.title).toBe(`Workflow: ${revision.name}`);
            }
        } finally { await h.catalog.close(); }
    });

    it("returns one receipt to concurrent identical retries", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            for (let round = 0; round < 10; round += 1) {
                const id = randomUUID();
                const results = await Promise.allSettled([v2Create(h, id), v2Create(h, id)]);
                expect(results.map(result => result.status), JSON.stringify(results.map(result => result.reason?.message))).toEqual(["fulfilled", "fulfilled"]);
                const [a, b] = results.map(result => result.value);
                expect(a.receipt).toEqual(b.receipt);
                expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
                expect((await snapshot(h, id)).definition).toEqual({ state: "draft", revision: 1 });
            }
        } finally { await h.catalog.close(); }
    });

    it("continues an interrupted creation only for the same request and tool grant", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const grant = (tools) => ({
                policy: "node-parent-tools-v1", parentSessionId: h.parentId, owner: OWNER, config: {},
                capabilities: { selections: [] }, tools: tools.map(name => ({ name, schemaHash: `${name}-schema` })),
                sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fingerprint",
            });
            const original = grant(["read_facts"]);
            const larger = grant(["read_facts", "store_fact"]);
            // The process stops after the session claim commits and before the definition exists.
            let crash = true;
            const store = Object.create(h.store);
            store.createDefinition = async (input) => {
                if (crash) { crash = false; throw new Error("injected crash after the session claim"); }
                return h.store.createDefinition(input);
            };
            const crashing = { ...h.host, store };
            const id = randomUUID();
            const request = (binding) => ({ workflowSessionId: id, parentSessionId: h.parentId, owner: OWNER, yaml: DRAFT("granted"),
                actor: ACTOR, operationId: "create", binding });
            await expect(createWorkflowV2(crashing, request(original))).rejects.toThrow("injected crash after the session claim");
            const interrupted = await snapshot(h, id);
            expect(interrupted).toMatchObject({ kind: "workflow", definition: null, owner: OWNER, root: h.parentId });
            expect(interrupted.creation.workflowToolBinding).toEqual(original);

            // A retry with another grant is another request: refused, nothing changes.
            await expect(createWorkflowV2(crashing, request(larger))).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await snapshot(h, id)).toEqual(interrupted);

            // The same request finishes the creation with its original grant, once.
            const finished = await createWorkflowV2(crashing, request(original));
            expect(finished.replayed).toBe(false);
            const replay = await createWorkflowV2(crashing, request(original));
            expect(replay).toEqual({ receipt: finished.receipt, replayed: true });
            const done = await snapshot(h, id);
            expect(done.definition).toEqual({ state: "draft", revision: 1 });
            expect(done.creation.workflowToolBinding).toEqual(original);
        } finally { await h.catalog.close(); }
    });

    it("gives an ordinary client no handle on a workflow's id and starts nothing there; an ordinary id still dispatches", { timeout: 180_000 }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const modelProvidersPath = await registerScriptedProvider(env, "http://127.0.0.1:9/never-called");
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const duroxide = new Client(provider);
        // A worker-equivalent registration runs one v2 workflow to its end; it is stopped before the
        // ordinary client acts, so nothing could hide an ordinary orchestration started afterwards.
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        registerWorkflowV2(runtime, {
            store: h.store, catalog: h.catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("This workflow calls no tools."); },
            authorizeParentNotification: async () => false,
            notifyParent: async () => { throw new Error("This workflow has no parent to notify."); },
            deleteSession: async (sessionId) => h.catalog.softDeleteSession(sessionId),
            wakeBackstopMs: 500,
        });
        await runtime.start();
        const client = new PilotSwarmClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, modelProvidersPath,
        });
        let runtimeStopped = false;
        try {
            const live = { ...h.host, duroxideClient: duroxide };
            const draftId = randomUUID();
            await v2Create(h, draftId, "draft-only");
            const finishedId = randomUUID();
            const finished = await createWorkflowV2(live, { workflowSessionId: finishedId, parentSessionId: h.parentId, owner: OWNER,
                yaml: DRAFT("finished"), actor: ACTOR, operationId: "run", start: { inputs: {} } });
            const controller = await duroxide.waitForOrchestration(finished.receipt.run.controllerInstanceId, 60_000);
            expect(controller.status, JSON.stringify(controller)).toBe("Completed");
            expect((await h.store.readRun(finished.receipt.run.runId)).status).toBe("completed");
            await runtime.shutdown(100);
            runtimeStopped = true;
            await client.start();

            const observe = async (id) => {
                const status = await duroxide.getStatus(`session-${id}`);
                const events = await h.catalog.getSessionEvents(id, 0, 200);
                return {
                    row: await snapshot(h, id),
                    orchestration: { status: status.status, output: status.output ?? null },
                    events: events.map(event => event.eventType),
                };
            };
            for (const id of [draftId, finishedId]) {
                const before = await observe(id);
                await expect(client.createSession({ sessionId: id })).rejects.toMatchObject({ code: "SESSION_EXISTS" });
                // A handle made by hand is refused before it starts, updates or enqueues anything.
                await expect(new PilotSwarmSession(id, client).send("hello")).rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                expect(await observe(id), id).toEqual(before);
            }
            const draft = await observe(draftId);
            expect(draft.orchestration.status).toBe("NotFound");
            expect(draft.row).toMatchObject({ kind: "workflow", orchestrationId: null });
            const done = await observe(finishedId);
            expect(done.row).toMatchObject({ kind: "workflow", orchestrationId: `session-${finishedId}` });
            expect(done.events).not.toContain("session.model_resolved");

            // Positive control: an ordinary id gets a handle whose send starts and enqueues its own session.
            const ordinaryId = randomUUID();
            const handle = await client.createSession({ sessionId: ordinaryId });
            expect(handle.sessionId).toBe(ordinaryId);
            expect((await client._catalog.getSession(ordinaryId)).sessionKind).toBe("agent");
            await handle.send("hello");
            const dispatched = await client._catalog.getSession(ordinaryId);
            expect(dispatched).toMatchObject({ orchestrationId: `session-${ordinaryId}`, state: "running" });
            expect((await duroxide.getStatus(`session-${ordinaryId}`)).status).not.toBe("NotFound");
        } finally {
            await client.stop();
            if (!runtimeStopped) await runtime.shutdown(100);
            await h.catalog.close();
        }
    });
});
