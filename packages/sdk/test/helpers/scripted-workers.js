/**
 * Full-stack harness with a scripted model: real PilotSwarm workers,
 * PostgreSQL, Duroxide and the Copilot CLI, with the model replaced by
 * scripted-model.mjs. Tests drive tool calls turn by turn and read back every
 * request the CLI sent.
 *
 * The fixture provider is registered the same way a deployment registers one:
 * a provider type in the model-providers file, and a shared provider plus the
 * cluster default in CMS.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createCatalog } from "./cms-helpers.js";
import { withClient, withTwoWorkers } from "./local-workers.js";
import { startScriptedModel } from "./scripted-model.mjs";

export const FIXTURE_PROVIDER_TYPE = "fixture-scripted-type";
export const FIXTURE_PROVIDER = "fixture-scripted";
export const FIXTURE_MODEL = "fixture-model";
export const FIXTURE_QUALIFIED_MODEL = `${FIXTURE_PROVIDER}:${FIXTURE_MODEL}`;

/**
 * Write the provider-type file and register the shared provider and cluster
 * default in CMS. Returns the file path to hand to workers and clients.
 */
export async function registerScriptedProvider(env, baseUrl) {
    const modelProvidersPath = path.join(env.baseDir, `model-providers.scripted-${env.runId}.json`);
    fs.writeFileSync(modelProvidersPath, JSON.stringify({
        providers: [{
            id: FIXTURE_PROVIDER_TYPE,
            type: "openai",
            baseUrl,
            models: [{ name: FIXTURE_MODEL, description: "Scripted test model." }],
        }],
    }, null, 2));
    const catalog = await createCatalog(env);
    try {
        await catalog.providers.createProvider({
            name: FIXTURE_PROVIDER,
            typeId: FIXTURE_PROVIDER_TYPE,
            class: "shared",
            secretRef: { apiKey: "synthetic" },
        }, null, true);
        await catalog.providers.setClusterDefault({
            provider: FIXTURE_PROVIDER,
            model: FIXTURE_QUALIFIED_MODEL,
            reasoning: null,
            context: null,
        }, true);
    } finally {
        await catalog.close?.();
    }
    return modelProvidersPath;
}

const FIXTURE_ADMIN = { principal: { provider: "test", subject: "fixture-admin" }, isAdmin: true };

/**
 * Set a cluster feature flag in CMS, as an admin would. Call it before the
 * workers start: a worker reads the flags when it starts.
 */
export async function setClusterFeature(env, featureKey, enabled, { allowUserOverride = true } = {}) {
    const catalog = await createCatalog(env);
    try {
        const current = (await catalog.features.revisions()).find((row) => row.featureKey === featureKey);
        if (!current) throw new Error(`unknown feature flag: ${featureKey}`);
        await catalog.features.mutate(FIXTURE_ADMIN, "cluster", {
            featureKey,
            expectedRevision: current.revision,
            requestId: `fixture-${featureKey}-${Date.now()}`,
            enabled,
            allowUserOverride,
        });
    } finally {
        await catalog.close?.();
    }
}

function mergeWorkerOpts(base, extra) {
    return { ...base, ...(extra || {}) };
}

/**
 * Run `fn` against one worker (default) or two workers (`opts.workers: 2`)
 * that use the scripted model.
 *
 * @param {object} env   - from createTestEnv()/useSuiteEnv()
 * @param {object} opts
 * @param {Function} [opts.respond]  - responder for session requests (see scriptTurns)
 * @param {1|2}      [opts.workers]  - how many workers
 * @param {object}   [opts.worker]   - extra options for every worker
 * @param {object}   [opts.workerA]  - extra options for worker A (two-worker mode)
 * @param {object}   [opts.workerB]  - extra options for worker B (two-worker mode)
 * @param {object}   [opts.client]   - extra client options
 * @param {Array}    [opts.tools]    - tools to register on every worker
 * @param {Function} fn - async ({ client, worker, workers, model, modelProvidersPath, qualifiedModel }) => void
 */
export async function withScriptedModel(env, opts, fn) {
    if (typeof opts === "function") {
        fn = opts;
        opts = {};
    }
    const model = await startScriptedModel({ respond: opts.respond, respondAuxiliary: opts.respondAuxiliary });
    try {
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
        const shared = { modelProvidersPath, ...(opts.worker || {}) };
        const client = { modelProvidersPath, ...(opts.client || {}) };
        const context = { model, modelProvidersPath, qualifiedModel: FIXTURE_QUALIFIED_MODEL };

        if ((opts.workers ?? 1) === 2) {
            await withTwoWorkers(env, {
                tools: opts.tools,
                workerA: mergeWorkerOpts(shared, opts.workerA),
                workerB: mergeWorkerOpts(shared, opts.workerB),
                client,
            }, async (c, workerA, workerB) => {
                await fn({ ...context, client: c, worker: workerA, workers: [workerA, workerB] });
            });
            return;
        }

        await withClient(env, {
            tools: opts.tools,
            workerNodeId: opts.workerNodeId,
            worker: shared,
            client,
        }, async (c, worker) => {
            await fn({ ...context, client: c, worker, workers: [worker] });
        });
    } finally {
        await model.close();
    }
}
