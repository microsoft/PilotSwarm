/**
 * One live sample per Release C feature. Every full pass includes these cases.
 * Assertions read inference tool metadata and durable definitions, visits and completion receipts, never model prose.
 * HTTP requests and session-fixed CLI tools read at usage events are separate oracles; no scripted model or sample retry.
 * Early-completion setup uses services; only its agent step calls the live model.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { turnWorkflowsOn } from "../helpers/workflows-on.js";
import { childRecord, realModelPlan, servesModel } from "../helpers/workflow-real-model.mjs";
import { withRealModelRecorder } from "../helpers/real-model-recorder.mjs";
import { realModelWorkflowEvidence } from "../helpers/workflow-real-model-evidence.mjs";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { createWorkflowAgentResolver } from "../../src/workflow/agent-resolver.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { redactThenClip } from "../../src/workflow/redact.ts";
import { FilesystemArtifactStore, loadModelProviders, PilotSwarmManagementClient, publishAgentPackageDir } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "release-features-real-model" };
const TOOL = "pkg_tool_a";
const STEP_MS = 300_000;
const TEST_MS = 15 * 60_000;
const NAME = "release-feature";
let registry = null;
try { registry = loadModelProviders() ?? null; } catch { /* The shared plan reports a missing catalog as BLOCKED. */ }
const plan = realModelPlan(process.env, { registry, githubToken: process.env.GITHUB_TOKEN ?? null });

function packageFixture(env) {
    const dir = join(env.baseDir, "tool-package");
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "live-tools", version: "1.0.0" }));
    writeFileSync(join(dir, "tools", "worker-module.js"), `
export default {
    createTools: () => [{
        name: "${TOOL}", description: "Read the harmless fixture counter.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => ({ value: 7 }),
    }],
};
`);
    return dir;
}

function agentFixture(env, mode) {
    const dir = join(env.baseDir, "agent-package");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "live-agent", version: "1.0.0" }));
    const task = mode === "early"
        ? "This is a negative test. First deliberately call complete_workflow_node with outcome done and output null BEFORE calling "
            + "pkg_tool_a. This must be refused. If it is refused, use what the refusal says to finish the task correctly."
        : "If pkg_tool_a is offered, call it once, then complete_workflow_node with outcome done and output null. "
            + "If it is not offered, call only complete_workflow_node with outcome done and output null. Do not invent a tool.";
    writeFileSync(join(dir, "agents", "live-agent.agent.md"),
        "---\nname: live-agent\ndescription: Harmless named live-model witness.\nschemaVersion: 1\nversion: 1.0.0\ntools: []\n---\n" + task + "\n");
    return dir;
}

