/**
 * I6: a child Workflow's whole result reaches its Workflow parent (real Duroxide runtime + PostgreSQL):
 * - a 100 KiB child output reaches the parent's next state whole, with the child's runId in the WorkflowEnded@1 notice;
 * - the notice limit is measured on the form the receiving state gets: a 180 KiB output through a list receive with a 60 KiB
 *   carry still reaches the next state whole (no invalid_input);
 * - an output that still does not fit (escape-heavy, ~240 KiB canonical) arrives as outputTruncated: true with the runId, and a
 *   script reads the whole output with child_workflows read full_output, within its 1 MiB tool result;
 * - after the test cleans that child up, the next script reads it whole again through the outcome kept with its parent, and the
 *   preview read carries no whole copy;
 * - a JSON null output reads as the text "null", live and kept; a run with no stored output reads null;
 * - a notice of the older shape (no runId) still works for a receiving state;
 * - later limits still apply to a whole output: a fan-out of two 150 KiB children whose branches end with the notice as it
 *   arrived fails at the join (invalid_output, 256 KiB), a 20 KiB child output sent on as it arrived fails the send
 *   (invalid_input, 16 KiB), and the same fan-out keeping only what it needs from each child joins.
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
import { sendTypedWorkflowInput } from "../../src/workflow/service.ts";
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
        q: async (sql, params = []) => (await pool.query(sql.replaceAll("SCHEMA", `"${cmsSchema}"`), params)).rows,
        waitForPendingState: async (runId, stateId, timeoutMs = 60_000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const { rows } = await pool.query(`SELECT 1 FROM "${cmsSchema}".workflow_node_executions WHERE run_id = $1 AND node_id = $2 AND state = 'pending'`,
                    [runId, stateId]);
                if (rows.length) return;
                const run = await store.readRun(runId);
                if (run && !["admitted", "running", "paused"].includes(run.status)) {
                    throw new Error(`Run ${runId} ended ${run.status} before reaching ${stateId}: ${JSON.stringify(run.terminalError)} ${JSON.stringify(run.terminalOutput)}`);
                }
                await new Promise(r => setTimeout(r, 100));
            }
            throw new Error(`Timed out waiting for state ${stateId} of run ${runId}`);
        },
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
  schema:
    type: object
    required: [kib]
    properties: { kib: { type: integer }, char: { type: string }, nothing: { type: boolean } }
    additionalProperties: false
initialInput: "\${inputs}"
initial: make
states:
  make:
    type: script
    outcomes: [ok]
    source: |
      const { kib, char, nothing } = context.input;
      if (nothing === true) {
        await setResult("ok", null);
      } else {
        await setResult("ok", { blob: (char ?? "x").repeat(kib * 1024) });
      }
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

/**
 * A child whose output does not fit the notice: 120 Ki double quotes, about 240 KiB of canonical JSON and about 480 KiB once
 * returned as JSON text (every quote escaped again). The next script reads it whole with child_workflows read, then, after the
 * test cleans the child up, reads it again through the kept outcome: each answer must stay within a script's 1 MiB tool result.
 */
const PARENT_READ_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-read, version: "1.0.0" }
contracts:
  Go@1: { schema: { type: object } }
initial: spawn_big
states:
  spawn_big:
    type: spawn
    definition: big-child
    inputs: { kib: 120, char: '"' }
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    from: "\${states.spawn_big.output.workflowId}"
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
      await setResult("ok", { childId: ended.workflowId, truncated: ended.outputTruncated, hasOutput: Object.hasOwn(ended, "output"),
        runId: ended.runId, readRunId: read.run.runId, length: whole.blob.length, quotes: /^"+$/.test(whole.blob),
        previewLength: preview.run.output.length });
    transition: { next: { ok: hold, failure: failed } }
  hold:
    type: messaging
    mode: receive
    contract: Go@1
    carry: { live: "\${input}" }
    wait: { seconds: 120 }
    transition: { next: { received: fetch_kept, elapsed: failed, failure: failed } }
  fetch_kept:
    type: script
    outcomes: [ok]
    source: |
      const live = context.input.carry.live;
      const full = await callTool("child_workflows", { operation: "read", workflow_id: live.childId, full_output: true });
      const preview = await callTool("child_workflows", { operation: "read", workflow_id: live.childId });
      await setResult("ok", { live, kept: { deleted: full.deleted === true, runId: full.run.runId, length: JSON.parse(full.run.output).blob.length,
        previewDeleted: preview.deleted === true, previewLength: preview.run.output.length,
        previewHasWholeCopy: Object.hasOwn(preview, "retainedOutcome") } });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

