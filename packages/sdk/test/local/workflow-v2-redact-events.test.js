/**
 * Adversarial review SF-6: a workflow event's error fields are stored with their secrets hidden, through the store's one
 * event writer (the notifier's, the test notice's and the agent end's failures all record through it).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";

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
});
