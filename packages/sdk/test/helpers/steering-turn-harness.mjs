import { vi } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";

export function barrier() {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    return {
        entered: entered.promise,
        release: released.resolve,
        reject: released.reject,
        async hold(value) {
            entered.resolve(value);
            return await released.promise;
        },
    };
}

/** Product ManagedSession with controlled SDK and storage boundaries. */
export function makeSteeringTurnHarness({ block = null, send = null, history = null, sdkSession = null } = {}) {
    const handlers = new Set();
    const events = [];
    const calls = [];
    const main = Promise.withResolvers();
    const claimed = Promise.withResolvers();
    const submitted = Promise.withResolvers();
    const delivered = Promise.withResolvers();
    const cut = barrier();
    const row = {
        requestId: "request-a", text: "Keep this guidance separate", actor: { provider: "test", subject: "author-a" },
        sequence: 1, seq: 1, status: "claimed", sdkMessageId: null, redelivery: false,
    };
    let claimReturned = false;
    let wake;
    const emit = (type, data = {}) => {
        const event = { type, data, id: `event-${events.length}`, timestamp: new Date().toISOString() };
        events.push(event);
        for (const handler of [...handlers]) {
            if (handler.type === null || handler.type === type) handler.fn(event);
        }
    };
    const copilot = sdkSession ?? {
        registerTools() {},
        on(type, fn) {
            const handler = typeof type === "function" ? { type: null, fn: type } : { type, fn };
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        send: vi.fn(async (input) => {
            calls.push(["send", input.mode ?? "main"]);
            if (input.mode !== "immediate") {
                emit("user.message", { messageId: "main-prompt", delivery: "idle", content: input.prompt });
                main.resolve();
                return "main-prompt";
            }
            if (send) return await send({ input, emit, cut, calls });
            emit("user.message", { messageId: "sdk-steer-a", delivery: "steering", content: input.displayPrompt });
            return "sdk-steer-a";
        }),
        abort: vi.fn(() => {
            calls.push(["abort"]);
            emit("session.idle");
        }),
        disconnect: vi.fn(async () => { calls.push(["disconnect"]); }),
        getEvents: vi.fn(async () => history ? await history(events) : [...events]),
        getMessages: vi.fn(async () => []),
    };
    const channel = {
        sessionId: "steering-turn-fixture",
        target: { epoch: 0, turnIndex: 1, incarnation: "snapshot-turn-fixture" },
        ownerToken: "owner-fixture",
        openWindow: vi.fn(async () => {
            calls.push(["open"]);
            if (block === "open") return await cut.hold();
            return { ok: true, recovered: [] };
        }),
        recordRecoveryCheck: vi.fn(async () => {}),
        renew: vi.fn(async () => { calls.push(["renew"]); return true; }),
        quiesce: vi.fn(async () => { calls.push(["quiesce"]); }),
        abandonWindow: vi.fn(async () => { calls.push(["abandon"]); }),
        claim: vi.fn(async () => {
            calls.push(["claim"]);
            claimed.resolve();
            if (claimReturned) return [];
            claimReturned = true;
            if (block === "claim") return await cut.hold();
            return [row];
        }),
        markSubmitting: vi.fn(async () => {
            calls.push(["submitting"]);
            if (block === "submitting") return await cut.hold();
            return { attemptId: "attempt-a" };
        }),
        markReleased: vi.fn(async () => { calls.push(["released"]); }),
        markSubmitted: vi.fn(async () => { calls.push(["submitted"]); submitted.resolve(); }),
        markDelivered: vi.fn(async (...args) => {
            calls.push(["delivered", ...args]);
            delivered.resolve(args);
            if (block === "delivery") return await cut.hold();
        }),
        markUnconfirmed: vi.fn(async () => { calls.push(["unconfirmed"]); }),
        onWake(cb) { wake = cb; return () => { wake = null; }; },
    };
    const managed = new ManagedSession("steering-turn-fixture", copilot, { waitThreshold: 30 });
    return {
        managed, copilot, channel, emit, row, calls, cut, events,
        mainEntered: main.promise, claimEntered: claimed.promise, submitted: submitted.promise, delivered: delivered.promise,
        wake: () => wake?.(),
        run: (options = {}) => managed.runTurn("original prompt", { turnIndex: 1, steering: channel, ...options }),
        answer(content = "original answer") {
            emit("assistant.message", { messageId: `assistant-${events.length}`, content });
            emit("session.idle");
        },
    };
}
