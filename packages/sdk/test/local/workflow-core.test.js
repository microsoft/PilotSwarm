/**
 * Workflow core: compiler, canonical values, the PostgreSQL store and the
 * durable controller on a real worker (PostgreSQL CMS + duroxide, real script
 * processes). No model is involved.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson, parseStoredJson, sha256Hex } from "../../src/workflow/json.ts";
import { createWorkflow, dispatchWorkflowRun, applyWorkflowUpdate } from "../../src/workflow/service.ts";
import { WORKFLOW_CONTROLLER_NAME, workflowEffectInstanceId } from "../../src/workflow/runtime.ts";
import { runScriptNode } from "../../src/workflow/runner.ts";
import { schemaSetFor } from "../../src/workflow/schema.ts";
import { WORKFLOW_REVISION_LIMITS } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "system", name: "workflow-core-test" };
// CI run 114 (HorizonDB, about ten times slower): the test's own bounds grow with the database (test/helpers/time-scale.js).
const TIMEOUT = testTime.ms(120_000);

const PIPELINE = `
apiVersion: pilotswarm.dev/v1
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
apiVersion: pilotswarm.dev/v1
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
apiVersion: pilotswarm.dev/v1
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
apiVersion: pilotswarm.dev/v1
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

/** A workflow whose 'work' state fails with no route of its own; `handler` is the catch-all state's definition. */
const CATCH_ALL = (handler, workSource = "process.exit(3);") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: catch-all, version: "1.0.0" }
initial: work
catchAll: handler
states:
  work:
    type: script
    source: |
      ${workSource}
    transition: { next: { ok: done } }
${handler}
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

function host(client) {
    return { catalog: client._catalog, store: client._catalog.workflowStore(), duroxideClient: client.duroxideClient };
}

