/**
 * Durable recipient intake, inactive: the turn activities of orchestration
 * 1.0.83, runTurnV5 / runTurnEpochV5 (design
 * docs/proposals/workflow-durable-intake.md 5.5 and section 8). They run the
 * turn-control path of runTurnV4 with the invocation that the input's
 * `intake` field carries, and only a test registers them.
 *
 * - The carried items' texts go before whatever prompt the attempt finally
 *   sends to the model, in a recovery re-run as well; the transcript records
 *   the prompt alone, as before.
 * - Every result names the invocation with the attempt's witness: sent once
 *   the model request that included the items was made, not sent when the
 *   turn ended before it. A saved result that a retry adopts keeps the
 *   witness of the attempt that ran.
 * - A malformed field fails the activity before any model run; runTurnV4
 *   ignores the field.
 *
 * The activity runs with a fake session manager, model session and catalog;
 * the adoption case uses a real filesystem snapshot store.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { registerActivities } from "../../src/session-proxy.ts";

const roots = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

const TEXT = "[SYSTEM: A workflow sent you a typed message.]\n{\"n\":1}";
const INTAKE = {
    invocationId: "inv-1",
    items: [{ exchangeId: `nx-${"1".repeat(40)}`, clientMessageId: `workflow:wf:run:send:nx-${"1".repeat(40)}`, text: TEXT }],
};

/** A fake turn-control catalog, as in turn-control-run-turn.test.js: records calls in order and plays back answers. */
function turnControlCatalog({ start = { stopped: false, controls: [] }, writeback = false, end = { stopped: false, late: [] }, endFailures = 0 } = {}) {
    const calls = [];
    let failuresLeft = endFailures;
    const extras = {
        setActiveTurnIndex: vi.fn(async (...args) => { calls.push(["setActiveTurnIndex", ...args]); }),
        turnStart: vi.fn(async (...args) => { calls.push(["turnStart", ...args]); return start; }),
        completeTurnWriteback: vi.fn(async (input) => { calls.push(["completeTurnWriteback", input.turnIndex]); return writeback; }),
        turnEnd: vi.fn(async (...args) => {
            calls.push(["turnEnd", ...args]);
            if (failuresLeft > 0) { failuresLeft -= 1; throw new Error("database unavailable"); }
            return end;
        }),
    };
    return { calls, extras };
}

function lifecycleDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-intake-turn-"));
    roots.push(root);
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { sessionStateDir, store: new FilesystemSessionStore(path.join(root, "session-store"), sessionStateDir) };
}

/**
 * The runTurn activity harness, with 1.0.83's turn activities registered over
 * the same fakes, as a test registers them (registerActivities' test option).
 */
function intakeHarness(options = {}) {
    const h = makeRunTurnHarness(options);
    const handlers = {};
    registerActivities({ registerActivity(name, handler) { handlers[name] = handler; } }, h.sessionManager, options.sessionStore ?? null, undefined,
        h.catalog, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "worker-1", undefined, undefined,
        { workflowIntakeTurns: true });
    const activityCtx = { traceInfo: () => {}, traceWarn: () => {}, isCancelled: () => false };
    return {
        ...h,
        handlers,
        runTurnV5: (sessionId, inputOverrides = {}, name = "runTurnV5") => handlers[name](activityCtx, {
            sessionId, prompt: "go", config: {}, turnIndex: 0, ...inputOverrides,
        }),
    };
}

