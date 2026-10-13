/**
 * Session turn control, phase A4: the runTurnV4 activity path (design 4.7,
 * 4.8, 5.1, 5.2; Spec FR-009..FR-013, FR-021; plan P12, P15, P17, P21, P23).
 *
 * The activity runs with a fake session manager, model session and catalog;
 * the lifecycle cases use a real filesystem snapshot store. The catalog
 * procedures themselves are covered by turn-control-cms.test.js.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { readTurnCommitFile } from "../../src/snapshot-protocol.ts";
import { CARRIED_STEERS_WAKE_PROMPT } from "../../src/turn-control-contract.ts";
import { appendSystemContextBlock } from "../../src/prompt-system-context.ts";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const roots = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });

/** A fake turn-control catalog: records calls in order and plays back answers. */
function turnControlCatalog({ start = { stopped: false, controls: [] }, writeback = false, end = { stopped: false, late: [] }, endFailures = 0 } = {}) {
    const calls = [];
    let failuresLeft = endFailures;
    const extras = {
        setActiveTurnIndex: vi.fn(async (...args) => { calls.push(["setActiveTurnIndex", ...args]); }),
        turnStart: vi.fn(async (...args) => { calls.push(["turnStart", ...args]); return typeof start === "function" ? start() : start; }),
        completeTurnWriteback: vi.fn(async (input) => {
            calls.push(["completeTurnWriteback", input.turnIndex]);
            if (writeback instanceof Error) throw writeback;
            return writeback;
        }),
        turnEnd: vi.fn(async (...args) => {
            calls.push(["turnEnd", ...args]);
            if (failuresLeft > 0) { failuresLeft -= 1; throw new Error("database unavailable"); }
            return typeof end === "function" ? end(...args) : end;
        }),
    };
    return { calls, extras };
}

/**
 * A model session that has a send gate, like ManagedSession with turn control:
 * the run attaches its port to the binding, opens the gate after the initial
 * send and detaches when it ends.
 */
function steeringSession() {
    let gate = "pending";
    const sent = [];
    const port = {
        gate: () => gate,
        close: () => { gate = "closed"; },
        sendSteer: async (text, onConfirmed) => { sent.push(text); onConfirmed(`m-${sent.length}`); },
        failTurn: () => {},
    };
    return {
        sent,
        extras: {},
        open(binding) { binding.attach(port); gate = "open"; binding.gateOpened(); },
        close(binding) { gate = "closed"; binding.detach(); },
    };
}

function lifecycleDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-tc-run-turn-"));
    roots.push(root);
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { sessionStateDir, store: new FilesystemSessionStore(path.join(root, "session-store"), sessionStateDir) };
}

