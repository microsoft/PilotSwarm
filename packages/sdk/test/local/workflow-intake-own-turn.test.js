/**
 * Durable recipient intake: decide's turn for the intake alone on
 * the native duroxide runtime and PostgreSQL (design docs/proposals/
 * workflow-durable-intake.md 6.2, the own turn's timer note and child
 * digest, and section 3, the item's transcript record). Frozen 1.0.83
 * and live 1.0.84 run separately; the real worker activities (V5/V6 turns)
 * and the real intake activities run over the real CMS and workflow store
 * (workflow-intake-native-fixture.js). Doubles (TEST_DOUBLES, recorded
 * with each receipt and piece of evidence): the scripted model session, the
 * fake session manager and the hidden provider budget store.
 *
 * A workflow's copy arrives while the agent's own wait is armed and a
 * child's summary is buffered. Drain releases the wait as it does for queued
 * work, and decide's turn for the item alone takes, in its system context,
 * the released wait's note and the buffered child digest, as drain gives
 * them to a newly arrived prompt. The item's canonical text comes first in
 * the model's prompt and is never changed. Turn start records the turn's
 * system note and the item once, with its canonical id and the system
 * sender. After the turn the wait resumes with the time it had left, and its
 * end runs a turn of its own that carries nothing.
 *
 * Limits: the child is a tracked entry with no orchestration of its own; the
 * cron and cron_at notes take the same release path and are unit-tested.
 * Not an activation, a mixed-version or a model qualification.
 */
