/**
 * A real model turns a polling request into a workflow.
 *
 * Opt-in: it needs a configured model provider and is not part of
 * `test:local:workflows`. Without one it skips.
 *
 * The person asks for a check every 10 minutes. The model should start
 * exactly one workflow whose loop goes through a wait state, and should not
 * set cron or cron_at, because each cron wake-up would cost a model turn. A
 * refused first attempt that the model corrects is allowed: what counts is
 * that one workflow runs.
 *
 * Run: npx vitest run test/local/workflow-live-model.test.js
 */
import { describe, it, expect } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, withClient } from "../helpers/local-workers.js";
import { compileWorkflow, workflowHasWaits } from "../../src/workflow/compiler.js";

function tryCompile(yaml) {
    try { return { workflow: compileWorkflow(yaml) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

const TIMEOUT = 300_000;
const getEnv = useSuiteEnv(import.meta.url);
const live = await preflightChecks().then(() => true, () => false);

const PROMPT = "Every 10 minutes, check whether the fact `ci/failed-build` exists. "
    + "If it does, store a fact `ci/handled` with the same value. Keep checking until I cancel it.";

function toolArgs(event) {
    const raw = event?.data?.arguments ?? event?.data?.args;
    if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return {}; }
    }
    return raw && typeof raw === "object" ? raw : {};
}

/** Whether some wait state can reach itself again: the loop goes through it. */
function waitIsInLoop(workflow) {
    const reachable = (from) => {
        const seen = new Set();
        const queue = [from];
        while (queue.length) {
            const id = queue.shift();
            const state = workflow.states[id];
            if (!state || state.type === "terminal") continue;
            for (const next of Object.values(state.next)) {
                if (!seen.has(next)) { seen.add(next); queue.push(next); }
            }
        }
        return seen;
    };
    return Object.values(workflow.states).some((state) => state.type === "wait" && reachable(state.id).has(state.id));
}

describe.skipIf(!live)("a real model writes polling as one workflow", () => {
    it("starts one workflow with a wait loop and sets no cron", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflows: { stateTypes: ["script"] } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const session = await client.createSession({});
                // Wait for the turn to end rather than for the session to go idle:
                // a session that set cron stays waiting, and that is the failure to report.
                await session.send(PROMPT);
                let turnError = null;
                const deadline = Date.now() + TIMEOUT - 60_000;
                while (true) {
                    const ended = await mgmt.getSessionEvents(session.sessionId, 0, 50, ["session.turn_completed"]);
                    if (ended.length) break;
                    if (Date.now() > deadline) { turnError = new Error("the turn did not end in time"); break; }
                    await new Promise((r) => setTimeout(r, 1_000));
                }
                if (turnError) {
                    // Say what the session did before failing, so a stall can be told apart from a wrong answer.
                    const events = await mgmt.getSessionEvents(session.sessionId, 0, 1_000);
                    const info = await mgmt.getSession(session.sessionId);
                    const summary = events.slice(-25).map((e) => `${e.eventType}${e.data?.toolName ? `:${e.data.toolName}` : ""}`
                        + (e.eventType === "assistant.message" ? ` "${String(e.data?.content ?? "").slice(0, 300)}"` : "")
                        + (/error|fail/i.test(e.eventType) ? ` ${JSON.stringify(e.data).slice(0, 300)}` : ""));
                    console.log(`[live] turn did not finish: ${turnError.message}; status ${info?.status}; last events:\n  ${summary.join("\n  ")}`);
                    throw turnError;
                }

                const starts = (await mgmt.getSessionEvents(session.sessionId, 0, 1_000, ["tool.execution_start"]))
                    .filter((event) => typeof event?.data?.toolName === "string");
                const names = starts.map((event) => event.data.toolName);
                expect(names.filter((name) => name === "cron" || name === "cron_at"), `tools called: ${names.join(", ")}`).toEqual([]);
                const spawns = starts.filter((event) => event.data.toolName === "spawn_workflow");
                const attempts = spawns.map((event) => tryCompile(String(toolArgs(event).yaml ?? "")));
                console.log(`[live] tools called: ${names.join(", ")}; spawn_workflow attempts: ${attempts.map((a) => a.error ? `refused (${a.error})` : "valid").join("; ")}`);
                const started = (await mgmt.listSessions()).filter((s) => s.parentSessionId === session.sessionId && s.sessionKind === "workflow");
                expect(started, `tools called: ${names.join(", ")}`).toHaveLength(1);
                const valid = attempts.filter((a) => a.workflow);
                expect(valid, "exactly one valid spawn_workflow call").toHaveLength(1);

                const workflow = valid[0].workflow;
                expect(workflowHasWaits(workflow)).toBe(true);
                expect(waitIsInLoop(workflow), "the wait state is part of the loop").toBe(true);
                const waits = Object.values(workflow.states).filter((state) => state.type === "wait");
                expect(waits.some((state) => state.seconds === 600)).toBe(true);
            } finally {
                // The workflow runs until cancelled: remove it.
                const children = (await mgmt.listSessions()).filter((s) => s.sessionKind === "workflow");
                for (const child of children) await mgmt.deleteSession(child.sessionId, "live test cleanup").catch(() => undefined);
                await mgmt.stop?.();
            }
        });
    });
});
