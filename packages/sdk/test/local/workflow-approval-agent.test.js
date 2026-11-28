/**
 * An approval answered by the session that controls the Workflow, on the real durable runtime (duroxide PostgreSQL
 * provider) and the real PostgreSQL store: the session gets a type=approval notice when the approval opens, answers it
 * for its owner with update_workflow approval_respond (the run takes the approved or rejected route), a replay of its
 * operation_id returns the same receipt, and the receipt names the session (viaSessionId). A person's answer through
 * the management client (with or without an originating session) is the same respond(): the first answer wins.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
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
const ACTOR = { kind: "system", name: "workflow-approval-agent-test" };
const OWNER = { provider: "test", subject: "approval-agent-owner" };

const CONSENT = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: agent-consent, version: "1.0.0" }
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

/** A worker-equivalent registration whose parent notices are authorized and recorded with their text. */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
    const notified = [];
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => true,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notified.push({ parentSessionId, text, clientMessageId }); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
    });
    await runtime.start();
    return {
        store, notified,
        host: { catalog, store, duroxideClient: client },
        async stop() { await runtime.shutdown(100); await catalog.close(); },
    };
}

/** A controlling session owned by OWNER, its Workflow started with `input`, and the approval once it is open. */
async function openApproval(h, input = { build: "1.2.3" }) {
    const parentId = randomUUID();
    await h.host.catalog.createSession(parentId, { owner: OWNER });
    const context = { callerSessionId: parentId, host: h.host };
    const workflowId = randomUUID();
    const created = await createWorkflow(h.host, { workflowSessionId: workflowId, parentSessionId: parentId, yaml: CONSENT,
        actor: ACTOR, operationId: "start", start: { inputs: input } });
    const { runId } = created.receipt.run;
    const approvalId = nodeExecutionIdFor(runId, "root", "consent", 1);
    const approval = await until(async () => {
        const read = (await h.store.approvals.readMany([approvalId])).get(approvalId);
        return read?.status === "pending" ? read : null;
    }, "the approval to open");
    return {
        parentId, workflowId, runId, approvalId, contextSha256: approval.contextSha256,
        update: async (args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        read: async () => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId }, context)),
    };
}

async function finished(h, runId) {
    return until(async () => {
        const run = await h.store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`);
}

const answer = (s, decision, operationId, reason) => ({ operation: "approval_respond", operation_id: operationId, run_id: s.runId,
    approval_id: s.approvalId, context_sha256: s.contextSha256, decision, ...(reason ? { reason } : {}) });

describe("workflow approval answered by the controlling session", () => {
    it("is noticed to the session, answered approved for its owner, replayed by operation_id, and routes approved", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // A large context: the notice carries a short preview, never the whole context.
            const s = await openApproval(h, { build: "1.2.3", notes: "x".repeat(20_000) });
            const notice = await until(async () => h.notified.find(n => n.clientMessageId === `workflow-approval:${s.approvalId}`), "the approval notice");
            expect(notice.parentSessionId).toBe(s.parentId);
            expect(notice.text).toContain("type=approval");
            expect(notice.text).toContain(s.approvalId);
            expect(notice.text).toContain("approval_respond");
            expect(notice.text).toContain(s.contextSha256);
            expect(notice.text).toContain("Release this exact build?");
            expect(notice.text.length).toBeLessThan(6_000);
            expect(notice.text).not.toContain(OWNER.subject);

            const before = await s.read();
            expect(before.approvals).toEqual([{ approvalId: s.approvalId, runId: s.runId, mayAnswer: true, reason: null }]);

            const receipt = await s.update(answer(s, "approved", "agent-approve"));
            expect(receipt).toMatchObject({ ok: true, operation: "approval_respond", approvalId: s.approvalId, runId: s.runId,
                decision: "approved", decidedBy: { by: "a person" }, viaSessionId: s.parentId, replayed: false });
            // A session sees the owner as a person, as pause and resume show it: never the provider or subject.
            expect(JSON.stringify(receipt)).not.toContain(OWNER.subject);
            expect(receipt.decidedBy).not.toHaveProperty("provider");
            const replay = await s.update(answer(s, "approved", "agent-approve"));
            expect(replay).toEqual({ ...receipt, replayed: true });

            const run = await finished(h, s.runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "release", terminalOutcome: "succeeded" });
            const after = await s.read();
            expect(after.approvals).toEqual([{ approvalId: s.approvalId, runId: s.runId, mayAnswer: false,
                reason: "This approval no longer accepts a new answer." }]);
        } finally {
            await h.stop();
        }
    });

    it("answered rejected with a reason routes rejected", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const s = await openApproval(h);
            const receipt = await s.update(answer(s, "rejected", "agent-reject", "The build has not passed its tests."));
            expect(receipt).toMatchObject({ ok: true, decision: "rejected", reason: "The build has not passed its tests.", viaSessionId: s.parentId });
            const run = await finished(h, s.runId);
            expect(run).toMatchObject({ terminalNodeId: "hold", terminalOutcome: "failed" });
        } finally {
            await h.stop();
        }
    });

    it("a person's answer through the management client, with an originating session, is taken; the session's later answer is closed", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {} });
        await mgmt.start();
        try {
            const s = await openApproval(h);
            const view = await mgmt.readWorkflow(s.workflowId);
            expect(view.personCommands.approvals).toEqual([{ approvalId: s.approvalId, runId: s.runId, mayAnswer: true, reason: null }]);

            const person = await mgmt.updateWorkflow(s.workflowId, answer(s, "approved", "person-approve"),
                { principal: OWNER, originatingSessionId: s.parentId });
            expect(person).toMatchObject({ decision: "approved", viaSessionId: s.parentId, replayed: false });

            const late = await s.update(answer(s, "rejected", "agent-late", "Too late."));
            expect(late).toMatchObject({ ok: false, error: { code: "APPROVAL_CLOSED" } });
            const run = await finished(h, s.runId);
            expect(run).toMatchObject({ terminalNodeId: "release", terminalOutcome: "succeeded" });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
});
