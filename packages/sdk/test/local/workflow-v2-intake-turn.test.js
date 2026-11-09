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
 * - Exposure protocol revision 2, section 4: before a run's initial send the
 *   store admits the carried items (exposeWorkflowIntake), asked with the
 *   activity's own session, the field's attempt id and retry flag, and each
 *   item's claim with the hash of the exact text the run would include. An
 *   admitted run includes them and says sent; a refused one sends its prompt
 *   without them, and its witness says refused (exposed or settled), never
 *   sent. A transient failure is asked again in place with the same request
 *   (a lost COMMIT answer is reconfirmed); one that runs out, an unknown
 *   failure or a worker without a workflow store ends the run, retryable,
 *   with nothing sent; one no retry can fix ends it not retryable. Every
 *   recovery re-run of the attempt is asked again as the same attempt.
 * - ManagedSession awaits the admission against the run's guards and its
 *   Stop, abort or forced settle, and checks again before its send: a Stop,
 *   an abort, a forced settle, a held Stop, the turn timeout or the
 *   inactivity watchdog while the answer is pending sends nothing, then or
 *   when the answer comes later; a failed admission sends nothing.
 * - Review of c1bda7a2: after a recovery, the witness is the final run's own
 *   (sent only when that run included the items; its refusal kept; otherwise
 *   not sent, possibly seen by the earlier run), for both recovery families
 *   (W1). The activity's cancellation is latched across runs and read before
 *   each run, at the admission, immediately before each send and at each
 *   steer: a cancelled activity starts no run and sends nothing (W2). A bare
 *   abort, or an activity that may no longer send, stops the run's
 *   corrective sends; a run neither aborted nor cancelled still corrects
 *   (W3). V4 turns are unchanged.
 *
 * The activity runs with a fake session manager, model session and catalog
 * (its workflow store's admission a fake); the adoption cases use a real
 * filesystem snapshot store, and the admission and send are checked on a
 * real ManagedSession over a fake Copilot session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { INTAKE_ENDED_BEFORE_SEND_MESSAGE, ManagedSession, TURN_INACTIVITY_ERROR_MARKER } from "../../src/managed-session.js";
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
    attemptId: "att-1",
    sentBefore: false,
    items: [{ exchangeId: `nx-${"1".repeat(40)}`, claimId: "claim-1", clientMessageId: `workflow:wf:run:send:nx-${"1".repeat(40)}`, text: TEXT }],
};
/** The admission a run of INTAKE's attempt asks of the store for session `sessionId` (exposure r2, section 3). */
const admissionOf = (sessionId, field = INTAKE) => ({
    recipientSessionId: sessionId, invocationId: field.invocationId, attemptId: field.attemptId, sentBefore: field.sentBefore,
    items: field.items.map((item) => ({ exchangeId: item.exchangeId, claimId: item.claimId, textSha256: createHash("sha256").update(item.text, "utf8").digest("hex") })),
});
/** A transient store failure (a serialization failure), retried in place; and one no retry can fix (a division by zero). */
const transient = () => Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });
const deterministic = () => Object.assign(new Error("division by zero"), { code: "22012" });

/**
 * A workflow store whose admission plays `answers` in order (an answer, or an
 * error to throw), then repeats the last; it records each request.
 */
