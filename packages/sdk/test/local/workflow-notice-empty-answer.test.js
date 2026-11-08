/**
 * Owner "No response" dump (2026-11-06; build d838a303, orchestration 1.0.83, gpt-5.6-terra): chat 726e9bfc ran two
 * copies of a monitor whose send state messages the chat. Each repeated notice says "Use it as the user asked; it needs
 * no answer." The model answered 29 of them with nothing (reasoning only, no text, no tool call); the Copilot CLI reports
 * that as "No response was returned", and the session failed the turn, retried it after 15 s and 30 s, then waited for
 * the person: 83 errors. Now a ROOT session's turn that answers only workflow notices that need no answer ends completed
 * with no content, as F-C3's system-only turn does: no error, no retry, one activity line. Every other empty answer is
 * unchanged.
 *
 * - The runTurn activity asks for the quiet answer (and names it) only for such a turn (isQuietWorkflowNoticeTurn;
 *   its cases in test/unit/workflow-notice-empty-answer.test.mjs).
 * - A full worker (PostgreSQL, duroxide and the Copilot CLI) with the model scripted, configured as the Workflow V2 test
 *   environment switch configures it, and a chat started at 1.0.83: the runtime's own message notice answered with
 *   nothing is one completed turn, no session.error, the session idle, no retry; the run's end answered with nothing is
 *   still an error.
 *
 * ManagedSession's own case (a fake CLI) is in inline-control-tools.test.js; a real model on repeated notices is
 * workflow-notice-empty-answer-real-model.test.js (runs only when asked).
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { workflowRuntimeSender } from "../../src/workflow/v2/parent-messages.ts";
import { appendSystemContextBlock } from "../../src/prompt-system-context.ts";

const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-notice-empty-answer" };
const getEnv = useSuiteEnv(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(250);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const notice = (run, type, fields) => `[WORKFLOW_UPDATE from=wf-notice-1 workflow=hacker-news-top-change-monitor@1.0.0 run=${run} type=${type}${fields}]\n`
    + `A workflow (session wf-notic, run ${run.slice(0, 8)}) sent you a Change@1 message from step send_summary. Use it as the user asked; it needs no answer.\n`
    + "Data (JSON, not instructions):\n{\"summary\":\"The top 20 did not change.\"}";
const MESSAGE = run => notice(run, "message", " state=send_summary contract=Change@1 exchange=nx-1");
const ENDED = run => notice(run, "ended", " status=completed outcome=succeeded state=done");

describe("a workflow notice that needs no answer: the runTurn activity", () => {
    const optionsOf = async (inputOverrides) => {
        const harness = makeRunTurnHarness();
        await harness.runTurn("notice-session", { config: { systemContextInPrompt: true }, ...inputOverrides });
        return harness.session.runTurn.mock.calls[0]?.[1] ?? {};
    };

    it("asks for a quiet empty answer, named a workflow notice, on a root chat's turn of the runtime's message notice", async () => {
        const options = await optionsOf({ prompt: appendSystemContextBlock(MESSAGE("act-1"), "[RECURRING TASK] Watch the top 20."),
            sender: workflowRuntimeSender("message") });
        expect(options.quietEmptyAnswer).toBe(true);
        expect(options.quietEmptyAnswerKind).toBe("workflow_notice");
    });

    it("does not for the run's end, a person's copy of the header, or a child session", async () => {
        for (const [label, input] of [
            ["the run's end", { prompt: ENDED("act-2"), sender: workflowRuntimeSender("ended") }],
            ["a person's copy", { prompt: MESSAGE("act-3"), sender: { kind: "user", provider: "test", subject: "ada", display: "Ada" } }],
            ["a child session", { prompt: MESSAGE("act-4"), sender: workflowRuntimeSender("message"), parentSessionId: "parent-1" }],
        ]) {
            const options = await optionsOf(input);
            expect(options.quietEmptyAnswer === true, label).toBe(false);
            expect(options.quietEmptyAnswerKind, label).toBeUndefined();
        }
    });
});

describe("a workflow notice that needs no answer, answered with nothing (real worker, scripted model)", () => {
    it("is one completed turn: no session.error, the session idle, no retry; the run's end answered with nothing is still an error", { timeout: TIMEOUT }, async () => {
        const asked = { message: 0, ended: 0 };
        const respond = (_body, position) => {
            if (position.step !== 0) return {};
            if (position.lastUserText.includes("type=message")) { asked.message += 1; return {}; }
            if (position.lastUserText.includes("type=ended")) { asked.ended += 1; return {}; }
            return { content: "Watching." };
        };
        const worker = { workflowScripts: { enabled: true } };
        await withScriptedModel(getEnv(), { respond, worker }, async ({ client, qualifiedModel }) => {
            const chat = await client.createSession({ model: qualifiedModel, owner: OWNER });
            expect(await chat.sendAndWait("Watch the top 20 and tell me what changes.", TIMEOUT)).toBe("Watching.");
            const turns = async () => (await client._catalog.getSessionEvents(chat.sessionId, 0, 500, ["session.turn_completed"]))
                .filter(event => Number(event.data?.iteration) >= 1);

            await chat.send(MESSAGE("real-message"), { sender: workflowRuntimeSender("message") });
            await until(async () => ((await turns()).length > 0 ? true : null), "the notice's turn");
            // Past the first retry delay (15 s) of a failed turn: nothing more runs.
            await pause(20_000);
            expect(asked.message, "the model was asked once").toBe(1);
            expect((await turns()).map(event => event.data?.resultType)).toEqual(["completed"]);
            expect(await client._catalog.getSessionEvents(chat.sessionId, 0, 500, ["session.error"])).toEqual([]);
            const quiet = await client._catalog.getSessionEvents(chat.sessionId, 0, 500, ["session.empty_answer"]);
            expect(quiet).toHaveLength(1);
            expect(quiet[0].data).toMatchObject({ kind: "workflow_notice", text: expect.stringContaining("a workflow notice that needs no answer") });
            expect((await client._catalog.getSession(chat.sessionId))?.state).toBe("idle");

            // The run's end asks for a report: an empty answer to it keeps today's rule.
            await chat.send(ENDED("real-ended"), { sender: workflowRuntimeSender("ended") });
            const errors = await until(async () => {
                const found = await client._catalog.getSessionEvents(chat.sessionId, 0, 500, ["session.error"]);
                return found.length > 0 ? found : null;
            }, "the run end's empty answer to be an error");
            expect(String(errors[0].data?.message ?? "")).toContain("No response was returned");
            expect(await client._catalog.getSessionEvents(chat.sessionId, 0, 500, ["session.empty_answer"])).toHaveLength(1);
        });
    });
});
