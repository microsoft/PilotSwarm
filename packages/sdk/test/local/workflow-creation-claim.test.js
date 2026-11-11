/**
 * A Workflow's creation claim and its stored IR, on real PostgreSQL:
 *
 * - A creation claim states its create fingerprint version: a claim of the
 *   current version is continued or replayed for the same request and refused
 *   for another grant; one that states no version this build knows is refused
 *   (WORKFLOW_STORE_CORRUPT) and nothing is written.
 * - A stored IR states its root contract and catch-all (null for none).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow, parseWorkflowIr, WORKFLOW_API_VERSION } from "../../src/workflow/compiler.ts";
import { createWorkflow, WORKFLOW_CREATE_FINGERPRINT } from "../../src/workflow/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-creation-claim-test" };

const CONTRACT = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: contract, version: "1.0.0" }
outputSchema: { type: object, required: [n], properties: { n: { type: integer } } }
initial: step
states:
  step:
    type: script
    source: |
      await setResult("ok", { n: 3 });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

describe("a Workflow's creation claim and stored IR", () => {
    it("refuses a stored IR whose header does not state its root contract or its catch-all", () => {
        const compiled = compileWorkflow(CONTRACT);
        expect(compiled.ir.outputSchema).toBe("workflow.output");
        expect(compiled.ir.catchAll).toBeNull();
        expect(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir)))).toEqual(compiled.ir);
        const { outputSchema: _dropped, ...withoutRoot } = compiled.ir;
        expect(() => parseWorkflowIr(withoutRoot)).toThrow("stored IR header is invalid");
        const { catchAll: _droppedCatchAll, ...withoutCatchAll } = compiled.ir;
        expect(() => parseWorkflowIr(withoutCatchAll)).toThrow("stored IR header is invalid");
    });

    it("continues a creation record of the current fingerprint, refuses another grant, and refuses a record this build cannot read", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const OWNER = { provider: "test", subject: "claim-owner" };
        const grant = (tools) => ({
            policy: "node-parent-tools-v1", parentSessionId: "", owner: OWNER, config: {}, capabilities: { selections: [] },
            tools: tools.map(name => ({ name, schemaHash: `${name}-schema` })), sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fp",
        });
        const DRAFT = CONTRACT.replace("name: contract", "name: claim-draft");
        const host = { catalog, store, duroxideClient: { startOrchestrationVersioned: async () => { throw new Error("A draft is never dispatched."); } } };
        const create = (id, parentSessionId, owner, binding) => createWorkflow(host, {
            workflowSessionId: id, parentSessionId, owner, yaml: DRAFT, actor: ACTOR, operationId: "create", ...(binding ? { binding } : {}),
        });
        try {
            const parentId = randomUUID();
            await catalog.createSession(parentId, { owner: OWNER });
            const g1 = { ...grant(["read_facts"]), parentSessionId: parentId };
            const g2 = { ...grant(["read_facts", "store_fact"]), parentSessionId: parentId };

            // The current fingerprint: the marker states its version, and a changed grant is another request.
            const current = randomUUID();
            await create(current, parentId, OWNER, g1);
            expect((await catalog.getSessionCreationConfig(current)).workflow).toMatchObject({ fingerprint: WORKFLOW_CREATE_FINGERPRINT, operationId: "create" });
            await expect(create(current, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect((await create(current, parentId, OWNER, g1)).replayed).toBe(true);

            // A claim that states no fingerprint version this build knows is refused, and nothing is written.
            const unknown = randomUUID();
            const marker = { apiVersion: WORKFLOW_API_VERSION, requestSha256: "x", operationId: "create" };
            expect(await catalog.createWorkflowSession(unknown, { parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflow: marker, workflowToolBinding: g1 } })).toEqual({ created: true });
            await expect(create(unknown, parentId, OWNER, g1)).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
            expect(await store.readDefinition(unknown)).toBeNull();
            expect((await catalog.getSessionCreationConfig(unknown)).workflow).toEqual(marker);
        } finally { await catalog.close(); }
    });
});