async function until(check, label, timeoutMs = 60_000, diagnose = async () => null) {
    const deadline = Date.now() + testTime.ms(timeoutMs);
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

describe("workflow compiler and values", () => {
    it("compiles a valid definition to a stable IR hash that changes with the source", () => {
        const a = compileWorkflow(PIPELINE);
        const b = compileWorkflow(PIPELINE);
        expect(a.valid, JSON.stringify(a.diagnostics)).toBe(true);
        expect(a.irSha256).toBe(b.irSha256);
        expect(a.yamlSha256).toBe(sha256Hex(PIPELINE));
        expect(a.ir.nodes.first.outcomes).toEqual(["ok"]);
        const changed = compileWorkflow(PIPELINE.replace("n: 1 }", "n: 2 }"));
        expect(changed.valid).toBe(true);
        expect(changed.irSha256).not.toBe(a.irSha256);
    });

    it("reports field-level diagnostics and produces no IR for invalid documents", () => {
        const cases = [
            [PIPELINE.replace("ok: second,", "ok: nowhere,"), "WORKFLOW_TARGET_UNKNOWN"],
            [PIPELINE.replace('$ref: "#/schemas/In"', '$ref: "https://example.invalid/in.json"'), "WORKFLOW_SCHEMA_INVALID"],
            [PIPELINE.replace("type: script\n    outputSchema", "type: join\n    outputSchema"), "WORKFLOW_NODE_TYPE_UNSUPPORTED"],
            [PIPELINE.replace('version: "1.0.0"', "version: 1.0"), "WORKFLOW_SEMVER_INVALID"],
            [PIPELINE.replace("initial: first", "initial: first\ninitial: second"), "WORKFLOW_YAML_INVALID"],
            [LOOP.replace("enough: done", "enough: step"), "WORKFLOW_NO_TERMINAL_PATH"],
        ];
        for (const [yaml, code] of cases) {
            const result = compileWorkflow(yaml);
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
            const result = compileWorkflow(yaml);
            expect(result.valid, path).toBe(false);
            expect(result.diagnostics, path).toContainEqual(expect.objectContaining({ code: "WORKFLOW_SCHEMA_INVALID", path }));
        }
        const accept = compileWorkflow(PIPELINE.replace('inputs:\n  schema: { $ref: "#/schemas/In" }', "inputs:\n  schema: true"));
        const reject = compileWorkflow(PIPELINE.replace('inputs:\n  schema: { $ref: "#/schemas/In" }', "inputs:\n  schema: false"));
        expect(accept.valid && reject.valid, JSON.stringify([accept.diagnostics, reject.diagnostics])).toBe(true);
        expect(schemaSetFor(accept.irSha256, accept.ir.schemaDefs).validate(accept.ir.inputsSchema, { anything: 1 })).toEqual([]);
        expect(schemaSetFor(reject.irSha256, reject.ir.schemaDefs).validate(reject.ir.inputsSchema, {})).not.toEqual([]);
    });

    it("compiles a workflow-wide catch-all state and refuses an undeclared or initial one", () => {
        const terminal = compileWorkflow(CATCH_ALL('  handler: { type: terminal, outcome: blocked, output: "${input}" }'));
        expect(terminal.valid, JSON.stringify(terminal.diagnostics)).toBe(true);
        expect(terminal.ir.catchAll).toBe("handler");
        // With a catch-all, a state without a failure route is not warned about; without one it is.
        expect(terminal.diagnostics.map(item => item.code)).not.toContain("WORKFLOW_FAILURE_UNHANDLED");
        const without = compileWorkflow(CATCH_ALL('  handler: { type: terminal, outcome: blocked, output: "${input}" }').replace("catchAll: handler\n", ""));
        expect(without.valid).toBe(true);
        expect(without.ir.catchAll).toBeNull();
        expect(without.diagnostics.map(item => item.code)).toContain("WORKFLOW_FAILURE_UNHANDLED");
        // Reachable only as the catch-all, the handler is not reported unreachable.
        expect(terminal.diagnostics.map(item => item.code)).not.toContain("WORKFLOW_STATE_UNREACHABLE");
        for (const [yaml, path] of [
            [CATCH_ALL('  handler: { type: terminal, outcome: blocked }').replace("catchAll: handler", "catchAll: nowhere"), "catchAll"],
            [CATCH_ALL('  handler: { type: terminal, outcome: blocked }').replace("catchAll: handler", "catchAll: work"), "catchAll"],
            [CATCH_ALL('  handler: { type: terminal, outcome: blocked }').replace("catchAll: handler", "catchAll: [handler]"), "catchAll"],
        ]) {
            const result = compileWorkflow(yaml);
            expect(result.valid).toBe(false);
            expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_CATCH_ALL_INVALID", path }));
        }
        // The catch-all must itself be able to finish; it does not make a looping graph finishable.
        const stuck = compileWorkflow(CATCH_ALL(`  handler:
    type: script
    source: |
      await setResult("again", {});
    transition: { next: { again: handler } }`));
        expect(stuck.valid).toBe(false);
        expect(stuck.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_NO_TERMINAL_PATH", path: "states.handler" }));
    });

    it("keeps the workflow output contract beside a terminal's own schema", () => {
        const result = compileWorkflow(CONTRACT("wrong", "{ type: string }"));
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
    return { id: "probe", source, timeoutSeconds: 30 };
}

function runProbe(source) {
    return runScriptNode({
        sessionId: "plain-json-probe", node: scriptNode(source),
        callTool: async () => { throw new Error("These probes call no tools."); },
    });
}

describe("workflow script results are plain JSON before any serialization", () => {
    // setResult refuses the value and still reports it, so the node fails with invalid_output.
    const refused = [
        ["NaN", 'await setResult("ok", { n: NaN });', "numbers must be finite"],
        ["Infinity", 'await setResult("ok", { n: Infinity });', "numbers must be finite"],
        ["undefined", 'await setResult("ok", { a: undefined });', "undefined is not a JSON value"],
        ["a class instance with toJSON", 'await setResult("ok", { d: new Date(0) });', "only plain objects are JSON (got Date)"],
        ["an own toJSON function", 'await setResult("ok", { toJSON() { return 1; } });', "function is not a JSON value"],
        ["an object accessor", 'await setResult("ok", Object.defineProperty({}, "x", { enumerable: true, get() { return 1; } }));', "accessors are not JSON"],
        ["an array element accessor that changes after its check",
            'let reads = 0; const a = []; Object.defineProperty(a, "0", { enumerable: true, configurable: true, get() { return reads++ === 0 ? 1 : Infinity; } }); await setResult("ok", a);',
            "accessors are not JSON"],
        ["an array with its own toJSON", 'const a = [1]; a.toJSON = () => null; await setResult("ok", a);', "an array may hold only its elements"],
        ["an array with an extra property", 'const a = [1]; a.note = "x"; await setResult("ok", a);', "an array may hold only its elements"],
        ["a sparse array", 'await setResult("ok", [1, , 3]);', "sparse arrays are not JSON"],
        ["an array subclass", 'class List extends Array {} await setResult("ok", List.from([1]));', "only plain arrays are JSON"],
        ["a non-enumerable property", 'await setResult("ok", Object.defineProperty({}, "hidden", { value: 1 }));', "non-enumerable properties are not JSON"],
        ["an empty outcome", 'await setResult("", {});', "non-empty outcome"],
        // A script's trap may throw an error with an empty message; the refusal is still reported.
        ["a proxy whose trap throws an empty error", 'await setResult("ok", new Proxy({}, { ownKeys() { throw new Error(""); } }));',
            "the value cannot be encoded as plain JSON"],
        // The class name is read without running the script's getter.
        ["a class whose name getter throws an empty error", 'class Odd { static get name() { throw new Error(""); } } await setResult("ok", new Odd());',
            "only plain objects are JSON (got object)"],
    ];
    for (const [label, source, message] of refused) {
        it(`reports ${label} as an invalid result`, { timeout: 60_000 }, async () => {
            const result = await runProbe(`${source}\n`);
            expect(result.resultSource, JSON.stringify(result)).toBe("invalid");
            expect(result.problem).toContain(message);
            expect(result.output).toBeNull();
            // The script saw the refusal as an error.
            expect(result.exitCode).not.toBe(0);
            expect(result.stderrTail).toContain(message);
        });
    }

    it("refuses non-JSON tool arguments in the script before any call is sent", { timeout: 60_000 }, async () => {
        const calls = [];
        const result = await runScriptNode({
            sessionId: "plain-json-probe",
            node: scriptNode('try { await callTool("x", { n: NaN }); } catch (error) { await setResult("ok", { refused: error.message }); }'),
            callTool: async (call) => { calls.push(call); return null; },
        });
        expect(result.resultSource, JSON.stringify(result)).toBe("reported");
        expect(result.output.refused).toContain("numbers must be finite");
        expect(calls).toEqual([]);
    });

    it("ignores inherited toJSON hooks and encodes the value's own data", { timeout: 60_000 }, async () => {
        const result = await runProbe(`
Object.prototype.toJSON = function () { return "object hook"; };
Array.prototype.toJSON = function () { return "array hook"; };
await setResult("ok", { list: [1, [2, { k: "v" }]], empty: [], nulls: [null, null] });`);
        expect(result.resultSource, JSON.stringify(result)).toBe("reported");
        expect(result.output).toEqual({ list: [1, [2, { k: "v" }]], empty: [], nulls: [null, null] });
    });

    it("keeps dense arrays, nested values, escaped NUL and lone surrogates exact", { timeout: 60_000 }, async () => {
        const result = await runProbe('await setResult("ok", { s: "a\\u0000b\\ud800c", n: 1.5, z: -0, nested: [null, true, { k: "v" }, [[], [0, ""]]], a: Array.from({ length: 3 }, (_, i) => i) });');
        expect(result.resultSource, JSON.stringify(result)).toBe("reported");
        expect(result.output).toEqual({ s: "a\u0000b\ud800c", n: 1.5, z: 0, nested: [null, true, { k: "v" }, [[], [0, ""]]], a: [0, 1, 2] });
    });

    it("refuses a non-finite number posted directly to the endpoint (1e400 parses to Infinity)", { timeout: 60_000 }, async () => {
        const raw = `
const response = await fetch(process.env.PILOTSWARM_WORKFLOW_ENDPOINT + "/result", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.PILOTSWARM_WORKFLOW_TOKEN },
    body: '{"outcome":"ok","output":1e400}',
});`;
        const alone = await runProbe(`${raw}\nconsole.error(JSON.stringify(await response.json()));`);
        expect(alone.resultSource, JSON.stringify(alone)).toBe("invalid");
        expect(alone.problem).toBe("output: numbers must be finite");
        expect(alone.stderrTail).toContain('"ok":false');
        // A later valid setResult is the script's result.
        const corrected = await runProbe(`${raw}\nawait setResult("ok", { status: response.status, body: await response.json() });`);
        expect(corrected.resultSource, JSON.stringify(corrected)).toBe("reported");
        expect(corrected.output).toEqual({ status: 400, body: { ok: false, error: "output: numbers must be finite" } });
    });

    it("treats an invalid marker as a refusal whatever its text, and a plain null as a valid result", { timeout: 60_000 }, async () => {
        const marked = await runProbe(`
const response = await fetch(process.env.PILOTSWARM_WORKFLOW_ENDPOINT + "/result", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.PILOTSWARM_WORKFLOW_TOKEN },
    body: '{"outcome":"ok","invalid":""}',
});
console.error("status " + response.status);`);
        expect(marked).toMatchObject({ resultSource: "invalid", outcome: "ok", output: null, exitCode: 0,
            problem: "the script reported a result it could not encode" });
        expect(marked.stderrTail).toContain("status 400");
        const valid = await runProbe('await setResult("ok", null);');
        expect(valid).toMatchObject({ resultSource: "reported", outcome: "ok", output: null, exitCode: 0 });
        expect(valid.problem).toBeUndefined();
    });

    it("takes a final stdout result line or the exit code, checking stdout values", { timeout: 60_000 }, async () => {
        const valid = await runProbe('console.log(\'{"outcome":"ok","output":{"n":7}}\');');
        expect(valid).toMatchObject({ resultSource: "stdout", outcome: "ok", output: { n: 7 }, exitCode: 0 });
        const invalid = await runProbe('console.log(\'{"outcome":"ok","output":1e400}\');');
        expect(invalid).toMatchObject({ resultSource: "invalid", outcome: "ok", output: null, problem: "output: numbers must be finite" });
        const exited = await runProbe('console.log("plain text");');
        expect(exited).toMatchObject({ resultSource: "exit", outcome: "success", output: "plain text", exitCode: 0 });
        const crashed = await runProbe('process.exit(3);');
        expect(crashed).toMatchObject({ resultSource: "exit", outcome: "failure", exitCode: 3 });
        // A reported result stands even when the script exits non-zero afterwards.
        const reportedThenCrashed = await runProbe('await setResult("ok", { n: 1 }); process.exit(2);');
        expect(reportedThenCrashed).toMatchObject({ resultSource: "reported", outcome: "ok", output: { n: 1 }, exitCode: 2 });
    });
});

describe("workflow store and controller on PostgreSQL", () => {
    it("keeps drafts non-executing, revisioned, idempotent and immutable once published", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const id = randomUUID();
            const invalid = PIPELINE.replace("ok: second,", "ok: nowhere,");
            const created = await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: invalid, actor: ACTOR, operationId: "create-1" });
            expect(created.receipt).toMatchObject({ state: "draft", revision: 1, valid: false, run: null });
            await expectCode(applyWorkflowUpdate(h, id, { operation: "publish", expectedRevision: 1, definitionHash: created.receipt.yamlSha256 },
                { actor: ACTOR, operationId: "publish-invalid" }), "DEFINITION_INVALID");

            const replaced = await applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 1 }, { actor: ACTOR, operationId: "edit-2" });
            expect(replaced.receipt).toMatchObject({ revision: 2, valid: true, state: "draft" });
            const replay = await applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 1 }, { actor: ACTOR, operationId: "edit-2" });
            expect(replay.replayed).toBe(true);
            expect(replay.receipt).toEqual(replaced.receipt);
            await expectCode(applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: LOOP.replace("name: loop", "name: pipeline"), expectedRevision: 1 },
                { actor: ACTOR, operationId: "edit-2" }), "OPERATION_CONFLICT");
            await expectCode(applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 1 },
                { actor: ACTOR, operationId: "edit-stale" }), "REVISION_CONFLICT");
            await expectCode(applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: PIPELINE.replace('"1.0.0"', '"2.0.0"'), expectedRevision: 2 },
                { actor: ACTOR, operationId: "edit-semver" }), "SEMVER_IMMUTABLE");
            // Adversarial review R2-SF-5: YAML over 256 KiB is refused before it is read or saved: the draft keeps its revision,
            // here and at the store; a creation with it leaves no session and no definition.
            const oversize = `${PIPELINE}\n# ${"x".repeat(256 * 1024)}\n`;
            await expectCode(applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: oversize, expectedRevision: 2 },
                { actor: ACTOR, operationId: "edit-oversize" }), "WORKFLOW_YAML_TOO_LARGE");
            await expectCode(h.store.replaceDraft({ workflowSessionId: id, expectedRevision: 2, yaml: oversize, compiled: replaced.receipt,
                declaredSemver: "1.0.0", actor: ACTOR, operationId: "edit-oversize-store", requestSha256: "x", title: "Workflow: pipeline" }), "WORKFLOW_YAML_TOO_LARGE");
            expect((await h.store.readDefinition(id)).currentRevision).toBe(2);
            const tooLarge = randomUUID();
            await expectCode(createWorkflow(h, { workflowSessionId: tooLarge, parentSessionId: null, yaml: oversize, actor: ACTOR, operationId: "create-oversize" }),
                "WORKFLOW_YAML_TOO_LARGE");
            expect(await h.store.readDefinition(tooLarge)).toBeNull();
            expect(await client._catalog.getSession(tooLarge)).toBeNull();
            // Re-check S-SF-F5: a workflow keeps at most so many revisions and so much YAML (generous limits, lowered here):
            // a draft past either is refused, and keeps its revisions.
            const capped = randomUUID();
            await createWorkflow(h, { workflowSessionId: capped, parentSessionId: null, yaml: PIPELINE, actor: ACTOR, operationId: "create-capped" });
            h.store.revisionLimits = { maxRevisions: 2, maxYamlBytes: 64 * 1024 * 1024 };
            try {
                const second = PIPELINE.replace("name: pipeline", "name: pipeline, description: second");
                expect((await applyWorkflowUpdate(h, capped, { operation: "replace_definition", yaml: second, expectedRevision: 1 },
                    { actor: ACTOR, operationId: "capped-2" })).receipt.revision).toBe(2);
                const refusedCount = await expectCode(applyWorkflowUpdate(h, capped, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 2 },
                    { actor: ACTOR, operationId: "capped-3" }), "WORKFLOW_REVISION_LIMIT");
                expect(refusedCount.details).toMatchObject({ revisions: 2, maxRevisions: 2 });
                expect((await h.store.readDefinition(capped)).currentRevision).toBe(2);
                expect(await h.store.readRevision(capped, 3)).toBeNull();
                // The YAML limit: the next revision would pass it.
                h.store.revisionLimits = { maxRevisions: 1_000, maxYamlBytes: Buffer.byteLength(PIPELINE) + Buffer.byteLength(second) + 10 };
                const refusedBytes = await expectCode(applyWorkflowUpdate(h, capped, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 2 },
                    { actor: ACTOR, operationId: "capped-4" }), "WORKFLOW_REVISION_LIMIT");
                expect(refusedBytes.message).toMatch(/Nothing was saved: the draft keeps its revisions\./);
                expect((await h.store.readDefinition(capped)).currentRevision).toBe(2);
            } finally {
                h.store.revisionLimits = WORKFLOW_REVISION_LIMITS;
            }
            expect(WORKFLOW_REVISION_LIMITS).toEqual({ maxRevisions: 1_000, maxYamlBytes: 64 * 1024 * 1024 });
            await expectCode(applyWorkflowUpdate(h, id, { operation: "publish", expectedRevision: 2, definitionHash: created.receipt.yamlSha256 },
                { actor: ACTOR, operationId: "publish-wrong-hash" }), "DEFINITION_HASH_MISMATCH");

            const published = await applyWorkflowUpdate(h, id, { operation: "publish", expectedRevision: 2, definitionHash: replaced.receipt.yamlSha256 },
                { actor: ACTOR, operationId: "publish-2" });
            expect(published.receipt).toMatchObject({ state: "published", publishedRevision: 2, run: null });
            await expectCode(applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: PIPELINE, expectedRevision: 2 },
                { actor: ACTOR, operationId: "edit-after-publish" }), "DEFINITION_IMMUTABLE");
            expect(await h.store.listRuns(id)).toEqual([]);
            const session = await client._catalog.getSession(id);
            expect(session.sessionKind).toBe("workflow");
            expect(session.orchestrationId ?? null).toBeNull();

            // Text PostgreSQL would reject or rewrite never reaches the store.
            await expectCode(createWorkflow(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml: PIPELINE + "#\u0000",
                actor: ACTOR, operationId: "nul" }), "WORKFLOW_YAML_INVALID");
            await expectCode(createWorkflow(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml: PIPELINE,
                actor: ACTOR, operationId: "op-\ud800" }), "WORKFLOW_COMMAND_INVALID");
        });
    });

    it("lets exactly one of two concurrent edits of the same revision win", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), async (client) => {
            const h = host(client);
            const id = randomUUID();
            await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: PIPELINE, actor: ACTOR, operationId: "create" });
            const results = await Promise.allSettled(["a", "b"].map(op => applyWorkflowUpdate(h, id,
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
            const started = await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: PIPELINE, actor: ACTOR,
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

            const replay = await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: PIPELINE, actor: ACTOR,
                operationId: "create-start", start: { inputs } });
            expect(replay.replayed).toBe(true);
            expect(replay.receipt.run.runId).toBe(runId);
            await dispatchWorkflowRun(h, replay.receipt);
            await expectCode(applyWorkflowUpdate(h, id, { operation: "start", definitionHash: started.receipt.yamlSha256, inputs },
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
            const started = await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: LOOP, actor: ACTOR,
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
            const first = await createWorkflow(h, { workflowSessionId: caught, parentSessionId: null, yaml: throwing, actor: ACTOR,
                operationId: "caught", start: { inputs: { text: "x" } } });
            const blocked = await finishedRun(h, first.receipt.run.runId);
            expect(blocked.status).toBe("completed");
            expect(blocked.terminalOutcome).toBe("blocked");
            expect(blocked.terminalOutput).toMatchObject({ code: "execution_failed" });

            const unhandled = randomUUID();
            const undeclared = LOOP.replace('n < 30 ? "again" : "enough"', '"surprise"');
            const second = await createWorkflow(h, { workflowSessionId: unhandled, parentSessionId: null, yaml: undeclared, actor: ACTOR,
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
            const weakened = await createWorkflow(h, { workflowSessionId: randomUUID(), parentSessionId: null,
                yaml: CONTRACT("wrong", "{ type: string }"), actor: ACTOR, operationId: "weakened", start: { inputs: {} } });
            const failed = await finishedRun(h, weakened.receipt.run.runId);
            expect(failed.status).toBe("failed");
            expect(failed.terminalError).toMatchObject({ code: "invalid_output" });
            expect(JSON.stringify(failed.terminalError.details)).toContain("workflow.output");

            const control = await createWorkflow(h, { workflowSessionId: randomUUID(), parentSessionId: null,
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
            const draft = await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: NULL_INPUTS, actor: ACTOR, operationId: "draft" });
            const started = await applyWorkflowUpdate(h, id, { operation: "publish_and_start", expectedRevision: 1,
                definitionHash: draft.receipt.yamlSha256, inputs: null }, { actor: ACTOR, operationId: "go" });
            expect(started.receipt).toMatchObject({ operation: "publish_and_start", state: "published" });
            expect(started.receipt.run?.mode).toBe("live");
            const run = await finishedRun(h, started.receipt.run.runId);
            expect(run.inputs).toBeNull();
            expect(run.status, JSON.stringify(run.terminalError)).toBe("completed");
            expect(run.terminalOutput).toEqual({ inputs: null });
            const replay = await applyWorkflowUpdate(h, id, { operation: "publish_and_start", expectedRevision: 1,
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
            await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: yamlA, actor: ACTOR, operationId: "create" });
            expect((await client._catalog.getSession(id)).title).toBe("Workflow: title-a");
            await applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: yamlB, expectedRevision: 1 }, { actor: ACTOR, operationId: "rename" });
            expect((await client._catalog.getSession(id)).title).toBe("Workflow: title-b");
            const replayedCreate = await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: yamlA, actor: ACTOR, operationId: "create" });
            expect(replayedCreate.replayed).toBe(true);
            const replayedRename = await applyWorkflowUpdate(h, id, { operation: "replace_definition", yaml: yamlB, expectedRevision: 1 },
                { actor: ACTOR, operationId: "rename" });
            expect(replayedRename.replayed).toBe(true);
            expect((await client._catalog.getSession(id)).title).toBe("Workflow: title-b");
            expect((await h.store.readDefinition(id)).currentRevision).toBe(2);
        });
    });

    it("routes non-JSON results to invalid_output and keeps the stdout and exit-code channels", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const cases = [
                ["stdout-1e400", 'console.log(\'{"outcome":"ok","output":1e400}\');', { code: "invalid_output" }],
                ["nan", 'await setResult("ok", { n: NaN });', { code: "invalid_output" }],
                ["array-getter", 'const a = []; Object.defineProperty(a, "0", { enumerable: true, get() { return 1; } }); await setResult("ok", { a });', { code: "invalid_output" }],
                ["crash", 'process.exit(4);', { code: "execution_failed" }],
                ["stdout-valid", 'console.log(\'{"outcome":"ok","output":{"n":7}}\');', { output: { n: 7 } }],
                ["marked-empty", 'await fetch(process.env.PILOTSWARM_WORKFLOW_ENDPOINT + "/result", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.PILOTSWARM_WORKFLOW_TOKEN }, body: \'{"outcome":"ok","invalid":""}\' });', { code: "invalid_output" }],
                ["valid-null", 'await setResult("ok", null);', { output: null }],
                ["reported-then-exit", 'await setResult("ok", { n: 1 }); process.exit(2);', { output: { n: 1 } }],
            ];
            for (const [name, source, expected] of cases) {
                const yaml = `
apiVersion: pilotswarm.dev/v1
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
                const started = await createWorkflow(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml,
                    actor: ACTOR, operationId: name, start: { inputs: {} } });
                const run = await finishedRun(h, started.receipt.run.runId);
                const [probe] = await h.store.listNodeExecutions(run.runId);
                if (expected.code) {
                    expect(run.terminalOutcome, `${name}: ${JSON.stringify(run)}`).toBe("blocked");
                    expect(run.terminalOutput.code).toBe(expected.code);
                    expect(probe).toMatchObject({ nodeId: "probe", resultKind: "runtime_error", outcome: expected.code, output: null });
                } else {
                    expect(run.terminalOutcome, `${name}: ${JSON.stringify(run)}`).toBe("succeeded");
                    expect(run.terminalOutput).toEqual(expected.output);
                    expect(probe).toMatchObject({ nodeId: "probe", resultKind: "business", outcome: "ok", output: expected.output });
                }
            }
        });
    });

    it("routes an unhandled runtime error to the catch-all state once; a handled error and business routes do not use it", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const start = (name, yaml) => createWorkflow(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml,
                actor: ACTOR, operationId: name, start: { inputs: {} } });

            // An error with no route of its own reaches the catch-all terminal with its error envelope.
            const caught = await start("caught", CATCH_ALL('  handler: { type: terminal, outcome: blocked, output: "${input}" }'));
            const caughtRun = await finishedRun(h, caught.receipt.run.runId);
            expect(caughtRun, JSON.stringify(caughtRun)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "handler" });
            expect(caughtRun.terminalOutput).toMatchObject({ code: "execution_failed", details: { exitCode: 3 } });
            const caughtNodes = await h.store.listNodeExecutions(caughtRun.runId);
            expect(caughtNodes.map(node => [node.nodeId, node.arrivalRoute, node.outcome])).toEqual([
                ["work", null, "execution_failed"], ["handler", "@catchAll", "blocked"],
            ]);
            const started = (await events(client, caught.receipt.workflowSessionId))
                .filter(event => event.eventType === "workflow.state_started" && event.data.stateId === "handler");
            expect(started.map(event => event.data)).toEqual([expect.objectContaining({ catchAll: true, failedNodeExecutionId: caughtNodes[0].nodeExecutionId })]);

            // A catch-all script that fails without a route of its own is not entered again: the run fails.
            const failing = await start("handler-fails", CATCH_ALL(`  handler:
    type: script
    source: |
      process.exit(5);
    transition: { next: { ok: done } }`));
            const failingRun = await finishedRun(h, failing.receipt.run.runId);
            expect(failingRun.status, JSON.stringify(failingRun)).toBe("failed");
            expect(failingRun.terminalError).toMatchObject({ code: "execution_failed" });
            expect(failingRun.terminalError.message).toContain("catch-all state already ran");
            const failingNodes = await h.store.listNodeExecutions(failingRun.runId);
            expect(failingNodes.map(node => [node.nodeId, node.ordinal, node.outcome])).toEqual([
                ["work", 1, "execution_failed"], ["handler", 1, "execution_failed"],
            ]);

            // A catch-all script that recovers routes on to a normal terminal.
            const recovered = await start("handler-recovers", CATCH_ALL(`  handler:
    type: script
    source: |
      await setResult("ok", { recovered: context.input.code });
    transition: { next: { ok: done } }`));
            const recoveredRun = await finishedRun(h, recovered.receipt.run.runId);
            expect(recoveredRun).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { recovered: "execution_failed" } });

            // A state's own failure route wins over the catch-all, and business outcomes never use it.
            const handled = await start("handled", CATCH_ALL('  handler: { type: terminal, outcome: blocked, output: "${input}" }')
                .replace("transition: { next: { ok: done } }", "transition: { next: { ok: done, failure: own } }")
                .replace("  done: {", '  own: { type: terminal, outcome: failed, output: "${input}" }\n  done: {'));
            const handledRun = await finishedRun(h, handled.receipt.run.runId);
            expect(handledRun).toMatchObject({ status: "failed", terminalOutcome: "failed", terminalNodeId: "own" });
            const fine = await start("fine", CATCH_ALL('  handler: { type: terminal, outcome: blocked, output: "${input}" }', 'await setResult("ok", { fine: true });'));
            const fineRun = await finishedRun(h, fine.receipt.run.runId);
            expect(fineRun).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { fine: true } });
            expect((await h.store.listNodeExecutions(fineRun.runId)).map(node => node.nodeId)).toEqual(["work", "done"]);
        });
    });

    it("enters the catch-all state at most once by any route, and hands it a terminal's invalid output", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const start = (name, yaml) => createWorkflow(h, { workflowSessionId: randomUUID(), parentSessionId: null, yaml,
                actor: ACTOR, operationId: name, start: { inputs: {} } });
            const failingHandler = `  handler:
    type: script
    source: |
      process.exit(5);
    transition: { next: { ok: done } }`;

            // An explicit failure route into the catch-all state uses its one entry:
            // the handler's own unhandled error fails the run instead of entering it again.
            const explicit = await start("explicit", CATCH_ALL(failingHandler)
                .replace("transition: { next: { ok: done } }", "transition: { next: { ok: done, failure: handler } }"));
            const explicitRun = await finishedRun(h, explicit.receipt.run.runId);
            expect(explicitRun.status, JSON.stringify(explicitRun)).toBe("failed");
            expect(explicitRun.terminalError).toMatchObject({ code: "execution_failed" });
            expect(explicitRun.terminalError.message).toContain("catch-all state already ran");
            const explicitNodes = await h.store.listNodeExecutions(explicitRun.runId);
            expect(explicitNodes.map(node => [node.nodeId, node.ordinal, node.arrivalRoute, node.outcome])).toEqual([
                ["work", 1, null, "execution_failed"], ["handler", 1, "failure", "execution_failed"],
            ]);
            expect(explicitRun.terminalError.details).toEqual({ nodeExecutionId: explicitNodes[1].nodeExecutionId });

            // After the catch-all state ran, another route into it fails the run.
            const again = await start("route-back", CATCH_ALL(`  handler:
    type: script
    source: |
      await setResult("ok", {});
    transition: { next: { ok: retry } }
  retry:
    type: script
    source: |
      process.exit(4);
    transition: { next: { ok: done, failure: handler } }`));
            const againRun = await finishedRun(h, again.receipt.run.runId);
            expect(againRun.status, JSON.stringify(againRun)).toBe("failed");
            expect(againRun.terminalError.message).toContain("which already ran in this run");
            expect((await h.store.listNodeExecutions(againRun.runId)).map(node => [node.nodeId, node.ordinal, node.outcome])).toEqual([
                ["work", 1, "execution_failed"], ["handler", 1, "ok"], ["retry", 1, "execution_failed"],
            ]);

            // A terminal whose output fails its schema is a runtime error: its envelope goes to the catch-all state once.
            const INVALID_TERMINAL = (handler) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: invalid-terminal, version: "1.0.0" }
initial: work
catchAll: handler
states:
  work:
    type: script
    source: |
      await setResult("ok", {});
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: 7, outputSchema: { type: string } }
${handler}
`;
            const routed = await start("terminal-error", INVALID_TERMINAL('  handler: { type: terminal, outcome: blocked, output: "${input}" }'));
            const routedRun = await finishedRun(h, routed.receipt.run.runId);
            expect(routedRun, JSON.stringify(routedRun)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "handler" });
            expect(routedRun.terminalOutput).toMatchObject({ code: "invalid_output" });
            const routedNodes = await h.store.listNodeExecutions(routedRun.runId);
            expect(routedNodes.map(node => [node.nodeId, node.arrivalRoute, node.resultKind, node.outcome, node.winner])).toEqual([
                ["work", null, "business", "ok", "effect"],
                ["done", "ok", "runtime_error", "invalid_output", "controller"],
                ["handler", "@catchAll", "business", "blocked", "controller"],
            ]);
            expect(routedNodes[1].error).toEqual(routedRun.terminalOutput);
            expect(routedNodes[2].predecessorId).toBe(routedNodes[1].nodeExecutionId);
            const routedEvents = await events(client, routed.receipt.workflowSessionId);
            expect(routedEvents.filter(event => event.eventType === "workflow.state_failed").map(event => event.data))
                .toEqual([expect.objectContaining({ stateId: "done", outcome: "invalid_output", catchAll: "handler" })]);
            expect(count(routedEvents, "workflow.completed")).toBe(1);
            expect(count(routedEvents, "workflow.failed")).toBe(0);

            // The catch-all terminal's own invalid output ends the run as failed; it is not entered again.
            const twice = await start("terminal-error-twice", INVALID_TERMINAL("  handler: { type: terminal, outcome: blocked, output: 8, outputSchema: { type: string } }"));
            const twiceRun = await finishedRun(h, twice.receipt.run.runId);
            expect(twiceRun.status, JSON.stringify(twiceRun)).toBe("failed");
            expect(twiceRun).toMatchObject({ terminalNodeId: "handler", terminalOutcome: null, terminalError: { code: "invalid_output" } });
            expect((await h.store.listNodeExecutions(twiceRun.runId)).map(node => [node.nodeId, node.ordinal, node.outcome])).toEqual([
                ["work", 1, "ok"], ["done", 1, "invalid_output"], ["handler", 1, "invalid_output"],
            ]);
        });
    });

    it("cancels a running script node once: the stored winner is the cancellation, not a late result", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            const id = randomUUID();
            const slow = LOOP.replace("const n = context.input.n + 1;", "await new Promise(resolve => setTimeout(resolve, 60_000)); const n = 30;");
            const started = await createWorkflow(h, { workflowSessionId: id, parentSessionId: null, yaml: slow, actor: ACTOR,
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
            expect(WORKFLOW_CONTROLLER_NAME).toBe("workflow-controller");
        });
    });
});
