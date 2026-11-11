/**
 * Option A: only the existing completion refusals are removed; no migration or trigger change.
 * Gaps 1 and 2 are GREEN at 4fa702dc8: hidden benches cancel through the trigger, ended children remain unchanged.
 * Gap 3 is RED only for management completion (two cases), inline complete_agent, and Completed by parent activity.
 * Live Workflow children reached by the real done cascade cancel with its command attribution, not the trigger's words.
 * Repository-native real DB/runtime/worker paths; the full-stack cases replace only model answers with scripted ones.
 * Run: npx vitest run test/local/workflow-owner-complete-cascade.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv, testTime } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { waitForSessionState } from "../helpers/cms-helpers.js";
import { controlWorkflowRun } from "../../src/workflow/service.ts";
import {
    CASCADE_OWNER, CASCADE_ACTOR, CASCADE_TIMEOUT, openOwnerCascadeRuntime, startCascadeLive, startCascadeBench,
    terminalYaml, pendingCascadeNode, cascadeControllerEnded, assertNoActiveCascadeRuns, assertCancelledCascadeNodes,
} from "./workflow-owner-cascade-fixture.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const OWNER_ENDED_REASON = "The session that owns this Workflow ended, so the Workflow was canceled.";
const PARENT_DONE_REASON = "Completed by parent";
const PARENT_CASCADE_REASON = "Parent session completing";
const PENDING_CASCADE_REASON = "The workflow run was cancelled.";
const CASCADE_OPERATION_PREFIX = "session-command:done-cascade-";
const READY = "CASCADE_READY";
const AGENT_HOLD_REASON = "fixture Workflow agent held";
const AGENT_WAIT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: owner-agent-child, version: "1.0.0" }
initial: work
states:
  work:
    type: agent
    invoke: { prompt: fixture-workflow-agent-hold }
    outputSchema: true
    timeoutSeconds: 3600
    transition: { next: { done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const getEnv = useSuiteEnv(import.meta.url);

describe("completing an owner cancels active Workflows and preserves ended Workflow children", () => {
    it("gap 1 [GREEN]: the existing trigger cancels an active TEST bench and pending node and ends its wft controller", { timeout: CASCADE_TIMEOUT }, async () => {
        const h = await openOwnerCascadeRuntime(getEnv());
        try {
            const owner = randomUUID();
            await h.catalog.createSession(owner, { owner: CASCADE_OWNER });
            const run = await startCascadeBench(h.host, owner, "active-bench");
            await pendingCascadeNode(h.store, run);
            await expect(assertNoActiveCascadeRuns(h.q, [run.workflowId])).rejects.toThrow();
            await h.catalog.updateSession(owner, { state: "completed" });
            expect(await h.catalog.getSession(owner)).toMatchObject({ state: "completed" });
            expect(await h.store.readRun(run.runId)).toMatchObject({
                status: "cancelled", pausedFrom: null, terminalError: { code: "cancelled", message: OWNER_ENDED_REASON },
                finishedAt: expect.any(Date),
            });
            expect((await h.store.readRun(run.runId)).terminalError).toEqual({ code: "cancelled", message: OWNER_ENDED_REASON });
            await assertCancelledCascadeNodes(h.store, run, OWNER_ENDED_REASON);
            await cascadeControllerEnded(h.client, run);
            // Read after the controller's post-end projection, not just after the trigger.
            expect(await h.catalog.getSession(run.workflowId)).toMatchObject({ state: "cancelled", deletedAt: null });
            await assertNoActiveCascadeRuns(h.q, [run.workflowId]);
        } finally {
            await h.stop();
        }
    });

    // Negative control: changing an ended child's own state or rewriting its ended run breaks these exact snapshots.
    it("gap 2 [GREEN]: children whose runs already completed, failed or were cancelled keep their own sessions and run histories unchanged", { timeout: CASCADE_TIMEOUT }, async () => {
        const h = await openOwnerCascadeRuntime(getEnv());
        try {
            const owner = randomUUID();
            await h.catalog.createSession(owner, { owner: CASCADE_OWNER });
            const runs = [];
            for (const status of ["completed", "failed", "cancelled"]) {
                const name = `ended-${status}`;
                const run = await startCascadeLive(h.host, owner, name,
                    status === "cancelled" ? undefined : terminalYaml(name, status === "failed" ? "failed" : "succeeded"));
                if (status === "cancelled") {
                    await pendingCascadeNode(h.store, run);
                    await controlWorkflowRun(h.host, run.workflowId, { operation: "cancel", runId: run.runId, reason: "fixture cancel" },
                        { actor: CASCADE_ACTOR, operationId: `cancel-${randomUUID()}` });
                }
                await cascadeControllerEnded(h.client, run);
                expect((await h.store.readRun(run.runId)).status).toBe(status);
                expect((await h.catalog.getSession(run.workflowId)).state).toBe(status);
                runs.push({ ...run, before: await h.store.readRun(run.runId), beforeSession: await h.catalog.getSession(run.workflowId) });
            }
            await h.catalog.updateSession(owner, { state: "completed" });
            expect(await h.catalog.getSession(owner)).toMatchObject({ state: "completed" });
            for (const run of runs) {
                expect(await h.catalog.getSession(run.workflowId), run.before.status).toEqual(run.beforeSession);
                expect(await h.store.readRun(run.runId)).toEqual(run.before);
            }
            await assertNoActiveCascadeRuns(h.q, runs.map(run => run.workflowId));
        } finally {
            await h.stop();
        }
    });
});

/** Spawn through the model-facing tool so the ordinary child is tracked by the real state.subAgents cascade. */
async function spawnedChild(h, parentId) {
    await expect.poll(async () => (await h.q(`SELECT session_id FROM SCHEMA.sessions
        WHERE parent_session_id = $1 AND session_kind IS DISTINCT FROM 'workflow' AND deleted_at IS NULL`, [parentId])).length,
    { timeout: testTime.ms(30_000) }).toBe(1);
    return (await h.q(`SELECT session_id FROM SCHEMA.sessions WHERE parent_session_id = $1
        AND session_kind IS DISTINCT FROM 'workflow' AND deleted_at IS NULL`, [parentId]))[0].session_id;
}

