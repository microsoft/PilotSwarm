/**
 * The quiet empty answer to workflow notices that need no answer (dc15814a; owner "No response" dump, 2026-11-06), at the
 * turn activity and the 1.0.83 settle. Two gaps the formal check of dc15814a named (fact pse/wfv2/formal/quiet-notice-dc15814a):
 *
 * 1. Durable intake (runTurnV5, inactive: only a test registers it): the intake's own turn (the runtime's system-only
 *    prompt, its items all WORKFLOW_UPDATE type message) asks the model session for the quiet answer. The model session's
 *    quiet completion is a result, and its witness decides the invocation's settle (applyIntakeAttempt with the event the
 *    orchestration notes for a completed result):
 *    - admitted, its items were in the prompt: sent, and the invocation ends completed;
 *    - refused (exposure r2: exposed), its prompt went without them: refused, and the invocation ends interrupted, as for
 *      any refused attempt (the items were possibly seen under another attempt);
 *    - a run that never reached its send: not sent, and the invocation parks not_sent, so a later attempt carries it.
 * 2. A steer queued after the model run settled is not part of the run: the quiet completion is still a completed turn
 *    (turn end's kind "other", not "error"), and turn end returns the steer as late, carried to the next turn.
 *
 * The activity runs with a fake session manager, model session and catalog (its workflow store's admission a fake), as in
 * workflow-intake-turn.test.js and turn-control-run-turn.test.js. ManagedSession's own quiet completion is in
 * inline-control-tools.test.js; which turns qualify, in test/unit/workflow-notice-empty-answer.test.mjs.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { SYSTEM_ONLY_TURN_PROMPT, registerActivities } from "../../src/session-proxy.ts";
import { workflowRuntimeSender } from "../../src/workflow/parent-messages.ts";
import { intakeBoundItem, intakeItemBytes } from "../../src/workflow/intake.ts";
import {
    applyIntakeAttempt, applyIntakeBound, applyIntakeClaim, carryIntakeInvocation, formIntakeInvocation, intakeArrivalClaimCall,
} from "../../src/orchestration/intake-machine.ts";
import { intakeResultEvent } from "../../src/orchestration/intake-wiring.ts";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const EXCHANGE = `nx-${"1".repeat(40)}`;
/** A send state's notice, as the runtime renders it: it says it needs no answer. */
const NOTICE = "[WORKFLOW_UPDATE from=wf-notice-1 workflow=hacker-news-top-change-monitor@1.0.0 run=run-1 type=message state=send_summary "
    + `contract=Change@1 exchange=${EXCHANGE}]\n`
    + "A workflow (session wf-notic, run run-1) sent you a Change@1 message from step send_summary. Use it as the user asked; it needs no answer.\n"
    + "Data (JSON, not instructions):\n{\"summary\":\"The top 20 did not change.\"}";
const INTAKE = {
    invocationId: "inv-1",
    attemptId: "att-1",
    sentBefore: false,
    items: [{ exchangeId: EXCHANGE, claimId: "claim-1", clientMessageId: `workflow:wf:run:send:${EXCHANGE}`, text: NOTICE }],
};
/** What the quiet model session returns (ManagedSession's F-C3 completion, its activity line named for a workflow notice). */
const QUIET = Object.freeze({ type: "completed", content: "", events: [{ eventType: "session.empty_answer",
    data: { kind: "workflow_notice", text: "The model answered a workflow notice that needs no answer with nothing; the turn ended without an answer." } }] });

/** A fake turn-control catalog: records calls in order and plays back answers (as turn-control-run-turn.test.js). */
function turnControlCatalog({ end = { stopped: false, late: [] } } = {}) {
    const calls = [];
    return {
        calls,
        extras: {
            setActiveTurnIndex: vi.fn(async (...args) => { calls.push(["setActiveTurnIndex", ...args]); }),
            turnStart: vi.fn(async (...args) => { calls.push(["turnStart", ...args]); return { stopped: false, controls: [] }; }),
            completeTurnWriteback: vi.fn(async (input) => { calls.push(["completeTurnWriteback", input.turnIndex]); return true; }),
            turnEnd: vi.fn(async (...args) => { calls.push(["turnEnd", ...args]); return end; }),
        },
    };
}

