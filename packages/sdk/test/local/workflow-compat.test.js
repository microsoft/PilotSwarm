/**
 * Workflow data written by an earlier build stays usable after an upgrade,
 * on real PostgreSQL and the real durable runtime:
 *
 * - An immutable revision compiled to IR version 1 (no root outputSchema;
 *   each succeeded terminal carries the contract it was compiled with) or
 *   version 2 (no catchAll) is read and run as stored: its text and hash are
 *   not rewritten and its YAML is not recompiled.
 * - A creation claim states its create fingerprint version: a claim of the
 *   current version is continued or replayed for the same request and refused
 *   for another grant; one that states no version this build knows is refused
 *   (WORKFLOW_STORE_CORRUPT) and nothing is written.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow, parseWorkflowIr, WORKFLOW_API_VERSION } from "../../src/workflow/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { createWorkflow, dispatchWorkflowRun, WORKFLOW_CREATE_FINGERPRINT } from "../../src/workflow/service.ts";
import { registerWorkflow, WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-compat-test" };

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
afterAll(async () => {
    await pool.end();
});

const CONTRACT = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: old-contract, version: "1.0.0" }
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

/** The IR an earlier build (IR version 1) compiled from the same YAML: the root contract merged into succeeded terminals. */
function versionOneIr(ir) {
    const { outputSchema, catchAll: _catchAll, ...rest } = ir;
    const nodes = Object.fromEntries(Object.entries(ir.nodes).map(([id, node]) => [id,
        node.type === "terminal" && node.outcome === "succeeded" ? { ...node, outputSchema: node.outputSchema ?? outputSchema } : node]));
    return { ...rest, irVersion: 1, nodes };
}

describe("workflow data from an earlier build", () => {
    it("reads and runs an IR version 1 revision as stored, with the contract it was compiled with", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
        registerWorkflow(runtime, {
            store, catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("This workflow calls no tools."); },
            authorizeParentNotification: async () => false,
            notifyParent: async () => { throw new Error("This workflow has no parent to notify."); },
            deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
            wakeBackstopMs: 500,
        });
        await runtime.start();
        try {
            const compiled = compileWorkflow(CONTRACT);
            expect(compiled.ir.irVersion).toBe(3);
            expect(compiled.ir.outputSchema).toBe("workflow.output");
            expect(compiled.ir.catchAll).toBeNull();
            const old = versionOneIr(compiled.ir);
            expect(old.outputSchema).toBeUndefined();
            expect(old.nodes.done.outputSchema).toBe("workflow.output");
            const oldIrText = canonicalJson(old);
            const oldIrSha256 = sha256Hex(oldIrText);

            // Decoding: version 1 has no root contract and no catch-all; version 2 states the contract
            // but no catch-all; version 3 must state both.
            expect(parseWorkflowIr(JSON.parse(oldIrText))).toMatchObject({ irVersion: 1, outputSchema: null, catchAll: null });
            const { catchAll: _noCatchAll, ...versionTwo } = { ...compiled.ir, irVersion: 2 };
            expect(parseWorkflowIr(versionTwo)).toMatchObject({ irVersion: 2, outputSchema: "workflow.output", catchAll: null });
            const { outputSchema: _dropped, ...withoutRoot } = compiled.ir;
            expect(() => parseWorkflowIr(withoutRoot)).toThrow("stored IR header is invalid");
            const { catchAll: _droppedCatchAll, ...withoutCatchAll } = compiled.ir;
            expect(() => parseWorkflowIr(withoutCatchAll)).toThrow("stored IR header is invalid");

            const id = randomUUID();
            const claimed = await catalog.createWorkflowSession(id, { parentSessionId: null, owner: null,
                creationConfig: { workflow: { apiVersion: WORKFLOW_API_VERSION, requestSha256: "earlier", operationId: "create" } } });
            expect(claimed.created).toBe(true);
            const stored = await store.createDefinition({
                workflowSessionId: id, parentSessionId: null, notifyParent: false, yaml: CONTRACT,
                compiled: { ...compiled, ir: old, irSha256: oldIrSha256 },
                actor: ACTOR, operationId: "create", requestSha256: "earlier", publish: true,
                start: { runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(id), inputsText: "{}", kvText: "{}", testAgentMode: null,
                    controllerVersion: WORKFLOW_CONTROLLER_VERSION },
                title: "Workflow: old-contract",
            });
            await dispatchWorkflowRun({ catalog, store, duroxideClient: client }, stored.receipt);
            const run = await until(async () => {
                const current = await store.readRun(stored.receipt.run.runId);
                return current && current.status !== "admitted" && current.status !== "running" ? current : null;
            }, "the run to finish");
            expect(run, JSON.stringify(run)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { n: 3 }, irSha256: oldIrSha256 });

            // The revision is unchanged: same IR text and hash, YAML not recompiled into it.
            const { rows } = await pool.query(`SELECT ir, ir_sha256 FROM "${env.cmsSchema}".workflow_revisions WHERE workflow_session_id = $1 AND revision = 1`, [id]);
            expect(rows[0]).toEqual({ ir: oldIrText, ir_sha256: oldIrSha256 });
        } finally {
            await runtime.shutdown(100);
            await catalog.close();
        }
    });

    it("continues a creation record of the current fingerprint, refuses another grant, and refuses a record this build cannot read", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const OWNER = { provider: "test", subject: "compat-owner" };
        const grant = (tools) => ({
            policy: "node-parent-tools-v1", parentSessionId: "", owner: OWNER, config: {}, capabilities: { selections: [] },
            tools: tools.map(name => ({ name, schemaHash: `${name}-schema` })), sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fp",
        });
        const DRAFT = CONTRACT.replace("old-contract", "compat-draft");
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
