#!/usr/bin/env node

export * from "./providers.js";
export { WorkflowGeneratorController } from "./controller.js";

import { hostname } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PgSessionCatalog } from "pilotswarm-sdk";
import { WorkflowGeneratorController } from "./controller.js";
import {
    createEvaluatorsFromEnv,
    effectiveWorkflowGeneratorLeaseSeconds,
} from "./providers.js";

export async function runWorkflowGeneratorOnce(options: {
    controller: Pick<WorkflowGeneratorController, "runOnce">;
    signal?: AbortSignal;
}): Promise<void> {
    await options.controller.runOnce(options.signal);
}

export async function runWorkflowGenerator(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const catalogUrl = process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL?.trim() || databaseUrl;
    const cmsSchema = process.env.PILOTSWARM_CMS_SCHEMA?.trim() || "copilot_sessions";
    const useManagedIdentity = ["1", "true", "yes", "on"].includes(
        (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
    );
    const aadDbUser = process.env.PILOTSWARM_DB_AAD_USER?.trim()
        || process.env.PILOTSWARM_AAD_DB_USER?.trim();
    const runOnce = ["1", "true", "yes", "on"].includes(
        (process.env.WORKFLOW_GENERATOR_RUN_ONCE || "").trim().toLowerCase(),
    );
    const controllerCompute = process.env.WORKFLOW_GENERATOR_COMPUTE?.trim().toLowerCase();
    if (!controllerCompute) {
        throw new Error("WORKFLOW_GENERATOR_COMPUTE is required");
    }
    if (controllerCompute !== "cluster" && controllerCompute !== "devbox") {
        throw new Error("WORKFLOW_GENERATOR_COMPUTE must be 'cluster' or 'devbox'");
    }
    const workerId = process.env.WORKFLOW_GENERATOR_WORKER_ID || `${hostname()}-${process.pid}`;
    const readyFile = process.env.WORKFLOW_GENERATOR_READY_FILE?.trim();
    const pollIntervalMs = Number(process.env.WORKFLOW_GENERATOR_POLL_INTERVAL_MS || 15_000);
    const claimLimit = Number(process.env.WORKFLOW_GENERATOR_CLAIM_LIMIT || 10);
    const leaseSeconds = effectiveWorkflowGeneratorLeaseSeconds(
        Number(process.env.WORKFLOW_GENERATOR_LEASE_SECONDS || 300),
    );
    console.info("[workflow-generator] initializing PostgreSQL catalog");
    const catalog = await PgSessionCatalog.create(catalogUrl, cmsSchema, {
        useManagedIdentity,
        aadUser: aadDbUser,
    });
    await catalog.initialize();
    console.info(`[workflow-generator] catalog ready schema=${cmsSchema}`);
    const evaluators = createEvaluatorsFromEnv();
    const providerTypes = [...evaluators.keys()];
    if (providerTypes.length === 0) {
        console.warn("[workflow-generator] no source evaluators are configured");
    }
    console.info(
        `[workflow-generator] starting mode=${runOnce ? "once" : "continuous"}`
        + ` worker=${workerId} pollMs=${pollIntervalMs} claimLimit=${claimLimit}`
        + ` leaseSeconds=${leaseSeconds}`
        + ` compute=${controllerCompute}`
        + " admission=disabled"
        + ` providers=${providerTypes.join(",") || "none"}`,
    );
    const controller = new WorkflowGeneratorController({
        store: catalog,
        evaluators,
        workerId,
        pollIntervalMs,
        claimLimit,
        leaseSeconds,
        controllerCompute,
    });
    const abort = new AbortController();
    process.once("SIGTERM", () => abort.abort());
    process.once("SIGINT", () => abort.abort());
    try {
        if (readyFile) {
            await mkdir(dirname(readyFile), { recursive: true });
            await writeFile(readyFile, `${workerId}\n`, "utf8");
        }
        if (runOnce) {
            await runWorkflowGeneratorOnce({
                controller,
                signal: abort.signal,
            });
        } else {
            await controller.run(abort.signal);
        }
    } finally {
        console.info("[workflow-generator] stopping");
        abort.abort();
        if (readyFile) await rm(readyFile, { force: true }).catch(() => {});
        await catalog.close();
        console.info("[workflow-generator] stopped");
    }
}