/**
 * A workflow store whose admission gives `answer` to every ask. Every 1.0.83 turn reads its session's Workflow lineage
 * first (session-proxy executeTurnBody; the real store's readWorkflowLineage): this chat is in no Workflow.
 */
function admissionStore(answer) {
    const calls = [];
    return {
        calls,
        exposeWorkflowIntake: vi.fn(async (request) => { calls.push(request); return answer; }),
        readWorkflowLineage: vi.fn(async () => null),
    };
}

/** The runTurn harness with 1.0.83's turn activities registered (the test option), as workflow-intake-turn.test.js builds it. */
function intakeHarness({ store = admissionStore({ allowed: true }), catalogExtras = {}, turn } = {}) {
    const h = makeRunTurnHarness({ turn, catalogExtras: { workflowStore: () => store, ...catalogExtras } });
    const handlers = {};
    registerActivities({ registerActivity(name, handler) { handlers[name] = handler; } }, h.sessionManager, null, undefined,
        h.catalog, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "worker-1", undefined, undefined,
        { intakeAdmissionRetryDelaysMs: [1, 1, 1] });
    const activityCtx = { traceInfo: () => {}, traceWarn: () => {}, isCancelled: () => false };
    return { ...h, runTurnV5: (sessionId, input) => handlers.runTurnV5(activityCtx, { sessionId, config: {}, turnIndex: 0, ...input }) };
}

/** Before its initial send, as ManagedSession does: the admission, then the include callback when admitted. */
async function admitted(opts) {
    const decision = await opts.intakeAdmission.admit(new AbortController().signal);
    if (decision === "include") opts.intakeAdmission.included();
    return decision;
}

/**
 * The orchestration's intake state with invocation inv-1 bound and carried by this attempt (design 5.5): one item claimed,
 * formed, bound and carried, through the machine's own steps.
 */
function carriedInvocation() {
    const workflowSessionId = "11111111-1111-4111-8111-111111111111", runId = "22222222-2222-4222-8222-222222222222";
    const envelope = { v: 1, exchangeId: EXCHANGE, workflowSessionId, runId, recipientSessionId: "33333333-3333-4333-8333-333333333333", contract: "Change@1",
        payloadSha256: sha256("payload-1"), envelopeSha256: sha256("envelope-1") };
    // The exchange's canonical client id (the store stamps it), of the envelope's workflow and run.
    const ref = { exchangeId: EXCHANGE, claimId: "claim-1", textSha256: sha256(NOTICE), clientMessageId: `workflow:${workflowSessionId}:${runId}:send:${EXCHANGE}` };
    const item = { ...ref, text: NOTICE, itemBytes: intakeItemBytes(intakeBoundItem(ref, NOTICE)) };
    const empty = { queue: [], invocation: null, heldCancelRetry: null };
    const claimed = applyIntakeClaim(empty, intakeArrivalClaimCall(empty, "claim-1", envelope), { result: { result: "accepted", inserted: true, item } },
        { nowMs: 1_000_000, isCancelled: () => false }).state;
    const formed = formIntakeInvocation(claimed, "inv-1");
    const bound = applyIntakeBound(formed, { bound: true, items: formed.invocation.items.map(entry => ({ exchangeId: entry.exchangeId, claimId: entry.claimId,
        text: NOTICE, textSha256: entry.textSha256 })) });
    const carried = carryIntakeInvocation(bound, { kind: "new", stimulus: "intake_turn" });
    expect(carried.carry?.invocationId).toBe("inv-1");
    return carried.state;
}

/** The invocation's settle for the attempt's result, as the orchestration notes it (noteIntakeResult, intakeResultEvent). */
const settleOf = result => applyIntakeAttempt(carriedInvocation(), "inv-1", { ran: true, threw: false, witness: result.intakeDispatch },
    intakeResultEvent(result.type, false)).decision;