describe("runTurnV4: turn control around the model run", () => {
    it("a turn without controls makes today's catalog calls and saves no cursor", async () => {
        const { sessionStateDir, store } = lifecycleDirs();
        const v4 = turnControlCatalog({ writeback: false });
        const sessionId = `tc-${randomUUID()}`;
        const h = makeRunTurnHarness({
            catalogExtras: v4.extras, sessionStore: store, sessionStateDir,
            turn: async () => { makeSessionLayout(sessionStateDir, sessionId); return { type: "completed", content: "ok" }; },
        });
        const result = await h.runTurn(sessionId, { turnIndex: 3, snapshot: { turnKey: "k3" } }, "runTurnV4");
        expect(result.type).toBe("completed");
        expect(v4.calls.map((c) => c[0])).toEqual(["turnStart", "completeTurnWriteback"]);
        expect(readTurnCommitFile(path.join(sessionStateDir, sessionId)).result.controlCursor).toBeUndefined();

        const v3 = turnControlCatalog({ writeback: false });
        const legacy = makeRunTurnHarness({ catalogExtras: v3.extras });
        await legacy.runTurn("legacy", { turnIndex: 3 }, "runTurnV3");
        expect(v3.calls.map((c) => c[0])).toEqual(["setActiveTurnIndex", "completeTurnWriteback"]);
        expect(v4.calls.length).toBe(v3.calls.length);
    });

    it("folds steers accepted before the turn started after the prompt, and ends from their position", async () => {
        const v4 = turnControlCatalog({ start: { stopped: false, controls: [control(31, "steer", "use the v2 API")] }, writeback: true });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        await h.runTurn("s", { turnIndex: 2 }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][0]).toBe("go\n\nuse the v2 API");
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 2, 31, "other", []]);
        expect(h.recordedEvents.filter((e) => e.data?.content === "use the v2 API")).toEqual([]);
    });

    it("an open Stop at turn start ends the turn without a model run", async () => {
        const v4 = turnControlCatalog({
            start: { stopped: false, controls: [control(40, "steer"), control(41, "stop", "wrong way")] },
            end: { stopped: true, late: [] },
        });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        const result = await h.runTurn("s", { turnIndex: 5 }, "runTurnV4");
        expect(result).toMatchObject({ type: "stopped", reason: "wrong way" });
        expect(h.session.runTurn).not.toHaveBeenCalled();
        expect(v4.calls.map((c) => c[0])).toEqual(["turnStart", "turnEnd"]);
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 5, 0, "stopped", []]);
    });

    it("a recorded stopped outcome at turn start ends the turn without a model run", async () => {
        const v4 = turnControlCatalog({ start: { stopped: true, controls: [] }, end: { stopped: true, late: [] } });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        const result = await h.runTurn("s", { turnIndex: 5 }, "runTurnV4");
        expect(result.type).toBe("stopped");
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a stale turn start throws", async () => {
        const v4 = turnControlCatalog({ start: { stale: true } });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        await expect(h.runTurn("s", { turnIndex: 1 }, "runTurnV4")).rejects.toThrow(/stale/);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("maps turn end to the activity result: stopped wins, late steers ride along", async () => {
        const stopped = turnControlCatalog({ writeback: true, end: { stopped: true, late: [] } });
        const a = makeRunTurnHarness({ catalogExtras: stopped.extras, turn: async () => ({ type: "error", message: "model failed" }) });
        expect(await a.runTurn("s", { turnIndex: 1 }, "runTurnV4")).toMatchObject({ type: "stopped" });
        expect(stopped.calls.at(-1)).toEqual(["turnEnd", "s", 1, 0, "error", []]);

        const late = turnControlCatalog({ writeback: true, end: { stopped: false, late: [{ seq: 9, text: "late" }] } });
        const b = makeRunTurnHarness({ catalogExtras: late.extras });
        expect(await b.runTurn("s", { turnIndex: 1 }, "runTurnV4")).toMatchObject({ type: "completed", lateSteers: [{ seq: 9, text: "late" }] });
    });

    it("retries turn end in place, and fails the activity when it keeps failing", async () => {
        const once = turnControlCatalog({ writeback: true, endFailures: 1 });
        const a = makeRunTurnHarness({ catalogExtras: once.extras });
        expect((await a.runTurn("s", { turnIndex: 1 }, "runTurnV4")).type).toBe("completed");
        expect(once.calls.filter((c) => c[0] === "turnEnd").length).toBe(2);

        const always = turnControlCatalog({ writeback: true, endFailures: 5 });
        const b = makeRunTurnHarness({ catalogExtras: always.extras });
        await expect(b.runTurn("s", { turnIndex: 1 }, "runTurnV4")).rejects.toThrow(/database unavailable/);
        expect(always.calls.filter((c) => c[0] === "turnEnd").length).toBe(3);
    });

    it("a failed end-of-turn write still runs turn end (P15)", async () => {
        const v4 = turnControlCatalog({ writeback: new Error("write lost") });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        await h.runTurn("s", { turnIndex: 1 }, "runTurnV4");
        expect(v4.calls.filter((c) => c[0] === "turnEnd").length).toBe(1);
    }, 15_000);

    it("a live steer moves the cursor, which the save carries and turn end uses", async () => {
        const { sessionStateDir, store } = lifecycleDirs();
        const v4 = turnControlCatalog({ writeback: true });
        const s = steeringSession();
        const sessionId = `tc-${randomUUID()}`;
        const h = makeRunTurnHarness({
            catalogExtras: v4.extras, sessionExtras: s.extras, sessionStore: store, sessionStateDir,
            turn: async (opts) => {
                makeSessionLayout(sessionStateDir, sessionId);
                s.open(opts.turnControl);
                await opts.turnControl.enqueue([control(31, "steer", "use the v2 API")]);
                s.close(opts.turnControl);
                return { type: "completed", content: "ok" };
            },
        });
        await h.runTurn(sessionId, { turnIndex: 4, snapshot: { turnKey: "k4" } }, "runTurnV4");
        expect(s.sent).toEqual(["use the v2 API"]);
        expect(readTurnCommitFile(path.join(sessionStateDir, sessionId)).result.controlCursor).toEqual({ turn: 4, cursor: 31 });
        expect(v4.calls.at(-1)).toEqual(["turnEnd", sessionId, 4, 31, "other", []]);
        expect(h.recordedEvents.filter((e) => e.eventType === "session.steer_confirmed")).toEqual([
            { eventType: "session.steer_confirmed", data: { seq: 31, turn: 4, messageId: "m-1" } },
        ]);
    });

    it("after a crash between the save and turn end, the retry reuses the saved result and cursor without a model run", async () => {
        const { sessionStateDir, store } = lifecycleDirs();
        const v4 = turnControlCatalog({ writeback: true, endFailures: 3 });
        const s = steeringSession();
        const sessionId = `tc-${randomUUID()}`;
        const h = makeRunTurnHarness({
            catalogExtras: v4.extras, sessionExtras: s.extras, sessionStore: store, sessionStateDir,
            turn: async (opts) => {
                makeSessionLayout(sessionStateDir, sessionId);
                s.open(opts.turnControl);
                await opts.turnControl.enqueue([control(31, "steer")]);
                s.close(opts.turnControl);
                return { type: "completed", content: "saved answer" };
            },
        });
        const input = { turnIndex: 4, snapshot: { turnKey: "k4" } };
        await expect(h.runTurn(sessionId, input, "runTurnV4")).rejects.toThrow(/database unavailable/);
        const result = await h.runTurn(sessionId, input, "runTurnV4");
        expect(result).toMatchObject({ type: "completed", content: "saved answer" });
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(v4.calls.at(-1)).toEqual(["turnEnd", sessionId, 4, 31, "other", []]);
        expect(v4.calls.filter((c) => c[0] === "turnStart").length).toBe(1);
    });

    it("a stopped turn ends as stopped, whatever its cursor", async () => {
        const v4 = turnControlCatalog({ writeback: true, end: { stopped: true, late: [] } });
        const s = steeringSession();
        const h = makeRunTurnHarness({
            catalogExtras: v4.extras, sessionExtras: s.extras,
            turn: async (opts) => {
                s.open(opts.turnControl);
                await opts.turnControl.enqueue([control(31, "steer")]);
                s.close(opts.turnControl);
                return { type: "stopped", reason: "Stopped by user" };
            },
        });
        // Storeless (D4): the live cursor is 31, but a stopped turn ends with
        // every steer not delivered, decided by turn end from the result kind.
        const result = await h.runTurn("s", { turnIndex: 4 }, "runTurnV4");
        expect(result.type).toBe("stopped");
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 4, 31, "stopped", []]);
    });
});

