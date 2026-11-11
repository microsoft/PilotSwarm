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
    cascadeControllerEnded, assertNoActiveCascadeRuns, assertCancelledCascadeNodes,
} from "./workflow-owner-cascade-fixture.js";

const FAILED_REASON = "The session that owns this Workflow ended, so the Workflow was canceled.";
const DELETED_REASON = "The workflow session was deleted.";
const READY = "DELETE_CASCADE_READY";
const getEnv = useSuiteEnv(import.meta.url);

/**
 * `cascadeReason`: the live delete's own reason. A live owner's delete cascades a cancel with its reason to its Workflow
 * child (the orchestration's shutdown), which ends the run before the owner's row is deleted; the trigger's words apply
 * only when no cascade reached the Workflow first (the fast path, a nested Workflow).
 */
async function assertDeletedWorkflow(h, run, client, cascadeReason = null) {
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
    // deleteSession may mark an ancestor failed before deleting it; the first accepted run end is preserved.
    if (cascadeReason !== null) {
        expect(ended.terminalError).toMatchObject({ message: cascadeReason, details: { command: "cancel" } });
    } else {
        expect([DELETED_REASON, FAILED_REASON]).toContain(ended.terminalError.message);
    }
    await assertCancelledCascadeNodes(h.store, run);
    // The real force-delete paths may terminate the live instance rather than letting it return normally.
    await cascadeControllerEnded(client, run);
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
            await expect(assertNoActiveCascadeRuns(h.q, [run.workflowId])).rejects.toThrow();
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
                        await expect(assertNoActiveCascadeRuns(h.q, [run.workflowId])).rejects.toThrow();
                        // An unstarted owner takes deleteSession's terminal/unknown fast path, with a genuinely live Workflow.
                        await mgmt.deleteSession(owner.sessionId, "fixture delete");
                        expect(await h.catalog.getSession(owner.sessionId)).toBeNull();
                        await assertDeletedWorkflow(h, run, duroxide, path === "live orchestration" ? "fixture delete" : null);
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
                        await expect(assertNoActiveCascadeRuns(h.q, ids)).rejects.toThrow();
                        if (path === "SDK deleteSession") await client.deleteSession(root.sessionId);
                        else await mgmt.deleteSession(root.sessionId, "fixture delete tree");
                        for (const id of [root.sessionId, nested.sessionId, leaf.sessionId, ...ids]) {
                            expect(await h.catalog.getSession(id), id).toBeNull();
                            expect(await h.q("SELECT deleted_at IS NOT NULL AS deleted FROM SCHEMA.sessions WHERE session_id = $1", [id]))
                                .toEqual([{ deleted: true }]);
                        }
                        for (const run of runs) await assertDeletedWorkflow(h, run, duroxide);
                        await cascadeControllerEnded(duroxide, { controllerInstanceId: `session-${leaf.sessionId}` });
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
