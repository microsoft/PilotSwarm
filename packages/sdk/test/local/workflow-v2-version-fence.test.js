/**
 * Workflow v2 version and capability fence (design 02 compatibility,
 * migration and rollout; T121, T122). Reader support precedes new writes,
 * and a run is never handed to another interpreter than the one it was
 * admitted for:
 *
 * - A host that starts 1.8.0 runs neither publishes nor starts a revision
 *   whose IR it does not run (IR 7 and 8: request, agent or parallel states,
 *   or a run deadline): CONTROLLER_UNAVAILABLE, and nothing is written. A
 *   host that starts 1.9.0 runs does both.
 * - A run is started and recovered at the controller version it recorded at
 *   admission (a run admitted before migration 0096 recorded none: 1.8.0),
 *   never at the acting host's version; a host that does not run that
 *   version refuses before anything is recorded. Its notifier is the one of
 *   that version.
 *
 * Store and service only: a stand-in duroxide client records what would be
 * started, so no orchestration runs and no existing history is touched.
 * Orchestration items of a version a worker has not registered are a
 * separate matter (duroxide abandons and then poisons them): the activation
 * gate of the request design (8.4) addresses that, not this fence.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { createWorkflowV2, recoverWorkflowV2Run, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";
import {
    WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_CONTROLLER_VERSION, WORKFLOW_V2_NOTIFY_NAME, WORKFLOW_V2_NOTIFY_VERSION,
    WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, WORKFLOW_V2_TAGGED_ORCHESTRATION_VERSION, workflowLiveControllerInstanceId, workflowNotifyInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-version-fence-test" };
const MILESTONE = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true };

const yamlOf = doc => JSON.stringify(doc, null, 2);
const head = name => ({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name, version: "1.0.0" } });

/** IR 4 (a wait): every host runs it. */
const WAIT_DOC = {
    ...head("wait"),
    initial: "hold",
    states: {
        hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
};
/** IR 8 (an agent state): only a host that starts 1.9.0 runs runs it. */
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

/** Two hosts over one store: one that starts 1.9.0 runs (requests) and one that starts 1.8.0 runs. */
function hostsOf(h) {
    return {
        milestone: { catalog: h.catalog, store: h.store, duroxideClient: recordingClient(), requests: true },
        legacy: { catalog: h.catalog, store: h.store, duroxideClient: recordingClient() },
    };
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
    it("a 1.8.0 host neither publishes nor starts a revision whose IR it does not run; a 1.9.0 host does both", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { milestone, legacy } = hostsOf(h);
            expect(compileWorkflowV2(yamlOf(AGENT_DOC), MILESTONE).ir.irVersion).toBe(8);
            const draft = await draftOf(h, milestone, AGENT_DOC);
            expect(await h.store.readRevisionIrVersion(draft.workflowSessionId, 1)).toBe(8);
            expect(await h.store.readRevisionIrVersion(draft.workflowSessionId, 2)).toBeNull();
            const refusal = { code: "CONTROLLER_UNAVAILABLE", details: { revision: 1, irVersion: 8, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION,
                hostControllerVersion: WORKFLOW_V2_CONTROLLER_VERSION } };
            await expect(updateWorkflowV2(legacy, draft.workflowSessionId,
                { operation: "publish", expectedRevision: 1, definitionHash: draft.definitionHash }, context("publish-legacy"))).rejects.toMatchObject(refusal);
            await expect(updateWorkflowV2(legacy, draft.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: draft.definitionHash, inputs: {} }, context("go-legacy")))
                .rejects.toMatchObject(refusal);
            expect(await h.store.readDefinition(draft.workflowSessionId)).toMatchObject({ state: "draft", publishedRevision: null });

            expect((await updateWorkflowV2(milestone, draft.workflowSessionId,
                { operation: "publish", expectedRevision: 1, definitionHash: draft.definitionHash }, context("publish"))).receipt).toMatchObject({ state: "published" });
            await expect(updateWorkflowV2(legacy, draft.workflowSessionId,
                { operation: "start", definitionHash: draft.definitionHash, inputs: {} }, context("start-legacy"))).rejects.toMatchObject(refusal);
            expect(await h.store.listRuns(draft.workflowSessionId)).toEqual([]);
            expect(legacy.duroxideClient.starts).toEqual([]);

            const started = await updateWorkflowV2(milestone, draft.workflowSessionId,
                { operation: "start", definitionHash: draft.definitionHash, inputs: {} }, context("start"));
            const run = await h.store.readRun(started.receipt.run.runId);
            expect(run).toMatchObject({ status: "admitted", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION });
            expect(milestone.duroxideClient.starts).toEqual([{ instanceId: workflowLiveControllerInstanceId(draft.workflowSessionId),
                name: WORKFLOW_V2_CONTROLLER_NAME, version: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION }]);

            // IR every host runs: the 1.8.0 host publishes and starts it at 1.8.0, as before.
            const plain = await draftOf(h, legacy, WAIT_DOC);
            const plainStarted = await updateWorkflowV2(legacy, plain.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: plain.definitionHash, inputs: {} }, context("go"));
            expect(await h.store.readRun(plainStarted.receipt.run.runId)).toMatchObject({ controllerVersion: WORKFLOW_V2_CONTROLLER_VERSION });
            expect(legacy.duroxideClient.starts).toEqual([{ instanceId: workflowLiveControllerInstanceId(plain.workflowSessionId),
                name: WORKFLOW_V2_CONTROLLER_NAME, version: WORKFLOW_V2_CONTROLLER_VERSION }]);
        } finally {
            await h.stop();
        }
    });
});

