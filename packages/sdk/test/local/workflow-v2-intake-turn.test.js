/**
 * Durable recipient intake, inactive: the turn activities of orchestration
 * 1.0.83, runTurnV5 / runTurnEpochV5 (design
 * docs/proposals/workflow-durable-intake.md 5.5 and section 8). They run the
 * turn-control path of runTurnV4 with the invocation that the input's
 * `intake` field carries, and only a test registers them.
 *
 * - The carried items' texts go before whatever prompt the attempt finally
 *   sends to the model, in a recovery re-run as well. Turn start records
 *   each item before the turn's own prompt, as its plain copy would be
 *   recorded: its canonical text and client id and the workflow sender; it
 *   is passed on every attempt, and turn start records it once by its id.
 * - Every result of an attempt names the invocation with its witness: sent
 *   only once the model session called back right before its initial send
 *   (ManagedSession does after every check that ends a run without one: a
 *   missing required tool, a held Stop), and never unsent again within the
 *   attempt. A saved result that an attempt adopts (a retry's
 *   already-committed turn, or the winner of a racing commit) keeps the
 *   witness it was saved with, or none; another invocation's or a malformed
 *   one is passed on for the orchestration to fail on (review W2-WIT1, WIT2).
 *   An attempt that sent and then lost the commit adds `exposed` to the
 *   winner's own not-sent witness of the same invocation, and to nothing
 *   else; the winner's response stands. Two executions of one turn on two
 *   workers that share one versioned store reach it (review W2-WIT4).
 * - A malformed field fails the activity before any model run; runTurnV4
 *   ignores the field and passes no callback.
 * - Decision A1: a closed budget or workspace gate refuses the attempt
 *   before turn start and any send, and its witness says not sent.
 *
 * The activity runs with a fake session manager, model session and catalog;
 * the adoption cases use a real filesystem snapshot store, and the send
 * callback is checked on a real ManagedSession over a fake Copilot session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { ManagedSession } from "../../src/managed-session.js";
import { LiveTurnControl } from "../../src/turn-control.js";

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

/** A model session's run that issues its request: it calls the intake's callback first, as ManagedSession does right before its send. */
const sends = (result) => async (opts) => {
    opts.onBeforeInitialSend?.();
    return { ...result };
};

/** A promise and its resolve, to order two concurrent runs. */
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

