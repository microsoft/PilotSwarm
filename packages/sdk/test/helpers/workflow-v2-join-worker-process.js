/**
 * A worker process for the join crash tests (J3 JK-07; HG-2): forked by workflow-v2-join-robust.test.js, it registers
 * controller 1.9.0 and its activities from the built SDK (dist/, as the kill harness's workers run built code) on the
 * test's provider and catalog, test-only as the in-process harness does, with 2 s locks so a new worker takes over work a
 * killed one held within seconds. PILOTSWARM_FAULT_INJECT, set by the test for this process only, makes it die
 * (process.exit(137)) at a named fault point inside an activity: a real process death between a store write and the
 * activity's acknowledgement. It answers "ready" once its runtime runs, and stops on "stop".
 */
import { createRequire } from "node:module";
import { PgSessionCatalog } from "../../dist/cms.js";
import { registerWorkflowV2, sessionQueueTransport } from "../../dist/workflow/v2/runtime.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../dist/activity-routing.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");

process.on("message", async message => {
    if (message?.type !== "start") return;
    try {
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
            wakeBackstopMs: 500, workflowRequests: true,
            sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        });
        await runtime.start();
        process.send({ type: "ready", pid: process.pid });
        process.on("message", async stop => {
            if (stop?.type !== "stop") return;
            try { await runtime.shutdown(100); } catch { /* stopping anyway */ }
            try { await catalog.close(); } catch { /* stopping anyway */ }
            process.exit(0);
        });
    } catch (error) {
        process.send({ type: "error", error: String(error?.stack ?? error) });
        process.exit(1);
    }
});
