import { describe, it, expect } from "vitest";
import { CopilotSession } from "@github/copilot-sdk";
import { ManagedSession } from "../../src/managed-session.js";
import { SessionManager } from "../../src/session-manager.js";
import { stopTurnQueueName } from "../../src/types.js";

/**
 * Stop-turn (docs/proposals-impl/stop-button-turn-abort-plan.md) — deterministic
 * unit/integration coverage of the worker-local interrupt path:
 *
 *  - ManagedSession stop marker: requestStop/abort classifies the unwind as
 *    { type: "stopped" }, never completed/error; forceSettleTurn escalation
 *    unwinds a turn whose SDK never fires session.idle.
 *  - SessionManager.abortWarmSessionTurn: lock-bypassing primitive with
 *    no_active_turn / wrong-turn guards and the stop_forced escalation.
 *  - The management client's stopSessionTurn is covered in
 *    stop-turn-management.test.js; the orchestration race normalizer in
 *    stop-turn-race-legacy.test.js.
 *  - Copilot SDK abort primitive contract (session.abort RPC shape).
 *
 * No live LLM, database, or duroxide runtime required.
 */

// ─── Fakes ───────────────────────────────────────────────────────

function createFakeCopilotSession({ abortFiresIdle = true } = {}) {
    const handlers = [];
    const emit = (type, data = {}) => {
        for (const h of [...handlers]) {
            if (h.type === null) h.fn({ type, data });
            else if (h.type === type) h.fn({ type, data });
        }
    };
    const fake = {
        sent: [],
        abortCalls: 0,
        disconnectCalls: 0,
        registerTools() {},
        on(a, b) {
            const h = typeof a === "function" ? { type: null, fn: a } : { type: a, fn: b };
            handlers.push(h);
            return () => {
                const i = handlers.indexOf(h);
                if (i >= 0) handlers.splice(i, 1);
            };
        },
        async send(msg) {
            fake.sent.push(msg);
        },
        abort() {
            fake.abortCalls++;
            if (abortFiresIdle) setTimeout(() => emit("session.idle"), 5);
        },
        async disconnect() {
            fake.disconnectCalls++;
        },
        getMessages() {
            return [];
        },
        _emit: emit,
    };
    return fake;
}

function createManagedSession(fakeCopilot, config = {}) {
    return new ManagedSession("stop-turn-test-session", fakeCopilot, { waitThreshold: 30, ...config });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2_000, stepMs = 10) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(stepMs);
    }
    return predicate();
}

// ─── ManagedSession stop classification ──────────────────────────

describe("ManagedSession stop classification", () => {
    it("classifies an aborted turn as stopped, not completed", async () => {
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);

        const turnPromise = managed.runTurn("long prompt", { turnIndex: 7 });
        await waitFor(() => managed.getActiveTurn() != null);
        expect(managed.getActiveTurn().turnIndex).toBe(7);

        // Marker first, then abort — mirrors abortWarmSessionTurn ordering.
        const stopped = managed.requestStop("Stopped by user");
        expect(stopped).toEqual({ turnIndex: 7 });
        managed.abort();

        const result = await turnPromise;
        expect(result.type).toBe("stopped");
        expect(result.reason).toBe("Stopped by user");
        // Without the stop marker this unwind would have been
        // { type: "completed", content: "(no response)" } — the whole reason
        // the marker exists (verified fact 6 in the plan).
        expect(managed.getActiveTurn()).toBeNull();
    });

    it("unmarked aborts still unwind as completed (wait/ask_user contract preserved)", async () => {
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);

        const turnPromise = managed.runTurn("prompt", { turnIndex: 1 });
        await waitFor(() => managed.getActiveTurn() != null);
        managed.abort(); // no requestStop — e.g. a control-tool abort

        const result = await turnPromise;
        expect(result.type).toBe("completed");
    });

    it("requestStop returns null when no turn is in flight", () => {
        const managed = createManagedSession(createFakeCopilotSession());
        expect(managed.requestStop("late click")).toBeNull();
        expect(managed.getActiveTurn()).toBeNull();
    });

    it("forceSettleTurn unwinds a turn whose SDK never fires session.idle", async () => {
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);

        const turnPromise = managed.runTurn("hung prompt", { turnIndex: 3 });
        await waitFor(() => managed.getActiveTurn() != null);

        managed.requestStop("Stopped by user");
        managed.abort(); // does nothing — the fake never fires idle
        await sleep(50);
        expect(managed.getActiveTurn()).not.toBeNull();

        expect(managed.forceSettleTurn("Stopped by user")).toBe(true);
        const result = await turnPromise;
        expect(result.type).toBe("stopped");
        expect(managed.getActiveTurn()).toBeNull();
    });
});

