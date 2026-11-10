/**
 * Review L4 (per-session memory on TEST): the client that creates a Workflow agent step's child borrows the worker's own
 * duroxide provider, session catalog and fact store (PilotSwarmClient._startOnShared), as session-proxy's internal clients
 * do. Before, each child started a client of its own (a native duroxide provider, CMS and facts pools, migrations), and
 * stop() never closed the provider. A real worker, three agent steps (session: new) completed by a scripted model: no
 * client is started on its own storage, three borrow the worker's, and the database's connections do not grow per step.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { PilotSwarmClient } from "../../src/client.ts";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 300_000;
const OWNER = { provider: "test", subject: "agent-child-storage", email: null, displayName: null };
const ACTOR = { kind: "system", name: "agent-child-storage" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const STEP_WORKFLOW = JSON.stringify({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "child-storage", version: "1.0.0" },
    initial: "step",
    states: {
        step: { type: "agent", invoke: { prompt: "Say done." }, session: "new", timeoutSeconds: 600, transition: { next: { done: "finished", failure: "failed" } } },
        finished: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    },
}, null, 2);

function respond(body, position) {
    const tools = (body.tools ?? []).map(tool => tool.function?.name);
    if (!tools.includes("complete_workflow_node")) return { content: "ok" };
    if (position.step === 0) return { tools: [{ name: "complete_workflow_node", args: { outcome: "done", output: null, operation_id: "child-storage" } }] };
    return { content: "STATE_COMPLETED" };
}

afterEach(() => vi.restoreAllMocks());

describe("a Workflow agent step's child client borrows the worker's storage (review L4)", () => {
    it("three agent steps start no client on its own storage, borrow the worker's three times, and add no connection per step", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 1 });
        const connections = async () => (await direct.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()")).rows[0].n;
        try {
            await withScriptedModel(env, { respond, worker: { logLevel: "warning" } }, async ({ client }) => {
                const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
                await catalog.initialize();
                try {
                    const store = catalog.workflowStore();
                    const duroxide = client._getDuroxideClient();
                    const parent = randomUUID();
                    await catalog.createSession(parent, { owner: OWNER });
                    const own = vi.spyOn(PilotSwarmClient.prototype, "start");
                    const borrowed = vi.spyOn(PilotSwarmClient.prototype, "_startOnShared");
                    const before = await connections();
                    for (let index = 0; index < 3; index += 1) {
                        const created = await createWorkflowV2({ catalog, store, duroxideClient: duroxide }, {
                            workflowSessionId: randomUUID(), parentSessionId: parent, yaml: STEP_WORKFLOW, actor: ACTOR, operationId: `child-${index}`,
                            publish: true, start: { inputs: {} }, notifyParent: false,
                        });
                        const runId = created.receipt.run.runId;
                        let run = null;
                        for (let waited = 0; waited < 120_000; waited += 250) {
                            run = await store.readRun(runId);
                            if (run && !["admitted", "running", "paused"].includes(run.status)) break;
                            await pause(250);
                        }
                        expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                    }
                    expect(own).not.toHaveBeenCalled();
                    expect(borrowed.mock.calls.length).toBeGreaterThanOrEqual(3);
                    // Each child's own client opened at least a duroxide provider and two pools; borrowing opens none.
                    expect(await connections()).toBeLessThanOrEqual(before + 2);
                } finally {
                    await catalog.close();
                }
            });
        } finally {
            await direct.end();
        }
    });
});
