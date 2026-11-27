/**
 * I6: a child Workflow's whole result reaches its Workflow parent (real Duroxide runtime + PostgreSQL):
 * - a 100 KiB child output reaches the parent's next state whole, with the child's runId in the WorkflowEnded@1 notice;
 * - the notice limit is measured on the form the receiving state gets: a 180 KiB output through a list receive with a 60 KiB
 *   carry still reaches the next state whole (no invalid_input);
 * - an output that still does not fit (240 KiB) arrives as outputTruncated: true with the runId, and a script reads the whole
 *   output with child_workflows read full_output;
 * - a cleaned-up child is read through the outcome kept with its parent;
 * - a notice of the older shape (no runId) still works for a receiving state.
 *
 * Run: npx vitest run test/local/workflow-child-whole-result.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerWorkflow } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { childWorkflowsFromTool } from "../../src/workflow/tools.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { WORKFLOW_ENDED_CONTRACT } from "../../src/workflow/compiler.ts";
import { WORKFLOW_COMMAND_QUEUE } from "../../src/workflow/commands.ts";
import { typedInputRequestSha256, WORKFLOW_INBOX_LIMITS, WORKFLOW_INPUT_TTL_SECONDS } from "../../src/workflow/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "child-whole-result" };
const ENGINE = { kind: "system", name: "child-whole-result-test" };

async function startHarness(env) {
    const tag = randomUUID().slice(0, 8);
    const duroxideSchema = `duroxide_cwr_${tag}`;
    const cmsSchema = `cms_cwr_${tag}`;
    const provider = await PostgresProvider.connectWithSchema(env.store, duroxideSchema);
    const client = new Client(provider);
    const catalog = await PgSessionCatalog.create(env.store, cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const pool = new pg.Pool({ connectionString: env.store });
    const runtime = new Runtime(provider, {
        orchestrationConcurrency: 8, workerConcurrency: 8, dispatcherPollIntervalMs: 20,
        workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] }, logLevel: "error",
    });
    const host = { catalog, store, duroxideClient: client, scripts: true };
    registerWorkflow(runtime, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => ({ call: async () => { throw new Error("no tools"); }, close: async () => {} }),
        authorizeParentNotification: async () => true,
        notifyParent: async () => ({ delivered: true }),
        deleteSession: async (id) => { await catalog.softDeleteSession(id); },
        wakeBackstopMs: 200,
        spawnChildHost: () => host,
    });
    await runtime.start();
    const waitForRunStatus = async (runId, statuses, timeoutMs = 60_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const run = await store.readRun(runId);
            if (run && statuses.includes(run.status)) return run;
            await new Promise(r => setTimeout(r, 100));
        }
        const last = await store.readRun(runId);
        throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join("|")}; last=${last?.status} error=${JSON.stringify(last?.terminalError)}`);
    };
    return {
        catalog, store, host, client, waitForRunStatus,
        stop: async () => {
            await runtime.shutdown();
            await catalog.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${duroxideSchema}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${cmsSchema}" CASCADE`);
            await pool.end();
        },
    };
}

const BIG_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: big-child, version: "1.0.0" }
inputs:
  schema: { type: object, required: [kib], properties: { kib: { type: integer } }, additionalProperties: false }
initialInput: "\${inputs}"
initial: make
states:
  make:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { blob: "x".repeat(context.input.kib * 1024) });
    transition: { next: { ok: done } }
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
`;

/** 100 KiB child, single-contract receive: the next state gets the notice payload itself. */
const PARENT_WHOLE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-whole, version: "1.0.0" }
initial: spawn_big
states:
  spawn_big:
    type: spawn
    definition: big-child
    inputs: { kib: 100 }
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 60 }
    transition: { next: { received: check, elapsed: failed, failure: failed } }
  check:
    type: script
    outcomes: [ok]
    source: |
      const ended = context.input;
      await setResult("ok", { length: ended.output.blob.length, runId: ended.runId, truncated: ended.outputTruncated, status: ended.status });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

/** 180 KiB child through a list receive with a 60 KiB carry: the widest form a receiving state takes. */
const PARENT_WRAPPED_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-wrapped, version: "1.0.0" }
contracts:
  Progress@1: { schema: { type: object } }
