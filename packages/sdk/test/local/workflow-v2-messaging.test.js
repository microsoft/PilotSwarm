/**
 * Workflow v2 messaging receive states and typed input on the real durable
 * runtime (duroxide PostgreSQL provider) and the real PostgreSQL store
 * (design R07, R08; test plan T053, T054, T055, T059, T060, T064, T067, T028):
 *
 * - a receive state takes one typed message of its contract, from its
 *   sender and with its correlation, that a sender gave the run with
 *   send_workflow_input, before or after the state was entered, in the
 *   run's durable order; an expired message is not taken;
 * - its optional wait races the message and the store decides: an input
 *   accepted before the deadline claims the receive in its own transaction,
 *   one accepted at or after it is late for it and stays for a later
 *   receive, and a wait that elapses first does not discard it; a later
 *   receive takes it at entry only while it is unexpired, however late
 *   that entry is;
 * - a wrong sender, contract or correlation is not taken and does not move
 *   the deadline; an undeclared contract or an invalid payload stores
 *   nothing;
 * - only the workflow's live parent, or a live session owned by the same
 *   user as the workflow (provider and subject exactly equal), may send:
 *   unknown, partial, blank or system ownership on either side grants
 *   nothing, and another identity is refused; a receive may not name such a
 *   sender (forbidden), nor a deleted one, its parent included
 *   (unavailable), even when that sender's earlier input waits; the store
 *   decides the sender in the transaction that admits the receive or
 *   accepts a fresh input, so a sender deleted after the receive was
 *   resolved, or after the send was checked, is refused there; since stage
 *   2.1 (R5, migration 0107) deleting a Workflow's own parent (the chat
 *   that owns it) deletes the Workflow and cancels its run with it, so its
 *   receive is never entered;
 * - one reading of the store's clock decides each acceptance and each
 *   entry, compared and recorded exactly (microseconds): an input accepted
 *   at its receive's deadline is late, one a microsecond earlier wins; a
 *   receive takes at entry only an input unexpired at its own reading,
 *   however late its entry commits;
 * - the acceptance's receipt names the request and payload it accepted and
 *   is returned unchanged to every repeat; the read view shows what
 *   happened to the input since;
 * - a paused run takes input, and its receive may take it, but it admits
 *   nothing until it is resumed;
 * - each input is accepted once per (sender, operation id), and the inbox is
 *   bounded.
 *
 * The receive model (docs/formal/workflow-v2, README "Receive model")
 * checks these boundaries within its bounds; these regressions are their
 * native evidence, and the rest's.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_IR_VERSION, WORKFLOW_V2_MESSAGING_IR_VERSION, WORKFLOW_V2_WAIT_IR_VERSION,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/v2/json.ts";
import { WorkflowStore } from "../../src/workflow/v2/store.ts";
import { TYPED_INPUT_REFUSALS } from "../../src/workflow/v2/authority.ts";
import { createWorkflowV2, WORKFLOW_V2_INBOX_LIMITS } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, sendWorkflowInputFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_CONTROLLER_VERSION, workflowEffectInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-messaging-test" };

const SCHEMAS = `
schemas:
  BuildEvent:
    type: object
    additionalProperties: false
    required: [buildId, state]
    properties:
      buildId: { type: integer, minimum: 1 }
      state: { type: string, enum: [running, succeeded, failed] }
contracts:
  BuildEvent@1: { schema: { $ref: "#/schemas/BuildEvent" } }
`;

/** One receive state, optionally from a named sender (from the KV) and racing a wait (seconds from the KV). */
const RECEIVER = ({ from = "", wait = true } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: receiver, version: "1.0.0" }
inputs: { schema: { type: object, required: [buildId], properties: { buildId: { type: integer } } } }
initialInput: { asked: "\${inputs.buildId}" }
initial: await_build
${SCHEMAS}
states:
  await_build:
    type: messaging
    mode: receive
    contract: BuildEvent@1
${from ? `    from: "\${kv.reporter}"\n` : ""}    correlate: { buildId: "\${inputs.buildId}" }
${wait ? `    wait: { seconds: "\${kv.secs}" }\n` : ""}    transition: { next: { received: got${wait ? ", elapsed: timed_out" : ""}, forbidden: refused, unavailable: refused, invalid_input: refused } }
  got: { type: terminal, outcome: succeeded, output: "\${input}" }
  timed_out: { type: terminal, outcome: blocked, output: "\${input}" }
  refused: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

/** One receive state from the workflow's parent, with no wait: received is its only outcome. */
const PARENT_RECEIVER = RECEIVER({ wait: false }).replace("    correlate:", "    from: { parent: true }\n    correlate:");

/** A receive whose 1 s wait elapses, then a gap (seconds from the KV), then the same receive again. */
const POLLER = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: poller, version: "1.0.0" }
initialInput: {}
initial: await_build
limits: { maxNodeExecutions: 12 }
${SCHEMAS}
states:
  await_build:
    type: messaging
    mode: receive
    contract: BuildEvent@1
    wait: { seconds: 1 }
    transition: { next: { received: got, elapsed: gap } }
  gap:
    type: wait
    seconds: "\${kv.gap}"
    transition: { next: { elapsed: await_build } }
  got: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

/** As POLLER, with the receive's wait from the KV (seconds). */
const KV_POLLER = POLLER.replace("    wait: { seconds: 1 }\n", '    wait: { seconds: "${kv.secs}" }\n');

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/**
 * A worker-equivalent registration with one durable provider; `refusals` lists runs whose admission was refused for a pause,
 * and `withheld` runs whose results a collection kept from the controller while paused.
 * With `storePool`, the runtime's store runs on that pool (a test pool that can hold a statement); tool calls use the catalog's.
 * With `wrapStore`, the runtime's store is the one it returns for that store (a test store that can stop a method).
 */
async function harness(env, { wakeBackstopMs = 500, storePool = null, wrapStore = null } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const baseStore = storePool ? new WorkflowStore(storePool, env.cmsSchema) : store;
    const runtimeStore = wrapStore ? wrapStore(baseStore) : baseStore;
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
    const direct = new pg.Pool({ connectionString: env.store, max: 2 });
    const refusals = [];
    const withheld = [];
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, name === WORKFLOW_V2_ACTIVITIES.collect ? async (ctx, input) => {
            // Review R2-RT-1: a collection that reported the run paused while results of the work it asked about were stored.
            const collected = await fn(ctx, input);
            if (collected?.paused === true && input.nodeExecutionIds.length > 0
                && (await store.readCompletedNodes(input.runId, input.nodeExecutionIds)).length > 0) withheld.push(input.runId);
            return collected;
        } : name !== WORKFLOW_V2_ACTIVITIES.enter ? fn : async (ctx, input) => {
            const entered = await fn(ctx, input);
            if (entered.admitted === false && entered.status === "paused") refusals.push(input.runId);
            return entered;
        }),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: runtimeStore, catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs,
    });
    await runtime.start();
    const host = { catalog, store, duroxideClient: client };
    return {
        catalog, store, client, refusals, withheld, host,
        /** The host with a controller start that never reaches duroxide: a run stays admitted, its controller absent. */
        undispatched: { ...host, duroxideClient: { ...client, startOrchestrationVersioned: async () => undefined,
            getStatus: id => client.getStatus(id), enqueueEvent: (...args) => client.enqueueEvent(...args) } },
        /** A query on the test database: SCHEMA. names this test's catalog schema; times compared in SQL keep their microseconds. */
        async q(text, params = []) {
            return (await direct.query(text.replaceAll("SCHEMA.", `"${env.cmsSchema}".`), params)).rows;
        },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
            await direct.end();
        },
    };
}

/**
 * A pool for the runtime's store that holds a receive's entry (fault injection). When the entry's claim-selection
 * statement returns a message of `hold.runId`, the entry's transaction waits on its own connection until the
 * store's clock is past that message's expiry (recorded exactly in `hold.heldUntil`), then goes on to its insert and
 * commit. It holds once.
 */
