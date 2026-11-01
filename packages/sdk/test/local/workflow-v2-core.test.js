/**
 * Workflow v2 core: compiler, canonical values, the PostgreSQL store and the
 * durable controller on a real worker (PostgreSQL CMS + duroxide, real script
 * processes). No model is involved.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, parseStoredJson, sha256Hex } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2, dispatchWorkflowV2Run, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_STORE_RETRY, workflowEffectInstanceId } from "../../src/workflow/v2/runtime.ts";
import { runScriptNode } from "../../src/workflow/runner.ts";
import { schemaSetFor } from "../../src/workflow/v2/schema.ts";

const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "system", name: "workflow-v2-core-test" };
const TIMEOUT = 120_000;

const PIPELINE = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: pipeline, version: "1.0.0" }
inputs:
  schema: { $ref: "#/schemas/In" }
schemas:
  In:
    type: object
    required: [text]
    properties: { text: { type: string } }
  Mid:
    type: object
    required: [text, n]
    properties: { text: { type: string }, n: { type: integer } }
initialInput: { text: "\${inputs.text}" }
initial: first
states:
  first:
    type: script
    outputSchema: { $ref: "#/schemas/Mid" }
    source: |
      await setResult("ok", { text: context.input.text, n: 1 });
    transition: { next: { ok: second, failure: broken } }
  second:
    type: script
    input: { text: "\${input.text}", n: "\${input.n}" }
    inputSchema: { $ref: "#/schemas/Mid" }
    source: |
      await setResult("ok", { text: context.input.text, n: context.input.n + 1, seen: context.nodeExecutionId.startsWith("nx-") });
    transition: { next: { ok: done, failure: broken } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  broken: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

/** Root contract: integer. The succeeded terminal adds its own schema and emits `output`. */
const CONTRACT = (output, localSchema) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: contract, version: "1.0.0" }
outputSchema: { type: integer }
initial: first
states:
  first:
    type: script
    source: |
      await setResult("ok", {});
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: ${output}, outputSchema: ${localSchema} }
`;

const NULL_INPUTS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: null-inputs, version: "1.0.0" }
inputs: { schema: { type: "null" } }
initial: first
states:
  first:
    type: script
    source: |
      await setResult("ok", { inputs: context.inputs });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const LOOP = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: loop, version: "1.0.0" }
initialInput: { n: 0 }
initial: step
states:
  step:
    type: script
    source: |
      const n = context.input.n + 1;
      await setResult(n < 30 ? "again" : "enough", { n });
    transition: { next: { again: step, enough: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

function host(client) {
    return { catalog: client._catalog, store: client._catalog.workflowStore(), duroxideClient: client.duroxideClient };
}

async function until(check, label, timeoutMs = 60_000, diagnose = async () => null) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}; diagnosis: ${JSON.stringify(await diagnose())}`);
}

/** The run's controller orchestration status: a stalled run names its runtime cause. */
async function controllerStatus(h, runId) {
    const run = await h.store.readRun(runId);
    if (!run) return { run: null };
    const status = await h.duroxideClient.getStatus(run.controllerInstanceId);
    return { runStatus: run.status, orchestration: { status: status.status, error: status.error ?? null, customStatus: status.customStatus ?? null } };
}

