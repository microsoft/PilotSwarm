/**
 * Issue 331: idle pooled Copilot runtimes stop, and session teardown ends tool shells.
 *
 * One worker, sessions with no workspace, the real Copilot CLI and the scripted
 * model. After the worker's eviction sweep reclaims the session, its pooled
 * runtime has no sessions and no leases; after the idle period it leaves the pool
 * and stops. The next turn starts a fresh runtime and resumes from the committed
 * snapshot. Separately, an eviction, a dehydrate (still run by frozen
 * orchestration versions), a worker shutdown or a cancel ends the session's
 * background shells, including a daemon the shell left behind, which
 * client.stop() never reaches.
 *
 * The sweep is called directly with a 1 ms age, as the worker's eviction clock
 * calls it; the live orchestration's hold window only rotates affinity and never
 * drops the warm session itself.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { waitFor } from "../helpers/stop-turn-readiness.mjs";
import { processAlive, readProcess } from "../../src/process-tree.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const WAIT = 120_000;

afterEach(() => { vi.restoreAllMocks(); });

const pooledClients = (manager) => [...new Set(manager.clients.values())];
/** A process that still runs: present and not a zombie (an exited child waiting to be reaped runs nothing). */
const processRuns = (pid) => processAlive(pid) && readProcess(pid)?.zombie !== true;

/** Reclaims the session through the worker's eviction sweep, once its turn has released the session lock. */
async function evict(manager, sessionId) {
    return waitFor(async () => {
        await manager.sweepIdleSessions(1);
        return !manager.sessions.has(sessionId);
    }, 30_000, 100);
}

/** True when `file` stopped growing over 1.5 s. */
async function stoppedWriting(file) {
    const before = fs.statSync(file).size;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return fs.statSync(file).size === before;
}

