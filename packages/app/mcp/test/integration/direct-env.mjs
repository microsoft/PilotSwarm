// Shared harness for the MCP live suites — Direct datastore mode (--store).
//
// Starts an embedded PilotSwarmWorker on DATABASE_URL and returns StdioClientTransport
// args for `pilotswarm-mcp --store $DATABASE_URL` sharing the EXACT same
// SESSION_STATE_DIR and ARTIFACT_DIR so package Workflow tarballs published to
// the filesystem artifact store are visible to both the worker and direct-mode MCP.

import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { PilotSwarmWorker, FilesystemArtifactStore, PilotSwarmManagementClient, workflowScriptsOptionFromEnv } from "pilotswarm-sdk";
import { loadDotEnv } from "./web-env.mjs";

export async function startDirectEnv(root) {
    loadDotEnv(root);
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL not set — direct mode needs the datastore.");
    }
    const baseDir = mkdtempSync(resolve(tmpdir(), "ps-mcp-direct-live-"));
    const sessionStateDir = resolve(baseDir, "session-state");
    const artifactDir = resolve(baseDir, "artifacts");

    const worker = new PilotSwarmWorker({
        store: process.env.DATABASE_URL,
        sessionStateDir,
        artifactDir,
        workerNodeId: `mcp-direct-live-${process.pid}`,
        ...workflowScriptsOptionFromEnv(),
    });
    await worker.start();

    const artifactStore = new FilesystemArtifactStore(artifactDir);
    const mgmt = new PilotSwarmManagementClient({
        store: process.env.DATABASE_URL,
        artifactStore,
        workflowCommands: {},
        ...workflowScriptsOptionFromEnv(),
    });
    await mgmt.start();

    return {
        store: process.env.DATABASE_URL,
        sessionStateDir,
        artifactDir,
        mgmt,
        mcpStdioArgs(extraArgs = []) {
            return {
                command: "node",
                args: [
                    resolve(root, "packages/app/mcp/dist/bin/pilotswarm-mcp.js"),
                    "--store", process.env.DATABASE_URL,
                    "--transport", "stdio",
                    "--log-level", "error",
                    ...extraArgs,
                ],
                env: {
                    ...process.env,
                    SESSION_STATE_DIR: sessionStateDir,
                    ARTIFACT_DIR: artifactDir,
                },
                cwd: root,
                stderr: "pipe",
            };
        },
        async stop() {
            await mgmt.stop().catch(() => {});
            await worker.stop().catch(() => {});
        },
    };
}