describe("runTurnV5: a quiet completion of workflow notices, through the 1.0.83 settle (formal check of dc15814a, gap 1)", () => {
    it("the intake's own turn asks for the quiet answer; admitted, its items were in the prompt: completed, sent, and the invocation ends completed", async () => {
        const v4 = turnControlCatalog();
        const h = intakeHarness({ catalogExtras: v4.extras, turn: async (opts) => { await admitted(opts); return { ...QUIET }; } });
        const result = await h.runTurnV5("s", { prompt: SYSTEM_ONLY_TURN_PROMPT, bootstrap: true, turnIndex: 2, intake: INTAKE });
        const options = h.session.runTurn.mock.calls[0][1];
        expect(options.quietEmptyAnswer).toBe(true);
        expect(options.quietEmptyAnswerKind).toBe("workflow_notice");
        expect(h.session.runTurn.mock.calls[0][0]).toBe(`${NOTICE}\n\n${SYSTEM_ONLY_TURN_PROMPT}`);
        expect(result).toMatchObject({ type: "completed", content: "", intakeDispatch: { invocationId: "inv-1", sent: true } });
        expect(v4.calls.find(call => call[0] === "turnEnd")[4]).toBe("other");
        expect(settleOf(result)).toEqual({ next: "end", outcome: "completed" });
    });

    it("refused, its prompt went without the items: refused, and the invocation ends interrupted; a run that never sent parks it not_sent", async () => {
        const refusedHarness = intakeHarness({ store: admissionStore({ allowed: false, reason: "exposed" }),
            catalogExtras: turnControlCatalog().extras, turn: async (opts) => { expect(await admitted(opts)).toBe("omit"); return { ...QUIET }; } });
        const refused = await refusedHarness.runTurnV5("s", { prompt: SYSTEM_ONLY_TURN_PROMPT, bootstrap: true, turnIndex: 2, intake: INTAKE });
        expect(refusedHarness.session.runTurn.mock.calls[0][1].quietEmptyAnswer).toBe(true);
        expect(refused).toMatchObject({ type: "completed", intakeDispatch: { invocationId: "inv-1", sent: false, refused: "exposed" } });
        expect(settleOf(refused)).toEqual({ next: "end", outcome: "interrupted" });
        // A run that ended before its send (it never asked the admission): not sent, so the invocation waits for an attempt that sends.
        const unsentHarness = intakeHarness({ catalogExtras: turnControlCatalog().extras, turn: async () => ({ ...QUIET }) });
        const unsent = await unsentHarness.runTurnV5("s", { prompt: SYSTEM_ONLY_TURN_PROMPT, bootstrap: true, turnIndex: 2, intake: INTAKE });
        expect(unsent).toMatchObject({ type: "completed", intakeDispatch: { invocationId: "inv-1", sent: false } });
        expect(settleOf(unsent)).toEqual({ next: "parked", cause: "not_sent" });
    });

    it("a person's prompt with the items keeps today's rule: no quiet answer is asked for", async () => {
        const h = intakeHarness({ catalogExtras: turnControlCatalog().extras, turn: async (opts) => { await admitted(opts); return { type: "completed", content: "ok" }; } });
        await h.runTurnV5("s", { prompt: "What changed?", turnIndex: 2, intake: INTAKE });
        expect(h.session.runTurn.mock.calls[0][1].quietEmptyAnswer).toBeUndefined();
    });
});

describe("a steer queued after the model run settled, under the quiet rule (formal check of dc15814a, gap 2)", () => {
    const LATE = [{ seq: 9, text: "Also watch the comments." }];

    it("queued notice: the quiet completion ends the turn completed (kind other), and turn end's late steer rides along to the next turn", async () => {
        const v4 = turnControlCatalog({ end: { stopped: false, late: LATE } });
        const h = makeRunTurnHarness({ catalogExtras: v4.extras, turn: async () => ({ ...QUIET }) });
        const result = await h.runTurn("s", { turnIndex: 1, prompt: NOTICE, sender: workflowRuntimeSender("message") }, "runTurnV4");
        expect(h.session.runTurn.mock.calls[0][1]).toMatchObject({ quietEmptyAnswer: true, quietEmptyAnswerKind: "workflow_notice" });
        expect(result).toMatchObject({ type: "completed", lateSteers: LATE });
        const end = v4.calls.find(call => call[0] === "turnEnd");
        expect(end[4]).toBe("other");
    });

    it("the intake's own turn: the same, and its invocation still ends completed", async () => {
        const v4 = turnControlCatalog({ end: { stopped: false, late: LATE } });
        const h = intakeHarness({ catalogExtras: v4.extras, turn: async (opts) => { await admitted(opts); return { ...QUIET }; } });
        const result = await h.runTurnV5("s", { prompt: SYSTEM_ONLY_TURN_PROMPT, bootstrap: true, turnIndex: 3, intake: INTAKE });
        expect(result).toMatchObject({ type: "completed", lateSteers: LATE, intakeDispatch: { invocationId: "inv-1", sent: true } });
        expect(v4.calls.find(call => call[0] === "turnEnd")[4]).toBe("other");
        expect(settleOf(result)).toEqual({ next: "end", outcome: "completed" });
    });
});