describe("runTurnV4: an in-attempt recovery re-run keeps every folded steer", () => {
    const lost = { type: "error", message: "Request session.send failed with message: Session not found: s" };
    const corrupted = {
        type: "error",
        message: "400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: call_a",
    };
    const twoRuns = (first, onFirst) => {
        let calls = 0;
        return async (opts) => {
            calls += 1;
            if (calls === 1) {
                await onFirst?.(opts);
                return first;
            }
            return { type: "completed", content: "recovered" };
        };
    };

    it("a lost live session after turn start: the re-run holds the carried and turn-start steers, and turn end labels them from that prompt", async () => {
        const v4 = turnControlCatalog({ start: { stopped: false, controls: [control(31, "steer", "use the v2 API")] }, writeback: true });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras, turn: twoRuns(lost) });
        const result = await h.runTurn("s", {
            turnIndex: 6, prompt: CARRIED_STEERS_WAKE_PROMPT, carriedSteers: [{ seq: 5, text: "carried guidance" }],
        }, "runTurnV4");
        expect(h.session.runTurn).toHaveBeenCalledTimes(2);
        const [first, rerun] = h.session.runTurn.mock.calls.map((c) => c[0]);
        expect(first).toBe("carried guidance\n\nuse the v2 API");
        expect(rerun).toContain("runtime recovered this session");
        expect(rerun).toContain("carried guidance\n\nuse the v2 API");
        expect(rerun).not.toContain(CARRIED_STEERS_WAKE_PROMPT);
        expect(result).toMatchObject({ type: "completed", carriedSteersConsumed: true });
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 6, 31, "other", [5]]);
    });

    it("a corrupted transcript: the re-run holds the turn-start steer; a steer confirmed only in the lost conversation is carried", async () => {
        const v4 = turnControlCatalog({ start: { stopped: false, controls: [control(31, "steer", "use the v2 API")] }, writeback: true });
        const s = steeringSession();
        const h = makeRunTurnHarness({
            catalogExtras: v4.extras, sessionExtras: s.extras,
            turn: twoRuns(corrupted, async (opts) => {
                s.open(opts.turnControl);
                await opts.turnControl.enqueue([control(40, "steer", "live guidance")]);
                s.close(opts.turnControl);
            }),
        });
        const result = await h.runTurn("s", { turnIndex: 7, prompt: "check the tree" }, "runTurnV4");
        expect(s.sent).toEqual(["live guidance"]);
        const rerun = h.session.runTurn.mock.calls[1][0];
        expect(rerun).toContain("live Copilot transcript became inconsistent");
        expect(rerun).toContain("check the tree\n\nuse the v2 API");
        expect(rerun).not.toContain("live guidance");
        expect(result.type).toBe("completed");
        // Cursor 31: the folded steer is delivered by the re-run; 40 is above it, so turn end carries it.
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 7, 31, "other", []]);
    });

    it("a legacy (V3) recovery re-run is unchanged: the original prompt only", async () => {
        const v3 = turnControlCatalog({ writeback: true });
        const h = makeRunTurnHarness({ catalogExtras: v3.extras, turn: twoRuns(lost) });
        await h.runTurn("s", { turnIndex: 2, prompt: "plain prompt", carriedSteers: [{ seq: 5, text: "x" }] }, "runTurnV3");
        const rerun = h.session.runTurn.mock.calls[1][0];
        expect(rerun).toContain("runtime recovered this session");
        expect(rerun).toContain("plain prompt");
        expect(rerun).not.toContain("x\n\nplain prompt");
    });

    it("turn-start steers go before a trailing system-context block, which stays last", async () => {
        const v4 = turnControlCatalog({ start: { stopped: false, controls: [control(31, "steer", "use the v2 API")] }, writeback: true });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        await h.runTurn("s", { turnIndex: 2, prompt: appendSystemContextBlock("go", "turn note") }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][0]).toBe(appendSystemContextBlock("go\n\nuse the v2 API", "turn note"));
    });
});

