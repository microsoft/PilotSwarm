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
 *   receive, and a wait that elapses first does not discard it;
 * - a wrong sender, contract or correlation is not taken and does not move
 *   the deadline; an undeclared contract or an invalid payload stores
 *   nothing; a session of another user may not send, and a receive may not
 *   name one as its sender;
 * - a paused run takes input, and its receive may take it, but it admits
 *   nothing until it is resumed;
 * - each input is accepted once per (sender, operation id), and the inbox is
 *   bounded.
 *
 * Messaging is not yet in the formal models (README "Messaging"); these
 * regressions are its evidence.
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
import { createWorkflowV2, WORKFLOW_V2_INBOX_LIMITS } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, sendWorkflowInputFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_CONTROLLER_VERSION, workflowEffectInstanceId,
} from "../../src/workflow/v2/runtime.ts";

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

/** A worker-equivalent registration with one durable provider; `refusals` lists runs whose admission was refused for a pause. */
async function harness(env, { wakeBackstopMs = 500 } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
    const refusals = [];
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, name !== WORKFLOW_V2_ACTIVITIES.enter ? fn : async (ctx, input) => {
            const entered = await fn(ctx, input);
            if (entered.admitted === false && entered.status === "paused") refusals.push(input.runId);
            return entered;
        }),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog,
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
        catalog, store, client, refusals, host,
        /** The host with a controller start that never reaches duroxide: a run stays admitted, its controller absent. */
        undispatched: { ...host, duroxideClient: { ...client, startOrchestrationVersioned: async () => undefined,
            getStatus: id => client.getStatus(id), enqueueEvent: (...args) => client.enqueueEvent(...args) } },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function finished(store, runId, timeoutMs = 60_000) {
    return until(async () => {
        const run = await store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, timeoutMs);
}

/** A session (parent, peer or stranger) and the tool calls it makes. */
async function sessionOf(h, owner = null) {
    const sessionId = randomUUID();
    await h.catalog.createSession(sessionId, owner ? { owner } : {});
    const context = { callerSessionId: sessionId, host: h.host };
    return {
        sessionId,
        send: async (workflowId, args) => JSON.parse(await sendWorkflowInputFromTool({ workflow_id: workflowId, ...args }, context)),
        update: async (workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        read: async (workflowId, args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
    };
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
        const parentOnly = compileWorkflowV2(RECEIVER({ wait: false }).replace("    correlate:", "    from: { parent: true }\n    correlate:"));
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
            [RECEIVER().replace("mode: receive", "mode: send"), "WORKFLOW_FEATURE_UNSUPPORTED", "states.await_build.mode"],
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
            expect(expiring).toMatchObject({ ok: true, runId: run.runId, contract: "BuildEvent@1", replayed: false, claimedBy: null });
            // Wait (on the store's clock) until it has expired, then give two more.
            const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
            try {
                await until(async () => (await pool.query("SELECT clock_timestamp() > $1::timestamptz AS past", [expiring.expiresAt])).rows[0].past, "the first input to expire");
            } finally { await pool.end(); }
            const earlier = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "second" });
            const later = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "failed" }, operation_id: "third" });
            expect([earlier.claimedBy, later.claimedBy]).toEqual([null, null]);

            await run.startController();
            const ended = await finished(h.store, run.runId);
            expect(ended).toMatchObject({ status: "completed", terminalOutput: BUILD });
            const [receive] = await nodesOf(h.store, run.runId);
            // Taken when the state was entered, in that transaction: the earliest unexpired input.
            expect(receive).toMatchObject({ nodeId: "await_build", nodeType: "messaging", state: "completed", outcome: "received", resultKind: "business",
                winner: "message", output: BUILD, deadlineAt: null, effectAttempts: 0,
                receive: { contract: "BuildEvent@1", from: null, correlation: { buildId: 7 } } });
            expect(receive.completedAt).toEqual(receive.enteredAt);
            const inbox = await h.store.listInbox(run.runId);
            expect(inbox.map(message => [message.operationId, message.consumedBy])).toEqual([["first", null], ["second", receive.nodeExecutionId], ["third", null]]);
            expect(inbox[1].consumedAt).toEqual(receive.enteredAt);
            expect((await h.client.getStatus(workflowEffectInstanceId(receive.nodeExecutionId))).status).toBe("NotFound");

            // A repeat returns the receipt as it is now; another input with the id is refused.
            const repeat = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "second" });
            expect(repeat).toMatchObject({ ok: true, replayed: true, messageId: earlier.messageId,
                claimedBy: { nodeExecutionId: receive.nodeExecutionId, stateId: "await_build" } });
            const conflict = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: { buildId: 7, state: "running" }, operation_id: "second" });
            expect(conflict).toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            // The run has ended: new input is refused, and nothing is stored.
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "late" }))
                .toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            expect((await h.store.listInbox(run.runId)).length).toBe(3);
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
            const claimed = await h.store.readNodeExecution(waiting.nodeExecutionId);
            expect(claimed).toMatchObject({ state: "completed", outcome: "received", winner: "message", output: BUILD, deadlineAt: waiting.deadlineAt });
            expect(claimed.completedAt.toISOString()).toBe(sent.acceptedAt);
            expect(claimed.completedAt.getTime()).toBeLessThan(waiting.deadlineAt.getTime());
            expect(await finished(h.store, quick.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });

            // An input accepted at or after the deadline is late for that receive (fault injection: the stored
            // deadline moves back after the controller read it, so the controller elapses the wait later).
            const late = await started(h, parent, RECEIVER(), { vars: { secs: 4 } });
            const pending = await nodeAt(h.store, late.runId, "await_build", 1, "pending");
            const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
            try {
                await pool.query(`UPDATE "${getEnv().cmsSchema}".workflow_node_executions SET deadline_at = clock_timestamp() - interval '1 second'
                                   WHERE node_execution_id = $1`, [pending.nodeExecutionId]);
            } finally { await pool.end(); }
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
            const parent = await sessionOf(h);
            const reporter = await sessionOf(h);
            const peer = await sessionOf(h);
            const run = await started(h, parent, RECEIVER({ from: true }), { vars: { secs: 60, reporter: reporter.sessionId } });
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

    it("takes input while paused without admitting anything until the run is resumed", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await sessionOf(h);
            const run = await started(h, parent, RECEIVER(), { vars: { secs: 60 } });
            const waiting = await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            expect(await parent.update(run.id, { operation: "pause", run_id: run.runId, operation_id: "pause" })).toMatchObject({ ok: true, status: "paused" });
            const sent = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "build" });
            expect(sent).toMatchObject({ ok: true, claimedBy: { nodeExecutionId: waiting.nodeExecutionId } });
            // The controller routes the result and tries to admit the next state: refused, the run is paused.
            await until(async () => h.refusals.includes(run.runId), "the next admission to be refused for the pause");
            expect((await h.store.readRun(run.runId)).status).toBe("paused");
            expect((await nodesOf(h.store, run.runId)).map(node => node.nodeId)).toEqual(["await_build"]);
            expect(await parent.update(run.id, { operation: "resume", run_id: run.runId, operation_id: "resume" })).toMatchObject({ ok: true });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
        } finally { await h.stop(); }
    });

    it("bounds a run's unclaimed input per sender, and stores nothing past the bound", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await sessionOf(h);
            const run = await started(h, parent, RECEIVER(), { vars: { secs: 60 } });
            await nodeAt(h.store, run.runId, "await_build", 1, "pending");
            const bound = WORKFLOW_V2_INBOX_LIMITS.maxUnconsumedPerSender;
            for (let index = 0; index < bound; index += 1) {
                const sent = await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 100 + index }, payload: BUILD, operation_id: `n${index}` });
                expect(sent, `input ${index}`).toMatchObject({ ok: true, claimedBy: null });
            }
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 999 }, payload: BUILD, operation_id: "over" }))
                .toMatchObject({ ok: false, error: { code: "INBOX_FULL" } });
            expect((await h.store.listInbox(run.runId)).length).toBe(bound);
            // A repeat of an accepted input is still answered; another sender still has room.
            expect(await parent.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 100 }, payload: BUILD, operation_id: "n0" }))
                .toMatchObject({ ok: true, replayed: true });
            const other = await sessionOf(h);
            expect(await other.send(run.id, { contract: "BuildEvent@1", correlation: { buildId: 7 }, payload: BUILD, operation_id: "n0" }))
                .toMatchObject({ ok: true, replayed: false, claimedBy: { stateId: "await_build" } });
            expect(await finished(h.store, run.runId)).toMatchObject({ status: "completed", terminalOutput: BUILD });
        } finally { await h.stop(); }
    });
});
