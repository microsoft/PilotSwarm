import { readFileSync } from "node:fs";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    FilesystemArtifactStore,
    PilotSwarmClient,
    PilotSwarmManagementClient,
    PilotSwarmWorker,
    WorkflowStateProviderRegistry,
} from "../../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PROCESS = path.join(__dirname, "worker-process.js");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../../");

export const WORKFLOW_PACKAGE_ROOT = path.resolve(
    __dirname,
    "../fixtures/workflow-package",
);
export const REGISTERED_CONTROL_WORKFLOW_YAML = readFileSync(
    path.join(WORKFLOW_PACKAGE_ROOT, "registered-control.workflow.yaml"),
    "utf8",
);

export function createWorkflowWorker(env, workflowStateProviders, workerNodeId) {
    return new PilotSwarmWorker({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId,
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        workflowStateProviders,
    });
}

export function createWorkflowClient(env) {
    return new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
}

export function createWorkflowManagementClient(env) {
    return new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        artifactStore: new FilesystemArtifactStore(
            path.join(env.baseDir, "artifacts"),
        ),
    });
}

export async function registerControlWorkflow(management) {
    return management.registerWorkflowDefinition(
        REGISTERED_CONTROL_WORKFLOW_YAML,
        { packageRoot: WORKFLOW_PACKAGE_ROOT },
    );
}

export function createWorkflowResourceTracker() {
    const resources = [];
    return {
        add(resource) {
            resources.push(resource);
            return resource;
        },
        async start(resource) {
            await resource.start();
            resources.push(resource);
            return resource;
        },
        remove(resource) {
            const index = resources.indexOf(resource);
            if (index >= 0) resources.splice(index, 1);
        },
        async stopAll() {
            for (const resource of resources.splice(0).reverse()) {
                try {
                    await resource.stop();
                } catch {}
            }
        },
    };
}

export function createSuccessfulWorkflowProviders({
    onAction = () => {},
    onObservation = () => {},
    retryAfterMs = 100,
} = {}) {
    const writtenMarkers = new Set();
    return new WorkflowStateProviderRegistry()
        .registerAction("test-memory", request => {
            onAction(request);
            const marker = request.input?.marker;
            writtenMarkers.add(marker);
            return {
                outcome: "succeeded",
                output: { marker },
            };
        })
        .registerObservedCondition("test-memory", request => {
            onObservation(request);
            const marker = request.operation?.marker;
            if (request.observationAttempt === 1) {
                return { status: "pending", retryAfterMs };
            }
            return {
                status: "completed",
                outcome: "satisfied",
                output: {
                    marker,
                    observed: writtenMarkers.has(marker),
                    observationAttempt: request.observationAttempt,
                },
            };
        });
}

export async function waitForWorkflow(
    management,
    sessionId,
    predicate,
    timeoutMs = 30_000,
) {
    const deadline = Date.now() + timeoutMs;
    let projection;
    while (Date.now() < deadline) {
        projection = await management.getWorkflow(sessionId);
        if (projection && predicate(projection)) return projection;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(
        `Workflow ${sessionId} did not reach the expected state; ` +
        `last projection: ${JSON.stringify(projection)}`,
    );
}

export async function waitForCondition(predicate, description, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

export function workflowEffectPath(effectDir, marker) {
    return path.join(
        effectDir,
        `${String(marker).replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`,
    );
}

export function forkWorkflowWorker(
    env,
    workerNodeId,
    { effectDir, exitAfterActionEffect = false } = {},
) {
    const child = fork(WORKER_PROCESS, [], {
        cwd: WORKSPACE_ROOT,
        env: {
            ...process.env,
            PILOTSWARM_WORKER_LOCK_TIMEOUT_MS: "2000",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const logs = [];
    child.stdout.on("data", data => logs.push(data.toString()));
    child.stderr.on("data", data => logs.push(data.toString()));
    const exited = new Promise(resolve => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error(`Worker ${workerNodeId} did not start.`)),
            45_000,
        );
        child.on("message", function onMessage(message) {
            if (message.type === "ready") {
                clearTimeout(timeout);
                child.off("message", onMessage);
                resolve();
            } else if (message.type === "error") {
                clearTimeout(timeout);
                child.off("message", onMessage);
                reject(new Error(message.error));
            }
        });
    });
    child.send({
        type: "start",
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        workflowTestProvider: {
            effectDir,
            exitAfterActionEffect,
        },
    });
    return {
        child,
        ready,
        exited,
        logs,
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
                child.send({ type: "stop" });
            } catch {}
            await Promise.race([
                exited,
                new Promise(resolve => setTimeout(resolve, 3_000)),
            ]);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await exited;
            }
        },
    };
}
