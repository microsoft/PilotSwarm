/**
 * Workflow v2 data written by an earlier build stays usable after an upgrade,
 * on real PostgreSQL and the real durable runtime:
 *
 * - An immutable revision compiled to IR version 1 (no root outputSchema;
 *   each succeeded terminal carries the contract it was compiled with) or
 *   version 2 (no catchAll) is read and run as stored: its text and hash are
 *   not rewritten and its YAML is not recompiled.
 * - A creation claim or receipt written with an earlier create fingerprint
 *   (3a7ca2dd..547d1bf5: digest with owner and grant, version not stated;
 *   159bdce5: digest with the owner, no grant; c218d1bc..87549e10: no digest
 *   on the claim) is continued or replayed for the same request, without
 *   rewriting it, and refused for a request with another grant or owner.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_API_VERSION } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, jsonSha256, sha256Hex } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2, dispatchWorkflowV2Run } from "../../src/workflow/v2/service.ts";
import { registerWorkflowV2, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-compat-test" };

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
afterAll(async () => {
    await pool.end();
});

const CONTRACT = `
apiVersion: pilotswarm.dev/v2-draft
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

describe("workflow v2 data from an earlier build", () => {
    it("reads and runs an IR version 1 revision as stored, with the contract it was compiled with", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
        registerWorkflowV2(runtime, {
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
            const compiled = compileWorkflowV2(CONTRACT);
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
            const claimed = await catalog.createWorkflowSessionV2(id, { parentSessionId: null, owner: null,
                creationConfig: { workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256: "earlier", operationId: "create" } } });
            expect(claimed.created).toBe(true);
            const stored = await store.createDefinition({
                workflowSessionId: id, parentSessionId: null, notifyParent: false, yaml: CONTRACT,
                compiled: { ...compiled, ir: old, irSha256: oldIrSha256 },
                actor: ACTOR, operationId: "create", requestSha256: "earlier", publish: true,
                start: { runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(id), inputsText: "{}", kvText: "{}", testAgentMode: null },
                title: "Workflow: old-contract",
            });
            await dispatchWorkflowV2Run({ catalog, store, duroxideClient: client }, stored.receipt);
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

    it("continues and replays creation records of earlier fingerprints without rewriting them, and refuses another grant or owner", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const OWNER = { provider: "test", subject: "compat-owner" };
        const OTHER = { provider: "test", subject: "someone-else" };
        const grant = (tools) => ({
            policy: "node-parent-tools-v1", parentSessionId: "", owner: OWNER, config: {}, capabilities: { selections: [] },
            tools: tools.map(name => ({ name, schemaHash: `${name}-schema` })), sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fp",
        });
        const DRAFT = CONTRACT.replace("old-contract", "compat-draft");
        const compiled = compileWorkflowV2(DRAFT);
        // The create digests exactly as those builds computed them (a draft: no publish, no start, notify on).
        const content = (parentSessionId) => ({ kind: "create", yamlSha256: compiled.yamlSha256, publish: false, start: null, parentSessionId, notifyParent: true });
        const v1 = (parentSessionId) => jsonSha256(content(parentSessionId));
        const v2 = (parentSessionId, owner) => jsonSha256({ ...content(parentSessionId), owner: { provider: owner.provider, subject: owner.subject } });
        // 3a7ca2dd..547d1bf5 (service.ts, createWorkflowV2): owner and grant digest, marker without a version.
        const v3 = (parentSessionId, owner, binding) => jsonSha256({ ...content(parentSessionId), owner: { provider: owner.provider, subject: owner.subject },
            binding: binding ? jsonSha256(JSON.parse(JSON.stringify(binding))) : null });
        const host = { catalog, store, duroxideClient: { startOrchestrationVersioned: async () => { throw new Error("A draft is never dispatched."); } } };
        const create = (id, parentSessionId, owner, binding) => createWorkflowV2(host, {
            workflowSessionId: id, parentSessionId, owner, yaml: DRAFT, actor: ACTOR, operationId: "create", ...(binding ? { binding } : {}),
        });
        const receiptRow = async (id) => (await pool.query(
            `SELECT request_sha256, receipt FROM "${env.cmsSchema}".workflow_operations WHERE workflow_session_id = $1 AND operation_id = 'create'`, [id])).rows[0] ?? null;
        try {
            const parentId = randomUUID();
            await catalog.createSession(parentId, { owner: OWNER });
            const g1 = { ...grant(["read_facts"]), parentSessionId: parentId };
            const g2 = { ...grant(["read_facts", "store_fact"]), parentSessionId: parentId };

            // 159bdce5: a claim with the version 2 digest and a first grant, interrupted before its definition.
            const interrupted = randomUUID();
            const marker159 = { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256: v2(parentId, OWNER), operationId: "create" };
            expect(await catalog.createWorkflowSessionV2(interrupted, { parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: marker159, workflowToolBinding: g1 } })).toEqual({ created: true });
            await expect(create(interrupted, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await store.readDefinition(interrupted)).toBeNull();
            const continued = await create(interrupted, parentId, OWNER, g1);
            expect(continued.replayed).toBe(false);
            expect(continued.receipt).toMatchObject({ state: "draft", revision: 1 });
            const replayed = await create(interrupted, parentId, OWNER, g1);
            expect(replayed).toEqual({ receipt: continued.receipt, replayed: true });
            const kept = await catalog.getSessionCreationConfig(interrupted);
            expect(kept.workflowV2).toEqual(marker159);
            expect(kept.workflowToolBinding).toEqual(g1);

            // 159bdce5: a draft whose receipt carries the version 2 digest.
            const draft159 = randomUUID();
            await catalog.createWorkflowSessionV2(draft159, { parentSessionId: parentId, owner: OWNER, creationConfig: { workflowV2: marker159 } });
            const stored159 = await store.createDefinition({ workflowSessionId: draft159, parentSessionId: parentId, notifyParent: true, yaml: DRAFT,
                compiled, actor: ACTOR, operationId: "create", requestSha256: v2(parentId, OWNER), publish: false, start: null, title: "Workflow: compat-draft" });
            const before159 = await receiptRow(draft159);
            expect(before159.request_sha256).toBe(v2(parentId, OWNER));
            expect(await create(draft159, parentId, OWNER, null)).toEqual({ receipt: stored159.receipt, replayed: true });
            await expect(create(draft159, parentId, OWNER, g1)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await receiptRow(draft159)).toEqual(before159);
            expect((await catalog.getSessionCreationConfig(draft159)).workflowV2).toEqual(marker159);

            // c218d1bc..87549e10: a claim with no digest (catalog creation) and a receipt with the version 1 digest.
            const draft875 = randomUUID();
            await catalog.createSession(draft875, { sessionKind: "workflow", parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION } } });
            const stored875 = await store.createDefinition({ workflowSessionId: draft875, parentSessionId: parentId, notifyParent: true, yaml: DRAFT,
                compiled, actor: ACTOR, operationId: "create", requestSha256: v1(parentId), publish: false, start: null, title: "Workflow: compat-draft" });
            const before875 = await receiptRow(draft875);
            expect(await create(draft875, parentId, OWNER, null)).toEqual({ receipt: stored875.receipt, replayed: true });
            await expect(create(draft875, parentId, OTHER, null)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            await expect(create(draft875, parentId, OWNER, g1)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await receiptRow(draft875)).toEqual(before875);

            // 3a7ca2dd..547d1bf5: an interrupted claim and a complete draft whose marker holds the
            // version 3 digest without stating it.
            const interrupted547 = randomUUID();
            const marker547 = { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256: v3(parentId, OWNER, g1), operationId: "create" };
            expect(await catalog.createWorkflowSessionV2(interrupted547, { parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: marker547, workflowToolBinding: g1 } })).toEqual({ created: true });
            await expect(create(interrupted547, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            await expect(create(interrupted547, parentId, OTHER, g1)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await store.readDefinition(interrupted547)).toBeNull();
            const continued547 = await create(interrupted547, parentId, OWNER, g1);
            expect(continued547.replayed).toBe(false);
            expect(await create(interrupted547, parentId, OWNER, g1)).toEqual({ receipt: continued547.receipt, replayed: true });
            expect((await catalog.getSessionCreationConfig(interrupted547)).workflowV2).toEqual(marker547);

            const draft547 = randomUUID();
            await catalog.createWorkflowSessionV2(draft547, { parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: { ...marker547 }, workflowToolBinding: g1 } });
            const stored547 = await store.createDefinition({ workflowSessionId: draft547, parentSessionId: parentId, notifyParent: true, yaml: DRAFT,
                compiled, actor: ACTOR, operationId: "create", requestSha256: v3(parentId, OWNER, g1), publish: false, start: null, title: "Workflow: compat-draft" });
            const before547 = await receiptRow(draft547);
            expect(before547.request_sha256).toBe(v3(parentId, OWNER, g1));
            expect(await create(draft547, parentId, OWNER, g1)).toEqual({ receipt: stored547.receipt, replayed: true });
            await expect(create(draft547, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            await expect(create(draft547, parentId, OWNER, null)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await receiptRow(draft547)).toEqual(before547);
            expect((await catalog.getSessionCreationConfig(draft547)).workflowV2).toEqual(marker547);

            // The current fingerprint: the marker states its version, and a changed grant is another request.
            const current = randomUUID();
            await create(current, parentId, OWNER, g1);
            expect((await catalog.getSessionCreationConfig(current)).workflowV2).toMatchObject({ fingerprint: 3, operationId: "create" });
            await expect(create(current, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect((await create(current, parentId, OWNER, g1)).replayed).toBe(true);
        } finally { await catalog.close(); }
    });
});