function holdingPool(env) {
    const pool = new pg.Pool({ connectionString: env.store, max: 8 });
    const inbox = `"${env.cmsSchema}".workflow_inbox`;
    const hold = { runId: null, messageId: null, heldUntil: null };
    const holding = client => ({
        async query(text, params) {
            const result = await client.query(text, params);
            const sql = typeof text === "string" ? text : text.text;
            if (hold.runId !== null && hold.messageId === null && Array.isArray(params) && params[0] === hold.runId && result.rows[0]
                && sql.includes("workflow_inbox") && sql.includes("consumed_by IS NULL") && sql.includes("FOR UPDATE")) {
                hold.messageId = result.rows[0].message_id;
                const deadline = Date.now() + 20_000;
                for (;;) {
                    const { rows } = await client.query(`SELECT clock_timestamp() > expires_at AS past, clock_timestamp()::text AS at
                        FROM ${inbox} WHERE message_id = $1`, [hold.messageId]);
                    if (rows[0].past) {
                        hold.heldUntil = rows[0].at;
                        break;
                    }
                    if (Date.now() > deadline) throw new Error(`Message ${hold.messageId} did not expire while its receive's entry was held.`);
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
            return result;
        },
        release: (...args) => client.release(...args),
    });
    return { hold, pool: { connect: async () => holding(await pool.connect()), query: (text, params) => pool.query(text, params), end: () => pool.end() } };
}

/** `promise`'s value, or an error after `ms`. */
async function within(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
        })]);
    } finally { clearTimeout(timer); }
}

/**
 * Stop a store method before it runs (fault injection). `wrap(store)` gives a store whose `method`, called with an
 * input that `matches` the armed stop's spec, waits until the test releases the stop and then calls the real method:
 * nothing of that call has reached the database while it waits. `arm(spec)` arms one stop, which stops one call; the
 * stop records the call's input.
 */
function stopBefore(method, matches) {
    let armed = null;
    return {
        wrap(store) {
            const wrapped = Object.create(store);
            wrapped[method] = async input => {
                const stop = armed !== null && matches(input, armed.spec) ? armed : null;
                if (stop) {
                    armed = null;
                    stop.input = input;
                    stop.reach();
                    await stop.released;
                }
                return store[method](input);
            };
            return wrapped;
        },
        arm(spec) {
            let reach;
            let release;
            const reached = new Promise(resolve => { reach = resolve; });
            const released = new Promise(resolve => { release = resolve; });
            armed = { spec, input: null, reach, reached, released, release };
            return armed;
        },
    };
}