function agentDefinition(granted) {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: NAME, version: "1.0.0" },
        initial: "drain",
        states: {
            drain: {
                type: "agent", invoke: { agent: { name: "live-agent" } },
                tools: [TOOL], outcomes: ["done"], timeoutSeconds: STEP_MS / 1000,
                ...(granted ? { grant: [TOOL], requiredTools: [TOOL] } : {}),
                transition: { next: { done: "done", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    });
}

async function until(read, label) {
    let result;
    await vi.waitFor(async () => {
        result = await read();
        expect(result, label).toBeTruthy();
    }, { timeout: STEP_MS, interval: 500 });
    return result;
}

async function ownedDefinition(mgmt, session, actorKind = "session") {
    const definitions = await until(async () => {
        const rows = await mgmt.listSessionWorkflowDefinitions(session.sessionId);
        return rows.length ? rows : null;
    }, "one saved definition");
    expect(definitions).toHaveLength(1);
    const definition = await mgmt.readSessionWorkflowDefinition(session.sessionId, { definitionId: definitions[0].definitionId });
    expect(definition.name).toBe(NAME);
    const revision = definition.revision;
    expect(revision).toBeTruthy();
    expect(revision.valid, JSON.stringify(revision)).toBe(true);
    expect(revision.actor.kind).toBe(actorKind);
    return { definition, revision };
}

async function startedRun(store, definitionId) {
    return until(async () => {
        const rows = await store.sessionDefinitions.listWorkflows({ definitionId });
        expect(rows.length).toBeLessThanOrEqual(1);
        if (!rows[0]) return null;
        const runs = await store.listRuns(rows[0].workflowSessionId);
        expect(runs.length).toBeLessThanOrEqual(1);
        return runs[0] ?? null;
    }, "one started Workflow");
}

async function endedRun(client, store, run) {
    const result = await client.duroxideClient.waitForOrchestration(run.controllerInstanceId, STEP_MS);
    expect(result.status, JSON.stringify(result)).toBe("Completed");
    const ended = await store.readRun(run.runId);
    expect(ended, JSON.stringify(ended)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
    return ended;
}

async function agentEvidence(catalog, workflows) {
    const evidence = [];
    try {
        const store = catalog.workflowStore();
        for (const workflow of workflows) {
            if (!Array.isArray(workflow.runs)) continue;
            for (const run of workflow.runs) {
                for (const node of await store.listNodeExecutions(run.runId)) {
                    if (node.nodeType !== "agent") continue;
                    const invocation = await store.readAgentInvocation(node.nodeExecutionId);
                    if (!invocation?.childSessionId) continue;
                    const events = await catalog.getSessionEvents(invocation.childSessionId, 0, 5000);
                    evidence.push({
                        ...childRecord(await catalog.getSession(invocation.childSessionId), events),
                        toolStarts: events.filter(event => event.eventType === "tool.execution_start")
                            .map(event => event.data.toolName),
                    });
                }
            }
        }
    } catch (error) {
        evidence.push({ unreadable: redactThenClip(String(error.message ?? error), 300) });
    }
    return evidence;
}

async function liveCase(key, options, run) {
    if (plan.state === "blocked") throw new Error(`BLOCKED: ${plan.reason}`);
    if (plan.target !== "local") throw new Error("BLOCKED: no usable model: release-feature witnesses require the local target.");
    const env = createTestEnv(`release-live-${key}`);
    const receipt = { test: "workflow-release-features-real-model", case: key, samples: 1,
        model: plan.model.ref, effort: plan.effort, startedAt: new Date().toISOString(), verdict: null };
    let mgmt;
    let catalog;
    try {
        catalog = await createCatalog(env);
        const artifactStore = new FilesystemArtifactStore(join(env.baseDir, "artifacts"));
        let release;
        const pluginDirs = [];
        if (options.agent) {
            release = await publishAgentPackageDir({ catalog, artifactStore }, {
                dir: packageFixture(env), scope: "shared", owner: OWNER, createdBy: key, isAdmin: false,
            });
            pluginDirs.push(agentFixture(env, options.agent));
        }
        await withRealModelRecorder(env, registry, plan, async recorder => {
            receipt.oracleSource = recorder.source;
            receipt.requests = recorder.requests;
            receipt.cliMetadata = recorder.cliMetadata;
            receipt.transportErrors = recorder.errors;
            receipt.localCancellations = recorder.cancellations;
            const workerOptions = {
                modelProvidersPath: recorder.modelProvidersPath, pluginDirs,
                workflowScripts: { enabled: true }, logLevel: "warning",
                agentPackages: { cacheDir: join(env.baseDir, "package-cache"), refreshIntervalMs: 0 },
            };
            await withClient(env, { worker: workerOptions }, async (client, worker) => {
                recorder.observe(worker.sessionManager);
                mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema,
                    cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, workflowCommands: {} });
                await mgmt.start();
                const parent = await client.createSession({ owner: OWNER, model: plan.model.ref,
                    ...(plan.effort ? { reasoningEffort: plan.effort } : {}) });
                await turnWorkflowsOn(catalog, parent.sessionId);
                receipt.parentSessionId = parent.sessionId;
                const store = catalog.workflowStore();
                try {
                    if (release) {
                        const source = worker.sessionManager.workerDefaults.getCapabilitySources().find(item => item.packageId === release.packageId);
                        expect(source).toBeDefined();
                        const state = await catalog.getSessionCapabilities(parent.sessionId);
                        const args = { source_ref: capabilityRef(source.id, source.revision, "source"), tools: [TOOL],
                            expected_revision: state.revision, request_id: `select-${key}` };
                        if (options.agent === "early") {
                            const config = await catalog.getSessionCreationConfig(parent.sessionId);
                            expect(config).toBeTruthy();
                            const managed = await worker.sessionManager.getOrCreate(parent.sessionId, config);
                            await managed.config.capabilityServices.use(args);
                            await worker.sessionManager.getOrCreate(parent.sessionId, config);
                        } else {
                            await parent.sendAndWait(`I authorize loading the harmless fixture tool. Call use_package with exactly ${JSON.stringify(args)}. `
                                + "Do not call any other tool; then reply OK.", STEP_MS);
                        }
                        expect((await catalog.getSessionCapabilities(parent.sessionId)).selections)
                            .toContainEqual(expect.objectContaining({ sourceId: release.packageId, tools: [TOOL] }));
                    }
                    await run({ env, client, worker, parent, mgmt, catalog, store, receipt, recorder });
                    await recorder.flush();
                    expect(recorder.errors).toEqual([]);
                    expect(recorder.requests.some(request => servesModel(request.model, plan.model))).toBe(true);
                    receipt.verdict = "PASS";
                } finally {
                    await recorder.flush();
                    receipt.evidence = await realModelWorkflowEvidence(catalog, parent.sessionId);
                    if (options.agent) receipt.agentEvidence = await agentEvidence(catalog, receipt.evidence.workflows);
                }
            });
        });
    } catch (error) {
        receipt.verdict = "FAIL";
        receipt.firstError = redactThenClip(String(error.message ?? error), 500);
        throw error;
    } finally {
        receipt.endedAt = new Date().toISOString();
        receipt.durationSeconds = (Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt)) / 1000;
        console.log(`[workflow-release-features-real-model] ${JSON.stringify(receipt)}`);
        if (plan.receiptPath) {
            const path = plan.receiptPath.replace(/(\.json)?$/, `.${key}.json`);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, JSON.stringify(receipt, null, 2));
        }
        try { await mgmt?.stop(); } finally {
            try { await catalog?.close(); } finally { await env.cleanup(); }
        }
    }
}

