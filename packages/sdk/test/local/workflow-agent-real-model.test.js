/**
 * Workflow agent states with a REAL model (test layer M; design 06 "A separate real-model scenario"; R09 to R11,
 * R23). An inline prompt and a packaged reviewer take the same input schema and produce the same typed output, on a
 * model that is not scripted. It records the provider, model and effort, each child's model calls, tokens, turns and
 * tools, each completion's answer, errors and refusals. A mocked or scripted case does not stand in for it.
 *
 * It spends model tokens, so it runs only when asked: PS_WORKFLOW_REAL_MODEL=run. Asked but unable to run as asked (a
 * missing setting, a model without its credential, a target database behind this checkout), it fails as BLOCKED; it
 * never skips then. Every setting comes from the environment (test/helpers/workflow-real-model.mjs names them); no
 * credential, endpoint or connection string is in the repository, and none is printed or recorded.
 *
 * Targets (PS_WORKFLOW_REAL_MODEL_TARGET):
 * - local (the default): a worker in this process on its own
 *   test schemas, its model catalog from PS_MODEL_PROVIDERS_PATH (the test catalog unless the environment names
 *   another, such as a TEST-pool catalog) and that catalog's credentials from the environment. The packaged reviewer
 *   is a synthetic package the test publishes into its own registry. Everything is dropped afterwards.
 * - deployed: an existing isolated test environment whose workers run the Workflow controller (every worker of this release
 *   does) and serve the named model from their own
 *   catalog and credentials. The test runs no worker: as a client of the environment's database it creates one parent
 *   session row (the controlling agent, whose model and effort the agent states' children take) and one workflow, then
 *   reads what the environment's workers did. The packaged reviewer must already be published there
 *   (PS_WORKFLOW_TARGET_PACKAGED_REVIEWER=<package>/<agent>, visible to the test owner); nothing is published there
 *   and nothing is deleted. Before it connects as a client it checks that the environment's CMS and facts schemas
 *   already hold every migration of this checkout, because a client's start applies the missing ones: run it from the
 *   commit the environment's images were built from.
 *
 * Budget: PS_WORKFLOW_REAL_MODEL_SAMPLES runs (1 to 5, default 1), each started once. A sample that fails is
 * recorded and the test fails naming it; no sample is retried, and the others still run. The verdicts are the model's
 * own: whether the two reviewers agree, and whether a verdict names its outcome, are recorded, not asserted. The receipt
 * goes to PS_WORKFLOW_REAL_MODEL_RECEIPT (a JSON file) when it is set, and a summary is printed.
 *
 * Run (local, after a build of nothing: the test imports the sources):
 *   PS_WORKFLOW_REAL_MODEL=run PS_WORKFLOW_REAL_MODEL_REF=<provider:model> \
 *     npx vitest run test/local/workflow-agent-real-model.test.js
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestEnv } from "../helpers/local-env.js";
import { PilotSwarmClient, withClient } from "../helpers/local-workers.js";
import {
    REAL_MODEL_MAX_SAMPLES,
    REVIEW_OUTCOMES,
    childRecord,
    missingMigrations,
    realModelPlan,
    reviewResultProblems,
    servesModel,
} from "../helpers/workflow-real-model.mjs";
import { FilesystemArtifactStore, loadModelProviders, publishAgentPackageDir } from "../../src/index.ts";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { FACTS_MIGRATIONS } from "../../src/facts-migrations.ts";
import { createWorkflowAgentResolver } from "../../src/workflow/agent-resolver.ts";
import { createWorkflow, applyWorkflowUpdate } from "../../src/workflow/service.ts";
import { WORKFLOW_CONTROLLER_VERSION } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const OWNER = { provider: "test", subject: "workflow-real-model", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-real-model-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
/** An agent state's outer deadline (its timed_out route). */
const STATE_TIMEOUT_SECONDS = 300;
/** How long the first state may take to be entered: past it, no worker there serves the Workflow controller. */
const ENTER_MS = 120_000;
/** One sample's wait for its run to end: both states' deadlines and a margin. */
const SAMPLE_MS = (2 * STATE_TIMEOUT_SECONDS + 120) * 1_000;
/** After the run ends, how long to wait for the controller to end each child before its events are read. */
const CHILD_END_MS = 60_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The review's input: one code change. Synthetic; no private case. */
const REVIEW_INPUT = {
    type: "object", required: ["title", "diff"], additionalProperties: false,
    properties: { title: { type: "string", minLength: 1, maxLength: 200 }, diff: { type: "string", minLength: 1, maxLength: 4000 } },
};
/** The review's typed output (reviewResultProblems checks the same contract independently). */
const REVIEW_RESULT = {
    type: "object", required: ["verdict", "summary", "risks"], additionalProperties: false,
    properties: {
        verdict: { enum: [...REVIEW_OUTCOMES] },
        summary: { type: "string", minLength: 1, maxLength: 600 },
        risks: { type: "array", maxItems: 5, items: { type: "string", minLength: 1, maxLength: 200 } },
    },
};
/** The same task for both reviewers: what differs is only where it comes from (inline, or the package agent's prompt). */
const REVIEW_TASK = [
    "Review the code change in your input as a careful senior engineer and decide whether it can merge as it is.",
    "Then complete this workflow state with complete_workflow_node: outcome approve or request_changes, and an output",
    "{ verdict, summary, risks } whose verdict is that same outcome, whose summary is at most three sentences, and whose",
    "risks lists at most five concrete problems (an empty list when there are none). Do not ask anyone a question.",
].join(" ");
const SAMPLE_CHANGE = {
    title: "Look up an order by its id",
    diff: [
        "--- a/orders.js",
        "+++ b/orders.js",
        "@@ -0,0 +1,4 @@",
        "+export async function findOrder(db, orderId) {",
        "+    const rows = await db.query(\"SELECT * FROM orders WHERE id = '\" + orderId + \"'\");",
        "+    return rows[0];",
        "+}",
    ].join("\n"),
};

