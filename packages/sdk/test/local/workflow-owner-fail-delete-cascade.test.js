/**
 * Gaps 4 and 6: expected GREEN at 4fa702dc8; preserve failed/deleted-owner behavior.
 * Negative controls: dropping the owner/deletion trigger, failing to tombstone descendants, or leaving a run/controller
 * active breaks these assertions. Each active fixture first fails the same no-active-run oracle used after the end.
 * Run: npx vitest run test/local/workflow-owner-fail-delete-cascade.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv, testTime } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import {
    CASCADE_OWNER, CASCADE_TIMEOUT, WORKFLOW_SESSION_END_STATE, openOwnerCascadeRuntime, startCascadeLive, startCascadeBench, pendingCascadeNode,
    cascadeControllerEnded, cascadeControllerRunning, assertNoActiveCascadeRuns, assertActiveCascadeRuns, assertCancelledCascadeNodes,
} from "./workflow-owner-cascade-fixture.js";

const FAILED_REASON = "The session that owns this Workflow ended, so the Workflow was canceled.";
const DELETED_REASON = "The workflow session was deleted.";
const READY = "DELETE_CASCADE_READY";
const getEnv = useSuiteEnv(import.meta.url);

/**
 * `end`: how the run ended, exactly, by path. `{ cascade: { reason, command, operationPrefix, requestedBy } }`: a live
 * delete's cascade reached the Workflow first (its session's own cancel, with the delete's reason); `{ trigger: message }`:
 * a deletion trigger ended it (DELETED_REASON when the Workflow itself was deleted first, FAILED_REASON when its owner
 * ended first). Nothing else is accepted.
 */
async function assertDeletedWorkflow(h, run, client, end, { deleted = false } = {}) {
    expect(await h.catalog.getSession(run.workflowId)).toBeNull();
    expect(await h.q("SELECT deleted_at IS NOT NULL AS deleted FROM SCHEMA.sessions WHERE session_id = $1", [run.workflowId]))
        .toEqual([{ deleted: true }]);
    expect(await h.store.sessionDefinitions.readDefinition(run.definitionId)).toMatchObject({
        deletedAt: expect.any(String),
    });
    expect(await h.q(`SELECT deleted_by::jsonb AS actor FROM SCHEMA.session_workflow_definitions WHERE definition_id = $1`, [run.definitionId]))
        .toEqual([{ actor: { kind: "system", name: "owner-session-deleted" } }]);
    expect(await h.store.readDefinition(run.workflowId)).toMatchObject({ state: "deleted" });
    const ended = await h.store.readRun(run.runId);
    expect(ended).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled" }, finishedAt: expect.any(Date) });
    // The first accepted run end is preserved: the cascade's when it reached the Workflow first, else the trigger's.
    if (end?.cascade) {
        expect(ended.terminalError).toEqual({ code: "cancelled", message: end.cascade.reason, details: {
            accepted: true, command: end.cascade.command, requestedBy: end.cascade.requestedBy,
            operationId: expect.stringMatching(new RegExp(`^${end.cascade.operationPrefix}\\d+-${run.workflowId.slice(0, 8)}$`)),
        } });
    } else {
        expect([DELETED_REASON, FAILED_REASON]).toContain(end?.trigger);
        expect(ended.terminalError).toEqual({ code: "cancelled", message: end.trigger });
    }
    await assertCancelledCascadeNodes(h.store, run);
    // A path that deletes instances may leave NotFound (the controller was proven Running before the delete).
    await cascadeControllerEnded(client, run, { deleted });
    await assertNoActiveCascadeRuns(h.q, [run.workflowId]);
}

