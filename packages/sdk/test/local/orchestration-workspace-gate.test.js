/**
 * Session workspaces, slice C2: the workspace gate in orchestration 1.0.80
 * (docs/proposals/session-workspaces.md, section 4.7). The drives run the
 * REAL latest orchestration generator with a scripted session proxy, the
 * pattern of orchestration-budget-resume.test.js.
 *
 * Covers F12 (the retry schedule), the orchestration half of F2 (held
 * prompts with images and sender, replayed once), F4's release rule (two
 * failures on one worker), F9 (a message or a model switch does not re-arm a
 * workspace wait), F11 (a budget wait's timer text is never held as a user
 * message), "retry now", and the continue-as-new carry.
 *
 * Run: npx vitest run test/local/orchestration-workspace-gate.test.js
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

const WORKSPACE = { schema: 1, root: "a", folder: "sessions/s-1/app" };

/** A workspace refusal, exactly as the runTurn activity returns one. */
const refusal = ({ worker = "worker-a", code = "WORKSPACE_FOLDER_MISSING", retryAfterMs } = {}) => ({
    type: "wait", seconds: 30, reason: `workspace unavailable: ${code}`, gate: "workspace",
    code, workerNodeId: worker, ...(retryAfterMs ? { retryAfterMs } : {}),
});
const budgetRefusal = () => ({ type: "wait", seconds: 3600, reason: "provider has reached its daily limit", budget: true });

/**
 * `turnResults` scripts runTurn results in order. `queue` stages messages:
 * an entry becomes deliverable after `afterTurns` turn attempts. `fireTimers`
 * lets that many real (>1 s) timers fire when nothing is queued; after that a
 * real timer parks the drive. Every raced real timer's length is recorded.
 */