/** The workflow: the inline reviewer, then the packaged one, on the same input and contract. As a document (JSON is YAML). */
function reviewWorkflow(reviewer) {
    const reviewState = (invoke, next) => ({
        type: "agent", invoke, input: "${inputs.change}",
        inputSchema: { $ref: "#/schemas/ReviewInput" }, outputSchema: { $ref: "#/schemas/ReviewResult" },
        outcomes: [...REVIEW_OUTCOMES], timeoutSeconds: STATE_TIMEOUT_SECONDS,
        transition: { next: { approve: next, request_changes: next, failure: "failed" } },
    });
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "real-model-review", version: "1.0.0" },
        inputs: { schema: { type: "object", required: ["change"], additionalProperties: false, properties: { change: REVIEW_INPUT } } },
        initial: "inline_review",
        schemas: { ReviewInput: REVIEW_INPUT, ReviewResult: REVIEW_RESULT },
        states: {
            inline_review: reviewState({ prompt: REVIEW_TASK }, "packaged_review"),
            packaged_review: reviewState({ agent: { name: reviewer.name, package: reviewer.package } }, "done"),
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    }, null, 2);
}

/** The local target's synthetic reviewer package: one agent whose prompt is the review task. */
function writeReviewerPackage(baseDir, reviewer) {
    const dir = join(baseDir, `real-review-kit-${reviewer.name}`);
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: reviewer.package, version: "1.0.0",
        description: "A code reviewer for workflow states (a synthetic test package)." }));
    writeFileSync(join(dir, "agents", `${reviewer.name}.agent.md`), [
        "---", `name: ${reviewer.name}`, "description: Reviews one code change for a workflow state.", "schemaVersion: 1", "version: 1.0.0", "---",
        "", `You are the code reviewer of a workflow state. ${REVIEW_TASK}`, "",
    ].join("\n"));
    return dir;
}