function admissionStore(...answers) {
    const plays = answers.length > 0 ? answers : [{ allowed: true }];
    const calls = [];
    return {
        calls,
        exposeWorkflowIntake: vi.fn(async (request) => {
            calls.push(request);
            const answer = plays[Math.min(calls.length, plays.length) - 1];
            if (answer instanceof Error) throw answer;
            return answer;
        }),
        // Every 1.0.83 turn reads its session's Workflow lineage first (session-proxy executeTurnBody; the real store's
        // readWorkflowLineage): these chats are in no Workflow.
        readWorkflowLineage: vi.fn(async () => null),
    };
}

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
 * the same fakes, as a test registers them (registerActivities' test option),
 * and a catalog whose workflow store admits the items (`store`, by default one
 * that always allows; `store: null` for a worker without one). The admission's
 * transient retries wait 1 ms. `isCancelled` plays the activity context's
 * cancellation (the native runtime's, sticky once true).
 */
function intakeHarness(options = {}) {
    const store = options.store === undefined ? admissionStore() : options.store;
    const catalogExtras = { ...(store === null ? {} : { workflowStore: () => store }), ...(options.catalogExtras ?? {}) };
    const h = makeRunTurnHarness({ ...options, catalogExtras });
    const handlers = {};
    registerActivities({ registerActivity(name, handler) { handlers[name] = handler; } }, h.sessionManager, options.sessionStore ?? null, undefined,
        h.catalog, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "worker-1", undefined, undefined,
        { intakeAdmissionRetryDelaysMs: [1, 1, 1] });
    const activityCtx = { traceInfo: () => {}, traceWarn: () => {}, isCancelled: () => (options.isCancelled ? options.isCancelled() === true : false) };
    return {
        ...h,
        store,
        handlers,
        runTurnV5: (sessionId, inputOverrides = {}, name = "runTurnV5") => handlers[name](activityCtx, {
            sessionId, prompt: "go", config: {}, turnIndex: 0, ...inputOverrides,
        }),
    };
}

/**
 * Before its initial send, as ManagedSession does (exposure r2, section 4):
 * the admission; then, read again immediately before the send, the
 * activity's eligibility (review of c1bda7a2, W2); then the include callback
 * when admitted. Returns what the run sends: "include", "omit", "plain" for
 * a run that carries nothing, or "ended" when the activity may no longer
 * send (nothing is sent); an admission that fails rejects.
 */
async function admitted(opts) {
    if (!opts.intakeAdmission) return "plain";
    const decision = await opts.intakeAdmission.admit(new AbortController().signal);
    if (opts.intakeAdmission.eligible?.() === false) return "ended";
    if (decision === "include") opts.intakeAdmission.included();
    return decision;
}

/** A model session's run that issues its request, admitted first; a failed admission ends it with nothing sent, as ManagedSession's does. */
const sends = (result) => async (opts) => {
    try {
        await admitted(opts);
    } catch (error) {
        return { type: "error", message: error.message, ...(error.retryable === false ? { retryable: false } : {}) };
    }
    return { ...result };
};

/** A promise and its resolve, to order two concurrent runs. */
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

describe("runTurnV5: the turn of an invocation", () => {
    it("is registered on every worker (no option, owner 2026-11-08T15:30Z); runTurnV4 ignores an intake field and asks no admission", async () => {
        expect(makeRunTurnHarness().handlers.runTurnV5).toBeTypeOf("function");
        const v4 = turnControlCatalog();
        const h = intakeHarness({ catalogExtras: v4.extras });
        expect(Object.keys(h.handlers).filter((name) => name.endsWith("V5"))).toEqual(["runTurnV5", "runTurnEpochV5"]);
        const result = await h.runTurn("s", { turnIndex: 2, intake: INTAKE }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][0]).toBe("go");
        expect(h.session.runTurn.mock.calls[0][1].intakeAdmission).toBeUndefined();
        expect(h.store.calls).toEqual([]);
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

    it("an in-attempt recovery re-run puts the carried items before its own prompt again; a re-run that never sends is not sent, its items possibly seen by the earlier run (review of c1bda7a2, W1)", async () => {
        const lost = { type: "error", message: "Request session.send failed with message: Session not found: s" };
        let calls = 0;
        const v4 = turnControlCatalog({ writeback: true });
        const h = intakeHarness({
            catalogExtras: v4.extras,
            turn: async (opts) => {
                calls += 1;
                if (calls === 1) {
                    expect(await admitted(opts)).toBe("include");
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
        // The re-run is offered its own prompt without the items, should its admission refuse them.
        const offered = h.session.runTurn.mock.calls.map((call) => call[1].intakeAdmission.promptWithoutIntake);
        expect(offered[0]).toBe("check the tree");
        expect(rerun).toBe(`${TEXT}\n\n${offered[1]}`);
        expect(h.store.calls).toEqual([admissionOf("s")]);
        // The result is the re-run's, which sent nothing: never sent, and possibly seen (the first run included the items).
        expect(result).toMatchObject({ type: "completed", intakeDispatch: { invocationId: "inv-1", sent: false, exposed: true } });
    });

    it("review of c1bda7a2, W1: after a recovery, the result's witness is the final run's own: sent only when that run included the items; its refusal kept; otherwise possibly seen by the earlier run", async () => {
        const families = {
            "live session lost": { type: "error", message: "Request session.send failed with message: Session not found: s" },
            "transcript corrupted": { type: "error", message: "assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'" },
        };
        const finals = {
            // [the final run, the store's answer to its admission, the witness expected]
            "includes": [async (opts) => (expect(await admitted(opts)).toBe("include"), { type: "completed", content: "answered" }),
                { allowed: true }, { invocationId: "inv-1", sent: true }],
            "fails before its send": [async () => ({ type: "error", message: 'Required tool "lookup" is not available in this session.', retryable: false }),
                { allowed: true }, { invocationId: "inv-1", sent: false, exposed: true }],
            "stops before its send": [async () => ({ type: "stopped", reason: "Stopped by user" }),
                { allowed: true }, { invocationId: "inv-1", sent: false, exposed: true }],
            "omits after a settled refusal": [async (opts) => (expect(await admitted(opts)).toBe("omit"), { type: "completed", content: "answered without them" }),
                { allowed: false, reason: "settled" }, { invocationId: "inv-1", sent: false, refused: "settled" }],
        };
        for (const [family, failure] of Object.entries(families)) {
            for (const [final, [run, answer, witness]] of Object.entries(finals)) {
                const label = `${family}, then the final run ${final}`;
                let calls = 0;
                const h = intakeHarness({
                    catalogExtras: turnControlCatalog({ writeback: true }).extras, store: admissionStore({ allowed: true }, answer),
                    turn: async (opts) => {
                        calls += 1;
                        if (calls === 1) {
                            expect(await admitted(opts), label).toBe("include");
                            return { ...failure };
                        }
                        return run(opts);
                    },
                });
                const result = await h.runTurnV5("s", { turnIndex: 6, intake: INTAKE });
                expect(h.session.runTurn, label).toHaveBeenCalledTimes(2);
                expect(result.intakeDispatch, label).toEqual(witness);
            }
        }
    });

    it("review of c1bda7a2, W2: an activity already cancelled starts no run and asks nothing; one cancelled while its admission is answered sends nothing, for an include and an omit", async () => {
        const before = intakeHarness({ catalogExtras: turnControlCatalog().extras, isCancelled: () => true, turn: sends({ type: "completed", content: "never" }) });
        const skipped = await before.runTurnV5("s", { turnIndex: 2, intake: INTAKE });
        expect(before.session.runTurn).not.toHaveBeenCalled();
        expect(before.store.calls).toEqual([]);
        expect(skipped.intakeDispatch).toEqual({ invocationId: "inv-1", sent: false });
        for (const [answer, witness] of [
            [{ allowed: true }, { invocationId: "inv-1", sent: false }],
            [{ allowed: false, reason: "exposed" }, { invocationId: "inv-1", sent: false, refused: "exposed" }],
        ]) {
            let cancelledNow = false;
            const store = admissionStore(answer);
            const answering = store.exposeWorkflowIntake.getMockImplementation();
            // The activity loses its lock while the store answers, before any poll could see it.
            store.exposeWorkflowIntake.mockImplementation(async (request) => {
                const result = await answering(request);
                cancelledNow = true;
                return result;
            });
            let sent = null;
            const h = intakeHarness({
                catalogExtras: turnControlCatalog().extras, store, isCancelled: () => cancelledNow,
                turn: async (opts) => {
                    sent = await admitted(opts);
                    return { type: "error", message: "the run ended before its send" };
                },
            });
            const result = await h.runTurnV5("s", { turnIndex: 2, intake: INTAKE });
            expect(sent, JSON.stringify(answer)).toBe("ended");
            expect(result.intakeDispatch, JSON.stringify(answer)).toEqual(witness);
        }
    });

    it("review of c1bda7a2, W2: a cancellation observed between recovery runs, after the poll stopped, keeps the recovered run from starting: nothing more is sent", async () => {
        const lost = { type: "error", message: "Request session.send failed with message: Session not found: s" };
        let cancelledNow = false;
        let opened = 0;
        let h;
        h = intakeHarness({
            catalogExtras: turnControlCatalog({ writeback: true }).extras,
            isCancelled: () => cancelledNow,
            managerExtras: {
                // The recovery's session: the activity is cancelled while it is made, long enough for the poll (every 2 s) to
                // see it, abort the session and stop.
                getOrCreate: vi.fn(async () => {
                    opened += 1;
                    if (opened === 2) {
                        cancelledNow = true;
                        await new Promise((resolve) => setTimeout(resolve, 2_300));
                    }
                    return h.session;
                }),
            },
            turn: async (opts) => {
                expect(await admitted(opts)).toBe("include");
                return lost;
            },
        });
        const result = await h.runTurnV5("s", { turnIndex: 6, intake: INTAKE });
        expect(opened).toBe(2);
        expect(h.session.abort).toHaveBeenCalled();
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(h.store.calls).toEqual([admissionOf("s")]);
        expect(result).toMatchObject({ type: "cancelled", intakeDispatch: { invocationId: "inv-1", sent: false, exposed: true } });
    }, 15_000);

    it("a malformed intake field fails the activity before any model run", async () => {
        const h = intakeHarness({ catalogExtras: turnControlCatalog().extras });
        await expect(h.runTurnV5("s", { intake: { ...INTAKE, items: [] } })).rejects.toThrow(/intake\.items/);
        await expect(h.runTurnV5("s", { intake: { ...INTAKE, items: [{ ...INTAKE.items[0], exchangeId: "nx-1" }] } }))
            .rejects.toThrow(/intake\.items\[0\]\.exchangeId/);
        await expect(h.runTurnV5("s", { intake: { invocationId: "inv-1", items: INTAKE.items } })).rejects.toThrow(/intake\.attemptId/);
        expect(h.session.runTurn).not.toHaveBeenCalled();
        expect(h.store.calls).toEqual([]);
    });
});

describe("runTurnV5: the store admits the carried items before a run includes them (exposure protocol revision 2, section 4)", () => {
    it("asks with the activity's own session, the attempt's id and retry flag, and each item's claim with the hash of the exact text it would include; admitted, the run includes them", async () => {
        const v4 = turnControlCatalog();
        const h = intakeHarness({ catalogExtras: v4.extras, turn: sends({ type: "completed", content: "ok" }) });
        const retry = { ...INTAKE, attemptId: "att-2", sentBefore: true };
        expect(await h.runTurnV5("recipient-1", { turnIndex: 2, intake: retry }))
            .toMatchObject({ type: "completed", intakeDispatch: { invocationId: "inv-1", sent: true } });
        expect(h.store.calls).toEqual([admissionOf("recipient-1", retry)]);
        expect(h.store.calls[0].items[0].textSha256).toBe(createHash("sha256").update(TEXT, "utf8").digest("hex"));
    });

    it("refused (exposed, or settled), the run sends its prompt without the items: its witness says refused, never sent", async () => {
        for (const reason of ["exposed", "settled"]) {
            const v4 = turnControlCatalog();
            let sent = null;
            const h = intakeHarness({
                catalogExtras: v4.extras, store: admissionStore({ allowed: false, reason }),
                turn: async (opts) => {
                    sent = await admitted(opts);
                    return { type: "completed", content: "answered without them" };
                },
            });
            const result = await h.runTurnV5("s", { turnIndex: 2, intake: INTAKE });
            expect(sent, reason).toBe("omit");
            expect(h.session.runTurn.mock.calls[0][1].intakeAdmission.promptWithoutIntake, reason).toBe("go");
            expect(result, reason).toMatchObject({ type: "completed", content: "answered without them",
                intakeDispatch: { invocationId: "inv-1", sent: false, refused: reason } });
            expect(Object.hasOwn(result.intakeDispatch, "exposed"), reason).toBe(false);
        }
    });

    // Review PRR-2: a refusal omits only the Workflow items. A Workflow Definition note the turn read stays in the prompt the
    // model gets, and is marked read once when the turn succeeds; a turn that fails leaves it for its retry.
    it("PRR-2: refused, the run keeps the chat's pending note in its prompt and consumes it once on success; a failed turn leaves it pending", async () => {
        for (const [outcome, consumed] of [["completed", 1], ["error", 0]]) {
            const v4 = turnControlCatalog();
            const store = admissionStore({ allowed: false, reason: "exposed" });
            const consumes = [];
            store.chat = {
                pendingNotes: vi.fn(async () => [{ noteId: 7, text: "Ada Lovelace saved hn-top-watch revision 1." }]),
                consumeNotes: vi.fn(async (sessionId, ids) => { consumes.push([sessionId, ids]); }),
            };
            let sent = null;
            const h = intakeHarness({
                catalogExtras: v4.extras, store,
                turn: async (opts) => {
                    sent = await admitted(opts);
                    return outcome === "completed" ? { type: "completed", content: "noted" } : { type: "error", message: "the model did not answer" };
                },
            });
            const result = await h.runTurnV5("s", { turnIndex: 2, intake: INTAKE });
            expect(sent, outcome).toBe("omit");
            const [modelPrompt, opts] = h.session.runTurn.mock.calls[0];
            // The prompt with the items has the note too; the prompt without them is the note and the ordinary prompt.
            expect(modelPrompt, outcome).toBe(`${TEXT}\n\n[SYSTEM: Ada Lovelace saved hn-top-watch revision 1.]\n\ngo`);
            expect(opts.intakeAdmission.promptWithoutIntake, outcome).toBe("[SYSTEM: Ada Lovelace saved hn-top-watch revision 1.]\n\ngo");
            expect(opts.intakeAdmission.promptWithoutIntake, outcome).not.toContain(TEXT);
            expect(result, outcome).toMatchObject({ type: outcome, intakeDispatch: { invocationId: "inv-1", sent: false, refused: "exposed" } });
            expect(consumes, outcome).toEqual(consumed ? [["s", [7]]] : []);
        }
    });

    it("a transient failure is asked again in place with the same request: a COMMIT whose answer was lost is reconfirmed, and the run includes the items once", async () => {
        const h = intakeHarness({
            catalogExtras: turnControlCatalog().extras, store: admissionStore(transient(), { allowed: true }), turn: sends({ type: "completed", content: "ok" }),
        });
        expect(await h.runTurnV5("s", { turnIndex: 2, intake: INTAKE })).toMatchObject({ intakeDispatch: { invocationId: "inv-1", sent: true } });
        expect(h.store.calls).toEqual([admissionOf("s"), admissionOf("s")]);
        expect(h.session.runTurn).toHaveBeenCalledTimes(1);
    });

    it("no answer, no send: transient failures that run out, an unknown failure, or a worker without a workflow store end the run, retryable; a failure no retry can fix ends it not retryable", async () => {
        for (const [label, store, retryable, asks] of [
            ["transient, run out", admissionStore(transient()), true, 4],
            ["unknown", admissionStore(new Error("socket hung up")), true, 1],
            ["no workflow store", null, true, 0],
            ["no retry can fix it", admissionStore(deterministic()), false, 1],
        ]) {
            let decision = null;
            const h = intakeHarness({
                catalogExtras: turnControlCatalog().extras, store,
                turn: async (opts) => {
                    try {
                        decision = await admitted(opts);
                    } catch (error) {
                        expect(error.code, label).toBe("WORKFLOW_INTAKE_ADMISSION_FAILED");
                        return { type: "error", message: error.message, ...(error.retryable === false ? { retryable: false } : {}) };
                    }
                    return { type: "completed", content: "never" };
                },
            });
            const result = await h.runTurnV5("s", { turnIndex: 2, intake: INTAKE });
            expect(decision, label).toBeNull();
            expect(result, label).toMatchObject({ type: "error", intakeDispatch: { invocationId: "inv-1", sent: false } });
            expect(result.retryable === false, label).toBe(!retryable);
            expect(store?.calls.length ?? 0, label).toBe(asks);
        }
    });

    it("every recovery re-run of the attempt is admitted again as the same attempt", async () => {
        const lost = { type: "error", message: "Request session.send failed with message: Session not found: s" };
        let calls = 0;
        const h = intakeHarness({
            catalogExtras: turnControlCatalog({ writeback: true }).extras,
            turn: async (opts) => {
                calls += 1;
                expect(await admitted(opts)).toBe("include");
                return calls === 1 ? lost : { type: "completed", content: "recovered" };
            },
        });
        expect(await h.runTurnV5("s", { turnIndex: 6, intake: INTAKE })).toMatchObject({ intakeDispatch: { invocationId: "inv-1", sent: true } });
        expect(h.store.calls).toEqual([admissionOf("s"), admissionOf("s")]);
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
                if (loserSends) expect(await admitted(opts)).toBe("include");
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
            expect(await admitted(opts)).toBe("include");
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

describe("ManagedSession: the intake's admission and send (review W2-WIT1; exposure protocol revision 2, section 4)", () => {
    const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });

    /** A fake Copilot session, as in turn-control-live.test.js: it records each send and the test drives every event. */
    function fakeCopilotSession() {
        const handlers = [];
        const fake = {
            sent: [],
            aborts: 0,
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
            abort() { fake.aborts += 1; queueMicrotask(() => fake._emit("session.idle")); },
            async disconnect() {},
            getMessages() { return []; },
            _emit(type, data = {}) {
                for (const h of [...handlers]) if (h.type === null || h.type === type) h.fn({ type, data });
            },
        };
        return fake;
    }

    /**
     * An intake admission the test answers: `admit` resolves (or rejects) when the test says, the signal it was given is
     * kept, and `included` counts its calls with the sends made before each.
     */
    function heldAdmission(promptWithoutIntake = "work", eligible = undefined) {
        let answer;
        let fail;
        const asked = deferred();
        const admission = {
            signal: null, included: [], promptWithoutIntake,
            asked: asked.promise,
            answer: (decision) => answer(decision),
            fail: (error) => fail(error),
        };
        admission.option = (fake) => ({
            promptWithoutIntake,
            ...(eligible ? { eligible } : {}),
            admit: (signal) => {
                admission.signal = signal;
                asked.resolve();
                return new Promise((resolve, reject) => { answer = resolve; fail = reject; });
            },
            included: () => { admission.included.push(fake.sent.length); },
        });
        return admission;
    }

    /** Wait until the fake has `n` sends (at most 50 ticks). */
    const sentCount = async (fake, n) => {
        for (let i = 0; i < 50 && fake.sent.length < n; i++) await new Promise((resolve) => setImmediate(resolve));
        expect(fake.sent.length).toBeGreaterThanOrEqual(n);
    };
    const TEXT_TOOL_CALL = '<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>';

    const settle = async (fake, turn) => {
        for (let i = 0; i < 50 && fake.sent.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
        fake._emit("session.idle");
        return turn;
    };
    const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

    it("admitted: `included` is called once, right before the initial prompt with the items is sent", async () => {
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-send", fake, { waitThreshold: 30 });
        const admission = heldAdmission("work");
        const turn = managed.runTurn(`${TEXT}\n\nwork`, { intakeAdmission: admission.option(fake) });
        await admission.asked;
        expect(fake.sent).toEqual([]);
        admission.answer("include");
        expect((await settle(fake, turn)).type).toBe("completed");
        expect(admission.included).toEqual([0]);
        expect(fake.sent.map((message) => message.prompt)).toEqual([`${TEXT}\n\nwork`]);
        expect(admission.signal.aborted).toBe(true);
    });

    it("refused: the run sends its prompt without the items, wrapped for a required tool as its own prompt would be, and `included` is never called", async () => {
        for (const requiredTool of [undefined, "wait"]) {
            const fake = fakeCopilotSession();
            const managed = new ManagedSession("intake-omit", fake, { waitThreshold: 30 });
            const admission = heldAdmission("work");
            const turn = managed.runTurn(`${TEXT}\n\nwork`, { intakeAdmission: admission.option(fake), ...(requiredTool ? { requiredTool } : {}) });
            await admission.asked;
            admission.answer("omit");
            for (let i = 0; i < 50 && fake.sent.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
            // The run ends here (a Stop): a required tool's corrective prompts are not under test.
            managed.requestStop("done");
            managed.abort();
            await turn;
            expect(admission.included, String(requiredTool)).toEqual([]);
            expect(fake.sent, String(requiredTool)).toHaveLength(1);
            const [message] = fake.sent;
            if (requiredTool) {
                expect(message.prompt.startsWith(`[SYSTEM: For this request, you MUST invoke the tool "wait"`)).toBe(true);
                expect(message.prompt.endsWith("\nwork")).toBe(true);
                expect(message.prompt).not.toContain(TEXT);
                expect(message.displayPrompt).toBe("work");
            } else {
                expect(message).toMatchObject({ prompt: "work" });
                expect(Object.hasOwn(message, "displayPrompt")).toBe(false);
            }
        }
    });

    it("a Stop, an abort or a forced settle while the answer is pending ends the run with nothing sent, then and when the answer comes", async () => {
        for (const [label, interrupt, expected] of [
            ["stop", (managed) => { managed.requestStop("Stopped by user"); managed.abort(); }, { type: "stopped", reason: "Stopped by user" }],
            ["abort (the activity's lock was lost)", (managed) => managed.abort(), { type: "error", message: INTAKE_ENDED_BEFORE_SEND_MESSAGE }],
            ["forced settle", (managed) => managed.forceSettleTurn("hung"), { type: "stopped", reason: "hung" }],
        ]) {
            const fake = fakeCopilotSession();
            const managed = new ManagedSession(`intake-interrupt-${label}`, fake, { waitThreshold: 30 });
            const admission = heldAdmission();
            const turn = managed.runTurn(`${TEXT}\n\nwork`, { intakeAdmission: admission.option(fake) });
            await admission.asked;
            interrupt(managed);
            expect(await turn, label).toMatchObject(expected);
            expect(admission.signal.aborted, label).toBe(true);
            // The admission commits late: nothing is sent, and the run's own send is never reported.
            admission.answer("include");
            await ticks();
            expect(fake.sent, label).toEqual([]);
            expect(admission.included, label).toEqual([]);
        }
    });

    it("the turn timeout or the inactivity watchdog while the answer is pending ends the run with nothing sent, then and when the answer comes", async () => {
        for (const [label, config, message] of [
            ["turn timeout", { turnTimeoutMs: 30, turnInactivityTimeoutMs: 0 }, /taking too long/],
            ["inactivity watchdog", { turnTimeoutMs: 0, turnInactivityTimeoutMs: 30 }, new RegExp(TURN_INACTIVITY_ERROR_MARKER)],
        ]) {
            const fake = fakeCopilotSession();
            const managed = new ManagedSession(`intake-guard-${label}`, fake, { waitThreshold: 30, ...config });
            const admission = heldAdmission();
            const result = await managed.runTurn(`${TEXT}\n\nwork`, { intakeAdmission: admission.option(fake) });
            expect(result.type, label).toBe("error");
            expect(result.message, label).toMatch(message);
            expect(admission.signal.aborted, label).toBe(true);
            admission.answer("include");
            await ticks();
            expect(fake.sent, label).toEqual([]);
            expect(admission.included, label).toEqual([]);
        }
    });

    it("a Stop held while the answer is pending is found by the check before the send: nothing is sent", async () => {
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-held-late", fake, { waitThreshold: 30 });
        const live = new LiveTurnControl({
            sessionId: "intake-held-late", turn: 4, start: 0,
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
        const admission = heldAdmission();
        const turn = managed.runTurn(`${TEXT}\n\nwork`, { turnIndex: 4, turnControl: binding, intakeAdmission: admission.option(fake) });
        await admission.asked;
        // Before the send the gate is pending: the Stop is held, not applied.
        await live.enqueue([control(72, "stop", "not now")]);
        admission.answer("include");
        expect(await turn).toMatchObject({ type: "stopped", reason: "not now" });
        expect(fake.sent).toEqual([]);
        expect(admission.included).toEqual([]);
    });

    it("a failed admission ends the run with nothing sent: not retryable when it says so", async () => {
        for (const [label, error, retryable] of [
            ["retryable", Object.assign(new Error("the store is unavailable"), { retryable: true }), true],
            ["not retryable", Object.assign(new Error("no retry can fix it"), { retryable: false }), false],
            ["plain", new Error("socket hung up"), true],
        ]) {
            const fake = fakeCopilotSession();
            const managed = new ManagedSession(`intake-failed-${label}`, fake, { waitThreshold: 30 });
            const admission = heldAdmission();
            const turn = managed.runTurn(`${TEXT}\n\nwork`, { intakeAdmission: admission.option(fake) });
            await admission.asked;
            admission.fail(error);
            const result = await turn;
            expect(result, label).toMatchObject({ type: "error", message: error.message });
            expect(result.retryable === false, label).toBe(!retryable);
            expect(fake.sent, label).toEqual([]);
            expect(admission.included, label).toEqual([]);
        }
        // An answer that is neither include nor omit is a broken protocol: not retryable, nothing sent.
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-unknown-answer", fake, { waitThreshold: 30 });
        const admission = heldAdmission();
        const turn = managed.runTurn(`${TEXT}\n\nwork`, { intakeAdmission: admission.option(fake) });
        await admission.asked;
        admission.answer("maybe");
        expect(await turn).toMatchObject({ type: "error", retryable: false });
        expect(fake.sent).toEqual([]);
    });

    it("is not asked when a held Stop ends the run before its send", async () => {
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
        const admission = heldAdmission();
        const result = await managed.runTurn("work", { turnIndex: 4, turnControl: binding, intakeAdmission: admission.option(fake) });
        expect(result).toMatchObject({ type: "stopped", reason: "never mind" });
        expect(admission.signal).toBeNull();
        expect(admission.included).toEqual([]);
        expect(fake.sent).toEqual([]);
    });

    it("is not asked when a required tool is missing: the run ends before its send", async () => {
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-required-tool", fake, { waitThreshold: 30 });
        const admission = heldAdmission();
        const result = await managed.runTurn("work", { requiredTool: "package_catalog", intakeAdmission: admission.option(fake) });
        expect(result).toMatchObject({ type: "error", retryable: false, message: 'Required tool "package_catalog" is not available in this session.' });
        expect(admission.signal).toBeNull();
        expect(admission.included).toEqual([]);
        expect(fake.sent).toEqual([]);
    });

    it("review of c1bda7a2, W2: an activity that may no longer send when the answer comes sends nothing, for an include and an omit", async () => {
        for (const decision of ["include", "omit"]) {
            let eligible = true;
            const fake = fakeCopilotSession();
            const managed = new ManagedSession(`intake-ineligible-${decision}`, fake, { waitThreshold: 30 });
            const admission = heldAdmission("work", () => eligible);
            const turn = managed.runTurn(`${TEXT}\n\nwork`, { intakeAdmission: admission.option(fake) });
            await admission.asked;
            eligible = false;
            admission.answer(decision);
            expect(await turn, decision).toMatchObject({ type: "error", message: INTAKE_ENDED_BEFORE_SEND_MESSAGE });
            expect(fake.sent, decision).toEqual([]);
            expect(admission.included, decision).toEqual([]);
        }
    });

    it("review of c1bda7a2, W3: a bare abort after the admitted initial send stops the run's corrective sends, for a required tool and a tool call written as text", async () => {
        for (const variant of ["required tool", "tool call as text"]) {
            const fake = fakeCopilotSession();
            const managed = new ManagedSession(`intake-abort-${variant}`, fake, { waitThreshold: 30 });
            const admission = heldAdmission("work");
            const turn = managed.runTurn(`${TEXT}\n\nwork`, {
                intakeAdmission: admission.option(fake), ...(variant === "required tool" ? { requiredTool: "wait" } : {}),
            });
            await admission.asked;
            admission.answer("include");
            await sentCount(fake, 1);
            if (variant === "tool call as text") fake._emit("assistant.message", { content: TEXT_TOOL_CALL });
            // The activity's cancellation: a bare abort, with no Stop; the fake's abort ends the run with session.idle.
            managed.abort();
            await turn;
            await ticks();
            expect(fake.sent, variant).toHaveLength(1);
            expect(admission.included, variant).toEqual([0]);
        }
    });

    it("review of c1bda7a2, W2, W3: corrective sends are refused once the activity may no longer send, and a run neither aborted nor cancelled still corrects", async () => {
        for (const [variant, cancelBeforeCorrection] of [
            ["required tool", false], ["tool call as text", false], ["required tool", true], ["tool call as text", true],
        ]) {
            const label = `${variant}, ${cancelBeforeCorrection ? "activity cancelled" : "still eligible"}`;
            let eligible = true;
            const fake = fakeCopilotSession();
            const managed = new ManagedSession(`intake-correct-${label}`, fake, { waitThreshold: 30 });
            const admission = heldAdmission("work", () => eligible);
            const turn = managed.runTurn(`${TEXT}\n\nwork`, {
                intakeAdmission: admission.option(fake), ...(variant === "required tool" ? { requiredTool: "wait" } : {}),
            });
            await admission.asked;
            admission.answer("include");
            await sentCount(fake, 1);
            if (variant === "tool call as text") fake._emit("assistant.message", { content: TEXT_TOOL_CALL });
            if (cancelBeforeCorrection) eligible = false;
            // The initial run ends without the tool's execution (or with the tool call written as text).
            fake._emit("session.idle");
            if (!cancelBeforeCorrection) {
                await sentCount(fake, 2);
                fake._emit("session.idle");
            }
            await turn;
            await ticks();
            expect(fake.sent, label).toHaveLength(cancelBeforeCorrection ? 1 : 2);
            if (!cancelBeforeCorrection) {
                expect(fake.sent[1].prompt, label).toMatch(variant === "required tool" ? /Required-tool contract violation/ : /Tool-call protocol error/);
            }
            expect(admission.included, label).toEqual([0]);
        }
    });

    it("review of c1bda7a2, W2: a steer of the run is refused once the activity may no longer send; nothing more is sent", async () => {
        let eligible = true;
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-steer", fake, { waitThreshold: 30 });
        const live = new LiveTurnControl({
            sessionId: "intake-steer", turn: 4, start: 0,
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
        const admission = heldAdmission("work", () => eligible);
        const turn = managed.runTurn(`${TEXT}\n\nwork`, { turnIndex: 4, turnControl: binding, intakeAdmission: admission.option(fake) });
        await admission.asked;
        admission.answer("include");
        await sentCount(fake, 1);
        eligible = false;
        await live.enqueue([control(81, "steer", "one more thing")]);
        const result = await turn;
        expect(result.type).toBe("error");
        expect(fake.sent.map((message) => message.prompt)).toEqual([`${TEXT}\n\nwork`]);
    });

    it("a turn that carries nothing is sent as before: no admission, no wait", async () => {
        const fake = fakeCopilotSession();
        const managed = new ManagedSession("intake-plain", fake, { waitThreshold: 30 });
        const turn = managed.runTurn("work", {});
        expect((await settle(fake, turn)).type).toBe("completed");
        expect(fake.sent.map((message) => message.prompt)).toEqual(["work"]);
    });
});
