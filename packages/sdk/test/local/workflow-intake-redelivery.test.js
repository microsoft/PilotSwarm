/**
 * Durable recipient intake: redelivery of an attempt that carries
 * an invocation after a runtime shutdown (exposure protocol revision 2,
 * section 9; decision intake-exposure-r2-implementation), on orchestration
 * frozen 1.0.83 and live 1.0.84, their real V5/V6 turns and the real workflow store over
 * PostgreSQL, with a scripted model session (TEST_DOUBLES). Each case shuts
 * its native runtime down (shutdown(500)) while a carrying activity is in
 * flight and restarts another runtime on the same provider: the activity is
 * left unanswered, its lock runs out, and the new runtime is given the same
 * work item. This is a runtime shutdown and restart with the activity
 * outstanding, not an operating-system crash. Each case checks together: the
 * two executions of one scheduled input (the same attempt id), the
 * completion the history accepted and its witness, the exposure record, the
 * end the store applied and the final intake row.
 *
 * - Shutdown after the send: the redelivered run stops before its send; its
 *   witness says not sent, and its completion is the accepted one; the end
 *   asked as not_dispatched is applied interrupted, never not_dispatched.
 * - Shutdown after the send: the redelivered run is admitted again as the
 *   same attempt and sends (a duplicate request: at least once, never
 *   exactly once); the invocation completes.
 * - The two late-admission order cases: the shut-down execution, which has
 *   not observed its cancellation (as a partitioned worker would not), asks
 *   the store by calling it directly with its run's exact captured admission
 *   request, only after the redelivered run's accepted negative result:
 *   before the end, the end is applied interrupted; after it, the admission
 *   is refused settled, nothing is recorded and the end stands
 *   not_dispatched. These cases call the store directly; they are not a
 *   worker's own send. (An execution that observes its cancellation sends
 *   nothing; the activity-level cases of workflow-intake-turn.test.js
 *   cover that, and these cases only log what the shut-down execution read.)
 * - Shutdown after the send: the redelivered run fails before its send
 *   (asking nothing), and the invocation parks unsent, unaware of the record;
 *   the next carrying attempt, another attempt, is refused as possibly seen,
 *   runs without the items, and ends the invocation interrupted.
 *
 * In all five cases the history accepts the new, redelivered execution's
 * completion. The other order, in which the original execution's completion
 * is accepted after a duplicate execution has started, is not established
 * here.
 *
 * No snapshot store runs here (the session has none): a redelivered turn
 * runs again rather than adopting a saved one, which the adoption cases of
 * workflow-intake-turn.test.js cover. Not an activation or a model
 * qualification.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { admitAndSend, eventText, INTAKE_NATIVE_VARIANTS, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-intake-native-fixture.js";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../src/workflow/intake.ts";
import { sha256Hex } from "../../src/workflow/json.ts";
import { INTAKE_RECORDED_EVENT } from "../../src/orchestration/intake-wiring.ts";

const getEnv = useSuiteEnv(import.meta.url);
/** Short locks, so the crashed runtime's work item and session are taken over soon. */
const CRASH = { runtimeOptions: { workerLockTimeoutMs: 2_000, sessionLockTimeoutMs: 2_000 } };
const STOPPED = { type: "stopped", reason: "Stopped by user", events: [] };

const waiting = ({ history }) => history.some(event => event.kind === "QueueSubscribed");
const turnsOf = h => h.calls.filter(call => call.name === h.turnName && call.input?.sessionId === h.sessionId);
const settlesOf = h => h.calls.filter(call => call.name === WORKFLOW_INTAKE_ACTIVITIES.settle && call.input?.recipientSessionId === h.sessionId);
const rowOf = (h, input) => h.store.readWorkflowIntake(input.envelope.exchangeId);
/**
 * Whether the end settle's activity has returned its answer (the fixture records it as the activity returns). Its row
 * commits inside the activity, so a row read can see the end before the answer is recorded.
 */
const endAnswered = h => settlesOf(h).some(call => call.input.op === "end" && call.result !== undefined);
/**
 * Whether the recipient recorded that the store applied another end outcome to invocation `invocationId`: the
 * orchestration records it only after it applied the end's answer (intake-wiring.ts endInvocation), after the row commits.
 */
async function endAppliedRecorded(h, invocationId) {
    const events = await h.catalog.getSessionEvents(h.sessionId, 0, 1000);
    return events.some(event => event.eventType === INTAKE_RECORDED_EVENT && event.data?.outcome === "end_applied"
        && event.data?.invocationId === invocationId);
}