/** A value as bounded JSON text. */
function bounded(value, limit = 600) {
    let text;
    try { text = JSON.stringify(value); } catch { return "(unserializable)"; }
    if (text === undefined) return "null";
    return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} chars)`;
}

/** `check()` until it answers, every `everyMs`, for at most `timeoutMs`; null when it never did. */
async function poll(check, timeoutMs, everyMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await pause(everyMs);
    }
}

/** One agent state of a sample: its decision against the contract, and what its child did on the model. */
async function stateRecord(ctx, plan, runId, stateId, fail) {
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", stateId, 1);
    const node = await ctx.store.readNodeExecution(nodeExecutionId);
    const record = { state: stateId, nodeExecutionId, status: node?.state ?? "not entered", outcome: node?.outcome ?? null,
        winner: node?.winner ?? null, resultKind: node?.resultKind ?? null, output: node?.output ?? null, error: node?.error ?? null,
        verdictMatchesOutcome: null, task: null, child: null };
    if (!node) {
        fail(`${stateId} was not entered`);
        return record;
    }
    if (node.state !== "completed") fail(`${stateId} did not complete`);
    else if (!REVIEW_OUTCOMES.includes(node.outcome)) fail(`${stateId} ended ${node.outcome}: ${bounded(node.error)}`);
    else {
        if (node.winner !== "agent") fail(`${stateId} was decided by ${node.winner}, not by its agent's completion`);
        const problems = reviewResultProblems(node.output);
        if (problems.length) fail(`${stateId}'s output breaks the contract: ${problems.join("; ")}`);
        // The model's own consistency: recorded, not asserted.
        record.verdictMatchesOutcome = node.output?.verdict === node.outcome;
    }
    // The controller ends the child after the state is decided; its events are complete then.
    const invocation = await poll(async () => {
        const row = await ctx.store.readAgentInvocation(nodeExecutionId);
        return row && (row.endSentAt || node.state !== "completed") ? row : null;
    }, CHILD_END_MS) ?? await ctx.store.readAgentInvocation(nodeExecutionId);
    record.task = invocation?.task ?? null;
    if (!invocation?.childSessionId) {
        fail(`${stateId} has no child session`);
        return record;
    }
    const [row, events] = await Promise.all([ctx.catalog.getSession(invocation.childSessionId), ctx.catalog.getSessionEvents(invocation.childSessionId, 0, 2_000)]);
    const child = childRecord({ ...(row ?? {}), sessionId: invocation.childSessionId }, events);
    record.child = { ...child, ended: Boolean(invocation.endSentAt), endRequested: invocation.endRequested, endChildStatus: invocation.endChildStatus };
    if (!servesModel(child.model, plan.model)) fail(`${stateId}'s child was created on ${child.model}, not ${plan.model.ref}`);
    if (plan.effort && child.reasoningEffort !== plan.effort) fail(`${stateId}'s child was created with effort ${child.reasoningEffort}, not ${plan.effort}`);
    if (child.requests === 0) fail(`${stateId}'s child made no model call`);
    const others = child.observedModels.filter(model => !servesModel(model, plan.model));
    if (others.length) fail(`${stateId}'s child was served by ${others.join(", ")}, not ${plan.model.ref}`);
    return record;
}

/** One sample: one run of the published workflow, started once, waited for, and recorded state by state. */
async function sample(ctx, host, plan, workflow, index, receipt) {
    const startedAt = Date.now();
    const started = await applyWorkflowUpdate(host, workflow.workflowSessionId,
        { operation: "start", definitionHash: workflow.definitionSha256, inputs: { change: SAMPLE_CHANGE } },
        { actor: ACTOR, operationId: `start-${index + 1}` });
    const runId = started.receipt.run.runId;
    const record = { sample: index + 1, runId, status: null, controllerVersion: null, durationMs: null, agreement: null, states: [], failures: [] };
    const fail = text => {
        record.failures.push(text);
        receipt.failures.push(`sample ${index + 1}: ${text}`);
    };
    const first = nodeExecutionIdFor(runId, "root", "inline_review", 1);
    if (!(await poll(() => ctx.store.readNodeExecution(first), ENTER_MS))) {
        fail(`no worker entered the first state within ${ENTER_MS / 1_000} s: does every worker there serve controller `
            + `${WORKFLOW_CONTROLLER_VERSION} (the test-environment switch)?`);
        record.durationMs = Date.now() - startedAt;
        return record;
    }
    const run = await poll(async () => {
        const row = await ctx.store.readRun(runId);
        return row && ENDED.includes(row.status) ? row : null;
    }, SAMPLE_MS);
    record.durationMs = Date.now() - startedAt;
    if (!run) fail(`the run did not end within ${SAMPLE_MS / 60_000} min`);
    else {
        record.status = run.status;
        record.controllerVersion = run.controllerVersion;
        if (run.status !== "completed") fail(`the run ended ${run.status} at ${run.terminalNodeId}: ${bounded(run.terminalError ?? run.terminalOutput)}`);
        if (run.controllerVersion !== WORKFLOW_CONTROLLER_VERSION) fail(`the run was admitted for controller ${run.controllerVersion}`);
    }
    for (const stateId of ["inline_review", "packaged_review"]) record.states.push(await stateRecord(ctx, plan, runId, stateId, fail));
    const verdicts = record.states.map(state => state.output?.verdict ?? null);
    record.agreement = verdicts.every(Boolean) ? verdicts[0] === verdicts[1] : null;
    return record;
}

