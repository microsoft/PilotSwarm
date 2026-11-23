/**
 * Issue 329: a Copilot runtime that dies mid-turn is never reused.
 *
 * One worker, a session with no workspace, the real Copilot CLI and the
 * scripted model. The second turn holds its model request while the test
 * SIGKILLs the runtime child, as an OOM kill would. The turn must settle
 * within seconds (not at the 300 s inactivity watchdog), the dead client and
 * warm session must leave the pools, and the orchestration's connection-closed
 * retry must answer on a fresh runtime from the last committed snapshot,
 * without a lossy hand-off.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const WAIT = 120_000;
/** Well under the 300 s turn inactivity watchdog that settled such turns before the fix. */
const SETTLE_BUDGET_MS = 30_000;

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

afterEach(() => { vi.restoreAllMocks(); });

async function waitForAssistant(catalog, sessionId, pattern, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const events = await catalog.getSessionEvents(sessionId);
        const hit = events.find((e) => e.eventType === "assistant.message" && pattern.test(String(e.data?.content ?? "")));
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`no assistant message matching ${pattern} within ${timeoutMs}ms`);
}

describe("issue 329: a dead Copilot runtime is not reused", () => {
    it("a runtime SIGKILLed mid-turn settles promptly and the retry resumes on a fresh runtime without a lossy hand-off", { timeout: TIMEOUT }, async () => {
        const hold = { started: deferred(), released: deferred(), held: 0 };
        const warnings = [];
        const warn = console.warn;
        vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.map(String).join(" ")); warn(...args); });

        await withScriptedModel(getEnv(), {
            respond: async (_body, position) => {
                const tag = position.lastUserText.match(/RTL-[A-Z]+/)?.[0] ?? "?";
                if (tag === "RTL-HOLD" && position.step === 0 && hold.held++ === 0) {
                    hold.started.resolve();
                    await hold.released.promise;
                    return { content: "answer from the killed runtime" };
                }
                return { content: `answered ${tag}` };
            },
        }, async ({ client, worker, model, qualifiedModel }) => {
            const catalog = await createCatalog(getEnv());
            try {
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel });
                expect(await session.sendAndWait("RTL-HELLO committed first turn", WAIT)).toContain("answered RTL-HELLO");

                const manager = worker.sessionManager;
                // One worker, one transport: the session runs on the only pooled client.
                const pooled = [...new Set(manager.clients.values())];
                expect(pooled).toHaveLength(1);
                const [oldClient] = pooled;
                const oldManaged = manager.sessions.get(sessionId);
                const oldPid = manager.runtimeMonitor.pid(oldClient);
                expect(oldManaged).toBeTruthy();
                expect(oldPid).toBeGreaterThan(0);

                await session.send("RTL-HOLD second turn");
                await hold.started.promise;
                const killedAt = Date.now();
                process.kill(oldPid, "SIGKILL");

                const [unpublished] = await waitForEventCount(catalog, sessionId, "session.snapshot_unpublished", 1, SETTLE_BUDGET_MS);
                const settleMs = Date.now() - killedAt;
                console.log(`  turn settled ${settleMs}ms after the runtime kill`);
                expect(settleMs).toBeLessThan(SETTLE_BUDGET_MS);
                expect(unpublished.data).toMatchObject({ reason: "transport_loss", modelMemoryCommitted: false, resultType: "error" });
                hold.released.resolve();

                // The dead client and its warm session left the pools as soon as the runtime exited.
                expect([...manager.clients.values()]).not.toContain(oldClient);
                expect(manager.sessions.get(sessionId)).not.toBe(oldManaged);
                const exitLog = warnings.find((line) => line.includes("Copilot runtime") && line.includes(`pid ${oldPid}`));
                expect(exitLog).toMatch(/after startup/);
                expect(exitLog).toMatch(/code \S+, signal \S+/);
                if (process.platform !== "win32") expect(exitLog).toMatch(/signal SIGKILL/);

                // The connection-closed retry answers on a fresh runtime.
                await waitForAssistant(catalog, sessionId, /answered RTL-HOLD/, WAIT);
                const fresh = [...new Set(manager.clients.values())];
                expect(fresh).toHaveLength(1);
                const [newClient] = fresh;
                expect(newClient).not.toBe(oldClient);
                const newPid = manager.runtimeMonitor.pid(newClient);
                expect(newPid).toBeGreaterThan(0);
                expect(newPid).not.toBe(oldPid);

                // It resumed the committed first turn, without the torn second turn and without a lossy hand-off.
                const events = await catalog.getSessionEvents(sessionId);
                expect(events.filter((e) => e.eventType === "session.lossy_handoff")).toEqual([]);
                const retried = model.sessionRequests("RTL-HELLO").filter((r) => r.position.lastUserText.includes("RTL-HOLD"));
                expect(retried.length).toBeGreaterThanOrEqual(2);
                const users = retried.at(-1).body.messages.filter((m) => m.role === "user").map(messageText);
                expect(users.some((text) => text.includes("RTL-HELLO"))).toBe(true);
                expect(users.filter((text) => text.includes("RTL-HOLD"))).toHaveLength(1);
                expect(retried.at(-1).body.messages.some((m) => m.role === "assistant" && messageText(m).includes("answer from the killed runtime"))).toBe(false);
            } finally {
                hold.released.resolve();
                await catalog.close();
            }
        });
    });
});
