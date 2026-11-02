/**
 * Durable recipient intake, inactive: orchestration 1.0.83 on the native
 * duroxide runtime and PostgreSQL (design docs/proposals/workflow-durable-
 * intake.md 3, 5.5, 6.2 and section 8). The orchestration, its continue-as-
 * new, the real worker activities (runTurnV5 included) over the real CMS,
 * and the real intake activities over the real workflow store run as a
 * worker runs them, and 1.0.83 is registered by this test alone
 * (workflow-v2-intake-native-fixture.js). Test doubles (TEST_DOUBLES): the
 * model session is scripted, the session manager is a fake, the workspace
 * provider of the last case is the fake provider, and the CMS provider
 * budget store is hidden. A failing case records its evidence (boundary,
 * native histories, activity calls, intake rows, transcript records) before
 * its fixture closes; a passing one records a compact receipt.
 *
 * - An enveloped copy is claimed and held; decide binds it and starts a turn
 *   of its own that carries it in runTurnV5's `intake` field under the
 *   workflow-request tag; the model gets the item's canonical text before
 *   the turn's prompt; sent, the invocation ends completed in the store; the
 *   transcript records the item once, as its plain copy would be; the
 *   session then continues as new on 1.0.83 with nothing of the intake.
 * - An attempt that sends and fails retries across a continue-as-new that
 *   carries the retry marker and the retry's count; the retry carries the
 *   same invocation, completes it, and turn start records the item no
 *   second time.
 * - A run that ends before its send leaves the invocation not dispatched,
 *   settled so in the store.
 * - Decision A1: a closed workspace gate refuses the first attempt before
 *   any model run, and the invocation is parked for the gate; a person's
 *   message ends the gate's wait, and its turn, past the gate this time,
 *   carries the same invocation to completion.
 * - Exposure protocol revision 2: each carrying turn's `intake` field has the
 *   batch with its claims, an attempt id recorded for that activity, and
 *   `sentBefore` only on the invocation's own retry; the real store admits
 *   an attempt's include before its send (its exposure record names the
 *   first admitted attempt), and a run that never asks leaves none.
 *
 * These cover the orchestration's own boundaries natively; they are not an
 * activation, a mixed-version, a crash-redelivery or a model qualification.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";
import { admitAndSend, intakeNativeCase, scheduled, eventText, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-v2-intake-native-fixture.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../src/workflow/v2/intake.ts";
import { INTERNAL_SYSTEM_TURN_PROMPT } from "../../src/orchestration_1_0_83/state.ts";

const getEnv = useSuiteEnv(import.meta.url);
const WORKFLOW_SENDER = { kind: "system", display: "workflow message" };

/** A run that sends: the real store admits the carried items first (exposure r2), as ManagedSession asks before its send. */
const sends = result => async (_call, _prompt, opts) => {
    expect(await admitAndSend(opts)).not.toBe("omit");
    return { events: [], ...result };
};
const callsOf = (h, name) => h.calls.filter(call => call.name === name
    && (call.input?.sessionId === h.sessionId || call.input?.recipientSessionId === h.sessionId));
const waiting = ({ history }) => history.some(event => event.kind === "QueueSubscribed");

/** The recipient's transcript records of one client message id. */
async function recordsOf(h, clientMessageId) {
    const events = await h.catalog.getSessionEvents(h.sessionId, 0, 1000);
    return events.filter(event => Array.isArray(event.data?.clientMessageIds) && event.data.clientMessageIds.includes(clientMessageId));
}

