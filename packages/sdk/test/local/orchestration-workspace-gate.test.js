/**
 * Session workspaces: the workspace gate in orchestration 1.0.80
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
// The config each session proxy was built with: what the next turn runs with.
let proxyConfigs = [];

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (_ctx, _sessionId, _affinityKey, config) => {
        proxyConfigs.push(JSON.parse(JSON.stringify(config ?? null)));
        return mockSession;
    },
    createSessionManagerProxy: () => mockManager,
}));

const WORKSPACE = { schema: 1, root: "a", folder: "sessions/s-1/app" };

/** A result of a turn that got past the workspace check: the activity marks it. */
const ran = (result) => ({ ...result, workspaceAttached: true });

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
function createHarness({ turnResults = [], queue = [], fireTimers = 0, releaseHangs = false, checkWorkspace } = {}) {
    // checkWorkspace activity calls: the args, and what they answered.
    const checks = [];
    const turns = [];
    const recorded = [];
    const timers = [];
    // releaseWorkspace races: { args, capMs }. `sequence` orders releases and events.
    const releases = [];
    // spawnChildSession activity calls: the positional args.
    const spawns = [];
    const sequence = [];
    const kv = new Map();
    const pendingMessages = queue.map((entry) => (typeof entry === "string" ? { afterTurns: 0, msg: entry } : { afterTurns: 0, ...entry }));
    const script = [...turnResults];
    let timersLeft = fireTimers;
    // `afterReleases` holds a message back until that many releaseWorkspace calls ran.
    const deliverable = (e) => e.afterTurns <= turns.length && (e.afterReleases ?? 0) <= releases.length;
    const nextDeliverable = () => {
        const ix = pendingMessages.findIndex(deliverable);
        if (ix < 0) return null;
        return pendingMessages.splice(ix, 1)[0].msg;
    };
    const hasDeliverable = () => pendingMessages.some(deliverable);

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
                if (effect.effect === "session.checkWorkspace") {
                    const args = effect.args[0];
                    const answer = checkWorkspace ? checkWorkspace(args) : { ok: true, path: `/ws/${args.workspace.root}/${args.workspace.folder ?? ""}` };
                    checks.push({ args, answer });
                    // An Error stands for a failed activity: it is thrown into the handler.
                    return answer instanceof Error ? { __throw: answer } : answer;
                }
                if (effect.effect === "manager.spawnChildSession") {
                    spawns.push(effect.args);
                    return `child-${spawns.length}`;
                }
                if (effect.effect === "manager.getWorkerSessionPolicy") return { policy: null, allowedAgentNames: [] };
                if (effect.effect === "manager.resolveAgentConfig") return null;
                if (effect.effect === "manager.listModels") return [];
                return undefined;
        }
    };
    return { ctx, turns, recorded, timers, releases, sequence, checks, spawns, kv, resolve, hasDeliverable };
}

async function latestHandler() {
    const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
    const mod = await import("../../src/orchestration.ts");
    return mod[`durableSessionOrchestration_${DURABLE_SESSION_LATEST_VERSION.replace(/\./g, "_")}`];
}

