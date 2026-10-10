/**
 * Standalone worker process for multi-process repro test.
 *
 * Spawned by concurrent-sessions-repro.test.js via child_process.fork().
 * Receives config via IPC, starts a PilotSwarmWorker, signals readiness,
 * and stays alive until told to stop.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    PilotSwarmWorker,
    FilesystemSessionStore,
    WorkflowStateProviderRegistry,
} from "../../dist/index.js";

function workflowEffectFilename(marker) {
    return `${String(marker).replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
}

function createWorkflowTestProviders(config) {
    if (!config) return undefined;
    mkdirSync(config.effectDir, { recursive: true });
    const attemptsPath = path.join(config.effectDir, "attempts.jsonl");
    return new WorkflowStateProviderRegistry()
        .registerAction("test-memory", request => {
            const marker = request.input?.marker;
            const effectPath = path.join(
                config.effectDir,
                workflowEffectFilename(marker),
            );
            let applied = false;
            try {
                writeFileSync(
                    effectPath,
                    JSON.stringify({
                        marker,
                        workflowSessionId: request.workflowSessionId,
                        stateId: request.stateId,
                        executionSequence: request.executionSequence,
                    }),
                    { flag: "wx" },
                );
                applied = true;
            } catch (error) {
                if (error?.code !== "EEXIST") throw error;
            }
            appendFileSync(attemptsPath, `${JSON.stringify({
                marker,
                workflowSessionId: request.workflowSessionId,
                stateId: request.stateId,
                executionSequence: request.executionSequence,
                applied,
            })}\n`);
            if (config.exitAfterActionEffect) {
                console.error(
                    `[workflow-test-provider] exiting after action effect marker=${marker}`,
                );
                process.exit(137);
            }
            return {
                outcome: "succeeded",
                output: { marker, applied },
            };
        })
        .registerObservedCondition("test-memory", request => {
            const marker = request.operation?.marker;
            const effectPath = path.join(
                config.effectDir,
                workflowEffectFilename(marker),
            );
            return {
                status: "completed",
                outcome: "satisfied",
                output: {
                    marker,
                    observed: existsSync(effectPath),
                    effectPath,
                    observationAttempt: request.observationAttempt,
                },
            };
        });
}

process.on("message", async (msg) => {
    if (msg.type === "start") {
        try {
            const workflowStateProviders = createWorkflowTestProviders(
                msg.workflowTestProvider,
            );
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
                // Kill-harness support: an explicit SHARED snapshot store dir
                // (separate worker "disks" + one store, like pods sharing
                // blob storage). Without it, the store derives from
                // sessionStateDir's parent as before.
                ...(msg.sessionStoreDir
                    ? { sessionStore: new FilesystemSessionStore(msg.sessionStoreDir, msg.sessionStateDir) }
                    : {}),
                ...(workflowStateProviders ? { workflowStateProviders } : {}),
            });
            await worker.start();

            process.send({ type: "ready", workerNodeId: msg.workerNodeId });

            process.on("message", async (stopMsg) => {
                if (stopMsg.type === "stop") {
                    try { await worker.stop(); } catch {}
                    process.exit(0);
                }
            });
        } catch (err) {
            process.send({ type: "error", error: err.message });
            process.exit(1);
        }
    }
});
