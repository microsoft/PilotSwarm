/**
 * Adversarial review SF-6: a workflow event's error fields are stored with their secrets hidden, through the store's one
 * event writer (the notifier's, the test notice's and the agent end's failures all record through it).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { WORKFLOW_V2_STOP_CONTROLLER_VERSIONS } from "../../src/workflow/v2/runtime.ts";
import { readWorkflowFromTool, readWorkflowV2View } from "../../src/workflow/v2/tools.ts";
import pg from "pg";

const getEnv = useSuiteEnv(import.meta.url);
const SENTINEL = "s3nt1nel-Secr3t";

describe("workflow v2 event redaction", () => {
    it("stores an event's error fields without secrets and leaves its other fields as they were", { timeout: 60_000 }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const store = catalog.workflowStore();
            const id = randomUUID();
            await catalog.createSession(id, {});
            await store.recordSessionEvents(id, [{ eventType: "workflow.test_notice_failed", data: {
                runId: "run-1", interceptionId: "nx-1/call-1",
                error: `notify failed: postgres://app:${SENTINEL}@db/wf {"authorization":"Bearer ${SENTINEL}"} token=${SENTINEL}`,
            } }]);
            const [event] = await catalog.getSessionEvents(id, 0, 10, ["workflow.test_notice_failed"]);
            expect(JSON.stringify(event.data)).not.toContain(SENTINEL);
            expect(event.data.runId).toBe("run-1");
            expect(event.data.interceptionId).toBe("nx-1/call-1");
            expect(event.data.error).toContain("postgres://<hidden>@db/wf");
        } finally {
            await catalog.close();
        }
    });

    it("SF-6 verification: a run's error column and the session's last error are stored without secrets", { timeout: 60_000 }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const db = new pg.Pool({ connectionString: env.store, max: 1 });
        try {
            const store = catalog.workflowStore();
            const parent = randomUUID();
            await catalog.createSession(parent, {});
            const id = randomUUID();
            const host = { catalog, store, duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const yaml = [
                "apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", "metadata: { name: redact, version: \"1.0.0\" }", "initial: pause", "states:",
                "  pause: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }", "  done: { type: terminal, outcome: succeeded }",
            ].join("\n");
            const created = await createWorkflowV2(host, { workflowSessionId: id, parentSessionId: parent, yaml, actor: { kind: "system", name: "redact-test" },
                operationId: "create", start: { inputs: {} } });
            const { runId } = created.receipt.run;
            const secretError = JSON.stringify({ code: "controller_error", message: `connect postgres://app:${SENTINEL}@db/wf failed`, details: { key: SENTINEL } });
            await store.finishRun({ runId, status: "failed", terminalNodeId: null, terminalOutcome: null, outputText: null, errorText: secretError,
                endPending: { winner: "controller", message: "The workflow run ended before this state finished." },
                projection: { sessionId: id, events: [], update: { state: "failed", lastError: `Bearer ${SENTINEL} token=${SENTINEL}` } } });
            const runs = await db.query(`SELECT terminal_error FROM "${env.cmsSchema}".workflow_runs WHERE run_id = $1`, [runId]);
            expect(String(runs.rows[0].terminal_error)).not.toContain(SENTINEL);
            expect(String(runs.rows[0].terminal_error)).toContain("postgres://<hidden>@db/wf");
            const sessions = await db.query(`SELECT last_error FROM "${env.cmsSchema}".sessions WHERE session_id = $1`, [id]);
            expect(String(sessions.rows[0].last_error)).not.toContain(SENTINEL);
        } finally {
            await db.end();
            await catalog.close();
        }
    });

    it("E2-T5: a cancel's reason before the run began and a stop's reason are stored without secrets", { timeout: 60_000 }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const db = new pg.Pool({ connectionString: env.store, max: 1 });
        try {
            const store = catalog.workflowStore();
            const parent = randomUUID();
            await catalog.createSession(parent, {});
            // No controller starts: each run stays admitted (not begun), on controller 1.9.0.
            const host = { catalog, store, requests: true,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "NotFound" }), enqueueEvent: async () => {} } };
            const yaml = [
                "apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", "metadata: { name: redact, version: \"1.0.0\" }", "initial: pause", "states:",
                "  pause: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }", "  done: { type: terminal, outcome: succeeded }",
            ].join("\n");
            const actor = { kind: "system", name: "redact-test" };
            const started = async () => {
                const id = randomUUID();
                const created = await createWorkflowV2(host, { workflowSessionId: id, parentSessionId: parent, yaml, actor, operationId: "create", start: { inputs: {} } });
                return { id, runId: created.receipt.run.runId };
            };
            const reason = `stop it: token=${SENTINEL} Bearer ${SENTINEL}`;
            const stored = async runId => (await db.query(
                `SELECT terminal_error, stop_request, status FROM "${env.cmsSchema}".workflow_runs WHERE run_id = $1`, [runId])).rows[0];

            // A cancel before the run began ends it in the store, with its reason in the run's error.
            const cancelled = await started();
            await controlWorkflowV2Run(host, cancelled.id, { operation: "cancel", runId: null, reason }, { actor, operationId: "cancel-1" });
            const afterCancel = await stored(cancelled.runId);
            expect(afterCancel.status).toBe("cancelled");
            expect(String(afterCancel.terminal_error)).not.toContain(SENTINEL);
            expect(JSON.parse(afterCancel.terminal_error).message).toBe("stop it: token=<hidden> Bearer <hidden>");

            // A stop: its request and the run's error when it ends.
            const stopped = await started();
            await store.requestRunStop({ workflowSessionId: stopped.id, runId: stopped.runId, operationId: "stop-1", requestSha256: "stop", actor, reason,
                graceSeconds: 0, stoppableVersions: WORKFLOW_V2_STOP_CONTROLLER_VERSIONS });
            expect(String((await stored(stopped.runId)).stop_request)).not.toContain(SENTINEL);
            const ended = await store.finishStoppedRun({ runId: stopped.runId,
                projection: ({ run }) => ({ sessionId: run.workflowSessionId, update: { state: "cancelled", touch: true } }) });
            expect(ended).toMatchObject({ result: "ended", run: { status: "stopped" } });
            const afterStop = await stored(stopped.runId);
            expect(String(afterStop.terminal_error)).not.toContain(SENTINEL);
            expect(JSON.parse(afterStop.terminal_error)).toMatchObject({ code: "stopped" });
            // And the events and the session row of both.
            for (const id of [cancelled.id, stopped.id]) {
                expect(JSON.stringify(await catalog.getSessionEvents(id, 0, 100))).not.toContain(SENTINEL);
                const session = await db.query(`SELECT last_error FROM "${env.cmsSchema}".sessions WHERE session_id = $1`, [id]);
                expect(String(session.rows[0].last_error)).not.toContain(SENTINEL);
            }
            // Verification E2bH-T6: every read shows them hidden: the workflow view (what the REST and MCP reads return) and the
            // parent agent's read_workflow; and the replay of the cancel (its operation id again) returns its receipt without them.
            for (const id of [cancelled.id, stopped.id]) {
                expect(JSON.stringify(await readWorkflowV2View(store, id))).not.toContain(SENTINEL);
                const read = await readWorkflowFromTool({ workflow_id: id }, { callerSessionId: parent, host });
                expect(read).not.toContain(SENTINEL);
                expect(JSON.parse(read)).toMatchObject({ ok: true });
            }
            const replay = await controlWorkflowV2Run(host, cancelled.id, { operation: "cancel", runId: null, reason }, { actor, operationId: "cancel-1" });
            expect(replay).toMatchObject({ replayed: true });
            expect(JSON.stringify(replay)).not.toContain(SENTINEL);
        } finally {
            await db.end();
            await catalog.close();
        }
    });

    // Adversarial review R3-SF-2: a reason holding a URL whose user and password are longer than the 500-character cut is
    // redacted whole before it is cut, so no part of the password is stored or read: the pause event, the stop request and
    // its event, the run read, the stopped run's error, the cancel before begin and the session row. A stop request stored
    // before this fix (cut first) is hidden when it is read.
    it("R3-SF-2: a credential longer than the cut leaves no part in any stored or read reason", { timeout: 60_000 }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const db = new pg.Pool({ connectionString: env.store, max: 1 });
        try {
            const store = catalog.workflowStore();
            const parent = randomUUID();
            await catalog.createSession(parent, {});
            const host = { catalog, store, requests: true,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "NotFound" }), enqueueEvent: async () => {} } };
            const yaml = [
                "apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", "metadata: { name: redact, version: \"1.0.0\" }", "initial: pause", "states:",
                "  pause: { type: wait, seconds: 600, transition: { next: { elapsed: done } } }", "  done: { type: terminal, outcome: succeeded }",
            ].join("\n");
            const actor = { kind: "system", name: "redact-test" };
            const started = async () => {
                const id = randomUUID();
                const created = await createWorkflowV2(host, { workflowSessionId: id, parentSessionId: parent, yaml, actor, operationId: "create", start: { inputs: {} } });
                return { id, runId: created.receipt.run.runId };
            };
            const PART = "pppppppp";
            const reason = `stop it: postgres://admin:${"p".repeat(600)}${SENTINEL}@db.example.com/app`;
            const clean = text => {
                expect(text).not.toContain(PART);
                expect(text).not.toContain(SENTINEL);
            };
            const row = async runId => (await db.query(
                `SELECT terminal_error, stop_request FROM "${env.cmsSchema}".workflow_runs WHERE run_id = $1`, [runId])).rows[0];

            // A pause and a resume with the reason, then a cancel before the run began.
            const cancelled = await started();
            await controlWorkflowV2Run(host, cancelled.id, { operation: "pause", runId: null, reason }, { actor, operationId: "pause-1" });
            await controlWorkflowV2Run(host, cancelled.id, { operation: "resume", runId: null, reason }, { actor, operationId: "resume-1" });
            await controlWorkflowV2Run(host, cancelled.id, { operation: "cancel", runId: null, reason }, { actor, operationId: "cancel-1" });
            clean(String((await row(cancelled.runId)).terminal_error));

            // A stop: its request, its event, the run read while it stops, and the stopped run's error.
            const stopped = await started();
            await store.requestRunStop({ workflowSessionId: stopped.id, runId: stopped.runId, operationId: "stop-1", requestSha256: "stop", actor, reason,
                graceSeconds: 600, stoppableVersions: WORKFLOW_V2_STOP_CONTROLLER_VERSIONS });
            clean(String((await row(stopped.runId)).stop_request));
            const stopping = await readWorkflowV2View(store, stopped.id);
            expect(stopping.run.stop.reason).toContain("postgres://<hidden>");
            clean(JSON.stringify(stopping));
            const ended = await store.finishStoppedRun({ runId: stopped.runId,
                projection: ({ run }) => ({ sessionId: run.workflowSessionId, update: { state: "cancelled", touch: true } }) });
            expect(ended).toMatchObject({ result: "ended" });
            clean(String((await row(stopped.runId)).terminal_error));

            // Every event and session row of both, and the parent's read_workflow.
            for (const id of [cancelled.id, stopped.id]) {
                clean(JSON.stringify(await catalog.getSessionEvents(id, 0, 100)));
                clean(String((await db.query(`SELECT last_error FROM "${env.cmsSchema}".sessions WHERE session_id = $1`, [id])).rows[0].last_error));
                clean(await readWorkflowFromTool({ workflow_id: id }, { callerSessionId: parent, host }));
            }

            // A stop request stored before this fix, cut first: the cut URL is hidden when it is read.
            const legacy = JSON.parse((await row(stopped.runId)).stop_request);
            legacy.reason = `stop it: postgres://admin:${"p".repeat(480)}…`;
            await db.query(`UPDATE "${env.cmsSchema}".workflow_runs SET stop_request = $2 WHERE run_id = $1`, [stopped.runId, JSON.stringify(legacy)]);
            const read = await readWorkflowV2View(store, stopped.id);
            expect(read.run.stop.reason).toBe("stop it: postgres://<hidden>…");
        } finally {
            await db.end();
            await catalog.close();
        }
    });
});

