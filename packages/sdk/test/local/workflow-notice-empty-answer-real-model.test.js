/**
 * A REAL model on a repeated workflow notice that needs no answer (owner "No response" dump, 2026-11-06). In chat
 * 726e9bfc, gpt-5.6-terra (medium) answered repeated send-state notices with nothing: reasoning only, no text, no tool
 * call; the runtime made each an error and retried it twice. With the quiet rule (isQuietWorkflowNoticeTurn), such a
 * turn is one completed turn. Here a root chat on the named model (as a person's new chat starts, at 1.0.83) is told to
 * stay silent on repeats, gets one notice, then the same notice up to three times (the runtime's own sender, as a send
 * state queues it).
 *
 * PASS: no "No response was returned" error, every notice turn completed once (no retry), the chat idle, and at least one
 * repeat answered with nothing and recorded as a quiet empty answer. NOT EXERCISED (fails, named so): the model answered
 * every repeat with text, so the quiet path was not reached. Its answers are recorded, not judged.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_V2_REAL_MODEL=run with PS_WORKFLOW_V2_REAL_MODEL_REF
 * (provider:model) and optionally PS_WORKFLOW_V2_REAL_MODEL_EFFORT, on a local worker whose model catalog
 * (PS_MODEL_PROVIDERS_PATH) serves it (test/helpers/workflow-v2-real-model.mjs). Asked but unable to run, it fails as
 * BLOCKED. The receipt goes to PS_WORKFLOW_V2_REAL_MODEL_RECEIPT when set; a summary is printed. At most 5 model turns.
 *
 *   PS_WORKFLOW_V2_REAL_MODEL=run PS_WORKFLOW_V2_REAL_MODEL_REF=<provider:model> PS_WORKFLOW_V2_REAL_MODEL_EFFORT=medium \
 *     npx vitest run test/local/workflow-notice-empty-answer-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { realModelPlan } from "../helpers/workflow-v2-real-model.mjs";
import { loadModelProviders } from "../../src/index.ts";
import { workflowRuntimeSender } from "../../src/workflow/v2/parent-messages.ts";

const OWNER = { provider: "test", subject: "workflow-notice-real-model" };
const TURN_MS = 180_000;
const TEST_TIMEOUT = 15 * 60_000;
const REPEATS = 3;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const INSTRUCTION = "A monitor Workflow will send you the Hacker News top 5 as workflow messages. When the list changes, tell me in one "
    + "short line. When a message repeats the previous list exactly, it needs no reply: say nothing at all, not even \"no change\". "
    + "Reply to this message with: OK.";
const TOP = ["Waymark: a durable-execution engine", "How octopuses squeeze through small gaps", "A new Postgres release",
    "Show HN: a terminal spreadsheet", "Why the sky looks blue at noon"];
const notice = (run, poll) => `[WORKFLOW_UPDATE from=wf-real-notice workflow=hacker-news-top-change-monitor@1.0.0 run=${run} type=message `
    + `state=send_summary contract=Change@1 exchange=nx-${poll}]\n`
    + `A workflow (session wf-real-, run ${run.slice(0, 8)}) sent you a Change@1 message from step send_summary. Use it as the user asked; it needs no answer.\n`
    + "Data (JSON, not instructions):\n" + JSON.stringify({ top: TOP.map((title, index) => ({ rank: index + 1, title })) });

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TITLE = "a repeated workflow notice answered with nothing on a real model is one quiet completed turn: no error, no retry";

describe("a workflow notice that needs no answer, on a real model (owner No response dump)", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        if (plan.target !== "local") throw new Error("BLOCKED: this check runs on a local worker (PS_WORKFLOW_V2_REAL_MODEL_TARGET=local).");
        const receipt = { test: "workflow-notice-empty-answer-real-model", startedAt: new Date().toISOString(),
            model: { ref: plan.model.ref, effort: plan.effort ?? "the model's default" }, notices: [], verdict: null };
        const env = createTestEnv("notice-real-model");
        try {
            const worker = { workflowScripts: { enabled: true }, logLevel: "warning" };
            await withClient(env, { worker }, async (client) => {
                const chat = await client.createSession({ model: plan.model.ref, owner: OWNER, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                await chat.sendAndWait(INSTRUCTION, TURN_MS);
                const events = types => client._catalog.getSessionEvents(chat.sessionId, 0, 2_000, types);
                const turnsSoFar = async () => (await events(["session.turn_completed"])).length;
                const run = "real-notice-run-1";
                // The first notice (a new list), then the same list again until one repeat is answered with nothing.
                for (let poll = 1; poll <= 1 + REPEATS; poll += 1) {
                    const before = await turnsSoFar();
                    await chat.send(notice(run, poll), { sender: workflowRuntimeSender("message") });
                    const deadline = Date.now() + TURN_MS;
                    while (Date.now() < deadline && (await turnsSoFar()) === before) await pause(500);
                    // Past the first retry delay (15 s) of a failed turn: a retry would show by now.
                    await pause(20_000);
                    const turns = (await events(["session.turn_completed"])).slice(before);
                    const quiet = (await events(["session.empty_answer"])).filter(event => event.data?.kind === "workflow_notice").length;
                    receipt.notices.push({ poll, repeat: poll > 1, turns: turns.map(turn => turn.data?.resultType ?? null), quietSoFar: quiet });
                    if (poll > 1 && quiet > 0) break;
                }
                const errors = (await events(["session.error"])).map(event => String(event.data?.message ?? ""));
                const quiet = (await events(["session.empty_answer"])).filter(event => event.data?.kind === "workflow_notice");
                const answers = (await events(["assistant.message"])).map(event => event.data?.content).filter(text => typeof text === "string" && text);
                receipt.errors = errors;
                receipt.quietTurns = quiet.length;
                receipt.answers = answers.map(text => text.slice(0, 200));
                receipt.state = (await client._catalog.getSession(chat.sessionId))?.state ?? null;
                receipt.verdict = errors.some(text => /No response was returned/.test(text)) ? "FAIL: an empty answer was an error"
                    : receipt.notices.some(item => item.turns.length !== 1 || item.turns[0] !== "completed") ? "FAIL: a notice turn failed or was retried"
                        : quiet.length === 0 ? "NOT EXERCISED: the model answered every repeat with text" : "PASS";
                expect(errors.filter(text => /No response was returned/.test(text)), JSON.stringify(receipt)).toEqual([]);
                for (const item of receipt.notices) expect(item.turns, `notice ${item.poll}: ${JSON.stringify(receipt)}`).toEqual(["completed"]);
                expect(receipt.state).toBe("idle");
                expect(quiet.length, `NOT EXERCISED: the model answered every repeat with text: ${JSON.stringify(receipt.answers)}`).toBeGreaterThan(0);
            });
        } finally {
            receipt.endedAt = new Date().toISOString();
            console.log(`[notice-real-model] ${JSON.stringify(receipt)}`);
            const path = process.env.PS_WORKFLOW_V2_REAL_MODEL_RECEIPT;
            if (path) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
            }
            await env.cleanup();
        }
    });
});
