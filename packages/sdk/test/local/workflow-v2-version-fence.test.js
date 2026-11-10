/**
 * Workflow v2 version fence (design 02 compatibility; T121, T122). There is one controller version
 * (WORKFLOW_V2_CONTROLLER_VERSION), and a run is never handed to another interpreter than the one it was admitted for:
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
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { createWorkflowV2, recoverWorkflowV2Run, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";
import {
    WORKFLOW_V2_CONTROLLER_NAME,
    WORKFLOW_V2_CONTROLLER_VERSION,
    WORKFLOW_V2_NOTIFY_NAME,
    WORKFLOW_V2_NOTIFY_VERSION,
    workflowLiveControllerInstanceId,
    workflowNotifyInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-version-fence-test" };
const MILESTONE = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true };

const yamlOf = doc => JSON.stringify(doc, null, 2);
const head = name => ({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name, version: "1.0.0" } });

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
    const created = await createWorkflowV2(host, { workflowSessionId, parentSessionId, yaml: yamlOf(doc), actor: ACTOR, operationId: "create" });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parentSessionId, workflowSessionId, definitionHash: created.receipt.yamlSha256 };
}

const context = operationId => ({ actor: ACTOR, operationId });

describe("workflow v2 version fence: admission (design 02 compatibility; T121)", () => {
    it("a host publishes and starts a revision with an agent state at the controller version, which the run records", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const draft = await draftOf(h, host, AGENT_DOC);
            expect(compileWorkflowV2(yamlOf(AGENT_DOC), MILESTONE).ir.irVersion).toBeGreaterThanOrEqual(8);
            const started = await updateWorkflowV2(host, draft.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: draft.definitionHash, inputs: {} }, context("go"));
            const run = started.receipt.run;
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "admitted", controllerVersion: WORKFLOW_V2_CONTROLLER_VERSION });
            expect(host.duroxideClient.starts).toEqual([{ instanceId: workflowLiveControllerInstanceId(draft.workflowSessionId),
                name: WORKFLOW_V2_CONTROLLER_NAME, version: WORKFLOW_V2_CONTROLLER_VERSION }]);
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
    const compiled = compileWorkflowV2(yaml);
    expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId, owner: null,
        creationConfig: { workflowV2: { requestSha256: "fence" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId, notifyParent: false, yaml, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "fence", publish: true, title: "Workflow: wait",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, ...(controllerVersion === undefined ? {} : { controllerVersion }) },
    });
    return { parentSessionId, workflowSessionId, run: await h.store.readRun(runId) };
}

describe("workflow v2 version fence: a run keeps its controller version (design 02; T122)", () => {
    it("recovery starts a run at the version it was admitted for, and refuses a run of another version, or none, recording nothing", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const host = hostOf(h);
            const current = await storedRunOf(h, WORKFLOW_V2_CONTROLLER_VERSION);
            expect((await recoverWorkflowV2Run(host, current.run.runId, { requestedBy: current.parentSessionId, operationId: "recover-1" })).receipt)
                .toMatchObject({ action: "dispatched" });
            expect(host.duroxideClient.starts).toEqual([{ instanceId: current.run.controllerInstanceId, name: WORKFLOW_V2_CONTROLLER_NAME,
                version: WORKFLOW_V2_CONTROLLER_VERSION }]);
            host.duroxideClient.starts.length = 0;
            for (const [label, version] of [["another version", "0.9.0"], ["no version", undefined]]) {
                const other = await storedRunOf(h, version);
                await expect(recoverWorkflowV2Run(host, other.run.runId, { requestedBy: other.parentSessionId, operationId: "recover" }), label)
                    .rejects.toMatchObject({ code: "CONTROLLER_UNAVAILABLE", details: { runId: other.run.runId, controllerVersion: version ?? null,
                        hostControllerVersion: WORKFLOW_V2_CONTROLLER_VERSION } });
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
            const run = (await updateWorkflowV2(host, draft.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: draft.definitionHash, inputs: {} }, context("go"))).receipt.run;
            // The run began, then its controller ended without ending it.
            await h.store.beginRun(run.runId);
            expect(await h.store.readRun(run.runId)).toMatchObject({ status: "running", controllerVersion: WORKFLOW_V2_CONTROLLER_VERSION });
            const recovering = { ...host, duroxideClient: recordingClient() };
            recovering.duroxideClient.statuses[run.controllerInstanceId] = "Completed";
            const recovered = await recoverWorkflowV2Run(recovering, run.runId, { requestedBy: draft.parentSessionId, operationId: "recover" });
            expect(recovered.receipt).toMatchObject({ action: "ended", status: "failed" });
            expect(recovering.duroxideClient.starts).toEqual([{ instanceId: workflowNotifyInstanceId(run.runId), name: WORKFLOW_V2_NOTIFY_NAME,
                version: WORKFLOW_V2_NOTIFY_VERSION }]);
        } finally {
            await h.stop();
        }
    });
});
