/**
 * Workflow Simplified stage 2.1c, FU-19, on PostgreSQL: a failed step's short error words are stored with its failure
 * event and given by every read beside the visit and the failed run, made on the server from the whole stored error.
 * A script that writes a long stack to stderr before the line that names its error (HN #2's shape: the 500-character
 * preview is cut before that line) fails its step: the `workflow.state_failed` event, the run's `workflow.failed` event,
 * the read's visit row and its run all say "the script stopped with an error: <that line>"; the preview stays as it was.
 *
 * Run: npx vitest run test/local/workflow-error-words.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowModel } from "../../src/workflow/tools.ts";

const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "system", name: "workflow-error-words-test" };
const TIMEOUT = 120_000;
const LINE = "Unknown model: gpt-imaginary (try one of the listed models)";
const WORDS = `the script stopped with an error: ${LINE}`;

const FAILING = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: noisy-failure, version: "1.0.0" }
initial: poll
states:
  poll:
    type: script
    source: |
      for (let i = 0; i < 40; i += 1) process.stderr.write("    at frame" + i + " (file:///work/script.mjs:" + i + ":1)\\n");
      process.stderr.write("Error: ${LINE}\\n");
      process.exit(1);
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;

function host(client) {
    return { catalog: client._catalog, store: client._catalog.workflowStore(), duroxideClient: client.duroxideClient };
}

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

describe("FU-19: a failed step's words, stored with its event and given by every read", () => {
    it("a script whose error line comes after a long stack: the events, the visit and the run say it in words", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const workflowSessionId = randomUUID();
            const created = await createWorkflow(h, { workflowSessionId, parentSessionId: null, yaml: FAILING, actor: ACTOR, operationId: "words",
                start: { inputs: {} } });
            const runId = created.receipt.run.runId;
            const run = await until(async () => {
                const row = await h.store.readRun(runId);
                return row && ["completed", "failed", "cancelled"].includes(row.status) ? row : null;
            }, "the run to end");
            expect(run.status, JSON.stringify(run)).toBe("failed");
            const events = await client._catalog.getSessionEvents(workflowSessionId, 0, 1000);
            const failed = events.filter(event => event.eventType === "workflow.state_failed").map(event => event.data);
            expect(failed).toEqual([expect.objectContaining({ stateId: "poll", outcome: "execution_failed", errorWords: WORDS })]);
            const ended = events.filter(event => event.eventType === "workflow.failed").map(event => event.data);
            expect(ended).toHaveLength(1);
            expect(typeof ended[0].errorWords).toBe("string");
            // A read: the visit's words beside its preview (which is cut before the line), and the failed run's.
            const view = await readWorkflowModel(h, workflowSessionId, { runId }, "api");
            const visit = view.run.nodeExecutions.find(row => row.stateId === "poll");
            expect(visit.errorWords).toBe(WORDS);
            expect(typeof visit.errorPreview).toBe("string");
            expect(visit.errorPreview.includes(LINE)).toBe(false);
            expect(typeof view.run.errorWords).toBe("string");
            // A visit that succeeded has none.
            for (const row of view.run.nodeExecutions.filter(item => item.resultKind !== "runtime_error")) expect(Object.hasOwn(row, "errorWords")).toBe(false);
        });
    });
});