describe("runTurnV5: the turn of an invocation", () => {
    it("is registered only with the test option; runTurnV4 ignores an intake field", async () => {
        expect(makeRunTurnHarness().handlers.runTurnV5).toBeUndefined();
        const h = intakeHarness({ catalogExtras: turnControlCatalog().extras });
        expect(Object.keys(h.handlers).filter((name) => name.endsWith("V5"))).toEqual(["runTurnV5", "runTurnEpochV5"]);
        const result = await h.runTurn("s", { turnIndex: 2, intake: INTAKE }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][0]).toBe("go");
        expect(result.intakeDispatch).toBeUndefined();
    });

    it("puts the carried items before the prompt the model gets and returns the witness, sent; the transcript records the prompt alone", async () => {
        const v4 = turnControlCatalog();
        const h = intakeHarness({ catalogExtras: v4.extras });
        const result = await h.runTurnV5("s", { turnIndex: 2, intake: INTAKE });
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(h.session.runTurn.mock.calls[0][0]).toBe(`${TEXT}\n\ngo`);
        expect(result).toMatchObject({ type: "completed", intakeDispatch: { invocationId: "inv-1", sent: true } });
        // Turn start records the turn's prompt, without the items.
        const [, , , records] = v4.calls.find((call) => call[0] === "turnStart");
        expect(records).toEqual([{ eventType: "user.message", data: { content: "go" } }]);
        // The epoch-start name runs the same path.
        const epoch = await h.runTurnV5("s", { turnIndex: 3, intake: INTAKE }, "runTurnEpochV5");
        expect(epoch).toMatchObject({ intakeDispatch: { invocationId: "inv-1", sent: true } });
    });

    it("a Stop at turn start: no model run, and the witness says not sent", async () => {
        const v4 = turnControlCatalog({ start: { stopped: true, controls: [] }, end: { stopped: true, late: [] } });
        const h = intakeHarness({ catalogExtras: v4.extras });
        const result = await h.runTurnV5("s", { turnIndex: 5, intake: INTAKE });
        expect(h.session.runTurn).not.toHaveBeenCalled();
        expect(result).toMatchObject({ type: "stopped", intakeDispatch: { invocationId: "inv-1", sent: false } });
    });

    it("an error after the model ran carries the witness, sent", async () => {
        const v4 = turnControlCatalog({ writeback: true });
        const h = intakeHarness({ catalogExtras: v4.extras, turn: async () => ({ type: "error", message: "model failed" }) });
        const result = await h.runTurnV5("s", { turnIndex: 1, intake: INTAKE });
        expect(result).toMatchObject({ type: "error", message: "model failed", intakeDispatch: { invocationId: "inv-1", sent: true } });
    });

    it("an in-attempt recovery re-run puts the carried items before its own prompt again", async () => {
        const lost = { type: "error", message: "Request session.send failed with message: Session not found: s" };
        let calls = 0;
        const v4 = turnControlCatalog({ writeback: true });
        const h = intakeHarness({
            catalogExtras: v4.extras,
            turn: async () => (++calls === 1 ? lost : { type: "completed", content: "recovered" }),
        });
        const result = await h.runTurnV5("s", { turnIndex: 6, prompt: "check the tree", intake: INTAKE });
        expect(h.session.runTurn).toHaveBeenCalledTimes(2);
        const [first, rerun] = h.session.runTurn.mock.calls.map((call) => call[0]);
        expect(first).toBe(`${TEXT}\n\ncheck the tree`);
        expect(rerun.startsWith(`${TEXT}\n\n`)).toBe(true);
        expect(rerun).toContain("runtime recovered this session");
        expect(rerun).toContain("check the tree");
        expect(result).toMatchObject({ type: "completed", intakeDispatch: { invocationId: "inv-1", sent: true } });
    });

    it("a retry that adopts the saved result returns the witness of the attempt that ran, with no second model run", async () => {
        const { sessionStateDir, store } = lifecycleDirs();
        const v4 = turnControlCatalog({ writeback: true, endFailures: 3 });
        const sessionId = `intake-${randomUUID()}`;
        const h = intakeHarness({
            catalogExtras: v4.extras, sessionStore: store, sessionStateDir,
            turn: async () => { makeSessionLayout(sessionStateDir, sessionId); return { type: "completed", content: "saved answer" }; },
        });
        const input = { turnIndex: 4, snapshot: { turnKey: "k4" }, intake: INTAKE };
        // The turn is saved, then its turn end keeps failing: the attempt throws after the save.
        await expect(h.runTurnV5(sessionId, input)).rejects.toThrow(/database unavailable/);
        const result = await h.runTurnV5(sessionId, input);
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ type: "completed", content: "saved answer", intakeDispatch: { invocationId: "inv-1", sent: true } });
    });

    it("a malformed intake field fails the activity before any model run", async () => {
        const h = intakeHarness({ catalogExtras: turnControlCatalog().extras });
        await expect(h.runTurnV5("s", { intake: { invocationId: "inv-1", items: [] } })).rejects.toThrow(/intake\.items/);
        await expect(h.runTurnV5("s", { intake: { ...INTAKE, items: [{ ...INTAKE.items[0], exchangeId: "nx-1" }] } }))
            .rejects.toThrow(/intake\.items\[0\]\.exchangeId/);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });
});
