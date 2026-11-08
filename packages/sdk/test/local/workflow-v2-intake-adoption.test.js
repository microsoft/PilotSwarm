/**
 * Ordinary retry ownership on the real session lifecycle, inactive (review
 * Q-W2-7, decision ordinary-retry-ownership-83; design docs/proposals/
 * workflow-durable-intake.md 5.5): orchestration 1.0.83 on the native
 * duroxide runtime and PostgreSQL, with its turns run by the real worker
 * activity (runTurnV5) and the real session lifecycle (the runTurn preamble,
 * the already-committed adoption and the commit) over a real versioned
 * FilesystemSessionStore (workflow-v2-intake-native-fixture.js, snapshot
 * mode). Each model run leaves one line in the saved conversation, so the
 * store shows which runs a version holds.
 *
 * - Committed T: an attempt of turn P saves its snapshot under its key T and
 *   then fails (the worker's own fault point after the commit). While its
 *   retry waits, a child's summary S and a person's follow-up U arrive, and
 *   a set_model forces a continue-as-new before the retry's dispatch. The
 *   retry still sends T with its count and P's prompt alone, and adopts the
 *   saved turn: no second model run of P and no new version. What arrived
 *   after the attempt rides turns of its own, each under a key of its own:
 *   the model notice with the switch's continuation, and S with U.
 * - Uncommitted T: an attempt that fails before its commit (the worker's
 *   fault point before the compare-and-swap) leaves nothing under T. The
 *   retry sends T again, rehydrates the last saved version, runs P once more
 *   and saves it under T; the failed attempt's run is not in the store.
 * - Review W2-WIT3: P's attempt carried no workflow item; a workflow's copy
 *   that arrives while its retry waits is not attached to that retry, which
 *   adopts a saved turn with no witness. The invocation is bound after the
 *   retry and the next attempt, under a key of its own, carries, sends and
 *   completes it.
 * - Lossy-fresh control: attempts whose completions are lost to a closed
 *   connection retry with T and adopt the saved turn; once those retries are
 *   spent, the lossy handoff's retry has count 0 and no key, so it never
 *   adopts: it runs P again and saves it under a key of its own.
 *
 * Doubles (testDoublesOf, recorded with each receipt and piece of evidence):
 * the scripted model session; the fake session manager, which writes a
 * session layout on create and, for the switch, takes a model name as
 * given; the hidden provider budget store; and, in the last case only, the
 * transport: the fixture throws "Connection is closed" in place of a
 * completed turn's result (afterActivity), a completion lost on the way
 * back. The other cases fail inside the real worker activity, at its own
 * fault points (PILOTSWARM_FAULT_INJECT, armed for one attempt). Limits: the
 * forced continue-as-new is set_model's (the iteration and history caps are
 * unit-tested); the child is a tracked entry with no orchestration of its
 * own; the store is the filesystem one, not the blob store. These are not an
 * activation, a mixed-version or a model qualification.
 */
