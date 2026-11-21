/**
 * Workflow Simplified A1 (spec 14; owner decision E4), on real PostgreSQL: sessions inside a Workflow (an agent node's
 * session and its sub-agents) get no definition tools, and the server refuses the calls too.
 *
 * - The stored lineage decides (sessionInsideWorkflow, which the turn's bridge reads whatever its worker runs): an agent
 *   state's own child and that child's sub-agent are inside the Workflow; the session that started the Workflow, the
 *   Workflow session itself and an ordinary sub-agent of that session are not (O3: ordinary sub-agents keep the tools).
 * - spawn_workflow refuses inside a Workflow in words (the tools' JSON refusal with its code), for any document, before
 *   anything is made; outside it reaches its own checks.
 * - The model is not declared update_workflow or workflow_definition inside a Workflow (spawn_workflow nowhere); every other
 *   tool stays (A5).
 *
 * No controller runs here: the lineage is the agent state's admitted invocation record, as the controller writes it.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import {
    sessionInsideWorkflow, WORKFLOW_DEFINITION_TOOLS, WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT, WORKFLOW_DEFINITION_TOOLS_REFUSED,
    workflowDefinitionToolsRefusal,
} from "../../src/workflow/input-policy.ts";
import { WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { spawnWorkflowFromTool } from "../../src/workflow/spawn.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-a1-refusal-test" };
const PERSON = { provider: "test", subject: "alice" };

const AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: reviewer, version: "1.0.0" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "Review it." }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const FIXTURE_DRAFT = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: nested, version: "1.0.0" }
initial: done
states:
  done: { type: terminal, outcome: succeeded }
`;

/** A document in another format: refused for its apiVersion outside a Workflow. */
const OTHER_FORMAT = "apiVersion: example.com/other\nkind: Workflow\nmetadata: { name: x, version: 1.0.0 }\n";

/** The session P, its Workflow W with agent state `review` admitted for child C, C's sub-agent G, and P's ordinary sub-agent S. */
async function lineageOf(catalog) {
    const store = catalog.workflowStore();
    const parent = randomUUID();
    await catalog.createSession(parent, { owner: PERSON });
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const compiled = compileWorkflow(AGENT_YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect((await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflow: { requestSha256: "a1-refusal" } } })).created).toBe(true);
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: AGENT_YAML, compiled, actor: ACTOR, operationId: "create",
        requestSha256: "a1-refusal", publish: true, title: `Workflow: ${compiled.name}`,
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
    });
    const child = randomUUID();
    const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
    expect(await store.enterNode({
        runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent", predecessorId: null,
        arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
        agent: { childSessionId: child, controllingSessionId: parent, task: { source: "prompt", prompt: "Review it." }, outcomes: ["accepted"],
            outputSchema: "ReviewResult", timeoutSeconds: 3600 },
    })).toMatchObject({ admitted: true, inserted: true });
    await catalog.createSession(child, { parentSessionId: workflowSessionId });
    const grandchild = randomUUID();
    await catalog.createSession(grandchild, { parentSessionId: child });
    const ordinary = randomUUID();
    await catalog.createSession(ordinary, { parentSessionId: parent });
    return { store, parent, workflowSessionId, child, grandchild, ordinary };
}

/** spawn_workflow as the turn's bridge runs it for `caller`, its A1 check read from the store; nothing is ever saved. */
function spawnAs(store, caller) {
    const reached = [];
    const deps = {
        parentSessionId: caller,
        enabled: () => true,
        definitionToolsRefused: () => sessionInsideWorkflow(store, caller),
        resolveOwner: async () => null,
        captureToolBinding: async () => { throw new Error("not reached in this test"); },
        workflowHost: async () => { reached.push("host"); throw new Error("not reached in this test"); },
    };
    return { reached, call: (yaml) => spawnWorkflowFromTool({ yaml }, { toolCallId: "call-1" }, deps) };
}

describe("Workflow Simplified A1: no definition tools inside a Workflow", () => {
    it("the stored lineage decides who is inside a Workflow, and spawn_workflow refuses there in words", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const { store, parent, workflowSessionId, child, grandchild, ordinary } = await lineageOf(catalog);
            expect(await sessionInsideWorkflow(store, child)).toBe(true);
            expect(await sessionInsideWorkflow(store, grandchild)).toBe(true);
            expect(await sessionInsideWorkflow(store, parent)).toBe(false);
            expect(await sessionInsideWorkflow(store, workflowSessionId)).toBe(false);
            expect(await sessionInsideWorkflow(store, ordinary)).toBe(false);
            expect(await sessionInsideWorkflow(store, randomUUID())).toBe(false);

            for (const caller of [child, grandchild]) {
                const { reached, call } = spawnAs(store, caller);
                const refused = JSON.parse(await call(FIXTURE_DRAFT));
                expect(refused).toEqual({ ok: false, error: { code: WORKFLOW_DEFINITION_TOOLS_REFUSED, message: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT } });
                expect(refused.error.message).toMatch(/^Sessions inside a Workflow cannot create or change workflow definitions\./);
                expect(JSON.parse(await call(OTHER_FORMAT))).toEqual(refused);
                expect(reached).toEqual([]);
            }
            // Outside a Workflow the call reaches spawn_workflow's own checks (here: a document in another format).
            for (const caller of [parent, ordinary]) {
                const { reached, call } = spawnAs(store, caller);
                expect(JSON.parse(await call(OTHER_FORMAT)).error.code).toBe("WORKFLOW_API_VERSION");
                expect(reached).toEqual([]);
            }
            // update_workflow's refusal, as the bridge answers it inside a Workflow.
            expect(JSON.parse(workflowDefinitionToolsRefusal()))
                .toEqual({ ok: false, error: { code: WORKFLOW_DEFINITION_TOOLS_REFUSED, message: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT } });
        } finally {
            await catalog.close();
        }
    });

    it("the model is declared no definition tools inside a Workflow; every other tool stays", () => {
        // Stage 2.1: workflow_definition (the session's own definitions) is a definition tool too, so A1 refuses it inside a Workflow.
        expect([...WORKFLOW_DEFINITION_TOOLS]).toEqual(["spawn_workflow", "update_workflow", "workflow_definition"]);
        const names = defs => defs.map(def => def.name);
        for (const opts of [{}, { workflowMilestone: true }, { workflowMilestone: true, workflowAgentChild: true }]) {
            const outside = names(ManagedSession.subAgentToolDefs(opts));
            const inside = names(ManagedSession.subAgentToolDefs({ ...opts, workflowInsideWorkflow: true }));
            // spawn_workflow is no longer declared anywhere (its handler refuses inside a Workflow, above).
            expect(outside).toEqual(expect.arrayContaining(["update_workflow", "workflow_definition"]));
            expect(outside).not.toContain("spawn_workflow");
            expect(inside).not.toContain("spawn_workflow");
            expect(inside).not.toContain("update_workflow");
            expect(inside).not.toContain("workflow_definition");
            expect(inside).toEqual(outside.filter(name => !WORKFLOW_DEFINITION_TOOLS.includes(name)));
        }
    });
});