describe("failed and deleted owners retain their existing cascades", () => {
    it("gap 4a [GREEN]: owner failed while a test bench waits cancels the test and bench and ends wft", { timeout: CASCADE_TIMEOUT }, async () => {
        const h = await openOwnerCascadeRuntime(getEnv());
        try {
            const owner = randomUUID();
            await h.catalog.createSession(owner, { owner: CASCADE_OWNER });
            const run = await startCascadeBench(h.host, owner, "failed-owner-bench");
            await pendingCascadeNode(h.store, run);
            await assertActiveCascadeRuns(h.q, [run.workflowId], [run.runId]);
            await h.catalog.updateSession(owner, { state: "failed" });
            expect(await h.catalog.getSession(owner)).toMatchObject({ state: "failed" });
            expect(await h.store.readRun(run.runId)).toMatchObject({
                status: "cancelled", pausedFrom: null, terminalError: { code: "cancelled", message: FAILED_REASON },
            });
            await assertCancelledCascadeNodes(h.store, run);
            await cascadeControllerEnded(h.client, run);
            expect(await h.catalog.getSession(run.workflowId)).toMatchObject({ state: WORKFLOW_SESSION_END_STATE, deletedAt: null });
            await assertNoActiveCascadeRuns(h.q, [run.workflowId]);
            // No later test admission may revive a failed owner's bench.
            await expect(startCascadeBench(h.host, owner, "after-failure")).rejects.toThrow();
            await assertNoActiveCascadeRuns(h.q, [run.workflowId]);
        } finally {
            await h.stop();
        }
    });

    for (const path of ["live orchestration", "terminal management fast path"]) {
        it(`gap 4b [GREEN]: deleting an owner by the ${path} tombstones its definition, soft-deletes its Workflow and ends the live controller`,
            { timeout: CASCADE_TIMEOUT * 2 }, async () => {
                const env = getEnv();
                const h = await openWorkflowStore(env);
                const mgmt = await createManagementClient(env);
                try {
                    await withScriptedModel(env, { respond: () => ({ content: READY }) }, async ({ client, qualifiedModel }) => {
                        const owner = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel });
                        if (path === "live orchestration") expect(await owner.sendAndWait("fixture-delete-owner", CASCADE_TIMEOUT)).toBe(READY);
                        const duroxide = client._getDuroxideClient();
                        const host = { catalog: h.catalog, store: h.store, duroxideClient: duroxide, scripts: true };
                        const run = await startCascadeLive(host, owner.sessionId, "deleted-owner-live");
                        await pendingCascadeNode(h.store, run);
                        await assertActiveCascadeRuns(h.q, [run.workflowId], [run.runId]);
                        await cascadeControllerRunning(duroxide, run);
                        // An unstarted owner takes deleteSession's terminal/unknown fast path, with a genuinely live Workflow.
                        await mgmt.deleteSession(owner.sessionId, "fixture delete");
                        expect(await h.catalog.getSession(owner.sessionId)).toBeNull();
                        await assertDeletedWorkflow(h, run, duroxide, path === "live orchestration"
                            ? { cascade: { reason: "fixture delete", command: "cancel", operationPrefix: "session-command:delete-cascade-", requestedBy: owner.sessionId } }
                            : { trigger: DELETED_REASON }, { deleted: path !== "live orchestration" });
                    });
                } finally {
                    await mgmt.stop();
                    await h.stop();
                }
            });
    }

    for (const path of ["live orchestration", "terminal management fast path", "SDK deleteSession"]) {
        it(`gap 6 [GREEN]: deleteSession's ${path} deletes a nested tree, including Workflow and ordinary descendants, with no active orphan`,
            { timeout: CASCADE_TIMEOUT * 2 }, async () => {
                const env = getEnv();
                const h = await openWorkflowStore(env);
                const mgmt = await createManagementClient(env);
                try {
                    await withScriptedModel(env, { respond: () => ({ content: READY }) }, async ({ client, qualifiedModel }) => {
                        const root = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel });
                        if (path !== "terminal management fast path") expect(await root.sendAndWait("fixture-delete-tree", CASCADE_TIMEOUT)).toBe(READY);
                        // Catalog descendants not tracked by state.subAgents must be covered by the real delete cascade too.
                        const nested = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel, parentSessionId: root.sessionId });
                        // Every child is live (has had its first message): a live delete with a child that never started is
                        // https://github.com/microsoft/PilotSwarm/issues/290 section 1 (its parent ends failed, not deleted).
                        if (path === "live orchestration") expect(await nested.sendAndWait("fixture-nested-live", CASCADE_TIMEOUT)).toBe(READY);
                        const leaf = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel, parentSessionId: nested.sessionId });
                        expect(await leaf.sendAndWait("fixture-ordinary-descendant", CASCADE_TIMEOUT)).toBe(READY);
                        const duroxide = client._getDuroxideClient();
                        const host = { catalog: h.catalog, store: h.store, duroxideClient: duroxide, scripts: true };
                        const runs = [
                            await startCascadeLive(host, root.sessionId, "root-workflow"),
                            await startCascadeLive(host, nested.sessionId, "nested-workflow"),
                            await startCascadeBench(host, nested.sessionId, "nested-bench"),
                        ];
                        for (const run of runs) await pendingCascadeNode(h.store, run);
                        const ids = runs.map(run => run.workflowId);
                        await assertActiveCascadeRuns(h.q, ids, runs.map(run => run.runId));
                        for (const run of runs) await cascadeControllerRunning(duroxide, run);
                        await cascadeControllerRunning(duroxide, { controllerInstanceId: `session-${leaf.sessionId}` });
                        if (path === "SDK deleteSession") await client.deleteSession(root.sessionId);
                        else await mgmt.deleteSession(root.sessionId, "fixture delete tree");
                        for (const id of [root.sessionId, nested.sessionId, leaf.sessionId, ...ids]) {
                            expect(await h.catalog.getSession(id), id).toBeNull();
                            expect(await h.q("SELECT deleted_at IS NOT NULL AS deleted FROM SCHEMA.sessions WHERE session_id = $1", [id]))
                                .toEqual([{ deleted: true }]);
                        }
                        // Each run's end, exactly, by path. Live: the cascade reaches each listed Workflow child first, with the
                        // delete's reason (the root's delete, then the nested session's cancel); the bench is not in a child list,
                        // so its owner's end ends it. Fast path: the root's Workflow child is deleted directly; the nested
                        // session is ended before its own Workflows. SDK: each Workflow is deleted directly.
                        const [rootRun, nestedRun, benchRun] = runs;
                        const ends = path === "live orchestration" ? [
                            [rootRun, { cascade: { reason: "fixture delete tree", command: "cancel", operationPrefix: "session-command:delete-cascade-", requestedBy: root.sessionId } }],
                            [nestedRun, { cascade: { reason: "fixture delete tree", command: "cancel", operationPrefix: "session-command:cancel-cascade-", requestedBy: nested.sessionId } }],
                            [benchRun, { trigger: FAILED_REASON }],
                        ] : path === "terminal management fast path" ? [
                            [rootRun, { trigger: DELETED_REASON }], [nestedRun, { trigger: FAILED_REASON }], [benchRun, { trigger: FAILED_REASON }],
                        ] : [
                            [rootRun, { trigger: DELETED_REASON }], [nestedRun, { trigger: DELETED_REASON }], [benchRun, { trigger: DELETED_REASON }],
                        ];
                        for (const [run, end] of ends) await assertDeletedWorkflow(h, run, duroxide, end, { deleted: path !== "live orchestration" });
                        await cascadeControllerEnded(duroxide, { controllerInstanceId: `session-${leaf.sessionId}` }, { deleted: path !== "live orchestration" });
                        await assertNoActiveCascadeRuns(h.q, ids);
                        // All test-schema runs belong to this tree: catches a run omitted from our expected ids.
                        expect(await h.q(`SELECT run.run_id FROM SCHEMA.workflow_runs run JOIN SCHEMA.sessions child
                            ON child.session_id = run.workflow_session_id
                            WHERE child.deleted_at IS NOT NULL AND run.status IN ('admitted', 'running', 'paused')`)).toEqual([]);
                    });
                } finally {
                    await mgmt.stop();
                    await h.stop();
                }
            });
    }
});
