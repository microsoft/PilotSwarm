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
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
    it("inherits native file and shell tools while refusing direct filesystem and orchestration access", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const folder = await mkdtemp(path.join(os.tmpdir(), "workflow-parent-files-"));
        const file = path.join(folder, "input.txt");
        await writeFile(file, "parent-file-marker");
        const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: native-parity, version: "1" }
initial: read
states:
  read:
    type: script
    runtime: node
    source: |
      const viewed = await callTool("view", {path: context.inputs.path});
      const shell = await callTool("bash", {command: "printf child-shell-marker", description: "Print fixture marker"});
      let directFsDenied = false, waitDenied = false;
      try { require("node:fs").readFileSync(context.inputs.path); }
      catch (error) { directFsDenied = error.code === "ERR_ACCESS_DENIED"; }
      try { await callTool("wait", {seconds: 1}); }
      catch (error) { waitDenied = /not permitted/.test(error.message); }
      await callTool("store_fact", {key: "parity/result", value: {child: context.sessionId}});
      await setResult("done", {file: JSON.stringify(viewed).includes("parent-file-marker"), shell: JSON.stringify(shell).includes("child-shell-marker"), directFsDenied, waitDenied});
    completion: {outcomes: [done]}
    transition: {next: {done: end}}
  end: {type: terminal, outcome: succeeded, output: "\${states.read.result}"}
`;
        try {
            await withScriptedModel(env, {
                respond: (_body, position) => position.lastUserText.includes("run native parity") && position.step === 0
                    ? { tools: [{ name: "spawn_workflow", args: { yaml, inputs: { path: file }, notify_on_completion: false } }] }
                    : { content: "parent remains conversational" },
                worker: { workflowScripts: { enabled: true } },
            }, async ({ client, qualifiedModel }) => {
                const mgmt = await createManagementClient(env);
                try {
                    const parent = await client.createSession({ model: qualifiedModel, owner: OWNER, workingDirectory: folder });
                    await parent.sendAndWait("run native parity", TIMEOUT);
                    const child = await waitFor(async () => {
                        const runs = (await mgmt.listSessions()).filter(s => s.parentSessionId === parent.sessionId && s.sessionKind === "workflow");
                        return runs.find(s => ["completed", "failed"].includes(s.status));
                    }, "native workflow completion");
                    const events = await mgmt.getSessionEvents(child.sessionId);
                    const end = events.find(e => e.eventType === "workflow.completed" || e.eventType === "workflow.failed");
                    expect(child.status, JSON.stringify(end?.data)).toBe("completed");
                    expect(JSON.parse(end.data.outputPreview)).toEqual({ file: true, shell: true, directFsDenied: true, waitDenied: true });
                    await parent.sendAndWait("are you still available?", TIMEOUT);
                } finally { await mgmt.stop?.(); }
            });
        } finally { await rm(folder, { recursive: true, force: true }); }
    });

    it("a prompt becomes spawn_workflow plus cron; each run is a child workflow session whose result wakes the agent", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, {
            respond,
            worker: { workflowScripts: { enabled: true } },
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
            worker: { workflowScripts: { enabled: false } },
        }, async ({ client, model, qualifiedModel }) => {
            const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
            await session.sendAndWait("list your tools", TIMEOUT);
            const names = model.sessionRequests("list your tools")[0].body.tools.map((tool) => tool?.function?.name);
            expect(names).toContain("spawn_agent");
            expect(names).not.toContain("spawn_workflow");
        });
    });
});
