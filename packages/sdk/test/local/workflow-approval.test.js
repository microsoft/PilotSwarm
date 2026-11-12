import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { parseApprovalCommand } from "../../src/workflow/approval.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "approval-owner", displayName: "Approval Owner" };
const ACTOR = { kind: "user", provider: OWNER.provider, subject: OWNER.subject };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: approval-storage, version: "1.0.0" }
initial: consent
states:
  consent:
    type: approval
    question: Approve this exact proposal?
    timeoutSeconds: 172800
    transition: { next: { approved: done, rejected: done, timed_out: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`;

async function harness({ owner = OWNER, controllerVersion = "1.1.0", forbidden = false, deadlineSeconds = null } = {}) {
    const env = getEnv();
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const sql = new pg.Pool({ connectionString: env.store, max: 3 });
    const schema = `"${env.cmsSchema.replace(/"/g, '""')}"`;
    const parent = randomUUID(), workflowSessionId = randomUUID(), runId = randomUUID();
    await catalog.createSession(parent, { owner });
    await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner,
        creationConfig: { workflow: { requestSha256: "approval" } } });
    const compiled = compileWorkflow(YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    await store.createDefinition({ workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: YAML, compiled,
        actor: { kind: "agent", sessionId: parent }, operationId: "create", requestSha256: "approval", publish: true,
        start: { runId, mode: "live", controllerInstanceId: `approval-${runId}`, inputsText: "{}", kvText: "{}",
            testAgentMode: null, controllerVersion } });
    if (deadlineSeconds !== null) await sql.query(`UPDATE ${schema}.workflow_runs SET deadline_at=clock_timestamp()+$2*interval '1 second' WHERE run_id=$1`,
        [runId, deadlineSeconds]);
    const approvalId = nodeExecutionIdFor(runId, "root", "consent", 1);
    const enter = () => store.enterNode({ runId, nodeExecutionId: approvalId, scopeId: "root", nodeId: "consent", ordinal: 1, nodeType: "approval",
        predecessorId: null, arrivalRoute: null, inputText: '{"proposal":1}', kvRevision: 1, waitSeconds: 172800, immediate: null,
        approval: { question: compiled.ir.nodes.consent.question, timeoutSeconds: 172800, forbidden } });
    const close = async () => { await sql.end(); await catalog.close(); };
    return { store, catalog, sql, schema, workflowSessionId, runId, approvalId, enter, close };
}
const answer = (h, contextSha256, overrides = {}) => parseApprovalCommand({ operation: "approval_respond", operation_id: "answer",
    run_id: h.runId, approval_id: h.approvalId, context_sha256: contextSha256, decision: "approved", ...overrides });
const proposal = async h => (await h.store.approvals.readMany([h.approvalId])).get(h.approvalId);

