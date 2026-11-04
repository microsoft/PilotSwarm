/**
 * Workflow v2 run control on the real durable runtime (duroxide PostgreSQL
 * provider) and the real PostgreSQL store, through the update_workflow and
 * read_workflow tool adapters a parent agent calls:
 *
 * - open KV: the initial map, one atomic set/delete batch at the expected
 *   revision, idempotency by operation id, limits, and the snapshot each
 *   state pins when it is admitted (a running script keeps its own);
 * - pause and resume: a paused run admits no new state, while work already
 *   running finishes and its result is kept; resume admits again;
 * - cancel while paused, a run paused before its controller began, and
 *   recover of such a run whose dispatch was lost;
 * - a cancel of a run that has not begun ends it at once (C1): duroxide
 *   drops a command queued for a controller instance that has not started;
 *   an earlier build's accepted cancel ends the run at its repeat or at its
 *   begin, attributed to the parent under migration assumption M1 (README),
 *   and the parent is not told of that cancel; another requester's cancel is
 *   reported to the parent at least once, by the cancel's request or by the
 *   run's begin (C2);
 * - bindings that name any KV key: `??`, quotes, backslashes, `${` and `}`
 *   inside a JSON-string key or default are data, in a typed script input
 *   and a typed terminal output.
 *
 * Pause, resume and KV are not in the formal model (README "Model
 * simplifications"); these regressions are their evidence.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { evaluateBindingTemplate, parseBindingExpression, WorkflowBindingError } from "../../src/workflow/v2/bindings.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, jsonSha256 } from "../../src/workflow/v2/json.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_ADMISSION_EVALUATIONS, WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_CONTROLLER_VERSION,
    WORKFLOW_V2_STORE_RETRY, workflowEffectInstanceId, workflowNotifyInstanceId,
} from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-control-test" };

/** Two script states; each reports the KV snapshot it was given and its input. */
const TWO_STATES = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: control, version: "1.0.0" }
initialInput: { from: "start" }
initial: first
states:
  first:
    type: script
    source: |
      await setResult("ok", { kv: context.kv, input: context.input });
    transition: { next: { ok: second } }
  second:
    type: script
    source: |
      await setResult("ok", { kv: context.kv, prior: context.input });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: { last: "\${input}", mode: "\${kv.mode}" } }
`;

/** One script state whose input reads the KV; it reports the snapshot and input it was given. */
const ONE_STATE = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: one-state, version: "1.0.0" }
initial: first
states:
  first:
    type: script
    input: { mode: "\${kv.mode}" }
    source: |
      await setResult("ok", { kv: context.kv, input: context.input });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

/** A script that reports which KV keys it sees as own data, and a terminal that reads two of them. */
const KEYS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: kv-keys, version: "1.0.0" }
initial: act
states:
  act:
    type: script
    source: |
      await setResult("ok", {
        keys: Object.keys(context.kv).sort(),
        proto: Object.hasOwn(context.kv, "__proto__") ? context.kv["__proto__"] : "missing",
        plain: Object.getPrototypeOf(context.kv) === Object.prototype,
      });
    transition: { next: { ok: done } }
  done:
    type: terminal
    outcome: succeeded
    output: { seen: "\${input}", proto: '\${kv["__proto__"] ?? "deleted"}', ctor: "\${kv.constructor}" }
`;

/** KV keys that hold the operator `??`, quotes, a backslash, `${` and `}` as data. */
const KEY = { op: "a??b", quoted: 'say "hi" ?? x', slash: "back\\slash??", end: "end\\", ownNull: "own??null", dollar: "a${b}", brace: "}" };
const VARS = { [KEY.op]: 1, [KEY.quoted]: "q", [KEY.slash]: "s", [KEY.end]: "e", [KEY.ownNull]: null, [KEY.dollar]: "d", [KEY.brace]: "b" };

/** The script input template of BINDING_KEYS: each value is the text an author writes (JSON-string keys, no Unicode escapes). */
const READ_INPUT = {
    op: '${kv["a??b"]}',
    opNull: '${kv["a??b"] ?? null}',
    quoted: '${kv["say \\"hi\\" ?? x"]}',
    slash: '${kv["back\\\\slash??"] ?? "unused"}',
    end: '${kv["end\\\\"]??1}',
    ownNull: '${kv["own??null"]}',
    ownNullDefault: '${kv["own??null"] ?? "unused"}',
    missing: '${kv["no??such"] ?? "fallback ?? text"}',
    missingNull: '${kv["no??such"] ?? null}',
    dollar: '${kv["a${b}"]}',
    brace: '${kv[ "}" ] ?? "}"}',
};

/** READ_INPUT with VARS: a present value wins over a default, an own null is a value, only a missing key takes its default. */
const SEEN = { op: 1, opNull: 1, quoted: "q", slash: "s", end: "e", ownNull: null, ownNullDefault: null,
    missing: "fallback ?? text", missingNull: null, dollar: "d", brace: "b" };

/**
 * A typed script state whose input names the keys of VARS, and a typed
 * terminal that names a key of its input, of the KV and of the static inputs.
 * The YAML single-quoted values are the texts of READ_INPUT.
 */
const BINDING_KEYS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: binding-keys, version: "1.0.0" }
inputs:
  schema: { type: object, required: ["x??y"], properties: { "x??y": { type: integer } } }
schemas:
  Seen:
    type: object
    additionalProperties: false
    required: [op, opNull, quoted, slash, end, ownNull, ownNullDefault, missing, missingNull, dollar, brace]
    properties:
      op: { type: integer }
      opNull: { type: integer }
      quoted: { type: string }
      slash: { type: string }
      end: { type: string }
      ownNull: { type: "null" }
      ownNullDefault: { type: "null" }
      missing: { type: string }
      missingNull: { type: "null" }
      dollar: { type: string }
      brace: { type: string }
  Echo:
    type: object
    additionalProperties: false
    required: [seen, keys]
    properties:
      seen: { $ref: "#/schemas/Seen" }
      keys: { type: array, items: { type: string } }
  Done:
    type: object
    additionalProperties: false
    required: [seen, quoted, viaKv, missing, fromInputs]
    properties:
      seen: { $ref: "#/schemas/Seen" }
      quoted: { type: string }
      viaKv: { type: string }
      missing: { type: string }
      fromInputs: { type: integer }