describe("workflow v2 version fence: a run keeps its controller version (design 02; T122)", () => {
    it("recovery starts a run at the version it was admitted for, and a host that does not run that version records nothing", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { milestone, legacy } = hostsOf(h);
            // Admitted for 1.8.0 by the 1.8.0 host; its controller never began (the stand-in starts nothing).
            const older = await draftOf(h, legacy, WAIT_DOC);
            const olderRun = (await updateWorkflowV2(legacy, older.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: older.definitionHash, inputs: {} }, context("go"))).receipt.run;
            // The 1.9.0 host recovers it at 1.8.0, never at its own version.
            const recovered = await recoverWorkflowV2Run(milestone, olderRun.runId, { requestedBy: older.parentSessionId, operationId: "recover-1" });
            expect(recovered.receipt).toMatchObject({ action: "dispatched" });
            expect(milestone.duroxideClient.starts).toEqual([{ instanceId: olderRun.controllerInstanceId, name: WORKFLOW_V2_CONTROLLER_NAME,
                version: WORKFLOW_V2_CONTROLLER_VERSION }]);

            // Admitted for 1.9.0 by the 1.9.0 host: the 1.8.0 host refuses to recover it and records nothing; the 1.9.0 host does.
            const newer = await draftOf(h, milestone, WAIT_DOC);
            const newerRun = (await updateWorkflowV2(milestone, newer.workflowSessionId,
                { operation: "publish_and_start", expectedRevision: 1, definitionHash: newer.definitionHash, inputs: {} }, context("go"))).receipt.run;
            milestone.duroxideClient.starts.length = 0;
            // The 1.8.0 host's only start so far is the older run's own admission; the refusal below adds none.
            expect(legacy.duroxideClient.starts).toEqual([{ instanceId: olderRun.controllerInstanceId, name: WORKFLOW_V2_CONTROLLER_NAME,
                version: WORKFLOW_V2_CONTROLLER_VERSION }]);
            legacy.duroxideClient.starts.length = 0;
            await expect(recoverWorkflowV2Run(legacy, newerRun.runId, { requestedBy: newer.parentSessionId, operationId: "recover-legacy" }))
                .rejects.toMatchObject({ code: "CONTROLLER_UNAVAILABLE", details: { runId: newerRun.runId, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION,
                    hostControllerVersion: WORKFLOW_V2_CONTROLLER_VERSION } });
            expect(legacy.duroxideClient.starts).toEqual([]);
            expect(await h.store.readOperationReceipt(newer.workflowSessionId, "recover-legacy", "recover", null)).toBeNull();
            expect(await h.store.readRun(newerRun.runId)).toMatchObject({ status: "admitted" });
            expect((await recoverWorkflowV2Run(milestone, newerRun.runId, { requestedBy: newer.parentSessionId, operationId: "recover-2" })).receipt)
                .toMatchObject({ action: "dispatched" });
            expect(milestone.duroxideClient.starts).toEqual([{ instanceId: newerRun.controllerInstanceId, name: WORKFLOW_V2_CONTROLLER_NAME,
                version: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION }]);
        } finally {
            await h.stop();
        }
    });

    it("a run whose controller ended is reported through its own version's notifier, whichever host recovers it", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { milestone, legacy } = hostsOf(h);
            const cases = [];
            for (const [admitting, version, notifier] of [[legacy, WORKFLOW_V2_CONTROLLER_VERSION, WORKFLOW_V2_NOTIFY_VERSION],
                [milestone, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, WORKFLOW_V2_TAGGED_ORCHESTRATION_VERSION]]) {
                const draft = await draftOf(h, admitting, WAIT_DOC);
                const run = (await updateWorkflowV2(admitting, draft.workflowSessionId,
                    { operation: "publish_and_start", expectedRevision: 1, definitionHash: draft.definitionHash, inputs: {} }, context("go"))).receipt.run;
                // The run began, then its controller ended without ending it.
                await h.store.beginRun(run.runId);
                expect(await h.store.readRun(run.runId)).toMatchObject({ status: "running", controllerVersion: version });
                cases.push({ draft, run, notifier });
            }
            const recovering = { ...milestone, duroxideClient: recordingClient() };
            for (const { draft, run, notifier } of cases) {
                recovering.duroxideClient.statuses[run.controllerInstanceId] = "Completed";
                const recovered = await recoverWorkflowV2Run(recovering, run.runId, { requestedBy: draft.parentSessionId, operationId: "recover" });
                expect(recovered.receipt).toMatchObject({ action: "ended", status: "failed" });
                expect(recovering.duroxideClient.starts.at(-1)).toEqual({ instanceId: workflowNotifyInstanceId(run.runId), name: WORKFLOW_V2_NOTIFY_NAME, version: notifier });
            }
            expect(recovering.duroxideClient.starts).toHaveLength(2);
        } finally {
            await h.stop();
        }
    });
});
