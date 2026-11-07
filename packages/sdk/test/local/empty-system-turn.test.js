/**
 * F-C3 (the deployment at 65932bfc): a root session's system-only turn (a buffered child digest, a wake) that the model
 * answers with nothing. The Copilot CLI reports such an answer as the error "No response was returned"; the session
 * then failed the turn, retried it after 15 s and 30 s, and went to error. Now such a turn of a ROOT session ends
 * completed with no content: no error, no retry, no chat warning. A person's prompt, a child session and every other
 * error are unchanged.
 *
 * - isQuietSystemOnlyTurn: which turns qualify (the runTurn activity's TurnOptions.quietEmptyAnswer).
 * - The runTurn activity hands the flag to the model session only for such a turn.
 * - A full worker (PostgreSQL, duroxide and the Copilot CLI) with the model scripted: a root chat spawns a child; the
 *   child's report reaches the root as a buffered digest, a system-only turn; the model answers it with nothing. One
 *   turn, completed; no session.error; the session idle; no retry.
 *
 * ManagedSession's own cases (a fake CLI) are in inline-control-tools.test.js.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { isQuietSystemOnlyTurn, SYSTEM_ONLY_TURN_PROMPT } from "../../src/session-proxy.ts";
import { INTERNAL_SYSTEM_TURN_PROMPT as PROMPT_1_0_83 } from "../../src/orchestration_1_0_83/state.ts";
import { INTERNAL_SYSTEM_TURN_PROMPT as PROMPT_LATEST } from "../../src/orchestration/state.ts";
import { appendSystemContextBlock } from "../../src/prompt-system-context.ts";

const TIMEOUT = 240_000;
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

const DIGEST = "Buffered child updates arrived during the last 30 seconds:\n  - Agent session-c\n    Update: completed";
/** A root session's digest turn as the activity gets it (1.0.71+: the system context rides the prompt as a block). */
const digestTurn = (overrides = {}) => ({
    prompt: appendSystemContextBlock(SYSTEM_ONLY_TURN_PROMPT, DIGEST), bootstrap: true, systemContextInPrompt: true, ...overrides,
});

describe("F-C3: which turns end quietly when the model answers nothing", () => {
    it("the activity's prompt is the one every session orchestration version gives a system-only turn", () => {
        expect(SYSTEM_ONLY_TURN_PROMPT).toBe(PROMPT_1_0_83);
        expect(SYSTEM_ONLY_TURN_PROMPT).toBe(PROMPT_LATEST);
    });

    it("a root session's system-only turn qualifies, with or without its system context block", () => {
        expect(isQuietSystemOnlyTurn(digestTurn())).toBe(true);
        expect(isQuietSystemOnlyTurn({ prompt: SYSTEM_ONLY_TURN_PROMPT, bootstrap: true })).toBe(true);
    });

    it("a person's prompt, a child session and a turn with anybody's words folded in do not", () => {
        expect(isQuietSystemOnlyTurn(digestTurn({ prompt: "What happened to the child?", bootstrap: false })), "a person's prompt").toBe(false);
        expect(isQuietSystemOnlyTurn(digestTurn({ bootstrap: false })), "not a bootstrap turn").toBe(false);
        expect(isQuietSystemOnlyTurn(digestTurn({ parentSessionId: "parent-1" })), "a child session").toBe(false);
        expect(isQuietSystemOnlyTurn(digestTurn({ stashedPrompts: ["held words"] })), "held prompts").toBe(false);
        expect(isQuietSystemOnlyTurn(digestTurn({ foldedText: true })), "carried or open steers").toBe(false);
        expect(isQuietSystemOnlyTurn(digestTurn({ intake: true })), "workflow intake items").toBe(false);
        expect(isQuietSystemOnlyTurn(digestTurn({ attachments: 1 })), "attachments").toBe(false);
        expect(isQuietSystemOnlyTurn(digestTurn({ requiredTool: "report_cycle" })), "a required tool").toBe(false);
    });
});

describe("F-C3: the runTurn activity", () => {
    const quietOf = async (inputOverrides) => {
        const harness = makeRunTurnHarness();
        await harness.runTurn("fc3-session", { config: { systemContextInPrompt: true }, ...inputOverrides });
        return harness.session.runTurn.mock.calls[0]?.[1]?.quietEmptyAnswer === true;
    };

    it("asks for a quiet empty answer on a root session's digest turn", async () => {
        expect(await quietOf({ prompt: appendSystemContextBlock(SYSTEM_ONLY_TURN_PROMPT, DIGEST), bootstrap: true })).toBe(true);
    });

    it("does not on a person's prompt or in a child session", async () => {
        expect(await quietOf({ prompt: "Is the child done?" })).toBe(false);
        expect(await quietOf({ prompt: appendSystemContextBlock(SYSTEM_ONLY_TURN_PROMPT, DIGEST), bootstrap: true, parentSessionId: "parent-1" }))
            .toBe(false);
    });
});

describe("F-C3: a root session's buffered child digest answered with nothing (real worker, scripted model)", () => {
    it("is one completed turn: no session.error, the session idle, no retry", { timeout: TIMEOUT }, async () => {
        const CHILD = "FC3-CHILD";
        const RESULT = "FC3-CHILD-RESULT";
        const systemTurns = [];
        const respond = (_body, position) => {
            if (position.firstUserText.includes(CHILD)) return { content: RESULT };
            // The root's system-only turns (the child's report, buffered): answered with nothing, as gpt-5.6-terra did.
            if (position.lastUserText.includes(SYSTEM_ONLY_TURN_PROMPT)) {
                if (position.step === 0) systemTurns.push(position.lastUserText);
                return {};
            }
            if (position.step === 0) return { tools: [{ name: "spawn_agent", args: { task: `${CHILD}: answer ${RESULT}` } }] };
            return { content: "Spawned." };
        };
        await withScriptedModel(getEnv(), { respond }, async ({ client, qualifiedModel }) => {
            const root = await client.createSession({ model: qualifiedModel });
            expect(await root.sendAndWait("FC3-ROOT: start one child", TIMEOUT)).toBe("Spawned.");
            const laterTurns = async () => (await client._catalog.getSessionEvents(root.sessionId, 0, 500, ["session.turn_completed"]))
                .filter(event => Number(event.data?.iteration) >= 1);
            await until(async () => ((await laterTurns()).length > 0 ? true : null), "the root's digest turn");
            // Past the first retry delay (15 s) of a failed turn: nothing more runs.
            await pause(20_000);

            expect(systemTurns, "the model was asked once").toHaveLength(1);
            expect(systemTurns[0]).toContain("Buffered child updates");
            expect(systemTurns[0]).toContain(RESULT);
            expect((await laterTurns()).map(event => event.data?.resultType)).toEqual(["completed"]);
            const errors = await client._catalog.getSessionEvents(root.sessionId, 0, 500, ["session.error"]);
            expect(errors, JSON.stringify(errors)).toEqual([]);
            const quiet = await client._catalog.getSessionEvents(root.sessionId, 0, 500, ["session.empty_answer"]);
            expect(quiet, "the CLI's empty-answer error was quieted").toHaveLength(1);
            expect((await client._catalog.getSession(root.sessionId))?.state).toBe("idle");
        });
    });
});