describe("runTurnV4: carried steers (P12, P17, D6)", () => {
    const carriedSteers = [{ seq: 5, text: "carried guidance" }];

    it("replaces the carried-steers wake prompt, records nothing new, closes them at turn end and reports consumption", async () => {
        const v4 = turnControlCatalog({ writeback: false });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        const result = await h.runTurn("s", { turnIndex: 6, prompt: CARRIED_STEERS_WAKE_PROMPT, carriedSteers }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][0]).toBe("carried guidance");
        expect(h.recordedEvents.filter((e) => e.eventType === "user.message" || e.eventType === "system.message")).toEqual([]);
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 6, 0, "other", [5]]);
        expect(result.carriedSteersConsumed).toBe(true);
    });

    it("folds carried steers in front of a new prompt", async () => {
        const v4 = turnControlCatalog({ writeback: false });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        await h.runTurn("s", { turnIndex: 6, prompt: "the user's answer", carriedSteers }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][0]).toBe("carried guidance\n\nthe user's answer");
    });

    it("a returned error keeps them: no consumption", async () => {
        const v4 = turnControlCatalog({ writeback: false });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras, turn: async () => ({ type: "error", message: "boom" }) });
        const result = await h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4");
        expect(result.carriedSteersConsumed).toBeUndefined();
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 6, 0, "error", [5]]);
    });

    it("a thrown model run keeps them: the activity throws", async () => {
        const v4 = turnControlCatalog({ writeback: false });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras, turn: async () => { throw new Error("socket closed"); } });
        await expect(h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4")).rejects.toThrow(/socket closed/);
        expect(v4.calls.some((c) => c[0] === "turnEnd")).toBe(false);
    });

    it("a budget wait keeps them: the gate returns before turn start", async () => {
        const v4 = turnControlCatalog();
        const checkTurn = vi.fn(async () => ({
            verdict: "paused", providerName: "p", modelQualified: null, exempt: false,
            pause: { kind: "limit", provider: "p" }, rules: [],
        }));
        const h = makeRunTurnHarness({ catalogExtras: { ...v4.extras, providers: { checkTurn } } });
        const result = await h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4");
        expect(checkTurn).toHaveBeenCalled();
        expect(result).toMatchObject({ type: "wait", budget: true });
        expect(result.carriedSteersConsumed).toBeUndefined();
        expect(v4.calls).toEqual([]);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a provider-admission error keeps them: the error returns before turn start", async () => {
        const v4 = turnControlCatalog();
        const checkTurn = vi.fn(async () => { throw new Error("connection reset"); });
        const h = makeRunTurnHarness({ catalogExtras: { ...v4.extras, providers: { checkTurn } } });
        const result = await h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4");
        expect(result).toMatchObject({ type: "error" });
        expect(result.message).toMatch(/Provider admission could not verify this turn/);
        expect(result.carriedSteersConsumed).toBeUndefined();
        expect(v4.calls).toEqual([]);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a failed turn start keeps them: the activity throws, no model run, no turn end", async () => {
        const v4 = turnControlCatalog({ start: () => { throw new Error("turn start failed"); } });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        await expect(h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4")).rejects.toThrow(/turn start failed/);
        expect(v4.calls.map((c) => c[0])).toEqual(["turnStart"]);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a stale start keeps them", async () => {
        const v4 = turnControlCatalog({ start: { stale: true } });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        await expect(h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4")).rejects.toThrow(/stale/);
    });

    it("a Stop at turn start takes them as stopped (D6)", async () => {
        const v4 = turnControlCatalog({ start: { stopped: false, controls: [control(9, "stop")] }, end: { stopped: true, late: [] } });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras });
        const result = await h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4");
        expect(result).toMatchObject({ type: "stopped", carriedSteersConsumed: true });
        expect(v4.calls.at(-1)).toEqual(["turnEnd", "s", 6, 0, "stopped", [5]]);
    });

    it("an error turned stopped by an open Stop closes them as stopped and consumes them", async () => {
        let call = 0;
        const v4 = turnControlCatalog({ writeback: true, end: () => ({ stopped: (call += 1) >= 1, late: [] }) });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras, turn: async () => ({ type: "error", message: "boom" }) });
        const result = await h.runTurn("s", { turnIndex: 6, carriedSteers }, "runTurnV4");
        expect(result).toMatchObject({ type: "stopped", carriedSteersConsumed: true });
        expect(v4.calls.filter((c) => c[0] === "turnEnd").map((c) => c[4])).toEqual(["error", "stopped"]);
    });

    it("the already-saved path consumes them", async () => {
        const { sessionStateDir, store } = lifecycleDirs();
        const v4 = turnControlCatalog({ writeback: false, endFailures: 3 });
        const sessionId = `tc-${randomUUID()}`;
        const h = makeRunTurnHarness({
            catalogExtras: v4.extras, sessionStore: store, sessionStateDir,
            turn: async () => { makeSessionLayout(sessionStateDir, sessionId); return { type: "completed", content: "ok" }; },
        });
        const input = { turnIndex: 6, snapshot: { turnKey: "k6" }, carriedSteers };
        await expect(h.runTurn(sessionId, input, "runTurnV4")).rejects.toThrow();
        const result = await h.runTurn(sessionId, input, "runTurnV4");
        expect(result.carriedSteersConsumed).toBe(true);
        expect(v4.calls.at(-1)).toEqual(["turnEnd", sessionId, 6, 0, "other", [5]]);
    });
});