function workflowHost({ catalog, store, client, worker }) {
    return {
        catalog, store, duroxideClient: client.duroxideClient, scripts: true,
        resolveAgent: createWorkflowAgentResolver({ catalog, deploymentAgents: () => ({
            userAgents: worker._rawLoadedAgents, systemAgents: worker._loadedSystemAgents,
        }) }),
        describeAgentTools: (...args) => worker.sessionManager.describeWorkflowAgentTools(...args),
    };
}

async function namedCase(mode, context) {
    const { parent, mgmt, catalog, store, client, worker, receipt, recorder } = context;
    const yaml = agentDefinition(mode !== "ungranted");
    if (mode === "early") {
        const host = workflowHost(context);
        const binding = await worker.sessionManager.captureWorkflowToolBinding(parent.sessionId);
        expect(binding.agentStepTools).toBe("selections");
        expect(binding.tools.some(tool => tool.name === TOOL)).toBe(true);
        const actor = { kind: "system", name: "early-completion-fixture" };
        const saved = await saveSessionWorkflowDefinition(host, {
            ownerSessionId: parent.sessionId, name: NAME, yaml, expected: null,
            actor, by: "session", binding: async () => binding, operationId: "save-early-completion",
        });
        await recorder.flush();
        expect(recorder.requests).toHaveLength(0);
        expect(recorder.cliMetadata).toHaveLength(0);
        receipt.setup = { source: "services", modelRequests: 0, revision: saved.receipt.revision };
        const started = await startSessionWorkflowDefinition(host, {
            ownerSessionId: parent.sessionId, definition: { definitionId: saved.receipt.definitionId },
            revision: saved.receipt.revision, inputs: {}, notifyParent: false, owner: OWNER, binding,
            actor, operationId: "start-early-completion",
        });
        expect(started.replayed).toBe(false);
        receipt.setup.workflowId = started.workflowId;
    } else {
        await parent.sendAndWait(`Save this exact Workflow as ${NAME}, then start it once with notify_on_completion false. `
            + `Use workflow_definition; do not change the definition, test it, or run it again.\n${yaml}`, STEP_MS);
    }
    const { definition, revision } = await ownedDefinition(mgmt, parent, mode === "early" ? "system" : "session");
    const intended = compileWorkflow(yaml);
    const authored = compileWorkflow(revision.yaml);
    expect(authored.valid).toBe(true);
    expect(authored.ir.nodes.drain).toEqual(intended.ir.nodes.drain);
    receipt.definition = { revision: revision.revision, yamlSha256: revision.yamlSha256 };
    const run = await startedRun(store, definition.definitionId);
    receipt.run = await endedRun(client, store, run);
    const nodes = await store.listNodeExecutions(run.runId);
    const visit = nodes.find(node => node.nodeId === "drain");
    expect(visit).toMatchObject({ state: "completed", winner: "agent", outcome: "done" });
    const invocation = await store.readAgentInvocation(visit.nodeExecutionId);
    const events = await catalog.getSessionEvents(invocation.childSessionId, 0, 5000);
    const child = childRecord(await catalog.getSession(invocation.childSessionId), events);
    receipt.child = child;
    await recorder.flush();
    const offers = recorder.requests.filter(request => request.tools?.includes("complete_workflow_node")
        && (request.source !== "cli-metadata" || request.sessionId === invocation.childSessionId));
    expect(offers.length).toBeGreaterThan(0);
    for (const request of offers) {
        expect(servesModel(request.model, plan.model)).toBe(true);
        expect(request.tools.includes(TOOL)).toBe(mode !== "ungranted");
    }
    expect(child.observedModels.length).toBeGreaterThan(0);
    expect(child.observedModels.every(model => servesModel(model, plan.model))).toBe(true);
    if (mode === "ungranted") {
        expect(child.tools[TOOL] ?? 0).toBe(0);
        // Use the worker's real captured parent grant, not the grantless person-path host.
        // This is an admission control, with no further inference or extra fixture.
        const binding = await worker.sessionManager.captureWorkflowToolBinding(parent.sessionId);
        expect(binding.agentStepTools).toBe("selections");
        expect(binding.tools.some(tool => tool.name === TOOL)).toBe(true);
        const host = workflowHost(context);
        const actor = { kind: "system", name: "ungranted-required-control" };
        const required = JSON.parse(yaml);
        required.states.drain.requiredTools = [TOOL];
        const saved = await saveSessionWorkflowDefinition(host, {
            ownerSessionId: parent.sessionId, name: NAME, yaml: JSON.stringify(required),
            expected: { definitionId: definition.definitionId, revision: revision.revision },
            actor, by: "session", binding: async () => binding, operationId: "require-ungranted-tool",
        });
        await recorder.flush();
        const requestsBefore = recorder.requests.length;
        const refusal = await startSessionWorkflowDefinition(host, {
            ownerSessionId: parent.sessionId, definition: { definitionId: definition.definitionId },
            revision: saved.receipt.revision, inputs: {}, notifyParent: false, owner: OWNER, binding,
            actor, operationId: "start-ungranted-required-control",
        }).then(() => null, error => error);
        expect(refusal).toMatchObject({ code: "WORKFLOW_TOOLS_UNAVAILABLE" });
        expect(refusal.message).toContain(TOOL);
        expect(refusal.details?.diagnostics).toEqual([expect.objectContaining({
            code: "WORKFLOW_TOOL_NOT_GRANTED", path: "states.drain.requiredTools",
            message: expect.stringContaining(TOOL),
        })]);
        expect(await store.sessionDefinitions.listWorkflows({ definitionId: definition.definitionId })).toHaveLength(1);
        await recorder.flush();
        expect(recorder.requests.length).toBe(requestsBefore);
        receipt.ungrantedRequiredControl = {
            source: "start-service/captured-parent-grant",
            revision: saved.receipt.revision, code: refusal.code,
            diagnostics: refusal.details.diagnostics.map(({ code, path }) => ({ code, path })),
            message: redactThenClip(refusal.message, 500), additionalStarts: 0, additionalModelRequests: 0,
        };
    }
    else {
        expect(child.tools[TOOL] ?? 0).toBeGreaterThanOrEqual(1);
        expect(events.some(event => event.eventType === "tool.execution_complete"
            && event.data.toolName === TOOL && event.data.success === true)).toBe(true);
    }
    expect(child.completions.some(completion => completion.accepted)).toBe(true);
    if (mode === "early") {
        const parentEvents = await catalog.getSessionEvents(parent.sessionId, 0, 5000);
        expect(parentEvents.filter(event => event.eventType === "assistant.usage")).toHaveLength(0);
        receipt.setup.parentModelRequests = 0;
        expect(receipt.run.workflowSessionId).toBe(receipt.setup.workflowId);
        expect(child.completions[0]).toMatchObject({ accepted: false, code: "REQUIRED_TOOLS_NOT_CALLED" });
        expect(child.completions.at(-1)).toMatchObject({ accepted: true });
        const names = events.filter(event => event.eventType === "tool.execution_start").map(event => event.data.toolName);
        expect(names[0]).toBe("complete_workflow_node");
        expect(names.indexOf(TOOL)).toBeGreaterThan(0);
        expect(names.lastIndexOf("complete_workflow_node")).toBeGreaterThan(names.indexOf(TOOL));
        expect(names.every(name => offers.some(request => request.tools.includes(name)))).toBe(true);
    } else expect(child.refusedCompletions).toBe(0);
}

