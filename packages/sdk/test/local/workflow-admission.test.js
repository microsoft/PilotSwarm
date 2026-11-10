/**
 * Workflow admission at the session-row creation boundary, on real
 * PostgreSQL through the production entry points: createWorkflow, the
 * catalog's createSession call that agent sessions use, and the ordinary
 * PilotSwarmClient (createSession and its session handle).
 *
 * A v2 creation claims the session row exclusively. It never changes a row
 * another creator made (an agent session, a different v2 request), whether
 * that row existed first or was inserted concurrently.
 * No other creator can take a workflow's id: the catalog leaves the row
 * unchanged (as it always has), the ordinary client reads it back and returns
 * no handle, and a send on a workflow session starts and enqueues nothing at
 * session-<id>, which the workflow controller owns.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmClient, PilotSwarmSession } from "../../src/client.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { registerWorkflow } from "../../src/workflow/runtime.ts";
import { DURABLE_SESSION_ORCHESTRATION_NAME } from "../../src/orchestration-registry.ts";
import { DURABLE_SESSION_LATEST_VERSION } from "../../src/orchestration-version.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "workflow-admission" };
const ACTOR = { kind: "agent", sessionId: "parent" };

const DRAFT = (name) => `
apiVersion: pilotswarm.dev/v1
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

/** The catalog call that creates an agent session (a sub-agent of the parent). */
function agentCreate(h, id) {
    return h.catalog.createSession(id, { parentSessionId: h.parentId, owner: OWNER, creationConfig: { systemMessage: "agent" } });
}