async function assertLiveCascadeEnd(h, run, ownerId) {
    const ended = await h.store.readRun(run.runId);
    expect(ended.status).toBe("cancelled");
    expect(ended.terminalError).toEqual({
        code: "cancelled", message: PARENT_CASCADE_REASON,
        details: {
            command: "done",
            // Existing store attribution; option A removes no accepted-command markers.
            accepted: true,
            operationId: expect.stringMatching(new RegExp(`^${CASCADE_OPERATION_PREFIX}\\d+-${run.workflowId.slice(0, 8)}$`)),
            requestedBy: ownerId,
        },
    });
    expect(await h.catalog.getSession(run.workflowId)).toMatchObject({
        state: "cancelled", lastError: PARENT_CASCADE_REASON, deletedAt: null,
    });
    await assertCancelledCascadeNodes(h.store, run, PENDING_CASCADE_REASON);
}

describe("the real owner completion entry points, with an active live Workflow and an ordinary child", () => {
    it("gap 1 [GREEN]: management accepts an owner with only an active TEST bench, which the unchanged trigger cancels", { timeout: CASCADE_TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const mgmt = await createManagementClient(env);
        try {
            await withScriptedModel(env, { respond: () => ({ content: READY }) }, async ({ client, qualifiedModel }) => {
                const owner = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel });
                expect(await owner.sendAndWait("fixture-owner-test-bench", CASCADE_TIMEOUT)).toBe(READY);
                const duroxide = client._getDuroxideClient();
                const host = { catalog: h.catalog, store: h.store, duroxideClient: duroxide, scripts: true };
                const run = await startCascadeBench(host, owner.sessionId, "management-bench");
                await pendingCascadeNode(h.store, run);
                await expect(assertNoActiveCascadeRuns(h.q, [run.workflowId])).rejects.toThrow();
                await mgmt.completeSession(owner.sessionId, "fixture bench owner completion", { wait: false });
                await waitForSessionState(h.catalog, owner.sessionId, "completed", testTime.ms(60_000));
                expect((await h.store.readRun(run.runId)).terminalError).toEqual({ code: "cancelled", message: OWNER_ENDED_REASON });
                expect((await h.store.readRun(run.runId)).status).toBe("cancelled");
                await assertCancelledCascadeNodes(h.store, run, OWNER_ENDED_REASON);
                await cascadeControllerEnded(duroxide, run);
                expect(await h.catalog.getSession(run.workflowId)).toMatchObject({ state: "cancelled" });
                await assertNoActiveCascadeRuns(h.q, [run.workflowId]);
            });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    it("gap 3 [RED]: management completion also ends a live Workflow's own agent session", { timeout: CASCADE_TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const mgmt = await createManagementClient(env);
        const respond = (_body, position) => position.lastUserText.includes("fixture-workflow-agent-hold") && position.step === 0
            ? { tools: [{ name: "wait", args: { seconds: 3600, reason: AGENT_HOLD_REASON } }] }
            : { content: READY };
        try {
            await withScriptedModel(env, { respond }, async ({ client, qualifiedModel }) => {
                const owner = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel });
                expect(await owner.sendAndWait("fixture-owner-agent-child", CASCADE_TIMEOUT)).toBe(READY);
                const duroxide = client._getDuroxideClient();
                const host = { catalog: h.catalog, store: h.store, duroxideClient: duroxide, scripts: true };
                const run = await startCascadeLive(host, owner.sessionId, "owner-agent-child", AGENT_WAIT_YAML);
                await pendingCascadeNode(h.store, run);
                const agentRows = () => h.q(`SELECT child_session_id FROM SCHEMA.workflow_agent_invocations
                    WHERE run_id = $1 AND child_session_id IS NOT NULL`, [run.runId]);
                await expect.poll(async () => (await agentRows()).length, { timeout: testTime.ms(60_000) }).toBe(1);
                const agentId = (await agentRows())[0].child_session_id;
                await waitForSessionState(h.catalog, agentId, "waiting", testTime.ms(60_000));
                expect((await h.store.readRun(run.runId)).status).toBe("running");
                await mgmt.completeSession(owner.sessionId, "fixture agent owner completion", { wait: false });
                await waitForSessionState(h.catalog, owner.sessionId, "completed", testTime.ms(60_000));
                await assertLiveCascadeEnd(h, run, owner.sessionId);
                await waitForSessionState(h.catalog, agentId, ["completed", "cancelled"], testTime.ms(60_000));
                await cascadeControllerEnded(duroxide, { controllerInstanceId: `session-${agentId}` });
                await cascadeControllerEnded(duroxide, run);
                await assertLiveCascadeEnd(h, run, owner.sessionId);
                await assertNoActiveCascadeRuns(h.q, [run.workflowId]);
            });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    for (const path of ["done command", "management completeSession", "inline complete_agent", "parent's own completion", "Completed by parent activity"]) {
        const expected = ["done command", "parent's own completion"].includes(path) ? "GREEN" : "RED";
        // Negative control for GREEN paths: the real active fixture first fails the same post-end orphan oracle.
        it(`gap 3 [${expected}]: ${path} accepts completion, cancels its live Workflow and completes its ordinary child`, { timeout: CASCADE_TIMEOUT * 2 }, async () => {
            const env = getEnv();
            const h = await openWorkflowStore(env);
            const mgmt = await createManagementClient(env);
            let ownerId;
            const respond = (_body, position) => {
                const prompt = position.lastUserText;
                if (prompt.includes("fixture-spawn-owner") && position.step === 0) {
                    return { tools: [{ name: "spawn_agent", args: { task: "fixture-owner-idle" } }] };
                }
                if (prompt.includes("fixture-spawn-ordinary") && position.step === 0) {
                    return { tools: [{ name: "spawn_agent", args: { task: "fixture-ordinary-idle" } }] };
                }
                if (prompt.includes("fixture-complete-owner") && position.step === 0) {
                    return { tools: [{ name: "complete_agent", args: { agent_id: `session-${ownerId}` } }] };
                }
                return { content: READY };
            };
            try {
                await withScriptedModel(env, { respond }, async ({ client, worker, model, qualifiedModel }) => {
                    const root = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel });
                    if (path === "Completed by parent activity") {
                        // This parent's instance is a command relay, so the exact activity input at the former refusal is exercised.
                        const owner = await client.createSession({ owner: CASCADE_OWNER, model: qualifiedModel, parentSessionId: root.sessionId });
                        ownerId = owner.sessionId;
                    } else {
                        expect(await root.sendAndWait("fixture-spawn-owner", CASCADE_TIMEOUT)).toBe(READY);
                        ownerId = await spawnedChild(h, root.sessionId);
                    }
                    const owner = await client.resumeSession(ownerId);
                    expect(await owner.sendAndWait("fixture-spawn-ordinary", CASCADE_TIMEOUT)).toBe(READY);
                    const ordinaryId = await spawnedChild(h, ownerId);
                    await waitForSessionState(h.catalog, ordinaryId, "idle", testTime.ms(30_000));
                    const duroxide = client._getDuroxideClient();
                    const host = { catalog: h.catalog, store: h.store, duroxideClient: duroxide, scripts: true };
                    const run = await startCascadeLive(host, ownerId, "live-on-completion");
                    await pendingCascadeNode(h.store, run);
                    await expect(assertNoActiveCascadeRuns(h.q, [run.workflowId])).rejects.toThrow();

                    if (path === "done command") {
                        const id = `done-${randomUUID()}`;
                        await mgmt.sendCommand(ownerId, { cmd: "done", id });
                        await expect.poll(() => mgmt.getCommandResponse(ownerId, id), { timeout: testTime.ms(30_000) })
                            .toMatchObject({ cmd: "done", result: { ok: true } });
                    } else if (path === "management completeSession") {
                        await mgmt.completeSession(ownerId, "fixture management completion", { wait: false });
                    } else if (path === "inline complete_agent") {
                        expect(await root.sendAndWait("fixture-complete-owner", CASCADE_TIMEOUT)).toBe(READY);
                        const results = model.sessionRequests().flatMap(request => request.position.toolResults);
                        expect(results.some(text => text.includes("Graceful completion requested"))).toBe(true);
                        expect(results.join("\n")).not.toMatch(/WORKFLOW_ACTIVE|complete_agent refused|complete_agent failed/);
                    } else if (path === "parent's own completion") {
                        await mgmt.completeSession(root.sessionId, "fixture parent completion", { wait: false });
                    } else {
                        worker.runtime.registerOrchestration("fixture-parent-completes-owner", function* (ctx, input) {
                            yield ctx.scheduleActivity("sendCommandToSession", {
                                sessionId: input.ownerId,
                                command: { type: "cmd", cmd: "done", id: input.commandId,
                                    args: { reason: PARENT_DONE_REASON }, requestedBy: input.rootId },
                            });
                            return "sent";
                        });
                        await duroxide.startOrchestration(`session-${root.sessionId}`, "fixture-parent-completes-owner", {
                            ownerId, rootId: root.sessionId, commandId: `done-parent-${randomUUID()}`,
                        });
                        expect(await duroxide.waitForOrchestration(`session-${root.sessionId}`, testTime.ms(30_000))).toMatchObject({ output: "sent" });
                    }
                    await waitForSessionState(h.catalog, ownerId, "completed", testTime.ms(60_000));
                    await waitForSessionState(h.catalog, ordinaryId, "completed", testTime.ms(60_000));
                    await cascadeControllerEnded(duroxide, { controllerInstanceId: `session-${ordinaryId}` });
                    await assertLiveCascadeEnd(h, run, ownerId);
                    await cascadeControllerEnded(duroxide, run);
                    await assertLiveCascadeEnd(h, run, ownerId);
                    await assertNoActiveCascadeRuns(h.q, [run.workflowId]);
                    if (path === "parent's own completion") {
                        await waitForSessionState(h.catalog, root.sessionId, "completed", testTime.ms(60_000));
                        const executions = await duroxide.listExecutions(`session-${root.sessionId}`);
                        const history = (await Promise.all(executions.map(executionId =>
                            duroxide.readExecutionHistory(`session-${root.sessionId}`, executionId)))).flat();
                        expect(history.some(event => event.kind === "ActivityScheduled"
                            && String(event.data).includes(PARENT_CASCADE_REASON))).toBe(true);
                    }
                });
            } finally {
                await mgmt.stop();
                await h.stop();
            }
        });
    }
});