import { describe, expect, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { admitAndSend, INTAKE_NATIVE_VARIANTS, INTAKE_NATIVE_TIMEOUT } from "../helpers/workflow-intake-native-fixture.js";
import { WORKFLOW_INTAKE_ACTIVITIES } from "../../src/workflow/intake.ts";
import { INTERNAL_SYSTEM_TURN_PROMPT } from "../../src/orchestration/state.ts";

const getEnv = useSuiteEnv(import.meta.url);
/**
 * The sender a workflow's message is recorded with (batch 7, w-4; SF-2): kind workflow, named by its session (a send's
 * text names no workflow), with the header's type and ids, read from the message's own header.
 */
const workflowSender = text => {
    const field = name => new RegExp(`\\b${name}=(\\S+?)[\\s\\]]`).exec(text)?.[1] ?? null;
    return { kind: "workflow", display: `workflow ${field("from").slice(0, 8)}`, workflow: { type: "message", sessionId: field("from"), runId: field("run") } };
};
const W = "First turn W: wait for the build.";
const CHILD = "c0ffee00-0000-4000-8000-000000000002";
const S = "Child summary S: the risk scan found two risky changes.";
/** The note of the released wait, as drain gives it to a newly arrived prompt. */
const WAIT_NOTE = /interrupted your 20s timer \(reason: "nap"\)\. \d+s elapsed, \d+s remain\./;

const turnsOf = h => h.calls.filter(call => call.name === h.turnName);
const waiting = ({ history }) => history.some(event => event.kind === "QueueSubscribed");
const enqueue = (h, message) => h.client.enqueueEvent(h.instanceId, "messages", JSON.stringify(message));

describe.each(INTAKE_NATIVE_VARIANTS)("workflow durable intake: intake's own native turn $version ($turnName)", ({ intakeNativeCase }) => {
    it("6.2: a copy that arrives during the agent's wait gets a turn of its own with the released wait's note and the buffered child digest in its system context; the wait resumes after it", { timeout: INTAKE_NATIVE_TIMEOUT }, async () => {
        // The first run waits 20 s; every later run sends what it is given and completes.
        const script = async (call, _prompt, opts) => {
            await admitAndSend(opts);
            return call === 1
                ? { type: "wait", seconds: 20, reason: "nap", content: "waiting for the build", events: [] }
                : { type: "completed", content: `answer ${call}`, events: [] };
        };
        await intakeNativeCase(getEnv(), "own turn: the wait's note and the child digest", script, {}, async h => {
            const input = await h.send(1);
            const expected = await h.expectedItem(input);
            await h.start({ subAgents: [{ orchId: `session-${CHILD}`, sessionId: CHILD, task: "risk scan", status: "running" }] });
            await h.until(waiting, "the session waits for its messages");
            await h.say(W, "w-1");
            await h.until(({ status }) => {
                const custom = h.customStatus(status);
                return custom.status === "waiting" && custom.waitReason === "nap";
            }, "the agent's 20 s wait is armed");
            // While it waits: a child's summary is buffered, then the workflow's copy arrives.
            await enqueue(h, { prompt: `[CHILD_UPDATE from=${CHILD} type=completed iter=1 verdict=success]\n${S}` });
            await h.deliver(input);
            await h.until(async () => (await h.store.readWorkflowIntake(input.envelope.exchangeId))?.processing === "completed"
                && turnsOf(h)[1]?.result !== undefined, "the copy's own turn completes its invocation");
            const row = await h.store.readWorkflowIntake(input.envelope.exchangeId);
            expect(row).toMatchObject({ state: "admitted", processing: "completed" });

            // decide's turn for the item alone: the internal prompt as a bootstrap turn, the bound item in its own field.
            const own = turnsOf(h)[1];
            expect(own.input.prompt.startsWith(INTERNAL_SYSTEM_TURN_PROMPT)).toBe(true);
            expect(own.input.bootstrap).toBe(true);
            expect(own.input.intake).toMatchObject({
                invocationId: row.invocationId, sentBefore: false,
                items: [{ exchangeId: input.envelope.exchangeId, clientMessageId: expected.clientMessageId, text: expected.text }],
            });
            // Its system context holds the released wait's note and the buffered digest; neither is in the item.
            expect(own.input.prompt).toMatch(WAIT_NOTE);
            expect(own.input.prompt).toContain("Buffered child updates arrived");
            expect(own.input.prompt).toContain(S);
            expect(own.input.prompt).not.toContain(expected.text);
            // The model gets the item's canonical text first, then that prompt with its note and digest.
            expect(h.prompts[1].startsWith(`${expected.text}\n\n`)).toBe(true);
            expect(h.prompts[1]).toContain(INTERNAL_SYSTEM_TURN_PROMPT);
            expect(h.prompts[1]).toMatch(WAIT_NOTE);
            expect(h.prompts[1]).toContain(S);
            // One bind and one end, completed; the store admitted the own turn's attempt.
            const settles = h.calls.filter(call => call.name === WORKFLOW_INTAKE_ACTIVITIES.settle && call.input?.recipientSessionId === h.sessionId);
            expect(settles.map(call => [call.input.op, call.input.outcome ?? null])).toEqual([["bind", null], ["end", "completed"]]);
            expect(await h.store.readWorkflowIntakeExposure(row.invocationId)).toMatchObject({ attemptId: own.input.intake.attemptId });

            // Turn start recorded the turn's system note, then the item once, as its plain copy would be.
            const events = await h.catalog.getSessionEvents(h.sessionId, 0, 1000);
            const itemRecords = events.filter(event => Array.isArray(event.data?.clientMessageIds)
                && event.data.clientMessageIds.includes(expected.clientMessageId));
            expect(itemRecords.map(event => [event.eventType, event.data.content, event.data.sender])).toEqual([["system.message", expected.text, workflowSender(expected.text)]]);
            const notes = events.filter(event => event.eventType === "system.message" && WAIT_NOTE.test(String(event.data?.content ?? "")));
            expect(notes).toHaveLength(1);
            expect(notes[0].data.content).toContain(S);
            expect(notes[0].seq).toBeLessThan(itemRecords[0].seq);

            // The released wait resumes with the time it had left; its end runs a turn of its own that carries nothing.
            await h.until(() => turnsOf(h).length >= 3 && turnsOf(h)[2].result !== undefined, "the resumed wait ends in a turn of its own", 90_000);
            const resumed = turnsOf(h)[2];
            expect(resumed.input.prompt).toMatch(/^The \d+ second wait is now complete\./);
            expect(Object.hasOwn(resumed.input, "intake")).toBe(false);
            expect(h.prompts).toHaveLength(3);
            expect(h.prompts[2]).not.toContain(expected.text);
        });
    });
});
