/**
 * Standalone worker process for multi-process repro test.
 *
 * Spawned by concurrent-sessions-repro.test.js via child_process.fork().
 * Receives config via IPC, starts a PilotSwarmWorker, signals readiness,
 * and stays alive until told to stop.
 */

import { PilotSwarmWorker, FilesystemSessionStore } from "../../dist/index.js";

process.on("message", async (msg) => {
    if (msg.type === "start") {
        try {
            // Kill-harness support for workspace tests: the reference repo
            // workspace provider, talking to a repo service in the test process.
            let workspaceProvider = null;
            if (msg.repoWorkspaces) {
                const { createRepoWorkspaceProvider } = await import("../../examples/repo-workspaces/provider.mjs");
                const { rootName, rootPath, serviceUrl } = msg.repoWorkspaces;
                workspaceProvider = createRepoWorkspaceProvider({ roots: [{ name: rootName, path: rootPath }], serviceUrls: { [rootName]: serviceUrl } });
            }
            const worker = new PilotSwarmWorker({
                store: msg.store,
                githubToken: msg.githubToken,
                duroxideSchema: msg.duroxideSchema,
                cmsSchema: msg.cmsSchema,
                factsSchema: msg.factsSchema,
                sessionStateDir: msg.sessionStateDir,
                workerNodeId: msg.workerNodeId,
                disableManagementAgents: true,
                logLevel: msg.logLevel || "warn",
                ...(msg.modelProvidersPath ? { modelProvidersPath: msg.modelProvidersPath } : {}),
                ...(workspaceProvider ? { workspaceProvider } : {}),
                // Kill-harness support: an explicit SHARED snapshot store dir
                // (separate worker "disks" + one store, like pods sharing
                // blob storage). Without it, the store derives from
                // sessionStateDir's parent as before.
                ...(msg.sessionStoreDir
                    ? { sessionStore: new FilesystemSessionStore(msg.sessionStoreDir, msg.sessionStateDir) }
                    : {}),
            });
            await worker.start();

            process.send({ type: "ready", workerNodeId: msg.workerNodeId });

            process.on("message", async (stopMsg) => {
                if (stopMsg.type === "stop") {
                    try { await worker.stop(); } catch {}
                    process.exit(0);
                }
                // Graceful drain (lifecycle protocol §3.8): finish in-flight
                // turns, release idle workspaces, then exit.
                if (stopMsg.type === "drain") {
                    // gracefulShutdown() ends with stop().
                    try { await worker.gracefulShutdown(); } catch (err) {
                        process.send({ type: "drain-error", error: err?.message ?? String(err) });
                    }
                    process.exit(0);
                }
            });
        } catch (err) {
            process.send({ type: "error", error: err.message });
            process.exit(1);
        }
    }
});
