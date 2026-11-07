/**
 * A worker process for the join crash and compatibility tests (J3 JK-07, JK-21, JK-23; HG-2): forked by
 * workflow-v2-join-harness.js, it registers controller 1.9.0 and its activities from a built SDK on the test's provider
 * and catalog, test-only as the in-process harness does, with 2 s locks so a new worker takes over work a stopped or
 * killed one held within seconds. The build is this one's dist/ unless the start message names another (`dist`: an
 * absolute path to a built packages/sdk/dist, for example of 8d568890); duroxide is loaded from beside that build.
 * PILOTSWARM_FAULT_INJECT, set by the test for this process only, makes it die (process.exit(137)) at a named fault
 * point. It answers "ready" once its runtime runs; "create" makes a workflow with a started live run through that build's
 * service (its compiler and store); "stop" stops it.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_DIST = fileURLToPath(new URL("../../dist", import.meta.url));

let started = null;

async function start(message) {
    const dist = typeof message.dist === "string" && message.dist ? message.dist : DEFAULT_DIST;
    const load = file => import(pathToFileURL(`${dist}/${file}`).href);
    const [{ PgSessionCatalog }, { registerWorkflowV2, sessionQueueTransport }, { WORKFLOW_REQUEST_CAPABILITY }, { createWorkflowV2 }] = await Promise.all([
        load("cms.js"), load("workflow/v2/runtime.js"), load("activity-routing.js"), load("workflow/v2/service.js")]);
    const { Runtime, Client, PostgresProvider } = createRequire(pathToFileURL(`${dist}/index.js`).href)("duroxide");
    const catalog = await PgSessionCatalog.create(message.store, message.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(message.store, message.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: 16, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 2_000,
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: Number.isSafeInteger(message.wakeBackstopMs) ? message.wakeBackstopMs : 500, workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    started = { catalog, store, client, runtime, createWorkflowV2 };
}

process.on("message", async message => {
    try {
        if (message?.type === "start") {
            await start(message);
            process.send({ type: "ready", pid: process.pid });
        } else if (message?.type === "create") {
            const parent = randomUUID();
            await started.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            try {
                const created = await started.createWorkflowV2({ catalog: started.catalog, store: started.store, duroxideClient: started.client, requests: true }, {
                    workflowSessionId, parentSessionId: parent, yaml: message.yaml, actor: { kind: "system", name: "workflow-v2-join-compat" },
                    operationId: "start", start: { inputs: {} } });
                process.send({ type: "created", requestId: message.requestId, parent, workflowSessionId, valid: created.receipt.valid,
                    runId: created.receipt.run?.runId ?? null, diagnostics: created.receipt.diagnostics ?? [] });
            } catch (error) {
                process.send({ type: "created", requestId: message.requestId, parent, workflowSessionId, refused: { code: error?.code ?? null, message: String(error?.message ?? error) } });
            }
        } else if (message?.type === "stop") {
            try { await started?.runtime.shutdown(100); } catch { /* stopping anyway */ }
            try { await started?.catalog.close(); } catch { /* stopping anyway */ }
            process.exit(0);
        }
    } catch (error) {
        process.send({ type: "error", error: String(error?.stack ?? error) });
        if (message?.type === "start") process.exit(1);
    }
});