async function finishedRun(h, runId) {
    return until(async () => {
        const run = await h.store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, 60_000, () => controllerStatus(h, runId));
}

async function events(client, sessionId) {
    return client._catalog.getSessionEvents(sessionId, 0, 1000);
}

function count(list, type) {
    return list.filter(event => event.eventType === type).length;
}

async function expectCode(promise, code) {
    let caught;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

describe("workflow v2 compiler and values", () => {
    it("schedules store activities with a retry policy duroxide-node accepts", () => {
        // duroxide-node reads backoff as a strategy name; a number fails the orchestration.
        expect(["undefined", "string"]).toContain(typeof WORKFLOW_V2_STORE_RETRY.backoff);
        expect(WORKFLOW_V2_STORE_RETRY.maxAttempts).toBeGreaterThan(1);
    });

    it("compiles a valid definition to a stable IR hash that changes with the source", () => {
        const a = compileWorkflowV2(PIPELINE);
        const b = compileWorkflowV2(PIPELINE);
        expect(a.valid, JSON.stringify(a.diagnostics)).toBe(true);
        expect(a.irSha256).toBe(b.irSha256);
        expect(a.yamlSha256).toBe(sha256Hex(PIPELINE));
        expect(a.ir.nodes.first.outcomes).toEqual(["ok"]);
        const changed = compileWorkflowV2(PIPELINE.replace("n: 1 }", "n: 2 }"));
        expect(changed.valid).toBe(true);
        expect(changed.irSha256).not.toBe(a.irSha256);
    });

    it("reports field-level diagnostics and produces no IR for invalid documents", () => {
        const cases = [
            [PIPELINE.replace("ok: second,", "ok: nowhere,"), "WORKFLOW_TARGET_UNKNOWN"],
            [PIPELINE.replace('$ref: "#/schemas/In"', '$ref: "https://example.invalid/in.json"'), "WORKFLOW_SCHEMA_INVALID"],
            [PIPELINE.replace("type: script\n    outputSchema", "type: agent\n    outputSchema"), "WORKFLOW_NODE_TYPE_UNSUPPORTED"],
            [PIPELINE.replace('version: "1.0.0"', "version: 1.0"), "WORKFLOW_SEMVER_INVALID"],
            [PIPELINE.replace("initial: first", "initial: first\ninitial: second"), "WORKFLOW_YAML_INVALID"],
            [LOOP.replace("enough: done", "enough: step"), "WORKFLOW_NO_TERMINAL_PATH"],
        ];
        for (const [yaml, code] of cases) {
            const result = compileWorkflowV2(yaml);
            expect(result.valid, code).toBe(false);
            expect(result.ir).toBeNull();
            expect(result.diagnostics.map(item => item.code), JSON.stringify(result.diagnostics)).toContain(code);
        }
    });

    it("rejects an explicit null schema on every schema field and keeps boolean schemas", () => {
        const nullCases = [
            ["inputs.schema", PIPELINE.replace('inputs:\n  schema: { $ref: "#/schemas/In" }', "inputs:\n  schema: null")],
            ["outputSchema", PIPELINE.replace("initial: first", "outputSchema: null\ninitial: first")],
            ["states.first.outputSchema", PIPELINE.replace('outputSchema: { $ref: "#/schemas/Mid" }', "outputSchema: null")],
            ["states.second.inputSchema", PIPELINE.replace('inputSchema: { $ref: "#/schemas/Mid" }', "inputSchema: null")],
            ["states.done.outputSchema", PIPELINE.replace('done: { type: terminal, outcome: succeeded, output: "\${input}" }',
                'done: { type: terminal, outcome: succeeded, output: "\${input}", outputSchema: null }')],
        ];
        for (const [path, yaml] of nullCases) {
            expect(yaml, path).not.toBe(PIPELINE);
            const result = compileWorkflowV2(yaml);
            expect(result.valid, path).toBe(false);
            expect(result.diagnostics, path).toContainEqual(expect.objectContaining({ code: "WORKFLOW_SCHEMA_INVALID", path }));
        }
        const accept = compileWorkflowV2(PIPELINE.replace('inputs:\n  schema: { $ref: "#/schemas/In" }', "inputs:\n  schema: true"));
        const reject = compileWorkflowV2(PIPELINE.replace('inputs:\n  schema: { $ref: "#/schemas/In" }', "inputs:\n  schema: false"));
        expect(accept.valid && reject.valid, JSON.stringify([accept.diagnostics, reject.diagnostics])).toBe(true);
        expect(schemaSetFor(accept.irSha256, accept.ir.schemaDefs).validate(accept.ir.inputsSchema, { anything: 1 })).toEqual([]);
        expect(schemaSetFor(reject.irSha256, reject.ir.schemaDefs).validate(reject.ir.inputsSchema, {})).not.toEqual([]);
    });

    it("keeps the workflow output contract beside a terminal's own schema", () => {
        const result = compileWorkflowV2(CONTRACT("wrong", "{ type: string }"));
        expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
        expect(result.ir.outputSchema).toBe("workflow.output");
        expect(result.ir.nodes.done.outputSchema).toBe("node.done.output");
    });

    it("stores escaped NUL and lone surrogates exactly and sorts keys", () => {
        const value = { z: "a\u0000b\ud800c", a: [null, 1.5, true, { y: "\udc01" }] };
        const text = canonicalJson(value);
        expect(text.startsWith('{"a":')).toBe(true);
        expect(text.includes("\u0000")).toBe(false);
        expect(parseStoredJson(text)).toEqual(value);
        for (const bad of [undefined, Number.NaN, new Date(0), { nested: () => 1 }]) {
            expect(() => canonicalJson(bad)).toThrow();
        }
    });
});

function scriptNode(source) {
    return { id: "probe", type: "script", runtime: "node", source, timeoutSeconds: 30, outcomes: ["ok"], next: { ok: "done" } };
}

function runProbe(source, strictJson) {
    return runScriptNode({
        sessionId: "strict-json-probe", workflowName: "probe", node: scriptNode(source), inputs: {}, priorOutput: null, step: 1,
        callTool: async () => { throw new Error("These probes call no tools."); },
        guardedNode: true, strictJson,
    });
}

describe("workflow v2 script results are plain JSON before any serialization", () => {
    const rejected = [
        ["NaN", 'await setResult("ok", { n: NaN });', "numbers must be finite"],
        ["Infinity", 'await setResult("ok", { n: Infinity });', "numbers must be finite"],
        ["undefined", 'await setResult("ok", { a: undefined });', "undefined is not a JSON value"],
        ["toJSON on a class", 'await setResult("ok", { d: new Date(0) });', "only plain objects are JSON (got Date)"],
        ["own toJSON function", 'await setResult("ok", { toJSON() { return 1; } });', "function is not a JSON value"],
        ["tool arguments", 'await callTool("x", { n: NaN });', "numbers must be finite"],
    ];
    for (const [label, source, message] of rejected) {
        it(`rejects ${label} in the script before it is sent`, { timeout: 60_000 }, async () => {
            const result = await runProbe(source, true);
            expect(result.resultSource, JSON.stringify(result)).toBe("exit");
            expect(result.exitCode).not.toBe(0);
            expect(result.stderrTail).toContain(message);
        });
    }

    it("rejects a non-finite number posted directly to the endpoint (1e400 parses to Infinity)", { timeout: 60_000 }, async () => {
        const result = await runProbe(`
const response = await fetch(process.env.PILOTSWARM_WORKFLOW_ENDPOINT + "/result", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.PILOTSWARM_WORKFLOW_TOKEN },
    body: '{"outcome":"ok","output":1e400}',
});
await setResult("ok", { status: response.status, body: await response.json() });`, true);
        expect(result.resultSource, JSON.stringify(result)).toBe("reported");
        expect(result.output).toEqual({ status: 400, body: { ok: false, error: "output: numbers must be finite" } });
    });

    it("does not take a result from stdout or the exit code", { timeout: 60_000 }, async () => {
        const result = await runProbe('console.log(\'{"outcome":"ok","output":1e400}\');', true);
        expect(result).toMatchObject({ resultSource: "none", exitCode: 0, output: null });
    });

    it("keeps escaped NUL, lone surrogates and plain values exact", { timeout: 60_000 }, async () => {
        const result = await runProbe('await setResult("ok", { s: "a\\u0000b\\ud800c", n: 1.5, nested: [null, true, { k: "v" }] });', true);
        expect(result.resultSource, JSON.stringify(result)).toBe("reported");
        expect(result.output).toEqual({ s: "a\u0000b\ud800c", n: 1.5, nested: [null, true, { k: "v" }] });
    });

    it("leaves the legacy runner's conversions unchanged when strict JSON is off", { timeout: 60_000 }, async () => {
        const reported = await runProbe('await setResult("ok", { n: NaN, a: undefined, d: new Date(0) });', false);
        expect(reported.output).toEqual({ n: null, d: "1970-01-01T00:00:00.000Z" });
        const stdout = await runProbe('console.log(\'{"outcome":"ok","output":1e400}\');', false);
        expect(stdout).toMatchObject({ resultSource: "stdout", outcome: "ok", output: null });
    });
});

describe("workflow v2 store and controller on PostgreSQL", () => {
    it("keeps drafts non-executing, revisioned, idempotent and immutable once published", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const id = randomUUID();
            const invalid = PIPELINE.replace("ok: second,", "ok: nowhere,");
            const created = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: invalid, actor: ACTOR, operationId: "create-1" });
            expect(created.receipt).toMatchObject({ state: "draft", revision: 1, valid: false, run: null });
            await expectCode(updateWorkflowV2(h, id, { operation: "publish", expectedRevision: 1, definitionHash: created.receipt.yamlSha256 },
                { actor: ACTOR, operationId: "publish-invalid" }), "DEFINITION_INVALID");

            const replaced = await updateWorkflowV2(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 1 }, { actor: ACTOR, operationId: "edit-2" });
            expect(replaced.receipt).toMatchObject({ revision: 2, valid: true, state: "draft" });
            const replay = await updateWorkflowV2(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 1 }, { actor: ACTOR, operationId: "edit-2" });
            expect(replay.replayed).toBe(true);
            expect(replay.receipt).toEqual(replaced.receipt);
            await expectCode(updateWorkflowV2(h, id, { operation: "replace_definition", yaml: LOOP.replace("name: loop", "name: pipeline"), expectedRevision: 1 },
                { actor: ACTOR, operationId: "edit-2" }), "OPERATION_CONFLICT");
            await expectCode(updateWorkflowV2(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 1 },
                { actor: ACTOR, operationId: "edit-stale" }), "REVISION_CONFLICT");
            await expectCode(updateWorkflowV2(h, id, { operation: "replace_definition", yaml: PIPELINE.replace('"1.0.0"', '"2.0.0"'), expectedRevision: 2 },
                { actor: ACTOR, operationId: "edit-semver" }), "SEMVER_IMMUTABLE");
            await expectCode(updateWorkflowV2(h, id, { operation: "publish", expectedRevision: 2, definitionHash: created.receipt.yamlSha256 },
                { actor: ACTOR, operationId: "publish-wrong-hash" }), "DEFINITION_HASH_MISMATCH");

            const published = await updateWorkflowV2(h, id, { operation: "publish", expectedRevision: 2, definitionHash: replaced.receipt.yamlSha256 },
                { actor: ACTOR, operationId: "publish-2" });
            expect(published.receipt).toMatchObject({ state: "published", publishedRevision: 2, run: null });
            await expectCode(updateWorkflowV2(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 2 },
                { actor: ACTOR, operationId: "edit-after-publish" }), "DEFINITION_IMMUTABLE");
            expect(await h.store.listRuns(id)).toEqual([]);
            const session = await client._catalog.getSession(id);
            expect(session.sessionKind).toBe("workflow");
            expect(session.orchestrationId ?? null).toBeNull();

            // Text PostgreSQL would reject or rewrite never reaches the store.
            await expectCode(createWorkflowV2(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml: PIPELINE + "#\u0000",
                actor: ACTOR, operationId: "nul" }), "WORKFLOW_YAML_INVALID");
            await expectCode(createWorkflowV2(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml: PIPELINE,
                actor: ACTOR, operationId: "op-\ud800" }), "WORKFLOW_COMMAND_INVALID");
        });
    });

    it("lets exactly one of two concurrent edits of the same revision win", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), async (client) => {
            const h = host(client);
            const id = randomUUID();
            await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: PIPELINE, actor: ACTOR, operationId: "create" });
            const results = await Promise.allSettled(["a", "b"].map(op => updateWorkflowV2(h, id,
                { operation: "replace_definition", yaml: PIPELINE.replace("n: 1 }", `n: 1, op: "${op}" }`), expectedRevision: 1 },
                { actor: ACTOR, operationId: `edit-${op}` })));
            expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
            const rejected = results.find(result => result.status === "rejected");
            expect(rejected.reason.code).toBe("REVISION_CONFLICT");
            expect((await h.store.readDefinition(id)).currentRevision).toBe(2);
        });
    });

    it("runs a published definition durably with typed values, exact output and exactly-once events", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const id = randomUUID();
            const inputs = { text: "a\u0000b\ud800c" };
            const started = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: PIPELINE, actor: ACTOR,
                operationId: "create-start", start: { inputs } });
            const runId = started.receipt.run.runId;
            const run = await finishedRun(h, runId);
            expect(run.status, JSON.stringify(run.terminalError)).toBe("completed");
            expect(run.terminalOutcome).toBe("succeeded");
            expect(run.terminalOutput).toEqual({ text: inputs.text, n: 2, seen: true });

            const nodes = await h.store.listNodeExecutions(runId);
            expect(nodes.map(node => [node.nodeId, node.ordinal, node.state, node.outcome])).toEqual([
                ["first", 1, "completed", "ok"], ["second", 1, "completed", "ok"], ["done", 1, "completed", "succeeded"],
            ]);
            expect(nodes[1].predecessorId).toBe(nodes[0].nodeExecutionId);
            expect(nodes[1].input).toEqual({ text: inputs.text, n: 1 });

            const replay = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: PIPELINE, actor: ACTOR,
                operationId: "create-start", start: { inputs } });
            expect(replay.replayed).toBe(true);
            expect(replay.receipt.run.runId).toBe(runId);
            await dispatchWorkflowV2Run(h, replay.receipt);
            await expectCode(updateWorkflowV2(h, id, { operation: "start", definitionHash: started.receipt.yamlSha256, inputs },
                { actor: ACTOR, operationId: "second-live-start" }), "LIVE_RUN_EXISTS");
            expect(await h.store.listRuns(id)).toHaveLength(1);

            const log = await events(client, id);
            expect(count(log, "workflow.started")).toBe(1);
            expect(count(log, "workflow.state_started")).toBe(3);
            expect(count(log, "workflow.state_completed")).toBe(2);
            expect(count(log, "workflow.completed")).toBe(1);
            const session = await client._catalog.getSession(id);
            expect(session.state).toBe("completed");
            const status = await client.duroxideClient.waitForOrchestration(started.receipt.run.controllerInstanceId, 30_000);
            expect(status.status, JSON.stringify(status)).toBe("Completed");
        });
    });

    it("carries the exact controller state across continue-as-new", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const id = randomUUID();
            const started = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: LOOP, actor: ACTOR,
                operationId: "loop", start: { inputs: {} } });
            const run = await finishedRun(h, started.receipt.run.runId);
            expect(run.status, JSON.stringify(run.terminalError)).toBe("completed");
            expect(run.terminalOutput).toEqual({ n: 30 });
            const nodes = await h.store.listNodeExecutions(run.runId);
            const steps = nodes.filter(node => node.nodeId === "step");
            expect(steps.map(node => node.ordinal)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
            expect(new Set(steps.map(node => node.nodeExecutionId)).size).toBe(30);
            for (let index = 1; index < steps.length; index += 1) expect(steps[index].predecessorId).toBe(steps[index - 1].nodeExecutionId);
            expect(nodes.filter(node => node.nodeId === "done")).toHaveLength(1);
            expect(count(await events(client, id), "workflow.completed")).toBe(1);
        });
    });

    it("routes a runtime error through its catch and fails an unhandled one with the stored cause", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const caught = randomUUID();
            const throwing = PIPELINE.replace('await setResult("ok", { text: context.input.text, n: 1 });', 'throw new Error("boom");');
            const first = await createWorkflowV2(h, { workflowSessionId: caught, parentSessionId: null, yaml: throwing, actor: ACTOR,
                operationId: "caught", start: { inputs: { text: "x" } } });
            const blocked = await finishedRun(h, first.receipt.run.runId);
            expect(blocked.status).toBe("completed");
            expect(blocked.terminalOutcome).toBe("blocked");
            expect(blocked.terminalOutput).toMatchObject({ code: "execution_failed" });

            const unhandled = randomUUID();
            const undeclared = LOOP.replace('n < 30 ? "again" : "enough"', '"surprise"');
            const second = await createWorkflowV2(h, { workflowSessionId: unhandled, parentSessionId: null, yaml: undeclared, actor: ACTOR,
                operationId: "unhandled", start: { inputs: {} } });
            const failed = await finishedRun(h, second.receipt.run.runId);
            expect(failed.status).toBe("failed");
            expect(failed.terminalError).toMatchObject({ code: "invalid_output" });
            expect((await client._catalog.getSession(unhandled)).state).toBe("failed");
        });
    });

    it("fails a succeeded terminal whose output breaks the workflow contract, even when its own schema allows it", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const weakened = await createWorkflowV2(h, { workflowSessionId: randomUUID(), parentSessionId: null,
                yaml: CONTRACT("wrong", "{ type: string }"), actor: ACTOR, operationId: "weakened", start: { inputs: {} } });
            const failed = await finishedRun(h, weakened.receipt.run.runId);
            expect(failed.status).toBe("failed");
            expect(failed.terminalError).toMatchObject({ code: "invalid_output" });
            expect(JSON.stringify(failed.terminalError.details)).toContain("workflow.output");

            const control = await createWorkflowV2(h, { workflowSessionId: randomUUID(), parentSessionId: null,
                yaml: CONTRACT("7", "{ type: integer, minimum: 0 }"), actor: ACTOR, operationId: "control", start: { inputs: {} } });
            const completed = await finishedRun(h, control.receipt.run.runId);
            expect(completed.status, JSON.stringify(completed.terminalError)).toBe("completed");
            expect(completed.terminalOutput).toBe(7);
        });
    });

    it("starts a run for publish_and_start with null inputs instead of only publishing", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const id = randomUUID();
            const draft = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: NULL_INPUTS, actor: ACTOR, operationId: "draft" });
            const started = await updateWorkflowV2(h, id, { operation: "publish_and_start", expectedRevision: 1,
                definitionHash: draft.receipt.yamlSha256, inputs: null }, { actor: ACTOR, operationId: "go" });
            expect(started.receipt).toMatchObject({ operation: "publish_and_start", state: "published" });
            expect(started.receipt.run?.mode).toBe("live");
            const run = await finishedRun(h, started.receipt.run.runId);
            expect(run.inputs).toBeNull();
            expect(run.status, JSON.stringify(run.terminalError)).toBe("completed");
            expect(run.terminalOutput).toEqual({ inputs: null });
            const replay = await updateWorkflowV2(h, id, { operation: "publish_and_start", expectedRevision: 1,
                definitionHash: draft.receipt.yamlSha256, inputs: null }, { actor: ACTOR, operationId: "go" });
            expect(replay.replayed).toBe(true);
            expect(replay.receipt.run.runId).toBe(started.receipt.run.runId);
            expect(await h.store.listRuns(id)).toHaveLength(1);
        });
    });

    it("keeps the title of the current revision across create and replace replays", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), async (client) => {
            const h = host(client);
            const id = randomUUID();
            const yamlA = PIPELINE.replace("name: pipeline", "name: title-a");
            const yamlB = PIPELINE.replace("name: pipeline", "name: title-b");
            await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: yamlA, actor: ACTOR, operationId: "create" });
            expect((await client._catalog.getSession(id)).title).toBe("Workflow: title-a");
            await updateWorkflowV2(h, id, { operation: "replace_definition", yaml: yamlB, expectedRevision: 1 }, { actor: ACTOR, operationId: "rename" });
            expect((await client._catalog.getSession(id)).title).toBe("Workflow: title-b");
            const replayedCreate = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: yamlA, actor: ACTOR, operationId: "create" });
            expect(replayedCreate.replayed).toBe(true);
            const replayedRename = await updateWorkflowV2(h, id, { operation: "replace_definition", yaml: yamlB, expectedRevision: 1 },
                { actor: ACTOR, operationId: "rename" });
            expect(replayedRename.replayed).toBe(true);
            expect((await client._catalog.getSession(id)).title).toBe("Workflow: title-b");
            expect((await h.store.readDefinition(id)).currentRevision).toBe(2);
        });
    });

    it("completes a state only from an accepted setResult: non-JSON or missing results become typed errors", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const cases = [
                ["stdout-1e400", 'console.log(\'{"outcome":"ok","output":1e400}\');', "invalid_output"],
                ["nan", 'await setResult("ok", { n: NaN });', "execution_failed"],
            ];
            for (const [name, source, code] of cases) {
                const yaml = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: probe
states:
  probe:
    type: script
    outputSchema: { type: [object, "null"] }
    source: |
      ${source}
    transition: { next: { ok: done, failure: caught } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  caught: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;
                const started = await createWorkflowV2(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml,
                    actor: ACTOR, operationId: name, start: { inputs: {} } });
                const run = await finishedRun(h, started.receipt.run.runId);
                expect(run.terminalOutcome, `${name}: ${JSON.stringify(run)}`).toBe("blocked");
                expect(run.terminalOutput.code).toBe(code);
                const [probe] = await h.store.listNodeExecutions(run.runId);
                expect(probe).toMatchObject({ nodeId: "probe", resultKind: "runtime_error", outcome: code, output: null });
            }
        });
    });

    it("cancels a running script node once: the stored winner is the cancellation, not a late result", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const id = randomUUID();
            const slow = LOOP.replace("const n = context.input.n + 1;", "await new Promise(resolve => setTimeout(resolve, 60_000)); const n = 30;");
            const started = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: slow, actor: ACTOR,
                operationId: "slow", start: { inputs: {} } });
            const runId = started.receipt.run.runId;
            const node = await until(async () => {
                const [first] = await h.store.listNodeExecutions(runId);
                return first?.effectAttempts >= 1 ? first : null;
            }, "the script to start", 60_000, () => controllerStatus(h, runId));
            await client.duroxideClient.enqueueEvent(started.receipt.run.controllerInstanceId, "messages",
                JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-1", args: { reason: "test cancel" } }));
            const run = await finishedRun(h, runId);
            expect(run.status).toBe("cancelled");
            const stored = await h.store.readNodeExecution(node.nodeExecutionId);
            expect(stored).toMatchObject({ state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "cancel" });
            // The effect orchestration is asked to stop; its own terminal status word is the runtime's.
            const effect = await until(async () => {
                const status = await client.duroxideClient.getStatus(workflowEffectInstanceId(node.nodeExecutionId));
                return status.status !== "Running" ? status : null;
            }, "the effect to stop");
            expect(effect.status).not.toBe("NotFound");
            const after = await h.store.readNodeExecution(node.nodeExecutionId);
            expect(after.winner).toBe("cancel");
            const log = await events(client, id);
            expect(count(log, "workflow.cancelled")).toBe(1);
            expect((await client._catalog.getSession(id)).state).toBe("cancelled");
            expect(WORKFLOW_V2_CONTROLLER_NAME).toBe("workflow-v2-controller");
        });
    });
});
