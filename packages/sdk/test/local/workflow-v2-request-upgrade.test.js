import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore, REQUEST_ACTOR, REQUEST_TIMEOUT } from "../helpers/workflow-v2-request-fixture.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/v2/json.ts";
import { workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const CMS_LOCK_SEED = 0x63_6D_73;
const SENDS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: earlier-sends, version: "1.0.0" }
initial: tell
contracts:
  Note@1: { schema: true }
states:
  tell:
    type: messaging
    mode: send
    recipient: { parent: true }
    contract: Note@1
    input: { note: "earlier" }
    transition: { next: { sent: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

async function legacyRows(h, runId) {
    return h.q(`SELECT outbox.exchange_id, outbox.mode, outbox.recipient_kind, outbox.correlation, outbox.state, outbox.attempts,
        outbox.payload, outbox.payload_sha256, outbox.receipt, outbox.error,
        to_char(outbox.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created,
        to_char(outbox.last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS attempted,
        to_char(outbox.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided,
        node.state AS node_state, node.outcome, node.output, node.error AS node_error, node.winner,
        to_char(node.entered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS entered,
        to_char(node.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed
        FROM SCHEMA.workflow_outbox outbox JOIN SCHEMA.workflow_node_executions node ON node.node_execution_id = outbox.node_execution_id
        WHERE outbox.run_id = $1 ORDER BY node.ordinal`, [runId]);
}

describe("workflow v2 request migration: populated send compatibility", () => {
    it("upgrades actual 0096 send rows without rewriting their payloads, receipts, times or legacy defaults", { timeout: REQUEST_TIMEOUT }, async () => {
        const env = getEnv();
        // useSuiteEnv owns this schema's teardown; unlike a current initialized catalog, this starts with genuine 0096 DDL.
        const h = await openWorkflowStore(env, { initialize: false });
        try {
            const migrations = CMS_MIGRATIONS(env.cmsSchema);
            await runMigrations(h.pool, env.cmsSchema, migrations.filter(migration => migration.version <= "0096"), CMS_LOCK_SEED);
            const versions = async () => (await h.q("SELECT version FROM SCHEMA.schema_migrations ORDER BY version")).map(row => row.version);
            const beforeVersions = await versions();
            expect(beforeVersions.at(-1)).toBe("0096");
            expect(await h.q("SELECT to_regclass($1) AS request_table", [`"${env.cmsSchema}".workflow_requests`])).toEqual([{ request_table: null }]);
            const modeConstraint = async () => (await h.q(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
                WHERE conrelid = $1::regclass AND conname = 'workflow_outbox_mode'`, [`"${env.cmsSchema}".workflow_outbox`]))[0].definition;
            expect(await modeConstraint()).not.toContain("request");

            const owner = { provider: "test", subject: `earlier-send-owner-${randomUUID()}` };
            const parent = randomUUID();
            await h.catalog.createSession(parent, { owner });
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            const compiled = compileWorkflowV2(SENDS);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
                creationConfig: { workflowV2: { requestSha256: "earlier-sends" } } })).toEqual({ created: true });
            await h.store.createDefinition({ workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: SENDS, compiled,
                actor: REQUEST_ACTOR, operationId: "create", requestSha256: "earlier-sends", publish: true, title: "Workflow: earlier sends",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null } });
            const refusal = code => ({ result: { outcome: code, resultKind: "runtime_error",
                valueText: canonicalJson({ code, message: code }), winner: "controller" } });
            const deliveryProjection = receipt => ({ sessionId: workflowSessionId, update: { touch: true }, events: [{
                eventType: "workflow.state_completed", data: { exchangeId: receipt.exchangeId, outcome: "sent" },
            }] });
            const refusals = { refused: { unavailable: refusal("unavailable"), forbidden: refusal("forbidden") },
                ended: null, delivered: { stateId: "tell", projection: deliveryProjection } };
            const payloads = [null, { note: "delivered", text: "\u0000\ud800" }, [false, [], { note: "failed" }]];
            const exchangeIds = [];
            for (let ordinal = 1; ordinal <= payloads.length; ordinal += 1) {
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "tell", ordinal);
                const payloadText = canonicalJson(payloads[ordinal - 1]);
                expect(await h.store.enterNode({ runId, nodeExecutionId, scopeId: "root", nodeId: "tell", ordinal, nodeType: "messaging",
                    predecessorId: null, arrivalRoute: null, inputText: payloadText, kvRevision: 1, waitSeconds: null, immediate: null,
                    send: { recipient: parent, contract: "Note@1", payloadText, correlationText: "{}",
                        refused: refusals.refused } })).toMatchObject({ admitted: true, inserted: true });
                exchangeIds.push(nodeExecutionId);
            }
            // 0096 explicitly permits null columns on agent rows retained from 0095.
            await h.q("UPDATE SCHEMA.workflow_outbox SET recipient_kind = NULL, correlation = NULL WHERE run_id = $1", [runId]);
            for (const exchangeId of exchangeIds) expect(await h.store.beginDelivery(exchangeId, refusals)).toMatchObject({ kind: "deliver" });
            const [pending, delivered, failed] = exchangeIds;
            expect(await h.store.beginDelivery(delivered, refusals)).toMatchObject({ kind: "deliver", message: { attempts: 2 } });
            expect(await h.store.recordDelivery(delivered, { stateId: "tell", clientMessageId: "earlier-queue-receipt", input: null },
                deliveryProjection)).toMatchObject({ recorded: true, won: true });
            expect(await h.store.failDelivery(failed, { outcome: "unavailable", resultKind: "runtime_error",
                valueText: canonicalJson({ code: "unavailable", message: "earlier failure" }), winner: "controller" },
            { sessionId: workflowSessionId, update: { touch: true } }, refusals.delivered)).toMatchObject({ delivered: false, won: true });

            const before = await legacyRows(h, runId);
            expect(before.map(row => row.state)).toEqual(["pending", "delivered", "failed"]);
            expect(before.map(row => row.attempts)).toEqual([1, 2, 1]);
            for (let index = 0; index < before.length; index += 1) {
                expect(before[index]).toMatchObject({ mode: "send", recipient_kind: null, correlation: null,
                    payload: canonicalJson(payloads[index]), payload_sha256: sha256Hex(canonicalJson(payloads[index])) });
                expect(before[index].created).toBe(before[index].entered);
                expect(before[index].attempted).toMatch(/\.\d{6}Z$/);
            }
            expect(before[0]).toMatchObject({ decided: null, receipt: null, completed: null, node_state: "pending" });
            expect(before[1].receipt).toBe(before[1].output);
            expect(before[1].decided).toBe(before[1].completed);
            expect(JSON.parse(before[1].receipt)).toMatchObject({ clientMessageId: "earlier-queue-receipt", attempts: 2,
                payloadSha256: before[1].payload_sha256, deliveredAt: before[1].decided });
            expect(before[2].error).toBe(before[2].node_error);
            const revisions = await h.q("SELECT yaml, yaml_sha256, ir, ir_sha256 FROM SCHEMA.workflow_revisions WHERE workflow_session_id = $1",
                [workflowSessionId]);
            const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 1000);
            expect(await versions()).toEqual(beforeVersions);
            expect(await h.q("SELECT to_regclass($1) AS request_table", [`"${env.cmsSchema}".workflow_requests`])).toEqual([{ request_table: null }]);

            // The real catalog initialization applies the registered 0097 transaction, not copied migration SQL.
            await h.catalog.initialize();
            expect(await versions()).toEqual([...beforeVersions, "0097", "0098", "0099", "0100", "0101", "0102", "0103", "0104", "0105", "0106"]);
            expect(await modeConstraint()).toContain("request");
            expect(await legacyRows(h, runId)).toEqual(before);
            expect(await h.q("SELECT yaml, yaml_sha256, ir, ir_sha256 FROM SCHEMA.workflow_revisions WHERE workflow_session_id = $1",
                [workflowSessionId])).toEqual(revisions);
            expect(await h.catalog.getSessionEvents(workflowSessionId, 0, 1000)).toEqual(events);
            for (const table of ["workflow_requests", "workflow_request_responses", "workflow_request_operations", "workflow_response_wakes"]) {
                expect((await h.q(`SELECT count(*)::int AS n FROM SCHEMA.${table}`))[0].n).toBe(0);
            }
            const outbox = await h.store.listOutbox(runId);
            expect(outbox).toHaveLength(3);
            for (let index = 0; index < outbox.length; index += 1) {
                const message = await h.store.readOutboxMessage(exchangeIds[index]);
                expect(message).toMatchObject({ mode: "send", recipientKind: "agent", correlation: {}, state: before[index].state,
                    payload: payloads[index], payloadSha256: before[index].payload_sha256, attempts: before[index].attempts });
                expect(message).toEqual(outbox.find(item => item.exchangeId === exchangeIds[index]));
            }
            const deliveredBefore = await h.store.readOutboxMessage(delivered);
            const failedBefore = await h.store.readOutboxMessage(failed);
            expect(await h.store.beginDelivery(delivered, refusals)).toMatchObject({ kind: "decided", message: deliveredBefore });
            expect(await h.store.beginDelivery(failed, refusals)).toMatchObject({ kind: "decided", message: failedBefore });
            expect(await h.store.recordDelivery(delivered, { stateId: "tell", clientMessageId: "earlier-queue-receipt", input: null },
                deliveryProjection)).toMatchObject({ recorded: false, won: false, message: deliveredBefore });
            expect(await legacyRows(h, runId)).toEqual(before);

            // The still-pending legacy operation works after the widened CHECK and records one new delivery, then replays.
            expect(await h.store.beginDelivery(pending, refusals)).toMatchObject({ kind: "deliver", message: { attempts: 2, recipientKind: "agent" } });
            const control = await h.store.recordDelivery(pending, { stateId: "tell", clientMessageId: "after-upgrade-receipt", input: null },
                deliveryProjection);
            expect(control).toMatchObject({ recorded: true, won: true, node: { state: "completed", outcome: "sent", winner: "delivery" },
                message: { state: "delivered", attempts: 2, payload: null, correlation: {}, receipt: { clientMessageId: "after-upgrade-receipt" } } });
            expect(control.node.output).toEqual(control.message.receipt);
            expect(await h.store.recordDelivery(pending, { stateId: "tell", clientMessageId: "after-upgrade-receipt", input: null },
                deliveryProjection)).toMatchObject({ recorded: false, won: false, message: control.message });
            expect((await h.catalog.getSessionEvents(workflowSessionId, 0, 1000))
                .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === pending)).toHaveLength(1);
            const after = await legacyRows(h, runId);
            expect(after.slice(1)).toEqual(before.slice(1));
            expect(after[0]).toMatchObject({ payload: before[0].payload, payload_sha256: before[0].payload_sha256,
                created: before[0].created, entered: before[0].entered, recipient_kind: null, correlation: null });
            await runMigrations(h.pool, env.cmsSchema, migrations, CMS_LOCK_SEED);
            expect(await versions()).toEqual([...beforeVersions, "0097", "0098", "0099", "0100", "0101", "0102", "0103", "0104", "0105", "0106"]);
            expect(await legacyRows(h, runId)).toEqual(after);
        } finally { await h.stop(); }
    });
});