describe("runTurnV4: an attempt re-dispatched after turn start records the prompt once", () => {
    const recorded = (h) => h.recordedEvents.filter((e) => e.eventType === "user.message" || e.eventType === "system.message").map((e) => e.eventType);
    const input = { turnIndex: 4, prompt: "check the build", config: { turnSystemPrompt: "turn note" } };

    it("the first attempt records the prompt and the system message", async () => {
        const v4 = turnControlCatalog({ writeback: false });
        const h = makeRunTurnHarness({
            catalogExtras: { ...v4.extras, getSession: vi.fn(async (sessionId) => ({ sessionId, owner: null, turnHigh: 3 })) },
        });
        await h.runTurn("s", input, "runTurnV4");
        expect(recorded(h)).toEqual(["system.message", "user.message"]);
        expect(v4.calls.map((c) => c[0])).toContain("turnStart");
    });

    it("an attempt after an earlier one passed turn start (worker loss) records nothing again", async () => {
        const v4 = turnControlCatalog({ writeback: false });
        const h = makeRunTurnHarness({
            catalogExtras: { ...v4.extras, getSession: vi.fn(async (sessionId) => ({ sessionId, owner: null, turnHigh: 4 })) },
        });
        const result = await h.runTurn("s", input, "runTurnV4");
        expect(result.type).toBe("completed");
        expect(recorded(h)).toEqual([]);
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
    });

    it("runTurnV3 keeps recording on a re-dispatch, as before", async () => {
        const v3 = turnControlCatalog({ writeback: false });
        const h = makeRunTurnHarness({
            catalogExtras: { ...v3.extras, getSession: vi.fn(async (sessionId) => ({ sessionId, owner: null, turnHigh: 4 })) },
        });
        await h.runTurn("s", input, "runTurnV3");
        expect(recorded(h)).toEqual(["system.message", "user.message"]);
    });
});