function drive(gen, harness, { maxSteps = 600 } = {}) {
    let input;
    let thrown = null;
    for (let i = 0; i < maxSteps; i += 1) {
        const next = thrown ? gen.throw(thrown) : gen.next(input);
        thrown = null;
        if (next.done) return { kind: "return", value: next.value };
        const effect = next.value;
        if (effect?.effect === "continueAsNew") return { kind: "continueAsNew", input: effect.input };
        if (effect?.effect === "dequeueEvent" && !harness.hasDeliverable()) return { kind: "blocked" };
        input = harness.resolve(effect);
        if (input?.__throw) {
            thrown = input.__throw;
            input = undefined;
        }
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
    beforeEach(() => { mockSession = null; mockManager = null; proxyConfigs = []; });

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
            turnResults: [refusal(), refusal({ retryAfterMs: 10_000 }), refusal({ retryAfterMs: 400_000 }), refusal(), refusal(), refusal()],
            queue: [prompt("work")],
            fireTimers: 5,
        });
        drive(handler(h.ctx, INPUT()), h);
        // Step 2's 10 s from the provider is under the schedule's 2 min: the larger wins.
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
            turnResults: [refusal(), refusal(), ran({ type: "completed", content: "done" }), ran({ type: "completed", content: "next" })],
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
            turnResults: [refusal(), ran({ type: "completed", content: "answered" })],
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

    it("releasing affinity runs releaseWorkspace on the holder first, raced with a 10 s cap", async () => {
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

    const setCmd = (id, expectedRevision, workspace) => JSON.stringify({ type: "cmd", cmd: "set_workspace", id, args: { expectedRevision, workspace } });
    const responseOf = (h, id) => JSON.parse([...h.kv.entries()].find(([k]) => k === `command.response.${id}`)?.[1] ?? "null");

    it("an external set on an idle session checks the folder, bumps the revision, and forces no model turn (B6)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "completed", content: "first" }, { type: "completed", content: "second" }],
            queue: [
                prompt("first"),
                { afterTurns: 1, msg: setCmd("set-1", 1, { root: "a", folder: "b/" }) },
                { afterTurns: 1, msg: prompt("second") },
            ],
        });
        const outcome = drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        expect(h.checks.map((c) => c.args)).toEqual([{ workspace: { schema: 1, root: "a", folder: "b" }, revision: 2, turnIndex: 1 }]);
        expect(responseOf(h, "set-1").result).toEqual({ ok: true, changed: true, revision: 2, workspace: { schema: 1, root: "a", folder: "b" }, path: "/ws/a/b" });
        const changed = events(h, "session.workspace_changed").map((e) => e.data);
        expect(changed.at(-1)).toEqual({ workspace: { schema: 1, root: "a", folder: "b" }, revision: 2, path: "/ws/a/b", source: "external" });
        // The command itself ran no turn; the next message's turn carries the note and the new revision.
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1].prompt).toBe("second");
        expect(h.turns[1].opts.workspaceRevision).toBe(2);
        expect(h.turns[1].opts.workspaceNotice).toBe('The working directory changed from root "a", folder "sessions/s-1/app" to root "a", folder "b" (/ws/a/b).');
        expect(outcome.kind).not.toBe("continueAsNew");
        // The proxy the next turn runs on carries the new workspace (T2).
        expect(proxyConfigs.at(-1).workspace).toEqual({ schema: 1, root: "a", folder: "b" });
    });

    it("the idle timer stays armed across an external set (B6)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "completed", content: "first" }],
            queue: [prompt("first"), { afterTurns: 1, msg: setCmd("set-idle", 1, { root: "a", folder: "c" }) }],
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        expect(responseOf(h, "set-idle").result.changed).toBe(true);
        // Raced before the command and again after it: the same 30-minute hold.
        expect(h.timers.filter((ms) => ms === 1_800_000).length).toBeGreaterThanOrEqual(2);
        expect(h.turns).toHaveLength(1);
    });

    it("a stale expectedRevision changes nothing (B5)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "completed", content: "first" }],
            queue: [prompt("first"), { afterTurns: 1, msg: setCmd("stale", 7, { root: "a", folder: "b" }) }],
        });
        drive(handler(h.ctx, INPUT()), h);
        const response = responseOf(h, "stale");
        expect(response.error).toMatch(/^WORKSPACE_REVISION_CONFLICT/);
        expect(response.result).toEqual({ code: "WORKSPACE_REVISION_CONFLICT", revision: 1 });
        expect(h.checks).toHaveLength(0);
        expect(events(h, "session.workspace_changed").map((e) => e.data.source)).toEqual(["create"]);
    });

    it("a failed check keeps the old workspace and revision", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "completed", content: "first" }, { type: "completed", content: "second" }],
            queue: [prompt("first"), { afterTurns: 1, msg: setCmd("bad", 1, { root: "a", folder: "missing" }) }, { afterTurns: 1, msg: prompt("second") }],
            checkWorkspace: () => ({ ok: false, code: "WORKSPACE_FOLDER_MISSING", message: "folder does not exist" }),
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        const response = responseOf(h, "bad");
        expect(response.error).toBe("WORKSPACE_FOLDER_MISSING: folder does not exist");
        expect(response.result).toEqual({ code: "WORKSPACE_FOLDER_MISSING", revision: 1 });
        expect(h.turns[1].opts.workspaceRevision).toBe(1);
        expect(h.turns[1].opts.workspaceNotice).toBeUndefined();
    });

    it("the same folder answers 'no change'; a clear needs no check and drops the workspace (B4, B9)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "completed", content: "first" }, { type: "completed", content: "second" }],
            queue: [
                prompt("first"),
                { afterTurns: 1, msg: setCmd("same", 1, { root: "a", folder: "sessions/s-1/app" }) },
                { afterTurns: 1, msg: setCmd("clear", 1, null) },
                { afterTurns: 1, msg: prompt("second") },
            ],
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        expect(responseOf(h, "same").result).toEqual({ ok: true, changed: false, revision: 1, workspace: WORKSPACE });
        expect(responseOf(h, "clear").result).toEqual({ ok: true, changed: true, revision: 2, workspace: null, path: null });
        expect(h.checks).toHaveLength(0);
        expect(events(h, "session.workspace_changed").at(-1).data).toEqual({ workspace: null, revision: 2, path: null, source: "external" });
        // The revision still goes out after a clear: the worker then passes an
        // explicit folder and keeps repo hooks off (review R1).
        expect(h.turns[1].opts.workspaceRevision).toBe(2);
        expect(h.turns[1].opts.workspaceNotice).toBe('The working directory changed from root "a", folder "sessions/s-1/app" to the default working directory.');
    });

    it("a set or a clear during a workspace wait runs the held prompts at once", async () => {
        const handler = await latestHandler();
        for (const [id, workspace] of [["reset", { root: "a", folder: "other" }], ["cleared", null]]) {
            const h = createHarness({
                turnResults: [refusal(), { type: "completed", content: "ran" }],
                queue: [prompt("held"), { afterTurns: 1, msg: setCmd(id, 1, workspace) }],
            });
            drive(handler(h.ctx, INPUT()), h);
            expect(responseOf(h, id).result.changed).toBe(true);
            expect(h.turns).toHaveLength(2);
            expect(h.turns[1].bootstrap).toBe(true);
            expect(h.turns[1].opts.stashedPrompts).toEqual(["held"]);
            expect(h.timers).toEqual([30_000]);
        }
    });

    it("the agent's set_workspace is stored, announced, and followed by exactly one system-only turn in the new folder (B7)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [
                { type: "set_workspace", workspace: { schema: 1, root: "a", folder: "lib" }, path: "/ws/a/lib" },
                { type: "completed", content: "continued" },
            ],
            queue: [prompt("switch to lib, then fix the typo")],
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        expect(events(h, "session.workspace_changed").map((e) => e.data)).toEqual([
            { workspace: WORKSPACE, revision: 1, path: null, source: "create" },
            { workspace: { schema: 1, root: "a", folder: "lib" }, revision: 2, path: "/ws/a/lib", source: "agent" },
        ]);
        expect(h.turns).toHaveLength(2);
        const continuation = h.turns[1];
        expect(continuation.bootstrap).toBe(true);
        expect(continuation.prompt).toMatch(/^Internal orchestration wake-up/);
        expect(continuation.prompt).toMatch(/Continue your task in the new working directory/);
        expect(continuation.opts.workspaceRevision).toBe(2);
        expect(continuation.opts.workspaceNotice).toBe('The working directory changed from root "a", folder "sessions/s-1/app" to root "a", folder "lib" (/ws/a/lib).');
        // The set_workspace turn ran, so it used its index; the continuation is the next one.
        expect(continuation.turnIndex).toBe(1);
    });

    it("the agent's clear drops the workspace for the continuation turn", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "set_workspace", workspace: null, path: null }, { type: "completed", content: "done" }],
            queue: [prompt("leave the checkout")],
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        expect(events(h, "session.workspace_changed").at(-1).data).toEqual({ workspace: null, revision: 2, path: null, source: "agent" });
        expect(h.turns[1].opts.workspaceRevision).toBe(2);
        expect(h.turns[1].opts.workspaceNotice).toMatch(/to the default working directory\.$/);
    });

    it("the orchestration's spawn_agent: omitted inherits, a record replaces and asks for the check, null drops the workspace (B10)", async () => {
        const handler = await latestHandler();
        const spawnWith = (extra) => {
            const h = createHarness({
                turnResults: [{ type: "spawn_agent", task: "child task", ...extra }, { type: "completed", content: "done" }],
                queue: [prompt("spawn one")],
            });
            drive(handler(h.ctx, INPUT()), h);
            expect(h.spawns).toHaveLength(1);
            const [, childConfig, , , , , , , , , workspaceChosen] = h.spawns[0];
            return { childConfig, workspaceChosen, args: h.spawns[0] };
        };
        const inherited = spawnWith({});
        expect(inherited.childConfig.workspace).toEqual(WORKSPACE);
        expect(inherited.args).toHaveLength(10);

        const other = { schema: 1, root: "a", folder: "sessions/s-1/repo-b" };
        const chosen = spawnWith({ workspace: other });
        expect(chosen.childConfig.workspace).toEqual(other);
        expect(chosen.workspaceChosen).toBe(true);

        const none = spawnWith({ workspace: null });
        expect("workspace" in none.childConfig).toBe(false);
        expect(none.args).toHaveLength(10);
    });

    it("a session without a workspace carries no workspace fields and sends no revision", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "completed", content: "ok" }],
            // A model switch forces a continue-as-new, so the carried input is checked (T2).
            queue: [prompt("hello"), { afterTurns: 1, msg: JSON.stringify({ type: "cmd", cmd: "set_model", id: "m-1", args: { model: "fixture:other" } }) }],
        });
        const outcome = drive(handler(h.ctx, INPUT({ config: { model: "fixture:model" } })), h);
        expect(h.turns[0].opts.workspaceRevision).toBeUndefined();
        expect(h.turns[0].opts.workspaceNotice).toBeUndefined();
        expect(h.turns[0].opts.stashedAttachments).toBeUndefined();
        expect(outcome.kind).toBe("continueAsNew");
        for (const key of ["workspaceRevision", "workspaceStatus", "workspaceNotice", "workspaceHeldNote", "workspaceReleasePending", "workspaceRetry", "workspaceRetryScheduleMs"]) {
            expect(key in outcome.input, key).toBe(false);
        }
        expect(events(h, "session.workspace_available")).toHaveLength(0);
    });
});

