import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { parseApprovalCommand } from "../../src/workflow/approval.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { readWorkflowFromTool, readWorkflowModel, readWorkflowView } from "../../src/workflow/tools.ts";
import * as controllerFeatures from "../../src/workflow/controller-features.ts";
import { workflowTimeTitle } from "../../../app/ui/core/src/workflow-words.js";

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

async function harness({ owner = OWNER, controllerVersion = "1.1.0", forbidden = false, deadlineSeconds = null,
    mode = "live", timeoutSeconds = 172800, timezone = null } = {}) {
    const env = getEnv();
    const connection = new URL(env.store);
    if (timezone !== null) connection.searchParams.set("options", `-c TimeZone=${timezone}`);
    const catalog = await PgSessionCatalog.create(connection.toString(), env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const sql = new pg.Pool({ connectionString: connection.toString(), max: 3 });
    const schema = `"${env.cmsSchema.replace(/"/g, '""')}"`;
    const parent = randomUUID(), workflowSessionId = randomUUID(), runId = randomUUID();
    await catalog.createSession(parent, { owner });
    await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner,
        creationConfig: { workflow: { requestSha256: "approval" } } });
    const yaml = YAML.replace("timeoutSeconds: 172800", `timeoutSeconds: ${timeoutSeconds}`);
    const compiled = compileWorkflow(yaml);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const start = { runId, mode, controllerInstanceId: `approval-${runId}`, inputsText: "{}", kvText: "{}",
        testAgentMode: mode === "test" ? "mocked" : null, controllerVersion, ...(mode === "test" ? { fixturesText: "[]" } : {}) };
    await store.createDefinition({ workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled,
        actor: { kind: "agent", sessionId: parent }, operationId: "create", requestSha256: "approval", publish: mode === "live",
        start: mode === "live" ? start : null });
    if (mode === "test") {
        const revision = await store.readRevision(workflowSessionId, 1);
        await store.startTest({ workflowSessionId, expectedRevision: 1, definitionHash: revision.yamlSha256,
            operationId: "test", requestSha256: "test", start });
    }
    if (deadlineSeconds !== null) await sql.query(`UPDATE ${schema}.workflow_runs SET deadline_at=clock_timestamp()+$2*interval '1 second' WHERE run_id=$1`,
        [runId, deadlineSeconds]);
    const approvalId = nodeExecutionIdFor(runId, "root", "consent", 1);
    const enter = () => store.enterNode({ runId, nodeExecutionId: approvalId, scopeId: "root", nodeId: "consent", ordinal: 1, nodeType: "approval",
        predecessorId: null, arrivalRoute: null, inputText: '{"proposal":1}', kvRevision: 1, waitSeconds: timeoutSeconds, immediate: null,
        ...(mode === "live" ? { approval: { question: compiled.ir.nodes.consent.question, timeoutSeconds, forbidden } }
            : { intercept: { operation: "approval", argumentsText: '{"question":"Approve?","context":{"proposal":1}}', responseSchema: null } }) });
    const close = async () => { await sql.end(); await catalog.close(); };
    return { store, catalog, sql, schema, parent, workflowSessionId, runId, approvalId, enter, close };
}
const answer = (h, contextSha256, overrides = {}) => parseApprovalCommand({ operation: "approval_respond", operation_id: "answer",
    run_id: h.runId, approval_id: h.approvalId, context_sha256: contextSha256, decision: "approved", ...overrides });
const proposal = async h => (await h.store.approvals.readMany([h.approvalId])).get(h.approvalId);

