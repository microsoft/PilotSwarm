/**
 * The approval a controlling session answers for its owner, with reads that mask people (integration of the
 * session-answered approval and read parity): the notice, the completion event, the agent's and the person's reads and
 * the execution detail show the owner only as "a person" with a name, never a provider or subject; the receipt still
 * names the session (viaSessionId); the stored audit keeps the full identity the authority checks use.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { registerWorkflow } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store-primitives.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "mask-provider", subject: "mask-owner-subject", displayName: "Ada Approver" };
const PERSON = { by: "a person", name: OWNER.displayName };

const CONSENT = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: agent-consent-masked, version: "1.0.0" }
initial: consent
states:
  consent:
    type: approval
    question: Release this exact build?
    input: "\${inputs}"
    timeoutSeconds: 172800
    transition:
      next: { approved: release, rejected: hold, timed_out: hold, failure: hold }
  release: { type: terminal, outcome: succeeded }
  hold: { type: terminal, outcome: failed }
`;

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const leaks = text => [OWNER.provider, OWNER.subject, "\"provider\"", "\"subject\""].filter(word => text.includes(word));

describe("an approval answered by the controlling session, with masked reads", () => {
    it("shows the masked person in the notice, event, reads and detail, and keeps viaSessionId in the receipt", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
        const notified = [];
        registerWorkflow({
            registerActivity: (name, fn) => runtime.registerActivity(name, fn),
            registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
        }, {
            store, catalog,
            enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("This workflow calls no tools."); },
            authorizeParentNotification: async () => true,
            notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notified.push({ parentSessionId, text, clientMessageId }); },
            deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
            wakeBackstopMs: 500,
        });
        await runtime.start();
        const host = { catalog, store, duroxideClient: new Client(provider) };
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {} });
        await mgmt.start();
        const sql = new pg.Pool({ connectionString: env.store, max: 2 });
        const schema = `"${env.cmsSchema.replace(/"/g, '""')}"`;
        try {
            const parentId = randomUUID(), workflowId = randomUUID();
            await catalog.createSession(parentId, { owner: OWNER });
            const created = await createWorkflow(host, { workflowSessionId: workflowId, parentSessionId: parentId, yaml: CONSENT,
                actor: { kind: "system", name: "workflow-approval-agent-masked-test" }, operationId: "start", start: { inputs: { build: "1.2.3" } } });
            const { runId } = created.receipt.run;
            const approvalId = nodeExecutionIdFor(runId, "root", "consent", 1);
            const context = { callerSessionId: parentId, host };
            const opened = await until(async () => {
                const read = (await store.approvals.readMany([approvalId])).get(approvalId);
                return read?.status === "pending" ? read : null;
            }, "the approval to open");
            expect(opened.owner).toEqual(PERSON);

            const notice = await until(async () => notified.find(n => n.clientMessageId === `workflow-approval:${approvalId}`), "the approval notice");
            expect(notice.text).toContain("type=approval");
            expect(leaks(notice.text)).toEqual([]);

            const command = { workflow_id: workflowId, operation: "approval_respond", operation_id: "agent-approve", run_id: runId,
                approval_id: approvalId, context_sha256: opened.contextSha256, decision: "approved" };
            const receiptText = await updateWorkflowFromTool(command, context);
            const receipt = JSON.parse(receiptText);
            expect(receipt).toMatchObject({ ok: true, decision: "approved", viaSessionId: parentId, replayed: false });
            expect(receipt.decidedBy).toEqual(PERSON);
            expect(leaks(receiptText)).toEqual([]);
            expect(JSON.parse(await updateWorkflowFromTool(command, context))).toEqual({ ...receipt, replayed: true });
            await until(async () => (await store.readRun(runId))?.status === "completed", "the run to complete");

            const { rows: stored } = await sql.query(`SELECT data FROM ${schema}.session_events
                WHERE session_id=$1 AND event_type='workflow.state_completed' AND data->>'nodeExecutionId'=$2`, [workflowId, approvalId]);
            expect(stored).toHaveLength(1);
            expect(stored[0].data).toMatchObject({ approval: true, outcome: "approved", decidedBy: PERSON });
            expect(stored[0].data).not.toHaveProperty("viaSessionId");
            const events = (await catalog.getSessionEvents(workflowId)).filter(e => e.eventType === "workflow.state_completed"
                && e.data?.nodeExecutionId === approvalId);
            expect(events.map(e => e.data.decidedBy)).toEqual([PERSON]);

            const agentText = await readWorkflowFromTool({ workflow_id: workflowId, run_id: runId }, context);
            const agentRead = JSON.parse(agentText);
            const agentApproval = agentRead.run.nodeExecutions.find(e => e.approval?.approvalId === approvalId).approval;
            expect(agentApproval).toMatchObject({ owner: PERSON, status: "approved", decision: { decidedBy: PERSON } });
            expect(leaks(agentText)).toEqual([]);
            const detailText = await readWorkflowFromTool({ workflow_id: workflowId, run_id: runId, execution_id: approvalId }, context);
            expect(JSON.parse(detailText).execution.result.value.decidedBy).toEqual(PERSON);
            expect(leaks(detailText)).toEqual([]);

            const personRead = await mgmt.readWorkflow(workflowId);
            const personApproval = personRead.run.nodeExecutions.find(e => e.approval?.approvalId === approvalId).approval;
            expect(personApproval).toMatchObject({ owner: PERSON, decision: { decidedBy: PERSON } });

            // The authority checks keep reading the full identity, which the audit row retains.
            const { rows: audit } = await sql.query(`SELECT owner_provider, owner_subject, decided_by FROM ${schema}.workflow_approvals
                WHERE node_execution_id=$1`, [approvalId]);
            expect(audit[0]).toMatchObject({ owner_provider: OWNER.provider, owner_subject: OWNER.subject });
            expect(JSON.parse(typeof audit[0].decided_by === "string" ? audit[0].decided_by : JSON.stringify(audit[0].decided_by)))
                .toMatchObject({ provider: OWNER.provider, subject: OWNER.subject });
        } finally {
            await sql.end();
            await mgmt.stop();
            await runtime.shutdown(100);
            await catalog.close();
        }
    });
});
