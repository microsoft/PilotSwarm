/**
 * Workflow v2 publication pins (design 02 publication record, 03 package
 * agents; R18, R28; T011, T018, T070; migration 0099), INACTIVE: only a host
 * that starts runs at controller 1.9.0 compiles agent states and resolves
 * agents. Here a mutable test-double catalog stands in for the resolver
 * (the registry-backed one those hosts use is
 * workflow-v2-agent-resolver.test.js's).
 *
 * - Publication resolves every named agent state for the workflow's parent,
 *   as the child would be bound: an agent that is missing, a worker-managed
 *   system agent, or not at the package or version the state names refuses
 *   the publication (AGENT_UNAVAILABLE) and nothing is published; otherwise
 *   the pins are frozen with the publication and read_workflow shows them.
 * - A live run binds its agent state to the pin (the real agent host
 *   checks it): a package republished after publication is never picked
 *   up silently (the state fails unavailable), and a new workflow child
 *   published later pins the new version explicitly.
 *
 * The agent host is the real createWorkflowAgentNodeHost with test-double
 * dependencies (a mutable agent catalog and a child double). No model runs.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowV2View } from "../../src/workflow/v2/tools.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/v2/agent-node-service.ts";
import { createWorkflowAgentNodeHost } from "../../src/workflow/v2/agent-host.ts";
import { registerWorkflowV2, sessionQueueTransport } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-publication-test" };
const CHILD = "test-publication-agent-child";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** One agent state naming `agent` (package and version optional), or with an inline `prompt`, then terminals. As a document (JSON is YAML). */
function reviewer(agent, { prompt = null } = {}) {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "pinned", version: "1.0.0" },
        initialInput: { head: "abc" }, initial: "review",
        schemas: { Review: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } }, additionalProperties: false } },
        states: {
            review: {
                type: "agent", invoke: prompt !== null ? { prompt } : { agent }, outputSchema: { $ref: "#/schemas/Review" }, timeoutSeconds: 3600,
                transition: { next: { accepted: "done", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    }, null, 2);
}

function* agentChild(ctx) {
    const received = [];
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        received.push(typeof raw === "string" ? JSON.parse(raw) : raw);
        ctx.setCustomStatus(JSON.stringify(received));
    }
}