describe("owner-only approval transactions", () => {
    it("pins context, atomically accepts audit/result/receipt/event, replays after deadline and conflicts on reuse", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            const entered = await h.enter();
            expect(entered).toMatchObject({ admitted: true, node: { nodeType: "approval", state: "pending" } });
            const snapshot = await proposal(h);
            expect(snapshot).toMatchObject({ question: "Approve this exact proposal?", context: { proposal: 1 }, owner: OWNER, status: "pending" });
            expect(snapshot.contextSha256).toMatch(/^[a-f0-9]{64}$/);
            const command = answer(h, snapshot.contextSha256);
            const receipt = await h.store.approvals.respond(h.workflowSessionId, command, ACTOR);
            expect(receipt).toMatchObject({ decision: "approved", replayed: false, contextSha256: snapshot.contextSha256 });
            expect(await proposal(h)).toMatchObject({ status: "approved", decision: { decidedBy: OWNER } });
            expect(await h.store.readNodeExecution(h.approvalId)).toMatchObject({ state: "completed", outcome: "approved", winner: "approval_owner" });
            expect((await h.sql.query(`SELECT kind FROM ${h.schema}.workflow_operations WHERE workflow_session_id=$1 AND operation_id='answer'`,
                [h.workflowSessionId])).rows).toEqual([{ kind: "approval_respond" }]);
            expect((await h.sql.query(`SELECT event_type FROM ${h.schema}.session_events WHERE session_id=$1 AND event_type='workflow.state_completed'`,
                [h.workflowSessionId])).rows).toHaveLength(1);
            await h.sql.query(`UPDATE ${h.schema}.workflow_runs SET status='completed', finished_at=clock_timestamp() WHERE run_id=$1`, [h.runId]);
            expect(await h.store.approvals.respond(h.workflowSessionId, command, ACTOR)).toEqual({ ...receipt, replayed: true });
            await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256, { approval_id: "another-visit" }), ACTOR))
                .rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
            await expect(h.sql.query(`UPDATE ${h.schema}.workflow_approvals SET reason='rewritten' WHERE node_execution_id=$1`, [h.approvalId]))
                .rejects.toMatchObject({ code: "23514" });
        } finally { await h.close(); }
    });

    it("refuses stale context, nonowners and non-user actors without deciding", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            await h.enter();
            const snapshot = await proposal(h);
            await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, "0".repeat(64)), ACTOR)).rejects.toMatchObject({ code: "APPROVAL_CONTEXT_CHANGED" });
            for (const actor of [{ kind: "system", name: "admin" }, { kind: "agent", sessionId: "owner-agent" },
                { kind: "user", provider: "test", subject: "admin" }]) {
                await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
            }
            expect((await h.store.readNodeExecution(h.approvalId)).state).toBe("pending");
        } finally { await h.close(); }
    });

    it("deadline equality loses, and timeout/answer share the row lock and one clock", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            await h.enter();
            const snapshot = await proposal(h);
            const approvals = h.store.approvals;
            approvals.clock = async () => snapshot.deadlineAt;
            await expect(approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), ACTOR)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
            expect((await h.store.readNodeExecution(h.approvalId)).outcome).toBe("timed_out");
            expect((await proposal(h)).decision).toBeNull();
            expect(await approvals.expire(h.workflowSessionId, h.runId, h.approvalId)).toEqual({ remainingMs: null });
        } finally { await h.close(); }
    });

    it("accepts exactly one of two competing answers and rolls back every decision write if the event fails", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            await h.enter();
            const snapshot = await proposal(h);
            const faulty = h.store.approvals;
            faulty.context.project = async () => { throw new Error("injected projection failure"); };
            await expect(faulty.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), ACTOR)).rejects.toThrow("injected projection failure");
            expect((await proposal(h)).decision).toBeNull();
            expect((await h.store.readNodeExecution(h.approvalId)).state).toBe("pending");
            expect((await h.sql.query(`SELECT 1 FROM ${h.schema}.workflow_operations WHERE workflow_session_id=$1 AND operation_id='answer'`,
                [h.workflowSessionId])).rows).toHaveLength(0);
            const attempts = await Promise.allSettled([
                h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), ACTOR),
                h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256,
                    { operation_id: "reject", decision: "rejected", reason: "Not ready" }), ACTOR),
            ]);
            expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
            expect(attempts.find(item => item.status === "rejected").reason).toMatchObject({ code: "APPROVAL_CLOSED" });
            expect((await h.sql.query(`SELECT 1 FROM ${h.schema}.workflow_approvals WHERE run_id=$1 AND decision IS NOT NULL`, [h.runId])).rows).toHaveLength(1);
        } finally { await h.close(); }
    });

    it("requires the same person to be both the pinned owner and the current owner", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            await h.enter();
            const snapshot = await proposal(h);
            await h.catalog.createSession(randomUUID(), { owner: { provider: "test", subject: "replacement-owner" } });
            await h.sql.query(`UPDATE ${h.schema}.session_owners SET user_id=(SELECT user_id FROM ${h.schema}.users WHERE provider='test' AND subject='replacement-owner')
                WHERE session_id=$1`, [h.workflowSessionId]);
            await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), ACTOR)).rejects.toMatchObject({ code: "FORBIDDEN" });
            await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256),
                { kind: "user", provider: "test", subject: "replacement-owner" })).rejects.toMatchObject({ code: "FORBIDDEN" });
            expect((await proposal(h)).decision).toBeNull();
        } finally { await h.close(); }
    });

    it("uses the earlier run cutoff and refuses new answers after stop or deletion", { timeout: 120000 }, async () => {
        const h = await harness({ deadlineSeconds: 3600 });
        try {
            await h.enter();
            const node = await h.store.readNodeExecution(h.approvalId), run = await h.store.readRun(h.runId);
            expect(node.deadlineAt.toISOString()).toBe(run.deadlineAt.toISOString());
            const snapshot = await proposal(h);
            await h.sql.query(`UPDATE ${h.schema}.workflow_runs SET stop_requested_at=clock_timestamp(), stop_deadline_at=clock_timestamp()+interval '60 seconds',
                stop_request=$2 WHERE run_id=$1`, [h.runId, JSON.stringify({ operationId: "stop", reason: null, actor: ACTOR, graceSeconds: 60 })]);
            await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), ACTOR)).rejects.toMatchObject({ code: "APPROVAL_CLOSED" });
            await h.sql.query(`UPDATE ${h.schema}.sessions SET deleted_at=clock_timestamp() WHERE session_id=$1`, [h.workflowSessionId]);
            await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), ACTOR)).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
            expect(await proposal(h)).not.toBeNull();
        } finally { await h.close(); }
    });

    for (const options of [{ owner: null }, { forbidden: true }]) {
        it(`ownerless or agent-subtree admission fails visibly: ${JSON.stringify(options)}`, { timeout: 120000 }, async () => {
            const h = await harness(options);
            try {
                expect(await h.enter()).toMatchObject({ admitted: true, node: { state: "completed", outcome: "forbidden" } });
                expect(await proposal(h)).toBeUndefined();
            } finally { await h.close(); }
        });
    }
    it("does not admit an approval at 1.0.0", { timeout: 120000 }, async () => {
        const h = await harness({ controllerVersion: "1.0.0" });
        try { await expect(h.enter()).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" }); }
        finally { await h.close(); }
    });
});
