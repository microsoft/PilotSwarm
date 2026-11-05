/**
 * The harness of the robust join tests (J3; test design join-k-of-n, hooks HG-1, HG-3, HG-4 and HG-10), against the
 * real store on PostgreSQL and controller 1.9.0 on a native duroxide runtime (test-only registration):
 *
 * - joinBaseOf: one catalog, store, provider and client for a test, and a private pg pool (`q`) to read rows the store
 *   writes, as SQL sees them (their exact completed_at, deadline_at and commit rank; HG-3).
 * - joinRuntimeOn: a worker-equivalent registration on that base. `wrap` replaces a registered activity with a wrapper
 *   around the real handler (HG-1): the real handler always runs; a wrapper may hold it at a gate, call it again, change
 *   what it answers, or throw after it returned (a lost acknowledgement), and counts what happened. Several runtimes
 *   may run one after another on a base (a restart).
 * - gate, within, until: barriers that say when they were reached, and bounded waits whose failures name what they
 *   waited for (HG-10). A precondition a test could not reach is reported as VOID, never as a pass.
 * - startJoin: a published live run of a definition, with its parallel state's and its branches' node execution ids.
 * - commitOrder: the SQL commit order of node executions (HG-3); executionsOf: the controller's executions, so a test
 *   sees a real continue-as-new (HG-4).
 *
 * Nothing here changes the product: wrappers sit at the registration a worker makes, as the faults tests' do.
 */
import { expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { branchScopeId, registerWorkflowV2, sessionQueueTransport, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");

export const JOIN_ACTOR = { kind: "system", name: "workflow-v2-join-robust-test" };
export const ENDED_RUN_STATUSES = ["completed", "failed", "cancelled", "stopped"];
/** Enough worker slots for every branch and the controller (DEV of 206c4198: duroxide's default is 2). */
export const JOIN_WORKER_SLOTS = 16;

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wait until `check` gives a truthy value; fail naming `label` and the last value seen. */
export async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** `promise`, or a failure naming `label` after `ms`. */
export function within(promise, ms, label) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms); })])
        .finally(() => clearTimeout(timer));
}

/** A gate the test opens; `reached` resolves when code arrives at it, and `arrivals` counts them. */
export function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    const state = { arrivals: 0, isOpen: false };
    return {
        reached, state,
        arrive: () => { state.arrivals += 1; arrive(); },
        wait: () => opened,
        open: () => { state.isOpen = true; open(); },
    };
}

/** A definition as a document (JSON is YAML). */
export const yamlOf = doc => JSON.stringify(doc, null, 2);
const head = name => ({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name, version: "1.0.0" } });

/**
 * Each branch's script waits its item's `ms`, then ends `bad` for an item with `fail`, `hold` for an item with `seconds`
 * (a wait of that many seconds, then success), and `ok` otherwise; its output is its index and its item (as the join
 * tests' WORK).
 */
export const WORK = "const item = context.input;\n"
    + "await new Promise(resolve => setTimeout(resolve, item.ms ?? 0));\n"
    + "await setResult(item.fail ? \"bad\" : item.seconds ? \"hold\" : \"ok\", { index: context.branch.index, ...item });\n";

