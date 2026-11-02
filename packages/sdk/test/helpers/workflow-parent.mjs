/**
 * Workflow tests need a live agent parent: a workflow's scripts call the
 * tools of the agent that started it, captured from that agent's live
 * Copilot CLI session. This harness runs a real worker, client and CLI with
 * the scripted model (no tokens), and gives a test two ways to start a
 * workflow under a live parent:
 *
 *  - startWorkflow: the parent's tools are captured on its worker and passed
 *    to client.createWorkflowSession, exactly what spawn_workflow does in
 *    the parent's turn, without a model turn per workflow;
 *  - spawnThroughAgent: the parent's model calls spawn_workflow.
 *
 * The scripted model counts every request, so a test can show that running
 * a workflow sent none.
 */
import { randomUUID } from "node:crypto";
import { withScriptedModel } from "./scripted-workers.js";
import { workflowChildSessionId } from "../../src/workflow/spawn.js";

export const PARENT_OWNER = { provider: "test", subject: "workflow-owner" };
const SPAWN_OPEN = "<<SPAWN_WORKFLOW>>";
const SPAWN_CLOSE = "<</SPAWN_WORKFLOW>>";

function spawnArgs(text) {
    const start = text.indexOf(SPAWN_OPEN);
    const end = text.indexOf(SPAWN_CLOSE);
    if (start < 0 || end < start) return null;
    return JSON.parse(text.slice(start + SPAWN_OPEN.length, end));
}

/** Answers a spawn prompt with one spawn_workflow call, then ends the turn. Other prompts: `fallback`, or "ok". */
export function workflowParentResponder(fallback) {
    return (body, position) => {
        const args = spawnArgs(position.lastUserText);
        if (args) return position.step === 0 ? { tools: [{ name: "spawn_workflow", args }] } : { content: "spawned" };
        return fallback ? fallback(body, position) : { content: "ok" };
    };
}

/**
 * @param {object} env
 * @param {object} opts  { worker, tools, respond }
 * @param {Function} fn  async (ctx) => void, ctx = { client, worker, model, liveParent, toolBinding, startWorkflow, spawnThroughAgent, modelRequests }
 */
export async function withWorkflowParent(env, opts, fn) {
    await withScriptedModel(env, {
        respond: workflowParentResponder(opts.respond),
        worker: opts.worker,
        tools: opts.tools,
    }, async ({ client, worker, model, qualifiedModel }) => {
        const parents = new Map();
        /** A new agent session that has taken one turn, so its CLI session is live on the worker. */
        const liveParent = async ({ owner = PARENT_OWNER, toolNames } = {}) => {
            const session = await client.createSession({ model: qualifiedModel, owner, ...(toolNames ? { toolNames } : {}) });
            await session.sendAndWait("Get ready to start workflows.", 120_000);
            parents.set(session.sessionId, session);
            return session.sessionId;
        };
        /** What spawn_workflow captures from the parent, on the parent's worker. */
        const toolBinding = (parentSessionId) => worker.sessionManager.captureWorkflowToolBinding(parentSessionId);
        let defaultParent = null;
        const startWorkflow = async (config) => {
            const parentSessionId = config.parentSessionId ?? (defaultParent ??= await liveParent());
            const binding = await toolBinding(parentSessionId);
            return client.createWorkflowSession({ notifyParent: false, ...config, parentSessionId }, { toolBinding: binding });
        };
        const spawnThroughAgent = async ({ parentSessionId, yaml, inputs = {}, key = randomUUID(), notify = false }) => {
            const parentId = parentSessionId ?? (defaultParent ??= await liveParent());
            const session = parents.get(parentId);
            const args = { yaml, inputs, key, notify_on_completion: notify };
            const prompt = `Start this workflow. ${SPAWN_OPEN}${JSON.stringify(args)}${SPAWN_CLOSE}`;
            await session.sendAndWait(prompt, 120_000);
            const record = model.sessionRequests().filter((r) => r.position.lastUserText.includes(prompt) && r.position.step === 1).at(-1);
            return { sessionId: workflowChildSessionId(parentId, key, undefined), toolResult: record?.position.toolResults.join("\n") ?? "" };
        };
        /** The model request count once it has stopped changing (titles and summaries settle after a turn). */
        const settledModelRequests = async (quietMs = 2_000) => {
            let count = model.requests.length;
            let since = Date.now();
            while (Date.now() - since < quietMs) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                if (model.requests.length !== count) { count = model.requests.length; since = Date.now(); }
            }
            return count;
        };
        await fn({
            client, worker, model, qualifiedModel, liveParent, toolBinding, startWorkflow, spawnThroughAgent,
            settledModelRequests,
            /** The client handle of a parent made by liveParent. */
            parentSession: (parentSessionId) => parents.get(parentSessionId),
        });
    });
}
