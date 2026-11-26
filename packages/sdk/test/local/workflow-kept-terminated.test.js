/**
 * Issue 412 (review R1-3): a finished Workflow of an idle owner, read through the production paths after every
 * maintenance pass. A real worker runs a Workflow whose agent state is answered by a scripted model (no model is
 * called). Then the Sweeper's scan, cleanup_session (default grace and 0) and prune_orchestrations (cutoffs 5 and 0) run,
 * and the Resource Manager's purge_old_events runs with every event aged past its cutoff.
 *
 * After them:
 * - the management client's session list, grouped by the session list's own tree builder (ui/core session-tree.js),
 *   puts the Workflow in its owner's Terminated row, and its agent session in the Workflow's Terminated row;
 * - the agent session's history, read as the agent node Log reads it (getSessionEvents), still holds the agent's own
 *   answer from the run, and the Workflow's own events still hold the agent visit;
 * - read_workflow returns the graph and the agent step with its output.
 *
 * Run: npx vitest run test/local/workflow-kept-terminated.test.js
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowFromTool } from "../../src/workflow/tools.ts";
import { createSweeperTools } from "../../src/sweeper-tools.ts";
import { createResourceManagerTools } from "../../src/resourcemgr-tools.ts";
import { buildSessionTree } from "../../../app/ui/core/src/session-tree.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 300_000;
const OWNER = { provider: "test", subject: "workflow-kept-terminated", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-kept-terminated" };
const MARKER = `item-7-unverified-${randomUUID().slice(0, 8)}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const CHECK_WORKFLOW = JSON.stringify({
    apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "check-items", version: "1.0.0" },
    initial: "verify",
    states: {
        verify: { type: "agent", invoke: { prompt: "Verify item 7." }, session: "new", timeoutSeconds: 600,
            transition: { next: { unverified: "blocked", failure: "blocked" } } },
        blocked: { type: "terminal", outcome: "blocked" },
    },
}, null, 2);

/** The agent step answers with its finding and completes the state; any other turn (the owner's) answers "ok". */
function respond(body, position) {
    const tools = (body.tools ?? []).map(tool => tool.function?.name);
    if (!tools.includes("complete_workflow_node")) return { content: "ok" };
    if (position.step === 0) {
        return { content: `Item 7 cannot be verified: ${MARKER}.`, tools: [{ name: "complete_workflow_node",
            args: { outcome: "unverified", output: { item: 7, finding: MARKER }, operation_id: "kept-terminated" } }] };
    }
    return { content: "STATE_COMPLETED" };
}

function findTool(tools, name) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}