outputSchema: { $ref: "#/schemas/Done" }
initial: read
states:
  read:
    type: script
    input:
      op: '\${kv["a??b"]}'
      opNull: '\${kv["a??b"] ?? null}'
      quoted: '\${kv["say \\"hi\\" ?? x"]}'
      slash: '\${kv["back\\\\slash??"] ?? "unused"}'
      end: '\${kv["end\\\\"]??1}'
      ownNull: '\${kv["own??null"]}'
      ownNullDefault: '\${kv["own??null"] ?? "unused"}'
      missing: '\${kv["no??such"] ?? "fallback ?? text"}'
      missingNull: '\${kv["no??such"] ?? null}'
      dollar: '\${kv["a\${b}"]}'
      brace: '\${kv[ "}" ] ?? "}"}'
    inputSchema: { $ref: "#/schemas/Seen" }
    outputSchema: { $ref: "#/schemas/Echo" }
    source: |
      await setResult("ok", { seen: context.input, keys: Object.keys(context.kv).sort() });
    transition: { next: { ok: done, invalid_input: bad } }
  done:
    type: terminal
    outcome: succeeded
    output:
      seen: '\${input.seen}'
      quoted: '\${input.seen["quoted"]}'
      viaKv: '\${kv["back\\\\slash??"]}'
      missing: '\${input["no??such"] ?? "absent ?? here"}'
      fromInputs: '\${inputs["x??y"]}'
    outputSchema: { $ref: "#/schemas/Done" }
  bad: { type: terminal, outcome: blocked, output: '\${input}' }