// ─── SessionManager.abortWarmSessionTurn ─────────────────────────

function createBareSessionManager() {
    // Bypass the full constructor: abortWarmSessionTurn only reads the warm
    // map and (on escalation) calls invalidateWarmSession.
    const manager = Object.create(SessionManager.prototype);
    manager.sessions = new Map();
    manager.invalidateWarmSessionCalls = [];
    manager.invalidateWarmSession = async (sessionId) => {
        manager.invalidateWarmSessionCalls.push(sessionId);
        manager.sessions.delete(sessionId);
    };
    return manager;
}

describe("SessionManager.abortWarmSessionTurn", () => {
    it("returns no_active_turn when the session is not warm", async () => {
        const manager = createBareSessionManager();
        const result = await manager.abortWarmSessionTurn("missing", { reason: "user" });
        expect(result.outcome).toBe("no_active_turn");
    });

    it("returns no_active_turn when the warm session has no turn in flight", async () => {
        const manager = createBareSessionManager();
        const managed = createManagedSession(createFakeCopilotSession());
        manager.sessions.set(managed.sessionId, managed);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, { reason: "user" });
        expect(result.outcome).toBe("no_active_turn");
    });

    it("guards against stopping the wrong turn (expectedTurnIndex mismatch)", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("prompt", { turnIndex: 5 });
        await waitFor(() => managed.getActiveTurn() != null);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "user",
            expectedTurnIndex: 4, // stale — a previous turn
        });
        expect(result.outcome).toBe("no_active_turn");
        expect(result.turnIndex).toBe(5);
        expect(copilot.abortCalls).toBe(0); // the newer turn was untouched

        managed.abort();
        const turnResult = await turnPromise;
        expect(turnResult.type).toBe("completed"); // wrong-turn stop never marked it
    });

    it("aborts a matching in-flight turn mid-flight and reports stopped", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("prompt", { turnIndex: 2 });
        await waitFor(() => managed.getActiveTurn() != null);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user",
            expectedTurnIndex: 2,
        });
        expect(result.outcome).toBe("stopped");
        expect(result.turnIndex).toBe(2);
        expect(copilot.abortCalls).toBe(1);

        const turnResult = await turnPromise;
        expect(turnResult.type).toBe("stopped");
    });

    it("escalates to stop_forced when the SDK never unwinds, and invalidates the warm session", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("hung prompt", { turnIndex: 9 });
        await waitFor(() => managed.getActiveTurn() != null);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user",
            expectedTurnIndex: 9,
            unwindGraceMs: 100, // keep the test fast
        });
        expect(result.outcome).toBe("stop_forced");

        const turnResult = await turnPromise;
        expect(turnResult.type).toBe("stopped");
        await waitFor(() => manager.invalidateWarmSessionCalls.length > 0);
        expect(manager.invalidateWarmSessionCalls).toContain(managed.sessionId);
    });

    // Session turn control (V4 Stop): the turn's background tasks are
    // cancelled right after the abort, before the unwind wait.
    function withTaskList(copilot, tasks, { endTurnOnCancel = null } = {}) {
        const cancelled = [];
        copilot.rpc = {
            tasks: {
                list: async () => ({ tasks: tasks.filter((t) => !cancelled.includes(t.id)) }),
                cancel: async ({ id }) => {
                    cancelled.push(id);
                    // The backgrounded shell ending lets the CLI fire session.idle.
                    if (id === endTurnOnCancel) queueMicrotask(() => copilot._emit("session.idle"));
                    return { cancelled: true };
                },
            },
        };
        return cancelled;
    }

    it("V4 Stop (cancelTurnTasks): cancels the tasks this turn started before the wait; keeps earlier-turn tasks and tasks without startedAt", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("long shell", { turnIndex: 3 });
        await waitFor(() => managed.getActiveTurn() != null);
        const turnStart = managed.getActiveTurn().startedAt;
        const cancelled = withTaskList(copilot, [
            { id: "earlier-server", type: "shell", status: "running", startedAt: new Date(turnStart - 60_000).toISOString() },
            { id: "this-turn-shell", type: "shell", status: "running", startedAt: new Date(turnStart).toISOString() },
            { id: "no-start", type: "agent", status: "running" },
        ], { endTurnOnCancel: "this-turn-shell" });

        const t0 = Date.now();
        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user",
            expectedTurnIndex: 3,
            unwindGraceMs: 5_000,
            cancelTurnTasks: true,
        });
        const ms = Date.now() - t0;
        expect(result.outcome).toBe("stopped");
        expect(cancelled).toEqual(["this-turn-shell"]);
        expect(copilot.abortCalls).toBe(1);
        expect(ms).toBeLessThan(2_000); // the 5 s unwind wait was not needed
        expect((await turnPromise).type).toBe("stopped");
    });

    it("V4 Stop: a slow task list that already shows the next turn's task cancels only the stopped turn's task", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("long shell", { turnIndex: 6 });
        await waitFor(() => managed.getActiveTurn() != null);
        const turnStart = managed.getActiveTurn().startedAt;
        const cancelled = [];
        const tasks = [
            { id: "stopped-turn-shell", type: "shell", status: "running", startedAt: new Date(turnStart).toISOString() },
        ];
        const current = () => ({ tasks: tasks.filter((t) => !cancelled.includes(t.id)) });
        let releaseList;
        let first = true;
        copilot.rpc = {
            tasks: {
                // The first list answers late: by then the next turn has started a task of its own.
                list: () => {
                    if (!first) return Promise.resolve(current());
                    first = false;
                    return new Promise((resolve) => { releaseList = () => resolve(current()); });
                },
                cancel: async ({ id }) => { cancelled.push(id); return { cancelled: true }; },
            },
        };

        const stopping = manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user", expectedTurnIndex: 6, unwindGraceMs: 100, cancelTurnTasks: true,
        });
        await waitFor(() => typeof releaseList === "function");
        tasks.push({ id: "next-turn-shell", type: "shell", status: "running", startedAt: new Date(Date.now() + 5).toISOString() });
        releaseList();
        await stopping;
        expect((await turnPromise).type).toBe("stopped");
        await waitFor(() => cancelled.length > 0);
        expect(cancelled).toEqual(["stopped-turn-shell"]);
    });

    it("the legacy Stop (no cancelTurnTasks) cancels no background task", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("long shell", { turnIndex: 4 });
        await waitFor(() => managed.getActiveTurn() != null);
        const turnStart = managed.getActiveTurn().startedAt;
        const cancelled = withTaskList(copilot, [
            { id: "this-turn-shell", type: "shell", status: "running", startedAt: new Date(turnStart).toISOString() },
        ]);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user",
            expectedTurnIndex: 4,
            unwindGraceMs: 100,
        });
        expect(result.outcome).toBe("stop_forced");
        expect(cancelled).toEqual([]);
        expect((await turnPromise).type).toBe("stopped");
    });

    it("a task cancel that hangs is bounded: the Stop still unwinds through the grace backstop", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("long shell", { turnIndex: 5 });
        await waitFor(() => managed.getActiveTurn() != null);
        copilot.rpc = { tasks: { list: () => new Promise(() => {}), cancel: async () => ({ cancelled: true }) } };

        const t0 = Date.now();
        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user",
            expectedTurnIndex: 5,
            unwindGraceMs: 100,
            cancelTurnTasks: true,
        });
        expect(result.outcome).toBe("stop_forced");
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect((await turnPromise).type).toBe("stopped");
    });

    it("never takes the per-session lock (lock-bypass contract)", () => {
        // runTurn holds withRunTurnLock for the entire turn; a lock-taking
        // stop would serialize behind the turn and defeat mid-flight stop.
        const source = SessionManager.prototype.abortWarmSessionTurn.toString();
        expect(source.includes("_withSessionLock")).toBe(false);
        expect(source.includes("withRunTurnLock")).toBe(false);
    });
});

// ─── Queue naming ────────────────────────────────────────────────

describe("stopTurnQueueName", () => {
    it("is turn-scoped so a stale stop can never win a later turn's race", () => {
        expect(stopTurnQueueName(0)).toBe("stopTurn.0");
        expect(stopTurnQueueName(12)).toBe("stopTurn.12");
        expect(stopTurnQueueName(12)).not.toBe(stopTurnQueueName(13));
    });
});

// ─── Copilot SDK abort primitive contract ────────────────────────

describe("CopilotSession.abort contract", () => {
    it("sends session.abort with the current sessionId (guards SDK drift)", async () => {
        const calls = [];
        const connection = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                return { ok: true };
            },
        };
        const session = new CopilotSession("probe-session", connection, process.cwd());
        expect(typeof session.abort).toBe("function");
        await session.abort();
        expect(calls.length).toBe(1);
        expect(calls[0].method).toBe("session.abort");
        expect(calls[0].params.sessionId).toBe("probe-session");
    });
});
