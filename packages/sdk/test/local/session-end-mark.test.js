/**
 * G1 residual: a done or cancel is marked on its session (session.end_requested) only when the command is sent. A refused
 * command marks nothing: a system session (SYSTEM_SESSION_PROTECTED), a chat with an active Workflow (R4, 409), and a
 * session with no live orchestration (nothing could be queued). A session whose orchestration runs gets the mark before
 * its command. (A reader of a shared session is refused by the portal's session:manage gate before the management client
 * is called: workflow-chat-definitions-runtime and the session route tests.)
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";

const { Runtime, Client, PostgresProvider } = (await import("node:module")).createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: `end-mark-${randomUUID()}` };
const HOLD = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: hold, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

/** An orchestration that reads its queue and never ends (a session whose turn is still running). */
function* listening(ctx) {
    for (;;) yield ctx.dequeueEvent("messages");
}

/** A session that ends at the first end command it reads (as a session orchestration ends at done or cancel). */
function* endsAtCommand(ctx) {
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        const message = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (message?.type === "cmd" && (message.cmd === "done" || message.cmd === "cancel")) return message.cmd;
    }
}

describe("an end's mark is recorded only when its command is sent (G1 residual)", () => {
    it("a refused complete or cancel marks nothing; a live session is marked before its command", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        runtime.registerOrchestrationVersioned("end-mark-listener", "1.0.0", listening);
        await runtime.start();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await mgmt.start();
        const marks = async sessionId => (await catalog.getSessionEvents(sessionId, 0, 100, ["session.end_requested"])).map(event => event.data);
        try {
            // A system session: refused, no mark.
            const system = randomUUID();
            await catalog.createSession(system, { isSystem: true });
            await expect(mgmt.completeSession(system, "no", { wait: false })).rejects.toMatchObject({ code: "SYSTEM_SESSION_PROTECTED" });
            await expect(mgmt.cancelSession(system, "no")).rejects.toMatchObject({ code: "SYSTEM_SESSION_PROTECTED" });
            expect(await marks(system)).toEqual([]);

            // A chat with an active Workflow (R4): its completion is refused, no mark.
            const chat = randomUUID();
            await catalog.createSession(chat, { owner: OWNER });
            const host = { catalog, store: catalog.workflowStore(), duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }),
                enqueueEvent: async () => {} } };
            const created = await createWorkflowV2(host, { workflowSessionId: randomUUID(), parentSessionId: chat, owner: OWNER, yaml: HOLD,
                actor: { kind: "system", name: "end-mark-test" }, operationId: "start", start: { inputs: {} } });
            expect(created.receipt.valid).toBe(true);
            await expect(mgmt.completeSession(chat, "no", { wait: false })).rejects.toMatchObject({ status: 409 });
            expect(await marks(chat)).toEqual([]);

            // No live orchestration: nothing can be queued, no mark.
            const idle = randomUUID();
            await catalog.createSession(idle, { owner: OWNER });
            await expect(mgmt.completeSession(idle, "no", { wait: false })).rejects.toThrow(/is not started/);
            expect(await marks(idle)).toEqual([]);

            // A live session: marked, then its command queued.
            const live = randomUUID();
            await catalog.createSession(live, { owner: OWNER });
            await client.startOrchestrationVersioned(`session-${live}`, "end-mark-listener", {}, "1.0.0");
            for (let waited = 0; waited < 10_000 && (await client.getStatus(`session-${live}`)).status !== "Running"; waited += 50) await new Promise(r => setTimeout(r, 50));
            await mgmt.completeSession(live, "done by a person", { wait: false });
            expect(await marks(live)).toEqual([expect.objectContaining({ cmd: "done", id: expect.any(String) })]);
        } finally {
            await mgmt.stop();
            await runtime.shutdown(100);
            await catalog.close();
        }
    });

    // Review DRR-2, condition 3: the person's done or cancel records its mark, and a Workflow that acts on that mark carries
    // the end itself; when the carried end lands first, the person's own command meets an ended session. That is success:
    // the call resolves (duroxide queues to an ended instance without an error, and the live check refuses only a session
    // that never started), and the session stays ended.
    it("a person's done or cancel whose session the Workflow's carried end ended first, between the mark and the send, succeeds", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        runtime.registerOrchestrationVersioned("end-mark-ender", "1.0.0", endsAtCommand);
        await runtime.start();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await mgmt.start();
        const settle = async (instanceId, statuses) => {
            for (let waited = 0; waited < 20_000; waited += 50) {
                const status = (await client.getStatus(instanceId)).status;
                if (statuses.includes(status)) return status;
                await new Promise(r => setTimeout(r, 50));
            }
            return (await client.getStatus(instanceId)).status;
        };
        const record = mgmt._catalog.recordEvents;
        try {
            for (const [verb, call] of [
                ["done", (id) => mgmt.completeSession(id, "done by a person", { wait: false })],
                ["cancel", (id) => mgmt.cancelSession(id, "cancelled by a person")],
            ]) {
                const id = randomUUID();
                await catalog.createSession(id, { owner: OWNER });
                await client.startOrchestrationVersioned(`session-${id}`, "end-mark-ender", {}, "1.0.0");
                expect(await settle(`session-${id}`, ["Running"])).toBe("Running");
                // Right after the mark is recorded, the Workflow's carried end lands and the session ends.
                mgmt._catalog.recordEvents = async (sessionId, events, ...rest) => {
                    await record.call(mgmt._catalog, sessionId, events, ...rest);
                    if (sessionId === id && events.some(event => event.eventType === "session.end_requested")) {
                        await client.enqueueEvent(`session-${id}`, "messages", JSON.stringify({ type: "cmd", cmd: verb, id: `workflow-mark-end:${verb}` }));
                        expect(await settle(`session-${id}`, ["Completed"]), verb).toBe("Completed");
                        // As a session orchestration records its own end in the catalog.
                        await catalog.updateSession(id, { state: verb === "done" ? "completed" : "cancelled" });
                    }
                };
                await expect(call(id), verb).resolves.toBeUndefined();
                mgmt._catalog.recordEvents = record;
                expect((await client.getStatus(`session-${id}`)).status, verb).toBe("Completed");
            }
        } finally {
            mgmt._catalog.recordEvents = record;
            await mgmt.stop();
            await runtime.shutdown(100);
            await catalog.close();
        }
    });
});