describe("owner-only approval transactions", () => {
    it("masks the pinned owner on reads while retaining their identity in audit", async () => {
        const h = await harness();
        try {
            await h.enter();
            expect((await proposal(h)).owner).toEqual({ by: "a person", name: OWNER.displayName });
            const { rows } = await h.sql.query(`SELECT owner_provider, owner_subject FROM ${h.schema}.workflow_approvals WHERE node_execution_id=$1`,
                [h.approvalId]);
            expect(rows[0]).toEqual({ owner_provider: OWNER.provider, owner_subject: OWNER.subject });
            for (const [actor, matches] of [[ACTOR, true], [{ ...ACTOR, subject: "not-owner" }, false]]) {
                const view = await readWorkflowModel({ store: h.store }, h.workflowSessionId, {}, "api", { actor });
                expect(view.run.nodeExecutions[0].approval.viewerIsPinnedOwner).toBe(matches);
            }
        } finally { await h.close(); }
    });

    it("masks the answering person in the proposal, execution output and completion event", async () => {
        const h = await harness();
        try {
            await h.enter();
            const command = answer(h, (await proposal(h)).contextSha256);
            const receipt = await h.store.approvals.respond(h.workflowSessionId, command, ACTOR);
            const actor = { by: "a person", name: OWNER.displayName };
            expect(receipt.decidedBy).toEqual(actor);
            expect((await h.store.readNodeExecution(h.approvalId)).output.decidedBy).toEqual(actor);
            const audit = await h.sql.query(`SELECT decided_by FROM ${h.schema}.workflow_approvals WHERE node_execution_id=$1`, [h.approvalId]);
            expect(JSON.parse(audit.rows[0].decided_by)).toEqual(OWNER);
            expect((await h.store.readReusedApprovalsForRerun(h.runId, [h.approvalId]))[0].decidedBy)
                .toEqual({ provider: OWNER.provider, subject: OWNER.subject });
            await h.sql.query(`UPDATE ${h.schema}.workflow_operations SET receipt=$3 WHERE workflow_session_id=$1 AND operation_id=$2`,
                [h.workflowSessionId, command.operationId, JSON.stringify({ ...receipt, decidedBy: OWNER })]);
            expect(await h.store.approvals.respond(h.workflowSessionId, command, ACTOR)).toEqual({ ...receipt, replayed: true });
            const detail = await readWorkflowView(h.store, h.workflowSessionId, { executionId: h.approvalId });
            const { rows } = await h.sql.query(`SELECT data FROM ${h.schema}.session_events
                WHERE session_id=$1 AND event_type='workflow.state_completed'`, [h.workflowSessionId]);
            expect((await proposal(h)).decision.decidedBy).toEqual(actor);
            expect(detail.execution.result.value.decidedBy).toEqual(actor);
            expect(rows[0].data.decidedBy).toEqual(actor);
        } finally { await h.close(); }
    });

    it("hides legacy identity carried into the next visit, the run result and dropped output previews", async () => {
        const h = await harness();
        try {
            const legacy = { decidedBy: OWNER, received: { from: "person:user:dev:private", payload: [1, null] } };
            const safe = { decidedBy: { by: "a person", name: OWNER.displayName }, received: { from: { by: "a person" }, payload: [1, null] } };
            const id = nodeExecutionIdFor(h.runId, "root", "done", 2);
            await h.store.enterNode({ runId: h.runId, nodeExecutionId: id, scopeId: "root", nodeId: "done", ordinal: 2,
                nodeType: "terminal", predecessorId: null, arrivalRoute: null, inputText: JSON.stringify(legacy), kvRevision: 1, waitSeconds: null,
                immediate: { outcome: "succeeded", resultKind: "business", valueText: JSON.stringify(legacy), winner: "controller" } });
            await h.sql.query(`UPDATE ${h.schema}.workflow_runs SET terminal_output=$2 WHERE run_id=$1`, [h.runId, JSON.stringify(legacy)]);
            const overview = await readWorkflowView(h.store, h.workflowSessionId);
            expect(JSON.parse(overview.run.nodeExecutions[0].inputPreview)).toEqual(safe);
            expect(JSON.parse(overview.run.output)).toEqual(safe);
            const detail = await readWorkflowView(h.store, h.workflowSessionId, { executionId: id });
            expect(detail.execution.input.value).toEqual(safe);
            expect(JSON.parse((await h.store.readDroppedVisitPreviews(h.runId, [id])).get(id))).toEqual(safe);
        } finally { await h.close(); }
    });

    it("does not give the coordinating agent sign-in identity in an approval read", async () => {
        const h = await harness();
        try {
            await h.enter();
            await h.store.approvals.respond(h.workflowSessionId, answer(h, (await proposal(h)).contextSha256), ACTOR);
            const result = await readWorkflowFromTool({ workflow_id: h.workflowSessionId },
                { callerSessionId: h.parent, host: { catalog: h.catalog, store: h.store, duroxideClient: { getStatus: async () => ({ status: "Running" }) } } });
            const view = JSON.parse(result);
            expect(view.ok, result).toBe(true);
            expect(view.run.nodeExecutions[0].approval.owner.by).toBe("a person");
            expect(result).not.toContain(OWNER.subject);
            expect(result).not.toContain("provider");
        } finally { await h.close(); }
    });

    it("masks carried identity in variables, inputs, outbox, and stored event previews", async () => {
        const h = await harness();
        try {
            const sender = "person:user:dev:private-sender";
            const actor = { ...OWNER, subject: 'private"subject' };
            const legacy = { decidedBy: actor, from: sender };
            const safe = { decidedBy: { by: "a person", name: OWNER.displayName }, from: { by: "a person" } };
            const raw = JSON.stringify(legacy);
            const kv = JSON.stringify({ carried: legacy });
            const largeKv = JSON.stringify({ carried: legacy, a: "x".repeat(150_000), b: "y".repeat(150_000) });
            await h.enter();
            await h.sql.query(`UPDATE ${h.schema}.workflow_runs SET inputs=$2, kv=$3, kv_revision=3 WHERE run_id=$1`,
                [h.runId, raw, kv]);
            await h.sql.query(`INSERT INTO ${h.schema}.workflow_kv_revisions (run_id, revision, kv) VALUES ($1, 2, $2), ($1, 3, $3)`,
                [h.runId, kv, largeKv]);
            await h.sql.query(`INSERT INTO ${h.schema}.workflow_outbox (exchange_id, node_execution_id, workflow_session_id, run_id, mode,
                recipient_session_id, recipient_kind, contract, payload, payload_sha256, correlation, created_at)
                VALUES ($1,$1,$2,$3,'send',$4,'agent','Note@1',$5,'x','{}',now())`,
            [h.approvalId, h.workflowSessionId, h.runId, h.parent, raw]);
            const read = options => readWorkflowView(h.store, h.workflowSessionId, options);
            const run = (await read()).run;
            expect.soft(JSON.parse(run.inputs)).toEqual(safe);
            expect.soft(JSON.parse(run.kv)).toEqual({ carried: safe });
            expect.soft(JSON.parse(run.outbox[0].payloadPreview)).toEqual(safe);
            expect.soft((await read({ kvRevision: 2 })).kv.entries[0].value).toEqual(safe);
            expect.soft((await read({ kvRevision: 2, kvKey: "carried" })).kv.value).toEqual(safe);
            const carried = (await read({ kvRevision: 3 })).kv.entries.find(entry => entry.key === "carried");
            expect.soft(JSON.parse(carried.preview)).toEqual(safe);
            expect.soft(carried.sha256).toBe(sha256Hex(canonicalJson(legacy)));
            expect.soft(carried.bytes).toBe(Buffer.byteLength(canonicalJson(legacy)));

            const cut = raw.slice(0, -4) + "…";
            const cutSubject = raw.slice(0, raw.indexOf('\\"') + 1);
            const clean = `{"tail":"${"z".repeat(300)}`;
            await h.catalog.recordEvents(h.workflowSessionId, [
                { eventType: "workflow.state_completed", data: { inputPreview: raw, outputPreview: cut } },
                { eventType: "workflow.completed", data: { inputPreview: clean, outputPreview: cutSubject } },
            ]);
            const [completed] = await h.catalog.getSessionEvents(h.workflowSessionId, undefined, undefined, ["workflow.state_completed"]);
            expect.soft(JSON.parse(completed.data.inputPreview)).toEqual(safe);
            expect.soft(completed.data.outputPreview).not.toMatch(/private|person:user:/);
            const [ended] = await h.catalog.getSessionEvents(h.workflowSessionId, undefined, undefined, ["workflow.completed"]);
            expect.soft(ended.data.inputPreview).toBe(clean);
            expect.soft(ended.data.outputPreview).not.toContain("private");

            const longOutput = JSON.stringify({ from: sender, tail: "z".repeat(600) });
            await h.sql.query(`UPDATE ${h.schema}.workflow_node_executions SET node_type='agent', state='completed', deadline_at=NULL,
                outcome='ok', result_kind='business', output=$2, winner='agent', completed_at=now(),
                reused_from_execution_id='old-execution', reused_from_run_id='old-run', reused_from_workflow_session_id='old-workflow', reused_at=now()
                WHERE node_execution_id=$1`, [h.approvalId, raw]);
            const recap = () => h.store.readReusedAgentVisits(h.runId, "consent");
            expect.soft((await recap()).visits[0].output).toEqual(safe);
            await h.sql.query(`UPDATE ${h.schema}.workflow_node_executions SET output=$2 WHERE node_execution_id=$1`, [h.approvalId, longOutput]);
            const visit = (await recap()).visits[0];
            expect.soft(visit).toMatchObject({ truncated: true, outputChars: longOutput.length });
            expect.soft(visit.outputPreview.length).toBeLessThanOrEqual(500);
            expect.soft(visit.outputPreview).not.toContain("private");
            const dropped = (await h.store.readDroppedVisitPreviews(h.runId, [h.approvalId])).get(h.approvalId);
            expect.soft(dropped.length).toBeLessThanOrEqual(300);
            expect.soft(dropped).not.toContain("private");
        } finally { await h.close(); }
    });

    it("renders real approval dates as portable UTC ISO even with a non-UTC store timezone", { timeout: 120000 }, async () => {
        const h = await harness({ timezone: "Pacific/Kiritimati" });
        try {
            await h.enter();
            const read = await proposal(h);
            const { rows } = await h.sql.query(`SELECT snapshot FROM ${h.schema}.workflow_approvals WHERE node_execution_id=$1`, [h.approvalId]);
            const snapshot = JSON.parse(rows[0].snapshot);
            for (const field of ["activatedAt", "deadlineAt"]) {
                expect(read[field]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
                expect(snapshot[field]).toBe(read[field]);
                expect(workflowTimeTitle(read[field])).toEqual(expect.any(String));
            }
            const receipt = await h.store.approvals.respond(h.workflowSessionId, answer(h, read.contextSha256), ACTOR);
            expect((await proposal(h)).decision.decidedAt).toBe(receipt.decidedAt);
        } finally { await h.close(); }
    });

    it("uses the feature gate, not a literal version, for live and test admission and owner answers", { timeout: 120000 }, async () => {
        const original = controllerFeatures.workflowControllerFeatures;
        const features = original("1.1.0");
        const gate = vi.spyOn(controllerFeatures, "workflowControllerFeatures")
            .mockImplementation(version => version === "1.2.0" ? features : original(version));
        try {
            for (const mode of ["live", "test"]) {
                const h = await harness({ mode, controllerVersion: "1.2.0" });
                try {
                    expect(await h.enter()).toMatchObject({ admitted: true, node: { nodeType: "approval", state: "pending" } });
                    if (mode === "live") {
                        const read = await proposal(h);
                        expect(await h.store.approvals.respond(h.workflowSessionId, answer(h, read.contextSha256), ACTOR))
                            .toMatchObject({ decision: "approved" });
                    } else {
                        expect((await h.sql.query(`SELECT operation FROM ${h.schema}.workflow_test_interceptions WHERE node_execution_id=$1`,
                            [h.approvalId])).rows).toEqual([{ operation: "approval" }]);
                    }
                } finally { await h.close(); }
            }
        } finally { gate.mockRestore(); }
    });

    it("keeps an old open approval readable outside the history page and in its detail", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            await h.enter();
            await h.store.enterNode({ runId: h.runId, nodeExecutionId: nodeExecutionIdFor(h.runId, "root", "done", 2),
                scopeId: "root", nodeId: "done", ordinal: 2, nodeType: "terminal", predecessorId: null, arrivalRoute: null,
                inputText: "{}", kvRevision: 1, waitSeconds: null,
                immediate: { outcome: "succeeded", resultKind: "business", valueText: "{}", winner: "controller" } });
            const overview = await readWorkflowView(h.store, h.workflowSessionId, { runId: h.runId, limit: 1 });
            expect(overview.run.nodeExecutions).toHaveLength(1);
            expect(overview.run.nodeExecutions[0].nodeExecutionId).not.toBe(h.approvalId);
            expect(overview.run.openExecutions.find(item => item.nodeExecutionId === h.approvalId).approval)
                .toMatchObject({ approvalId: h.approvalId, context: { proposal: 1 }, status: "pending" });
            const detail = await readWorkflowView(h.store, h.workflowSessionId, { runId: h.runId, executionId: h.approvalId });
            expect(detail.execution.approval).toMatchObject({ approvalId: h.approvalId, question: "Approve this exact proposal?" });
            for (const [actor, matches] of [[ACTOR, true], [{ ...ACTOR, subject: "not-owner" }, false]]) {
                const read = options => readWorkflowModel({ store: h.store }, h.workflowSessionId, options, "api", { actor });
                expect((await read({ executionId: h.approvalId })).execution.approval.viewerIsPinnedOwner).toBe(matches);
                expect((await read({ cursor: overview.run.pages.executions.nextCursor, limit: 1 })).items[0].approval.viewerIsPinnedOwner).toBe(matches);
            }
        } finally { await h.close(); }
    });

    it("serializes an answer against its deadline without two results", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            await h.enter();
            const snapshot = await proposal(h);
            const answering = h.store.approvals, timing = h.store.approvals;
            answering.clock = async () => new Date(Date.parse(snapshot.deadlineAt) - 1).toISOString();
            timing.clock = async () => snapshot.deadlineAt;
            const [answerResult] = await Promise.allSettled([
                answering.respond(h.workflowSessionId, answer(h, snapshot.contextSha256), ACTOR),
                timing.expire(h.workflowSessionId, h.runId, h.approvalId),
            ]);
            const node = await h.store.readNodeExecution(h.approvalId);
            expect(["approved", "timed_out"]).toContain(node.outcome);
            expect(node.outcome === "approved").toBe(answerResult.status === "fulfilled");
            expect((await proposal(h)).decision !== null).toBe(node.outcome === "approved");
        } finally { await h.close(); }
    });

    it.each([172800, 2592000])("expires a simulated %i-second approval on virtual time, with no live consent audit", { timeout: 120000 }, async timeoutSeconds => {
        const h = await harness({ mode: "test", timeoutSeconds });
        try {
            const entered = await h.enter();
            expect(Date.parse(entered.node.deadlineAt) - Date.parse(entered.node.enteredAt)).toBe(timeoutSeconds * 1000);
            expect(await proposal(h)).toBeUndefined();
            await expect(h.store.approvals.respond(h.workflowSessionId, answer(h, "a".repeat(64)), ACTOR)).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
            await h.store.advanceTestClock({ workflowSessionId: h.workflowSessionId, runId: h.runId, seconds: timeoutSeconds,
                operationId: "advance", requestSha256: "advance", projection: () => ({ eventType: "workflow.test_advanced", data: {} }) });
            expect(await h.store.readNodeExecution(h.approvalId)).toMatchObject({ outcome: "timed_out", winner: "controller" });
            expect(await proposal(h)).toBeUndefined();
        } finally { await h.close(); }
    });
    it("pins context, atomically accepts audit/result/receipt/event, replays after deadline and conflicts on reuse", { timeout: 120000 }, async () => {
        const h = await harness();
        try {
            const entered = await h.enter();
            expect(entered).toMatchObject({ admitted: true, node: { nodeType: "approval", state: "pending" } });
            const snapshot = await proposal(h);
            expect(snapshot).toMatchObject({ question: "Approve this exact proposal?", context: { proposal: 1 },
                owner: { by: "a person", name: OWNER.displayName }, status: "pending" });
            expect(snapshot.contextSha256).toMatch(/^[a-f0-9]{64}$/);
            const command = answer(h, snapshot.contextSha256);
            const receipt = await h.store.approvals.respond(h.workflowSessionId, command, ACTOR);
            expect(receipt).toMatchObject({ decision: "approved", replayed: false, contextSha256: snapshot.contextSha256 });
            expect(await proposal(h)).toMatchObject({ status: "approved", decision: { decidedBy: { by: "a person", name: OWNER.displayName } } });
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