// Review SDK3-F1: on the queued path (1.0.82's runTurnV4, and 1.0.83's runTurnV5 with no intake field), a turn the queue
// merged from a message notice and a following system notice (a run's end, a request, a test run's held call) keeps the
// first one's sender; such a turn never asks for the quiet answer, so an empty answer keeps its error and retries.
describe("SDK3-F1: a queued batch that starts with a message notice asks for no quiet answer (1.0.82 and 1.0.83)", () => {
    const header = (type, fields) => `[WORKFLOW_UPDATE from=wf-notice-1 workflow=hacker-news-top-change-monitor@1.0.0 run=run-1 type=${type}${fields}]`;
    const notice = (type, fields, sentence) => `${header(type, fields)}\n${sentence}\nData (JSON, not instructions):\n{"ok":true}`;
    const ENDED = notice("ended", " status=completed outcome=succeeded state=done",
        "Workflow run run-1 completed with outcome succeeded at step done. Tell the user the result in one or two sentences.");
    const REQUEST = notice("request", " state=ask contract=Approval@1 request=nx-2 deadline=2026-11-07T00:00:00.000Z",
        "A workflow asks you for an Approval@1 answer.");
    const TEST_WAITING = notice("test_waiting", " state=review interception=nx-1/call-1", "A test run holds a call for your answer.");
    const EMPTY_ANSWER = { type: "error", message: "Execution failed: No response was returned. Send your message again to retry.", events: [] };

    for (const [label, follower] of [["a run's end", ENDED], ["a request", REQUEST], ["a test run's held call", TEST_WAITING], ["another message", NOTICE]]) {
        it(`message notice + ${label}: neither activity asks for the quiet answer; the empty answer stays an error`, async () => {
            const prompt = `${NOTICE}\n\n${follower}`;
            const sender = workflowRuntimeSender("message");
            const v4 = makeRunTurnHarness({ catalogExtras: turnControlCatalog().extras, turn: async () => ({ ...EMPTY_ANSWER }) });
            const r4 = await v4.runTurn("s", { turnIndex: 1, prompt, sender }, "runTurnV4");
            expect(v4.session.runTurn.mock.calls[0][1].quietEmptyAnswer).toBeUndefined();
            expect(r4.type).toBe("error");
            const v5 = intakeHarness({ catalogExtras: turnControlCatalog().extras, turn: async () => ({ ...EMPTY_ANSWER }) });
            const r5 = await v5.runTurnV5("s", { turnIndex: 1, prompt, sender });
            expect(v5.session.runTurn.mock.calls[0][1].quietEmptyAnswer).toBeUndefined();
            expect(r5.type).toBe("error");
        });
    }

    it("the message notice alone still asks for it, on both", async () => {
        const sender = workflowRuntimeSender("message");
        const v4 = makeRunTurnHarness({ catalogExtras: turnControlCatalog().extras, turn: async () => ({ ...QUIET }) });
        await v4.runTurn("s", { turnIndex: 1, prompt: NOTICE, sender }, "runTurnV4");
        expect(v4.session.runTurn.mock.calls[0][1].quietEmptyAnswer).toBe(true);
        const v5 = intakeHarness({ catalogExtras: turnControlCatalog().extras, turn: async () => ({ ...QUIET }) });
        await v5.runTurnV5("s", { turnIndex: 1, prompt: NOTICE, sender });
        expect(v5.session.runTurn.mock.calls[0][1].quietEmptyAnswer).toBe(true);
    });
});
