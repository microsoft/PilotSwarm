/**
 * Session steering: the Stop safety net on the actual ManagedSession, with a
 * controlled SDK that misbehaves after abort the way a queued steer could:
 *  - the abort does not end the run and a follow-up run starts;
 *  - the abort produces no idle at all.
 * Stop (requestStop + abort, as abortWarmSessionTurn does) must still unwind the
 * turn quickly, without changing behavior for a turn that is not steered.
 */
import { describe, expect, it } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";
import { SessionManager } from "../../src/session-manager.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, label) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(5);
    }
}

function fakeSdk(onAbort) {
    const handlers = new Set();
    const sdk = {
        aborts: 0,
        removed: 0,
        pending: 0,
        tools: new Map(),
        registerTools(tools) { for (const tool of tools ?? []) this.tools.set(tool.name, tool); },
        on(type, fn) {
            const h = typeof type === "function" ? { type: null, fn: type } : { type, fn };
            handlers.add(h);
            return () => handlers.delete(h);
        },
        emit(type, data = {}) { for (const h of [...handlers]) if (h.type === null || h.type === type) h.fn({ type, data }); },
        async send(input) {
            if (input.mode !== "immediate") {
                sdk.emit("user.message", { messageId: "main", delivery: "idle", content: input.prompt });
                sdk.emit("assistant.turn_start", {});
                return "main";
            }
            sdk.pending++;
            return `steer-${sdk.pending}`;
        },
        async abort() {
            sdk.aborts++;
            onAbort(sdk, sdk.aborts);
        },
        async getEvents() { return []; },
        rpc: { queue: { removeMostRecent: async () => {
            if (sdk.pending > 0) { sdk.pending--; sdk.removed++; return { removed: true }; }
            return { removed: false };
        } } },
    };
    return sdk;
}

function channel(row) {
    let claimed = false;
    return {
        sessionId: "s", target: { epoch: 0, turnIndex: 1, incarnation: "i" }, ownerToken: "o", recoverySource: "restored",
        openWindow: async () => ({ ok: true, recovered: [] }),
        renew: async () => true, quiesce: async () => {}, abandonWindow: async () => {},
        claim: async () => { if (claimed || !row) return []; claimed = true; return [row]; },
        recordRecoveryCheck: async () => {}, markSubmitting: async () => ({ attemptId: "a1" }),
        markReleased: async () => {}, markSubmitted: async () => {}, markDelivered: async () => {}, markUnconfirmed: async () => {},
    };
}

const ROW = { requestId: "r1", sequence: 1, text: "focus", actor: { provider: "t", subject: "a" }, redelivery: false };

async function stopAndTime(managed, sdk) {
    const turn = managed.runTurn("long essay", { turnIndex: 1, steering: channel(ROW), steeringQuiesce: async () => true });
    await until(() => sdk.pending === 1, 5_000, "the steer hand-off");
    const started = performance.now();
    managed.requestStop("test stop");
    managed.abort();
    await until(() => managed.getActiveTurn() === null, 8_000, "the turn to unwind");
    const ms = performance.now() - started;
    const result = await turn;
    return { ms, result };
}

