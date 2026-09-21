#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    PilotSwarmWorker,
    StickyRepositoryWorkspace,
} from "pilotswarm-sdk";
import { resolveModelProvidersPath } from "../dist/model-providers.js";

function requireEnv(name) {
    const value = String(process.env[name] ?? "").trim();
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function parsePluginDirs() {
    return String(process.env.PLUGIN_DIRS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => path.resolve(value));
}

function configureWorkerConcurrency() {
    const configured = String(process.env.PILOTSWARM_WORKER_CONCURRENCY ?? "2").trim();
    const slots = Number.parseInt(configured, 10);
    if (!/^[1-9][0-9]*$/.test(configured) || !Number.isSafeInteger(slots) || slots < 2) {
        throw new Error(
            "Repository workers require PILOTSWARM_WORKER_CONCURRENCY>=2 "
            + "so abortTurn can run while a repository turn is active",
        );
    }
    process.env.PILOTSWARM_WORKER_CONCURRENCY = String(slots);
}

function writeReadyFile(file, status) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify({
            ready: true,
            directory: status.directory,
            headSha: status.headSha,
            sessionId: status.sessionId,
            pid: process.pid,
        }),
        "utf8",
    );
}

function removeReadyFile(file) {
    if (!file) return;
    fs.rmSync(file, { force: true });
}

async function main() {
    configureWorkerConcurrency();

    const databaseUrl = requireEnv("DATABASE_URL");
    const repositoryUrl = requireEnv("REPOSITORY_URL");
    const repositoryDirectory = path.resolve(
        process.env.REPOSITORY_WORKSPACE_DIR ?? "./repository-workspace",
    );
    const targetRef = String(process.env.REPOSITORY_REF ?? "").trim() || null;
    const readyFileValue = String(process.env.REPOSITORY_READY_FILE ?? "").trim();
    const readyFile = readyFileValue ? path.resolve(readyFileValue) : null;
    const sessionStateDirValue = String(process.env.SESSION_STATE_DIR ?? "").trim();
    const sessionStateDir = sessionStateDirValue
        ? path.resolve(sessionStateDirValue)
        : undefined;
    const configuredModelProvidersPath = String(
        process.env.PS_MODEL_PROVIDERS_PATH
        || process.env.MODEL_PROVIDERS_PATH
        || "",
    ).trim();
    const discoveredModelProvidersPath = resolveModelProvidersPath(
        configuredModelProvidersPath || undefined,
    );
    const modelProvidersPath = discoveredModelProvidersPath
        ? path.resolve(discoveredModelProvidersPath)
        : undefined;
    const pluginDirs = parsePluginDirs();
    const trace = (message) => console.log(message);
    const repository = new StickyRepositoryWorkspace({
        repositoryUrl,
        directory: repositoryDirectory,
        targetRef,
        trace,
    });

    removeReadyFile(readyFile);
    const repositoryStatus = await repository.initialize();

    const worker = new PilotSwarmWorker({
        store: databaseUrl,
        githubToken: process.env.GITHUB_TOKEN,
        logLevel: process.env.LOG_LEVEL || "info",
        traceWriter: trace,
        sessionStateDir,
        modelProvidersPath,
        workerNodeId: process.env.PILOTSWARM_WORKER_ID || os.hostname(),
        pluginDirs,
        disableManagementAgents: true,
        beforeTurn: repository.beforeTurn,
    });
    if (worker.systemAgents.length > 0) {
        throw new Error(
            "Repository workers do not support auto-starting system agents: "
            + worker.systemAgents.map((agent) => agent.name).join(", "),
        );
    }
    process.chdir(repositoryStatus.directory);

    let stopping = false;
    let shutdownError;
    let resolveShutdown;
    const shutdownComplete = new Promise((resolve) => {
        resolveShutdown = resolve;
    });
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`[repository-worker] ${signal}; draining`);
        const shutdownErrors = [];
        try {
            removeReadyFile(readyFile);
        } catch (error) {
            shutdownErrors.push(error);
        }
        try {
            await worker.gracefulShutdown();
        } catch (error) {
            shutdownErrors.push(error);
            try {
                await worker.stop();
            } catch (stopError) {
                shutdownErrors.push(stopError);
            }
        } finally {
            if (shutdownErrors.length === 1) {
                [shutdownError] = shutdownErrors;
            } else if (shutdownErrors.length > 1) {
                shutdownError = new AggregateError(
                    shutdownErrors,
                    "Repository worker shutdown encountered multiple failures",
                );
            }
            resolveShutdown();
        }
    };

    const onSigint = () => {
        void shutdown("SIGINT");
    };
    const onSigterm = () => {
        void shutdown("SIGTERM");
    };

    let startInvoked = false;
    let mainError;
    try {
        startInvoked = true;
        await worker.start();
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
        writeReadyFile(readyFile, repositoryStatus);
        console.log(
            `[repository-worker] ready directory=${repositoryStatus.directory} `
            + `head=${repositoryStatus.headSha.slice(0, 12)}`,
        );
        await shutdownComplete;
        if (shutdownError) throw shutdownError;
    } catch (error) {
        mainError = error;
        throw error;
    } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        const cleanupErrors = [];
        if (startInvoked && !stopping) {
            try {
                await worker.stop();
            } catch (stopError) {
                cleanupErrors.push(stopError);
            }
        }
        if (!stopping) {
            try {
                removeReadyFile(readyFile);
            } catch (readyFileError) {
                cleanupErrors.push(readyFileError);
            }
        }
        if (cleanupErrors.length > 0) {
            const cleanupError = cleanupErrors.length === 1
                ? cleanupErrors[0]
                : new AggregateError(cleanupErrors, "Repository worker cleanup failed");
            if (mainError) {
                throw new AggregateError(
                    [mainError, cleanupError],
                    "Repository worker failed and cleanup was incomplete",
                );
            }
            throw cleanupError;
        }
    }
}

main().catch((error) => {
    console.error("[repository-worker] fatal:", error);
    process.exit(1);
});