describe("runTurnV3 is unchanged", () => {
    it("never calls turn start or turn end, and ignores carried steers", async () => {
        const v3 = turnControlCatalog({ writeback: true });
        const h = makeRunTurnHarness({ catalogExtras: v3.extras });
        const result = await h.runTurn("s", { turnIndex: 2, carriedSteers: [{ seq: 5, text: "x" }] }, "runTurnV3");
        expect(v3.calls.map((c) => c[0])).toEqual(["setActiveTurnIndex", "completeTurnWriteback"]);
        expect(h.session.runTurn.mock.calls[0][0]).toBe("go");
        expect(h.session.runTurn.mock.calls[0][1].turnControl).toBeUndefined();
        expect(result.carriedSteersConsumed).toBeUndefined();
    });
});

describe("runTurnV4: workspace sessions report the attach on every result", () => {
    function workspaceHarness(v4, turn, { refuse = false } = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-tc-ws-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "repo"), { recursive: true });
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        if (refuse) provider.script({ type: "fail", code: "WORKSPACE_IN_USE", message: "held elsewhere" });
        return makeRunTurnHarness({
            catalogExtras: v4.extras,
            workspaceProvider: provider,
            managerExtras: { holdWorkspaceFolders: vi.fn(), noteWorkspaceAttached: vi.fn() },
            ...(turn ? { turn } : {}),
        });
    }
    const workspaceInput = (extra = {}) => ({ turnIndex: 3, workspaceRevision: 1, config: { workspace: { schema: 1, root: "a", folder: "repo" } }, ...extra });

    it("a Stop applied at turn start", async () => {
        const v4 = turnControlCatalog({ start: { stopped: false, controls: [control(9, "stop")] }, end: { stopped: true, late: [] } });
        const h = workspaceHarness(v4);
        const result = await h.runTurn("s", workspaceInput(), "runTurnV4");
        expect(result).toMatchObject({ type: "stopped", workspaceAttached: true });
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a carried-steers-only turn", async () => {
        const v4 = turnControlCatalog({ writeback: false });
        const h = workspaceHarness(v4);
        const result = await h.runTurn("s", workspaceInput({ prompt: CARRIED_STEERS_WAKE_PROMPT, carriedSteers: [{ seq: 5, text: "carried" }] }), "runTurnV4");
        expect(result).toMatchObject({ type: "completed", workspaceAttached: true, carriedSteersConsumed: true });
    });

    it("a workspace wait keeps carried steers: no turn start, no consumption", async () => {
        const v4 = turnControlCatalog();
        const h = workspaceHarness(v4, undefined, { refuse: true });
        const result = await h.runTurn("s", workspaceInput({ prompt: CARRIED_STEERS_WAKE_PROMPT, carriedSteers: [{ seq: 5, text: "carried" }] }), "runTurnV4");
        expect(result).toMatchObject({ type: "wait", gate: "workspace" });
        expect(result.carriedSteersConsumed).toBeUndefined();
        expect(v4.calls).toEqual([]);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a turn the workspace gate refuses never starts: no turn start, no turn end", async () => {
        const v4 = turnControlCatalog();
        const h = workspaceHarness(v4, undefined, { refuse: true });
        const result = await h.runTurn("s", workspaceInput(), "runTurnV4");
        expect(result).toMatchObject({ type: "wait", gate: "workspace" });
        expect(v4.calls).toEqual([]);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a turn that ends stopped", async () => {
        const v4 = turnControlCatalog({ writeback: true, end: { stopped: true, late: [] } });
        const h = workspaceHarness(v4, async () => ({ type: "completed", content: "done" }));
        const result = await h.runTurn("s", workspaceInput(), "runTurnV4");
        expect(result).toMatchObject({ type: "stopped", workspaceAttached: true });
    });
});