function createHarness({ turnResults = [], queue = [], fireTimers = 0, releaseHangs = false } = {}) {
    const turns = [];
    const recorded = [];
    const timers = [];
    // releaseWorkspace races: { args, capMs }. `sequence` orders releases and events.
    const releases = [];
    const sequence = [];
    const kv = new Map();
    const pendingMessages = queue.map((entry) => (typeof entry === "string" ? { afterTurns: 0, msg: entry } : entry));
    const script = [...turnResults];
    let timersLeft = fireTimers;
    const nextDeliverable = () => {
        const ix = pendingMessages.findIndex((e) => e.afterTurns <= turns.length);
        if (ix < 0) return null;
        return pendingMessages.splice(ix, 1)[0].msg;
    };
    const hasDeliverable = () => pendingMessages.some((e) => e.afterTurns <= turns.length);

    mockSession = new Proxy({}, {
        get: (_t, prop) => {
            if (prop === "runTurn") {
                return (prompt, bootstrap, turnIndex, opts) => {
                    turns.push({ prompt, bootstrap: Boolean(bootstrap), turnIndex, opts: opts ?? {} });
                    return { effect: "runTurn" };
                };
            }
            return (...args) => ({ effect: `session.${String(prop)}`, args });
        },
    });
    mockManager = new Proxy({}, {
        get: (_t, prop) => (...args) => ({ effect: `manager.${String(prop)}`, args }),
    });

    const ctx = {
        traceInfo: () => {},
        setCustomStatus: () => {},
        getValue: (k) => (kv.has(k) ? kv.get(k) : null),
        setValue: (k, v) => kv.set(k, v),
        clearValue: (k) => kv.delete(k),
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
        dequeueEvent: (name) => ({ effect: "dequeueEvent", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
    };

    let now = 1_750_000_000_000;
    let guid = 0;
    const resolve = (effect) => {
        if (!effect || typeof effect !== "object") return undefined;
        switch (effect.effect) {
            case "utcNow": return now;
            case "newGuid": return `00000000-0000-0000-0000-${String(++guid).padStart(12, "0")}`;
            case "dequeueEvent": {
                const msg = nextDeliverable();
                if (msg == null) throw new Error(`dequeue underflow (${effect.name ?? "?"})`);
                return msg;
            }
            case "race": {
                if (effect.left?.effect === "runTurn") {
                    if (script.length === 0) throw new Error("runTurn past the script");
                    return { index: 0, value: script.shift() };
                }
                const sides = [effect.left, effect.right];
                const releaseIx = sides.findIndex((s) => s?.effect === "session.releaseWorkspace");
                if (releaseIx >= 0) {
                    releases.push({ args: sides[releaseIx].args[0], capMs: sides[1 - releaseIx]?.ms });
                    sequence.push("releaseWorkspace");
                    return releaseHangs ? { index: 1 - releaseIx } : { index: releaseIx, value: { released: true, cancelled: 0 } };
                }
                const dequeueIx = sides.findIndex((s) => s?.effect === "dequeueEvent");
                const timerIx = sides.findIndex((s) => s?.effect === "scheduleTimer");
                if (timerIx >= 0 && sides[timerIx].ms > 1000) timers.push(sides[timerIx].ms);
                if (dequeueIx >= 0 && hasDeliverable()) return { index: dequeueIx, value: nextDeliverable() };
                if (timerIx >= 0 && sides[timerIx].ms <= 1000) return { index: timerIx };
                if (timerIx >= 0) {
                    if (timersLeft > 0) {
                        timersLeft -= 1;
                        now += sides[timerIx].ms;
                        return { index: timerIx };
                    }
                }
                return { effect: "PARKED" };
            }
            default:
                if (effect.effect === "manager.recordSessionEvent") {
                    const [sessionId, events] = effect.args;
                    for (const e of events ?? []) {
                        recorded.push({ sessionId, ...e });
                        sequence.push(`event:${e.eventType}`);
                    }
                    return undefined;
                }
                if (effect.effect === "manager.getWorkerSessionPolicy") return { policy: null, allowedAgentNames: [] };
                if (effect.effect === "manager.resolveAgentConfig") return null;
                if (effect.effect === "manager.listModels") return [];
                return undefined;
        }
    };
    return { ctx, turns, recorded, timers, releases, sequence, kv, resolve, hasDeliverable };
}

async function latestHandler() {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    const mod = await import("../../src/orchestration.ts");
    return mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
}

function drive(gen, harness, { maxSteps = 600 } = {}) {
    let input;
    for (let i = 0; i < maxSteps; i += 1) {
        const next = gen.next(input);
        if (next.done) return { kind: "return", value: next.value };
        const effect = next.value;
        if (effect?.effect === "continueAsNew") return { kind: "continueAsNew", input: effect.input };
        if (effect?.effect === "dequeueEvent" && !harness.hasDeliverable()) return { kind: "blocked" };
        input = harness.resolve(effect);
        if (input?.effect === "PARKED") return { kind: "parked" };
    }
    throw new Error("drive exceeded step limit");
}

const INPUT = (overrides = {}) => ({
    sessionId: "ws-gate",
    config: { model: "fixture:model", workspace: WORKSPACE },
    iteration: 0,
    isSystem: false,
    blobEnabled: false,
    ...overrides,
});
const prompt = (text, extra = {}) => JSON.stringify({ prompt: text, ...extra });
const events = (h, type) => h.recorded.filter((e) => e.eventType === type);

describe("workspace gate (orchestration 1.0.80)", () => {
    beforeEach(() => { mockSession = null; mockManager = null; });

    it("a refusal holds the prompt with its images and sender, sends the revision, and does not burn the turn index", async () => {
        const handler = await latestHandler();
        const attachments = [{ filename: "shot.png", contentType: "image/png", sizeBytes: 10 }];
        const sender = { kind: "user", provider: "test", subject: "ada", display: "Ada", relation: "owner" };
        const h = createHarness({
            turnResults: [refusal()],
            queue: [prompt("fix the typo", { clientMessageIds: ["cm-1"], attachments, sender })],
        });
        expect(drive(handler(h.ctx, INPUT()), h).kind).toBe("parked");

        const held = events(h, "user.message");
        expect(held).toHaveLength(1);
        expect(held[0].data).toMatchObject({ content: "fix the typo", clientMessageIds: ["cm-1"], workspaceQueued: true, attachments, sender });
        expect(held[0].data.budgetQueued).toBeUndefined();
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0].turnIndex).toBe(0);
        expect(h.turns[0].opts.workspaceRevision).toBe(1);
        expect(h.timers).toEqual([30_000]);
    });

    it("the retry schedule is 30 s, 2 min, 5 min, then every 15 min, or the provider's larger retryAfterMs (F12)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal(), refusal(), refusal({ retryAfterMs: 400_000 }), refusal(), refusal(), refusal()],
            queue: [prompt("work")],
            fireTimers: 5,
        });
        drive(handler(h.ctx, INPUT()), h);
        expect(h.timers).toEqual([30_000, 120_000, 400_000, 900_000, 900_000, 900_000]);
        // The retries are machinery: one user.message for the one prompt.
        expect(events(h, "user.message")).toHaveLength(1);
        // Every attempt re-used the turn index of the turn that never ran.
        expect(new Set(h.turns.map((t) => t.turnIndex))).toEqual(new Set([0]));
    });

    it("the test override replaces the schedule in milliseconds", async () => {
        const handler = await latestHandler();
        const h = createHarness({ turnResults: [refusal(), refusal()], queue: [prompt("work")], fireTimers: 1 });
        drive(handler(h.ctx, INPUT({ workspaceRetryScheduleMs: [1_500, 2_500] })), h);
        expect(h.timers).toEqual([1_500, 2_500]);
    });

    it("recovery runs the held prompt once with its images, clears the hold, and emits workspace_available (F2)", async () => {
        const handler = await latestHandler();
        const attachments = [{ filename: "a.png", contentType: "image/png", sizeBytes: 5 }];
        const h = createHarness({
            turnResults: [refusal(), refusal(), { type: "completed", content: "done" }, { type: "completed", content: "next" }],
            queue: [
                prompt("held prompt", { attachments }),
                { afterTurns: 3, msg: prompt("a later message") },
            ],
            fireTimers: 2,
        });
        drive(handler(h.ctx, INPUT()), h);
        expect(h.turns.length).toBeGreaterThanOrEqual(4);

        // Attempts 2 and 3 are retry wakes: [SYSTEM:] traffic on the internal
        // prompt, carrying the held prompt and its images.
        for (const retry of [h.turns[1], h.turns[2]]) {
            expect(retry.bootstrap).toBe(true);
            expect(retry.prompt).toMatch(/^Internal orchestration wake-up/);
            expect(retry.opts.stashedPrompts).toEqual(["held prompt"]);
            expect(retry.opts.stashedAttachments).toEqual(attachments);
        }
        // After recovery, nothing is held any more.
        expect(h.turns[3].prompt).toBe("a later message");
        expect(h.turns[3].opts.stashedPrompts).toBeUndefined();
        expect(h.turns[3].opts.stashedAttachments).toBeUndefined();

        expect(events(h, "user.message")).toHaveLength(1);
        expect(events(h, "session.workspace_available")).toEqual([
            expect.objectContaining({ data: { revision: 1 } }),
        ]);
        // The turn index was used once the turn really ran.
        expect(h.turns[2].turnIndex).toBe(0);
        expect(h.turns[3].turnIndex).toBe(1);
    });

    it("two failures in a row on one worker release affinity; the count starts again on another worker (F4 rule)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal({ worker: "w-a" }), refusal({ worker: "w-a" }), refusal({ worker: "w-b" }), refusal({ worker: "w-b" }), refusal({ worker: "w-b" })],
            queue: [prompt("work")],
            fireTimers: 4,
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        const releases = events(h, "session.affinity_released").filter((e) => e.data.reason === "workspace_unavailable");
        expect(releases.map((e) => [e.data.workerNodeId, e.data.failures])).toEqual([["w-a", 2], ["w-b", 2], ["w-b", 3]]);
    });

    it("a message during a workspace wait clears the retry timer, and the wait is not re-armed after recovery (F9)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal(), { type: "completed", content: "answered" }],
            queue: [prompt("first"), { afterTurns: 1, msg: prompt("second") }],
        });
        const outcome = drive(handler(h.ctx, INPUT()), h);
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1].prompt).toBe("second");
        expect(h.turns[1].opts.stashedPrompts).toEqual(["first"]);
        // Only the first retry timer was ever armed; nothing after recovery.
        expect(h.timers).toEqual([30_000]);
        expect(outcome.kind).not.toBe("parked");
        expect(events(h, "session.workspace_available")).toHaveLength(1);
    });

    it("a model switch during a workspace wait drops the retry timer and carries the hold across continue-as-new (F9)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal()],
            queue: [prompt("first"), { afterTurns: 1, msg: JSON.stringify({ type: "cmd", cmd: "set_model", id: "c-1", args: { model: "fixture:other" } }) }],
        });
        const outcome = drive(handler(h.ctx, INPUT()), h);
        expect(outcome.kind).toBe("continueAsNew");
        expect(outcome.input.activeTimerState).toBeUndefined();
        expect(outcome.input.interruptedWaitTimer).toBeUndefined();
        expect(outcome.input.workspaceStatus).toEqual({ state: "unavailable", code: "WORKSPACE_FOLDER_MISSING" });
        expect(outcome.input.workspaceRetry).toEqual({ step: 1, failures: { workerNodeId: "worker-a", count: 1 } });
        expect(outcome.input.budgetStash).toEqual([{ prompt: "first" }]);
        expect(outcome.input.workspaceRevision).toBe(1);
    });

    it("retry now interrupts the wait and attempts at once", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal(), { type: "completed", content: "done" }],
            queue: [prompt("first"), { afterTurns: 1, msg: JSON.stringify({ type: "cmd", cmd: "retry_workspace", id: "r-1" }) }],
        });
        drive(handler(h.ctx, INPUT()), h);
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1].bootstrap).toBe(true);
        expect(h.turns[1].opts.stashedPrompts).toEqual(["first"]);
        const response = JSON.parse(h.kv.get("cmd.response.r-1") ?? [...h.kv.entries()].find(([k]) => k.includes("r-1"))?.[1]);
        expect(response.result).toEqual({ ok: true, retried: true });
    });

    it("a budget wait's own timer wakes with [SYSTEM:] text that is never held as a user message (F11)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [budgetRefusal(), budgetRefusal()],
            queue: [prompt("please run")],
            fireTimers: 1,
        });
        drive(handler(h.ctx, INPUT({ config: { model: "fixture:model" } })), h);
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1].prompt).not.toMatch(/second wait is now complete/);
        expect(h.turns[1].bootstrap).toBe(true);
        const held = events(h, "user.message");
        expect(held.map((e) => e.data.content)).toEqual(["please run"]);
        expect(held[0].data.budgetQueued).toBe(true);
    });

    it("a session created with a workspace starts at revision 1 and announces it once (B13)", async () => {
        const handler = await latestHandler();
        const h = createHarness({ turnResults: [{ type: "completed", content: "ok" }], queue: [prompt("hello")] });
        drive(handler(h.ctx, INPUT()), h);
        expect(events(h, "session.workspace_changed")).toEqual([
            expect.objectContaining({ data: { workspace: WORKSPACE, revision: 1, path: null, source: "create" } }),
        ]);
        // A later execution (after continue-as-new) carries revision 1 and does not announce again.
        const again = createHarness({ turnResults: [{ type: "completed", content: "ok" }], queue: [prompt("again")] });
        drive(handler(again.ctx, INPUT({ workspaceRevision: 1 })), again);
        expect(events(again, "session.workspace_changed")).toHaveLength(0);
        expect(again.turns[0].opts.workspaceRevision).toBe(1);
    });

    it("an old history's budget timer text is still never held as a user message (F11, filter)", async () => {
        const handler = await latestHandler();
        // A pre-1.0.80 continue-as-new input: the budget timer lost its flag,
        // so it still wakes with the agent's wait text.
        const h = createHarness({ turnResults: [budgetRefusal()] });
        drive(handler(h.ctx, INPUT({
            config: { model: "fixture:model" },
            activeTimerState: { remainingMs: 0, reason: "provider has reached its daily limit", type: "wait", originalDurationMs: 3_600_000 },
        })), h);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0].prompt).toMatch(/^The 3600 second wait is now complete\./);
        expect(events(h, "user.message")).toHaveLength(0);
    });

    it("releasing affinity runs releaseWorkspace on the holder first, raced with a 10 s cap (C3)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal({ worker: "w-a" }), refusal({ worker: "w-a" })],
            queue: [prompt("work")],
            fireTimers: 1,
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        expect(h.releases).toEqual([{ args: { reason: "workspace_unavailable", revision: 1, turnIndex: 0 }, capMs: 10_000 }]);
        const at = h.sequence.indexOf("releaseWorkspace");
        const released = h.sequence.findIndex((entry, i) => i > at && entry === "event:session.affinity_released");
        expect(at).toBeGreaterThanOrEqual(0);
        expect(released).toBeGreaterThan(at);
    });

    it("the hold-window release runs releaseWorkspace for a workspace session and not for a plain one (M1)", async () => {
        const handler = await latestHandler();
        const ws = createHarness({ turnResults: [{ type: "completed", content: "ok" }], queue: [prompt("hi")], fireTimers: 1 });
        drive(handler(ws.ctx, INPUT({ blobEnabled: true })), ws);
        expect(ws.releases.map((r) => r.args.reason)).toEqual(["idle"]);
        expect(events(ws, "session.affinity_released").map((e) => e.data.reason)).toEqual(["idle"]);

        const plain = createHarness({ turnResults: [{ type: "completed", content: "ok" }], queue: [prompt("hi")], fireTimers: 1 });
        drive(handler(plain.ctx, INPUT({ blobEnabled: true, config: { model: "fixture:model" } })), plain);
        expect(plain.releases).toEqual([]);
        expect(events(plain, "session.affinity_released").map((e) => e.data.reason)).toEqual(["idle"]);
    });

    it("a hanging releaseWorkspace does not hold the move beyond the cap (M6)", async () => {
        const handler = await latestHandler();
        const h = createHarness({ turnResults: [{ type: "completed", content: "ok" }], queue: [prompt("hi")], fireTimers: 1, releaseHangs: true });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        expect(h.releases).toHaveLength(1);
        expect(events(h, "session.affinity_released").map((e) => e.data.reason)).toEqual(["idle"]);
    });

    it("a session without a workspace carries no workspace fields and sends no revision", async () => {
        const handler = await latestHandler();
        const h = createHarness({ turnResults: [{ type: "completed", content: "ok" }], queue: [prompt("hello")] });
        const outcome = drive(handler(h.ctx, INPUT({ config: { model: "fixture:model" } })), h);
        expect(h.turns[0].opts.workspaceRevision).toBeUndefined();
        expect(h.turns[0].opts.workspaceNotice).toBeUndefined();
        expect(h.turns[0].opts.stashedAttachments).toBeUndefined();
        if (outcome.kind === "continueAsNew") {
            for (const key of ["workspaceRevision", "workspaceStatus", "workspaceNotice", "workspaceRetry", "workspaceRetryScheduleMs"]) {
                expect(key in outcome.input).toBe(false);
            }
        }
        expect(events(h, "session.workspace_available")).toHaveLength(0);
    });
});
