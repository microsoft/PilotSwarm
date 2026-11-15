import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { intakeBoundItem, intakeEnvelopeSha256, intakeItemBytes } from "../../src/workflow/intake.ts";
import { runWorkflowIntakeClaim, runWorkflowIntakeSettle } from "../../src/workflow/intake-activities.ts";
import { workflowLiveControllerInstanceId, workflowSendClientMessageId, workflowSendPrompt } from "../../src/workflow/runtime.ts";
import { WorkflowStore, nodeExecutionIdFor } from "../../src/workflow/store.ts";

export const INTAKE_ACTIVITY_TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-intake-activities-test" };
const SENDS = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: intake-activity-sends, version: "1.0.0" }
initial: tell
contracts:
  Note@1: { schema: true }
states:
  tell:
    type: messaging
    mode: send
    recipient: { parent: true }
    contract: Note@1
    input: { note: "hello" }
    transition: { next: { sent: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** Real store transactions over private query hooks; no activity registration, worker or orchestration starts. */
export async function intakeActivityFixture(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    const pool = new pg.Pool({ connectionString: env.store, max: 3, connectionTimeoutMillis: 10_000,
        statement_timeout: 15_000, lock_timeout: 10_000 });
    const control = { hook: null, onRetry: null };
    const sleeps = [];
    const logs = [];
    const store = new WorkflowStore({
        async connect() {
            const client = await pool.connect();
            const query = (sql, params) => client.query(sql, params);
            return {
                query(sql, params) {
                    return control.hook ? control.hook({ sql, params, query, pid: client.processID }) : query(sql, params);
                },
                release: (...args) => client.release(...args),
            };
        },
        query: (sql, params) => pool.query(sql, params),
    }, env.cmsSchema);
    const deps = { store, sleep: async ms => { sleeps.push(ms); if (control.onRetry) await control.onRetry(ms); } };
    const q = async (sql, params = []) => (await pool.query(sql.replaceAll("SCHEMA.", `"${env.cmsSchema}".`), params)).rows;
    const close = async () => {
        control.hook = null;
        control.onRetry = null;
        try { await catalog.close(); } finally { await pool.end(); }
    };
    try {
        await catalog.initialize();
        const recipientSessionId = randomUUID();
        const workflowSessionId = randomUUID();
        const runId = randomUUID();
        const owner = { provider: "test", subject: `intake-activity-owner-${randomUUID()}` };
        await catalog.createSession(recipientSessionId, { owner });
        expect(await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: recipientSessionId, owner,
            creationConfig: { workflow: { requestSha256: "intake-activities" } } })).toEqual({ created: true });
        const compiled = compileWorkflow(SENDS);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        await store.createDefinition({
            workflowSessionId, parentSessionId: recipientSessionId, notifyParent: false, yaml: SENDS, compiled, actor: ACTOR,
            operationId: "create", requestSha256: "intake-activities", publish: true, title: "Workflow: intake activity tests",
            start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                inputsText: "{}", kvText: "{}", testAgentMode: null },
        });
        const claim = input => runWorkflowIntakeClaim(deps, input, message => logs.push(message));
        const settle = input => runWorkflowIntakeSettle(deps, input, message => logs.push(message));
        const send = async (ordinal, payload = { note: `item ${ordinal}` }) => {
            const exchangeId = nodeExecutionIdFor(runId, "root", "tell", ordinal);
            const payloadText = canonicalJson(payload);
            const refusal = code => ({ result: { outcome: code, resultKind: "runtime_error",
                valueText: canonicalJson({ code, message: code }), winner: "controller" } });
            expect(await store.enterNode({ runId, nodeExecutionId: exchangeId, scopeId: "root", nodeId: "tell", ordinal,
                nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: payloadText, kvRevision: 1,
                waitSeconds: null, immediate: null, send: { recipient: recipientSessionId, contract: "Note@1", payloadText,
                    correlationText: "{}", refused: { unavailable: refusal("unavailable"), forbidden: refusal("forbidden") } } }))
                .toMatchObject({ admitted: true, inserted: true });
            // The inactive sender has no durable-count entry point. Use the native intake-store test's single mode-decision statement.
            expect(await q(`UPDATE SCHEMA.workflow_outbox SET attempts = attempts + 1, last_attempt_at = clock_timestamp(),
                intake_mode = 'durable', attempt_token = $2 WHERE exchange_id = $1 AND attempts = 0 RETURNING attempts, intake_mode`,
            [exchangeId, randomUUID()])).toEqual([{ attempts: 1, intake_mode: "durable" }]);
            const fields = { v: 1, exchangeId, workflowSessionId, runId, recipientSessionId, contract: "Note@1", payloadSha256: sha256Hex(payloadText) };
            return { recipientSessionId, envelope: { ...fields, envelopeSha256: intakeEnvelopeSha256(fields) },
                claimId: `claim-${ordinal}`, mode: "accept" };
        };
        const accepted = async ordinal => {
            const input = await send(ordinal);
            const result = await claim(input);
            expect(result).toMatchObject({ ok: true, result: { result: "accepted", inserted: true } });
            return { exchangeId: input.envelope.exchangeId, claimId: input.claimId };
        };
        const boundPair = async () => {
            const items = [await accepted(1), await accepted(2)];
            const invocationId = randomUUID();
            expect(await settle({ op: "bind", recipientSessionId, invocationId, items }))
                .toMatchObject({ ok: true, result: { bound: true, items } });
            return { recipientSessionId, invocationId, items };
        };
        const expectedItem = async input => {
            const message = await store.readOutboxMessage(input.envelope.exchangeId);
            const text = workflowSendPrompt({ ...message, stateId: "tell" });
            const clientMessageId = workflowSendClientMessageId(workflowSessionId, runId, message.nodeExecutionId);
            const ref = { exchangeId: message.exchangeId, claimId: input.claimId, textSha256: sha256Hex(text), clientMessageId };
            return { ...ref, text, itemBytes: intakeItemBytes(intakeBoundItem(ref, text)) };
        };
        const effects = async () => ({
            nodes: await q("SELECT row_to_json(node)::text AS data, xmin::text AS version FROM SCHEMA.workflow_node_executions node WHERE run_id = $1 ORDER BY ordinal",
                [runId]),
            outbox: await q("SELECT row_to_json(outbox)::text AS data, xmin::text AS version FROM SCHEMA.workflow_outbox outbox WHERE run_id = $1 ORDER BY exchange_id",
                [runId]),
            sessions: await q("SELECT row_to_json(session)::text AS data, xmin::text AS version FROM SCHEMA.sessions session WHERE session_id = ANY($1::text[]) ORDER BY session_id",
                [[workflowSessionId, recipientSessionId]]),
            senderEvents: await catalog.getSessionEvents(workflowSessionId, 0, 1000),
            recipientEvents: await catalog.getSessionEvents(recipientSessionId, 0, 1000),
        });
        const snapshot = async () => ({
            intake: await q(`SELECT row_to_json(intake)::text AS data, xmin::text AS version FROM SCHEMA.workflow_intake intake
                WHERE run_id = $1 ORDER BY exchange_id`, [runId]),
            invocations: await q(`SELECT row_to_json(invocation)::text AS data, xmin::text AS version FROM SCHEMA.workflow_intake_invocations invocation
                WHERE recipient_session_id = $1 ORDER BY invocation_id`, [recipientSessionId]),
            effects: await effects(),
        });
        return { catalog, store, control, sleeps, logs, deps, q, claim, settle, send, accepted, boundPair, expectedItem, effects, snapshot,
            recipientSessionId, workflowSessionId, runId, close };
    } catch (error) {
        await close();
        throw error;
    }
}