describe("Stop safety net for a steered turn", () => {
    it("a follow-up run started by a queued steer after Stop is aborted at once", async () => {
        const sdk = fakeSdk((s, n) => {
            if (n === 1) { s.emit("assistant.turn_start", {}); return; }   // first abort: the queued steer starts a run
            s.emit("assistant.turn_end", {}); s.emit("session.idle", {});
        });
        const managed = new ManagedSession("s", sdk, {});
        const { ms, result } = await stopAndTime(managed, sdk);
        expect(result.type).toBe("stopped");
        expect(sdk.aborts).toBe(2);
        expect(ms).toBeLessThan(1_000);
    });

    it("an abort that produces no idle is retried after 1 s with the CLI queue drained", async () => {
        const sdk = fakeSdk((s, n) => {
            if (n === 1) return;                                             // wedge: nothing at all
            if (s.pending === 0) { s.emit("assistant.turn_end", {}); s.emit("session.idle", {}); }
        });
        const managed = new ManagedSession("s", sdk, {});
        const { ms, result } = await stopAndTime(managed, sdk);
        expect(result.type).toBe("stopped");
        expect(sdk.aborts).toBe(2);
        expect(sdk.removed).toBe(1);
        expect(ms).toBeGreaterThanOrEqual(900);
        expect(ms).toBeLessThan(2_000);
    });

    it("the next turn disarms the watch: it is never aborted by the previous Stop", async () => {
        const sdk = fakeSdk((s, n) => { if (n === 1) { s.emit("assistant.turn_end", {}); s.emit("session.idle", {}); } });
        const managed = new ManagedSession("s", sdk, {});
        await stopAndTime(managed, sdk);
        sdk.send = async (input) => {
            if (input.mode !== "immediate") {
                sdk.emit("user.message", { messageId: "main-2", delivery: "idle" });
                sdk.emit("assistant.turn_start", {});
                setTimeout(() => { sdk.emit("assistant.message", { content: "second answer" }); sdk.emit("session.idle", {}); }, 1_500);
                return "main-2";
            }
            return "x";
        };
        const second = await managed.runTurn("next prompt", { turnIndex: 2 });
        expect(second.type).toBe("completed");
        expect(sdk.aborts).toBe(1);
    });
});

describe("Stop is never delayed by steering settlement (test-env timeline 79d544be)", () => {
    /** Abort ends the run at once (idle within ms) and drops the queued steer: no delivery event, ever. */
    const dropOnAbort = (s) => { s.pending = 0; s.emit("assistant.turn_end", {}); s.emit("session.idle", {}); };

    it("an activity-cancellation abort (no Stop request) returns the turn at once instead of waiting for settlement", async () => {
        const sdk = fakeSdk(dropOnAbort);
        const managed = new ManagedSession("s", sdk, {});
        const turn = managed.runTurn("long essay", { turnIndex: 1, steering: channel(ROW), steeringQuiesce: async () => true });
        await until(() => sdk.pending === 1, 5_000, "the steer hand-off");
        const started = performance.now();
        managed.abort();                                                     // the runTurn cancellation poll
        const result = await turn;
        expect(performance.now() - started).toBeLessThan(500);
        expect(result.type).not.toBe("stopped");
        expect(managed.getActiveTurn()).toBeNull();
    });

    it("a Stop that arrives while settlement is waiting for evidence interrupts it", async () => {
        const sdk = fakeSdk(dropOnAbort);
        const managed = new ManagedSession("s", sdk, {});
        const turn = managed.runTurn("long essay", { turnIndex: 1, steering: channel(ROW), steeringQuiesce: async () => true });
        await until(() => sdk.pending === 1, 5_000, "the steer hand-off");
        sdk.emit("assistant.turn_end", {});
        sdk.emit("session.idle", {});                                        // natural idle; the steer has no evidence
        await sleep(50);
        expect(managed.getActiveTurn()).not.toBeNull();                     // settlement is waiting (up to 30 s)
        const started = performance.now();
        managed.requestStop("Stop");
        managed.abort();
        const result = await turn;
        expect(performance.now() - started).toBeLessThan(500);
        expect(result.type).toBe("stopped");
    });

    it("abortWarmSessionTurn reaches `stopped` quickly when the CLI is already idle and settlement is in progress", async () => {
        const sdk = fakeSdk(dropOnAbort);
        const managed = new ManagedSession("s3", sdk, {});
        const m = Object.create(SessionManager.prototype);
        m.sessions = new Map([["s3", managed]]);
        m.sessionAgentCopies = new Map();
        m.sessionBindingFingerprints = new Map();
        const turn = managed.runTurn("long essay", { turnIndex: 4, steering: channel(ROW), steeringQuiesce: async () => true });
        await until(() => sdk.pending === 1, 5_000, "the steer hand-off");
        sdk.emit("assistant.turn_end", {});
        sdk.emit("session.idle", {});
        await sleep(50);
        const started = performance.now();
        const outcome = await m.abortWarmSessionTurn("s3", { reason: "Stop", expectedTurnIndex: 4 });
        expect(outcome).toEqual({ outcome: "stopped", turnIndex: 4 });
        expect(performance.now() - started).toBeLessThan(1_000);
        expect((await turn).type).toBe("stopped");
    });
});