/** A child whose output is JSON null: the notice carries null, and the whole read is the text "null". */
const PARENT_NULL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-null, version: "1.0.0" }
initial: spawn_null
states:
  spawn_null:
    type: spawn
    definition: big-child
    inputs: { kib: 0, nothing: true }
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    from: "\${states.spawn_null.output.workflowId}"
    wait: { seconds: 60 }
    transition: { next: { received: check, elapsed: failed, failure: failed } }
  check:
    type: script
    outcomes: [ok]
    source: |
      const ended = context.input;
      const read = await callTool("child_workflows", { operation: "read", workflow_id: ended.workflowId, full_output: true });
      await setResult("ok", { childId: ended.workflowId, hasOutput: Object.hasOwn(ended, "output"), output: ended.output, full: read.run.output });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

/**
 * Downstream limits still apply to a whole child output (owner decision i6-downstream): two children of about 150 KiB each,
 * each branch ending with the notice as it arrived, join to about 300 KiB, past the joined output's 256 KiB.
 */
const fanOutYaml = (name, branchOutput) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    forEach: [150, 150]
    concurrency: 2
    body:
      initial: launch
      states:
        launch:
          type: spawn
          definition: big-child
          inputs: { kib: "\${branch.item}" }
          transition: { next: { started: collect, failure: branch_failed } }
        collect:
          type: messaging
          mode: receive
          contract: WorkflowEnded@1
          from: "\${states.launch.output.workflowId}"
          wait: { seconds: 60 }
          transition: { next: { received: branch_done, elapsed: branch_failed, failure: branch_failed } }
        branch_done: { type: terminal, outcome: succeeded, output: ${branchOutput} }
        branch_failed: { type: terminal, outcome: failed }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;
const PARENT_JOIN_WHOLE_YAML = fanOutYaml("parent-join-whole", '"${input}"');
/** The same fan-out, each branch keeping only what it needs: it joins. */
const PARENT_JOIN_MAPPED_YAML = fanOutYaml("parent-join-mapped", '{ outcome: "${input.outcome}", truncated: "${input.outputTruncated}" }');

/** A 20 KiB child output forwarded with send as it arrived: past a message's 16 KiB. */
const PARENT_SEND_WHOLE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-send-whole, version: "1.0.0" }
contracts:
  ChildDone@1: { schema: { type: object } }