/** A promise the test resolves. */
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

/** The witnesses of the turn completions every execution's history accepted, in order. */
async function acceptedWitnesses(h) {
    const witnesses = [];
    for (const history of await h.histories()) {
        for (const event of history) {
            if (event.kind !== "ActivityCompleted") continue;
            const match = /"intakeDispatch":(\{[^{}]*\})/.exec(eventText(event));
            if (match) witnesses.push(JSON.parse(match[1]));
        }
    }
    return witnesses;
}

/** The scheduled turns of every execution's history. */
async function scheduledTurns(h) {
    let count = 0;
    for (const history of await h.histories()) {
        count += history.filter(event => event.kind === "ActivityScheduled" && eventText(event).includes(`"name":"${h.turnName}"`)).length;
    }
    return count;
}

/**
 * The first turn's two executions: the crashed runtime's and the redelivered one, of the same scheduled input (the same
 * attempt id), each on its own runtime.
 */
function expectRedelivered(h) {
    const [crashed, redelivered] = turnsOf(h);
    expect(crashed.runtime).toBe(1);
    expect(redelivered.runtime).toBe(2);
    expect(redelivered.input).toEqual(crashed.input);
    expect(typeof crashed.input.intake.attemptId).toBe("string");
    expect(crashed.input.intake.sentBefore).toBe(false);
    return { crashed, redelivered, attemptId: crashed.input.intake.attemptId, invocationId: crashed.input.intake.invocationId };
}