async function finished(store, runId, timeoutMs = 60_000) {
    return until(async () => {
        const run = await store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, timeoutMs);
}

/** A session (parent, peer or stranger) and the tool calls it makes; `system` makes a system session. */
async function sessionOf(h, owner = null, { system = false } = {}) {
    const sessionId = randomUUID();
    await h.catalog.createSession(sessionId, { ...(owner ? { owner } : {}), ...(system ? { isSystem: true } : {}) });
    const context = { callerSessionId: sessionId, host: h.host };
    return {
        sessionId,
        send: async (workflowId, args) => JSON.parse(await sendWorkflowInputFromTool({ workflow_id: workflowId, ...args }, context)),
        update: async (workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        read: async (workflowId, args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
    };
}

/**
 * Link a session to a user row as stored, directly: the catalog registers
 * only complete, trimmed identities and never links a system session, so
 * partial, blank and system ownership exist only as stored data.
 */
async function linkOwner(h, sessionId, provider, subject) {
    const [user] = await h.q(`INSERT INTO SCHEMA.users (provider, subject) VALUES ($1, $2)
        ON CONFLICT (provider, subject) DO UPDATE SET provider = EXCLUDED.provider RETURNING user_id`, [provider, subject]);
    await h.q(`INSERT INTO SCHEMA.session_owners (session_id, user_id) VALUES ($1, $2)
        ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id`, [sessionId, user.user_id]);
}

/** ISO 8601 UTC with microseconds, as the store records its times. */
const EXACT_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

/**
 * The receipt a send returned is the one stored with the input, with the
 * input's exact stored times, and names the request and the payload it
 * accepted.
 */
async function expectStoredReceipt(h, sent, payload) {
    const { ok, replayed, workflowId, ...fields } = sent;
    expect(ok).toBe(true);
    expect(typeof replayed).toBe("boolean");
    const [row] = await h.q(`SELECT receipt, request_sha256, accepted_at = $2::timestamptz AS same_accepted, expires_at = $3::timestamptz AS same_expires,
            to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted
          FROM SCHEMA.workflow_inbox WHERE message_id = $1`, [sent.messageId, sent.acceptedAt, sent.expiresAt]);
    expect(JSON.parse(row.receipt)).toEqual({ workflowSessionId: workflowId, ...fields });
    expect(row).toMatchObject({ request_sha256: sent.requestSha256, same_accepted: true, same_expires: true, accepted: sent.acceptedAt });
    expect(sent.payloadSha256).toBe(sha256Hex(canonicalJson(payload)));
    expect([sent.acceptedAt, sent.expiresAt]).toEqual([expect.stringMatching(EXACT_TIME), expect.stringMatching(EXACT_TIME)]);
}

/** Events of a workflow session that record accepted input and completed states. */
async function inputEvents(h, workflowId) {
    return h.catalog.getSessionEvents(workflowId, 0, 200, ["workflow.input_accepted", "workflow.state_completed"]);
}

/** Start a run of `yaml` for `parent`; with `dispatch: false` its controller is not started. */
async function started(h, parent, yaml, { inputs = { buildId: 7 }, vars = {}, dispatch = true, owner = null } = {}) {
    const id = randomUUID();
    const created = await createWorkflowV2(dispatch ? h.host : h.undispatched, { workflowSessionId: id, parentSessionId: parent.sessionId, owner,
        yaml, actor: ACTOR, operationId: "start", start: { inputs, vars } });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const { runId, controllerInstanceId } = created.receipt.run;
    return {
        id, runId, controllerInstanceId,
        startController: () => h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME,
            { v: 2, workflowSessionId: id, runId }, WORKFLOW_V2_CONTROLLER_VERSION),
    };
}

/** The node executions of a run, by state id and ordinal. */
async function nodesOf(store, runId) {
    return store.listNodeExecutions(runId);
}

/** Poll until the run has a node execution of this state and ordinal with the given state ("pending" or "completed"). */
async function nodeAt(store, runId, nodeId, ordinal, state) {
    return until(async () => (await nodesOf(store, runId)).find(node => node.nodeId === nodeId && node.ordinal === ordinal && node.state === state) ?? null,
        `${nodeId}#${ordinal} ${state}`);
}

const BUILD = { buildId: 7, state: "succeeded" };

describe("workflow v2 messaging receive", () => {
    it("compiles a receive state and its contracts, writes IR version 5 only for a workflow with one, and refuses what this build does not run", () => {
        const compiled = compileWorkflowV2(RECEIVER({ from: true }));
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_V2_MESSAGING_IR_VERSION);
        expect(compiled.ir.contracts).toEqual({ "BuildEvent@1": { schema: "BuildEvent" } });
        expect(compiled.ir.nodes.await_build).toEqual({
            id: "await_build", type: "messaging", description: null, mode: "receive", contract: "BuildEvent@1",
            from: { sessionId: "${kv.reporter}" }, correlate: { buildId: "${inputs.buildId}" }, waitSeconds: "${kv.secs}",
            hasInput: false, input: null,
            next: { received: "got", elapsed: "timed_out", forbidden: "refused", unavailable: "refused", invalid_input: "refused" },
        });
        const stored = JSON.parse(JSON.stringify(compiled.ir));
        expect(parseWorkflowIr(stored)).toEqual(compiled.ir);
        // Version 4 has no messaging states or contracts.
        expect(() => parseWorkflowIr({ ...stored, irVersion: WORKFLOW_V2_WAIT_IR_VERSION })).toThrow("stored IR has contracts before version 5");
        const { contracts, ...withoutContracts } = stored;
        expect(contracts).toBeDefined();
        expect(() => parseWorkflowIr({ ...withoutContracts, irVersion: WORKFLOW_V2_WAIT_IR_VERSION })).toThrow("stored IR messaging state await_build is invalid");
        // The parent as sender, and no wait: received is the only outcome.
        const parentOnly = compileWorkflowV2(PARENT_RECEIVER);
        expect(parentOnly.valid, JSON.stringify(parentOnly.diagnostics)).toBe(true);
        expect(parentOnly.ir.nodes.await_build).toMatchObject({ from: { parent: true }, waitSeconds: null });
        // A workflow with no receive keeps its earlier IR version and stores no contracts (they are reported unused).
        const noReceive = compileWorkflowV2(`
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: unused, version: "1.0.0" }
initial: step
${SCHEMAS}
states:
  step:
    type: script
    source: |
      await setResult("ok", {});
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`);
        expect(noReceive.valid, JSON.stringify(noReceive.diagnostics)).toBe(true);
        expect(noReceive.ir.irVersion).toBe(WORKFLOW_V2_IR_VERSION);
        expect(Object.hasOwn(noReceive.ir, "contracts")).toBe(false);
        expect(noReceive.diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", code: "WORKFLOW_CONTRACT_UNUSED", path: "contracts.BuildEvent@1" }));
        const refusals = [
            [RECEIVER().replace("contract: BuildEvent@1\n", "contract: Other@1\n"), "WORKFLOW_CONTRACT_UNKNOWN", "states.await_build.contract"],
            // A send state needs a recipient (a receive's fields are not a send's); request is not supported yet.
            [RECEIVER().replace("mode: receive", "mode: send"), "WORKFLOW_FIELD_REQUIRED", "states.await_build.recipient"],
            [RECEIVER().replace("mode: receive", "mode: request"), "WORKFLOW_FEATURE_UNSUPPORTED", "states.await_build.mode"],
            [RECEIVER().replace("received: got, ", ""), "WORKFLOW_ROUTE_MISSING", "states.await_build.transition.next"],
            [RECEIVER({ wait: false }).replace("received: got", "received: got, elapsed: timed_out"), "WORKFLOW_ROUTE_INVALID", "states.await_build.transition.next.elapsed"],
            [RECEIVER().replace("received: got,", "received: got, arrived: got,"), "WORKFLOW_ROUTE_INVALID", "states.await_build.transition.next.arrived"],
            [RECEIVER().replace("    correlate:", "    from: { parent: false }\n    correlate:"), "WORKFLOW_FIELD_INVALID", "states.await_build.from"],
            [RECEIVER().replace('correlate: { buildId: "${inputs.buildId}" }', "correlate: [1]"), "WORKFLOW_FIELD_INVALID", "states.await_build.correlate"],
            [RECEIVER().replace('wait: { seconds: "${kv.secs}" }', "wait: { seconds: 0 }"), "WORKFLOW_FIELD_INVALID", "states.await_build.wait.seconds"],
            [RECEIVER().replace('wait: { seconds: "${kv.secs}" }', "wait: { seconds: 5, tool: sleep }"), "WORKFLOW_FIELD_INVALID", "states.await_build.wait.tool"],
            [RECEIVER().replaceAll("BuildEvent@1", "BuildEvent"), "WORKFLOW_CONTRACT_NAME", "contracts.BuildEvent"],
        ];
        for (const [yaml, code, path] of refusals) {
            const result = compileWorkflowV2(yaml);
            expect(result.valid, `${code} ${path}: ${JSON.stringify(result.diagnostics)}`).toBe(false);
            expect(result.diagnostics, `${code} ${path}`).toContainEqual(expect.objectContaining({ code, path }));
        }
    });

    it("takes input given before the state was entered, in the run's order, skipping an expired one, once per operation id", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await sessionOf(h);
            const run = await started(h, parent, RECEIVER({ wait: false }), { dispatch: false });
            // The run is admitted and its controller has not started: nothing can have entered the receive.
            expect(await nodesOf(h.store, run.runId)).toEqual([]);
            const expiring = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "running" },
                ttl_seconds: 1, operation_id: "first" });
            expect(expiring).toMatchObject({ ok: true, runId: run.runId, contract: "BuildEvent@1", replayed: false, claimedBy: null,
                senderSessionId: parent.sessionId, operationId: "first" });
            await expectStoredReceipt(h, expiring, { buildId: 7, state: "running" });
            // Wait (on the store's clock) until it has expired, then give two more.
            await until(async () => (await h.q("SELECT clock_timestamp() > $1::timestamptz AS past", [expiring.expiresAt]))[0].past, "the first input to expire");
            const earlier = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "second" });
            const later = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "failed" }, operation_id: "third" });
            expect([earlier.claimedBy, later.claimedBy]).toEqual([null, null]);
            await expectStoredReceipt(h, earlier, BUILD);

            await run.startController();
            const ended = await finished(h.store, run.runId);
            expect(ended).toMatchObject({ status: "completed", terminalOutput: BUILD });
            const [receive] = await nodesOf(h.store, run.runId);
            // Taken when the state was entered, in that transaction: the earliest unexpired input.
            expect(receive).toMatchObject({ nodeId: "await_build", nodeType: "messaging", state: "completed", outcome: "received", resultKind: "business",
                winner: "message", output: BUILD, deadlineAt: null, effectAttempts: 0,
                receive: { contract: "BuildEvent@1", from: null, correlation: { buildId: 7 } } });
            // One reading of the store's clock decided the entry, exactly: it is the receive's entered_at and
            // completed_at and the input's consumed_at, and the input was unexpired at it.
            const [entry] = await h.q(`SELECT n.completed_at = n.entered_at AS completed_at_entry, m.consumed_at = n.entered_at AS consumed_at_entry,
                    m.expires_at > n.entered_at AS unexpired_at_entry
                  FROM SCHEMA.workflow_node_executions n JOIN SCHEMA.workflow_inbox m ON m.consumed_by = n.node_execution_id
                 WHERE n.node_execution_id = $1`, [receive.nodeExecutionId]);
            expect(entry).toEqual({ completed_at_entry: true, consumed_at_entry: true, unexpired_at_entry: true });
            const inbox = await h.store.listInbox(run.runId);
            expect(inbox.map(message => [message.operationId, message.consumedBy])).toEqual([["first", null], ["second", receive.nodeExecutionId], ["third", null]]);
            expect(inbox[1].consumedAt).toMatch(EXACT_TIME);
            expect((await h.client.getStatus(workflowEffectInstanceId(receive.nodeExecutionId))).status).toBe("NotFound");

            // A repeat returns the acceptance's receipt unchanged: no receive took the input when it was accepted,
            // although one took it since, and the expired input's repeat too. The read view shows what happened since.
            const repeat = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "second" });
            expect(repeat).toEqual({ ...earlier, replayed: true });
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "running" },
                ttl_seconds: 1, operation_id: "first" })).toEqual({ ...expiring, replayed: true });
            const view = await parent.read(run.id);
            expect(view.run.inbox.map(message => [message.messageId, message.claimedBy, message.claimedAt])).toEqual([
                [expiring.messageId, null, null], [earlier.messageId, receive.nodeExecutionId, inbox[1].consumedAt], [later.messageId, null, null]]);
            const conflict = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "running" }, operation_id: "second" });
            expect(conflict).toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            // The run has ended: new input is refused, and nothing is stored.
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "late" }))
                .toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            expect((await h.store.listInbox(run.runId)).length).toBe(3);
            // An input stored without a receipt (a pre-release build) is not repeated from what it is now.
            await h.q("UPDATE SCHEMA.workflow_inbox SET receipt = NULL WHERE message_id = $1", [later.messageId]);
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "failed" }, operation_id: "third" }))
                .toMatchObject({ ok: false, error: { code: "WORKFLOW_STORE_CORRUPT" } });
        } finally { await h.stop(); }
    });

    it("decides between an input and the receive's wait in the store: input first wins, the wait first elapses and keeps the late input for the next receive", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await sessionOf(h);
            // Input before the deadline: the receive is waiting for 60 s, and the input claims it in its own transaction.
            const quick = await started(h, parent, RECEIVER(), { vars: { secs: 60 } });
            const waiting = await nodeAt(h.store, quick.runId, "await_build", 1, "pending");
            expect(waiting.deadlineAt.getTime() - waiting.enteredAt.getTime()).toBe(60_000);
            const sent = await parent.send(quick.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "build" });
            expect(sent).toMatchObject({ ok: true, claimedBy: { nodeExecutionId: waiting.nodeExecutionId, stateId: "await_build" } });
            await expectStoredReceipt(h, sent, BUILD);
            const claimed = await h.store.readNodeExecution(waiting.nodeExecutionId);
            expect(claimed).toMatchObject({ state: "completed", outcome: "received", winner: "message", output: BUILD, deadlineAt: waiting.deadlineAt });
            // One reading of the store's clock decided the acceptance, exactly: the input's accepted_at, the
            // receive's completed_at and the input's consumed_at, before the receive's deadline.
            const [race] = await h.q(`SELECT n.completed_at = m.accepted_at AS completed_at_acceptance, m.consumed_at = m.accepted_at AS consumed_at_acceptance,
                    m.accepted_at < n.deadline_at AS before_deadline
                  FROM SCHEMA.workflow_inbox m JOIN SCHEMA.workflow_node_executions n ON n.node_execution_id = m.consumed_by WHERE m.message_id = $1`, [sent.messageId]);
            expect(race).toEqual({ completed_at_acceptance: true, consumed_at_acceptance: true, before_deadline: true });
            expect(await finished(h.store, quick.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });

            // An input accepted at or after the deadline is late for that receive (fault injection: the stored
            // deadline moves back after the controller read it, so the controller elapses the wait later).
            const late = await started(h, parent, RECEIVER(), { vars: { secs: 4 } });
            const pending = await nodeAt(h.store, late.runId, "await_build", 1, "pending");
            await h.q(`UPDATE SCHEMA.workflow_node_executions SET deadline_at = clock_timestamp() - interval '1 second' WHERE node_execution_id = $1`,
                [pending.nodeExecutionId]);
            const tooLate = await parent.send(late.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "build" });
            expect(tooLate).toMatchObject({ ok: true, claimedBy: null });
            const elapsed = await nodeAt(h.store, late.runId, "await_build", 1, "completed");
            expect(elapsed).toMatchObject({ outcome: "elapsed", winner: "controller", output: { asked: 7 } });
            expect(await finished(h.store, late.runId)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalOutput: { asked: 7 } });
            // The late input is kept, unclaimed.
            expect((await h.store.listInbox(late.runId)).map(message => message.consumedBy)).toEqual([null]);

            // The wait elapses first; an input given while no receive waits is kept and the next receive takes it,
            // not the one that elapsed.
            const poller = await started(h, parent, POLLER, { inputs: {}, vars: { gap: 3 } });
            const first = await nodeAt(h.store, poller.runId, "await_build", 1, "completed");
            expect(first).toMatchObject({ outcome: "elapsed", winner: "controller" });
            await nodeAt(h.store, poller.runId, "gap", 1, "pending");
            const between = await parent.send(poller.id, { contract: "BuildEvent@1", payload: BUILD, operation_id: "build" });
            expect(between).toMatchObject({ ok: true, claimedBy: null });
            expect(await finished(h.store, poller.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
            const second = (await nodesOf(h.store, poller.runId)).find(node => node.nodeId === "await_build" && node.ordinal === 2);
            expect(second).toMatchObject({ state: "completed", outcome: "received", winner: "message", output: BUILD });
            expect((await h.store.readNodeExecution(first.nodeExecutionId))).toMatchObject({ outcome: "elapsed", winner: "controller" });
            expect((await h.store.listInbox(poller.runId)).map(message => message.consumedBy)).toEqual([second.nodeExecutionId]);
        } finally { await h.stop(); }
    });

    it("does not take an input of another sender or correlation, refuses an undeclared contract or an invalid payload, and keeps the deadline", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // Every sender here is owned by the workflow's user, so each may send.
            const alice = { provider: "test", subject: `alice-${randomUUID()}` };
            const parent = await sessionOf(h, alice);
            const reporter = await sessionOf(h, alice);
            const peer = await sessionOf(h, alice);
            const run = await started(h, parent, RECEIVER({ from: true }), { vars: { secs: 60, reporter: reporter.sessionId }, owner: alice });
            const waiting = await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            expect(waiting.receive).toEqual({ contract: "BuildEvent@1", from: reporter.sessionId, correlation: { buildId: 7 } });
            const wrongRound = await reporter.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 8 }, payload: BUILD, operation_id: "a" });
            const wrongSender = await peer.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "a" });
            expect([wrongRound.claimedBy, wrongSender.claimedBy]).toEqual([null, null]);
            expect(await reporter.send(run.id, { contract: "Other@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "b" }))
                .toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CONTRACT", details: { receives: ["BuildEvent@1"] } } });
            const invalid = await reporter.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "unknown" }, operation_id: "c" });
            expect(invalid).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
            expect(invalid.error.details[0].path).toBe("/state");
            // Still waiting, with the same deadline; the two inputs it does not take are kept.
            expect(await h.store.readNodeExecution(waiting.nodeExecutionId)).toMatchObject({ state: "pending", deadlineAt: waiting.deadlineAt });
            const view = await parent.read(run.id);
            expect(view.run.nodeExecutions[0]).toMatchObject({ stateId: "await_build", state: "pending",
                receive: { contract: "BuildEvent@1", from: reporter.sessionId, correlation: { buildId: 7 } } });
            expect(view.run.inbox.map(message => [message.senderSessionId, message.correlation, message.claimedBy]))
                .toEqual([[reporter.sessionId, { buildId: 8 }, null], [peer.sessionId, { buildId: 7 }, null]]);
            expect(view.graph.states).toContainEqual({ id: "await_build", type: "messaging", mode: "receive", contract: "BuildEvent@1",
                from: "${kv.reporter}", waitSeconds: "${kv.secs}", outcomes: ["received", "elapsed"],
                next: { received: "got", elapsed: "timed_out", forbidden: "refused", unavailable: "refused", invalid_input: "refused" } });
            // The named sender with the receive's correlation is taken.
            const right = await reporter.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "d" });
            expect(right).toMatchObject({ ok: true, claimedBy: { nodeExecutionId: waiting.nodeExecutionId } });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
            expect((await h.store.listInbox(run.runId)).map(message => message.consumedBy)).toEqual([null, null, waiting.nodeExecutionId]);
        } finally { await h.stop(); }
    });

    it("refuses input across users, and fails a receive that names a session of another user or none", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const alice = { provider: "test", subject: `alice-${randomUUID()}` };
            const bob = { provider: "test", subject: `bob-${randomUUID()}` };
            const parent = await sessionOf(h, alice);
            const colleague = await sessionOf(h, alice);
            const stranger = await sessionOf(h, bob);
            const run = await started(h, parent, RECEIVER({ wait: false }), { owner: alice });
            await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            expect(await stranger.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "x" }))
                .toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
            expect(await h.store.listInbox(run.runId)).toEqual([]);
            // A session of the same user may give it input.
            expect(await colleague.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "x" }))
                .toMatchObject({ ok: true, claimedBy: { stateId: "await_build" } });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed" });

            // A receive that names another user's session, or one that does not exist, fails on entry.
            for (const [reporterId, code] of [[stranger.sessionId, "forbidden"], [randomUUID(), "unavailable"]]) {
                const named = await started(h, parent, RECEIVER({ from: true }), { vars: { secs: 60, reporter: reporterId }, owner: alice });
                const ended = await finished(h.store, named.runId);
                expect(ended, code).toMatchObject({ status: "failed", terminalOutput: { code } });
                expect((await nodesOf(h.store, named.runId))[0], code).toMatchObject({ nodeId: "await_build", outcome: code, resultKind: "runtime_error",
                    winner: "controller", receive: null, deadlineAt: null });
            }
        } finally { await h.stop(); }
    });

    it("refuses input from a session of unknown, partial, blank or system ownership or another identity, and fails a receive that names one", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const alice = { provider: "test", subject: `alice-${randomUUID()}` };
            const parent = await sessionOf(h, alice);
            const colleague = await sessionOf(h, alice);
            // Senders whose stored ownership grants nothing: none, partial, blank, a system session (unowned, and one
            // linked to the workflow's user as stored data), and an identity that differs from that user's by a space.
            const unowned = await sessionOf(h);
            const partial = await sessionOf(h);
            await linkOwner(h, partial.sessionId, alice.provider, "");
            const blank = await sessionOf(h);
            await linkOwner(h, blank.sessionId, " ", " ");
            const system = await sessionOf(h, null, { system: true });
            const aliceSystem = await sessionOf(h, null, { system: true });
            await linkOwner(h, aliceSystem.sessionId, alice.provider, alice.subject);
            const padded = await sessionOf(h);
            await linkOwner(h, padded.sessionId, alice.provider, `${alice.subject} `);
            // The catalog reads the stored ownership these cases depend on.
            expect((await h.catalog.getSession(unowned.sessionId)).owner).toBeNull();
            expect((await h.catalog.getSession(partial.sessionId)).owner).toBeNull();
            expect((await h.catalog.getSession(blank.sessionId)).owner).toMatchObject({ provider: " ", subject: " " });
            expect(await h.catalog.getSession(system.sessionId)).toMatchObject({ isSystem: true, owner: null });
            expect(await h.catalog.getSession(aliceSystem.sessionId)).toMatchObject({ isSystem: true, owner: alice });
            expect((await h.catalog.getSession(padded.sessionId)).owner).toMatchObject({ provider: alice.provider, subject: `${alice.subject} ` });
            const refused = { unowned, partial, blank, system, aliceSystem, padded };

            const run = await started(h, parent, RECEIVER({ wait: false }), { owner: alice });
            expect((await h.catalog.getSession(run.id)).owner).toMatchObject(alice);
            const waiting = await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            const events = await inputEvents(h, run.id);
            for (const [name, sender] of Object.entries(refused)) {
                expect(await sender.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "x" }), name)
                    .toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
            }
            // Nothing was stored or recorded, and the receive still waits.
            expect(await h.store.listInbox(run.runId)).toEqual([]);
            expect(await inputEvents(h, run.id)).toEqual(events);
            expect(await h.store.readNodeExecution(waiting.nodeExecutionId)).toMatchObject({ state: "pending" });
            // A session of the workflow's user may.
            expect(await colleague.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "x" }))
                .toMatchObject({ ok: true, claimedBy: { nodeExecutionId: waiting.nodeExecutionId } });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });

            // A workflow that no user owns takes input from its parent only: not from a user's session, nor from another unowned one.
            const unownedParent = await sessionOf(h);
            const orphan = await started(h, unownedParent, RECEIVER({ wait: false }));
            expect((await h.catalog.getSession(orphan.id)).owner).toBeNull();
            await nodeAt(h.store, orphan.runId, "await_build", 1, "pending");
            for (const [name, sender] of Object.entries({ colleague, unowned })) {
                expect(await sender.send(orphan.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "y" }), name)
                    .toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
            }
            expect(await h.store.listInbox(orphan.runId)).toEqual([]);
            expect(await unownedParent.send(orphan.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "y" }))
                .toMatchObject({ ok: true, claimedBy: { stateId: "await_build" } });
            expect(await finished(h.store, orphan.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });

            // A receive that names any of the refused senders fails on entry, waiting for nothing.
            const named = [];
            for (const [name, sender] of Object.entries(refused)) {
                named.push([name, await started(h, parent, RECEIVER({ from: true }), { vars: { secs: 60, reporter: sender.sessionId }, owner: alice })]);
            }
            for (const [name, namedRun] of named) {
                expect(await finished(h.store, namedRun.runId), name).toMatchObject({ status: "failed", terminalOutput: { code: "forbidden" } });
                expect((await nodesOf(h.store, namedRun.runId))[0], name).toMatchObject({ nodeId: "await_build", outcome: "forbidden",
                    resultKind: "runtime_error", winner: "controller", receive: null, deadlineAt: null });
            }
        } finally { await h.stop(); }
    });

    it("fails a receive whose sender is not live when it is entered, the parent included, although an input that sender gave earlier waits", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await sessionOf(h);
            const run = await started(h, parent, PARENT_RECEIVER, { dispatch: false });
            const before = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "before" });
            expect(before).toMatchObject({ ok: true, claimedBy: null, senderSessionId: parent.sessionId });
            // The parent is deleted before the run enters the receive. Stage 2.1 (R5, migration 0107): deleting the chat that owns
            // a Workflow deletes the Workflow with it, and that cancels its run in the same transaction (0090), so the receive is
            // never entered and the parent's input is never taken. (Before 2.1 the Workflow stayed, and its receive failed as
            // unavailable; a deleted sender that is not the parent still fails it so, below.)
            await h.catalog.softDeleteSession(parent.sessionId);
            expect(await h.catalog.getSession(parent.sessionId)).toBeNull();
            expect(await h.catalog.getSession(run.id)).toBeNull();
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "cancelled", terminalOutput: null, terminalError: { code: "cancelled" } });
            expect(await nodesOf(h.store, run.runId)).toEqual([]);
            // The input the parent gave before it was deleted was not taken.
            expect((await h.store.listInbox(run.runId)).map(message => [message.messageId, message.consumedBy])).toEqual([[before.messageId, null]]);

            // A receive of another session's Workflow that names the deleted parent as its sender fails as unavailable.
            const other = await sessionOf(h);
            const named = await started(h, other, RECEIVER({ from: true }), { vars: { secs: 60, reporter: parent.sessionId } });
            expect(await finished(h.store, named.runId)).toMatchObject({ status: "failed", terminalOutput: { code: "unavailable" } });
            expect((await nodesOf(h.store, named.runId))[0]).toMatchObject({ outcome: "unavailable", receive: null, deadlineAt: null });

            // A live parent is the receive's sender, and the receive takes its input.
            const live = await started(h, other, PARENT_RECEIVER);
            const waiting = await nodeAt(h.store, live.runId, "await_build", 1, "pending");
            expect(waiting).toMatchObject({ deadlineAt: null, receive: { contract: "BuildEvent@1", from: other.sessionId, correlation: { buildId: 7 } } });
            expect(await other.send(live.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "now" }))
                .toMatchObject({ ok: true, claimedBy: { nodeExecutionId: waiting.nodeExecutionId } });
            expect(await finished(h.store, live.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
        } finally { await h.stop(); }
    });

    it("decides a receive's sender in its admission: a sender deleted after the receive was resolved and before it was admitted fails it", { timeout: TIMEOUT }, async () => {
        const entries = stopBefore("enterNode", (input, spec) => input.runId === spec.runId && input.nodeId === "await_build");
        const h = await harness(getEnv(), { wrapStore: entries.wrap });
        try {
            /** Start `run` (not dispatched yet) and stop its receive's admission: the receive was resolved, its admission's transaction has not started. */
            const stoppedAt = async (run, from) => {
                const stop = entries.arm({ runId: run.runId });
                await run.startController();
                await within(stop.reached, 60_000, "the receive's admission to be stopped");
                expect(stop.input.receive).toMatchObject({ contract: "BuildEvent@1", from, correlationText: canonicalJson({ buildId: 7 }) });
                expect(await nodesOf(h.store, run.runId)).toEqual([]);
                return stop;
            };
            // The parent selector: the parent gave an input before the run began, and is deleted after its receive was
            // resolved, before its admission. Stage 2.1 (R5, migration 0107): deleting the chat that owns a Workflow deletes
            // the Workflow with it and cancels its run in the same transaction (0090); the admission then admits nothing (the
            // session is deleted), and the parent's input is not taken. (Before 2.1 the Workflow stayed, and the admission
            // failed the receive as unavailable; a named sender that is not the parent still does, below.)
            const parent = await sessionOf(h);
            const run = await started(h, parent, PARENT_RECEIVER, { dispatch: false });
            const before = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "before" });
            expect(before).toMatchObject({ ok: true, claimedBy: null });
            const stop = await stoppedAt(run, parent.sessionId);
            await h.catalog.softDeleteSession(parent.sessionId);
            expect(await h.catalog.getSession(parent.sessionId)).toBeNull();
            expect(await h.catalog.getSession(run.id)).toBeNull();
            stop.release();
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "cancelled", terminalOutput: null, terminalError: { code: "cancelled" } });
            // The released admission has run (its controller ended) and entered nothing.
            await until(async () => (["Completed", "Failed"].includes((await h.client.getStatus(run.controllerInstanceId))?.status) ? true : null),
                "the deleted Workflow's controller to end", 60_000);
            expect(await nodesOf(h.store, run.runId)).toEqual([]);
            expect((await h.store.listInbox(run.runId)).map(message => [message.messageId, message.consumedBy])).toEqual([[before.messageId, null]]);

            // A named sender, a session of the workflow's user that gave an input, deleted the same way.
            const alice = { provider: "test", subject: `alice-${randomUUID()}` };
            const owner = await sessionOf(h, alice);
            const reporter = await sessionOf(h, alice);
            const named = await started(h, owner, RECEIVER({ from: true }), { vars: { secs: 60, reporter: reporter.sessionId }, owner: alice, dispatch: false });
            const given = await reporter.send(named.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "given" });
            expect(given).toMatchObject({ ok: true, claimedBy: null });
            const namedStop = await stoppedAt(named, reporter.sessionId);
            expect(namedStop.input.waitSeconds).toBe(60);
            await h.catalog.softDeleteSession(reporter.sessionId);
            namedStop.release();
            expect(await finished(h.store, named.runId)).toMatchObject({ status: "failed",
                terminalOutput: { code: "unavailable", details: { sessionId: reporter.sessionId } } });
            expect((await nodesOf(h.store, named.runId))[0]).toMatchObject({ outcome: "unavailable", winner: "controller", receive: null, deadlineAt: null });
            expect((await h.store.listInbox(named.runId)).map(message => message.consumedBy)).toEqual([null]);

            // Control: the same stop and no deletion: the receive takes its live parent's earlier input.
            const liveParent = await sessionOf(h);
            const live = await started(h, liveParent, PARENT_RECEIVER, { dispatch: false });
            const earlier = await liveParent.send(live.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "earlier" });
            const liveStop = await stoppedAt(live, liveParent.sessionId);
            liveStop.release();
            expect(await finished(h.store, live.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
            const [took] = await nodesOf(h.store, live.runId);
            expect(took).toMatchObject({ outcome: "received", winner: "message", output: BUILD,
                receive: { contract: "BuildEvent@1", from: liveParent.sessionId, correlation: { buildId: 7 } } });
            expect((await h.store.listInbox(live.runId)).map(message => [message.messageId, message.consumedBy])).toEqual([[earlier.messageId, took.nodeExecutionId]]);
            // A repeat of that committed admission returns it as stored, after its sender was deleted too.
            await h.catalog.softDeleteSession(liveParent.sessionId);
            const repeated = await h.store.enterNode(liveStop.input);
            expect(repeated).toMatchObject({ admitted: true, inserted: false, node: { nodeExecutionId: took.nodeExecutionId, outcome: "received",
                receive: { from: liveParent.sessionId }, completedAt: took.completedAt } });
        } finally { await h.stop(); }
    });

    it("decides a fresh input's sender in its acceptance: a sender deleted after the send was checked and before it was accepted is refused, and nothing is stored", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const accepts = stopBefore("acceptInput", (input, spec) => input.workflowSessionId === spec.workflowSessionId);
            const host = { ...h.host, store: accepts.wrap(h.store) };
            const sendAs = async (sessionId, workflowId, args) => JSON.parse(await sendWorkflowInputFromTool({ workflow_id: workflowId, ...args },
                { callerSessionId: sessionId, host }));
            const alice = { provider: "test", subject: `alice-${randomUUID()}` };
            const parent = await sessionOf(h, alice);
            // The sender is another session of the Workflow's user, not its parent: since stage 2.1 (R5, migration 0107),
            // deleting the parent deletes the Workflow with it, and a send to it is then refused as a deleted Workflow's.
            const reporter = await sessionOf(h, alice);
            const run = await started(h, parent, RECEIVER({ wait: false }), { owner: alice });
            const waiting = await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            const events = await inputEvents(h, run.id);
            // The send passed the service's check (the reporter is live) and is stopped before its acceptance's
            // transaction; the reporter is deleted; the acceptance refuses it.
            const stop = accepts.arm({ workflowSessionId: run.id });
            const sending = sendAs(reporter.sessionId, run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "x" });
            await within(stop.reached, 30_000, "the acceptance to be stopped");
            expect(stop.input).toMatchObject({ workflowSessionId: run.id, senderSessionId: reporter.sessionId, operationId: "x" });
            await h.catalog.softDeleteSession(reporter.sessionId);
            stop.release();
            expect(await sending).toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: TYPED_INPUT_REFUSALS.unavailable } });
            expect(await h.store.listInbox(run.runId)).toEqual([]);
            expect(await inputEvents(h, run.id)).toEqual(events);
            expect(await h.store.readNodeExecution(waiting.nodeExecutionId)).toMatchObject({ state: "pending" });

            // Control: the same stop and no deletion: a session of the workflow's user is accepted, and the receive takes it.
            const colleague = await sessionOf(h, alice);
            const liveStop = accepts.arm({ workflowSessionId: run.id });
            const accepted = sendAs(colleague.sessionId, run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "y" });
            await within(liveStop.reached, 30_000, "the acceptance to be stopped");
            liveStop.release();
            expect(await accepted).toMatchObject({ ok: true, replayed: false, claimedBy: { nodeExecutionId: waiting.nodeExecutionId } });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });

            // The acceptance decides with the same rule as the service, called directly: another user's session, a
            // session of unknown ownership, a missing one and a deleted one are refused, and nothing is stored;
            // the workflow's parent is accepted.
            const owner = await sessionOf(h, alice);
            const second = await started(h, owner, RECEIVER({ wait: false }), { owner: alice });
            await nodeAt(h.store, second.runId, "await_build", 1, "pending");
            const bob = await sessionOf(h, { provider: "test", subject: `bob-${randomUUID()}` });
            const nobody = await sessionOf(h);
            const direct = (senderSessionId, operationId) => h.store.acceptInput({
                workflowSessionId: second.id, runId: second.runId, messageId: randomUUID(), senderSessionId, operationId,
                requestSha256: sha256Hex(operationId), contract: "BuildEvent@1", correlationText: canonicalJson({ buildId: 7 }),
                payloadText: canonicalJson(BUILD), ttlSeconds: 60, limits: WORKFLOW_V2_INBOX_LIMITS,
            });
            for (const [senderSessionId, refusal] of [[bob.sessionId, "forbidden"], [nobody.sessionId, "forbidden"], [randomUUID(), "unavailable"],
                [reporter.sessionId, "unavailable"]]) {
                await expect(direct(senderSessionId, "direct"), `${refusal} ${senderSessionId}`).rejects
                    .toMatchObject({ code: "FORBIDDEN", message: TYPED_INPUT_REFUSALS[refusal] });
            }
            expect(await h.store.listInbox(second.runId)).toEqual([]);
            expect(await direct(owner.sessionId, "direct")).toMatchObject({ replayed: false, receipt: { senderSessionId: owner.sessionId,
                claimedBy: { stateId: "await_build" } } });
            expect(await finished(h.store, second.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
        } finally { await h.stop(); }
    });

    it("decides an input against its receive's deadline to the microsecond: at the deadline or after it is late, a microsecond before it wins", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // Fault injection: as an input of a listed run is inserted, its waiting receive's deadline moves to the
            // input's own acceptance reading plus the run's offset (microseconds). The controller still elapses the
            // wait at the time it read at entry.
            await h.q(`CREATE TABLE SCHEMA.test_deadline_offsets (run_id TEXT PRIMARY KEY, offset_us BIGINT NOT NULL)`);
            await h.q(`CREATE FUNCTION SCHEMA.test_move_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    UPDATE SCHEMA.workflow_node_executions n SET deadline_at = NEW.accepted_at + o.offset_us * interval '1 microsecond'
                      FROM SCHEMA.test_deadline_offsets o
                     WHERE o.run_id = NEW.run_id AND n.run_id = NEW.run_id AND n.state = 'pending' AND n.node_type = 'messaging';
                    RETURN NEW;
                END $$`);
            await h.q(`CREATE TRIGGER test_move_deadline BEFORE INSERT ON SCHEMA.workflow_inbox FOR EACH ROW EXECUTE FUNCTION SCHEMA.test_move_deadline()`);
            const parent = await sessionOf(h);
            const give = async (offsetUs, secs) => {
                const run = await started(h, parent, RECEIVER(), { vars: { secs } });
                const waiting = await nodeAt(h.store, run.runId, "await_build", 1, "pending");
                await h.q(`INSERT INTO SCHEMA.test_deadline_offsets (run_id, offset_us) VALUES ($1, $2)`, [run.runId, offsetUs]);
                const sent = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "build" });
                expect(sent, `offset ${offsetUs}`).toMatchObject({ ok: true });
                const [moved] = await h.q(`SELECT n.deadline_at = m.accepted_at + $3::bigint * interval '1 microsecond' AS at_offset,
                        (extract(microseconds FROM m.accepted_at)::bigint % 1000)::int AS sub_ms
                      FROM SCHEMA.workflow_inbox m, SCHEMA.workflow_node_executions n WHERE m.message_id = $1 AND n.node_execution_id = $2`,
                    [sent.messageId, waiting.nodeExecutionId, offsetUs]);
                expect(moved.at_offset, `offset ${offsetUs}: the deadline was moved`).toBe(true);
                return { run, waiting, sent, subMs: moved.sub_ms };
            };
            // At the deadline, and a microsecond after it, the input is late: it is kept and the wait elapses. A
            // millisecond comparison would let both win whenever the acceptance's reading had two or more microseconds
            // past its millisecond, so a case is given again (at most twice) when its reading had fewer.
            for (const offsetUs of [-1, 0]) {
                let late = null;
                for (let attempt = 1; attempt <= 3 && !(late && late.subMs >= 2); attempt += 1) {
                    late = await give(offsetUs, 4);
                    expect(late.sent, `offset ${offsetUs}`).toMatchObject({ claimedBy: null });
                    expect(await nodeAt(h.store, late.run.runId, "await_build", 1, "completed"), `offset ${offsetUs}`)
                        .toMatchObject({ outcome: "elapsed", winner: "controller" });
                    expect(await finished(h.store, late.run.runId)).toMatchObject({ status: "completed", terminalOutcome: "blocked" });
                    expect((await h.store.listInbox(late.run.runId)).map(message => message.consumedBy)).toEqual([null]);
                }
                expect(late.subMs, `offset ${offsetUs}: the reading could tell a millisecond comparison apart`).toBeGreaterThanOrEqual(2);
            }
            // A microsecond before the deadline, the input wins, at its acceptance reading exactly.
            const early = await give(1, 60);
            expect(early.sent).toMatchObject({ claimedBy: { nodeExecutionId: early.waiting.nodeExecutionId, stateId: "await_build" } });
            const [won] = await h.q(`SELECT n.completed_at = m.accepted_at AS completed_at_acceptance, m.consumed_at = m.accepted_at AS consumed_at_acceptance,
                    n.deadline_at - m.accepted_at = interval '1 microsecond' AS microsecond_before
                  FROM SCHEMA.workflow_inbox m JOIN SCHEMA.workflow_node_executions n ON n.node_execution_id = m.consumed_by WHERE m.message_id = $1`,
                [early.sent.messageId]);
            expect(won).toEqual({ completed_at_acceptance: true, consumed_at_acceptance: true, microsecond_before: true });
            expect(await finished(h.store, early.run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
        } finally {
            try {
                await h.q(`DROP TRIGGER IF EXISTS test_move_deadline ON SCHEMA.workflow_inbox`);
                await h.q(`DROP FUNCTION IF EXISTS SCHEMA.test_move_deadline()`);
                await h.q(`DROP TABLE IF EXISTS SCHEMA.test_deadline_offsets`);
            } finally { await h.stop(); }
        }
    });

    it("takes at entry only an input unexpired at the entry's own reading of the store's clock, however late the entry commits", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const holding = holdingPool(env);
        const h = await harness(env, { storePool: holding.pool });
        try {
            const parent = await sessionOf(h);
            // The input must still be unexpired when the receive selects it. When the controller starts too late for
            // that (nothing is held; the receive's 1 s wait elapses), the case is given again with a longer ttl.
            let held = null;
            for (const ttl of [2, 4, 8]) {
                const run = await started(h, parent, RECEIVER(), { vars: { secs: 1 }, dispatch: false });
                const sent = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, ttl_seconds: ttl, operation_id: "build" });
                expect(sent, `ttl ${ttl}`).toMatchObject({ ok: true, claimedBy: null });
                holding.hold.runId = run.runId;
                await run.startController();
                const ended = await finished(h.store, run.runId);
                const [receive] = await nodesOf(h.store, run.runId);
                if (receive.outcome === "elapsed") {
                    expect(holding.hold.messageId, `ttl ${ttl}`).toBeNull();
                    continue;
                }
                held = { sent, receive, ended };
                break;
            }
            expect(held, "a receive selected the input before it expired").not.toBeNull();
            expect(held.ended).toMatchObject({ status: "completed", terminalOutput: BUILD });
            expect(held.receive).toMatchObject({ outcome: "received", winner: "message", output: BUILD, deadlineAt: null });
            expect(holding.hold).toMatchObject({ messageId: held.sent.messageId, heldUntil: expect.any(String) });
            // The entry was held until the input had expired, and still decided at its own earlier reading:
            // entered_at, completed_at and consumed_at are that reading, before the expiry.
            const [entry] = await h.q(`SELECT m.expires_at > n.entered_at AS unexpired_at_entry, m.consumed_at = n.entered_at AS consumed_at_entry,
                    n.completed_at = n.entered_at AS completed_at_entry, $2::timestamptz > m.expires_at AS held_past_expiry
                  FROM SCHEMA.workflow_inbox m JOIN SCHEMA.workflow_node_executions n ON n.node_execution_id = m.consumed_by WHERE m.message_id = $1`,
                [held.sent.messageId, holding.hold.heldUntil]);
            expect(entry).toEqual({ unexpired_at_entry: true, consumed_at_entry: true, completed_at_entry: true, held_past_expiry: true });
        } finally {
            try { await h.stop(); } finally { await holding.pool.end(); }
        }
    });

    it("keeps an input late for a receive for the next receive, which takes it at entry only if it has not expired, however late that entry is", { timeout: TIMEOUT }, async () => {
        expect(KV_POLLER).toContain('wait: { seconds: "${kv.secs}" }');
        const entries = stopBefore("enterNode", (input, spec) => input.runId === spec.runId && input.nodeId === "await_build" && input.ordinal === 2);
        const h = await harness(getEnv(), { wrapStore: entries.wrap });
        try {
            const parent = await sessionOf(h);
            /**
             * A poller whose receive waits 4 s, with its second receive's admission stopped before it reaches the
             * store. An input with this ttl is given while the first receive still waits, after its stored deadline (fault
             * injection: the stored deadline moves back after the controller read it, so the controller elapses the wait
             * later, at its own time): late for that receive, it is kept. The first receive elapses, the 1 s gap passes and
             * the second receive's admission is stopped.
             */
            const lateInput = async ttl => {
                const run = await started(h, parent, KV_POLLER, { inputs: {}, vars: { secs: 4, gap: 1 }, dispatch: false });
                const stop = entries.arm({ runId: run.runId });
                await run.startController();
                const first = await nodeAt(h.store, run.runId, "await_build", 1, "pending");
                expect(first.deadlineAt.getTime() - first.enteredAt.getTime()).toBe(4_000);
                await h.q(`UPDATE SCHEMA.workflow_node_executions SET deadline_at = clock_timestamp() - interval '1 second' WHERE node_execution_id = $1`,
                    [first.nodeExecutionId]);
                const late = await parent.send(run.id, { contract: "BuildEvent@1", payload: BUILD, ttl_seconds: ttl, operation_id: "late" });
                expect(late, `ttl ${ttl}`).toMatchObject({ ok: true, claimedBy: null });
                await within(stop.reached, 60_000, "the second receive's admission to be stopped");
                expect(stop.input).toMatchObject({ runId: run.runId, nodeId: "await_build", ordinal: 2 });
                expect((await nodesOf(h.store, run.runId)).filter(node => node.nodeId === "await_build").map(node => node.ordinal)).toEqual([1]);
                expect(await h.store.readNodeExecution(first.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "elapsed", winner: "controller" });
                // The input was accepted at or after the first receive's (stored) deadline and before its wait elapsed, and nothing took it.
                const [timing] = await h.q(`SELECT m.accepted_at >= n.deadline_at AS at_or_after_deadline, m.accepted_at < n.completed_at AS before_elapse,
                        m.consumed_by IS NULL AS unclaimed
                      FROM SCHEMA.workflow_inbox m, SCHEMA.workflow_node_executions n WHERE m.message_id = $1 AND n.node_execution_id = $2`,
                    [late.messageId, first.nodeExecutionId]);
                expect(timing, `ttl ${ttl}`).toEqual({ at_or_after_deadline: true, before_elapse: true, unclaimed: true });
                return { run, late, stop };
            };

            // Control: the second receive's admission goes on at once, while the late input is unexpired: the entry takes
            // it, at the entry's own reading.
            const kept = await lateInput(60);
            kept.stop.release();
            expect(await finished(h.store, kept.run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
            const taker = (await nodesOf(h.store, kept.run.runId)).find(node => node.nodeId === "await_build" && node.ordinal === 2);
            expect(taker).toMatchObject({ state: "completed", outcome: "received", winner: "message", output: BUILD, deadlineAt: null });
            const [entry] = await h.q(`SELECT m.consumed_by = n.node_execution_id AS taken_by_second, m.consumed_at = n.entered_at AS consumed_at_entry,
                    n.completed_at = n.entered_at AS completed_at_entry, m.expires_at > n.entered_at AS unexpired_at_entry
                  FROM SCHEMA.workflow_inbox m, SCHEMA.workflow_node_executions n WHERE m.message_id = $1 AND n.node_execution_id = $2`,
                [kept.late.messageId, taker.nodeExecutionId]);
            expect(entry).toEqual({ taken_by_second: true, consumed_at_entry: true, completed_at_entry: true, unexpired_at_entry: true });

            // The second receive's admission is held until the store's clock is past the late input's expiry (a
            // controller late to admit it): the entry does not take the expired input, and the receive waits.
            const expiring = await lateInput(6);
            await until(async () => (await h.q("SELECT clock_timestamp() > $1::timestamptz AS past", [expiring.late.expiresAt]))[0].past,
                "the late input to expire");
            expiring.stop.release();
            const waiting = await nodeAt(h.store, expiring.run.runId, "await_build", 2, "pending");
            expect(waiting.deadlineAt.getTime() - waiting.enteredAt.getTime()).toBe(4_000);
            const [skipped] = await h.q(`SELECT n.entered_at >= m.expires_at AS entered_after_expiry, m.consumed_by IS NULL AS unclaimed
                  FROM SCHEMA.workflow_inbox m, SCHEMA.workflow_node_executions n WHERE m.message_id = $1 AND n.node_execution_id = $2`,
                [expiring.late.messageId, waiting.nodeExecutionId]);
            expect(skipped).toEqual({ entered_after_expiry: true, unclaimed: true });
            // A fresh input takes the waiting receive in its own acceptance; the expired one stays unclaimed.
            const fresh = { buildId: 8, state: "succeeded" };
            const now = await parent.send(expiring.run.id, { contract: "BuildEvent@1", payload: fresh, operation_id: "fresh" });
            expect(now).toMatchObject({ ok: true, claimedBy: { nodeExecutionId: waiting.nodeExecutionId, stateId: "await_build" } });
            expect(await finished(h.store, expiring.run.runId)).toMatchObject({ status: "completed", terminalOutput: fresh });
            expect((await h.store.listInbox(expiring.run.runId)).map(message => [message.messageId, message.consumedBy]))
                .toEqual([[expiring.late.messageId, null], [now.messageId, waiting.nodeExecutionId]]);
        } finally { await h.stop(); }
    });

    it("takes input while paused without admitting anything until the run is resumed", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await sessionOf(h);
            const run = await started(h, parent, RECEIVER(), { vars: { secs: 60 } });
            const waiting = await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            expect(await parent.update(run.id, { operation: "pause", run_id: run.runId, operation_id: "pause" })).toMatchObject({ ok: true, status: "paused" });
            const sent = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "build" });
            expect(sent).toMatchObject({ ok: true, claimedBy: { nodeExecutionId: waiting.nodeExecutionId } });
            // The result is kept for the resume (review R2-RT-1): the controller routes nothing and tries no admission.
            await until(async () => h.withheld.includes(run.runId), "a collection that keeps the result for the resume");
            expect(h.refusals).not.toContain(run.runId);
            expect((await h.store.readRun(run.runId)).status).toBe("paused");
            expect((await nodesOf(h.store, run.runId)).map(node => node.nodeId)).toEqual(["await_build"]);
            expect(await parent.update(run.id, { operation: "resume", run_id: run.runId, operation_id: "resume" })).toMatchObject({ ok: true });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
        } finally { await h.stop(); }
    });

    it("bounds a run's unclaimed input per sender, and stores nothing past the bound", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const alice = { provider: "test", subject: `alice-${randomUUID()}` };
            const parent = await sessionOf(h, alice);
            const run = await started(h, parent, RECEIVER(), { vars: { secs: 60 }, owner: alice });
            await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            const bound = WORKFLOW_V2_INBOX_LIMITS.maxUnconsumedPerSender;
            for (let index = 0; index < bound; index += 1) {
                const sent = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 100 + index }, payload: BUILD, operation_id: `n${index}` });
                expect(sent, `input ${index}`).toMatchObject({ ok: true, claimedBy: null });
            }
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 999 }, payload: BUILD, operation_id: "over" }))
                .toMatchObject({ ok: false, error: { code: "INBOX_FULL" } });
            expect((await h.store.listInbox(run.runId)).length).toBe(bound);
            // A repeat of an accepted input is still answered; another sender of the same user still has room.
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 100 }, payload: BUILD, operation_id: "n0" }))
                .toMatchObject({ ok: true, replayed: true });
            const other = await sessionOf(h, alice);
            expect(await other.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "n0" }))
                .toMatchObject({ ok: true, replayed: false, claimedBy: { stateId: "await_build" } });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
        } finally { await h.stop(); }
    });
});