/** A parallel state over `items` (the join tests' joinDoc): its join, failFast, concurrency and time limit as given. */
export function joinDoc({ items = [], forEach = "${input.items}", join, failFast = false, concurrency, timeoutSeconds, name = "join-robust", work = WORK } = {}) {
    const timed = timeoutSeconds !== undefined;
    return {
        ...head(name),
        initialInput: { items },
        initial: "fan",
        states: {
            fan: {
                type: "parallel", forEach, concurrency: concurrency ?? Math.max(1, Math.min(Array.isArray(items) ? items.length : 1, 16)),
                ...(join !== undefined ? { join } : {}), ...(failFast ? { failFast: true } : {}), ...(timed ? { timeoutSeconds } : {}),
                body: {
                    initial: "work",
                    states: {
                        work: { type: "script", source: work, transition: { next: { ok: "done", bad: "refused", hold: "hold" } } },
                        hold: { type: "wait", seconds: "${input.seconds}", transition: { next: { elapsed: "done" } } },
                        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                        refused: { type: "terminal", outcome: "blocked", output: "${input}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed", ...(timed ? { timed_out: "late" } : {}) } },
            },
            finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
            stuck: { type: "terminal", outcome: "blocked", output: "${input}" },
            failed: { type: "terminal", outcome: "failed" },
            ...(timed ? { late: { type: "terminal", outcome: "blocked", output: "${input}" } } : {}),
        },
    };
}

/**
 * HG-5: a branch script that reports to `item.probe` its start with its process id (`/start/<index>/<pid>`), waits
 * `item.ms`, then reports a side effect it makes only after the wait (`/late/<index>`), then ends `ok` (`bad` for an item
 * with `fail`). Without a probe it only waits.
 */
export const PROBED_WORK = "const item = context.input;\n"
    + "if (item.probe) await fetch(`${item.probe}/start/${context.branch.index}/${process.pid}`);\n"
    + "await new Promise(resolve => setTimeout(resolve, item.ms ?? 0));\n"
    + "if (item.probe) await fetch(`${item.probe}/late/${context.branch.index}`);\n"
    + "await setResult(item.fail ? \"bad\" : \"ok\", { index: context.branch.index, ms: item.ms ?? 0 });\n";

/** A loopback server the probed scripts report to: which started (with their process ids), and which made a late effect. */
export async function probeServer() {
    const { createServer } = await import("node:http");
    const hits = [];
    const server = createServer((req, res) => {
        hits.push(req.url);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        count: prefix => hits.filter(hit => hit.startsWith(prefix)).length,
        /** The process id branch `index` reported when it started, or null. */
        pidOf: index => {
            const hit = hits.find(item => item.startsWith(`/start/${index}/`));
            return hit ? Number(hit.split("/")[3]) : null;
        },
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
    };
}

/** Whether process `pid` still exists (signal 0; EPERM: it exists, owned by someone else). */
export function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

/** A wait's success as its elapse stores it (outcome elapsed), with `value` as its output. */
export const elapsedResult = (value = { seconds: 600 }) => ({ outcome: "elapsed", resultKind: "business", valueText: canonicalJson(value), winner: "controller" });

/** One test's catalog, store, provider and client, and a pg pool for SQL reads of what the store wrote. */
export async function joinBaseOf(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const pool = new pg.Pool({ connectionString: env.store, max: 2, connectionTimeoutMillis: 10_000 });
    const q = async (text, params = []) => (await pool.query(text.replaceAll("SCHEMA.", `"${env.cmsSchema}".`), params)).rows;
    return {
        catalog, store, provider, client, q, pool, schema: env.cmsSchema,
        host: { catalog, store, duroxideClient: client, requests: true },
        async close() {
            try { await catalog.close(); } finally { await pool.end(); }
        },
    };
}

/**
 * A worker-equivalent registration on `base` (workflowRequests, the request tag declared), with `wrap` (activity name ->
 * (realHandler) => handler) around the real handlers (HG-1). `calls` counts each wrapped activity's deliveries; `handlers`
 * are the real registered handlers, so a test can call one as a contender exactly as a delivery would (with the events it
 * records). The activity lock is a PilotSwarm worker's default (10 s, renewed every 5 s while an activity runs: a running
 * activity also learns of its orchestration's cancellation at a renewal); `fastLocks` shortens it (2 s, the shortest that renews: duroxide 0.1.32 renews a lock under 15 s at half its
 * timeout rounded up to whole seconds, and duroxide-pg extends by whole seconds) for a test that stops a runtime with work
 * in flight and needs it taken over quickly.
 */
export async function joinRuntimeOn(base, { wrap = {}, workerConcurrency = JOIN_WORKER_SLOTS, wakeBackstopMs = 500, fastLocks = false, deps = {} } = {}) {
    const runtime = new Runtime(base.provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        ...(fastLocks ? { workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 2_000 } : { workerLockTimeoutMs: 10_000 }),
    });
    const calls = {};
    const handlers = {};
    registerWorkflowV2({
        registerActivity: (name, fn) => {
            handlers[name] = fn;
            return runtime.registerActivity(name, wrap[name]
                ? (() => { const wrapped = wrap[name](fn); return async (ctx, input) => { calls[name] = (calls[name] ?? 0) + 1; return wrapped(ctx, input); }; })()
                : fn);
        },
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: base.store, catalog: base.catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => base.catalog.softDeleteSession(sessionId),
        wakeBackstopMs, workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(base.client), version: async () => "1.0.83" },
        ...deps,
    });
    await runtime.start();
    let running = true;
    return { calls, handlers, async stop() { if (!running) return; running = false; await runtime.shutdown(100); } };
}

/**
 * A published live run of `doc`, created by a new parent session: its ids, its parallel state's node execution (`fan`)
 * and `at(index, nodeId, ordinal)`, a branch state's node execution id.
 */
