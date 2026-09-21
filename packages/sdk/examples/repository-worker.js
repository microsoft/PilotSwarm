#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    PilotSwarmWorker,
    StickyRepositoryWorkspace,
} from "pilotswarm-sdk";

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

function assertSingleConcurrency() {
    const configured = String(process.env.PILOTSWARM_WORKER_CONCURRENCY ?? "1").trim();
    if (configured !== "1") {
        throw new Error(
            "Repository workers require PILOTSWARM_WORKER_CONCURRENCY=1 "
            + "because one persistent checkout is bound to one session",
        );
    }
    process.env.PILOTSWARM_WORKER_CONCURRENCY = "1";
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
    assertSingleConcurrency();

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
    process.chdir(repositoryStatus.directory);

    const worker = new PilotSwarmWorker({
        store: databaseUrl,
        githubToken: process.env.GITHUB_TOKEN,
        logLevel: process.env.LOG_LEVEL || "info",
        traceWriter: trace,
        sessionStateDir,
        modelProvidersPath:
            process.env.PS_MODEL_PROVIDERS_PATH
            || process.env.MODEL_PROVIDERS_PATH
            || undefined,
        workerNodeId: process.env.PILOTSWARM_WORKER_ID || os.hostname(),
        pluginDirs,
        beforeTurn: repository.beforeTurn,
    });

    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        removeReadyFile(readyFile);
        console.log(`[repository-worker] ${signal}; draining`);
        await worker.gracefulShutdown();
    };

    process.on("SIGINT", () => {
        void shutdown("SIGINT").catch((error) => {
            console.error("[repository-worker] shutdown failed:", error);
            process.exitCode = 1;
        });
    });
    process.on("SIGTERM", () => {
        void shutdown("SIGTERM").catch((error) => {
            console.error("[repository-worker] shutdown failed:", error);
            process.exitCode = 1;
        });
    });

    try {
        await worker.start();
        writeReadyFile(readyFile, repositoryStatus);
        console.log(
            `[repository-worker] ready directory=${repositoryStatus.directory} `
            + `head=${repositoryStatus.headSha.slice(0, 12)}`,
        );
        await new Promise(() => {});
    } finally {
        removeReadyFile(readyFile);
    }
}

main().catch((error) => {
    console.error("[repository-worker] fatal:", error);
    process.exitCode = 1;
});