`;

/** A KV map's own entries, sorted by key, and whether its prototype is the plain one. */
function entriesOf(map) {
    return { plain: Object.getPrototypeOf(map) === Object.prototype, entries: Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
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

/** A gate the test opens; `reached` resolves when code arrives at it. */
function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    return { reached, arrive: () => arrive(), wait: () => opened, open: () => open() };
}

/**
 * The collect activity, recording in `withheld` each run whose collection gave
 * its controller no result while results of the work it asked about were
 * stored (controller 1.8.0 while its run is paused; review R2-RT-1).
 */
function withholding(store, fn, withheld) {
    return async (ctx, input) => {
        const collected = await fn(ctx, input);
        if (Array.isArray(collected) && collected.length === 0 && input.nodeExecutionIds.length > 0
            && (await store.readCompletedNodes(input.runId, input.nodeExecutionIds)).length > 0) withheld.push(input.runId);
        return collected;
    };
}

/**
 * A worker-equivalent registration. `hold` pauses each effect named in it
 * after its node was admitted and before its script starts (the tool binding
 * read); `refusals` counts admissions the store refused for a pause;
 * `withheld` lists runs whose results a collection kept from the controller;
 * `wrapStore` wraps the store the runtime uses. With `notify`, the parent
 * notification is authorized and each delivery is recorded in `notified`
 * (otherwise it is refused, and the notifier records the skip).
 */
async function harness(env, { wrapStore, notify = false } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
    const holds = new Map();
    const refusals = [];
    const withheld = [];
    const notified = [];
    const registrar = {
        registerActivity: (name, fn) => runtime.registerActivity(name, name === WORKFLOW_V2_ACTIVITIES.collect ? withholding(store, fn, withheld)
            : name !== WORKFLOW_V2_ACTIVITIES.enter ? fn : async (ctx, input) => {
                const entered = await fn(ctx, input);
                if (entered.admitted === false && entered.status === "paused") refusals.push(input.runId);
                return entered;
            }),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    };
    registerWorkflowV2(registrar, {
        store: wrapStore ? wrapStore(store) : store,
        catalog,
        enabled: () => true,
        resolveToolBinding: async (sessionId) => {
            const held = holds.get(sessionId);
            if (held) { holds.delete(sessionId); held.arrive(); await held.wait(); }
            return null;
        },
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => notify,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => {
            if (!notify) throw new Error("These workflows notify no parent.");
            notified.push({ parentSessionId, clientMessageId });
        },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
    });
    await runtime.start();
    return {
        store, client, refusals, withheld, notified,
        host: { catalog, store, duroxideClient: client },
        /** Hold the next effect of this workflow before its script starts. */
        hold(workflowId) { const held = gate(); holds.set(workflowId, held); return held; },
        async stop() {
            for (const held of holds.values()) held.open();
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function finished(h, runId, timeoutMs = 60_000) {
    return until(async () => {
        const run = await h.store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, timeoutMs);
}

/** A parent session and the tool calls it makes on its workflow children. */
async function parentOf(h) {
    const parentId = randomUUID();
    await h.host.catalog.createSession(parentId, {});
    const context = { callerSessionId: parentId, host: h.host };
    return {
        parentId,
        update: async (workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        read: async (workflowId, args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
    };
}

describe("workflow v2 run control on the real runtime", () => {
    it("pins each state's KV snapshot at admission and applies set_vars as one atomic batch at the expected revision", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const held = h.hold(id);
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: { mode: "a", keep: null } } });
            const { runId } = created.receipt.run;
            await held.reached;

            // The first state was admitted with revision 1 and holds before its script starts.
            const before = await parent.read(id);
            expect(before.run).toMatchObject({ status: "running", kvRevision: 1 });
            // The read view previews the map as canonical JSON text, like outputs and errors.
            expect(JSON.parse(before.run.kv)).toEqual({ mode: "a", keep: null });
            expect(before.run.nodeExecutions.map(node => [node.stateId, node.state, node.kvRevision])).toEqual([["first", "pending", 1]]);

            // One batch: set two keys, delete one; null was a value until it is deleted explicitly.
            const set = await parent.update(id, { operation: "set_vars", operation_id: "vars-1", set: { mode: "b", extra: 1 }, delete: ["keep"], expected_kv_revision: 1 });
            expect(set, JSON.stringify(set)).toEqual({ ok: true, workflowId: id, operation: "set_vars", replayed: false, runId, status: "running", kvRevision: 2 });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-1", set: { mode: "b", extra: 1 }, delete: ["keep"], expected_kv_revision: 1 }))
                .toEqual({ ...set, replayed: true });
            // A stale revision, a value over the limit and a contradictory batch change nothing.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-stale", set: { mode: "c" }, expected_kv_revision: 1 }))
                .toMatchObject({ ok: false, error: { code: "KV_REVISION_CONFLICT", details: { kvRevision: 2 } } });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-big", set: { mode: "c", big: "x".repeat(300 * 1024) }, expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "KV_LIMIT" } });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-both", set: { mode: "c" }, delete: ["mode"], expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID" } });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-1", set: { mode: "z" }, expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            const after = (await parent.read(id)).run;
            expect(after.kvRevision).toBe(2);
            expect(JSON.parse(after.kv)).toEqual({ mode: "b", extra: 1 });
            expect(await h.store.readKv(runId, 1)).toEqual({ mode: "a", keep: null });

            // The running state keeps the snapshot it was admitted with; the next state pins revision 2.
            held.open();
            const run = await finished(h, runId);
            expect(run.status, JSON.stringify(run)).toBe("completed");
            const nodes = await h.store.listNodeExecutions(runId);
            expect(nodes.map(node => [node.nodeId, node.kvRevision])).toEqual([["first", 1], ["second", 2], ["done", 2]]);
            expect(nodes[0].output).toEqual({ kv: { mode: "a", keep: null }, input: { from: "start" } });
            expect(nodes[1].output).toEqual({ kv: { mode: "b", extra: 1 }, prior: { kv: { mode: "a", keep: null }, input: { from: "start" } } });
            expect(run.terminalOutput).toEqual({ last: nodes[1].output, mode: "b" });

            // After the run ends, its KV no longer changes; one vars event was recorded.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-late", set: { mode: "d" }, expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            const events = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.vars_set"]);
            expect(events.map(event => event.data)).toEqual([expect.objectContaining({ runId, kvRevision: 2, set: ["mode", "extra"], deleted: ["keep"] })]);
        } finally { await h.stop(); }
    });

    it("pauses admission without stopping admitted work, and resumes it", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const held = h.hold(id);
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: { mode: "a" } } });
            const { runId } = created.receipt.run;
            await held.reached;
            expect(await parent.update(id, { operation: "resume", operation_id: "resume-early" })).toMatchObject({ ok: false, error: { code: "RUN_NOT_PAUSED" } });

            const paused = await parent.update(id, { operation: "pause", operation_id: "pause-1", reason: "review" });
            expect(paused, JSON.stringify(paused)).toEqual({ ok: true, workflowId: id, operation: "pause", replayed: false, runId, status: "paused", kvRevision: 1 });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-1", reason: "review" })).toEqual({ ...paused, replayed: true });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-2" })).toMatchObject({ ok: false, error: { code: "RUN_ALREADY_PAUSED" } });
            // Requested, not yet settled: the admitted state is still running.
            expect((await parent.read(id)).run).toMatchObject({ status: "paused", pausedFrom: "running", pauseSettled: false });

            // The admitted script still runs and its result is kept; it is not routed while paused (review R2-RT-1: the
            // collection keeps it from the controller, which tries no admission), so no next state is admitted.
            held.open();
            await until(async () => (await h.store.listNodeExecutions(runId))[0]?.state === "completed", "the admitted script's result");
            await until(async () => h.withheld.includes(runId), "a collection that keeps the result for the resume");
            expect(h.refusals).not.toContain(runId);
            expect((await h.store.listNodeExecutions(runId)).map(node => [node.nodeId, node.state, node.winner])).toEqual([["first", "completed", "effect"]]);
            const view = await parent.read(id);
            expect(view.run).toMatchObject({ status: "paused", pausedFrom: "running", pauseSettled: true, controller: { needsRecovery: false } });
            // KV still changes while paused; the next state will pin it.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-paused", set: { mode: "p" }, expected_kv_revision: 1 }))
                .toMatchObject({ ok: true, status: "paused", kvRevision: 2 });

            const resumed = await parent.update(id, { operation: "resume", operation_id: "resume-1" });
            expect(resumed).toMatchObject({ ok: true, replayed: false, status: "running" });
            const run = await finished(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect(run.terminalOutput.mode).toBe("p");
            expect((await h.store.listNodeExecutions(runId)).map(node => [node.nodeId, node.ordinal, node.kvRevision])).toEqual([["first", 1, 1], ["second", 1, 2], ["done", 1, 2]]);
            expect(await parent.update(id, { operation: "resume", operation_id: "resume-1" })).toEqual({ ...resumed, replayed: true });
            expect(await parent.update(id, { operation: "resume", operation_id: "resume-late" })).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            const events = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.paused", "workflow.resumed"]);
            expect(events.map(event => [event.eventType, event.data.reason ?? null])).toEqual([["workflow.paused", "review"], ["workflow.resumed", null]]);
        } finally { await h.stop(); }
    });

    it("starts a run paused before it began as paused, recovers its lost dispatch, and cancels it while paused", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const created = await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const { runId, controllerInstanceId } = created.receipt.run;
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-1" })).toMatchObject({ ok: true, status: "paused" });
            expect(await h.store.readRun(runId)).toMatchObject({ status: "paused", pausedFrom: "admitted" });
            expect((await parent.read(id)).run).toMatchObject({ status: "paused", controller: { status: "NotFound", needsRecovery: true } });

            // Recover dispatches the paused, never-begun run; it begins and stays paused, admitting nothing.
            expect(await parent.update(id, { operation: "recover", operation_id: "recover-1" })).toMatchObject({ ok: true, action: "dispatched", status: "paused" });
            await until(async () => h.refusals.includes(runId), "an admission refused for the pause");
            expect(await h.store.readRun(runId)).toMatchObject({ status: "paused", pausedFrom: "running" });
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
            const begun = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.started"]);
            expect(begun).toHaveLength(1);

            // A cancel is processed while paused; its receipt only says it was accepted.
            const cancel = await parent.update(id, { operation: "cancel", operation_id: "cancel-1", reason: "not needed" });
            expect(cancel, JSON.stringify(cancel)).toMatchObject({ ok: true, operation: "cancel", replayed: false, status: "paused" });
            const run = await finished(h, runId);
            expect(run).toMatchObject({ status: "cancelled", pausedFrom: null, terminalError: { code: "cancelled", message: "not needed" } });
            expect((await h.client.waitForOrchestration(controllerInstanceId, 30_000)).status).toBe("Completed");
            expect(await parent.update(id, { operation: "cancel", operation_id: "cancel-1", reason: "not needed" })).toEqual({ ...cancel, replayed: true });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-late" })).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
        } finally { await h.stop(); }
    });
    it("ends a run that has not begun at once when it is cancelled, admitted or paused before begin, and notifies its parent at least once by the controller's rule", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env, { notify: true });
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parent = await parentOf(h);
            // The dispatch after admission is lost: the run's controller instance does not exist.
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const lost = async (id) => (await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
            const queued = async (instanceId) => Number((await db.query(
                `SELECT count(*) AS n FROM "${env.duroxideSchema}".orchestrator_queue WHERE instance_id = $1`, [instanceId])).rows[0].n);
            const stableId = (workflowId, runId) => `workflow:${workflowId}:${runId}:terminal`;

            // Admitted: the parent's cancel ends the run in its own transaction, with its receipt.
            const id = randomUUID();
            const { runId, controllerInstanceId } = await lost(id);
            expect((await parent.read(id)).run).toMatchObject({ status: "admitted", controller: { status: "NotFound", needsRecovery: true } });
            const cancel = await parent.update(id, { operation: "cancel", operation_id: "cancel-1", reason: "not needed" });
            expect(cancel, JSON.stringify(cancel)).toEqual({ ok: true, workflowId: id, operation: "cancel", replayed: false, runId, status: "cancelled", kvRevision: 1 });
            expect(await h.store.readRun(runId)).toMatchObject({ status: "cancelled", pausedFrom: null,
                terminalError: { code: "cancelled", message: "not needed",
                    details: { command: "cancel", requestedBy: parent.parentId, operationId: "cancel-1", beforeBegin: true } } });
            const events = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.cancelled"]);
            expect(events.map(event => event.data)).toEqual([expect.objectContaining({ runId, command: "cancel", beforeBegin: true, operationId: "cancel-1" })]);
            // No command was queued for the instance that does not exist, and nothing needs recovery.
            expect(await queued(controllerInstanceId)).toBe(0);
            expect((await h.client.getStatus(controllerInstanceId)).status).toBe("NotFound");
            const view = (await parent.read(id)).run;
            expect(view.status).toBe("cancelled");
            expect(view.controller).toBeUndefined();
            expect(await parent.update(id, { operation: "cancel", operation_id: "cancel-1", reason: "not needed" })).toEqual({ ...cancel, replayed: true });
            expect(await parent.update(id, { operation: "recover", operation_id: "recover-1" })).toMatchObject({ ok: true, action: "none", status: "cancelled" });
            // The parent asked for the cancel, so it is not notified (the controller's rule).
            expect((await h.client.getStatus(workflowNotifyInstanceId(runId))).status).toBe("NotFound");
            // The original dispatch arrives late and starts the instance: begin finds the run ended and admits nothing.
            await h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, { v: 2, workflowSessionId: id, runId },
                WORKFLOW_V2_CONTROLLER_VERSION);
            expect((await h.client.waitForOrchestration(controllerInstanceId, 30_000)).status).toBe("Completed");
            expect(await h.store.readRun(runId)).toMatchObject({ status: "cancelled", terminalError: { details: { operationId: "cancel-1" } } });
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
            expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.started"])).toEqual([]);

            // Paused before it began, then cancelled by another actor: ended at once, and the parent is notified
            // through the notifier orchestration with the stable client message id.
            const other = randomUUID();
            const pausedRun = await lost(other);
            expect(await parent.update(other, { operation: "pause", operation_id: "pause-1" })).toMatchObject({ ok: true, status: "paused" });
            expect(await h.store.readRun(pausedRun.runId)).toMatchObject({ status: "paused", pausedFrom: "admitted" });
            const byUser = await controlWorkflowV2Run(h.host, other, { operation: "cancel", runId: null, reason: "stop it" },
                { actor: { kind: "system", name: "workflow-v2-control-test-user" }, operationId: "cancel-2" });
            expect(byUser).toMatchObject({ replayed: false, receipt: { operation: "cancel", status: "cancelled" } });
            expect(await h.store.readRun(pausedRun.runId)).toMatchObject({ status: "cancelled", pausedFrom: null,
                terminalError: { code: "cancelled", message: "stop it", details: { requestedBy: null, operationId: "cancel-2", beforeBegin: true } } });
            expect((await h.client.waitForOrchestration(workflowNotifyInstanceId(pausedRun.runId), 30_000)).status).toBe("Completed");
            const toParent = h.notified.filter(item => item.clientMessageId === stableId(other, pausedRun.runId));
            expect(toParent.length).toBeGreaterThanOrEqual(1);
            expect(toParent.every(item => item.parentSessionId === parent.parentId)).toBe(true);
            expect((await h.host.catalog.getSessionEvents(other, 0, 50, ["workflow.parent_notified"])).length).toBeGreaterThanOrEqual(1);
            expect(await queued(pausedRun.controllerInstanceId)).toBe(0);
            expect(await h.store.listNodeExecutions(pausedRun.runId)).toEqual([]);

            // The cancel commits and the request is interrupted before it starts the notifier (an injected
            // failure of that start): a repeat with the same operation id starts it, with the same stable id.
            const third = randomUUID();
            const thirdRun = await lost(third);
            const notifierStartFails = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async (instanceId, ...rest) => {
                if (instanceId === workflowNotifyInstanceId(thirdRun.runId)) throw new Error("injected: interrupted before the notifier started");
                return h.host.duroxideClient.startOrchestrationVersioned(instanceId, ...rest);
            } } };
            const actor = { kind: "system", name: "workflow-v2-control-test-user" };
            await expect(controlWorkflowV2Run(notifierStartFails, third, { operation: "cancel", runId: null, reason: "stop it" }, { actor, operationId: "cancel-3" }))
                .rejects.toThrow("injected: interrupted before the notifier started");
            expect(await h.store.readRun(thirdRun.runId)).toMatchObject({ status: "cancelled", terminalError: { details: { operationId: "cancel-3", beforeBegin: true } } });
            expect((await h.client.getStatus(workflowNotifyInstanceId(thirdRun.runId))).status).toBe("NotFound");
            const repeated = await controlWorkflowV2Run(h.host, third, { operation: "cancel", runId: null, reason: "stop it" }, { actor, operationId: "cancel-3" });
            expect(repeated).toMatchObject({ replayed: true, receipt: { operation: "cancel", status: "cancelled" } });
            expect((await h.client.waitForOrchestration(workflowNotifyInstanceId(thirdRun.runId), 30_000)).status).toBe("Completed");
            expect(h.notified.filter(item => item.clientMessageId === stableId(third, thirdRun.runId)).length).toBeGreaterThanOrEqual(1);
            expect(h.notified.every(item => item.clientMessageId.endsWith(":terminal"))).toBe(true);
        } finally {
            await h.stop();
            await db.end();
        }
    });

    it("orders a cancel and the run's begin under the same locks: before begin the cancel ends the run, after begin the controller applies it", { timeout: TIMEOUT }, async () => {
        // Each run's begin holds at a gate, before or after the begin transaction (its store call), while the
        // controller instance exists and runs the begin activity.
        const gates = new Map();
        const h = await harness(getEnv(), {
            wrapStore: (store) => {
                const watched = Object.create(store);
                watched.beginRun = async (runId, projection) => {
                    const held = gates.get(runId);
                    if (held?.when === "before") { held.arrive(); await held.wait(); }
                    const begun = await store.beginRun(runId, projection);
                    if (held?.when === "after") { held.arrive(); await held.wait(); }
                    return begun;
                };
                return watched;
            },
        });
        try {
            const parent = await parentOf(h);
            // The run is admitted without its dispatch, its gate is set, and then its controller starts, so its begin meets the gate.
            const started = async (when) => {
                const id = randomUUID();
                const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
                const run = (await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                    actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
                const held = gate();
                gates.set(run.runId, { ...held, when });
                await h.client.startOrchestrationVersioned(run.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME,
                    { v: 2, workflowSessionId: id, runId: run.runId }, WORKFLOW_V2_CONTROLLER_VERSION);
                await held.reached;
                return { id, ...run, open: held.open };
            };

            // The cancel commits first, while the instance runs and its begin waits: the run ends at once.
            for (const pausedFirst of [false, true]) {
                const run = await started("before");
                expect((await h.client.getStatus(run.controllerInstanceId)).status).toBe("Running");
                if (pausedFirst) {
                    expect(await parent.update(run.id, { operation: "pause", operation_id: "pause" })).toMatchObject({ ok: true, status: "paused" });
                    expect(await h.store.readRun(run.runId)).toMatchObject({ status: "paused", pausedFrom: "admitted" });
                }
                const cancel = await parent.update(run.id, { operation: "cancel", operation_id: "cancel", reason: "early" });
                expect(cancel, JSON.stringify(cancel)).toMatchObject({ ok: true, replayed: false, status: "cancelled" });
                run.open();
                // Begin then finds the run ended: it changes nothing, and the controller admits nothing.
                expect((await h.client.waitForOrchestration(run.controllerInstanceId, 30_000)).status).toBe("Completed");
                expect(await h.store.readRun(run.runId)).toMatchObject({ status: "cancelled", pausedFrom: null,
                    terminalError: { message: "early", details: { beforeBegin: true, operationId: "cancel" } } });
                expect(await h.store.listNodeExecutions(run.runId)).toEqual([]);
                expect(await h.host.catalog.getSessionEvents(run.id, 0, 50, ["workflow.started"])).toEqual([]);
            }

            // Begin commits first: the cancel finds a begun run, its receipt says so, and the controller,
            // which began the run, takes the queued command before it admits anything.
            const run = await started("after");
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "running" });
            const cancel = await parent.update(run.id, { operation: "cancel", operation_id: "cancel", reason: "late" });
            expect(cancel, JSON.stringify(cancel)).toMatchObject({ ok: true, replayed: false, status: "running" });
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "running" });
            run.open();
            const ended = await finished(h, run.runId);
            expect(ended).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled", message: "late",
                details: { command: "cancel", requestedBy: parent.parentId } } });
            expect(ended.terminalError.details.beforeBegin).toBeUndefined();
            expect(await h.store.listNodeExecutions(run.runId)).toEqual([]);
            expect((await h.client.waitForOrchestration(run.controllerInstanceId, 30_000)).status).toBe("Completed");
            // The first run end stands: a later cancel is accepted against the ended run and changes nothing.
            expect(await parent.update(run.id, { operation: "cancel", operation_id: "cancel-again", reason: "again" }))
                .toMatchObject({ ok: true, replayed: false, status: "cancelled" });
            expect(await h.store.readRun(run.runId)).toEqual(ended);
        } finally {
            for (const held of gates.values()) held.open();
            await h.stop();
        }
    });

    it("loses a command queued before its controller started (the PostgreSQL provider drops it); a cancel accepted that way ends the run on its repeat or at its begin", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        // Fault injection: the begin of the run named here is interrupted once, after its transaction commits.
        let interruptBeginOf = null;
        const h = await harness(env, {
            notify: true,
            wrapStore: (store) => {
                const watched = Object.create(store);
                watched.beginRun = async (runId, projection) => {
                    const begun = await store.beginRun(runId, projection);
                    if (interruptBeginOf === runId) {
                        interruptBeginOf = null;
                        throw new Error("injected: interrupted after the begin transaction committed");
                    }
                    return begun;
                };
                return watched;
            },
        });
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parent = await parentOf(h);
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const lost = async (id) => (await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: { mode: "recovered" } } })).receipt.run;
            const provider = async (instanceId) => {
                const count = async (table) => Number((await db.query(
                    `SELECT count(*) AS n FROM "${env.duroxideSchema}".${table} WHERE instance_id = $1`, [instanceId])).rows[0].n);
                return { queued: await count("orchestrator_queue"), instances: await count("instances"), executions: await count("executions") };
            };
            // The cancel command an earlier build queued for the run's controller, as controlWorkflowV2Run sent it.
            const earlierCancel = (operationId, reason) => JSON.stringify({ type: "cmd", cmd: "cancel", id: `cancel-${operationId}`,
                args: { reason }, requestedBy: parent.parentId });
            // duroxide-pg 0.1.38 fetches the message of an instance with no row and no history as orchestration
            // "Unknown" and drops a batch of only queue messages: it acknowledges it with no history, which deletes
            // the queue row and records an execution row, and creates no instance.
            const dropped = async (instanceId) => {
                expect(await provider(instanceId)).toEqual({ queued: 0, instances: 0, executions: 0 });
                await h.client.enqueueEvent(instanceId, "messages", earlierCancel("old", "old cancel"));
                return until(async () => {
                    const rows = await provider(instanceId);
                    return rows.queued === 0 && rows.executions === 1 && rows.instances === 0 ? rows : null;
                }, "the provider to drop the queued command");
            };

            // Negative control: the dropped command is gone, so a later start (recover's dispatch) runs the
            // whole run although a cancel was queued for it.
            const x = randomUUID();
            const runX = await lost(x);
            await dropped(runX.controllerInstanceId);
            expect((await h.client.getStatus(runX.controllerInstanceId)).status).toBe("NotFound");
            expect(await parent.update(x, { operation: "recover", operation_id: "recover" })).toMatchObject({ ok: true, action: "dispatched" });
            // The terminal reads kv.mode, which this fixture sets: the run completes with its declared output.
            const completedX = await finished(h, runX.runId);
            expect(completedX, JSON.stringify(completedX)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done" });
            expect(completedX.terminalOutput.mode).toBe("recovered");
            expect((await h.store.listNodeExecutions(runX.runId)).map(node => [node.nodeId, node.outcome])).toEqual([["first", "ok"], ["second", "ok"], ["done", "succeeded"]]);

            // A cancel an earlier build accepted, exactly as it stored it (receipt with the run's status then), whose
            // command the provider dropped. Its repeat ends the run now; the stored receipt stays as it was.
            const y = randomUUID();
            const runY = await lost(y);
            const receipt = { workflowSessionId: y, operation: "cancel", runId: runY.runId, status: "admitted", kvRevision: 1 };
            await db.query(`INSERT INTO "${env.cmsSchema}".workflow_operations (workflow_session_id, operation_id, kind, request_sha256, receipt)
                VALUES ($1, $2, 'cancel', $3, $4)`, [y, "old", jsonSha256({ kind: "cancel", runId: runY.runId, reason: "old cancel" }), canonicalJson(receipt)]);
            await dropped(runY.controllerInstanceId);
            const storedReceipt = async () => (await db.query(`SELECT kind, request_sha256, receipt, created_at FROM "${env.cmsSchema}".workflow_operations
                WHERE workflow_session_id = $1 AND operation_id = $2`, [y, "old"])).rows;
            const before = await storedReceipt();
            expect(before).toHaveLength(1);
            // Another request with the same operation id is refused and changes nothing.
            expect(await parent.update(y, { operation: "cancel", operation_id: "old", reason: "a different reason" }))
                .toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            expect(await h.store.readRun(runY.runId)).toMatchObject({ status: "admitted" });
            // The repeat returns the accept-time receipt as stored; the run, which has not begun, ends now.
            const repeat = await parent.update(y, { operation: "cancel", operation_id: "old", reason: "old cancel" });
            expect(repeat, JSON.stringify(repeat)).toEqual({ ok: true, workflowId: y, operation: "cancel", replayed: true, runId: runY.runId, status: "admitted", kvRevision: 1 });
            expect(await h.store.readRun(runY.runId)).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled", message: "old cancel",
                details: { command: "cancel", requestedBy: parent.parentId, operationId: "old", beforeBegin: true, repaired: true } } });
            expect((await parent.read(y)).run.status).toBe("cancelled");
            expect(await storedReceipt()).toEqual(before);
            // A further repeat returns the same receipt and changes nothing more.
            expect(await parent.update(y, { operation: "cancel", operation_id: "old", reason: "old cancel" })).toEqual(repeat);
            expect((await h.host.catalog.getSessionEvents(y, 0, 50, ["workflow.cancelled"])).map(event => event.data))
                .toEqual([expect.objectContaining({ runId: runY.runId, beforeBegin: true, repaired: true, operationId: "old" })]);
            expect(await parent.update(y, { operation: "recover", operation_id: "recover" })).toMatchObject({ ok: true, action: "none", status: "cancelled" });
            expect(await h.store.listNodeExecutions(runY.runId)).toEqual([]);
            expect((await h.client.getStatus(runY.controllerInstanceId)).status).toBe("NotFound");

            // The parent's repeat repaired runY: it asked for the cancel, so it is not told of it.
            expect((await h.client.getStatus(workflowNotifyInstanceId(runY.runId))).status).toBe("NotFound");

            // The same earlier-build cancel, but nobody repeats it: a recover dispatches the run (z), or the original
            // dispatch arrives late (w), and begin finds the accepted cancel and ends the run instead of beginning it.
            // The earlier receipt records no requester. Under migration assumption M1 (README: update_workflow, which admits
            // only the parent, wrote such receipts) the end attributes the cancel to the parent and does not tell the parent.
            const stableId = (workflowId, runId) => `workflow:${workflowId}:${runId}:terminal`;
            const seedEarlierCancel = async (id, run) => {
                await db.query(`INSERT INTO "${env.cmsSchema}".workflow_operations (workflow_session_id, operation_id, kind, request_sha256, receipt)
                    VALUES ($1, $2, 'cancel', $3, $4)`, [id, "old", jsonSha256({ kind: "cancel", runId: run.runId, reason: "old cancel" }),
                    canonicalJson({ workflowSessionId: id, operation: "cancel", runId: run.runId, status: "admitted", kvRevision: 1 })]);
                await dropped(run.controllerInstanceId);
            };
            const endedByBegin = async (id, run) => {
                expect((await h.client.waitForOrchestration(run.controllerInstanceId, 30_000)).status).toBe("Completed");
                expect(await h.store.readRun(run.runId)).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled",
                    message: "Cancelled before it began", details: { command: "cancel", requestedBy: parent.parentId, attributedFrom: "update_workflow",
                        operationId: "old", beforeBegin: true, repaired: true } } });
                expect(await h.store.listNodeExecutions(run.runId)).toEqual([]);
                expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.started"])).toEqual([]);
                expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.cancelled"])).toHaveLength(1);
                // The parent's own repeat of that cancel returns the stored receipt and is not reported to it either.
                expect(await parent.update(id, { operation: "cancel", operation_id: "old", reason: "old cancel" }))
                    .toEqual({ ok: true, workflowId: id, operation: "cancel", replayed: true, runId: run.runId, status: "admitted", kvRevision: 1 });
                expect((await h.client.getStatus(workflowNotifyInstanceId(run.runId))).status).toBe("NotFound");
                expect(h.notified.filter(item => item.clientMessageId === stableId(id, run.runId))).toEqual([]);
                expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.parent_notified", "workflow.parent_notification_skipped"])).toEqual([]);
            };
            const z = randomUUID();
            const runZ = await lost(z);
            await seedEarlierCancel(z, runZ);
            // Its first begin is interrupted after the transaction that ended the run; the retry ends nothing twice.
            interruptBeginOf = runZ.runId;
            expect(await parent.update(z, { operation: "recover", operation_id: "recover" })).toMatchObject({ ok: true, action: "dispatched" });
            await endedByBegin(z, runZ);
            expect(interruptBeginOf).toBeNull();
            const w = randomUUID();
            const runW = await lost(w);
            await seedEarlierCancel(w, runW);
            await h.client.startOrchestrationVersioned(runW.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, { v: 2, workflowSessionId: w, runId: runW.runId },
                WORKFLOW_V2_CONTROLLER_VERSION);
            await endedByBegin(w, runW);
        } finally {
            await h.stop();
            await db.end();
        }
    });

    it("tells the parent of a run another requester's cancel ended before it began when its controller starts, after an interruption at each step", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        // Fault injection: the begin of the run named here is interrupted once, after its transaction commits.
        let interruptBeginOf = null;
        const h = await harness(env, {
            notify: true,
            wrapStore: (store) => {
                const watched = Object.create(store);
                watched.beginRun = async (runId, projection) => {
                    const begun = await store.beginRun(runId, projection);
                    if (interruptBeginOf === runId) {
                        interruptBeginOf = null;
                        throw new Error("injected: interrupted after the begin transaction committed");
                    }
                    return begun;
                };
                return watched;
            },
        });
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const { runId, controllerInstanceId } = (await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent.parentId,
                yaml: TWO_STATES, actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
            // Another requester's cancel commits; its request stops before it starts the notifier, and it is never repeated.
            const notifierStartFails = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async (instanceId, ...rest) => {
                if (instanceId === workflowNotifyInstanceId(runId)) throw new Error("injected: interrupted before the notifier started");
                return h.host.duroxideClient.startOrchestrationVersioned(instanceId, ...rest);
            } } };
            await expect(controlWorkflowV2Run(notifierStartFails, id, { operation: "cancel", runId: null, reason: "stop it" },
                { actor: { kind: "system", name: "workflow-v2-control-test-user" }, operationId: "cancel-n" }))
                .rejects.toThrow("injected: interrupted before the notifier started");
            const ended = await h.store.readRun(runId);
            expect(ended).toMatchObject({ status: "cancelled", terminalError: { details: { requestedBy: null, operationId: "cancel-n", beforeBegin: true } } });
            expect((await h.client.getStatus(workflowNotifyInstanceId(runId))).status).toBe("NotFound");
            expect(h.notified).toEqual([]);

            // The original dispatch arrives late. Its begin changes nothing, is interrupted after its transaction, and its
            // retry starts the notifier: the parent is told once, with the stable client message id.
            interruptBeginOf = runId;
            await h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, { v: 2, workflowSessionId: id, runId },
                WORKFLOW_V2_CONTROLLER_VERSION);
            expect((await h.client.waitForOrchestration(controllerInstanceId, 30_000)).status).toBe("Completed");
            expect(interruptBeginOf).toBeNull();
            expect((await h.client.waitForOrchestration(workflowNotifyInstanceId(runId), 30_000)).status).toBe("Completed");
            const told = h.notified.filter(item => item.clientMessageId === `workflow:${id}:${runId}:terminal`);
            expect(told.length).toBeGreaterThanOrEqual(1);
            expect(told.every(item => item.parentSessionId === parent.parentId)).toBe(true);
            expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.parent_notified"])).toHaveLength(1);
            // The run is as the cancel ended it; nothing began.
            expect(await h.store.readRun(runId)).toEqual(ended);
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
            expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.started"])).toEqual([]);
        } finally { await h.stop(); }
    });

    it("keeps any valid KV key, \"__proto__\" and \"constructor\" included, as plain data through every update", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const held = h.hold(id);
            // Parsed JSON, as tool arguments arrive: "__proto__" is an own data property here.
            const initial = JSON.parse('{"__proto__": 7, "constructor": "c", "toString": null, "mode": "a"}');
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: KEYS,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: initial } });
            const { runId } = created.receipt.run;
            await held.reached;
            const set = (operationId, setJson, expected) => parent.update(id,
                { operation: "set_vars", operation_id: operationId, set: JSON.parse(setJson), expected_kv_revision: expected });
            const at = async (revision) => entriesOf(await h.store.readKv(runId, revision));
            expect(await at(1)).toEqual({ plain: true, entries: [["__proto__", 7], ["constructor", "c"], ["mode", "a"], ["toString", null]] });

            // An unrelated update keeps the key and its value.
            expect(await set("mode-b", '{"mode": "b"}', 1)).toMatchObject({ ok: true, kvRevision: 2 });
            expect(await at(2)).toEqual({ plain: true, entries: [["__proto__", 7], ["constructor", "c"], ["mode", "b"], ["toString", null]] });
            // A direct set of null, its replay, then an object value carried through another unrelated update.
            const toNull = await set("proto-null", '{"__proto__": null}', 2);
            expect(toNull).toMatchObject({ ok: true, replayed: false, kvRevision: 3 });
            expect(await set("proto-null", '{"__proto__": null}', 2)).toEqual({ ...toNull, replayed: true });
            expect(await at(3)).toEqual({ plain: true, entries: [["__proto__", null], ["constructor", "c"], ["mode", "b"], ["toString", null]] });
            expect(await set("proto-object", '{"__proto__": {"a": 1}}', 3)).toMatchObject({ ok: true, kvRevision: 4 });
            expect(await set("mode-c", '{"mode": "c"}', 4)).toMatchObject({ ok: true, kvRevision: 5 });
            expect(await at(5)).toEqual({ plain: true, entries: [["__proto__", { a: 1 }], ["constructor", "c"], ["mode", "c"], ["toString", null]] });
            // Only an explicit delete removes it.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "proto-delete", delete: ["__proto__"], expected_kv_revision: 5 }))
                .toMatchObject({ ok: true, kvRevision: 6 });
            expect(await at(6)).toEqual({ plain: true, entries: [["constructor", "c"], ["mode", "c"], ["toString", null]] });
            const view = (await parent.read(id)).run;
            expect(view.kvRevision).toBe(6);
            expect(entriesOf(JSON.parse(view.kv)).entries).toEqual([["constructor", "c"], ["mode", "c"], ["toString", null]]);

            // The running script keeps revision 1, "__proto__" as own data; the terminal reads revision 6.
            held.open();
            const run = await finished(h, runId);
            expect(run.status, JSON.stringify(run)).toBe("completed");
            const [act, done] = await h.store.listNodeExecutions(runId);
            expect([act.kvRevision, done.kvRevision]).toEqual([1, 6]);
            expect(act.output).toEqual({ keys: ["__proto__", "constructor", "mode", "toString"], proto: 7, plain: true });
            expect(run.terminalOutput).toEqual({ seen: act.output, proto: "deleted", ctor: "c" });
        } finally { await h.stop(); }
    });

    it("pins the KV revision current when an admission commits, even when set_vars commits while it is evaluated", { timeout: TIMEOUT }, async () => {
        const reads = [];
        let armed = false;
        const evaluating = gate();
        // The first KV read of the run is the evaluation of its first admission; it waits there.
        const h = await harness(getEnv(), {
            wrapStore: (store) => {
                const watched = Object.create(store);
                watched.readKv = async (runId, revision) => {
                    if (armed) {
                        reads.push(revision);
                        if (reads.length === 1) { evaluating.arrive(); await evaluating.wait(); }
                    }
                    return store.readKv(runId, revision);
                };
                return watched;
            },
        });
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            armed = true;
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: ONE_STATE,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: { mode: "a" } } });
            const { runId } = created.receipt.run;
            await evaluating.reached;
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
            // set_vars commits after the evaluation read revision 1 and before the admission commits.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "during", set: { mode: "b" }, expected_kv_revision: 1 }))
                .toMatchObject({ ok: true, kvRevision: 2 });
            evaluating.open();
            const run = await finished(h, runId);
            expect(run.status, JSON.stringify(run)).toBe("completed");
            // The admission was refused for the changed revision and evaluated again with revision 2.
            expect(reads.slice(0, 2)).toEqual([1, 2]);
            const [first] = await h.store.listNodeExecutions(runId);
            expect(first).toMatchObject({ nodeId: "first", ordinal: 1, kvRevision: 2, input: { mode: "b" } });
            expect(first.output).toEqual({ kv: { mode: "b" }, input: { mode: "b" } });
            const started = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.state_started"]);
            expect(started.map(event => [event.data.stateId, event.data.kvRevision])).toEqual([["first", 2], ["done", 2]]);
        } finally { await h.stop(); }
    });

    it("ends the run as failed with KV_CHANGING when set_vars commits during every evaluation of every attempt of one admission", { timeout: TIMEOUT }, async () => {
        // The production budget this checks: five evaluations per attempt, five attempts of the store retry policy.
        expect([WORKFLOW_V2_ADMISSION_EVALUATIONS, WORKFLOW_V2_STORE_RETRY.maxAttempts]).toEqual([5, 5]);
        let target = null;
        let change = null;
        const reads = [];
        const changes = [];
        // Fault injection: before each evaluation of the target run's first admission reaches the store, a set_vars
        // commits, so the store refuses the admission for the revision it was evaluated with (kv_changed).
        const h = await harness(getEnv(), {
            wrapStore: (store) => {
                const watched = Object.create(store);
                watched.enterNode = async (input) => {
                    if (input.runId === target && input.nodeId === "first") {
                        reads.push(input.kvRevision);
                        changes.push(await change(input.kvRevision, reads.length));
                    }
                    return store.enterNode(input);
                };
                return watched;
            },
        });
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const created = await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: ONE_STATE,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: { mode: "a" } } });
            const { runId, controllerInstanceId } = created.receipt.run;
            change = (revision, n) => parent.update(id, { operation: "set_vars", operation_id: `change-${n}`, set: { mode: `m${n}` },
                expected_kv_revision: revision });
            target = runId;
            await h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, { v: 2, workflowSessionId: id, runId },
                WORKFLOW_V2_CONTROLLER_VERSION);
            const run = await finished(h, runId);
            expect(run.status, JSON.stringify(run)).toBe("failed");
            expect(run.terminalError).toMatchObject({ code: "controller_error" });
            expect(run.terminalError.message).toContain("changed during each of 5 evaluations of state 'first'");
            // Twenty-five evaluations, each with the revision the one before it changed: five attempts of five.
            expect(reads).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
            expect(changes.map(changed => [changed.ok, changed.kvRevision])).toEqual(Array.from({ length: 25 }, (_, index) => [true, index + 2]));
            // Nothing was admitted, and the controller ended the run through its failure path.
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
            expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.state_started"])).toEqual([]);
            const controller = await h.client.waitForOrchestration(controllerInstanceId, 30_000);
            expect(controller.status, JSON.stringify(controller)).toBe("Completed");
            expect(controller.output).toEqual({ runId, status: "failed", outcome: null });
            expect(await h.store.readRun(runId)).toMatchObject({ status: "failed", kvRevision: 26 });
        } finally { await h.stop(); }
    });
});

describe("workflow v2 bindings name any KV key", () => {
    it("reads ??, quotes, backslashes, ${ and } inside a JSON-string key or default as data, and still refuses them outside one", () => {
        // The YAML spells the texts of READ_INPUT, and the compiler accepts them unchanged.
        const compiled = compileWorkflowV2(BINDING_KEYS);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.nodes.read.input).toEqual(READ_INPUT);
        expect(compiled.ir.nodes.done.output.viaKv).toBe('${kv["back\\\\slash??"]}');

        const parse = (text) => parseBindingExpression(text, "$");
        const kvPath = (segments, more = {}) => ({ root: "kv", segments, hasDefault: false, defaultValue: null, ...more });
        expect(parse(READ_INPUT.op)).toEqual(kvPath([KEY.op]));
        expect(parse(READ_INPUT.opNull)).toEqual(kvPath([KEY.op], { hasDefault: true }));
        expect(parse(READ_INPUT.quoted)).toEqual(kvPath([KEY.quoted]));
        expect(parse(READ_INPUT.slash)).toEqual(kvPath([KEY.slash], { hasDefault: true, defaultValue: "unused" }));
        expect(parse(READ_INPUT.end)).toEqual(kvPath([KEY.end], { hasDefault: true, defaultValue: 1 }));
        expect(parse(READ_INPUT.missing)).toEqual(kvPath(["no??such"], { hasDefault: true, defaultValue: "fallback ?? text" }));
        expect(parse(READ_INPUT.dollar)).toEqual(kvPath([KEY.dollar]));
        expect(parse(READ_INPUT.brace)).toEqual(kvPath([KEY.brace], { hasDefault: true, defaultValue: "}" }));
        expect(parse('${input[ "x]??y" ][0].z}')).toEqual({ root: "input", segments: ["x]??y", 0, "z"], hasDefault: false, defaultValue: null });
        expect(parse('${kv.a ?? "${b}"}')).toEqual(kvPath(["a"], { hasDefault: true, defaultValue: "${b}" }));
        expect(parse("plain ?? text")).toBeNull();

        // Present, own null and missing, with and without a default.
        const scope = { inputs: {}, input: { "x]??y": [{ z: 3 }] }, kv: VARS, runtime: null };
        expect(evaluateBindingTemplate(READ_INPUT, scope)).toEqual(SEEN);
        expect(evaluateBindingTemplate({ deep: '${input[ "x]??y" ][0].z}', text: "plain ?? text" }, scope)).toEqual({ deep: 3, text: "plain ?? text" });
        expect(() => evaluateBindingTemplate('${kv["no??such"]}', scope, "$.missing")).toThrow("$.missing: could not resolve 'no??such' of kv");

        // Outside a JSON string, a second expression, a bad bracket or a bad default is still refused.
        const refusal = (text) => {
            try { parse(text); }
            catch (error) { return error instanceof WorkflowBindingError ? [error.code, error.message] : String(error); }
            return null;
        };
        const exactlyOne = ["WORKFLOW_BINDING_INVALID", "$: a value that uses ${...} must be exactly one expression"];
        const invalid = (message) => ["WORKFLOW_BINDING_INVALID", `$: ${message}`];
        expect([
            '${kv.a}${kv.b}', 'x ${kv["a??b"]}', '${kv["a"] ?? null} ${kv.b}', '${kv["a" x]}', '${kv["open]}', '${kv["a"}',
            '${kv["a"] ?? nope}', '${kv["a"] ?? "x" ?? "y"}', '${kv[1.5]}', '${kv["\\x"]}',
        ].map(refusal)).toEqual([
            exactlyOne, exactlyOne, exactlyOne,
            invalid(`bracket segment must be an index or a JSON string near '["a" x]'`),
            invalid(`unclosed '[' near '["open]'`),
            invalid(`unclosed '[' near '["a"'`),
            invalid("default 'nope' must be a JSON literal"),
            invalid(`default '"x" ?? "y"' must be a JSON literal`),
            invalid("bracket segment must be an index or a JSON string near '[1.5]'"),
            invalid(`bracket segment must be an index or a JSON string near '["\\x"]'`),
        ]);
        // The compiler reports a refused binding at the template that holds it.
        const refused = compileWorkflowV2(BINDING_KEYS.replace(READ_INPUT.opNull, READ_INPUT.opNull.replace("null", "nope")));
        expect(refused.valid).toBe(false);
        expect(refused.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", code: "WORKFLOW_BINDING_INVALID",
            path: "states.read.input", message: "states.read.input.opNull: default 'nope' must be a JSON literal" }));
    });

    it("gives a typed script the values those keys name, and a typed terminal its output; a wrong type fails the input contract", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const start = async (vars) => {
                const id = randomUUID();
                const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: BINDING_KEYS,
                    actor: ACTOR, operationId: "start", start: { inputs: { "x??y": 5 }, vars } });
                return { id, runId: created.receipt.run.runId };
            };
            const typed = await start(VARS);
            const run = await finished(h, typed.runId);
            expect(run, JSON.stringify(run)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "done" });
            const [read, done] = await h.store.listNodeExecutions(typed.runId);
            expect(read).toMatchObject({ nodeId: "read", outcome: "ok", winner: "effect", kvRevision: 1, input: SEEN });
            expect(read.output).toEqual({ seen: SEEN, keys: Object.keys(VARS).sort() });
            expect(done).toMatchObject({ nodeId: "done", kvRevision: 1 });
            expect(run.terminalOutput).toEqual({ seen: SEEN, quoted: "q", viaKv: "s", missing: "absent ?? here", fromInputs: 5 });
            expect(entriesOf(JSON.parse((await parent.read(typed.id)).run.kv))).toEqual(entriesOf(VARS));

            // The same bindings with a string where the contract wants an integer: op and opNull both name the
            // key "a??b", whose value is now "1" (a present value is never replaced by a default). The input
            // contract refuses both before any script starts.
            const wrong = await start({ ...VARS, [KEY.op]: "1" });
            const blocked = await finished(h, wrong.runId);
            expect(blocked, JSON.stringify(blocked)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "bad",
                terminalOutput: { code: "invalid_input", message: "Input does not match Seen." } });
            expect(blocked.terminalOutput.details.map(problem => problem.path).sort()).toEqual(["/op", "/opNull"]);
            const [refused] = await h.store.listNodeExecutions(wrong.runId);
            expect(refused).toMatchObject({ nodeId: "read", outcome: "invalid_input", resultKind: "runtime_error", winner: "controller", effectAttempts: 0 });
            expect(refused.input).toEqual({ ...SEEN, op: "1", opNull: "1" });
            // No effect orchestration was started for the refused state.
            expect((await h.client.getStatus(workflowEffectInstanceId(refused.nodeExecutionId))).status).toBe("NotFound");
        } finally { await h.stop(); }
    });
});