initial: pad
states:
  pad:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { pad: "p".repeat(60 * 1024) });
    transition: { next: { ok: spawn_big } }
  spawn_big:
    type: spawn
    definition: big-child
    inputs: { kib: 180 }
    carry: { pad: "\${input.pad}" }
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: [Progress@1, WorkflowEnded@1]
    carry: { pad: "\${input.carry.pad}", child: "\${input.result.workflowId}" }
    wait: { seconds: 60 }
    transition: { next: { Progress@1: failed, WorkflowEnded@1: check, elapsed: failed, failure: failed } }
  check:
    type: script
    outcomes: [ok]
    source: |
      const { carry, result } = context.input;
      await setResult("ok", { pad: carry.pad.length, child: carry.child === result.from, contract: result.contract,
        length: result.payload.output.blob.length, truncated: result.payload.outputTruncated, runId: result.payload.runId });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

/** 240 KiB child: the notice cannot carry it; the next script reads it whole with child_workflows read. */
const PARENT_READ_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-read, version: "1.0.0" }
initial: spawn_big
states:
  spawn_big:
    type: spawn
    definition: big-child
    inputs: { kib: 240 }
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 60 }
    transition: { next: { received: fetch, elapsed: failed, failure: failed } }
  fetch:
    type: script
    outcomes: [ok]
    source: |
      const ended = context.input;
      const read = await callTool("child_workflows", { operation: "read", workflow_id: ended.workflowId, full_output: true });
      const preview = await callTool("child_workflows", { operation: "read", workflow_id: ended.workflowId });
      const whole = JSON.parse(read.run.output);
      await setResult("ok", { truncated: ended.outputTruncated, hasOutput: Object.hasOwn(ended, "output"), runId: ended.runId,
        readRunId: read.run.runId, length: whole.blob.length, previewLength: preview.run.output.length });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

/** A receive and the next state, for a notice delivered by hand in the older shape (no runId). */
const PARENT_LEGACY_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-legacy, version: "1.0.0" }
initial: collect
states:
  collect:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 60 }
    transition: { next: { received: check, elapsed: failed, failure: failed } }
  check:
    type: script
    outcomes: [ok]
    source: |
      const ended = context.input;
      await setResult("ok", { workflowId: ended.workflowId, status: ended.status, summary: ended.output.summary, runId: ended.runId ?? null });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