describe("runTurnV5: the turn of an invocation", () => {
    it("is registered only with the test option; runTurnV4 ignores an intake field and passes no send callback", async () => {
        expect(makeRunTurnHarness().handlers.runTurnV5).toBeUndefined();
        const v4 = turnControlCatalog();
        const h = intakeHarness({ catalogExtras: v4.extras });
        expect(Object.keys(h.handlers).filter((name) => name.endsWith("V5"))).toEqual(["runTurnV5", "runTurnEpochV5"]);
        const result = await h.runTurn("s", { turnIndex: 2, intake: INTAKE }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][0]).toBe("go");
        expect(h.session.runTurn.mock.calls[0][1].onBeforeInitialSend).toBeUndefined();
        expect(result.intakeDispatch).toBeUndefined();
        const [, , , records] = v4.calls.find((call) => call[0] === "turnStart");
        expect(records).toEqual([{ eventType: "user.message", data: { content: "go" } }]);
    });

    it("puts the carried items before the prompt the model gets; once the model session sends, the witness says sent; the transcript records the items with their canonical ids, then the prompt", async () => {
        const v4 = turnControlCatalog();
        const h = intakeHarness({ catalogExtras: v4.extras, turn: sends({ type: "completed", content: "ok", events: [] }) });
        const result = await h.runTurnV5("s", { turnIndex: 2, intake: INTAKE });
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(h.session.runTurn.mock.calls[0][0]).toBe(`${TEXT}\n\ngo`);
        expect(result).toMatchObject({ type: "completed", intakeDispatch: { invocationId: "inv-1", sent: true } });
        // Turn start records each item as its plain copy would be (its text starts with [SYSTEM:]), then the turn's prompt.
        const [, , , records] = v4.calls.find((call) => call[0] === "turnStart");
        expect(records).toEqual([
            { eventType: "system.message", data: { content: TEXT, clientMessageIds: [INTAKE.items[0].clientMessageId], sender: { kind: "system", display: "workflow message" } } },
            { eventType: "user.message", data: { content: "go" } },
        ]);
        // The epoch-start name runs the same path.
        const epoch = await h.runTurnV5("s", { turnIndex: 3, intake: INTAKE }, "runTurnEpochV5");
        expect(epoch).toMatchObject({ intakeDispatch: { invocationId: "inv-1", sent: true } });
    });

    it("a retry passes the items to turn start again, which records each once by its canonical id; the retried prompt is not recorded again", async () => {
        const v4 = turnControlCatalog();
        const h = intakeHarness({ catalogExtras: v4.extras, turn: sends({ type: "completed", content: "ok" }) });
        await h.runTurnV5("s", { turnIndex: 2, retryCount: 1, intake: INTAKE });
        const [, , , records] = v4.calls.find((call) => call[0] === "turnStart");
        expect(records.map((record) => record.data.clientMessageIds)).toEqual([[INTAKE.items[0].clientMessageId]]);
    });

    it("a Stop at turn start: no model run, and the witness says not sent", async () => {
        const v4 = turnControlCatalog({ start: { stopped: true, controls: [] }, end: { stopped: true, late: [] } });
        const h = intakeHarness({ catalogExtras: v4.extras });
        const result = await h.runTurnV5("s", { turnIndex: 5, intake: INTAKE });
        expect(h.session.runTurn).not.toHaveBeenCalled();
        expect(result).toMatchObject({ type: "stopped", intakeDispatch: { invocationId: "inv-1", sent: false } });
    });

    it("decision A1: a closed budget gate refuses the attempt before turn start and any send; the witness says not sent", async () => {
        const v4 = turnControlCatalog();
        const checkTurn = vi.fn(async () => ({
            verdict: "paused", providerName: "p", modelQualified: null, exempt: false, pause: { kind: "limit", provider: "p" }, rules: [],
        }));
        const h = intakeHarness({ catalogExtras: { ...v4.extras, providers: { checkTurn } }, turn: sends({ type: "completed", content: "never" }) });
        const result = await h.runTurnV5("s", { turnIndex: 6, intake: INTAKE });
        expect(checkTurn).toHaveBeenCalled();
        expect(result).toMatchObject({ type: "wait", budget: true, intakeDispatch: { invocationId: "inv-1", sent: false } });
        expect(v4.calls).toEqual([]);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("decision A1: a closed workspace gate refuses the attempt before turn start and any send; the witness says not sent", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-intake-ws-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "repo"), { recursive: true });
        const provider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        provider.script({ type: "fail", code: "WORKSPACE_IN_USE", message: "held elsewhere" });
        const v4 = turnControlCatalog();
        const h = intakeHarness({
            catalogExtras: v4.extras, workspaceProvider: provider,
            managerExtras: { holdWorkspaceFolders: vi.fn(), noteWorkspaceAttached: vi.fn() },
            turn: sends({ type: "completed", content: "never" }),
        });
        const result = await h.runTurnV5("s", {
            turnIndex: 3, workspaceRevision: 1, config: { workspace: { schema: 1, root: "a", folder: "repo" } }, intake: INTAKE,
        });
        expect(result).toMatchObject({ type: "wait", gate: "workspace", intakeDispatch: { invocationId: "inv-1", sent: false } });
        expect(v4.calls).toEqual([]);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("a model session that ends its run before the send (a missing required tool, a held Stop) leaves the witness not sent (review W2-WIT1)", async () => {
        const h = intakeHarness({
            catalogExtras: turnControlCatalog({ writeback: true }).extras,
            // As ManagedSession answers a missing required tool: before any send, so without the callback.
            turn: async () => ({ type: "error", message: 'Required tool "lookup" is not available in this session.', retryable: false, events: [] }),
        });
        const result = await h.runTurnV5("s", { turnIndex: 1, intake: INTAKE });
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ type: "error", retryable: false, intakeDispatch: { invocationId: "inv-1", sent: false } });
    });

    it("an error after the model ran carries the witness, sent", async () => {
        const v4 = turnControlCatalog({ writeback: true });
        const h = intakeHarness({ catalogExtras: v4.extras, turn: sends({ type: "error", message: "model failed" }) });
        const result = await h.runTurnV5("s", { turnIndex: 1, intake: INTAKE });
        expect(result).toMatchObject({ type: "error", message: "model failed", intakeDispatch: { invocationId: "inv-1", sent: true } });
    });

    it("an in-attempt recovery re-run puts the carried items before its own prompt again; sent stays sent though the re-run never sends", async () => {
        const lost = { type: "error", message: "Request session.send failed with message: Session not found: s" };
        let calls = 0;
        const v4 = turnControlCatalog({ writeback: true });
        const h = intakeHarness({
            catalogExtras: v4.extras,
            turn: async (opts) => {
                calls += 1;
                if (calls === 1) {
                    opts.onBeforeInitialSend?.();
                    return lost;
                }
                return { type: "completed", content: "recovered" };
            },
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

    it("a malformed intake field fails the activity before any model run", async () => {
        const h = intakeHarness({ catalogExtras: turnControlCatalog().extras });
        await expect(h.runTurnV5("s", { intake: { invocationId: "inv-1", items: [] } })).rejects.toThrow(/intake\.items/);
        await expect(h.runTurnV5("s", { intake: { ...INTAKE, items: [{ ...INTAKE.items[0], exchangeId: "nx-1" }] } }))
            .rejects.toThrow(/intake\.items\[0\]\.exchangeId/);
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });
});

describe("runTurnV5: an adopted saved result keeps its own witness (review W2-WIT2)", () => {
    /** A harness over a real filesystem snapshot store, whose model run makes the session's layout first. */
    function savedHarness(turn, catalog = turnControlCatalog({ writeback: true })) {
        const { sessionStateDir, store } = lifecycleDirs();
        const sessionId = `intake-${randomUUID()}`;
        const h = intakeHarness({
            catalogExtras: catalog.extras, sessionStore: store, sessionStateDir,
            turn: async (opts) => {
                makeSessionLayout(sessionStateDir, sessionId);
                return turn(opts, { sessionStateDir, store, sessionId });
            },
        });
        return { h, sessionId };
    }

    it("a retry that adopts the turn saved by its attempt that ran returns that attempt's witness, with no second model run", async () => {
        const { h, sessionId } = savedHarness(sends({ type: "completed", content: "saved answer" }),
            turnControlCatalog({ writeback: true, endFailures: 3 }));
        const input = { turnIndex: 4, snapshot: { turnKey: "k4" }, intake: INTAKE };
        // The turn is saved, then its turn end keeps failing: the attempt throws after the save.
        await expect(h.runTurnV5(sessionId, input)).rejects.toThrow(/database unavailable/);
        const result = await h.runTurnV5(sessionId, input);
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ type: "completed", content: "saved answer", intakeDispatch: { invocationId: "inv-1", sent: true } });
    });

    it("a saved result without a witness is adopted without one: possibly sent, never this attempt's not sent", async () => {
        const { h, sessionId } = savedHarness(sends({ type: "completed", content: "saved answer" }));
        // Saved without a witness, here by runTurnV4 under the same key.
        const saved = await h.runTurn(sessionId, { turnIndex: 4, snapshot: { turnKey: "k4" } }, "runTurnV4");
        expect(saved.intakeDispatch).toBeUndefined();
        const result = await h.runTurnV5(sessionId, { turnIndex: 4, snapshot: { turnKey: "k4" }, intake: INTAKE });
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ type: "completed", content: "saved answer" });
        expect(result.intakeDispatch).toBeUndefined();
    });

    it("a saved witness for another invocation, or a malformed one, is passed on as saved: the orchestration fails on it visibly", async () => {
        const foreign = savedHarness(sends({ type: "completed", content: "saved answer" }));
        await foreign.h.runTurnV5(foreign.sessionId, { turnIndex: 4, snapshot: { turnKey: "k4" }, intake: { ...INTAKE, invocationId: "inv-2" } });
        const adoptedForeign = await foreign.h.runTurnV5(foreign.sessionId, { turnIndex: 4, snapshot: { turnKey: "k4" }, intake: INTAKE });
        expect(foreign.h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(adoptedForeign.intakeDispatch).toEqual({ invocationId: "inv-2", sent: true });

        // A malformed witness can only be saved by an attempt that sets none (runTurnV4 passes its result's fields on).
        const malformed = savedHarness(async () => ({ type: "completed", content: "saved answer", intakeDispatch: "not a witness" }));
        await malformed.h.runTurn(malformed.sessionId, { turnIndex: 4, snapshot: { turnKey: "k4" } }, "runTurnV4");
        const adoptedMalformed = await malformed.h.runTurnV5(malformed.sessionId, { turnIndex: 4, snapshot: { turnKey: "k4" }, intake: INTAKE });
        expect(adoptedMalformed.intakeDispatch).toBe("not a witness");
    });

    it("a losing attempt whose racing winner committed first returns the winner's result and witness, or none; only its own send adds exposed, to the winner's own not-sent witness of the same invocation (review W2-WIT4)", async () => {
        const cases = [
            // [the winner's saved witness, whether this losing attempt sent, the witness it returns]
            [undefined, true, undefined],
            [{ invocationId: "inv-1", sent: false }, true, { invocationId: "inv-1", sent: false, exposed: true }],
            [{ invocationId: "inv-1", sent: false }, false, { invocationId: "inv-1", sent: false }],
            [{ invocationId: "inv-1", sent: true }, true, { invocationId: "inv-1", sent: true }],
            [{ invocationId: "inv-2", sent: false }, true, { invocationId: "inv-2", sent: false }],
            ["not a witness", true, "not a witness"],
        ];
        for (const [winnerWitness, loserSends, expected] of cases) {
            const name = JSON.stringify([winnerWitness, loserSends]);
            const winner = { type: "completed", content: "winner output", ...(winnerWitness !== undefined ? { intakeDispatch: winnerWitness } : {}) };
            const { h, sessionId } = savedHarness(async (opts, { sessionStateDir, store, sessionId: id }) => {
                // This attempt sends, or ends its run before its send ...
                if (loserSends) opts.onBeforeInitialSend?.();
                // ... while a racing attempt of the same turn saves first, under the same key.
                fs.writeFileSync(path.join(sessionStateDir, id, ".ps-turn-commit.json"), JSON.stringify({ turnKey: "k5", result: winner }));
                await store.commitSnapshot(id, { baseVersion: 0, turnKey: "k5" });
                return { type: "completed", content: "loser output" };
            });
            const result = await h.runTurnV5(sessionId, { turnIndex: 5, snapshot: { turnKey: "k5" }, intake: INTAKE });
            // The winner's response stands, whatever this attempt did.
            expect(result, name).toMatchObject({ type: "completed", content: "winner output" });
            if (expected === undefined) expect(result.intakeDispatch, name).toBeUndefined();
            else expect(result.intakeDispatch, name).toEqual(expected);
        }
    });

    it("two executions of one turn (its work item run twice) race: the one that sent loses the commit to one whose run ended before its send, and returns the winner's result with the witness exposed (review W2-WIT4)", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-intake-race-"));
        roots.push(root);
        const storeDir = path.join(root, "session-store");
        const sessionId = `intake-race-${randomUUID()}`;
        const input = { turnIndex: 5, snapshot: { turnKey: "k5" }, intake: INTAKE };
        // Two workers: each its own session state folder and session manager, one versioned snapshot store.
        const worker = (name, turn) => {
            const sessionStateDir = path.join(root, `state-${name}`);
            fs.mkdirSync(sessionStateDir, { recursive: true });
            const store = new FilesystemSessionStore(storeDir, sessionStateDir);
            return intakeHarness({
                catalogExtras: turnControlCatalog({ writeback: true }).extras, sessionStore: store, sessionStateDir,
                turn: async (opts) => {
                    makeSessionLayout(sessionStateDir, sessionId);
                    return turn(opts);
                },
            });
        };
        const sending = deferred();
        const resume = deferred();
        // A: its request includes the items; then its model run stalls, as on a worker that lost its lock.
        const a = worker("a", async (opts) => {
            opts.onBeforeInitialSend?.();
            sending.resolve();
            await resume.promise;
            return { type: "completed", content: "A's answer" };
        });
        // B: the same work item, run again; its run ends before its send (here a required tool it cannot find).
        const b = worker("b", async () => ({ type: "error", message: 'Required tool "lookup" is not available in this session.', retryable: false }));
        const first = a.runTurnV5(sessionId, input);
        await sending.promise;
        const winner = await b.runTurnV5(sessionId, input);
        expect(winner).toMatchObject({ type: "error", retryable: false, snapshotVersion: 1, intakeDispatch: { invocationId: "inv-1", sent: false } });
        resume.resolve();
        const loser = await first;
        // A's commit finds the turn saved by B under the same key (restore, not replay): B's result stands, and A's own
        // send is reported, never as a send of the run whose result this is.
        expect(loser).toMatchObject({ type: "error", retryable: false, snapshotVersion: 1 });
        expect(loser.content).toBeUndefined();
        expect(loser.intakeDispatch).toEqual({ invocationId: "inv-1", sent: false, exposed: true });
        const probe = await new FilesystemSessionStore(storeDir, path.join(root, "state-a")).probeSnapshot(sessionId);
        expect(probe).toMatchObject({ version: 1, turnKey: "k5" });
    });
});