describe.each(INTAKE_NATIVE_VARIANTS)("workflow durable intake: native redelivery $version ($turnName, exposure protocol revision 2)", ({ intakeNativeCase }) => {
    it("shutdown(500) after the send and restart; the redelivered run stops before its send: its completion is accepted, and the end asked as not_dispatched is applied interrupted", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const flags = { sent: false };
        const crashed = deferred();
        await intakeNativeCase(getEnv(), "crash after the send; the redelivery stops", async (call, _prompt, opts) => {
            if (call === 1) {
                expect(await admitAndSend(opts)).toBe("include");
                flags.sent = true;
                await crashed.promise;
                return { type: "completed", content: "never accepted", events: [] };
            }
            return STOPPED;
        }, CRASH, async h => {
            try {
                const input = await h.send(1);
                await h.start();
                await h.until(waiting, "the session waits for its messages");
                await h.deliver(input);
                await h.until(() => flags.sent, "the first execution admitted and sent the items");
                await h.restart();
                await h.until(async () => (await rowOf(h, input))?.processing === "interrupted", "the end is applied interrupted");

                const { redelivered, attemptId, invocationId } = expectRedelivered(h);
                expect(turnsOf(h)).toHaveLength(2);
                expect(redelivered.result.intakeDispatch).toEqual({ invocationId, sent: false });
                // The history accepted one completion of its one scheduled turn: the redelivered run's, not sent.
                expect(await scheduledTurns(h)).toBe(1);
                expect(await acceptedWitnesses(h)).toEqual([{ invocationId, sent: false }]);
                // The crashed execution's admission recorded the exposure under the scheduled attempt id.
                expect(await h.store.readWorkflowIntakeExposure(invocationId)).toMatchObject({ attemptId, recipientSessionId: h.sessionId });
                // The end asked for not_dispatched; the store applied interrupted, and the orchestration recorded that once it
                // applied the end's answer, after the row committed.
                await h.until(() => endAppliedRecorded(h, invocationId), "the applied end is recorded");
                const settles = settlesOf(h);
                expect(settles.map(call => [call.input.op, call.input.outcome ?? null])).toEqual([["bind", null], ["end", "not_dispatched"]]);
                expect(settles[1].result).toEqual({ ok: true, result: { ended: true, outcome: "interrupted" } });
                expect(await rowOf(h, input)).toMatchObject({ state: "admitted", processing: "interrupted", invocationId });
                const recorded = (await h.catalog.getSessionEvents(h.sessionId, 0, 1000)).filter(event => event.eventType === INTAKE_RECORDED_EVENT);
                expect(recorded.map(event => event.data)).toContainEqual({ outcome: "end_applied", invocationId, requested: "not_dispatched", applied: "interrupted" });
            } finally {
                crashed.resolve();
            }
            await h.until(() => turnsOf(h)[0]?.result !== undefined || turnsOf(h)[0]?.error !== undefined, "the crashed execution returns, unanswered");
        });
    });

    it("shutdown(500) after the send and restart; the redelivered run is admitted again as the same attempt and sends: a duplicate request, and the invocation completes", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const flags = { sent: false, again: null };
        const crashed = deferred();
        await intakeNativeCase(getEnv(), "crash after the send; the redelivery sends again", async (call, _prompt, opts) => {
            if (call === 1) {
                expect(await admitAndSend(opts)).toBe("include");
                flags.sent = true;
                await crashed.promise;
                return { type: "completed", content: "never accepted", events: [] };
            }
            flags.again = await admitAndSend(opts);
            return { type: "completed", content: "answered again", events: [] };
        }, CRASH, async h => {
            try {
                const input = await h.send(1);
                await h.start();
                await h.until(waiting, "the session waits for its messages");
                await h.deliver(input);
                await h.until(() => flags.sent, "the first execution admitted and sent the items");
                await h.restart();
                await h.until(async () => (await rowOf(h, input))?.processing === "completed", "the redelivered attempt completes the invocation");

                const { redelivered, attemptId, invocationId } = expectRedelivered(h);
                expect(flags.again).toBe("include");
                expect(redelivered.result.intakeDispatch).toEqual({ invocationId, sent: true });
                expect(await scheduledTurns(h)).toBe(1);
                expect(await acceptedWitnesses(h)).toEqual([{ invocationId, sent: true }]);
                // One record, the first admission's; the redelivery was the same attempt to the store.
                expect(await h.store.readWorkflowIntakeExposure(invocationId)).toMatchObject({ attemptId });
                // The row commits inside the end's activity: its answer is recorded as the activity returns.
                await h.until(() => endAnswered(h), "the end's answer is returned");
                const settles = settlesOf(h);
                expect(settles.map(call => [call.input.op, call.input.outcome ?? null])).toEqual([["bind", null], ["end", "completed"]]);
                expect(settles[1].result).toEqual({ ok: true, result: { ended: true } });
                // Both requests included the items: the model got them twice (at least once, never exactly once).
                expect(h.prompts).toHaveLength(2);
            } finally {
                crashed.resolve();
            }
            await h.until(() => turnsOf(h)[0]?.result !== undefined || turnsOf(h)[0]?.error !== undefined, "the crashed execution returns, unanswered");
        });
    });

    for (const [label, admitsBeforeEnd] of [["before the end", true], ["after the end", false]]) {
        it(`the shut-down execution, which has not observed its cancellation, calls the store directly with its captured admission request only after the redelivered run's accepted negative result, ${label}: ${admitsBeforeEnd
            ? "the end is applied interrupted" : "it is refused settled, nothing is recorded, and the end stands not_dispatched"}`, { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
            const flags = { started: false, eligibleAfterRestart: null };
            const zombieGo = deferred();
            const endGate = deferred();
            const options = {
                ...CRASH,
                // The redelivered attempt's end is held until the test lets it through.
                beforeActivity: (name, input) => (name === WORKFLOW_INTAKE_ACTIVITIES.settle && input?.op === "end" ? endGate.promise : null),
            };
            await intakeNativeCase(getEnv(), `a crashed execution asks the store ${label}`, async (call, _prompt, opts) => {
                if (call === 1) {
                    flags.started = true;
                    await zombieGo.promise;
                    // Observed only: whether this execution's activity reads its cancellation once its runtime is gone (review
                    // of c1bda7a2, W2: a run that does sends nothing). It sends nothing here either way.
                    flags.eligibleAfterRestart = opts.intakeAdmission?.eligible?.() ?? null;
                    return { type: "completed", content: "never accepted", events: [] };
                }
                return STOPPED;
            }, options, async h => {
                try {
                    const input = await h.send(1);
                    await h.start();
                    await h.until(waiting, "the session waits for its messages");
                    await h.deliver(input);
                    await h.until(() => flags.started, "the first execution started, before its admission");
                    await h.restart();
                    await h.until(() => settlesOf(h).some(call => call.input.op === "end"), "the redelivered attempt's end is asked, and held");
                    const { crashed, redelivered, attemptId, invocationId } = expectRedelivered(h);
                    expect(redelivered.result.intakeDispatch).toEqual({ invocationId, sent: false });
                    expect(await acceptedWitnesses(h)).toEqual([{ invocationId, sent: false }]);
                    // The crashed execution's admission as its run makes it (a partitioned worker that has not observed its
                    // cancellation): its activity's session, the scheduled attempt id, and the hash of each exact text.
                    const late = () => h.store.exposeWorkflowIntake({
                        recipientSessionId: h.sessionId, invocationId, attemptId, sentBefore: crashed.input.intake.sentBefore,
                        items: crashed.input.intake.items.map(item => ({ exchangeId: item.exchangeId, claimId: item.claimId, textSha256: sha256Hex(item.text) })),
                    });
                    if (admitsBeforeEnd) {
                        expect(await late()).toEqual({ allowed: true });
                        expect(await h.store.readWorkflowIntakeExposure(invocationId)).toMatchObject({ attemptId });
                        endGate.resolve();
                        await h.until(async () => (await rowOf(h, input))?.processing === "interrupted", "the end is applied interrupted");
                        await h.until(() => endAnswered(h), "the end's answer is returned");
                        expect(settlesOf(h)[1].result).toEqual({ ok: true, result: { ended: true, outcome: "interrupted" } });
                    } else {
                        endGate.resolve();
                        await h.until(async () => (await rowOf(h, input))?.processing === "not_dispatched", "the end stands not_dispatched");
                        await h.until(() => endAnswered(h), "the end's answer is returned");
                        expect(await late()).toEqual({ allowed: false, reason: "settled" });
                        expect(await h.store.readWorkflowIntakeExposure(invocationId)).toBeNull();
                        expect(settlesOf(h)[1].result).toEqual({ ok: true, result: { ended: true } });
                        expect(await rowOf(h, input)).toMatchObject({ processing: "not_dispatched", reason: null });
                    }
                    expect(settlesOf(h).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([["bind", null], ["end", "not_dispatched"]]);
                } finally {
                    zombieGo.resolve();
                    endGate.resolve();
                }
                await h.until(() => turnsOf(h)[0]?.result !== undefined || turnsOf(h)[0]?.error !== undefined, "the crashed execution returns, unanswered");
                console.info("workflow intake native observation", JSON.stringify({ case: label, crashedExecutionEligibleAfterRestart: flags.eligibleAfterRestart }));
            });
        });
    }

    it("shutdown(500) after the send and restart; the redelivered run fails before its send and the invocation parks unsent; the next carrying attempt is refused as possibly seen and ends it interrupted", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const flags = { sent: false, third: null };
        const crashed = deferred();
        await intakeNativeCase(getEnv(), "crash after the send; a later attempt is refused exposed", async (call, _prompt, opts) => {
            if (call === 1) {
                expect(await admitAndSend(opts)).toBe("include");
                flags.sent = true;
                await crashed.promise;
                return { type: "completed", content: "never accepted", events: [] };
            }
            // The redelivered run ends before its send, as ManagedSession does for a missing required tool: it asks nothing.
            if (call === 2) return { type: "error", message: 'Required tool "lookup" is not available in this session.', retryable: false, events: [] };
            flags.third = await admitAndSend(opts);
            return { type: "completed", content: "answered without the items", events: [] };
        }, CRASH, async h => {
            try {
                const input = await h.send(1);
                await h.start();
                await h.until(waiting, "the session waits for its messages");
                await h.deliver(input);
                await h.until(() => flags.sent, "the first execution admitted and sent the items");
                await h.restart();
                await h.until(() => turnsOf(h)[1]?.result !== undefined, "the redelivered run failed before its send");
                const { redelivered, attemptId, invocationId } = expectRedelivered(h);
                expect(redelivered.result.intakeDispatch).toEqual({ invocationId, sent: false });
                // Parked unsent, not ended: the orchestration did not read the record.
                expect(await rowOf(h, input)).toMatchObject({ processing: "bound" });

                await h.say("hello", "person-1");
                await h.until(async () => (await rowOf(h, input))?.processing === "interrupted", "the next attempt ends the invocation interrupted");
                const turns = turnsOf(h);
                expect(turns).toHaveLength(3);
                const next = turns[2];
                expect(next.input.intake.invocationId).toBe(invocationId);
                expect(next.input.intake.attemptId).not.toBe(attemptId);
                expect(next.input.intake.sentBefore).toBe(false);
                expect(flags.third).toBe("omit");
                expect(next.result.intakeDispatch).toEqual({ invocationId, sent: false, refused: "exposed" });
                expect(await acceptedWitnesses(h)).toEqual([{ invocationId, sent: false }, { invocationId, sent: false, refused: "exposed" }]);
                expect(await h.store.readWorkflowIntakeExposure(invocationId)).toMatchObject({ attemptId });
                expect(settlesOf(h).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([["bind", null], ["end", "interrupted"]]);
            } finally {
                crashed.resolve();
            }
            await h.until(() => turnsOf(h)[0]?.result !== undefined || turnsOf(h)[0]?.error !== undefined, "the crashed execution returns, unanswered");
        });
    });
});
