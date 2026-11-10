/**
 * Workflow version fence (design 02 compatibility; T121, T122). There is one controller version
 * (WORKFLOW_CONTROLLER_VERSION), and a run is never handed to another interpreter than the one it was admitted for:
 *
 * - Every host publishes and starts every revision it compiles (IR 8 included), at the controller version, and the run
 *   records it.
 * - A run is started and recovered at the controller version it recorded at admission; a run that records another
 *   version, or none, is refused (CONTROLLER_UNAVAILABLE) before anything is recorded. A run whose controller ended is
 *   reported through the notifier.
 *
 * Store and service only: a stand-in duroxide client records what would be started, so no orchestration runs and no
 * existing history is touched.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { createWorkflow, recoverWorkflowRun, applyWorkflowUpdate } from "../../src/workflow/service.ts";
import {
    WORKFLOW_CONTROLLER_NAME,
    WORKFLOW_CONTROLLER_VERSION,
    WORKFLOW_NOTIFY_NAME,
    WORKFLOW_NOTIFY_VERSION,
    workflowLiveControllerInstanceId,
    workflowNotifyInstanceId,
} from "../../src/workflow/runtime.ts";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-version-fence-test" };
const MILESTONE = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true };

const yamlOf = doc => JSON.stringify(doc, null, 2);
const head = name => ({ apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name, version: "1.0.0" } });

/** IR 4 (a wait). */
const WAIT_DOC = {
    ...head("wait"),
    initial: "hold",
    states: {
        hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
};
/** IR 8 (an agent state). */
const AGENT_DOC = {
    ...head("agent"),
    initial: "review",
    states: {
        review: {
            type: "agent", invoke: { prompt: "Review it." }, outcomes: ["accepted"], timeoutSeconds: 600,
            transition: { next: { accepted: "done", failure: "failed" } },
        },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
};

/** A stand-in duroxide client: records each start; every instance reads as `statuses[id]`, else NotFound. Nothing runs. */
function recordingClient(statuses = {}) {
    const starts = [];
    return {
        starts, statuses,
        startOrchestrationVersioned: async (instanceId, name, input, version) => { starts.push({ instanceId, name, version }); },
        getStatus: async instanceId => ({ status: statuses[instanceId] ?? "NotFound" }),
        enqueueEvent: async () => {},
    };
}

/** A host over the store whose duroxide client records each start. */
function hostOf(h) {
    return { catalog: h.catalog, store: h.store, duroxideClient: recordingClient() };
}

/** A parent session and a workflow child of `doc`, created as a draft by `host`. */
async function draftOf(h, host, doc) {
    const parentSessionId = randomUUID();
    await h.catalog.createSession(parentSessionId, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflow(host, { workflowSessionId, parentSessionId, yaml: yamlOf(doc), actor: ACTOR, operationId: "create" });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parentSessionId, workflowSessionId, definitionHash: created.receipt.yamlSha256 };
}

const context = operationId => ({ actor: ACTOR, operationId });

describe("workflow version fence: admission (design 02 compatibility; T121)", () => {
    it("a host publishes and starts a revision with an agent state at the controller version, which the run records", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const draft = await draftOf(h, host, AGENT_DOC);
            expect(compileWorkflow(yamlOf(AGENT_DOC), MILESTONE).ir.irVersion).toBeGreaterThanOrEqual(8);
            const started = await applyWorkflowUpdate(host, draft.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: draft.definitionHash, inputs: {} }, context("go"));
            const run = started.receipt.run;
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "admitted", controllerVersion: WORKFLOW_CONTROLLER_VERSION });
            expect(host.duroxideClient.starts).toEqual([{ instanceId: workflowLiveControllerInstanceId(draft.workflowSessionId),
                name: WORKFLOW_CONTROLLER_NAME, version: WORKFLOW_CONTROLLER_VERSION }]);
        } finally {
            await h.stop();
        }
    });
});

/** A published workflow whose live run the store admitted for `controllerVersion` (undefined: none recorded). */
async function storedRunOf(h, controllerVersion) {
    const parentSessionId = randomUUID();
    await h.catalog.createSession(parentSessionId, {});
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const yaml = yamlOf(WAIT_DOC);
    const compiled = compileWorkflow(yaml);
    expect(await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId, owner: null,
        creationConfig: { workflow: { requestSha256: "fence" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId, notifyParent: false, yaml, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "fence", publish: true, title: "Workflow: wait",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, ...(controllerVersion === undefined ? {} : { controllerVersion }) },
    });
    return { parentSessionId, workflowSessionId, run: await h.store.readRun(runId) };
}

describe("workflow version fence: a run keeps its controller version (design 02; T122)", () => {
    it("recovery starts a run at the version it was admitted for, and refuses a run of another version, or none, recording nothing", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const current = await storedRunOf(h, WORKFLOW_CONTROLLER_VERSION);
            expect((await recoverWorkflowRun(host, current.run.runId, { requestedBy: current.parentSessionId, operationId: "recover-1" })).receipt)
                .toMatchObject({ action: "dispatched" });
            expect(host.duroxideClient.starts).toEqual([{ instanceId: current.run.controllerInstanceId, name: WORKFLOW_CONTROLLER_NAME,
                version: WORKFLOW_CONTROLLER_VERSION }]);
            host.duroxideClient.starts.length = 0;
            for (const [label, version] of [["another version", "0.9.0"], ["no version", undefined]]) {
                const other = await storedRunOf(h, version);
                await expect(recoverWorkflowRun(host, other.run.runId, { requestedBy: other.parentSessionId, operationId: "recover" }), label)
                    .rejects.toMatchObject({ code: "CONTROLLER_UNAVAILABLE", details: { runId: other.run.runId, controllerVersion: version ?? null,
                        hostControllerVersion: WORKFLOW_CONTROLLER_VERSION } });
                expect(host.duroxideClient.starts, label).toEqual([]);
                expect(await h.store.readOperationReceipt(other.workflowSessionId, "recover", "recover", null), label).toBeNull();
                expect(await h.store.readRun(other.run.runId), label).toMatchObject({ status: "admitted" });
            }
        } finally {
            await h.stop();
        }
    });

    it("a run whose controller ended is reported through the notifier", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const draft = await draftOf(h, host, WAIT_DOC);
            const run = (await applyWorkflowUpdate(host, draft.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: draft.definitionHash, inputs: {} }, context("go"))).receipt.run;
            // The run began, then its controller ended without ending it.
            await h.store.beginRun(run.runId);
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "running", controllerVersion: WORKFLOW_CONTROLLER_VERSION });
            const recovering = { ...host, duroxideClient: recordingClient() };
            recovering.duroxideClient.statuses[run.controllerInstanceId] = "Completed";
            const recovered = await recoverWorkflowRun(recovering, run.runId, { requestedBy: draft.parentSessionId, operationId: "recover" });
            expect(recovered.receipt).toMatchObject({ action: "ended", status: "failed" });
            expect(recovering.duroxideClient.starts).toEqual([{ instanceId: workflowNotifyInstanceId(run.runId), name: WORKFLOW_NOTIFY_NAME,
                version: WORKFLOW_NOTIFY_VERSION }]);
        } finally {
            await h.stop();
        }
    });
});