export async function startJoin(base, doc) {
    const parent = randomUUID();
    await base.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2(base.host, {
        workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: JOIN_ACTOR, operationId: "start", start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const runId = created.receipt.run.runId;
    const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
    return {
        parent, workflowSessionId, runId, fan, controller: workflowLiveControllerInstanceId(workflowSessionId),
        scope: index => branchScopeId(fan, index),
        at: (index, nodeId, ordinal = 1) => nodeExecutionIdFor(runId, branchScopeId(fan, index), nodeId, ordinal),
    };
}

/** The run once it has ended (`timeoutMs` bound). */
export const endOf = (base, runId, timeoutMs = 90_000) => until(async () => {
    const run = await base.store.readRun(runId);
    return run && ENDED_RUN_STATUSES.includes(run.status) ? run : null;
}, `run ${runId} to end`, timeoutMs);

/** Wait until every node execution of `ids` is stored with `state` (pending, by default). */
export const persisted = (base, ids, label, state = "pending", timeoutMs = 90_000) => until(async () => {
    const rows = await Promise.all(ids.map(id => base.store.readNodeExecution(id)));
    return rows.every(row => row?.state === state) ? rows : null;
}, label, timeoutMs);

/** The rows of a branch scope, in entry order. */
export const branchRowsOf = async (base, run, index) =>
    (await base.store.listNodeExecutions(run.runId)).filter(node => node.scopeId === run.scope(index));

/** The workflow session's events (the first `limit`). */
export const eventsOf = (base, workflowSessionId, limit = 2_000) => base.catalog.getSessionEvents(workflowSessionId, 0, limit);

/**
 * HG-3: the commit order of `ids` as SQL sees it: each one's exact completed_at as text, its rank (equal times share a
 * rank) and, given a parallel state (`parallelId`), whether it was committed at or before that state's deadline.
 */
export async function commitOrder(base, ids, parallelId = null) {
    const rows = await base.q(
        `SELECT node.node_execution_id AS id, node.completed_at::text AS at, dense_rank() OVER (ORDER BY node.completed_at) AS rank,
                ${parallelId ? "(parallel.deadline_at IS NULL OR node.completed_at <= parallel.deadline_at)" : "NULL::boolean"} AS in_time
           FROM SCHEMA.workflow_node_executions AS node
           ${parallelId ? "JOIN SCHEMA.workflow_node_executions AS parallel ON parallel.node_execution_id = $2" : ""}
          WHERE node.node_execution_id = ANY($1::text[]) AND node.completed_at IS NOT NULL
          ORDER BY node.completed_at, node.node_execution_id`, parallelId ? [ids, parallelId] : [ids]);
    return rows.map(row => ({ id: row.id, at: row.at, rank: Number(row.rank), inTime: row.in_time }));
}

/** HG-4: the controller instance's executions (more than one: it continued as new). */
export const executionsOf = (base, instanceId) => base.client.listExecutions(instanceId);

/** The inputs of every `name` activity a controller instance scheduled, in every execution. */
export async function scheduledInputs(base, instanceId, name) {
    const executions = await base.client.listExecutions(instanceId);
    const histories = await Promise.all(executions.map(id => base.client.readExecutionHistory(instanceId, id)));
    const prefix = `{"name":${JSON.stringify(name)}`;
    return histories.flat().filter(event => event.kind === "ActivityScheduled" && String(event.data).startsWith(prefix)).map(event => {
        const payload = JSON.parse(event.data);
        return typeof payload.input === "string" ? JSON.parse(payload.input) : payload.input;
    });
}

/**
 * HG-2: fork a separate worker process (workflow-v2-join-worker-process.js, built code) on the test's database, armed to
 * die at `faultInject` (PILOTSWARM_FAULT_INJECT, for that process only). Returns its `pid`, `ready` (its runtime runs),
 * `exited` ({ code, signal }), its `logs`, and `stop()`.
 */
export async function forkJoinWorker(env, { faultInject = null } = {}) {
    const { fork } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const script = fileURLToPath(new URL("./workflow-v2-join-worker-process.js", import.meta.url));
    const child = fork(script, [], {
        env: { ...process.env, ...(faultInject ? { PILOTSWARM_FAULT_INJECT: faultInject } : { PILOTSWARM_FAULT_INJECT: "" }) },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const logs = [];
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => logs.push(...String(data).split("\n").filter(Boolean)));
    const exited = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the worker process did not start in 45 s: ${logs.join("\n")}`)), 45_000);
        child.on("message", message => {
            if (message?.type === "ready") { clearTimeout(timer); resolve(message.pid); }
            if (message?.type === "error") { clearTimeout(timer); reject(new Error(`the worker process failed: ${message.error}`)); }
        });
        child.on("error", error => { clearTimeout(timer); reject(error); });
    });
    child.send({ type: "start", store: env.store, cmsSchema: env.cmsSchema, duroxideSchema: env.duroxideSchema });
    return {
        pid: child.pid, ready, exited, logs,
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.send({ type: "stop" });
            await Promise.race([exited, pause(5_000)]);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        },
    };
}