describe("ManagedSession: the intake's send callback (review W2-WIT1)", () => {
    const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });

    /** A fake Copilot session, as in turn-control-live.test.js: it records each send and the test drives every event. */
    function fakeCopilotSession() {
        const handlers = [];
        const fake = {
            sent: [],
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
                return `msg-${fake.sent.length}`;
            },
            abort() { queueMicrotask(() => fake._emit("session.idle")); },
            async disconnect() {},
            getMessages() { return []; },
            _emit(type, data = {}) {
                for (const h of [...handlers]) if (h.type === null || h.type === type) h.fn({ type, data });
            },
        };
        return fake;
    }

    it("is called once, right before the initial prompt is sent", async () => {
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-send", fake, { waitThreshold: 30 });
        const sentBeforeCallback = [];
        const turn = managed.runTurn("work", { onBeforeInitialSend: () => sentBeforeCallback.push(fake.sent.length) });
        for (let i = 0; i < 50 && fake.sent.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
        expect(sentBeforeCallback).toEqual([0]);
        expect(fake.sent.map((message) => message.prompt)).toEqual(["work"]);
    });

    it("is not called when a held Stop ends the run before its send", async () => {
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-held-stop", fake, { waitThreshold: 30 });
        const live = new LiveTurnControl({
            sessionId: "intake-held-stop", turn: 4, start: 0,
            abort: async (reason) => { managed.requestStop(reason); managed.abort(); },
            record: async () => {},
        });
        const binding = {
            port: null,
            attach: (port) => { binding.port = port; live.attach(port); },
            heldStop: () => live.heldStop(),
            gateOpened: () => live.gateOpened(),
            detach: () => live.detach(),
        };
        await live.enqueue([control(71, "stop", "never mind")]);
        let called = 0;
        const result = await managed.runTurn("work", { turnIndex: 4, turnControl: binding, onBeforeInitialSend: () => { called += 1; } });
        expect(result).toMatchObject({ type: "stopped", reason: "never mind" });
        expect(called).toBe(0);
        expect(fake.sent).toEqual([]);
    });

    it("is not called when a required tool is missing: the run ends before its send", async () => {
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-required-tool", fake, { waitThreshold: 30 });
        let called = 0;
        const result = await managed.runTurn("work", { requiredTool: "package_catalog", onBeforeInitialSend: () => { called += 1; } });
        expect(result).toMatchObject({ type: "error", retryable: false, message: 'Required tool "package_catalog" is not available in this session.' });
        expect(called).toBe(0);
        expect(fake.sent).toEqual([]);
    });
});