describe("workspace gate: fixes from the adversarial review", () => {
    beforeEach(() => { mockSession = null; mockManager = null; proxyConfigs = []; });
    const setCmd = (id, expectedRevision, workspace) => JSON.stringify({ type: "cmd", cmd: "set_workspace", id, args: { expectedRevision, workspace } });
    const modelCmd = (id) => JSON.stringify({ type: "cmd", cmd: "set_model", id, args: { model: "fixture:other" } });
    const responseOf = (h, id) => JSON.parse([...h.kv.entries()].find(([k]) => k === `command.response.${id}`)?.[1] ?? "null");

    it("an error returned before the workspace check keeps the held prompt, the unavailable state and the retry step (F1)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [
                refusal(),
                // A failed budget query returns before the check, so the activity does not mark it.
                { type: "error", message: "Provider admission could not verify this turn: connection reset" },
            ],
            queue: [prompt("fix the bug", { clientMessageIds: ["cm-1"] })],
            fireTimers: 1,
        });
        const out = drive(handler(h.ctx, INPUT({ workspaceNotice: "The working directory changed from A to B." })), h);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.budgetStash).toEqual([{ prompt: "fix the bug", clientMessageIds: ["cm-1"] }]);
        expect(out.input.workspaceNotice).toBe("The working directory changed from A to B.");
        expect(out.input.workspaceStatus).toEqual({ state: "unavailable", code: "WORKSPACE_FOLDER_MISSING" });
        expect(out.input.workspaceRetry).toEqual({ step: 1, failures: { workerNodeId: "worker-a", count: 1 } });
        expect(events(h, "session.workspace_available")).toHaveLength(0);

        // The retry gets past the check: the held prompt runs once, and the workspace is back.
        const next = createHarness({ turnResults: [ran({ type: "completed", content: "fixed" })] });
        drive(handler(next.ctx, out.input), next);
        expect(next.turns[0].opts.stashedPrompts).toEqual(["fix the bug"]);
        expect(next.turns[0].opts.workspaceNotice).toBe("The working directory changed from A to B.");
        expect(events(next, "session.workspace_available")).toHaveLength(1);
        expect(events(next, "user.message")).toHaveLength(0);
    });

    it("a child's question to its parent keeps the attach mark, so the held prompt counts as delivered (F1)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal(), ran({ type: "completed", content: "QUESTION FOR PARENT: which branch?" })],
            queue: [prompt("pick a branch")],
            fireTimers: 1,
        });
        drive(handler(h.ctx, INPUT({ parentSessionId: "parent-1", nestingLevel: 1 })), h);
        expect(h.turns[1].opts.stashedPrompts).toEqual(["pick a branch"]);
        expect(events(h, "session.workspace_available")).toHaveLength(1);
    });

    it("a hold survives a continue-as-new, and the held prompt runs exactly once after it (M7)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal()],
            queue: [prompt("first", { clientMessageIds: ["cm-7"] }), { afterTurns: 1, msg: modelCmd("m-7") }],
        });
        const out = drive(handler(h.ctx, INPUT()), h);
        expect(out.kind).toBe("continueAsNew");

        const next = createHarness({ turnResults: [ran({ type: "completed", content: "done" })] });
        drive(handler(next.ctx, out.input), next);
        expect(next.turns).toHaveLength(1);
        expect(next.turns[0].opts.stashedPrompts).toEqual(["first"]);
        expect(events(next, "session.workspace_available")).toEqual([expect.objectContaining({ data: { revision: 1 } })]);
        expect(events(h, "user.message").length + events(next, "user.message").length).toBe(1);
    });

    it("a child update folded into a refused prompt reaches the next turn that runs, once (F2)", async () => {
        const handler = await latestHandler();
        const now = 1_750_000_000_000;
        const h = createHarness({
            turnResults: [refusal(), refusal(), ran({ type: "completed", content: "ok" }), ran({ type: "completed", content: "later" })],
            queue: [prompt("status?"), { afterTurns: 3, msg: prompt("anything else?") }],
            fireTimers: 2,
        });
        drive(handler(h.ctx, INPUT({
            subAgents: [{ orchId: "session-child-1", sessionId: "child-1", task: "run tests", status: "completed", result: "all 42 tests pass" }],
            pendingChildDigest: { startedAtMs: now, ready: false, updates: [{ sessionId: "child-1", updateType: "completed", content: "all 42 tests pass", observedAtMs: now }] },
        })), h);
        expect(h.turns[0].prompt).toMatch(/all 42 tests pass/);
        // Two refusals: the second, a retry wake, adds nothing of its own.
        const recovery = h.turns[2];
        expect(recovery.opts.stashedPrompts).toEqual(["status?"]);
        expect(recovery.opts.workspaceNotice).toMatch(/^Buffered child updates[\s\S]*all 42 tests pass[\s\S]*continue your task\.$/);
        expect(recovery.opts.workspaceNotice).not.toMatch(/Retrying the workspace/);
        expect(h.turns[3].prompt).toBe("anything else?");
        expect(h.turns[3].opts.workspaceNotice).toBeUndefined();
    });

    it("a final cron_at occurrence and a finished wait, refused by the check, reach the model with the retry (F5)", async () => {
        const handler = await latestHandler();
        const now = 1_750_000_000_000;
        const cron = createHarness({ turnResults: [refusal(), ran({ type: "completed", content: "deployed" })], fireTimers: 2 });
        drive(handler(cron.ctx, INPUT({
            cronAtSchedule: { reason: "deploy release 42", tz: "UTC", minute: 0, hour: 9, maxFires: 1, firesCompleted: 0, nextFireAtMs: now + 60_000, nextOccurrenceKey: "2026-09-27T09:00Z" },
            activeTimerState: { type: "cron_at", remainingMs: 60_000, originalDurationMs: 60_000, reason: "deploy release 42" },
        })), cron);
        expect(events(cron, "session.cron_at_completed")).toHaveLength(1);
        expect(cron.turns).toHaveLength(2);
        expect(cron.turns[1].opts.workspaceNotice).toMatch(/Scheduled wall-clock cron wake-up for "deploy release 42"/);

        const wait = createHarness({ turnResults: [refusal(), ran({ type: "completed", content: "built" })], fireTimers: 1 });
        drive(handler(wait.ctx, INPUT({
            activeTimerState: { type: "wait", remainingMs: 0, originalDurationMs: 120_000, reason: "wait for the build" },
        })), wait);
        expect(wait.turns[0].prompt).toMatch(/^The 120 second wait is now complete\./);
        expect(wait.turns[1].opts.workspaceNotice).toMatch(/^The 120 second wait is now complete\. Continue with your task\./);
        expect(wait.turns[1].opts.workspaceNotice).toMatch(/Wait reason: "wait for the build"/);
        // Machinery, never held as a user message.
        expect(events(wait, "user.message")).toHaveLength(0);
    });

    it("a refused retry keeps its retry count and does not record the retried prompt again (F4)", async () => {
        const handler = await latestHandler();
        // The first attempt ran, recorded the prompt, and failed.
        const first = createHarness({
            turnResults: [ran({ type: "error", message: "Copilot was taking too long to process and was killed." })],
            queue: [prompt("refactor the parser", { clientMessageIds: ["cm-9"] })],
        });
        const out = drive(handler(first.ctx, INPUT()), first);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.retryCount).toBe(1);

        const retry = createHarness({ turnResults: [refusal({ worker: "worker-b" }), ran({ type: "completed", content: "done" })], fireTimers: 1 });
        drive(handler(retry.ctx, out.input), retry);
        expect(retry.turns.map((t) => t.opts.retryCount)).toEqual([1, 1]);
        expect(retry.turns[1].opts.stashedPrompts).toEqual(["refactor the parser"]);
        expect(events(retry, "user.message")).toHaveLength(0);
    });

    it("after a clear, the release is owed across continue-as-new and runs at the next affinity release, once (F6)", async () => {
        const handler = await latestHandler();
        const cleared = createHarness({
            turnResults: [ran({ type: "completed", content: "started" })],
            queue: [prompt("start a build in the background"), { afterTurns: 1, msg: setCmd("clear-1", 1, null) }, { afterTurns: 1, msg: modelCmd("m-6a") }],
        });
        const carried = drive(handler(cleared.ctx, INPUT({ blobEnabled: true, idleTimeout: 60 })), cleared);
        expect(carried.kind).toBe("continueAsNew");
        expect(carried.input.workspaceReleasePending).toBe(true);
        expect(cleared.releases).toEqual([]);

        const h = createHarness({
            turnResults: [ran({ type: "completed", content: "started" })],
            queue: [
                prompt("start a build in the background"),
                { afterTurns: 1, msg: setCmd("clear-2", 1, null) },
                // Held back until the idle release ran, to read the state after it.
                { afterTurns: 1, afterReleases: 1, msg: modelCmd("m-6b") },
            ],
            fireTimers: 1,
        });
        const out = drive(handler(h.ctx, INPUT({ blobEnabled: true, idleTimeout: 60 })), h);
        expect(h.releases.map((r) => [r.args.reason, r.args.revision])).toEqual([["idle", 2]]);
        expect(out.kind).toBe("continueAsNew");
        expect("workspaceReleasePending" in out.input).toBe(false);

        // The agent's own clear owes the release the same way.
        const agent = createHarness({
            turnResults: [ran({ type: "set_workspace", workspace: null, path: null }), { type: "completed", content: "continued" }],
            queue: [prompt("leave the checkout")],
            fireTimers: 1,
        });
        drive(handler(agent.ctx, INPUT({ blobEnabled: true, idleTimeout: 60 })), agent);
        expect(agent.releases.map((r) => [r.args.reason, r.args.revision])).toEqual([["idle", 2]]);
    });

    it("a hold keeps the retry count across a continue-as-new (F4)", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [refusal()],
            queue: [{ afterTurns: 1, msg: modelCmd("m-4") }],
        });
        const out = drive(handler(h.ctx, INPUT({ prompt: "refactor the parser", retryCount: 1 })), h);
        expect(h.turns[0].opts.retryCount).toBe(1);
        expect(out.kind).toBe("continueAsNew");
        expect(out.input.retryCount).toBe(1);
    });

    it("the agent's own wait, interrupted by a refused message, resumes after the turn that runs", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [{ type: "wait", seconds: 600, reason: "wait for the build" }, refusal(), ran({ type: "completed", content: "answered" })],
            queue: [prompt("start the build"), { afterTurns: 1, msg: prompt("status?") }],
            fireTimers: 1,
        });
        drive(handler(h.ctx, INPUT({ idleTimeout: 1800 })), h);
        expect(h.turns).toHaveLength(3);
        expect(h.turns[2].opts.workspaceNotice).toMatch(/The timer will be automatically resumed after your reply/);
        // The wait, the retry, then the wait again with the time it still had.
        expect(h.timers).toEqual([600_000, 30_000, 600_000]);
    });

    it("a check activity that fails answers the command and leaves the session running", async () => {
        const handler = await latestHandler();
        const h = createHarness({
            turnResults: [ran({ type: "completed", content: "first" }), ran({ type: "completed", content: "second" })],
            queue: [prompt("first"), { afterTurns: 1, msg: setCmd("broken", 1, { root: "a", folder: "b" }) }, { afterTurns: 1, msg: prompt("second") }],
            checkWorkspace: () => new Error("activity checkWorkspace is not registered on this worker"),
        });
        drive(handler(h.ctx, INPUT({ blobEnabled: true })), h);
        const response = responseOf(h, "broken");
        expect(response.error).toMatch(/^WORKSPACE_ATTACH_FAILED: the workspace check did not run: activity checkWorkspace is not registered/);
        expect(response.result).toEqual({ code: "WORKSPACE_ATTACH_FAILED", revision: 1 });
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1].opts.workspaceRevision).toBe(1);
    });
});
