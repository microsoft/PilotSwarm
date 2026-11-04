/**
 * Adversarial review SF-6: a workflow event's error fields are stored with their secrets hidden, through the store's one
 * event writer (the notifier's, the test notice's and the agent end's failures all record through it).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
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
});
