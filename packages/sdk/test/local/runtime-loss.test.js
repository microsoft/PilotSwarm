/**
 * Issue 329: a Copilot runtime that dies is never reused.
 *
 * One worker, the real Copilot CLI and the scripted model. A turn holds its
 * model request while the test SIGKILLs the runtime child, as an OOM kill
 * would. The test finds that child through the operating system's process
 * table (kill-harness.js), not through PilotSwarm, so the same kill runs on
 * every revision. Every wait on the outcome has its own bound, well under the
 * 300 s turn inactivity watchdog that settled such turns before the fix, so a
 * revision without the fix fails on the hang itself.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { copilotRuntimeChildPids } from "../helpers/kill-harness.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { WORKFLOW_PARENT_CONTEXT_UNAVAILABLE } from "../../src/workflow/tool-policy.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const WAIT = 120_000;
/** Well under the 300 s turn inactivity watchdog that settled such turns before the fix. */
const SETTLE_BUDGET_MS = 30_000;
/** COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS: the orchestration's wait before it retries the turn. */
const RETRY_DELAY_MS = 15_000;

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

afterEach(() => { vi.restoreAllMocks(); });

/** `promise`, or a rejection with `message` after `ms`. */
function within(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Poll `read` until it returns a truthy value; fail with `message` after `ms`. */
async function until(read, ms, message) {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() >= deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/** The Copilot runtimes this test process started since `before`, as the OS lists them. */
function runtimesSince(before) {
    return copilotRuntimeChildPids().filter((pid) => !before.includes(pid));
}

/** The orchestration's own view of the loss: its connection-closed retry status for the failed attempt. */
function recoverableLoss(mgmt, sessionId) {
    return async () => {
        const { customStatus } = await mgmt.getSessionStatus(sessionId);
        return customStatus?.status === "error" && customStatus.recoverableTransportLoss === true ? customStatus : null;
    };
}

function holdingResponder(holdTag, hold) {
    return async (_body, position) => {
        const tag = position.lastUserText.match(/RTL-[A-Z0-9]+/)?.[0] ?? "?";
        if (tag === holdTag && position.step === 0) {
            hold.requests.push(Date.now());
            if (hold.requests.length === 1) {
                hold.started.resolve();
                await hold.released.promise;
                return { content: "answer from the killed runtime" };
            }
        }
        return { content: `answered ${tag}` };
    };
}

const eventsOf = (events, type) => events.filter((e) => e.eventType === type);

describe("issue 329: a dead Copilot runtime is not reused", () => {
    it("a runtime SIGKILLed mid-turn settles promptly and the retry resumes on a fresh runtime without a lossy hand-off", { timeout: TIMEOUT }, async () => {
        const hold = { started: deferred(), released: deferred(), requests: [] };
        const warnings = [];
        const warn = console.warn;
        vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.map(String).join(" ")); warn(...args); });

        await withScriptedModel(getEnv(), { respond: holdingResponder("RTL-HOLD", hold) }, async ({ client, worker, model, qualifiedModel }) => {
            const catalog = await createCatalog(getEnv());
            const mgmt = await createManagementClient(getEnv());
            try {
                const before = copilotRuntimeChildPids();
                const store = worker.sessionStore;
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel });
                expect(await session.sendAndWait("RTL-HELLO committed first turn", WAIT)).toBe("answered RTL-HELLO");
                expect((await store.probeSnapshot(sessionId)).version).toBe(1);

                const manager = worker.sessionManager;
                // One worker, one transport: the session runs on the only pooled client and its one runtime.
                const pooled = [...new Set(manager.clients.values())];
                expect(pooled).toHaveLength(1);
                const [oldClient] = pooled;
                const oldManaged = manager.sessions.get(sessionId);
                expect(oldManaged).toBeTruthy();
                const started = runtimesSince(before);
                expect(started).toHaveLength(1);
                const [oldPid] = started;
                const monitoredOldPid = manager.runtimeMonitor?.pid?.(oldClient);

                await session.send("RTL-HOLD second turn");
                await within(hold.started.promise, WAIT, `the held model request did not arrive within ${WAIT}ms`);
                const killedAt = Date.now();
                process.kill(oldPid, "SIGKILL");

                // The failed attempt settles, and the orchestration classifies it as a recoverable transport loss.
                const lost = await until(recoverableLoss(mgmt, sessionId), SETTLE_BUDGET_MS,
                    `the orchestration did not observe the runtime loss within ${SETTLE_BUDGET_MS}ms of the kill`);
                const settleMs = Date.now() - killedAt;
                console.log(`  the orchestration saw the loss ${settleMs}ms after the runtime kill`);
                expect(lost.error).toMatch(/Copilot runtime exited \(pid \d+, code \S+, signal \S+\) during the turn: Connection is closed\./);
                hold.released.resolve();
                // Nothing was committed for the failed attempt.
                expect((await store.probeSnapshot(sessionId)).version).toBe(1);
                const [unpublished, ...more] = eventsOf(await catalog.getSessionEvents(sessionId), "session.snapshot_unpublished");
                expect(more).toEqual([]);
                expect(unpublished?.data).toMatchObject({ reason: "transport_loss", modelMemoryCommitted: false, resultType: "error" });

                // The dead client and its warm session left the pools as soon as the runtime exited.
                expect([...manager.clients.values()]).not.toContain(oldClient);
                expect(manager.sessions.get(sessionId)).not.toBe(oldManaged);
                const exitLog = warnings.find((line) => line.includes("Copilot runtime") && line.includes(`pid ${oldPid}`));
                expect(exitLog).toMatch(/after startup/);
                expect(exitLog).toMatch(/code \S+, signal \S+/);
                if (process.platform !== "win32") expect(exitLog).toMatch(/signal SIGKILL/);

                // The connection-closed retry asks the model again, promptly, and its result is durable.
                expect(await session.wait(WAIT)).toBe("answered RTL-HOLD");
                expect(hold.requests).toHaveLength(2);
                expect(hold.requests[1] - killedAt).toBeLessThan(SETTLE_BUDGET_MS + RETRY_DELAY_MS);
                expect((await store.probeSnapshot(sessionId)).version).toBe(2);

                // It ran on a fresh runtime.
                const fresh = [...new Set(manager.clients.values())];
                expect(fresh).toHaveLength(1);
                const [newClient] = fresh;
                expect(newClient).not.toBe(oldClient);
                const restarted = runtimesSince(before);
                expect(restarted).toHaveLength(1);
                expect(restarted[0]).not.toBe(oldPid);

                // It resumed the committed first turn, without the torn second turn and without a lossy hand-off.
                expect(eventsOf(await catalog.getSessionEvents(sessionId), "session.lossy_handoff")).toEqual([]);
                const retried = model.sessionRequests("RTL-HELLO").filter((r) => r.position.lastUserText.includes("RTL-HOLD"));
                expect(retried).toHaveLength(2);
                const users = retried[1].body.messages.filter((m) => m.role === "user").map(messageText);
                expect(users.some((text) => text.includes("RTL-HELLO"))).toBe(true);
                expect(users.filter((text) => text.includes("RTL-HOLD"))).toHaveLength(1);
                expect(retried[1].body.messages.some((m) => m.role === "assistant" && messageText(m).includes("answered RTL-HELLO"))).toBe(true);
                expect(retried[1].body.messages.some((m) => m.role === "assistant" && messageText(m).includes("answer from the killed runtime"))).toBe(false);

                // Last, the binding the fix relies on: the monitor named the runtimes the OS reports.
                expect(monitoredOldPid).toBe(oldPid);
                expect(manager.runtimeMonitor.pid(newClient)).toBe(restarted[0]);
            } finally {
                hold.released.resolve();
                await mgmt.stop();
                await catalog.close();
            }
        });
    });

    // Review S10: B's turn observes the loss itself, so it does not exercise the warm sessions that sat idle on the
    // same runtime. One kill covers both kinds of idle co-tenant: A's next turn (SessionManager.getOrCreate) and C's
    // direct tool capture. Not covered: two turns in flight on the one runtime at the kill.
    it("an idle co-tenant of the killed runtime resumes on a fresh runtime with its history, and an idle sibling's capture reports its parent unavailable", { timeout: TIMEOUT }, async () => {
        const hold = { started: deferred(), released: deferred(), requests: [] };
        const warnings = [];
        const warn = console.warn;
        vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.map(String).join(" ")); warn(...args); });

        await withScriptedModel(getEnv(), { respond: holdingResponder("RTL-B2", hold) }, async ({ client, worker, model, qualifiedModel }) => {
            const catalog = await createCatalog(getEnv());
            const mgmt = await createManagementClient(getEnv());
            try {
                const before = copilotRuntimeChildPids();
                const store = worker.sessionStore;
                const manager = worker.sessionManager;
                const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
                const sessions = {};
                for (const [name, sessionId] of Object.entries(ids)) {
                    sessions[name] = await client.createSession({ sessionId, model: qualifiedModel });
                    expect(await sessions[name].sendAndWait(`RTL-${name}1 first turn`, WAIT)).toBe(`answered RTL-${name}1`);
                }
                expect([...new Set(manager.clients.values())]).toHaveLength(1);
                const started = runtimesSince(before);
                expect(started).toHaveLength(1);
                const [oldPid] = started;
                const warmA = manager.sessions.get(ids.A);
                const warmC = manager.sessions.get(ids.C);
                expect(warmA).toBeTruthy();
                expect(warmC).toBeTruthy();

                await sessions.B.send("RTL-B2 held turn");
                await within(hold.started.promise, WAIT, `B's held model request did not arrive within ${WAIT}ms`);
                process.kill(oldPid, "SIGKILL");
                await until(recoverableLoss(mgmt, ids.B), SETTLE_BUDGET_MS,
                    `the orchestration did not observe B's runtime loss within ${SETTLE_BUDGET_MS}ms of the kill`);
                hold.released.resolve();

                // A and C sat idle on the runtime that died: their warm handles are still pooled, and marked lost.
                await until(() => warmA.runtimeLost === true && warmC.runtimeLost === true, SETTLE_BUDGET_MS,
                    "the idle co-tenants were not marked as on a lost runtime");
                expect(manager.sessions.get(ids.A)).toBe(warmA);
                expect(manager.sessions.get(ids.C)).toBe(warmC);

                // C: a direct capture refuses the dead parent rather than calling its closed connection.
                await expect(manager.captureWorkflowToolBinding(ids.C, true)).rejects.toMatchObject({ code: WORKFLOW_PARENT_CONTEXT_UNAVAILABLE });

                // A: the next turn drops the dead handle and resumes on a fresh runtime, with its committed history.
                expect(await within(sessions.A.sendAndWait("RTL-A2 second turn", WAIT), WAIT + 5_000,
                    "A's turn after the kill did not answer")).toBe("answered RTL-A2");
                expect(warnings.some((line) => line.includes(`the Copilot runtime of warm session ${ids.A} exited`))).toBe(true);
                const resumedA = manager.sessions.get(ids.A);
                expect(resumedA).toBeTruthy();
                expect(resumedA).not.toBe(warmA);
                expect(resumedA.runtimeLost).toBe(false);
                const eventsA = await catalog.getSessionEvents(ids.A);
                expect(eventsOf(eventsA, "session.snapshot_unpublished")).toEqual([]);
                expect(eventsOf(eventsA, "session.lossy_handoff")).toEqual([]);
                expect((await store.probeSnapshot(ids.A)).version).toBe(2);
                const requestsA = model.sessionRequests("RTL-A1").filter((r) => r.position.lastUserText.includes("RTL-A2"));
                expect(requestsA).toHaveLength(1);
                const historyA = requestsA[0].body.messages;
                expect(historyA.some((m) => m.role === "user" && messageText(m).includes("RTL-A1"))).toBe(true);
                expect(historyA.some((m) => m.role === "assistant" && messageText(m).includes("answered RTL-A1"))).toBe(true);
                const restarted = runtimesSince(before);
                expect(restarted).toHaveLength(1);
                expect(restarted[0]).not.toBe(oldPid);

                // B: its own retry answers on the fresh runtime, without a lossy hand-off.
                expect(await sessions.B.wait(WAIT)).toBe("answered RTL-B2");
                expect(eventsOf(await catalog.getSessionEvents(ids.B), "session.lossy_handoff")).toEqual([]);
                expect((await store.probeSnapshot(ids.B)).version).toBe(2);
                expect(runtimesSince(before)).toEqual(restarted);
            } finally {
                hold.released.resolve();
                await mgmt.stop();
                await catalog.close();
            }
        });
    });
});