describe("I6: a child Workflow's whole result reaches its Workflow parent", () => {
    it("delivers whole outputs, says when one does not fit, reads it whole, reads a cleaned-up child, and takes an older notice", { timeout: TIMEOUT }, async () => {
        const h = await startHarness(getEnv());
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            for (const [name, yaml] of [["big-child", BIG_CHILD_YAML], ["parent-whole", PARENT_WHOLE_YAML], ["parent-wrapped", PARENT_WRAPPED_YAML],
                ["parent-read", PARENT_READ_YAML], ["parent-legacy", PARENT_LEGACY_YAML]]) {
                const saved = await saveSessionWorkflowDefinition(h.host, {
                    ownerSessionId: chat, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: chat }, operationId: `save-${name}`, by: "session",
                });
                expect(saved.receipt.valid, `${name}: ${JSON.stringify(saved.receipt.diagnostics)}`).toBe(true);
            }
            const start = (name) => startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name }, inputs: {}, actor: ENGINE, operationId: `start-${name}`, owner: OWNER,
            });
            const onlyChild = async (workflowId) => {
                const children = await h.store.listChildWorkflows(workflowId);
                expect(children).toHaveLength(1);
                return children[0];
            };

            // A 100 KiB child output reaches the parent's next state whole, with the child's run id.
            const whole = await start("parent-whole");
            const wholeEnd = await h.waitForRunStatus(whole.runId, ["completed", "failed"]);
            expect(wholeEnd.status, JSON.stringify(wholeEnd.terminalError)).toBe("completed");
            const wholeChild = await onlyChild(whole.workflowId);
            expect(wholeEnd.terminalOutput).toEqual({ length: 100 * 1024, runId: wholeChild.runId, truncated: false, status: "completed" });

            // The widest form: a list receive with a 60 KiB carry around a 180 KiB output still fits the next state's input.
            const wrapped = await start("parent-wrapped");
            const wrappedEnd = await h.waitForRunStatus(wrapped.runId, ["completed", "failed"]);
            expect(wrappedEnd.status, JSON.stringify(wrappedEnd.terminalError)).toBe("completed");
            const wrappedChild = await onlyChild(wrapped.workflowId);
            expect(wrappedEnd.terminalOutput).toEqual({ pad: 60 * 1024, child: true, contract: WORKFLOW_ENDED_CONTRACT,
                length: 180 * 1024, truncated: false, runId: wrappedChild.runId });

            // A 240 KiB output does not fit: outputTruncated with the run id, and the script reads it whole.
            const big = await start("parent-read");
            const bigEnd = await h.waitForRunStatus(big.runId, ["completed", "failed"]);
            expect(bigEnd.status, JSON.stringify(bigEnd.terminalError)).toBe("completed");
            const bigChild = await onlyChild(big.workflowId);
            expect(bigEnd.terminalOutput).toEqual({ truncated: true, hasOutput: false, runId: bigChild.runId, readRunId: bigChild.runId,
                length: 240 * 1024, previewLength: 2_001 });

            // A cleaned-up child: read through the outcome kept with its parent, whole with full_output, a preview without.
            await h.catalog.softDeleteSession(bigChild.workflowSessionId);
            const cleaned = JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: bigChild.workflowSessionId, full_output: true },
                { callerWorkflowSessionId: big.workflowId, host: h.host }));
            expect(cleaned.ok, JSON.stringify(cleaned.error)).toBe(true);
            expect(cleaned.deleted).toBe(true);
            expect(cleaned.run).toMatchObject({ runId: bigChild.runId, status: "completed", outcome: "succeeded" });
            expect(JSON.parse(cleaned.run.output).blob.length).toBe(240 * 1024);
            const cleanedPreview = JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: bigChild.workflowSessionId },
                { callerWorkflowSessionId: big.workflowId, host: h.host }));
            expect(cleanedPreview.ok, JSON.stringify(cleanedPreview.error)).toBe(true);
            expect(cleanedPreview.run.output.length).toBe(2_001);
            // Another Workflow may not read it, kept or not.
            const foreign = JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: bigChild.workflowSessionId, full_output: true },
                { callerWorkflowSessionId: whole.workflowId, host: h.host }));
            expect([foreign.ok, foreign.error?.code]).toEqual([false, "WORKFLOW_NOT_FOUND"]);

            // A notice of the older shape (no runId) still works for a receiving state.
            const legacy = await start("parent-legacy");
            const sender = randomUUID();
            await h.catalog.createSession(sender, { owner: OWNER });
            const payloadText = canonicalJson({ workflowId: sender, definition: "old-child", revision: 1, spawnedBy: null, status: "completed",
                outcome: "succeeded", stateId: "done", output: { summary: "older notice" }, outputTruncated: false, error: null });
            await h.waitForRunStatus(legacy.runId, ["running"]);
            await h.store.acceptInput({
                workflowSessionId: legacy.workflowId, runId: legacy.runId, messageId: randomUUID(), senderSessionId: sender, operationId: "older-notice",
                requestSha256: typedInputRequestSha256({ runId: legacy.runId, contract: WORKFLOW_ENDED_CONTRACT, correlationText: "{}", payloadText,
                    ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS }),
                contract: WORKFLOW_ENDED_CONTRACT, correlationText: "{}", payloadText, ttlSeconds: WORKFLOW_INPUT_TTL_SECONDS, limits: WORKFLOW_INBOX_LIMITS,
            });
            const run = await h.store.readRun(legacy.runId);
            await h.client.enqueueEvent(run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE, JSON.stringify({ type: "workflow-wake", runId: legacy.runId, reason: "input" }));
            const legacyEnd = await h.waitForRunStatus(legacy.runId, ["completed", "failed"]);
            expect(legacyEnd.status, JSON.stringify(legacyEnd.terminalError)).toBe("completed");
            expect(legacyEnd.terminalOutput).toEqual({ workflowId: sender, status: "completed", summary: "older notice", runId: null });
        } finally {
            await h.stop();
        }
    });
});