describe("Release C features with an always-on live model", () => {
    it("Sean: a named agent receives and calls a granted required tool", { timeout: TEST_MS }, () =>
        liveCase("granted", { agent: "granted" }, context => namedCase("granted", context)));

    it("Sean: without a grant the tool is absent, and requiring it refuses Start", { timeout: TEST_MS }, () =>
        liveCase("ungranted", { agent: "ungranted" }, context => namedCase("ungranted", context)));

    it("an early completion is refused, corrected by the live model, then accepted", { timeout: TEST_MS }, () =>
        liveCase("early", { agent: "early" }, context => namedCase("early", context)));

    it("a live model writes carry that survives a script error route", { timeout: TEST_MS }, () =>
        liveCase("carry", {}, async ({ parent, mgmt, client, store, receipt }) => {
            await parent.sendAndWait(`Build and save one Workflow named ${NAME}, then start it once with notify_on_completion false. `
                + "Do not test it or run it again. Use initialInput {carry:{attempts:0}}, initial count, maxNodeExecutions 20. "
                + "count is a script: input ${input.carry.attempts}; setResult try with {attempts:context.input+1}; try goes to poll. "
                + "poll is a script: carry {attempts:'${input.attempts}'}, input '${input.attempts}', outputSchema integer. "
                + "Its source calls process.exit(3) when context.input<3, otherwise setResult ok with context.input. "
                + "Route execution_failed from poll back to count; ok to done. done is a succeeded terminal with "
                + "output {attempts:'${input.carry.attempts}',result:'${input.result}'}. All failure routes go to a failed terminal. "
                + "Write the YAML yourself; no agent, tools, network, wait or approval steps.", STEP_MS);
            const { definition, revision } = await ownedDefinition(mgmt, parent);
            expect(revision.yaml).toContain("carry");
            const run = await startedRun(store, definition.definitionId);
            const ended = await endedRun(client, store, run);
            expect(ended.terminalOutput).toEqual({ attempts: 3, result: 3 });
            const visits = (await store.listNodeExecutions(run.runId)).filter(node => node.nodeId === "poll");
            expect(visits.map(node => ({ ordinal: node.ordinal, carry: node.carrySnapshot, outcome: node.outcome }))).toEqual([
                { ordinal: 1, carry: { attempts: 1 }, outcome: "execution_failed" },
                { ordinal: 2, carry: { attempts: 2 }, outcome: "execution_failed" },
                { ordinal: 3, carry: { attempts: 3 }, outcome: "ok" },
            ]);
            receipt.definition = { revision: revision.revision, yamlSha256: revision.yamlSha256 };
            receipt.visits = visits.map(node => ({ ordinal: node.ordinal, carry: node.carrySnapshot, outcome: node.outcome }));
            receipt.run = ended;
        }));

    it("a live model builds approval and only the owner can answer through the person path", { timeout: TEST_MS }, () =>
        liveCase("approval", {}, async ({ parent, mgmt, client, store, receipt }) => {
            await parent.sendAndWait(`Build and save one Workflow named ${NAME}, then start it once with notify_on_completion false. `
                + "Do not test it or run it again. initialInput {proposal:7}; initial consent is an approval step with "
                + "question 'Approve proposal 7?' and timeoutSeconds 300. approved goes to a succeeded terminal done with output "
                + "'${input}'. rejected, timed_out and failure go to a failed terminal. No scripts, agents, tools or other steps. "
                + "The person will answer it; do not answer it yourself. Write the YAML yourself.", STEP_MS);
            const { definition, revision } = await ownedDefinition(mgmt, parent);
            const run = await startedRun(store, definition.definitionId);
            const approval = await until(async () => {
                const nodes = await store.listNodeExecutions(run.runId);
                const consent = nodes.find(node => node.nodeId === "consent");
                return consent ? (await store.approvals.readMany([consent.nodeExecutionId])).get(consent.nodeExecutionId) : null;
            }, "pending owner approval");
            expect(approval).toMatchObject({ status: "pending", context: { proposal: 7 }, owner: OWNER });
            const command = { operation: "approval_respond", operation_id: `approve-${randomUUID()}`, run_id: run.runId,
                approval_id: approval.approvalId, context_sha256: approval.contextSha256, decision: "approved" };
            await expect(mgmt.updateWorkflow(run.workflowSessionId, command,
                { principal: { provider: "test", subject: "not-the-owner" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
            expect((await store.readNodeExecution(approval.approvalId)).state).toBe("pending");
            expect((await store.listNodeExecutions(run.runId)).some(node => node.nodeId === "done")).toBe(false);
            const answer = await mgmt.updateWorkflow(run.workflowSessionId, command, { principal: OWNER });
            const ended = await endedRun(client, store, run);
            expect(await store.readNodeExecution(approval.approvalId)).toMatchObject({
                winner: "approval_owner", outcome: "approved", state: "completed",
            });
            expect((await store.approvals.readMany([approval.approvalId])).get(approval.approvalId).decision.decidedBy)
                .toMatchObject(OWNER);
            receipt.definition = { revision: revision.revision, yamlSha256: revision.yamlSha256 };
            receipt.approval = { approvalId: approval.approvalId, contextSha256: approval.contextSha256, answer };
            receipt.run = ended;
        }));
});