function v2Create(h, id, name = "v2", operationId = "create") {
    return createWorkflow(h.host, {
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

describe("workflow admission at the session creation boundary", () => {
    it("refuses an existing agent session and leaves it unchanged", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const agentId = randomUUID();
            await agentCreate(h, agentId);
            const agentBefore = await snapshot(h, agentId);
            await expect(v2Create(h, agentId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            const agentAfter = await snapshot(h, agentId);
            expect(agentAfter).toEqual(agentBefore);
            expect(agentAfter.kind).toBe("agent");
            expect(agentAfter.creation).toEqual({ systemMessage: "agent" });

            // A workflow of another parent, or the same parent's workflow created for another owner, is not ours.
            const otherParent = randomUUID();
            await h.catalog.createSession(otherParent, { owner: OWNER });
            const foreignId = randomUUID();
            await createWorkflow(h.host, { workflowSessionId: foreignId, parentSessionId: otherParent, owner: OWNER,
                yaml: DRAFT("foreign"), actor: ACTOR, operationId: "create" });
            const foreignBefore = await snapshot(h, foreignId);
            await expect(v2Create(h, foreignId)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            await expect(createWorkflow(h.host, { workflowSessionId: foreignId, parentSessionId: otherParent,
                owner: { provider: "test", subject: "someone-else" }, yaml: DRAFT("foreign"), actor: ACTOR, operationId: "create" }))
                .rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await snapshot(h, foreignId)).toEqual(foreignBefore);

            // An ordinary catalog creator leaves a workflow's row as it was.
            const agentAfterV2 = randomUUID();
            await v2Create(h, agentAfterV2);
            const v2Before = await snapshot(h, agentAfterV2);
            await agentCreate(h, agentAfterV2);
            await h.catalog.createSession(agentAfterV2, { owner: OWNER, creationConfig: { replace: true } });
            expect(await snapshot(h, agentAfterV2)).toEqual(v2Before);
            expect(v2Before.owner).toEqual(OWNER);
            expect(v2Before.root).toBe(h.parentId);
        } finally { await h.catalog.close(); }
    });

    it("keeps the first creator's row in both orders, whichever kind comes first", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const agentFirst = randomUUID();
            await agentCreate(h, agentFirst);
            const agentState = await snapshot(h, agentFirst);
            await expect(v2Create(h, agentFirst)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
            expect(await snapshot(h, agentFirst)).toEqual(agentState);
            expect(agentState).toMatchObject({ kind: "agent", owner: OWNER, root: h.parentId, definition: null });

            const v2First = randomUUID();
            await v2Create(h, v2First);
            const v2State = await snapshot(h, v2First);
            await agentCreate(h, v2First);
            expect(await snapshot(h, v2First)).toEqual(v2State);
            expect(v2State).toMatchObject({ kind: "workflow", owner: OWNER, root: h.parentId, definition: { state: "draft", revision: 1 } });
        } finally { await h.catalog.close(); }
    });

    it("lets exactly one of concurrent agent and v2 creators own each id, with no mixed state", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const outcomes = { agent: 0, v2: 0 };
            for (let round = 0; round < 16; round += 1) {
                const id = randomUUID();
                // Alternate which creator starts first; both run concurrently.
                let agentCall, v2Call;
                if (round % 2 === 0) { agentCall = agentCreate(h, id); v2Call = v2Create(h, id); }
                else { v2Call = v2Create(h, id); agentCall = agentCreate(h, id); }
                const [agent, v2] = await Promise.allSettled([agentCall, v2Call]);
                const state = await snapshot(h, id);
                const isV2 = state.kind === "workflow" && Boolean(state.creation.workflow);
                const isAgent = state.kind === "agent" && state.creation?.systemMessage === "agent" && !state.creation.workflow;
                expect(isV2 !== isAgent, JSON.stringify(state)).toBe(true);
                expect(state).toMatchObject({ owner: OWNER, root: h.parentId });
                // The catalog's create never fails on an existing row; it leaves the row unchanged.
                expect(agent.status, String(agent.reason)).toBe("fulfilled");
                if (isV2) {
                    outcomes.v2 += 1;
                    expect(v2.status).toBe("fulfilled");
                    expect(state.definition).toEqual({ state: "draft", revision: 1 });
                    expect(state.title).toBe("Workflow: v2");
                } else {
                    outcomes.agent += 1;
                    expect(v2.status).toBe("rejected");
                    expect(v2.reason.code).toBe("SESSION_EXISTS");
                    expect(state.definition).toBeNull();
                }
            }
            expect(outcomes.agent + outcomes.v2).toBe(16);
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
                expect(state.creation.workflow.operationId).toBe(revision.name === "first" ? "op-a" : "op-b");
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
            await expect(createWorkflow(crashing, request(original))).rejects.toThrow("injected crash after the session claim");
            const interrupted = await snapshot(h, id);
            expect(interrupted).toMatchObject({ kind: "workflow", definition: null, owner: OWNER, root: h.parentId });
            expect(interrupted.creation.workflowToolBinding).toEqual(original);

            // A retry with another grant is another request: refused, nothing changes.
            await expect(createWorkflow(crashing, request(larger))).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await snapshot(h, id)).toEqual(interrupted);

            // The same request finishes the creation with its original grant, once.
            const finished = await createWorkflow(crashing, request(original));
            expect(finished.replayed).toBe(false);
            const replay = await createWorkflow(crashing, request(original));
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
        // A worker-equivalent registration runs one workflow to its end. It stops before the
        // ordinary client acts: no session runtime runs while the client is observed.
        const v2Runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
        registerWorkflow(v2Runtime, {
            store: h.store, catalog: h.catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("This workflow calls no tools."); },
            authorizeParentNotification: async () => false,
            notifyParent: async () => { throw new Error("This workflow has no parent to notify."); },
            deleteSession: async (sessionId) => h.catalog.softDeleteSession(sessionId),
            wakeBackstopMs: 500,
        });
        await v2Runtime.start();
        const client = new PilotSwarmClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, modelProvidersPath,
        });
        const running = { v2: true, observer: null };
        try {
            const live = { ...h.host, duroxideClient: duroxide };
            const draftId = randomUUID();
            await v2Create(h, draftId, "draft-only");
            const finishedId = randomUUID();
            const finished = await createWorkflow(live, { workflowSessionId: finishedId, parentSessionId: h.parentId, owner: OWNER,
                yaml: DRAFT("finished"), actor: ACTOR, operationId: "run", start: { inputs: {} } });
            const controller = await duroxide.waitForOrchestration(finished.receipt.run.controllerInstanceId, 60_000);
            expect(controller.status, JSON.stringify(controller)).toBe("Completed");
            expect((await h.store.readRun(finished.receipt.run.runId)).status).toBe("completed");
            await v2Runtime.shutdown(100);
            running.v2 = false;
            await client.start();

            // Caller evidence: every durable write the real client makes, forwarded unchanged to its real client.
            const writes = [];
            const real = client.duroxideClient;
            const WRITES = new Set(["startOrchestration", "startOrchestrationVersioned", "enqueueEvent", "raiseEvent", "cancelInstance", "deleteInstance"]);
            client.duroxideClient = new Proxy(real, {
                get(target, property) {
                    const value = Reflect.get(target, property, target);
                    if (typeof value !== "function") return value;
                    if (!WRITES.has(property)) return value.bind(target);
                    return async (...args) => {
                        writes.push([property, args[0], args[1]]);
                        return value.apply(target, args);
                    };
                },
            });

            const observe = async (id) => {
                const status = await duroxide.getStatus(`session-${id}`);
                const events = await h.catalog.getSessionEvents(id, 0, 200);
                return {
                    row: await snapshot(h, id),
                    orchestration: { status: status.status, output: status.output ?? null },
                    events: events.map(event => event.eventType),
                };
            };
            const workflowIds = [draftId, finishedId];
            const before = {};
            for (const id of workflowIds) {
                before[id] = await observe(id);
                await expect(client.createSession({ sessionId: id })).rejects.toMatchObject({ code: "SESSION_EXISTS" });
                // A handle made by hand is refused before it starts, updates or enqueues anything.
                await expect(new PilotSwarmSession(id, client).send("hello")).rejects.toMatchObject({ code: "WORKFLOW_SESSION_NOT_CONVERSATIONAL" });
                expect(await observe(id), id).toEqual(before[id]);
            }
            expect(writes).toEqual([]);
            expect(before[draftId].orchestration.status).toBe("NotFound");
            expect(before[draftId].row).toMatchObject({ kind: "workflow", orchestrationId: null });
            expect(before[finishedId].row).toMatchObject({ kind: "workflow", orchestrationId: `session-${finishedId}` });
            expect(before[finishedId].events).not.toContain("session.model_resolved");

            // Positive control: an ordinary id gets a handle whose send starts and enqueues its own session.
            const ordinaryId = randomUUID();
            const handle = await client.createSession({ sessionId: ordinaryId });
            expect(handle.sessionId).toBe(ordinaryId);
            expect((await client._catalog.getSession(ordinaryId)).sessionKind).toBe("agent");
            await handle.send("hello");
            expect(writes).toEqual([
                ["startOrchestrationVersioned", `session-${ordinaryId}`, DURABLE_SESSION_ORCHESTRATION_NAME],
                ["enqueueEvent", `session-${ordinaryId}`, "messages"],
            ]);
            expect(await client._catalog.getSession(ordinaryId)).toMatchObject({ orchestrationId: `session-${ordinaryId}`, state: "running" });

            // Runtime evidence: the provider holds that start and that message for that instance. No
            // session runtime ran yet, so the instance does not exist until one takes the start. An
            // observer registered under the session orchestration's name takes it and reports what it got.
            const observer = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
            observer.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_LATEST_VERSION, function* (ctx, input) {
                const message = yield ctx.dequeueEvent("messages");
                const started = typeof input === "string" ? JSON.parse(input) : input;
                return { sessionId: started.sessionId, message: typeof message === "string" ? JSON.parse(message) : message };
            });
            await observer.start();
            running.observer = observer;
            const taken = await duroxide.waitForOrchestration(`session-${ordinaryId}`, 30_000);
            expect(taken.status, JSON.stringify(taken)).toBe("Completed");
            const output = typeof taken.output === "string" ? JSON.parse(taken.output) : taken.output;
            expect(output).toMatchObject({ sessionId: ordinaryId, message: { prompt: "hello" } });
            // The same runtime would have taken a start for a workflow id too; none existed.
            expect((await duroxide.getStatus(`session-${draftId}`)).status).toBe("NotFound");
            expect(await observe(finishedId)).toEqual(before[finishedId]);
        } finally {
            await client.stop();
            if (running.v2) await v2Runtime.shutdown(100);
            if (running.observer) await running.observer.shutdown(100);
            await h.catalog.close();
        }
    });
});