/**
 * A worker-equivalent registration with workflowRequests, whose agent host is
 * the real one over a mutable catalog of visible agents (`visible`), and a
 * service host that resolves agents from the same catalog at publication.
 */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    runtime.registerOrchestrationVersioned(CHILD, "1.0.0", agentChild);
    const visible = new Map();
    const resolveAgent = async name => visible.get(name) ?? null;
    const children = [];
    const agentNodes = createWorkflowAgentNodeHost({
        getSession: sessionId => catalog.getSession(sessionId),
        resolveAgent,
        createChild: async spec => {
            children.push(spec);
            const instanceId = `session-${spec.sessionId}`;
            await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: spec.prompt, clientMessageIds: [spec.clientMessageId] }));
        },
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        agentNodes,
    });
    await runtime.start();
    const parent = randomUUID();
    await catalog.createSession(parent, {});
    return {
        catalog, store, client, visible, children, parent,
        host: { catalog, store, duroxideClient: client, requests: true, resolveAgent },
        /** A workflow child of `parent` with this agent; published when `publish`. */
        async workflow(agent, { publish = false } = {}) {
            const workflowSessionId = randomUUID();
            const created = await createWorkflowV2(this.host, {
                workflowSessionId, parentSessionId: parent, yaml: reviewer(agent), actor: ACTOR, operationId: "create", publish,
            });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            return { workflowSessionId, definitionHash: created.receipt.yamlSha256 };
        },
        publish(workflow, operationId = "publish-1") {
            return updateWorkflowV2(this.host, workflow.workflowSessionId, { operation: "publish", expectedRevision: 1, definitionHash: workflow.definitionHash },
                { actor: ACTOR, operationId });
        },
        async start(workflow) {
            const started = await updateWorkflowV2(this.host, workflow.workflowSessionId, { operation: "start", definitionHash: workflow.definitionHash, inputs: {} },
                { actor: ACTOR, operationId: "start-1" });
            return started.receipt.run.runId;
        },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

const REVIEW_KIT = { name: "code-reviewer", packageName: "review-kit", packageVersion: "1.2.0", packageId: "pkg-1" };

describe("workflow v2 publication pins (inactive, test-only host hook)", () => {
    it("refuses to publish a named agent it cannot pin, and freezes the pins it resolves", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            h.visible.set("code-reviewer", REVIEW_KIT);
            h.visible.set("sweeper", { name: "sweeper", system: true, creatable: false });
            for (const [agent, message] of [
                [{ name: "ghost" }, /not available to this workflow's owner/],
                [{ name: "code-reviewer", package: "review-kit", version: "1.1.0" }, /not available at version 1\.1\.0 \(it is at 1\.2\.0\)/],
                [{ name: "code-reviewer", package: "other-kit" }, /not available from package "other-kit"/],
                [{ name: "sweeper" }, /worker-managed system agent/],
            ]) {
                const draft = await h.workflow(agent);
                await expect(h.publish(draft)).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE", message: expect.stringMatching(message),
                    details: { stateId: "review", agent: agent.name } });
                expect(await h.store.readDefinition(draft.workflowSessionId)).toMatchObject({ state: "draft", publishedRevision: null, publishedAgentPins: null });
                // Created as published, the same agent refuses the creation before anything is written.
                await expect(createWorkflowV2(h.host, { workflowSessionId: randomUUID(), parentSessionId: h.parent, yaml: reviewer(agent), actor: ACTOR,
                    operationId: "create", publish: true })).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
            }

            const pin = { review: { name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "pkg-1" } };
            const draft = await h.workflow({ name: "code-reviewer" });
            const published = await h.publish(draft);
            expect(published.receipt).toMatchObject({ state: "published", publishedRevision: 1 });
            expect((await h.store.readDefinition(draft.workflowSessionId)).publishedAgentPins).toEqual(pin);
            // A repeat of the publication returns its receipt; the pins stay as they were frozen, whatever is visible now.
            h.visible.set("code-reviewer", { ...REVIEW_KIT, packageVersion: "1.3.0", packageId: "pkg-2" });
            expect(await h.publish(draft)).toMatchObject({ replayed: true });
            expect((await h.store.readDefinition(draft.workflowSessionId)).publishedAgentPins).toEqual(pin);
            expect((await readWorkflowV2View(h.store, draft.workflowSessionId)).definition.publishedAgentPins).toEqual(pin);
            // An inline prompt is not pinned; a definition without a named agent records no pins.
            const inline = await createWorkflowV2(h.host, { workflowSessionId: randomUUID(), parentSessionId: h.parent, actor: ACTOR, operationId: "create",
                publish: true, yaml: reviewer(null, { prompt: "Review it." }) });
            expect(inline.receipt.state).toBe("published");
            expect((await h.store.readDefinition(inline.receipt.workflowSessionId)).publishedAgentPins).toBeNull();
        } finally {
            await h.stop();
        }
    });

    it("binds a live run's agent state to its pin: a republished package is never picked up silently", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            h.visible.set("code-reviewer", REVIEW_KIT);
            const first = await h.workflow({ name: "code-reviewer" }, { publish: true });
            const later = await h.workflow({ name: "code-reviewer" }, { publish: true });

            // The pinned version is the one the child is bound to, though the definition names no version.
            const runId = await h.start(first);
            const review = nodeExecutionIdFor(runId, "root", "review", 1);
            const invocation = await until(async () => {
                const found = await h.store.readAgentInvocation(review);
                return found?.spawnedAt ? found : null;
            }, "the pinned child");
            expect(invocation.task).toEqual({ source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0" });
            expect(h.children).toHaveLength(1);
            expect(h.children[0]).toMatchObject({ boundAgentName: "code-reviewer", boundAgentPackageId: "pkg-1" });
            expect(JSON.parse(await completeWorkflowNodeFromTool({ outcome: "accepted", output: { verdict: "ok" }, operation_id: "done-1" },
                { callerSessionId: invocation.childSessionId, store: h.store, client: h.client }))).toMatchObject({ ok: true });
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalOutput: { verdict: "ok" } });

            // The package is republished. A run of a definition published before binds to its pin, which no longer
            // resolves: the state fails unavailable, and no child is bound to the new version.
            h.visible.set("code-reviewer", { ...REVIEW_KIT, packageVersion: "1.3.0", packageId: "pkg-2" });
            const laterRun = await h.start(later);
            const failed = await ended(h, laterRun);
            expect(failed).toMatchObject({ status: "failed", terminalNodeId: "failed" });
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(laterRun, "root", "review", 1))).toMatchObject({
                outcome: "unavailable", error: { message: expect.stringMatching(/not available at version 1\.2\.0/) },
            });
            expect(h.children).toHaveLength(1);

            // A new workflow child published now pins the new version explicitly.
            const renewed = await h.workflow({ name: "code-reviewer" }, { publish: true });
            expect((await h.store.readDefinition(renewed.workflowSessionId)).publishedAgentPins)
                .toEqual({ review: { name: "code-reviewer", package: "review-kit", version: "1.3.0", packageId: "pkg-2" } });
        } finally {
            await h.stop();
        }
    });

    it("R18 (T070): a publication that pinned the exact package revision keeps running it after the package is republished; a later publication pins the new revision", { timeout: TIMEOUT }, async () => {
        const OLD = "a".repeat(64);
        const NEW = "b".repeat(64);
        const h = await harness(getEnv());
        try {
            h.visible.set("code-reviewer", { ...REVIEW_KIT, packageRevision: OLD });
            const first = await h.workflow({ name: "code-reviewer" }, { publish: true });
            expect((await h.store.readDefinition(first.workflowSessionId)).publishedAgentPins)
                .toEqual({ review: { name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "pkg-1", revision: OLD } });

            // The package is republished: the same package (its id is kept) is at 1.3.0 now.
            h.visible.set("code-reviewer", { ...REVIEW_KIT, packageVersion: "1.3.0", packageRevision: NEW });
            const runId = await h.start(first);
            const review = nodeExecutionIdFor(runId, "root", "review", 1);
            const invocation = await until(async () => {
                const found = await h.store.readAgentInvocation(review);
                return found?.spawnedAt ? found : null;
            }, "the child bound to the pinned revision");
            // The run asks for the exact revision its publication pinned, and its child is bound to it, not to 1.3.0.
            expect(invocation.task).toEqual({ source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0", packageId: "pkg-1", revision: OLD });
            expect(h.children).toHaveLength(1);
            expect(h.children[0]).toMatchObject({ boundAgentName: "code-reviewer", boundAgentPackageId: `pkg-1@${OLD}`, toolNames: [] });
            expect(JSON.parse(await completeWorkflowNodeFromTool({ outcome: "accepted", output: { verdict: "ok" }, operation_id: "done-1" },
                { callerSessionId: invocation.childSessionId, store: h.store, client: h.client }))).toMatchObject({ ok: true });
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalOutput: { verdict: "ok" } });

            // A new workflow child published now pins the new revision explicitly.
            const renewed = await h.workflow({ name: "code-reviewer" }, { publish: true });
            expect((await h.store.readDefinition(renewed.workflowSessionId)).publishedAgentPins)
                .toEqual({ review: { name: "code-reviewer", package: "review-kit", version: "1.3.0", packageId: "pkg-1", revision: NEW } });
        } finally {
            await h.stop();
        }
    });
});
