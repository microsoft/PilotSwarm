/**
 * An agent session drives script workflows: the full stack with a scripted
 * model (real workers, PostgreSQL, duroxide and the Copilot CLI).
 *
 * The person asks for a workflow on a schedule. The agent calls
 * spawn_workflow and cron in the same turn; the workflow runs as the agent's
 * child and its result wakes the agent; the cron fires, the agent starts the
 * next run and stops the schedule.
 */
import { describe, it, expect } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";

const TIMEOUT = 240_000;
const OWNER = { provider: "test", subject: "workflow-owner" };
const SETUP_PROMPT = "Every 15 seconds, run the counter workflow and tell me what it returns.";
// The orchestration delivers the result as a wake-up whose system context
// carries the notification text.
const isWorkflowResult = (text) => /Workflow session \S+ "counter" completed after/.test(text);

const WORKFLOW_YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata:
  name: counter
spec:
  entry: count
  nodes:
    count:
      type: script
      runtime: node
      source: |
        await callTool("store_fact", { key: "counter/" + context.inputs.run, value: { run: context.inputs.run } });
        await setResult("success", { run: context.inputs.run });
      next:
        success: null
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
            worker: { scriptWorkflows: { enabled: true } },
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

    it("a worker with script workflows off does not show spawn_workflow to the model", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, {
            respond: () => ({ content: "ok" }),
            worker: { scriptWorkflows: { enabled: false } },
        }, async ({ client, model, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
            await session.sendAndWait("list your tools", TIMEOUT);
            const names = model.sessionRequests("list your tools")[0].body.tools.map((tool) => tool?.function?.name);
            expect(names).toContain("spawn_agent");
            expect(names).not.toContain("spawn_workflow");
        });
    });
});
