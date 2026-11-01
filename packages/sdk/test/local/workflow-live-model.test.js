/**
 * A real model turns a polling request into a workflow.
 *
 * Opt-in: it needs a configured model provider and is not part of
 * `test:local:workflows`. Without one it skips.
 *
 * The person asks for a check every 10 minutes. The model should call
 * spawn_workflow once with a loop through a wait state, and should not set
 * cron or cron_at, because each cron wake-up would cost a model turn.
 *
 * Run: npx vitest run test/local/workflow-live-model.test.js
 */
import { describe, it, expect } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, withClient } from "../helpers/local-workers.js";
import { compileWorkflow, workflowHasWaits } from "../../src/workflow/compiler.js";

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
    it("calls spawn_workflow once with a wait loop and sets no cron", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withClient(env, { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const mgmt = await createManagementClient(env);
            try {
                const session = await client.createSession({});
                await session.sendAndWait(PROMPT, TIMEOUT);

                const starts = (await mgmt.getSessionEvents(session.sessionId, 0, 1_000, ["tool.execution_start"]))
                    .filter((event) => typeof event?.data?.toolName === "string");
                const names = starts.map((event) => event.data.toolName);
                expect(names.filter((name) => name === "cron" || name === "cron_at"), `tools called: ${names.join(", ")}`).toEqual([]);
                const spawns = starts.filter((event) => event.data.toolName === "spawn_workflow");
                expect(spawns, `tools called: ${names.join(", ")}`).toHaveLength(1);

                const workflow = compileWorkflow(String(toolArgs(spawns[0]).yaml ?? ""));
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