/**
 * The scenario on a target (`ctx`: its catalog, workflow store, Duroxide client, packaged reviewer and owner): a parent
 * session on the plan's model, the workflow published as a host publishes it (the packaged reviewer pinned at its
 * registry revision), then the samples.
 */
async function scenario(ctx, plan, receipt) {
    const host = { catalog: ctx.catalog, store: ctx.store, duroxideClient: ctx.duroxide,
        resolveAgent: createWorkflowAgentResolver({ catalog: ctx.catalog }) };
    const parent = randomUUID();
    await ctx.catalog.createSession(parent, { owner: ctx.owner, model: plan.model.ref, ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
    const workflowSessionId = randomUUID();
    const created = await createWorkflow(host, {
        workflowSessionId, parentSessionId: parent, yaml: reviewWorkflow(ctx.reviewer), actor: ACTOR, operationId: "create",
        publish: true, notifyParent: false,
    });
    expect(created.receipt, bounded(created.receipt.diagnostics, 2_000)).toMatchObject({ valid: true, state: "published", run: null });
    const pin = (await ctx.store.readDefinition(workflowSessionId))?.publishedAgentPins?.packaged_review ?? null;
    expect(pin, "the packaged reviewer is pinned at publication").toMatchObject({ name: ctx.reviewer.name, package: ctx.reviewer.package });
    if (ctx.expectedRevision) expect(pin.revision).toBe(ctx.expectedRevision);
    const workflow = { workflowSessionId, parentSessionId: parent, definitionSha256: created.receipt.yamlSha256, packagedReviewerPin: pin };
    receipt.workflow = workflow;
    for (let index = 0; index < plan.samples; index += 1) receipt.samples.push(await sample(ctx, host, plan, workflow, index, receipt));
}

/** The local target: its own schemas, a worker in this process with the test-only option, its own registry package. */
async function runLocal(plan, receipt) {
    const env = createTestEnv("wf-real-model");
    try {
        const tag = randomUUID().slice(0, 8);
        const reviewer = { package: `real-review-kit-${tag}`, name: `real-reviewer-${tag}` };
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const registry = { catalog, artifactStore: new FilesystemArtifactStore(join(dirname(env.sessionStateDir), "artifacts")) };
            const published = await publishAgentPackageDir(registry, {
                dir: writeReviewerPackage(env.baseDir, reviewer), scope: "shared", owner: OWNER, createdBy: ACTOR.name, isAdmin: false,
            });
            receipt.packagedReviewer = { ...reviewer, version: "1.0.0", packageId: published.packageId, revision: published.sha256, publishedByThisTest: true };
            const worker = {
                workerPool: "default", logLevel: "warning",
                agentPackages: { cacheDir: join(env.baseDir, `real-model-packages-${tag}`), refreshIntervalMs: 0 },
            };
            await withClient(env, { worker }, async (client) => {
                await scenario({ catalog, store: catalog.workflowStore(), duroxide: client._getDuroxideClient(), reviewer, owner: OWNER,
                    expectedRevision: published.sha256 }, plan, receipt);
            });
        } finally {
            await catalog.close();
        }
    } finally {
        await env.cleanup();
    }
}

/** The deployed target: a client of its database, after the guard that its start migrates nothing there. */
async function runDeployed(plan, receipt) {
    const target = plan.deployed;
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: target.store, max: 1 });
    try {
        for (const [label, schema, expected] of [["CMS", target.cmsSchema, CMS_MIGRATIONS(target.cmsSchema)],
            ["facts", target.factsSchema, FACTS_MIGRATIONS(target.factsSchema)]]) {
            const applied = await pool.query(`SELECT version FROM "${schema}".schema_migrations`).then(result => result.rows.map(row => row.version), () => null);
            if (applied === null) throw new Error(`BLOCKED: the target's ${label} schema ${schema} cannot be read.`);
            const missing = missingMigrations(expected.map(entry => entry.version), applied);
            if (missing.length) {
                throw new Error(`BLOCKED: the target's ${label} schema lacks ${missing.length} migration(s) of this checkout (first ${missing[0]}); `
                    + "run this test from the commit the environment's images were built from. It never migrates a shared database.");
            }
        }
    } finally {
        await pool.end();
    }
    receipt.packagedReviewer = { ...target.reviewer, publishedByThisTest: false };
    receipt.deployedSchemas = { duroxide: target.duroxideSchema, cms: target.cmsSchema, facts: target.factsSchema };
    const client = new PilotSwarmClient({ store: target.store, duroxideSchema: target.duroxideSchema, cmsSchema: target.cmsSchema,
        factsSchema: target.factsSchema });
    await client.start();
    // Not initialized: the guard above found every migration there.
    const catalog = await PgSessionCatalog.create(target.store, target.cmsSchema);
    try {
        await scenario({ catalog, store: catalog.workflowStore(), duroxide: client._getDuroxideClient(), reviewer: target.reviewer,
            owner: target.owner ?? OWNER, expectedRevision: null }, plan, receipt);
    } finally {
        await catalog.close();
        await client.stop();
    }
}