describe("a finished Workflow of an idle owner after every maintenance pass (issue 412)", () => {
    it("is grouped under its owner's Terminated row, and its agent node Log and steps stay readable", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        await withScriptedModel(env, { respond, worker: { logLevel: "warning" } }, async ({ client, qualifiedModel }) => {
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            const db = new pg.Pool({ connectionString: env.store, max: 1 });
            const mgmt = await createManagementClient(env);
            const schema = `"${env.cmsSchema}"`;
            try {
                const store = catalog.workflowStore();
                const duroxide = client._getDuroxideClient();
                const session = await client.createSession({ model: qualifiedModel, owner: OWNER });
                const owner = session.sessionId;
                expect(await session.sendAndWait("hello", 120_000)).toBe("ok");
                expect((await catalog.getSession(owner))?.state).toBe("idle");

                const workflowId = randomUUID();
                const created = await createWorkflow({ catalog, store, duroxideClient: duroxide }, {
                    workflowSessionId: workflowId, parentSessionId: owner, yaml: CHECK_WORKFLOW, actor: ACTOR, operationId: "start",
                    publish: true, start: { inputs: {} }, notifyParent: false,
                });
                const runId = created.receipt.run.runId;
                let run = null;
                for (let waited = 0; waited < 180_000; waited += 250) {
                    run = await store.readRun(runId);
                    if (run && !["admitted", "running", "paused"].includes(run.status)) break;
                    await pause(250);
                }
                expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "blocked" });
                const agentIds = (await mgmt.listSessions()).filter(item => item.parentSessionId === workflowId).map(item => item.sessionId);
                expect(agentIds).toHaveLength(1);
                const [agent] = agentIds;
                const agentAnswer = event => event.eventType === "assistant.message" && JSON.stringify(event.data ?? null).includes(MARKER);
                expect((await mgmt.getSessionEvents(agent, 0, 500)).some(agentAnswer), "the agent's answer is in its history").toBe(true);
                // The visit's agent session ends after the run: the Sweeper would judge both terminal.
                let agentStatus = null;
                for (let waited = 0; waited < 120_000; waited += 250) {
                    agentStatus = (await duroxide.getStatus(`session-${agent}`))?.status;
                    if (["Completed", "Failed", "Terminated"].includes(agentStatus)) break;
                    await pause(250);
                }
                expect(agentStatus, "the agent session's orchestration ended").toBe("Completed");

                // Past every grace: the sessions an hour old, every event two days old (past purge_old_events' 24 h).
                await db.query(`UPDATE ${schema}.sessions SET updated_at = now() - interval '60 minutes' WHERE session_id = ANY($1::text[])`,
                    [[workflowId, agent]]);
                await db.query(`UPDATE ${schema}.session_events SET created_at = now() - interval '2 days' WHERE session_id = ANY($1::text[])`,
                    [[owner, workflowId, agent]]);
                const sweeper = name => findTool(createSweeperTools({ catalog, duroxideClient: duroxide, factStore: null }), name);
                const scanned = await sweeper("scan_completed_sessions").handler({ graceMinutes: 5 });
                for (const id of [workflowId, agent]) expect(scanned.sessions.map(item => item.sessionId)).not.toContain(id);
                for (const id of [workflowId, agent]) {
                    for (const grace of [undefined, 0]) {
                        const kept = await sweeper("cleanup_session").handler({ sessionId: id, ...(grace === undefined ? {} : { graceMinutes: grace }) });
                        expect(kept, JSON.stringify(kept)).toMatchObject({ ok: false, refused: true, status: "WorkflowKept" });
                    }
                }
                for (const minutes of [5, 0]) {
                    const pruned = await sweeper("prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: minutes });
                    expect(pruned.ok, JSON.stringify(pruned)).toBe(true);
                }
                const resourceTools = createResourceManagerTools({ catalog, duroxideClient: duroxide, blobStore: null,
                    cmsSchema: env.cmsSchema, duroxideSchema: env.duroxideSchema });
                const purged = await findTool(resourceTools, "purge_old_events").handler({});
                expect(purged.eventsDeleted, JSON.stringify(purged)).toBeGreaterThan(0);
                expect(await mgmt.getSessionEvents(owner, 0, 500), "the owner's old events were purged as before").toEqual([]);

                // The session list: the production listing, grouped by the list's own tree builder.
                const listed = await mgmt.listSessions();
                const tree = buildSessionTree(listed, new Set(), [], null, null, { openTerminatedIds: [owner, workflowId] });
                const terminatedOf = parent => tree.find(row => row.virtual?.kind === "terminated" && row.virtual.parentSessionId === parent);
                expect(terminatedOf(owner)?.virtual.memberIds, "the Workflow is in its owner's Terminated row").toContain(workflowId);
                expect(terminatedOf(workflowId)?.virtual.memberIds, "its agent session is in the Workflow's Terminated row").toContain(agent);
                expect(listed.find(item => item.sessionId === owner)?.status).toBe("idle");

                // The agent node Log: the agent session's history, and the Workflow's own events of the visit.
                const agentLog = await mgmt.getSessionEvents(agent, 0, 500);
                expect(agentLog.filter(agentAnswer), "the agent's answer from the run is still in its Log").toHaveLength(1);
                const workflowLog = await mgmt.getSessionEvents(workflowId, 0, 500);
                const verified = workflowLog.find(event => event.eventType === "workflow.state_completed" && event.data?.stateId === "verify");
                expect(verified?.data, `the Workflow's Log holds the agent step's end: ${JSON.stringify(workflowLog.map(event => event.eventType))}`)
                    .toMatchObject({ runId, outcome: "unverified" });
                expect(verified.data.outputPreview).toContain(MARKER);

                const view = JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId }, { callerSessionId: owner,
                    host: { catalog, store, duroxideClient: duroxide } }));
                expect(view, JSON.stringify(view)).toMatchObject({ ok: true, workflowId, graph: { initial: "verify" },
                    run: { runId, status: "completed" } });
                const verify = view.run.nodeExecutions.find(node => node.stateId === "verify");
                expect(verify, JSON.stringify(view.run.nodeExecutions)).toMatchObject({ outcome: "unverified" });
                expect(verify.outputPreview).toContain(MARKER);
            } finally {
                await mgmt.stop();
                await db.end();
                await catalog.close();
            }
        });
    });
});