describe("workflow v2 durable intake: orchestration 1.0.83 on the native runtime (inactive)", () => {
    it("a claimed copy is bound and carried by a turn of its own; sent, it ends completed, recorded once; the session continues as new on 1.0.83", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        await intakeNativeCase(getEnv(), "arrival to completion", sends({ type: "completed", content: "noted" }), {}, async h => {
            const input = await h.send(1);
            const expected = await h.expectedItem(input);
            await h.start();
            await h.until(waiting, "the session waits for its messages");
            await h.deliver(input);
            const done = await h.until(async ({ info }) => {
                const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
                return row?.processing === "completed" && Number(info.currentExecutionId) >= 2;
            }, "the invocation ends completed and the session continues as new");
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
            expect(row).toMatchObject({ state: "admitted", processing: "completed" });

            // One model run: the item's canonical text, then the intake's own-turn prompt.
            expect(h.prompts).toHaveLength(1);
            expect(h.prompts[0].startsWith(`${expected.text}\n\n`)).toBe(true);
            expect(h.prompts[0]).toContain(INTERNAL_SYSTEM_TURN_PROMPT);
            // The turn ran as runTurnV5 under the workflow-request tag with the bound invocation in its own field: the batch with
            // its claims, the attempt's recorded id, and no retry flag (exposure r2, section 2).
            const turns = callsOf(h, "runTurnV5");
            expect(turns.map(turn => turn.tag)).toEqual([WORKFLOW_REQUEST_CAPABILITY]);
            expect(turns[0].input.intake).toEqual({
                invocationId: row.invocationId, attemptId: expect.any(String), sentBefore: false,
                items: [{ exchangeId: input.envelope.exchangeId, claimId: row.claimId, clientMessageId: expected.clientMessageId, text: expected.text }],
            });
            // The store admitted the include before the send: its exposure record names this attempt.
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId))
                .toMatchObject({ invocationId: row.invocationId, recipientSessionId: h.sessionId, attemptId: turns[0].input.intake.attemptId });
            expect(h.calls.some(call => /^runTurn(2|V3|V4|EpochV4)?$/.test(call.name))).toBe(false);
            // The store writes, each under the workflow-request tag: the claim, the bind, then the end.
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.claim).map(call => call.tag)).toEqual([WORKFLOW_REQUEST_CAPABILITY]);
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.tag])).toEqual([
                ["bind", WORKFLOW_REQUEST_CAPABILITY], ["end", WORKFLOW_REQUEST_CAPABILITY],
            ]);
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle)[1].input).toMatchObject({ invocationId: row.invocationId, outcome: "completed" });

            // The transcript records the item once, as its plain copy would be; the plain copy itself is never read.
            const records = await recordsOf(h, expected.clientMessageId);
            expect(records.map(event => [event.eventType, event.data.content, event.data.sender])).toEqual([["system.message", expected.text, WORKFLOW_SENDER]]);
            const events = await h.catalog.getSessionEvents(h.sessionId, 0, 1000);
            expect(events.some(event => JSON.stringify(event.data ?? {}).includes(`plain-${input.envelope.exchangeId}`))).toBe(false);

            // Natively: one turn scheduled in the first execution; the continue-as-new stays on 1.0.83 and carries no intake.
            const [first, ...later] = await h.histories();
            expect(scheduled(first, "runTurnV5")).toHaveLength(1);
            expect(done.info.orchestrationVersion).toBe("1.0.83");
            const started = later.at(-1)[0];
            expect(started.kind).toBe("OrchestrationStarted");
            expect(eventText(started)).not.toContain('"intake":');
            expect(eventText(started)).not.toContain("intakeRetryInvocationId");
            expect(done.status.status).toBe("Running");
        });
    });

    it("an attempt that sends and fails retries across a continue-as-new carrying the marker; the retry carries the same invocation to completion, recorded once", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        await intakeNativeCase(getEnv(), "error retry across continue-as-new", async (call, _prompt, opts) => {
            expect(await admitAndSend(opts)).toBe("include");
            return call === 1 ? { type: "error", message: "the model call failed", events: [] } : { type: "completed", content: "noted", events: [] };
        }, {}, async h => {
            const input = await h.send(1);
            const expected = await h.expectedItem(input);
            await h.start();
            await h.until(waiting, "the session waits for its messages");
            await h.deliver(input);
            // The retry waits 15 s on a durable timer, continues as new, and its execution completes the invocation.
            await h.until(async ({ info }) => {
                const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
                return row?.processing === "completed" && Number(info.currentExecutionId) >= 3;
            }, "the retry completes the invocation", 150_000);
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);

            // Two model runs, each with the item's text first; two turns of the same invocation, the second its retry.
            expect(h.prompts).toHaveLength(2);
            for (const prompt of h.prompts) expect(prompt.startsWith(`${expected.text}\n\n`)).toBe(true);
            const turns = callsOf(h, "runTurnV5");
            expect(turns.map(turn => [turn.input.intake.invocationId, turn.input.retryCount ?? 0])).toEqual([[row.invocationId, 0], [row.invocationId, 1]]);
            // Exposure r2: each carrying activity has its own recorded attempt id; only the retry, which took the marker, says
            // sentBefore. The first attempt's admission recorded the exposure; the retry was admitted as the invocation's own retry.
            const [firstAttempt, retryAttempt] = turns.map(turn => turn.input.intake);
            expect([firstAttempt.sentBefore, retryAttempt.sentBefore]).toEqual([false, true]);
            expect(retryAttempt.attemptId).not.toBe(firstAttempt.attemptId);
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId)).toMatchObject({ attemptId: firstAttempt.attemptId });
            // One bind; one end, completed.
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([
                ["bind", null], ["end", "completed"],
            ]);

            // Natively: the first execution schedules the failed attempt; its continue-as-new carries the invocation, the
            // pending prompt's retry marker and the retry's count; the next execution schedules the retry.
            const [first, second] = await h.histories();
            expect(scheduled(first, "runTurnV5")).toHaveLength(1);
            expect(scheduled(second, "runTurnV5")).toHaveLength(1);
            const restarted = eventText(second[0]);
            expect(second[0].kind).toBe("OrchestrationStarted");
            expect(restarted).toContain(`"intakeRetryInvocationId":"${row.invocationId}"`);
            expect(restarted).toContain('"intakeRetryAttempt":{"retryCount":1,"thrownTurnKey":null}');

            // Turn start recorded the item on the first attempt and found it recorded on the retry.
            const records = await recordsOf(h, expected.clientMessageId);
            expect(records.map(event => [event.eventType, event.data.sender])).toEqual([["system.message", WORKFLOW_SENDER]]);
        });
    });

    it("a run that ends before its send leaves the invocation not dispatched, and the store settles it so", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        // As ManagedSession answers a held Stop: before its send, so without asking the admission or including the items.
        await intakeNativeCase(getEnv(), "run ends before its send", () => ({ type: "stopped", reason: "Stopped by user", events: [] }), {}, async h => {
            const input = await h.send(1);
            await h.start();
            await h.until(waiting, "the session waits for its messages");
            await h.deliver(input);
            await h.until(async () => (await h.store.readWorkflowIntake(input.envelope.exchangeId))?.processing === "not_dispatched",
                "the invocation ends not dispatched");
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
            expect(row).toMatchObject({ state: "admitted", processing: "not_dispatched" });
            expect(callsOf(h, "runTurnV5")).toHaveLength(1);
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([
                ["bind", null], ["end", "not_dispatched"],
            ]);
            // The run never asked the admission: no exposure is recorded, and the end stands as asked.
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId)).toBeNull();
            expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle)[1].result).toEqual({ ok: true, result: { ended: true } });
        });
    });

    it("decision A1: a closed workspace gate refuses the first attempt before any model run; a person's message ends the gate's wait and its turn carries the same invocation to completion", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-intake-native-ws-"));
        fs.mkdirSync(path.join(root, "repo"), { recursive: true });
        const workspaceProvider = createFakeWorkspaceProvider({ roots: [{ name: "a", path: root }] });
        workspaceProvider.script({ type: "fail", code: "WORKSPACE_IN_USE", message: "held elsewhere", times: 1 });
        try {
            await intakeNativeCase(getEnv(), "gate A1: workspace refusal, then a person's message", sends({ type: "completed", content: "noted" }), {
                workspaceProvider,
                managerExtras: { holdWorkspaceFolders: vi.fn(), noteWorkspaceAttached: vi.fn(), releaseWorkspace: vi.fn(async () => ({ released: true })) },
            }, async h => {
                const input = await h.send(1);
                const expected = await h.expectedItem(input);
                await h.start({ config: { workspace: { schema: 1, root: "a", folder: "repo" } } });
                await h.until(waiting, "the session waits for its messages");
                await h.deliver(input);
                // The first attempt is refused at the workspace check: the session waits for the gate's retry.
                await h.until(({ status }) => {
                    const custom = h.customStatus(status);
                    return custom.status === "waiting" && custom.gate === "workspace";
                }, "the workspace gate refused the first attempt");
                expect(h.prompts).toHaveLength(0);
                expect(callsOf(h, "runTurnV5")).toHaveLength(1);
                const invocationId = callsOf(h, "runTurnV5")[0].input.intake.invocationId;

                await h.say("hello", "person-1");
                await h.until(async () => (await h.store.readWorkflowIntake(input.envelope.exchangeId))?.processing === "completed",
                    "the message's turn completes the invocation");
                // The message's turn passed the gate this time and carried the same invocation; the model got the item first.
                const turns = callsOf(h, "runTurnV5");
                expect(turns.map(turn => turn.input.intake?.invocationId ?? null)).toEqual([invocationId, invocationId]);
                expect(h.prompts).toHaveLength(1);
                expect(h.prompts[0].startsWith(`${expected.text}\n\nhello`)).toBe(true);
                expect(workspaceProvider.callsFor("ensureAttached").length).toBeGreaterThanOrEqual(2);
                expect(callsOf(h, WORKFLOW_INTAKE_ACTIVITIES.settle).map(call => [call.input.op, call.input.outcome ?? null])).toEqual([
                    ["bind", null], ["end", "completed"],
                ]);
                // Exposure r2: the refused attempt never asked the admission; the message's attempt, with its own id, was admitted.
                expect(turns[1].input.intake.attemptId).not.toBe(turns[0].input.intake.attemptId);
                expect(turns.map(turn => turn.input.intake.sentBefore)).toEqual([false, false]);
                expect(await h.store.readWorkflowIntakeExposure(invocationId)).toMatchObject({ attemptId: turns[1].input.intake.attemptId });
            });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