import { afterEach, describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { admitAndSend, eventText, intakeNativeCase, scheduled, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-v2-intake-native-fixture.js";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../src/workflow/v2/intake.ts";
import { INTERNAL_SYSTEM_TURN_PROMPT } from "../../src/orchestration/state.ts";

const getEnv = useSuiteEnv(import.meta.url);
const FAULT = "PILOTSWARM_FAULT_INJECT";

const W = "First turn W: say hello.";
const P = "Owner turn P: draft the release note for build 7.";
const U = "Follow-up U: and name its two riskiest changes.";
const S = "Child summary S: the risk scan found two risky changes.";
const CHILD = "c0ffee00-0000-4000-8000-000000000001";
const NOTICE = "Runtime model for this turn is m2.";

/** The scripted model's answer, by the turn a prompt belongs to. */
function answerTo(prompt) {
    if (prompt.includes(P)) return "P answered";
    if (prompt.includes(U)) return "U answered";
    if (prompt.includes("Continue on m2.")) return "continued on m2";
    if (prompt.includes(W)) return "W answered";
    return "other";
}
const script = async (_call, prompt, opts) => {
    await admitAndSend(opts);
    return { type: "completed", content: answerTo(prompt), events: [] };
};

const turnsOf = h => h.calls.filter(call => call.name === "runTurnV5");
const keyOf = call => call.input.snapshot?.turnKey ?? null;
const waiting = ({ history }) => history.some(event => event.kind === "QueueSubscribed");
const enqueue = (h, message) => h.client.enqueueEvent(h.instanceId, "messages", JSON.stringify(message));
/** The tail of P's owed retry as a continue-as-new input carries it: its envelope, count, key and kind. */
const owedP = (key, count, fresh = false) => `"clientMessageIds":["p-1"],"sender":null,"attachments":[],"retryCount":${count},`
    + `"thrownTurnKey":${key === null ? "null" : `"${key}"`},"fresh":${fresh}}`;

/**
 * The worker's own fault point, armed for one turn attempt: the first runTurnV5 that starts after `arm` meets it,
 * and the setting is gone before any later one starts.
 */
function oneAttemptFault() {
    let starts = 0;
    let armedAt = null;
    return {
        arm(point) {
            process.env[FAULT] = `${point}:throw`;
            armedAt = starts;
        },
        beforeActivity: name => {
            if (name !== "runTurnV5") return;
            starts += 1;
            if (armedAt !== null && starts > armedAt + 1) {
                delete process.env[FAULT];
                armedAt = null;
            }
        },
    };
}

afterEach(() => {
    delete process.env[FAULT];
});

describe("workflow v2 durable intake: the owed retry on the real session lifecycle (orchestration 1.0.83, inactive)", () => {
    it("committed T: after a set_model's continue-as-new while it waited, P's owed retry adopts the saved turn; the model notice, the child's summary and the follow-up ride turns of their own", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const fault = oneAttemptFault();
        await intakeNativeCase(getEnv(), "committed T adopted after a forced continue-as-new", script, {
            snapshots: true, beforeActivity: fault.beforeActivity,
            // The switch names a model that the fake manager takes as given: this worker has no provider registry.
            managerExtras: { refreshModelProviders: async () => {}, normalizeModelRef: ref => ref },
        }, async h => {
            await h.start({ blobEnabled: true, subAgents: [{ orchId: `session-${CHILD}`, sessionId: CHILD, task: "risk scan", status: "running" }] });
            await h.until(waiting, "the session waits for its messages");
            fault.arm("turn.control.after-commit");
            await h.say(P, "p-1");
            // The first attempt runs the model, saves the turn under its key T, then fails at the fault point.
            await h.until(() => turnsOf(h).some(call => call.error !== undefined), "P's first attempt fails after its commit");
            const [first] = turnsOf(h);
            const T = keyOf(first);
            expect(T).toEqual(expect.any(String));
            expect([first.input.retryCount, first.error.message]).toEqual([0, expect.stringContaining("fault-injection: turn.control.after-commit")]);
            expect(await h.snapshots.probe()).toMatchObject({ exists: true, version: 1, turnKey: T });

            // While the retry waits (15 s): the child's summary, the person's follow-up, then a model switch.
            await enqueue(h, { prompt: `[CHILD_UPDATE from=${CHILD} type=completed iter=1 verdict=success]\n${S}` });
            await h.say(U, "u-1");
            await enqueue(h, { type: "cmd", cmd: "set_model", id: "cmd-model-1", args: { model: "m2" } });
            await h.until(async () => turnsOf(h).length >= 4 && turnsOf(h)[3].result !== undefined
                && (await h.snapshots.probe()).version === 3, "the retry, the switch's continuation and U's turn complete", 120_000);

            const turns = turnsOf(h);
            expect(turns).toHaveLength(4);
            const [, retry, continued, follow] = turns;
            // The retry sends T again with its count, P's prompt and P's ids alone; the worker adopts the saved turn.
            expect([keyOf(retry), retry.input.retryCount, retry.input.prompt]).toEqual([T, 1, first.input.prompt]);
            expect(retry.input.clientMessageIds).toEqual(["p-1"]);
            for (const later of [NOTICE, S, U]) expect(retry.input.prompt).not.toContain(later);
            expect(retry.error).toBeUndefined();
            expect(retry.result).toMatchObject({ type: "completed", content: "P answered", snapshotVersion: 1 });
            // The model ran P once. The switch's continuation took the model notice, and U's turn took the child's summary.
            expect(h.prompts).toHaveLength(3);
            expect(h.prompts.filter(prompt => prompt.includes(P))).toHaveLength(1);
            expect(h.prompts[0]).toContain(P);
            expect(h.prompts[1]).toContain("Continue on m2.");
            expect(h.prompts[1]).toContain(NOTICE);
            expect(h.prompts[2]).toContain(U);
            expect(h.prompts[2]).toContain(S);
            // Each later turn draws a key of its own, starts at count 0 and saves the next version.
            expect(new Set([T, keyOf(continued), keyOf(follow)]).size).toBe(3);
            expect([continued.input.retryCount, follow.input.retryCount]).toEqual([0, 0]);
            expect([continued.result.snapshotVersion, follow.result.snapshotVersion]).toEqual([2, 3]);
            expect(follow.input.clientMessageIds).toEqual(["u-1"]);
            expect(await h.snapshots.probe()).toMatchObject({ version: 3, turnKey: keyOf(follow) });
            // The saved conversation holds each model run once, P's first.
            expect(h.snapshots.modelRuns().map(run => [run.modelRun, answerTo(run.prompt)])).toEqual([
                [1, "P answered"], [2, "continued on m2"], [3, "U answered"],
            ]);

            // Natively: the first execution schedules P's attempt; its retry's continue-as-new owes P with count 1 and T. The
            // next execution handles the switch and continues as new before any turn, still owing P whole and carrying the
            // continuation and its notice apart from it; the one after runs the retry first, then the continuation and U.
            const [e1, e2, e3] = await h.histories();
            expect(scheduled(e1, "runTurnV5")).toHaveLength(1);
            expect(eventText(e2[0])).toContain(owedP(T, 1));
            expect(scheduled(e2, "runTurnV5")).toHaveLength(0);
            const third = eventText(e3[0]);
            expect(third).toContain(owedP(T, 1));
            expect(third).toContain('"prompt":"Continue on m2."');
            expect(third).toContain(`"runtimeModelNotice":"${NOTICE}`);
            expect(scheduled(e3, "runTurnV5")).toHaveLength(3);
        });
    });

    it("uncommitted T: P's attempt failed before its commit and left nothing under T; the owed retry sends T again, rehydrates the last saved version, runs P once more and saves it under T", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const fault = oneAttemptFault();
        await intakeNativeCase(getEnv(), "uncommitted T run again under T", script, { snapshots: true, beforeActivity: fault.beforeActivity }, async h => {
            await h.start({ blobEnabled: true });
            await h.until(waiting, "the session waits for its messages");
            await h.say(W, "w-1");
            await h.until(async () => turnsOf(h)[0]?.result !== undefined && (await h.snapshots.probe()).version === 1, "W saves version 1");
            fault.arm("turn.commit.before-cas");
            await h.say(P, "p-1");
            await h.until(() => turnsOf(h).some(call => call.error !== undefined), "P's attempt fails before its commit");
            const [w, first] = turnsOf(h);
            const T = keyOf(first);
            expect(first.error.message).toContain("fault-injection: turn.commit.before-cas");
            // Nothing was saved under T: the tip is still W's.
            expect(await h.snapshots.probe()).toMatchObject({ version: 1, turnKey: keyOf(w) });
            // The tip moves to T when the retry's turn commits, inside its activity; the activity's result is recorded only when
            // it returns, so the case waits for both before it reads that result.
            await h.until(async () => turnsOf(h)[2]?.result !== undefined && (await h.snapshots.probe()).turnKey === T,
                "the owed retry saves P under T", 120_000);

            const turns = turnsOf(h);
            expect(turns).toHaveLength(3);
            const retry = turns[2];
            expect([keyOf(retry), retry.input.retryCount, retry.input.prompt]).toEqual([T, 1, first.input.prompt]);
            expect(retry.result).toMatchObject({ type: "completed", content: "P answered", snapshotVersion: 2 });
            // Nothing to adopt: the model ran P again, on the rehydrated conversation.
            expect(h.prompts).toHaveLength(3);
            expect(h.prompts.filter(prompt => prompt.includes(P))).toHaveLength(2);
            expect(await h.snapshots.probe()).toMatchObject({ version: 2, turnKey: T });
            // The saved conversation holds W's run and the retry's run of P; the failed attempt's run was never saved.
            expect(h.snapshots.modelRuns().map(run => [run.modelRun, answerTo(run.prompt)])).toEqual([[1, "W answered"], [3, "P answered"]]);
            // Natively: the retry's continue-as-new owes P with count 1 and T, and its execution runs that retry.
            const all = await h.histories();
            const owing = all.findIndex(history => eventText(history[0]).includes(owedP(T, 1)));
            expect(owing).toBeGreaterThan(0);
            expect(scheduled(all[owing], "runTurnV5")).toHaveLength(1);
        });
    });

    it("review W2-WIT3: P's owed retry adopts the turn its attempt saved, which carried nothing, and carries nothing itself; a workflow's copy that arrived meanwhile is bound after it and completed by the next attempt", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const fault = oneAttemptFault();
        await intakeNativeCase(getEnv(), "W2-WIT3: the adopting retry carries nothing", script, { snapshots: true, beforeActivity: fault.beforeActivity }, async h => {
            const input = await h.send(1);
            const expected = await h.expectedItem(input);
            await h.start({ blobEnabled: true });
            await h.until(waiting, "the session waits for its messages");
            fault.arm("turn.control.after-commit");
            await h.say(P, "p-1");
            await h.until(() => turnsOf(h).some(call => call.error !== undefined), "P's attempt fails after its commit");
            const T = keyOf(turnsOf(h)[0]);
            expect(Object.hasOwn(turnsOf(h)[0].input, "intake")).toBe(false);
            // While the retry waits, the workflow's copy arrives; the retry's execution claims it first.
            await h.deliver(input);
            await h.until(async () => (await h.store.readWorkflowIntake(input.envelope.exchangeId))?.processing === "completed",
                "the copy's invocation completes", 120_000);
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);

            const turns = turnsOf(h);
            expect(turns).toHaveLength(3);
            const [, retry, carrying] = turns;
            // The retry sends T with its count and no batch; it adopts the saved turn, which has no witness: no model run.
            expect([keyOf(retry), retry.input.retryCount, Object.hasOwn(retry.input, "intake")]).toEqual([T, 1, false]);
            expect(retry.result).toMatchObject({ type: "completed", content: "P answered", snapshotVersion: 1 });
            expect(retry.result.intakeDispatch).toBeUndefined();
            // The invocation is bound only after the retry, and the next attempt, under a key of its own, carries and sends it.
            const settles = h.calls.filter(call => call.name === WORKFLOW_INTAKE_ACTIVITIES.settle && call.input?.recipientSessionId === h.sessionId);
            expect(settles.map(call => [call.input.op, call.input.outcome ?? null])).toEqual([["bind", null], ["end", "completed"]]);
            expect(h.calls.indexOf(settles[0])).toBeGreaterThan(h.calls.indexOf(retry));
            expect(keyOf(carrying)).not.toBe(T);
            expect(carrying.input.intake).toMatchObject({
                invocationId: row.invocationId, sentBefore: false,
                items: [{ exchangeId: input.envelope.exchangeId, clientMessageId: expected.clientMessageId, text: expected.text }],
            });
            expect(carrying.result).toMatchObject({ intakeDispatch: { invocationId: row.invocationId, sent: true }, snapshotVersion: 2 });
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId)).toMatchObject({ attemptId: carrying.input.intake.attemptId });
            // Two model runs: P's, then the carrying turn's, with the item's canonical text first; both saved, in order.
            expect(h.prompts).toHaveLength(2);
            expect(h.prompts[1].startsWith(`${expected.text}\n\n`)).toBe(true);
            expect(h.prompts[1]).toContain(INTERNAL_SYSTEM_TURN_PROMPT);
            expect(await h.snapshots.probe()).toMatchObject({ version: 2, turnKey: keyOf(carrying) });
            expect(h.snapshots.modelRuns().map(run => run.modelRun)).toEqual([1, 2]);
        });
    });

    it("lossy-fresh control: retries after completions lost to a closed connection send T and adopt the saved turn; the lossy handoff's retry has count 0 and no key, never adopts, and runs P again under a key of its own", { timeout: 240_000 }, async () => {
        let lost = 0;
        // The transport double: the first four turn completions are lost to a closed connection after the real handler ran.
        const afterActivity = name => {
            if (name !== "runTurnV5" || lost >= 4) return undefined;
            lost += 1;
            return new Error("Connection is closed");
        };
        await intakeNativeCase(getEnv(), "lossy-fresh control", script, { snapshots: true, afterActivity }, async h => {
            await h.start({ blobEnabled: true });
            await h.until(waiting, "the session waits for its messages");
            await h.say(P, "p-1");
            // Four attempts, 15 s apart, lose their completions; then the lossy handoff's retry completes.
            await h.until(() => turnsOf(h).length >= 5 && turnsOf(h)[4].result !== undefined && turnsOf(h)[4].error === undefined,
                "the lossy handoff's retry completes", 180_000);

            const turns = turnsOf(h);
            expect(turns).toHaveLength(5);
            const T = keyOf(turns[0]);
            expect(turns.slice(0, 4).map(keyOf)).toEqual([T, T, T, T]);
            expect(turns.map(turn => turn.input.retryCount)).toEqual([0, 1, 2, 3, 0]);
            expect(turns.map(turn => turn.lostCompletion === true)).toEqual([true, true, true, true, false]);
            // The same-key retries adopted the saved turn: version 1 under T, P's first answer, and no model run.
            for (const turn of turns.slice(1, 4)) expect(turn.result).toMatchObject({ type: "completed", content: "P answered", snapshotVersion: 1 });
            // The lossy handoff's retry sends a key of its own at count 0: it never adopts; the model runs P again, and the
            // run is saved as version 2 under that key.
            const fresh = turns[4];
            expect(keyOf(fresh)).not.toBe(T);
            expect(fresh.input.prompt).toContain(P);
            expect(fresh.result).toMatchObject({ type: "completed", content: "P answered", snapshotVersion: 2 });
            expect(h.prompts).toHaveLength(2);
            expect(h.prompts.every(prompt => prompt.includes(P))).toBe(true);
            expect(await h.snapshots.probe()).toMatchObject({ version: 2, turnKey: keyOf(fresh) });
            expect(h.snapshots.modelRuns().map(run => run.modelRun)).toEqual([1, 2]);
            // Natively: the retries' continue-as-new inputs owe P with T at counts 1 to 3; the handoff's owes it fresh.
            const starts = (await h.histories()).map(history => eventText(history[0]));
            for (const count of [1, 2, 3]) expect(starts.filter(text => text.includes(owedP(T, count)))).toHaveLength(1);
            expect(starts.filter(text => text.includes(owedP(null, 0, true)))).toHaveLength(1);
            const events = await h.catalog.getSessionEvents(h.sessionId, 0, 1000);
            expect(events.filter(event => event.eventType === "session.lossy_handoff")).toHaveLength(1);
        });
    });
});
