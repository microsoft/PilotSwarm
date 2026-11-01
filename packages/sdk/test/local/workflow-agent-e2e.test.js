/**
 * An agent session drives script workflows: the full stack with a scripted
 * model (real workers, PostgreSQL, duroxide and the Copilot CLI).
 *
 * The person asks for a workflow on a schedule. The agent calls
 * spawn_workflow and cron in the same turn; the workflow runs as the agent's
 * child and its result wakes the agent; the cron fires, the agent starts the
 * next run and stops the schedule.
 *
 * The person asks for polling. The agent calls spawn_workflow once with a
 * loop through a wait state, and no cron: the checks and waits run with no
 * model call, and only the result wakes the agent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-owner" };
const SETUP_PROMPT = "Every 15 seconds, run the counter workflow and tell me what it returns.";
// The orchestration delivers the result as a wake-up whose system context
// carries the notification text.
const isWorkflowResult = (text) => /Workflow session \S+ "counter" ended at state 'counted' with outcome succeeded/.test(text);

const WORKFLOW_YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: counter
  version: 1.0.0
inputs:
  run: { type: string, required: true }
initial: count
states:
  count:
    type: script
    runtime: node
    source: |
      await callTool("store_fact", { key: "counter/" + context.inputs.run, value: { run: context.inputs.run } });
      await setResult("success", { run: context.inputs.run });
    completion: { outcomes: [success] }
    transition: { next: { success: counted } }
  counted: { type: terminal, outcome: succeeded, output: "\${states.count.result}" }
`;

const getEnv = useSuiteEnv(import.meta.url);

function respond(body, position) {
    const prompt = position.lastUserText;
    if (isWorkflowResult(prompt)) {
        return { content: "Noted the workflow result." };
    }
    if (prompt.includes(SETUP_PROMPT)) {
        return position.step === 0
            ? { tools: [
                { name: "spawn_workflow", args: { yaml: WORKFLOW_YAML, inputs: { run: "first" } } },
                { name: "cron", args: { seconds: 15, reason: "start the next run of the counter workflow" } },
            ] }
            : { content: "Started the first run; the next one starts in 15 seconds." };
    }
    // The cron wake-up: start the next run, then stop the schedule.
    return position.step === 0
        ? { tools: [
            { name: "spawn_workflow", args: { yaml: WORKFLOW_YAML, inputs: { run: "scheduled" } } },
            { name: "cron", args: { action: "cancel" } },
        ] }
        : { content: "Started the scheduled run and stopped the schedule." };
}

async function waitFor(check, label, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`timed out waiting for ${label}`);
}

describe("agent-driven script workflows", () => {
    it("a prompt becomes spawn_workflow plus cron; each run is a child workflow session whose result wakes the agent", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, {
            respond,
            worker: { workflows: { stateTypes: ["script"] } },
        }, async ({ client, model, qualifiedModel }) => {
            const mgmt = await createManagementClient(env);
            try {
                const parent = await client.createSession({ model: qualifiedModel, owner: OWNER });
                await parent.sendAndWait(SETUP_PROMPT, TIMEOUT);

                const firstRequest = model.sessionRequests(SETUP_PROMPT)[0];
                const toolNames = firstRequest.body.tools.map((tool) => tool?.function?.name);
                expect(toolNames).toContain("spawn_workflow");

                const children = await waitFor(async () => {
                    const all = await mgmt.listSessions();
                    const workflows = all.filter((s) => s.parentSessionId === parent.sessionId && s.sessionKind === "workflow");
                    return workflows.length === 2 && workflows.every((s) => s.status === "completed") ? workflows : null;
                }, "two completed workflow children");

                for (const child of children) {
                    expect(child.title).toBe("Workflow: counter");
                    expect(child.owner).toMatchObject(OWNER);
                }
                const runs = [];
                for (const child of children) {
                    const events = await mgmt.getSessionEvents(child.sessionId);
                    const done = events.find((event) => event.eventType === "workflow.completed");
                    runs.push(JSON.parse(done.data.outputPreview).run);
                }
                expect(runs.sort()).toEqual(["first", "scheduled"]);

                // Each result reached the agent as a turn of its own.
                await waitFor(() => {
                    const resultTurns = model.sessionRequests(SETUP_PROMPT)
                        .filter((record) => record.position.step === 0 && isWorkflowResult(record.position.lastUserText));
                    const ids = new Set(children.map((child) => child.sessionId));
                    const seen = new Set(resultTurns.flatMap((record) => [...ids].filter((id) => record.position.lastUserText.includes(id))));
                    return seen.size === 2;
                }, "both workflow results delivered to the agent", 60_000);

                // The agent stopped its schedule on the cron wake-up.
                await waitFor(async () => (await mgmt.getSession(parent.sessionId))?.cronActive === false, "the schedule to stop", 60_000);
            } finally {
                await mgmt.stop?.();
            }
        });
    });

    it("a worker with workflows off does not show spawn_workflow to the model", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, {
            respond: () => ({ content: "ok" }),
            worker: { workflows: { stateTypes: [] } },
        }, async ({ client, model, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
            await session.sendAndWait("list your tools", TIMEOUT);
            const names = model.sessionRequests("list your tools")[0].body.tools.map((tool) => tool?.function?.name);
            expect(names).toContain("spawn_agent");
            expect(names).not.toContain("spawn_workflow");
            // Without workflows, cron is not steered toward them.
            const cron = model.sessionRequests("list your tools")[0].body.tools.find((tool) => tool?.function?.name === "cron");
            expect(cron?.function?.description ?? "").not.toMatch(/spawn_workflow/);
            expect(cron?.function?.description ?? "").toMatch(/^Declare a recurring durable schedule owned by the orchestration\./);
        });
    });
});

const POLL_PROMPT = "Every minute, check whether a build has failed; when one has, record it. Keep checking until then.";
const isPollResult = (text) => /Workflow session \S+ "poll-builds" ended at state 'finished' with outcome succeeded/.test(text);
const POLL_YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: poll-builds, version: 1.0.0 }
inputs:
  run: { type: string, required: true }
initial: check
states:
  check:
    type: script
    runtime: node
    source: |
      const key = "builds/" + context.inputs.run + "/checks";
      const prior = await callTool("read_facts", { key_pattern: key, scope: "session" });
      const n = (prior.facts?.[0]?.value?.n ?? 0) + 1;
      await callTool("store_fact", { key, value: { n } });
      await setResult(n >= 3 ? "found" : "idle", { n });
    completion: { outcomes: [found, idle] }
    transition: { next: { found: record, idle: sleep } }
  record:
    type: script
    runtime: node
    source: |
      await callTool("store_fact", { key: "builds/" + context.inputs.run + "/failed", value: { afterChecks: context.input.n } });
      await setResult("done", { afterChecks: context.input.n });
    completion: { outcomes: [done] }
    transition: { next: { done: finished } }
  sleep:
    type: wait
    seconds: 1
    transition: { next: check }
  finished: { type: terminal, outcome: succeeded, summary: A failed build was recorded., output: "\${states.record.result}" }
`;

describe("agent-driven polling workflows", () => {
    // The scripted workflow waits a second between checks; production's minimum is 60.
    let savedMinWait;
    beforeAll(() => {
        savedMinWait = process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS;
        process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS = "1";
    });
    afterAll(() => {
        if (savedMinWait === undefined) delete process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS;
        else process.env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS = savedMinWait;
    });

    it("a polling prompt becomes one spawn_workflow with a wait loop and no cron; the loop calls no model", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const run = `agent-poll-${Math.random().toString(36).slice(2)}`;
        const respondPoll = (_body, position) => {
            const prompt = position.lastUserText;
            if (isPollResult(prompt)) return { content: "A failed build was recorded." };
            return position.step === 0
                ? { tools: [{ name: "spawn_workflow", args: { yaml: POLL_YAML, inputs: { run } } }] }
                : { content: "I started a workflow that checks every minute and records the first failed build." };
        };
        await withScriptedModel(env, {
            respond: respondPoll,
            worker: { workflows: { stateTypes: ["script"] } },
        }, async ({ client, model, qualifiedModel }) => {
            const mgmt = await createManagementClient(env);
            try {
                const parent = await client.createSession({ model: qualifiedModel, owner: OWNER });
                await parent.sendAndWait(POLL_PROMPT, TIMEOUT);

                // The model was told to keep polling inside the workflow.
                const spec = model.sessionRequests(POLL_PROMPT)[0].body.tools
                    .find((tool) => tool?.function?.name === "spawn_workflow")?.function?.description ?? "";
                expect(spec).toMatch(/call spawn_workflow ONCE\. Do not use cron or cron_at for it/);
                expect(spec).toContain("type: wait");
                // And the timer tools say they are for wake-ups that need the agent's judgment.
                const tools = model.sessionRequests(POLL_PROMPT)[0].body.tools;
                for (const name of ["cron", "cron_at"]) {
                    const description = tools.find((tool) => tool?.function?.name === name)?.function?.description ?? "";
                    expect(description, name).toMatch(/^Wake THIS AGENT .* Use it only when each wake-up needs this agent's own judgment/);
                    expect(description, name).toMatch(/call spawn_workflow ONCE with a loop through a wait state/);
                }

                const child = await waitFor(async () => {
                    const all = await mgmt.listSessions();
                    const found = all.find((s) => s.parentSessionId === parent.sessionId && s.sessionKind === "workflow");
                    return found?.status === "completed" ? found : null;
                }, "the polling workflow to finish");
                const events = await mgmt.getSessionEvents(child.sessionId);
                expect(events.filter((e) => e.eventType === "workflow.state_waiting")).toHaveLength(2);
                const done = events.find((e) => e.eventType === "workflow.completed");
                expect(JSON.parse(done.data.outputPreview)).toEqual({ afterChecks: 3 });

                await waitFor(() => model.sessionRequests(POLL_PROMPT).some((r) => isPollResult(r.position.lastUserText)), "the result to wake the agent", 60_000);
                // Every model call was the setup turn or the result: the checks and waits called no model.
                const prompts = model.sessionRequests(POLL_PROMPT).map((r) => r.position.lastUserText);
                expect(prompts.filter((text) => !text.includes(POLL_PROMPT) && !isPollResult(text))).toEqual([]);
                expect((await mgmt.getSession(parent.sessionId))?.cronActive ?? false).toBe(false);
            } finally {
                await mgmt.stop?.();
            }
        });
    });
});