describe("issue 331: idle Copilot runtimes stop and teardown ends tool shells", () => {
    it("an idle pooled runtime stops, and the next turn resumes on a fresh runtime", { timeout: TIMEOUT }, async () => {
        await withScriptedModel(getEnv(), {
            respond: (_body, position) => ({ content: `answered ${position.lastUserText.match(/IDL-[A-Z]+/)?.[0] ?? "?"}` }),
            worker: { copilotClientIdleStopMs: 500 },
        }, async ({ client, worker, model, qualifiedModel }) => {
            const catalog = await createCatalog(getEnv());
            try {
                const manager = worker.sessionManager;
                const sessionId = randomUUID();
                const session = await client.createSession({ sessionId, model: qualifiedModel });
                expect(await session.sendAndWait("IDL-FIRST committed turn", WAIT)).toContain("answered IDL-FIRST");
                const pooled = pooledClients(manager);
                expect(pooled).toHaveLength(1);
                const [oldClient] = pooled;
                const oldPid = manager.runtimeMonitor.pid(oldClient);
                expect(oldPid).toBeGreaterThan(0);
                expect(processRuns(oldPid)).toBe(true);
                const stop = vi.spyOn(oldClient, "stop");

                expect(await evict(manager, sessionId)).toBe(true);
                expect(await waitFor(() => manager.clients.size === 0, 30_000, 100)).toBe(true);
                expect(await waitFor(() => stop.mock.calls.length > 0, 30_000, 100)).toBe(true);
                expect(stop).toHaveBeenCalledTimes(1);
                // The stop ends the old runtime's process, not only its pool entry.
                expect(await waitFor(() => !processRuns(oldPid), 30_000, 100)).toBe(true);

                // The next turn starts a fresh runtime for the same key and resumes the snapshot.
                expect(await session.sendAndWait("IDL-SECOND after the stop", WAIT)).toContain("answered IDL-SECOND");
                const fresh = pooledClients(manager);
                expect(fresh).toHaveLength(1);
                expect(fresh[0]).not.toBe(oldClient);
                const second = model.sessionRequests("IDL-FIRST").filter((r) => r.position.lastUserText.includes("IDL-SECOND"));
                expect(second.length).toBeGreaterThanOrEqual(1);
                const users = second.at(-1).body.messages.filter((m) => m.role === "user").map(messageText);
                expect(users.some((text) => text.includes("IDL-FIRST"))).toBe(true);
                const events = await catalog.getSessionEvents(sessionId);
                expect(events.filter((e) => e.eventType === "session.lossy_handoff")).toEqual([]);

                // A new session on the restarted key runs on the fresh runtime too.
                const other = await client.createSession({ model: qualifiedModel });
                expect(await other.sendAndWait("IDL-OTHER new session", WAIT)).toContain("answered IDL-OTHER");
                expect(pooledClients(manager)).toEqual(fresh);
            } finally {
                await catalog.close();
            }
        });
    });

    // Tool shells run in their own session (setsid); POSIX process groups and sessions are not on Windows.
    describe.skipIf(process.platform === "win32")("background shells of a session with no workspace", () => {
        /**
         * The turn starts a detached shell that writes `heartbeat` and leaves a re-parented daemon writing `daemon`.
         * Both loops run only while their folder exists, so removing it ends them even when the teardown under
         * test fails to.
         */
        const startShells = (heartbeat, daemon) => (_body, position) => {
            if (!position.lastUserText.includes("start the shells")) return { content: "ok" };
            if (position.step > 0) return { content: "started" };
            const dir = path.dirname(heartbeat);
            const command = `( while [ -d '${dir}' ]; do date +%s >> '${daemon}'; sleep 0.2; done & ) ; `
                + `while [ -d '${dir}' ]; do date +%s >> '${heartbeat}'; sleep 0.2; done`;
            return { tools: [{ name: "bash", args: { command, description: "heartbeat", mode: "async", detach: true } }] };
        };

        async function withShellFiles(prefix, run) {
            const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
            try {
                await run(path.join(dir, "heartbeat.txt"), path.join(dir, "daemon.txt"));
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }

        async function startAndCheck(client, qualifiedModel, heartbeat, daemon) {
            const sessionId = randomUUID();
            const session = await client.createSession({ sessionId, model: qualifiedModel });
            expect(await session.sendAndWait("start the shells", WAIT)).toBe("started");
            expect(await waitFor(() => fs.existsSync(heartbeat) && fs.existsSync(daemon), 10_000, 100)).toBe(true);
            expect(await stoppedWriting(heartbeat)).toBe(false);
            expect(await stoppedWriting(daemon)).toBe(false);
            return sessionId;
        }

        it.each([
            ["an eviction", 1, (manager, sessionId) => evict(manager, sessionId)],
            ["a dehydrate", 1, async (manager, sessionId) => {
                await manager.dehydrate(sessionId, "issue-331-test");
                return !manager.sessions.has(sessionId);
            }],
            // A shutdown lists the shells, stops the runtime (which does not end them), then kills them.
            ["a worker shutdown", 0, async (manager, sessionId) => {
                await manager.shutdown();
                return !manager.sessions.has(sessionId);
            }],
        ])("%s ends the shell and the daemon it left behind", { timeout: TIMEOUT }, async (_label, poolAfter, tearDown) => {
            await withShellFiles("ps-idle-teardown-", async (heartbeat, daemon) => {
                await withScriptedModel(getEnv(), {
                    respond: startShells(heartbeat, daemon),
                    worker: { copilotClientIdleStopMs: 0 },
                }, async ({ client, worker, qualifiedModel }) => {
                    const manager = worker.sessionManager;
                    const sessionId = await startAndCheck(client, qualifiedModel, heartbeat, daemon);
                    expect(await tearDown(manager, sessionId)).toBe(true);
                    // The idle stop is off: only the teardown's own shell cancel or kill can stop them.
                    expect(manager.clients.size).toBe(poolAfter);
                    expect(await stoppedWriting(heartbeat)).toBe(true);
                    expect(await stoppedWriting(daemon)).toBe(true);
                });
            });
        });

        it("a cancel ends the shell and the daemon it left behind", { timeout: TIMEOUT }, async () => {
            await withShellFiles("ps-idle-cancel-", async (heartbeat, daemon) => {
                await withScriptedModel(getEnv(), {
                    respond: startShells(heartbeat, daemon),
                    worker: { copilotClientIdleStopMs: 0 },
                }, async ({ client, qualifiedModel }) => {
                    const mgmt = await createManagementClient(getEnv());
                    try {
                        const sessionId = await startAndCheck(client, qualifiedModel, heartbeat, daemon);
                        await mgmt.cancelSession(sessionId, "not needed");
                        expect(await waitFor(async () => (await stoppedWriting(heartbeat)) && (await stoppedWriting(daemon)), 30_000, 100)).toBe(true);
                    } finally {
                        await mgmt.stop();
                    }
                });
            });
        });
    });
});
