/**
 * Workflow v2 readWorkflow in direct mode (decision read-workflow-transport,
 * option A), on real PostgreSQL: the management client's human read adapter.
 * It returns readWorkflowV2View's bounded view of the workflow (the same
 * object the read_workflow tool builds its answer from) without the YAML,
 * and changes nothing. A missing or deleted session is NOT_FOUND, a session
 * that is not a version 2 workflow WORKFLOW_NOT_FOUND, a run that is not one
 * of the workflow's runs RUN_NOT_FOUND, and an invalid run id
 * INVALID_REQUEST, each with its HTTP status. The caller's authorization is
 * the portal's session:read gate (web/test/workflow-read-runtime.test.mjs);
 * nothing here passes through the agent tool's parent check.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { readWorkflowV2View } from "../../src/workflow/v2/tools.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;

const YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: read-api, version: "1.0.0" }
initial: step
states:
  step:
    type: script
    source: |
      await setResult("ok", { n: 3 });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;

async function refused(call, code, status) {
    let caught;
    try { await call(); } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    expect(caught?.status).toBe(status);
}

describe("workflow v2 readWorkflow (direct management client)", () => {
    it("reads a workflow's bounded view without its YAML, changes nothing, and refuses what is not one with a status", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const mgmt = await createManagementClient(env);
        try {
            const store = catalog.workflowStore();
            const owner = { provider: "test", subject: `read-${randomUUID()}` };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner });
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            const compiled = compileWorkflowV2(YAML);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
                creationConfig: { workflowV2: { requestSha256: "read-api" } } })).created).toBe(true);
            await store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: YAML, compiled, actor: { kind: "system", name: "read-api-test" },
                operationId: "create", requestSha256: "read-api", publish: true, title: "Workflow: read-api",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
                    testAgentMode: null },
            });

            // The live run by default, or the run named; the YAML is not included.
            const view = await mgmt.readWorkflow(workflowSessionId);
            expect(view).toEqual(await readWorkflowV2View(store, workflowSessionId, { runId: null }));
            expect(view).toMatchObject({ workflowId: workflowSessionId, definition: { state: "published", currentRevision: 1 },
                revision: { revision: 1, valid: true }, run: { runId, mode: "live" } });
            expect(view.revision).not.toHaveProperty("yaml");
            expect(view.graph?.states?.map(state => state.id)).toEqual(["step", "done"]);
            expect(await mgmt.readWorkflow(workflowSessionId, { runId })).toEqual(view);
            // Reading changes nothing.
            expect(await store.readRun(runId)).toMatchObject({ status: "admitted" });
            expect(await mgmt.readWorkflow(workflowSessionId)).toEqual(view);

            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: randomUUID() }), "RUN_NOT_FOUND", 404);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: "  " }), "INVALID_REQUEST", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: "r".repeat(257) }), "INVALID_REQUEST", 400);
            await refused(() => mgmt.readWorkflow(parent), "WORKFLOW_NOT_FOUND", 404);
            await refused(() => mgmt.readWorkflow(randomUUID()), "NOT_FOUND", 404);
            await catalog.softDeleteSession(workflowSessionId);
            await refused(() => mgmt.readWorkflow(workflowSessionId), "NOT_FOUND", 404);
        } finally {
            await mgmt.stop();
            await catalog.close();
        }
    });
});
