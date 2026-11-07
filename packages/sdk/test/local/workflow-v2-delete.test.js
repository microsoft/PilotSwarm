/**
 * Deleting a v2 workflow session, on a real worker and PostgreSQL, through
 * the normal management API and the session catalog that every deletion
 * path uses. A deletion that commits first prevents any script entry; one
 * that commits while a script runs stops it; the definition stays a
 * permanent tombstone. A loopback probe server records every external
 * effect the scripts attempt.
 *
 * Model cases: docs/formal/workflow-v2/WorkflowV2Run.tla, Prop_NoScriptAfterDelete
 * and Prop_TombstonePermanent.
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient, withClient } from "../helpers/local-workers.js";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { workflowEffectInstanceId } from "../../src/workflow/v2/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const ACTOR = { kind: "system", name: "workflow-v2-delete-test" };

async function probeServer() {
    const hits = [];
    const server = createServer((req, res) => {
        hits.push(req.url);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        count: (path) => hits.filter(hit => hit === path).length,
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
    };
}

function yamlFor(name, probeUrl, waitMs) {
    return `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: act
states:
  act:
    type: script
    timeoutSeconds: 120
    source: |
      await fetch("${probeUrl}/start");
      await new Promise(resolve => setTimeout(resolve, ${waitMs}));
      await fetch("${probeUrl}/late");
      await setResult("ok", {});
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;
}

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function host(client, duroxideClient = client.duroxideClient) {
    return { catalog: client._catalog, store: client._catalog.workflowStore(), duroxideClient };
}

async function expectTombstone(h, id, runId) {
    const definition = await h.store.readDefinition(id);
    expect(definition.state).toBe("deleted");
    const run = await h.store.readRun(runId);
    expect(run.status).toBe("cancelled");
    expect(run.terminalError).toMatchObject({ code: "cancelled" });
    expect(await h.catalog.getSession(id)).toBeNull();
    await expect(createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml: "kind: x", actor: ACTOR, operationId: "again" }))
        .rejects.toMatchObject({ code: "WORKFLOW_DELETED" });
}

describe("deleting a v2 workflow session", () => {
    it("lets a delete that wins after the run's admission and before dispatch prevent every script entry", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const probe = await probeServer();
            const mgmt = await createManagementClient(getEnv());
            try {
                // Dispatch waits at this gate, after createWorkflowV2 committed the admitted run.
                let release, reached;
                const gate = new Promise(resolve => { release = resolve; });
                const atGate = new Promise(resolve => { reached = resolve; });
                let dispatched = 0;
                const gated = host(client, {
                    startOrchestrationVersioned: async (...args) => {
                        reached();
                        await gate;
                        dispatched += 1;
                        return client.duroxideClient.startOrchestrationVersioned(...args);
                    },
                });
                const id = randomUUID();
                const creating = createWorkflowV2(gated, { workflowSessionId: id, parentSessionId: null,
                    yaml: yamlFor("delete-before-dispatch", probe.url, 0), actor: ACTOR, operationId: "start", start: { inputs: {} } });
                await atGate;
                const [admitted] = await gated.store.listRuns(id);
                expect(admitted.status).toBe("admitted");

                // Dispatch already read the run as admitted and now waits at the gate.
                await mgmt.deleteSession(id, "deleted before dispatch");
                release();
                const created = await creating;
                expect(created.receipt.run.runId).toBe(admitted.runId);
                expect(dispatched).toBe(1);
                // The controller starts after the delete; begin finds the run cancelled under the session lock.
                const controller = await client.duroxideClient.waitForOrchestration(admitted.controllerInstanceId, 30_000);
                expect(controller.status, JSON.stringify(controller)).toBe("Completed");
                expect(await gated.store.listNodeExecutions(admitted.runId)).toEqual([]);
                expect(probe.count("/start")).toBe(0);
                await expectTombstone(gated, id, admitted.runId);
                // Retrying the original creation request does not resurrect it.
                await expect(createWorkflowV2(gated, { workflowSessionId: id, parentSessionId: null,
                    yaml: yamlFor("delete-before-dispatch", probe.url, 0), actor: ACTOR, operationId: "start", start: { inputs: {} } }))
                    .rejects.toMatchObject({ code: "WORKFLOW_DELETED" });
            } finally {
                await mgmt.stop?.();
                await probe.close();
            }
        });
    });

    it("tombstones drafts and finished workflows without changing a finished run", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const probe = await probeServer();
            const mgmt = await createManagementClient(getEnv());
            try {
                const h = host(client);
                const draftId = randomUUID();
                await createWorkflowV2(h, { workflowSessionId: draftId, parentSessionId: null, yaml: yamlFor("draft", probe.url, 0),
                    actor: ACTOR, operationId: "draft" });
                await mgmt.deleteSession(draftId, "draft deleted");
                expect((await h.store.readDefinition(draftId)).state).toBe("deleted");
                expect(await h.store.listRuns(draftId)).toEqual([]);
                await expect(createWorkflowV2(h, { workflowSessionId: draftId, parentSessionId: null, yaml: yamlFor("draft", probe.url, 0),
                    actor: ACTOR, operationId: "draft" })).rejects.toMatchObject({ code: "WORKFLOW_DELETED" });

                const doneId = randomUUID();
                const done = await createWorkflowV2(h, { workflowSessionId: doneId, parentSessionId: null, yaml: yamlFor("finished", probe.url, 0),
                    actor: ACTOR, operationId: "run", start: { inputs: {} } });
                await until(async () => (await h.store.readRun(done.receipt.run.runId)).status === "completed", "the run to finish");
                await client.duroxideClient.waitForOrchestration(done.receipt.run.controllerInstanceId, 30_000);
                await mgmt.deleteSession(doneId, "finished workflow deleted");
                expect((await h.store.readDefinition(doneId)).state).toBe("deleted");
                const run = await h.store.readRun(done.receipt.run.runId);
                expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalError: null });
                expect(await h.catalog.getSession(doneId)).toBeNull();
            } finally {
                await mgmt.stop?.();
                await probe.close();
            }
        });
    });

    it("stops a running script when its session is deleted directly in the catalog", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const probe = await probeServer();
            try {
                const h = host(client);
                // Positive control: undisturbed, the script reaches its late effect.
                const control = await createWorkflowV2(h, { workflowSessionId: randomUUID(), parentSessionId: null,
                    yaml: yamlFor("control", probe.url, 2_000), actor: ACTOR, operationId: "control", start: { inputs: {} } });
                await until(async () => (await h.store.readRun(control.receipt.run.runId)).status === "completed", "the control run", 60_000);
                expect(probe.count("/late")).toBe(1);

                const id = randomUUID();
                const started = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null,
                    yaml: yamlFor("delete-while-running", probe.url, 6_000), actor: ACTOR, operationId: "start", start: { inputs: {} } });
                await until(() => probe.count("/start") === 2, "the script to start");
                const [node] = await h.store.listNodeExecutions(started.receipt.run.runId);
                await client._catalog.softDeleteSession(id);
                const effect = await client.duroxideClient.waitForOrchestration(workflowEffectInstanceId(node.nodeExecutionId), 30_000);
                expect(effect.status, JSON.stringify(effect)).toBe("Completed");
                expect(probe.count("/late")).toBe(1);
                expect(await h.store.readNodeExecution(node.nodeExecutionId)).toMatchObject({
                    state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "delete",
                });
                await expectTombstone(h, id, started.receipt.run.runId);
            } finally { await probe.close(); }
        });
    });

    it("deletes a running workflow through the management API with its controller and no late effect", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const probe = await probeServer();
            const mgmt = await createManagementClient(getEnv());
            try {
                const h = host(client);
                const id = randomUUID();
                const started = await createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null,
                    yaml: yamlFor("delete-via-management", probe.url, 6_000), actor: ACTOR, operationId: "start", start: { inputs: {} } });
                await until(() => probe.count("/start") === 1, "the script to start");
                const [node] = await h.store.listNodeExecutions(started.receipt.run.runId);
                await mgmt.deleteSession(id, "deleted while running");
                const effect = await client.duroxideClient.waitForOrchestration(workflowEffectInstanceId(node.nodeExecutionId), 30_000);
                expect(["Completed", "Failed", "Terminated", "Cancelled"]).toContain(effect.status);
                expect(probe.count("/late")).toBe(0);
                const stored = await h.store.readNodeExecution(node.nodeExecutionId);
                expect(stored.state).toBe("completed");
                expect(["cancel", "delete"]).toContain(stored.winner);
                await expectTombstone(h, id, started.receipt.run.runId);
            } finally {
                await mgmt.stop?.();
                await probe.close();
            }
        });
    });
});