initial: spawn_big
states:
  spawn_big:
    type: spawn
    definition: big-child
    inputs: { kib: 20 }
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    from: "\${states.spawn_big.output.workflowId}"
    wait: { seconds: 60 }
    transition: { next: { received: tell, elapsed: failed, failure: failed } }
  tell:
    type: messaging
    mode: send
    contract: ChildDone@1
    recipient: { parent: true }
    transition: { next: { sent: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
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
                ["parent-read", PARENT_READ_YAML], ["parent-null", PARENT_NULL_YAML], ["parent-legacy", PARENT_LEGACY_YAML]]) {
                const saved = await saveSessionWorkflowDefinition(h.host, {
                    ownerSessionId: chat, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: chat }, operationId: `save-${name}`, by: "session",
                });
                expect(saved.receipt.valid, `${name}: ${JSON.stringify(saved.receipt.diagnostics)}`).toBe(true);
            }
            const start = (name, operationId = `start-${name}`) => startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name }, inputs: {}, actor: ENGINE, operationId, owner: OWNER,
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

            // An output that does not fit (escape-heavy, ~240 KiB canonical): outputTruncated with the run id; the script reads it
            // whole, then the test cleans the child up and the next script reads it whole again through the kept outcome.
            const big = await start("parent-read");
            await h.waitForPendingState(big.runId, "hold");
            const bigChild = await onlyChild(big.workflowId);
            await h.catalog.softDeleteSession(bigChild.workflowSessionId);
            await sendTypedWorkflowInput(h.host, { workflowSessionId: big.workflowId, senderSessionId: chat, contract: "Go@1", payload: {},
                operationId: "go-after-cleanup" });
            const bigEnd = await h.waitForRunStatus(big.runId, ["completed", "failed"]);
            expect(bigEnd.status, JSON.stringify(bigEnd.terminalError)).toBe("completed");
            expect(bigEnd.terminalOutput).toEqual({
                live: { childId: bigChild.workflowSessionId, truncated: true, hasOutput: false, runId: bigChild.runId, readRunId: bigChild.runId,
                    length: 120 * 1024, quotes: true, previewLength: 2_001 },
                kept: { deleted: true, runId: bigChild.runId, length: 120 * 1024, previewDeleted: true, previewLength: 2_001, previewHasWholeCopy: false },
            });
            // Another Workflow may not read it, kept or not.
            const foreign = JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: bigChild.workflowSessionId, full_output: true },
                { callerWorkflowSessionId: whole.workflowId, host: h.host }));
            expect([foreign.ok, foreign.error?.code]).toEqual([false, "WORKFLOW_NOT_FOUND"]);

            // JSON null stays the text "null" in a whole read, live and after cleanup; a run with no stored output reads null.
            const nul = await start("parent-null");
            const nulEnd = await h.waitForRunStatus(nul.runId, ["completed", "failed"]);
            expect(nulEnd.status, JSON.stringify(nulEnd.terminalError)).toBe("completed");
            const nulChild = await onlyChild(nul.workflowId);
            expect(nulEnd.terminalOutput).toEqual({ childId: nulChild.workflowSessionId, hasOutput: true, output: null, full: "null" });
            const readNull = async () => JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: nulChild.workflowSessionId, full_output: true },
                { callerWorkflowSessionId: nul.workflowId, host: h.host }));
            await h.catalog.softDeleteSession(nulChild.workflowSessionId);
            expect((await readNull()).run.output, "JSON null after cleanup").toBe("null");
            const none = await start("parent-whole", "start-parent-whole-none");
            await h.waitForRunStatus(none.runId, ["completed", "failed"]);
            const noneChild = await onlyChild(none.workflowId);
            await h.q("UPDATE SCHEMA.workflow_runs SET terminal_output = NULL WHERE run_id = $1", [noneChild.runId]);
            const readNone = async () => JSON.parse(await childWorkflowsFromTool({ operation: "read", workflow_id: noneChild.workflowSessionId, full_output: true },
                { callerWorkflowSessionId: none.workflowId, host: h.host }));
            expect((await readNone()).run.output, "no output, live").toBeNull();
            await h.q("SELECT SCHEMA.workflow_record_terminal_outcome($1)", [noneChild.runId]);
            await h.catalog.softDeleteSession(noneChild.workflowSessionId);
            expect((await readNone()).run.output, "no output, after cleanup").toBeNull();

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

    it("a whole child output still meets the limits after the receive: a join and a send fail clearly; a mapped fan-out joins", { timeout: TIMEOUT }, async () => {
        const h = await startHarness(getEnv());
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            for (const [name, yaml] of [["big-child", BIG_CHILD_YAML], ["parent-join-whole", PARENT_JOIN_WHOLE_YAML],
                ["parent-join-mapped", PARENT_JOIN_MAPPED_YAML], ["parent-send-whole", PARENT_SEND_WHOLE_YAML]]) {
                const saved = await saveSessionWorkflowDefinition(h.host, {
                    ownerSessionId: chat, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: chat }, operationId: `save-${name}`, by: "session",
                });
                expect(saved.receipt.valid, `${name}: ${JSON.stringify(saved.receipt.diagnostics)}`).toBe(true);
            }
            const start = (name) => startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name }, inputs: {}, actor: ENGINE, operationId: `start-${name}`, owner: OWNER,
            });
            const endOf = async (name) => h.waitForRunStatus((await start(name)).runId, ["completed", "failed"], 120_000);

            // Two 150 KiB children, each branch ending with the notice as it arrived: each branch fits, the join does not.
            const joinWhole = await endOf("parent-join-whole");
            expect(joinWhole.terminalOutput?.code, JSON.stringify(joinWhole.terminalOutput)).toBe("invalid_output");
            expect(joinWhole.terminalOutput.message).toMatch(/The joined output is \d+ bytes; the limit is 262144\./);

            // A 20 KiB child output forwarded as it arrived: a message is at most 16 KiB.
            const sendWhole = await endOf("parent-send-whole");
            expect(sendWhole.terminalOutput?.code, JSON.stringify(sendWhole.terminalOutput)).toBe("invalid_input");
            expect(sendWhole.terminalOutput.message).toMatch(/The message of state 'tell' is \d+ bytes; the limit is 16384\./);

            // The same fan-out keeping only what each branch needs: whole outputs arrived, and the join passes.
            const joinMapped = await endOf("parent-join-mapped");
            expect(joinMapped.status, JSON.stringify(joinMapped.terminalError)).toBe("completed");
            expect(joinMapped.terminalOutput).toEqual([{ outcome: "succeeded", truncated: false }, { outcome: "succeeded", truncated: false }]);
        } finally {
            await h.stop();
        }
    });
});
