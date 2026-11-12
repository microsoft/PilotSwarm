/**
 * Workflow controller 1.1.0 scaffold (owner 2026-11-12T03:02Z: FB-005, FB-007 and FB-002 share one new controller version).
 * A run is admitted at the newest controller version and keeps it: its controller is started, recovered and continued as
 * new only at the version it was admitted for. A run admitted at 1.0.0 (by the previous build) is still started at 1.0.0,
 * and a version this build does not run is refused before anything is started.
 *
 * Run: npx vitest run test/local/workflow-controller-versions.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { createWorkflow, dispatchWorkflowRun } from "../../src/workflow/service.ts";
import { WORKFLOW_CONTROLLER_NAME, WORKFLOW_CONTROLLER_VERSION } from "../../src/workflow/runtime.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "workflow-controller-versions" };
const ACTOR = { kind: "system", name: "workflow-controller-versions-test" };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: hold, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 30, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

describe("Workflow controller versions (1.1.0 scaffold)", () => {
    it("a new run is admitted and started at 1.1.0; a run admitted at 1.0.0 is started at 1.0.0; an unknown version is refused", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const starts = [];
            const host = {
                catalog: h.catalog, store: h.store,
                duroxideClient: {
                    startOrchestrationVersioned: async (instanceId, name, input, version) => { starts.push({ instanceId, name, input, version }); },
                    getStatus: async () => ({ status: "Running" }),
                    enqueueEvent: async () => {},
                },
            };
            const parent = randomUUID();
            await h.catalog.createSession(parent, { owner: OWNER });
            const create = async () => (await createWorkflow(host, { workflowSessionId: randomUUID(), parentSessionId: parent, yaml: YAML, actor: ACTOR,
                operationId: `create-${randomUUID()}`, publish: true, start: { inputs: {} } })).receipt;

            // A new run: admitted at the newest version, and its controller started there.
            expect(WORKFLOW_CONTROLLER_VERSION).toBe("1.1.0");
            const fresh = await create();
            const freshRun = await h.store.readRun(fresh.run.runId);
            expect(freshRun.controllerVersion).toBe("1.1.0");
            expect(starts.at(-1)).toMatchObject({ name: WORKFLOW_CONTROLLER_NAME, version: "1.1.0", input: { v: 1, runId: fresh.run.runId } });

            // A run the previous build admitted at 1.0.0: its controller is started at 1.0.0, not at the newest version.
            const older = await create();
            await h.q("UPDATE SCHEMA.workflow_runs SET controller_version = '1.0.0' WHERE run_id = $1", [older.run.runId]);
            starts.length = 0;
            await dispatchWorkflowRun(host, older);
            expect(starts).toEqual([expect.objectContaining({ name: WORKFLOW_CONTROLLER_NAME, version: "1.0.0", input: { v: 1, workflowSessionId: older.workflowSessionId, runId: older.run.runId } })]);

            // A version this build does not run: refused before anything is started.
            await h.q("UPDATE SCHEMA.workflow_runs SET controller_version = '0.9.0' WHERE run_id = $1", [older.run.runId]);
            starts.length = 0;
            let refused = null;
            try { await dispatchWorkflowRun(host, older); } catch (error) { refused = error; }
            expect(refused?.code, refused?.message).toBe("CONTROLLER_UNAVAILABLE");
            expect(refused.details).toMatchObject({ controllerVersion: "0.9.0", hostControllerVersion: "1.1.0" });
            expect(starts).toEqual([]);
        } finally {
            await h.stop();
        }
    });
});