/** The receipt: to its file when one is named, and a bounded summary on the console. Never a credential or a connection string. */
function report(plan, receipt) {
    if (plan.receiptPath) {
        mkdirSync(dirname(plan.receiptPath), { recursive: true });
        writeFileSync(plan.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    console.info("workflow real-model receipt", bounded({
        target: receipt.target, model: receipt.model, budget: receipt.budget,
        samples: receipt.samples.map(item => ({ sample: item.sample, status: item.status, durationMs: item.durationMs, agreement: item.agreement,
            states: item.states.map(state => ({ state: state.state, outcome: state.outcome, verdict: state.output?.verdict ?? null,
                requests: state.child?.requests ?? null, refused: state.child?.refusedCompletions ?? null, tools: state.child?.tools ?? null })) })),
        failures: receipt.failures, error: receipt.error ?? null,
    }, 6_000));
}

function catalogOrNull() {
    try { return loadModelProviders() ?? null; } catch { return null; }
}

const plan = realModelPlan(process.env, { registry: catalogOrNull(), githubToken: process.env.GITHUB_TOKEN ?? null });
const TEST_TIMEOUT = (plan.samples ?? 1) * (ENTER_MS + SAMPLE_MS + 2 * CHILD_END_MS) + 300_000;
const TITLE = "an inline prompt and a packaged reviewer take the same input schema and produce typed output on a real model (provider, model and effort recorded)";

describe("workflow agent states on a real model (layer M; test-only option, inactive)", () => {
    if (plan.state === "skip") {
        it.skip(`${TITLE} — skipped: ${plan.reason}`, () => {});
        return;
    }
    it(TITLE, { timeout: TEST_TIMEOUT }, async () => {
        if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
        const receipt = {
            test: "workflow-agent-real-model", target: plan.target, startedAt: new Date().toISOString(), endedAt: null,
            model: { ref: plan.model.ref, provider: plan.model.provider, name: plan.model.name, type: plan.model.type,
                effort: plan.effort ?? "the model's default" },
            budget: { samples: plan.samples, maxSamples: REAL_MODEL_MAX_SAMPLES, retries: 0 },
            controllerVersion: WORKFLOW_CONTROLLER_VERSION, samples: [], failures: [],
        };
        try {
            if (plan.target === "local") await runLocal(plan, receipt);
            else await runDeployed(plan, receipt);
        } catch (error) {
            receipt.error = String(error?.message ?? error).slice(0, 2_000);
            throw error;
        } finally {
            receipt.endedAt = new Date().toISOString();
            report(plan, receipt);
        }
        // Every sample's failures, the first one first: none is retried or hidden.
        expect(receipt.failures, receipt.failures.join("\n")).toEqual([]);
    });
});
