#!/usr/bin/env node

export * from "./providers.js";
export * from "./controller.js";
export * from "./run-inducer.js";
export * from "./azure-devops-workflow-run-waits.js";

import { hostname } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
    WorkflowRunWaitScheduler,
    MockWorkflowRunWaitObserver,
    PgSessionCatalog,
    PilotSwarmClient,
    PilotSwarmManagementClient,
    RemoteLifecycleStateReader,
    loadModelProviderTypes,
} from "pilotswarm-sdk";
import {
    WorkflowGeneratorController,
    PilotSwarmInitialSessionFactory,
} from "./controller.js";
import { WorkflowRunInducer } from "./run-inducer.js";
import {
    createEvaluatorsFromEnv,
    effectiveWorkflowGeneratorLeaseSeconds,
} from "./providers.js";
import {
    AzureDevOpsPullRequestApprovalObserver,
    AzureDevOpsPullRequestClient,
    AzureDevOpsPullRequestCompletionObserver,
    WorkflowDefinitionAzureDevOpsTargetAuthorizer,
    parseAzureDevOpsRepositoryBindings,
} from "./azure-devops-workflow-run-waits.js";

export async function runWorkflowGeneratorOnce(options: {
    controller: Pick<WorkflowGeneratorController, "runOnce">;
    runInducer?: Pick<WorkflowRunInducer, "runOnce">;
    waitScheduler?: Pick<WorkflowRunWaitScheduler, "runOnce">;
    signal?: AbortSignal;
}): Promise<void> {
    await options.controller.runOnce(options.signal);
    if (options.runInducer) {
        while (await options.runInducer.runOnce()) {
            // Drain every Run made visible by this generator evaluation.
        }
    }
    await options.waitScheduler?.runOnce();
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
    const runInducerEnabled = !["0", "false", "no", "off"].includes(
        (process.env.WORKFLOW_RUN_INDUCER_ENABLED || "true").trim().toLowerCase(),
    );
    const runOnce = ["1", "true", "yes", "on"].includes(
        (process.env.WORKFLOW_GENERATOR_RUN_ONCE || "").trim().toLowerCase(),
    );
    const mockOperationsEnabled = ["1", "true", "yes", "on"].includes(
        (process.env.WORKFLOW_GENERATOR_MOCK_EXTERNAL_OPERATIONS || "").trim().toLowerCase(),
    );
    const waitSchedulerEnabled = !["0", "false", "no", "off"].includes(
        (process.env.WORKFLOW_GENERATOR_WAIT_SCHEDULER_ENABLED || "true").trim().toLowerCase(),
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
    const runInducerWorkerId = process.env.WORKFLOW_RUN_INDUCER_WORKER_ID
        || `${workerId}-workflow-run-inducer`;
    const runInducerPollIntervalMs = Number(
        process.env.WORKFLOW_RUN_INDUCER_POLL_INTERVAL_MS || pollIntervalMs,
    );
    const runInducerClaimLimit = Number(
        process.env.WORKFLOW_RUN_INDUCER_CLAIM_LIMIT || claimLimit,
    );
    const runInducerLeaseSeconds = effectiveWorkflowGeneratorLeaseSeconds(
        Number(process.env.WORKFLOW_RUN_INDUCER_LEASE_SECONDS || leaseSeconds),
    );
    console.info("[workflow-generator] initializing PostgreSQL catalog");
    const catalog = await PgSessionCatalog.create(catalogUrl, cmsSchema, {
        useManagedIdentity,
        aadUser: aadDbUser,
    });
    await catalog.initialize();
    console.info(`[workflow-generator] catalog ready schema=${cmsSchema}`);
    let client: PilotSwarmClient | undefined;
    if (runInducerEnabled) {
        client = new PilotSwarmClient({
            store: databaseUrl,
            cmsSchema,
            useManagedIdentity,
            cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
            aadDbUser: aadDbUser,
        });
        await client.start();
        console.info("[workflow-generator] session induction client ready");
    }
    let managementClient: PilotSwarmManagementClient | undefined;
    let waitScheduler: WorkflowRunWaitScheduler | undefined;
    if (waitSchedulerEnabled) {
        const azureDevOpsRepositoryBindings = parseAzureDevOpsRepositoryBindings(
            process.env.WORKFLOW_GENERATOR_ADO_REPOSITORY_BINDINGS,
        );
        managementClient = new PilotSwarmManagementClient({
            store: databaseUrl,
            cmsSchema,
            useManagedIdentity,
            cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
            aadDbUser,
        });
        await managementClient.start();
        const azureDevOpsClient = new AzureDevOpsPullRequestClient({
            token: process.env.WORKFLOW_GENERATOR_ADO_TOKEN,
            pat: process.env.WORKFLOW_GENERATOR_ADO_PAT || process.env.AZURE_DEVOPS_EXT_PAT,
        });
        const azureDevOpsAuthorizer = new WorkflowDefinitionAzureDevOpsTargetAuthorizer(
            catalog,
            azureDevOpsRepositoryBindings,
        );
        const observers = [
            new AzureDevOpsPullRequestApprovalObserver(
                azureDevOpsClient,
                azureDevOpsAuthorizer,
            ),
            new AzureDevOpsPullRequestCompletionObserver(
                azureDevOpsClient,
                azureDevOpsAuthorizer,
            ),
            ...(mockOperationsEnabled ? [new MockWorkflowRunWaitObserver()] : []),
        ];
        waitScheduler = new WorkflowRunWaitScheduler({
            store: catalog,
            signalSender: managementClient,
            observers,
            workerId: `${workerId}-workflow-run-waits`,
            pollIntervalMs: Number(process.env.WORKFLOW_GENERATOR_WAIT_POLL_INTERVAL_MS || 500),
            defaultCheckIntervalMs: Number(
                process.env.WORKFLOW_GENERATOR_WAIT_DEFAULT_CHECK_INTERVAL_MS || 5_000,
            ),
            retryDelayMs: Number(process.env.WORKFLOW_GENERATOR_WAIT_RETRY_DELAY_MS || 1_000),
            maxRetryDelayMs: Number(process.env.WORKFLOW_GENERATOR_WAIT_MAX_RETRY_DELAY_MS || 60_000),
            claimLimit: Number(process.env.WORKFLOW_GENERATOR_WAIT_CLAIM_LIMIT || claimLimit),
            leaseSeconds: Number(process.env.WORKFLOW_GENERATOR_WAIT_LEASE_SECONDS || 30),
        });
        console.info(
            `[workflow-generator] WorkflowRunWait scheduler ready observers=azure_devops/pull_request_approval,`
            + `azure_devops/pull_request_completion`
            + `${mockOperationsEnabled ? ",mock/*" : ""}`,
            `adoRepositoryBindings=${azureDevOpsRepositoryBindings.size}`,
        );
    }

    const evaluators = createEvaluatorsFromEnv();
    const providerTypes = [...evaluators.keys()];
    if (providerTypes.length === 0) {
        console.warn("[workflow-generator] no source evaluators are configured");
    }
    console.info(
        `[workflow-generator] starting mode=${runOnce ? "once" : "continuous"}`
        + ` worker=${workerId} pollMs=${pollIntervalMs} claimLimit=${claimLimit}`
        + ` leaseSeconds=${leaseSeconds} runInducer=${runInducerEnabled}`
        + ` compute=${controllerCompute}`
        + ` waitScheduler=${waitSchedulerEnabled}`
        + ` mockExternalOperations=${mockOperationsEnabled}`
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
    const runInducer = client
        ? new WorkflowRunInducer({
            store: catalog,
            sessionFactory: new PilotSwarmInitialSessionFactory(client, {
                store: catalog,
                reader: new RemoteLifecycleStateReader({
                    githubToken: process.env.WORKFLOW_GENERATOR_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
                    adoToken: process.env.WORKFLOW_GENERATOR_ADO_TOKEN,
                    adoPat: process.env.WORKFLOW_GENERATOR_ADO_PAT || process.env.AZURE_DEVOPS_EXT_PAT,
                }),
            }, loadModelProviderTypes(process.env.PS_MODEL_PROVIDERS_PATH) ?? undefined),
            workerId: runInducerWorkerId,
            pollIntervalMs: runInducerPollIntervalMs,
            claimLimit: runInducerClaimLimit,
            leaseSeconds: runInducerLeaseSeconds,
        })
        : undefined;
    const abort = new AbortController();
    process.once("SIGTERM", () => abort.abort());
    process.once("SIGINT", () => abort.abort());
    let producerRuns: Promise<void>[] = [];
    try {
        if (readyFile) {
            await mkdir(dirname(readyFile), { recursive: true });
            await writeFile(readyFile, `${workerId}\n`, "utf8");
        }
        if (runOnce) {
            await runWorkflowGeneratorOnce({
                controller,
                runInducer,
                waitScheduler,
                signal: abort.signal,
            });
        } else {
            producerRuns = [
                ...(runInducer ? [runInducer.run(abort.signal)] : []),
                ...(waitScheduler ? [waitScheduler.run(abort.signal)] : []),
            ];
            await controller.run(abort.signal);
        }
    } finally {
        console.info("[workflow-generator] stopping");
        abort.abort();
        await Promise.all(producerRuns);
        if (readyFile) await rm(readyFile, { force: true }).catch(() => {});
        await managementClient?.stop();
        await client?.stop();
        await catalog.close();
        console.info("[workflow-generator] stopped");
    }
}
