import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { branchScopeId } from "../../src/workflow/controller/runtime.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import {
    WORKFLOW_RERUN_MAX_COPY_BYTES,
    buildRerunResume,
    mapRerunExecutions,
    mapRerunSuppliedExecution,
    partitionRerunVisits,
} from "../../src/workflow/rerun.ts";
import { WorkflowStoreError, nodeExecutionIdFor } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "user", provider: "entra", subject: "owner-sub-1", name: "Owner" };
const OTHER_USER = { kind: "user", provider: "entra", subject: "other-sub-2", name: "Other" };

function pgPoolConfig(connectionString) {
    const parsed = new URL(connectionString);
    const sslMode = (parsed.searchParams.get("sslmode") ?? "").toLowerCase();
    const relaxSsl = sslMode === "require" || sslMode === "prefer";
    if (relaxSsl) parsed.searchParams.delete("sslmode");
    return {
        connectionString: parsed.toString(),
        max: 4,
        ...(relaxSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    };
}

const SIMPLE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-store-wf, version: "1.0.0" }
limits: { maxNodeExecutions: 50 }
initial: step1
states:
  step1:
    type: script
    source: 'await setResult("ok", { v: 1 });'
    transition: { next: { ok: step2 } }
  step2:
    type: script
    source: 'await setResult("ok", { v: 2 });'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

async function seedEndedSourceWorkflow(client, opts = {}) {
    const store = client._catalog.workflowStore();
    const pool = new pg.Pool(pgPoolConfig(getEnv().store));
    const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
    const ownerId = opts.ownerId ?? randomUUID();
    const wfId = randomUUID();
    const runId = randomUUID();
    const yaml = opts.yaml ?? SIMPLE_YAML;
    const compiled = compileWorkflow(yaml);
    if (!compiled.valid) throw new Error(JSON.stringify(compiled.diagnostics));
    try {
        if (!opts.ownerId) {
            await client._catalog.createSession(ownerId);
        }
        await client._catalog.createWorkflowSession(wfId, {
            parentSessionId: ownerId,
            title: "source-wf",
            creationConfig: { workflow: { name: compiled.name, version: compiled.version } },
        });
        const created = await store.createDefinition({
            workflowSessionId: wfId,
            parentSessionId: ownerId,
            notifyParent: true,
            yaml,
            compiled,
            actor: ACTOR,
            operationId: `create-${wfId}`,
            requestSha256: sha256Hex(`create-${wfId}`),
            publish: true,
            start: {
                runId,
                mode: "live",
                inputsText: canonicalJson(opts.inputs ?? {}),
                kvText: canonicalJson(opts.kv ?? {}),
                controllerInstanceId: `session-${wfId}`,
                controllerVersion: "1.3.0",
                testAgentMode: null,
            },
            title: "source-wf",
        });
        const visits = opts.visits ?? [
            { nodeId: "step1", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: { v: 1 }, input: {} },
            { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "ok", outcome: "execution_failed", resultKind: "runtime_error", error: { code: "execution_failed", message: "boom" }, input: { v: 1 } },
        ];
        let prevRootId = null;
        const ids = {};
        const baseMs = Date.now() - 60_000;
        for (let i = 0; i < visits.length; i += 1) {
            const v = visits[i];
            const scopeId = v.scopeId ?? "root";
            const id = v.nodeExecutionId ?? nodeExecutionIdFor(runId, scopeId, v.nodeId, v.ordinal);
            const pred = v.predecessorId !== undefined ? v.predecessorId : (scopeId === "root" ? prevRootId : null);
            const inputText = canonicalJson(v.input ?? {});
            const carryText = v.carry !== undefined ? canonicalJson(v.carry) : null;
            const outputText = v.resultKind === "business" ? canonicalJson(v.output ?? null) : null;
            const errorText = v.resultKind === "runtime_error" ? canonicalJson(v.error ?? { code: v.outcome ?? "error", message: "err" }) : null;
            const enteredAt = new Date(baseMs + i * 1000).toISOString();
            const completedAt = new Date(baseMs + i * 1000 + 500).toISOString();
            await pool.query(
                `INSERT INTO ${s}.workflow_node_executions (
                    node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                    input, input_sha256, carry_snapshot, state, outcome, result_kind, output, error, winner,
                    effect_attempts, entered_at, completed_at, kv_revision, deadline_at,
                    reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id,
                    supplied_actor, supplied_note, supplied_at
                 ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8,
                    $9, $10, $11, $12, $13, $14, $15, $16, $17,
                    $18, $19::timestamptz, $20::timestamptz, $21, NULL,
                    $22, $23, $24, $25::timestamptz,
                    $26, $27, $28, $29, $30, $31::timestamptz
                 )`,
                [
                    id, runId, scopeId, pred, v.nodeId, v.ordinal, v.nodeType, v.arrivalRoute ?? null,
                    inputText, sha256Hex(inputText), carryText, v.state ?? "completed", v.outcome ?? "ok", v.resultKind ?? "business",
                    outputText, errorText, v.winner ?? "effect",
                    v.effectAttempts ?? 1, enteredAt, completedAt, v.kvRevision ?? 1,
                    v.reusedFromExecutionId ?? null, v.reusedFromRunId ?? null, v.reusedFromWorkflowSessionId ?? null, v.reusedAt ?? null,
                    v.suppliedFromExecutionId ?? null, v.suppliedFromRunId ?? null, v.suppliedFromWorkflowSessionId ?? null,
                    v.suppliedActor ? canonicalJson(v.suppliedActor) : null, v.suppliedNote ?? null, v.suppliedAt ?? null,
                ],
            );
            ids[`${v.nodeId}#${v.ordinal}${scopeId === "root" ? "" : `@${scopeId}`}`] = id;
            if (scopeId === "root") prevRootId = id;
        }
        await pool.query(
            `UPDATE ${s}.workflow_runs SET status = $2, finished_at = now(), updated_at = now() WHERE run_id = $1`,
            [runId, opts.status ?? "failed"],
        );
        return { ownerId, wfId, runId, compiled, receipt: created.receipt, ids };
    } finally {
        await pool.end();
    }
}

describe("Task 4a: WorkflowStore rerun keys, bare-shell lock re-check, atomic copy/supply & lock races", () => {
    it("listRerunKeys computes byteLength, carryByteLength, multi-gen G-R1 spawn flags (R2-S5), summarizeRerunCarriedInbox (R2-S6), and readDroppedVisitPreviews", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const store = client._catalog.workflowStore();
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            try {
                // Multi-generation #1 -> #2 -> #3: child started in #1 (run1), cancelled by parent-end:<run1>, reused in #2 (run2).
                const run1Id = randomUUID();
                const wf1Id = randomUUID();
                const nx1Spawn = nodeExecutionIdFor(run1Id, "root", "sp", 1);
                const childWfId = randomUUID();

                const src = await seedEndedSourceWorkflow(client, {
                    visits: [
                        { nodeId: "step1", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: { big: "a".repeat(2048) }, carry: { round: 1 } },
                        {
                            nodeId: "sp", ordinal: 1, nodeType: "spawn", arrivalRoute: "ok", outcome: "started", resultKind: "business",
                            output: { workflowId: childWfId },
                            reusedFromExecutionId: nx1Spawn, reusedFromRunId: run1Id, reusedFromWorkflowSessionId: wf1Id,
                            reusedAt: new Date().toISOString(),
                        },
                        { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "started", outcome: "execution_failed", resultKind: "runtime_error", output: null, error: { code: "execution_failed", message: "boom" } },
                    ],
                });

                // Record parent-end:<run1Id> operation on childWfId (multi-gen R2-S5!)
                await client._catalog.createWorkflowSession(childWfId, { parentSessionId: src.ownerId, title: "child-wf" });
                await pool.query(
                    `INSERT INTO ${s}.workflow_definitions (workflow_session_id, parent_session_id, api_version, state, current_revision, published_revision, published_yaml_sha256, published_ir_sha256) VALUES ($1, $2, 'pilotswarm.dev/v1', 'published', 1, 1, 'yh', 'ih')`,
                    [childWfId, src.ownerId],
                );
                await pool.query(
                    `INSERT INTO ${s}.workflow_operations (workflow_session_id, operation_id, kind, request_sha256, receipt) VALUES ($1, $2, 'cancel', 'h', '{}')`,
                    [childWfId, `parent-end:${run1Id}`],
                );

                // Seed one waiting inbox message before cut and one message accepted after cut
                await pool.query(
                    `INSERT INTO ${s}.workflow_inbox (message_id, workflow_session_id, run_id, sender_session_id, operation_id, contract, correlation, payload, request_sha256, accepted_at, expires_at)
                     VALUES
                       ($1, $2, $3, $4, 'op-msg-1', 'HumanNote@1', '{}', '{"text":"hi"}', 'r1', now() - interval '120 seconds', now() + interval '1 hour'),
                       ($5, $2, $3, $4, 'op-msg-2', 'LateNote@1', '{}', '{"text":"late"}', 'r2', now() + interval '10 seconds', now() + interval '1 hour')`,
                    [`msg-${randomUUID()}`, src.wfId, src.runId, src.ownerId, `msg-${randomUUID()}`],
                );

                const keys = await store.listRerunKeys(src.runId);
                expect(keys.length).toBe(3);
                const kStep1 = keys.find(k => k.nodeId === "step1");
                expect(kStep1.hasCarry).toBe(true);
                expect(kStep1.carryByteLength).toBe(canonicalJson({ round: 1 }).length);
                expect(kStep1.carrySha256).toBe(sha256Hex(canonicalJson({ round: 1 })));
                expect(kStep1.byteLength).toBeGreaterThan(2048);

                const kSpawn = keys.find(k => k.nodeId === "sp");
                expect(kSpawn.spawnChildWorkflowId).toBe(childWfId);
                expect(kSpawn.spawnChildCancelledBySourceEnd, "R2-S5: COALESCE(reused_from_run_id, run_id) detects parent-end:<run1>").toBe(true);
                expect(kSpawn.spawnChildHasNotice).toBe(false);

                // R2-S6: summarizeRerunCarriedInbox returns { count, contracts } without reading bodies (M-3C: the kept source
                // visits are explicit; here those of a run_again of step2).
                const carried = await store.summarizeRerunCarriedInbox(src.runId, new Date(), [], [kStep1.nodeExecutionId, kSpawn.nodeExecutionId]);
                expect(carried).toEqual({ count: 1, contracts: ["HumanNote@1"] });

                // Dropped previews clip to 300 chars
                const previews = await store.readDroppedVisitPreviews(src.runId, [kStep1.nodeExecutionId]);
                expect(previews.get(kStep1.nodeExecutionId)?.length).toBe(300);
            } finally {
                await pool.end();
            }
        });
    });

    it("atomically copies reused top-level + parallel lane visits, writes supplied V' (including 0 reused & #3->#4 preservation), leaves #2 untouched, and enforces 256 MiB cap", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const store = client._catalog.workflowStore();
            const parId = nodeExecutionIdFor("tmp", "root", "fan", 1);
            const src = await seedEndedSourceWorkflow(client, {
                visits: [
                    { nodeId: "step1", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: { a: 1 } },
                    { nodeId: "fan", ordinal: 1, nodeType: "parallel", arrivalRoute: "ok", outcome: "joined", resultKind: "business", output: [{ ok: true }], nodeExecutionId: parId },
                    { scopeId: branchScopeId(parId, 0), predecessorId: parId, nodeId: "worker", ordinal: 1, nodeType: "script", arrivalRoute: "@branch", outcome: "ok", resultKind: "business", output: { ok: true } },
                    { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "joined", outcome: "timed_out", resultKind: "runtime_error", error: { code: "timed_out", message: "slow" } },
                ],
            });
            const srcKeys = await store.listRerunKeys(src.runId);
            const step2Key = srcKeys.find(k => k.nodeId === "step2");

            // 1. Supply mode on step2 with 3 reused visits (2 root + 1 lane)
            const wf3Id = randomUUID();
            const run3Id = randomUUID();
            const part3 = partitionRerunVisits(srcKeys, step2Key.nodeExecutionId, "supply");
            const mapped3 = mapRerunExecutions(run3Id, part3.reused);
            const mappedV3 = mapRerunSuppliedExecution(run3Id, step2Key, mapped3);
            const suppliedAt3 = new Date();
            const outputText3 = "null"; // N4: omitted output -> 'null' JSON text
            const resume3 = buildRerunResume({
                mode: "supply", chosen: step2Key, mappedPredecessorId: mappedV3.newPredecessorId,
                cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256,
                supplied: {
                    mappedSuppliedId: mappedV3.newId, outcome: "ok", outputSha256: sha256Hex(outputText3),
                    note: "verified via az cli", at: suppliedAt3.toISOString(), nextStateId: "done", nextOrdinal: 1,
                },
            });

            await client._catalog.createWorkflowSession(wf3Id, { parentSessionId: src.ownerId, title: "rerun-3" });
            await store.createDefinition({
                workflowSessionId: wf3Id,
                parentSessionId: src.ownerId,
                notifyParent: true,
                yaml: SIMPLE_YAML,
                compiled: src.compiled,
                actor: ACTOR,
                operationId: `rerun-3-${wf3Id}`,
                requestSha256: sha256Hex(`rerun-3-${wf3Id}`),
                publish: true,
                start: {
                    runId: run3Id, mode: "live", inputsText: "{}", kvText: "{}",
                    controllerInstanceId: `session-${wf3Id}`, controllerVersion: "1.3.0", testAgentMode: null,
                },
                title: "rerun-3",
                rerun: {
                    sourceWorkflowSessionId: src.wfId,
                    sourceRunId: src.runId,
                    fromExecutionId: step2Key.nodeExecutionId,
                    mode: "supply",
                    resume: resume3,
                    actor: ACTOR,
                    mapped: mapped3,
                    unwalkedCount: part3.unwalkedCount,
                    supplied: {
                        newExecutionId: mappedV3.newId,
                        newPredecessorId: mappedV3.newPredecessorId,
                        sourceExecutionId: step2Key.nodeExecutionId,
                        outcome: "ok",
                        outputText: outputText3,
                        note: "verified via az cli",
                        at: suppliedAt3,
                    },
                    cutKvRevision: 1,
                    inboxCutAt: new Date(),
                    reusedSpawnChildIds: [],
                    approvalOwnerCheck: null,
                },
            });

            const run3 = await store.readRun(run3Id);
            expect(run3.rerunOfWorkflowSessionId).toBe(src.wfId);
            expect(run3.rerunOfRunId).toBe(src.runId);
            expect(run3.rerunMode).toBe("supply");
            expect(run3.rerunReused).toBe(3);
            expect(run3.rerunUnwalked).toBe(1);
            expect(run3.rerunResumedAt).toBeNull();
            expect(run3.rerunResume?.mode).toBe("supply");

            const suppliedNode = await store.readNodeExecution(mappedV3.newId);
            expect(suppliedNode.state).toBe("completed");
            expect(suppliedNode.winner).toBe("supplied");
            expect(suppliedNode.resultKind).toBe("business");
            expect(suppliedNode.effectAttempts).toBe(0);
            expect(suppliedNode.output).toBeNull();
            expect(suppliedNode.hasOutput).toBe(true);
            expect(suppliedNode.suppliedFromExecutionId).toBe(step2Key.nodeExecutionId);
            expect(suppliedNode.suppliedNote).toBe("verified via az cli");
            expect(suppliedNode.reusedFromExecutionId).toBeNull();

            // Source #2 is completely untouched
            const srcAfter = await store.readNodeExecution(step2Key.nodeExecutionId);
            expect(srcAfter.outcome).toBe("timed_out");
            expect(srcAfter.winner).toBe("effect");

            // 2. Generation #3 -> #4 copies #3's supplied row preserving supplied_* AND setting flattened reused_from_*
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            try {
                await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [run3Id]);
            } finally {
                await pool.end();
            }
            const run3Keys = await store.listRerunKeys(run3Id);
            const wf4Id = randomUUID();
            const run4Id = randomUUID();
            const mapped4 = mapRerunExecutions(run4Id, run3Keys); // copy all 4 rows (continue after supplied step2)
            const resume4 = buildRerunResume({
                mode: "continue", chosen: run3Keys.find(k => k.nodeId === "step2"),
                mappedPredecessorId: mapped4.find(m => m.source.nodeId === "step2").newId,
                cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256,
            });
            await client._catalog.createWorkflowSession(wf4Id, { parentSessionId: src.ownerId, title: "rerun-4" });
            await store.createDefinition({
                workflowSessionId: wf4Id, parentSessionId: src.ownerId, notifyParent: true,
                yaml: SIMPLE_YAML, compiled: src.compiled, actor: ACTOR,
                operationId: `rerun-4-${wf4Id}`, requestSha256: sha256Hex(`rerun-4-${wf4Id}`),
                publish: true,
                start: { runId: run4Id, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wf4Id}`, controllerVersion: "1.3.0", testAgentMode: null },
                title: "rerun-4",
                rerun: {
                    sourceWorkflowSessionId: wf3Id, sourceRunId: run3Id,
                    fromExecutionId: mappedV3.newId, mode: "continue", resume: resume4, actor: ACTOR,
                    mapped: mapped4, unwalkedCount: 1, supplied: null,
                    cutKvRevision: 1, inboxCutAt: new Date(), reusedSpawnChildIds: [], approvalOwnerCheck: null,
                },
            });
            const gen4Step1 = await store.readNodeExecution(mapped4.find(m => m.source.nodeId === "step1").newId);
            expect(gen4Step1.reusedFromWorkflowSessionId, "COALESCE origin flattens to #2").toBe(src.wfId);
            const gen4Supplied = await store.readNodeExecution(mapped4.find(m => m.source.nodeId === "step2").newId);
            expect(gen4Supplied.reusedFromExecutionId).toBe(mappedV3.newId);
            expect(gen4Supplied.reusedFromWorkflowSessionId).toBe(wf3Id);
            expect(gen4Supplied.suppliedFromExecutionId).toBe(step2Key.nodeExecutionId);
            expect(gen4Supplied.suppliedNote).toBe("verified via az cli");
            expect(gen4Supplied.winner).toBe("supplied");

            // 3. listWorkflowReruns finds #3 under #2
            const reruns = await store.listWorkflowReruns(src.wfId);
            expect(reruns.some(r => r.workflowSessionId === wf3Id && r.runId === run3Id)).toBe(true);

            // 4. Supply on visit 1 (0 reused visits) succeeds
            const step1Key = srcKeys.find(k => k.nodeId === "step1");
            const wfVisit1 = randomUUID();
            const runVisit1 = randomUUID();
            const mappedV1 = mapRerunSuppliedExecution(runVisit1, step1Key, []);
            const resumeV1 = buildRerunResume({
                mode: "supply", chosen: step1Key, mappedPredecessorId: null,
                cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256,
                supplied: { mappedSuppliedId: mappedV1.newId, outcome: "ok", outputSha256: sha256Hex("{}"), note: "visit 1 supplied", at: new Date().toISOString(), nextStateId: "step2", nextOrdinal: 1 },
            });
            await client._catalog.createWorkflowSession(wfVisit1, { parentSessionId: src.ownerId, title: "rerun-v1" });
            await store.createDefinition({
                workflowSessionId: wfVisit1, parentSessionId: src.ownerId, notifyParent: true,
                yaml: SIMPLE_YAML, compiled: src.compiled, actor: ACTOR,
                operationId: `rerun-v1-${wfVisit1}`, requestSha256: sha256Hex(`rerun-v1-${wfVisit1}`),
                publish: true,
                start: { runId: runVisit1, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wfVisit1}`, controllerVersion: "1.3.0", testAgentMode: null },
                title: "rerun-v1",
                rerun: {
                    sourceWorkflowSessionId: src.wfId, sourceRunId: src.runId,
                    fromExecutionId: step1Key.nodeExecutionId, mode: "supply", resume: resumeV1, actor: ACTOR,
                    mapped: [], unwalkedCount: 0,
                    supplied: { newExecutionId: mappedV1.newId, newPredecessorId: null, sourceExecutionId: step1Key.nodeExecutionId, outcome: "ok", outputText: "{}", note: "visit 1 supplied", at: new Date() },
                    cutKvRevision: 1, inboxCutAt: new Date(), reusedSpawnChildIds: [], approvalOwnerCheck: null,
                },
            });
            const rV1 = await store.readRun(runVisit1);
            expect(rV1.rerunReused).toBe(0);
            expect(rV1.rerunUnwalked).toBe(0);

            // 5. 256 MiB cap enforced inside transaction via configurable limit override
            const wfBig = randomUUID();
            const runBig = randomUUID();
            await client._catalog.createWorkflowSession(wfBig, { parentSessionId: src.ownerId, title: "rerun-big" });
            let capErr = null;
            try {
                await store.createDefinition({
                    workflowSessionId: wfBig, parentSessionId: src.ownerId, notifyParent: true,
                    yaml: SIMPLE_YAML, compiled: src.compiled, actor: ACTOR,
                    operationId: `rerun-big-${wfBig}`, requestSha256: sha256Hex(`rerun-big-${wfBig}`),
                    publish: true,
                    start: { runId: runBig, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wfBig}`, controllerVersion: "1.3.0", testAgentMode: null },
                    title: "rerun-big",
                    rerun: {
                        sourceWorkflowSessionId: src.wfId, sourceRunId: src.runId,
                        fromExecutionId: step2Key.nodeExecutionId, mode: "run_again",
                        resume: buildRerunResume({ mode: "run_again", chosen: step2Key, mappedPredecessorId: mapped3[1].newId, cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256 }),
                        actor: ACTOR, mapped: mapRerunExecutions(runBig, part3.reused), unwalkedCount: 1,
                        supplied: null, cutKvRevision: 1, inboxCutAt: new Date(), reusedSpawnChildIds: [],
                        approvalOwnerCheck: null, maxCopyBytes: 10,
                    },
                });
            } catch (err) {
                capErr = err;
            }
            expect(capErr).toBeInstanceOf(WorkflowStoreError);
            expect(capErr.code).toBe("RERUN_TOO_LARGE");
            expect(await store.readRun(runBig)).toBeNull();
        });
    });

    it("50-interleaving races: (A) source deleter vs rerun copy (0 deadlocks) and (B) Sweeper bare-shell delete vs late admission (R2-M1/R2-S1)", { timeout: testTime.ms(240_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const store = client._catalog.workflowStore();
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            try {
                // Race A: 25 interleavings of source deleter (sweeperSoftDelete / softDeleteSession) vs rerun createDefinition
                let copyWonA = 0;
                let delWonA = 0;
                for (let i = 0; i < 25; i += 1) {
                    const src = await seedEndedSourceWorkflow(client);
                    const srcKeys = await store.listRerunKeys(src.runId);
                    const step2Key = srcKeys.find(k => k.nodeId === "step2");
                    const part = partitionRerunVisits(srcKeys, step2Key.nodeExecutionId, "run_again");
                    const wf3Id = randomUUID();
                    const run3Id = randomUUID();
                    const mapped = mapRerunExecutions(run3Id, part.reused);
                    await client._catalog.createWorkflowSession(wf3Id, { parentSessionId: src.ownerId, title: `raceA-${i}` });
                    const ver = await store.sweeperRowVersion(src.wfId);
                    const copyP = store.createDefinition({
                        workflowSessionId: wf3Id, parentSessionId: src.ownerId, notifyParent: true,
                        yaml: SIMPLE_YAML, compiled: src.compiled, actor: ACTOR,
                        operationId: `raceA-op-${i}`, requestSha256: sha256Hex(`raceA-op-${i}`),
                        publish: true,
                        start: { runId: run3Id, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wf3Id}`, controllerVersion: "1.3.0", testAgentMode: null },
                        title: `raceA-${i}`,
                        rerun: {
                            sourceWorkflowSessionId: src.wfId, sourceRunId: src.runId,
                            fromExecutionId: step2Key.nodeExecutionId, mode: "run_again",
                            resume: buildRerunResume({ mode: "run_again", chosen: step2Key, mappedPredecessorId: mapped[0].newId, cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256 }),
                            actor: ACTOR, mapped, unwalkedCount: 0, supplied: null,
                            cutKvRevision: 1, inboxCutAt: new Date(), reusedSpawnChildIds: [], approvalOwnerCheck: null,
                        },
                    }).then(() => ({ ok: true })).catch(err => ({ ok: false, err }));
                    const delP = (i % 2 === 0
                        ? store.sweeperSoftDelete({ sessionId: src.wfId, version: ver.version, cascade: false, orchestrationNotFound: false })
                        : client._catalog.softDeleteSession(src.wfId)
                    ).then(res => ({ ok: true, res })).catch(err => ({ ok: false, err }));

                    const [cRes, dRes] = await Promise.all([copyP, delP]);
                    expect(dRes.err?.code, "no PostgreSQL 40P01 deadlock on deleter").not.toBe("40P01");
                    expect(cRes.err?.code, "no PostgreSQL 40P01 deadlock on copy").not.toBe("40P01");
                    if (cRes.ok) {
                        copyWonA += 1;
                        expect(await store.readRun(run3Id)).not.toBeNull();
                    } else {
                        delWonA += 1;
                        expect(cRes.err).toBeInstanceOf(WorkflowStoreError);
                        expect(cRes.err.code).toBe("RERUN_SOURCE_GONE");
                        expect(await store.readRun(run3Id)).toBeNull();
                    }
                }
                expect(copyWonA + delWonA).toBe(25);

                // Race B (R2-M1 & R2-S1): 25 interleavings of Sweeper bare-shell delete vs late admission on #3
                let admitWonB = 0;
                let sweepWonB = 0;
                const sharedSrc = await seedEndedSourceWorkflow(client);
                const sharedKeys = await store.listRerunKeys(sharedSrc.runId);
                const sharedStep2 = sharedKeys.find(k => k.nodeId === "step2");
                const sharedPart = partitionRerunVisits(sharedKeys, sharedStep2.nodeExecutionId, "run_again");
                for (let i = 0; i < 25; i += 1) {
                    const wf3Id = randomUUID();
                    const run3Id = randomUUID();
                    const mapped = mapRerunExecutions(run3Id, sharedPart.reused);
                    await client._catalog.createWorkflowSession(wf3Id, { parentSessionId: sharedSrc.ownerId, title: `raceB-${i}` });
                    const ver = await store.sweeperRowVersion(wf3Id);
                    expect(ver).not.toBeNull();

                    const admitP = store.createDefinition({
                        workflowSessionId: wf3Id, parentSessionId: sharedSrc.ownerId, notifyParent: true,
                        yaml: SIMPLE_YAML, compiled: sharedSrc.compiled, actor: ACTOR,
                        operationId: `raceB-op-${i}`, requestSha256: sha256Hex(`raceB-op-${i}`),
                        publish: true,
                        start: { runId: run3Id, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wf3Id}`, controllerVersion: "1.3.0", testAgentMode: null },
                        title: `raceB-${i}`,
                        rerun: {
                            sourceWorkflowSessionId: sharedSrc.wfId, sourceRunId: sharedSrc.runId,
                            fromExecutionId: sharedStep2.nodeExecutionId, mode: "run_again",
                            resume: buildRerunResume({ mode: "run_again", chosen: sharedStep2, mappedPredecessorId: mapped[0].newId, cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: sharedSrc.compiled.irSha256, targetIrSha256: sharedSrc.compiled.irSha256 }),
                            actor: ACTOR, mapped, unwalkedCount: 0, supplied: null,
                            cutKvRevision: 1, inboxCutAt: new Date(), reusedSpawnChildIds: [], approvalOwnerCheck: null,
                        },
                    }).then(() => ({ ok: true })).catch(err => ({ ok: false, err }));

                    const sweepP = store.sweeperSoftDelete({
                        sessionId: wf3Id, version: ver.version, cascade: false, orchestrationNotFound: true, bareClaimShell: true,
                    });

                    const [aRes, sRes] = await Promise.all([admitP, sweepP]);
                    const { rows: sessRows } = await pool.query(`SELECT deleted_at FROM ${s}.sessions WHERE session_id = $1`, [wf3Id]);
                    const runRow = await store.readRun(run3Id);
                    const defRow = await store.readDefinition(wf3Id);

                    if (aRes.ok) {
                        admitWonB += 1;
                        // Sweeper MUST have refused once admission committed, and session MUST NOT be deleted!
                        expect("refused" in sRes).toBe(true);
                        expect(sessRows[0].deleted_at).toBeNull();
                        expect(runRow).not.toBeNull();
                    } else {
                        sweepWonB += 1;
                        // Losing admission MUST fail with WORKFLOW_DELETED and write ZERO rows!
                        expect(aRes.err).toBeInstanceOf(WorkflowStoreError);
                        expect(aRes.err.code).toBe("WORKFLOW_DELETED");
                        expect("deleted" in sRes).toBe(true);
                        expect(sessRows[0].deleted_at).not.toBeNull();
                        expect(runRow).toBeNull();
                        expect(defRow).toBeNull();
                    }
                }
                expect(admitWonB + sweepWonB).toBe(25);
                // Sanity check R2-S1 under-lock re-check: even with a current xmin, bareClaimShell refuses if a definition exists!
                const wfDraft = randomUUID();
                await client._catalog.createWorkflowSession(wfDraft, { parentSessionId: sharedSrc.ownerId, title: "draft-guard" });
                await store.createDefinition({
                    workflowSessionId: wfDraft, parentSessionId: sharedSrc.ownerId, notifyParent: true,
                    yaml: SIMPLE_YAML, compiled: sharedSrc.compiled, actor: ACTOR,
                    operationId: `draft-${wfDraft}`, requestSha256: sha256Hex(`draft-${wfDraft}`),
                    publish: false, start: null, title: "draft-guard",
                });
                const draftVer = await store.sweeperRowVersion(wfDraft);
                const draftSweep = await store.sweeperSoftDelete({
                    sessionId: wfDraft, version: draftVer.version, cascade: false, orchestrationNotFound: true, bareClaimShell: true,
                });
                expect("refused" in draftSweep && draftSweep.refused.status === "Changed").toBe(true);
            } finally {
                await pool.end();
            }
        });
    });
});

describe("Task 4b: KV revisions 1..R (+ vars R+1), copyRerunInboxIn (TTL restart + 180 KiB child notice), and state_reused/state_supplied events", () => {
    it("copies KV 1..R + optional vars R+1, carries waiting inbox & 180 KiB WorkflowEnded@1 notice with restarted TTL, and records workflow.state_reused + workflow.state_supplied events", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const store = client._catalog.workflowStore();
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            try {
                const childWfId = randomUUID();
                const src = await seedEndedSourceWorkflow(client, {
                    kv: { a: 1 },
                    visits: [
                        { nodeId: "step1", ordinal: 1, nodeType: "script", outcome: "ok", resultKind: "business", output: { ok: 1 }, kvRevision: 1 },
                        { nodeId: "sp", ordinal: 1, nodeType: "spawn", arrivalRoute: "ok", outcome: "started", resultKind: "business", output: { workflowId: childWfId }, kvRevision: 2 },
                        { nodeId: "step2", ordinal: 1, nodeType: "script", arrivalRoute: "started", outcome: "timed_out", resultKind: "runtime_error", kvRevision: 2 },
                    ],
                });
                // Add KV rev 2 and rev 3 on source #2 (rev 3 is after cut R=2)
                await pool.query(
                    `INSERT INTO ${s}.workflow_kv_revisions (run_id, revision, kv, operation_id)
                     VALUES ($1, 2, '{"a":1,"b":2}', 'kv-2'), ($1, 3, '{"a":1,"b":2,"c":3}', 'kv-3')`,
                    [src.runId],
                );
                await pool.query(
                    `UPDATE ${s}.workflow_runs SET kv = '{"a":1,"b":2,"c":3}', kv_revision = 3 WHERE run_id = $1`,
                    [src.runId],
                );

                // Seed 4 inbox rows on #2: (1) consumed (excluded), (2) waiting before cut (carried, TTL restarted),
                // (3) accepted after cut (excluded), (4) 180 KiB WorkflowEnded@1 from childWfId (carried even if accepted after cut!)
                const bigNoticePayload = canonicalJson({ workflowId: childWfId, status: "completed", output: { blob: "z".repeat(180 * 1024) } });
                const cutAt = new Date(Date.now() - 10_000);
                await pool.query(
                    `INSERT INTO ${s}.workflow_inbox (message_id, workflow_session_id, run_id, sender_session_id, operation_id, contract, correlation, payload, request_sha256, accepted_at, expires_at, consumed_by, consumed_at)
                     VALUES
                       ($1, $2, $3, $4, 'in-1', 'Note@1', '{}', '{"n":1}', 'r1', now() - interval '60 seconds', now() + interval '1 hour', $10, now() - interval '30 seconds'),
                       ($5, $2, $3, $4, 'in-2', 'Note@1', '{"k":"v"}', '{"n":2}', 'r2', now() - interval '50 seconds', now() + interval '10 minutes', NULL, NULL),
                       ($6, $2, $3, $4, 'in-3', 'Late@1', '{}', '{"n":3}', 'r3', now() - interval '1 second', now() + interval '10 minutes', NULL, NULL),
                       ($7, $2, $3, $8, 'in-4', 'WorkflowEnded@1', '{}', $9, 'r4', now() - interval '1 second', now() + interval '1 hour', NULL, NULL)`,
                    [
                        `m1-${randomUUID()}`, src.wfId, src.runId, src.ownerId,
                        `m2-${randomUUID()}`, `m3-${randomUUID()}`, `m4-${randomUUID()}`, childWfId, bigNoticePayload, src.ids["step1#1"],
                    ],
                );

                const srcKeys = await store.listRerunKeys(src.runId);
                const step2Key = srcKeys.find(k => k.nodeId === "step2");
                const part = partitionRerunVisits(srcKeys, step2Key.nodeExecutionId, "supply");

                // Re-run #3 in supply mode with cutKvRevision = 2 AND varsOverlay { extra: "yes" } -> KV rev 3 = { a:1, b:2, extra:"yes" }
                const wf3Id = randomUUID();
                const run3Id = randomUUID();
                const mapped3 = mapRerunExecutions(run3Id, part.reused);
                const mappedV3 = mapRerunSuppliedExecution(run3Id, step2Key, mapped3);
                const suppliedAt = new Date();
                await client._catalog.createWorkflowSession(wf3Id, { parentSessionId: src.ownerId, title: "rerun-4b" });
                await store.createDefinition({
                    workflowSessionId: wf3Id, parentSessionId: src.ownerId, notifyParent: true,
                    yaml: SIMPLE_YAML, compiled: src.compiled, actor: ACTOR,
                    operationId: `rerun-4b-${wf3Id}`, requestSha256: sha256Hex(`rerun-4b-${wf3Id}`),
                    publish: true,
                    start: { runId: run3Id, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wf3Id}`, controllerVersion: "1.3.0", testAgentMode: null },
                    title: "rerun-4b",
                    rerun: {
                        sourceWorkflowSessionId: src.wfId, sourceRunId: src.runId,
                        fromExecutionId: step2Key.nodeExecutionId, mode: "supply",
                        resume: buildRerunResume({
                            mode: "supply", chosen: step2Key, mappedPredecessorId: mappedV3.newPredecessorId,
                            cutKvRevision: 2, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256,
                            supplied: { mappedSuppliedId: mappedV3.newId, outcome: "ok", outputSha256: sha256Hex('{"ok":2}'), note: "checked live", at: suppliedAt.toISOString(), nextStateId: "done", nextOrdinal: 1 },
                        }),
                        actor: ACTOR, mapped: mapped3, unwalkedCount: 0,
                        supplied: { newExecutionId: mappedV3.newId, newPredecessorId: mappedV3.newPredecessorId, sourceExecutionId: step2Key.nodeExecutionId, outcome: "ok", outputText: '{"ok":2}', note: "checked live", at: suppliedAt },
                        cutKvRevision: 2,
                        varsOverlay: { extra: "yes" },
                        inboxCutAt: cutAt,
                        reusedSpawnChildIds: [childWfId],
                        approvalOwnerCheck: null,
                    },
                });

                // 1. Verify KV revisions 1, 2 (copied from #2) and 3 (varsOverlay R+1)
                const run3 = await store.readRun(run3Id);
                expect(run3.kvRevision).toBe(3);
                expect(run3.kv).toEqual({ a: 1, b: 2, extra: "yes" });
                const { rows: kvRows } = await pool.query(
                    `SELECT revision, kv FROM ${s}.workflow_kv_revisions WHERE run_id = $1 ORDER BY revision ASC`,
                    [run3Id],
                );
                expect(kvRows.map(r => r.revision)).toEqual([1, 2, 3]);
                expect(JSON.parse(kvRows[0].kv)).toEqual({ a: 1 });
                expect(JSON.parse(kvRows[1].kv)).toEqual({ a: 1, b: 2 });
                expect(JSON.parse(kvRows[2].kv)).toEqual({ a: 1, b: 2, extra: "yes" });

                // 2. Verify carried inbox: exactly 2 messages (in-2 + 180 KiB WorkflowEnded@1), in seq ASC order, TTL restarted
                const openInbox = await store.listOpenInbox(run3Id, 20);
                expect(openInbox.rows.length).toBe(2);
                expect(openInbox.rows.map(m => m.contract)).toEqual(["Note@1", "WorkflowEnded@1"]);
                expect(openInbox.rows[0].correlation).toEqual({ k: "v" });
                expect(openInbox.rows[0].payload).toEqual({ n: 2 });
                expect(Date.parse(openInbox.rows[0].expiresAt) - Date.parse(openInbox.rows[0].acceptedAt)).toBeGreaterThan(600_000);
                expect(openInbox.rows[1].senderSessionId).toBe(childWfId);
                expect(JSON.stringify(openInbox.rows[1].payload).length).toBeGreaterThan(180 * 1024);

                // 3. Verify workflow.state_reused (2 events) + workflow.state_supplied (1 event) in session_events
                const { rows: evRows } = await pool.query(
                    `SELECT event_type, data FROM ${s}.session_events WHERE session_id = $1 AND event_type IN ('workflow.state_reused', 'workflow.state_supplied') ORDER BY seq ASC`,
                    [wf3Id],
                );
                const reusedEvs = evRows.filter(r => r.event_type === "workflow.state_reused");
                const suppliedEvs = evRows.filter(r => r.event_type === "workflow.state_supplied");
                expect(reusedEvs.length).toBe(2);
                expect(reusedEvs[0].data.stateId).toBe("step1");
                expect(reusedEvs[0].data.reusedFrom.workflowId).toBe(src.wfId);
                expect(suppliedEvs.length).toBe(1);
                expect(suppliedEvs[0].data.stateId).toBe("step2");
                expect(suppliedEvs[0].data.outcome).toBe("ok");
                expect(suppliedEvs[0].data.note).toBe("checked live");
                expect(suppliedEvs[0].data.suppliedFrom.executionId).toBe(step2Key.nodeExecutionId);
            } finally {
                await pool.end();
            }
        });
    });

    it("carries WorkflowEnded@1 only from reused spawn children, whatever its times, and never through the ordinary time window (I-INBOX)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const store = client._catalog.workflowStore();
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            try {
                const src = await seedEndedSourceWorkflow(client);
                const srcKeys = await store.listRerunKeys(src.runId);
                const step1Key = srcKeys.find(k => k.nodeId === "step1");
                const step2Key = srcKeys.find(k => k.nodeId === "step2");
                const reusedChild = randomUUID();
                const reusedChildExpired = randomUUID();
                const strayChild = randomUUID();
                // The cut of a run_again of step2 is step2's entry. A stray child (whose spawn #3 does not reuse) sent its
                // WorkflowEnded@1 notice inside the ordinary time window; a reused child's notice came after the cut, and another
                // reused child's notice had expired at it. An ordinary note waited at the cut.
                const cut = `(SELECT entered_at FROM ${s}.workflow_node_executions WHERE node_execution_id = $5)`;
                const seed = (opId, contract, sender, accepted, expires) => pool.query(
                    `INSERT INTO ${s}.workflow_inbox (message_id, workflow_session_id, run_id, sender_session_id, operation_id, contract,
                        correlation, payload, request_sha256, accepted_at, expires_at)
                     VALUES ($1, $2, $3, $4, $6, $7, 'null', '{}', $6, ${accepted}, ${expires})`,
                    [`msg-${randomUUID()}`, src.wfId, src.runId, sender, step2Key.nodeExecutionId, opId, contract]);
                await seed("note-waiting", "Note@1", src.ownerId, `${cut} - interval '10 seconds'`, `${cut} + interval '1 hour'`);
                await seed(`ended:${randomUUID()}`, "WorkflowEnded@1", strayChild, `${cut} - interval '10 seconds'`, `${cut} + interval '1 hour'`);
                await seed(`ended:${randomUUID()}`, "WorkflowEnded@1", reusedChild, `${cut} + interval '5 seconds'`, `${cut} + interval '1 hour'`);
                await seed(`ended:${randomUUID()}`, "WorkflowEnded@1", reusedChildExpired, `${cut} - interval '20 seconds'`, `${cut} - interval '1 second'`);

                const part = partitionRerunVisits(srcKeys, step2Key.nodeExecutionId, "run_again");
                const wf3Id = randomUUID();
                const run3Id = randomUUID();
                const mapped = mapRerunExecutions(run3Id, part.reused);
                await client._catalog.createWorkflowSession(wf3Id, { parentSessionId: src.ownerId, title: "rerun-i-inbox" });
                await store.createDefinition({
                    workflowSessionId: wf3Id, parentSessionId: src.ownerId, notifyParent: true,
                    yaml: SIMPLE_YAML, compiled: src.compiled, actor: ACTOR,
                    operationId: `rerun-i-inbox-${wf3Id}`, requestSha256: sha256Hex(`rerun-i-inbox-${wf3Id}`),
                    publish: true,
                    start: { runId: run3Id, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wf3Id}`, controllerVersion: "1.3.0", testAgentMode: null },
                    title: "rerun-i-inbox",
                    rerun: {
                        sourceWorkflowSessionId: src.wfId, sourceRunId: src.runId,
                        fromExecutionId: step2Key.nodeExecutionId, mode: "run_again",
                        resume: buildRerunResume({
                            mode: "run_again", chosen: step2Key, mappedPredecessorId: mapped.at(-1).newId,
                            cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256,
                        }),
                        actor: ACTOR, mapped, unwalkedCount: 0, supplied: null, cutKvRevision: 1,
                        inboxCutAt: { enteredAtOf: step2Key.nodeExecutionId },
                        reusedSpawnChildIds: [reusedChild, reusedChildExpired],
                        approvalOwnerCheck: null,
                    },
                });
                const { rows: copied } = await pool.query(
                    `SELECT contract, sender_session_id FROM ${s}.workflow_inbox WHERE run_id = $1 ORDER BY seq`, [run3Id]);
                expect(copied.map(r => [r.contract, r.sender_session_id])).toEqual([
                    ["Note@1", src.ownerId],
                    ["WorkflowEnded@1", reusedChild],
                    ["WorkflowEnded@1", reusedChildExpired],
                ]);
                expect(await store.summarizeRerunCarriedInbox(src.runId, { enteredAtOf: step2Key.nodeExecutionId },
                    [reusedChild, reusedChildExpired], [step1Key.nodeExecutionId]))
                    .toEqual({ count: 3, contracts: ["Note@1", "WorkflowEnded@1"] });
            } finally {
                await pool.end();
            }
        });
    });
});

describe("Task 4c: 3-mode enterNode cut guard (run_again, continue, supply) & failRerunDiverged", () => {
    it("enforces cut guard across all 3 modes (incl. supply -> terminal & same-IR byte check), respects stopping/kv_changed/paused precedence, and fails rerun_diverged with 0 rows on mismatch", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const store = client._catalog.workflowStore();
            const src = await seedEndedSourceWorkflow(client);
            const srcKeys = await store.listRerunKeys(src.runId);
            const step1Key = srcKeys.find(k => k.nodeId === "step1");
            const step2Key = srcKeys.find(k => k.nodeId === "step2");

            const makeRerun = async (mode, resumeOverrides = {}, opts = {}) => {
                const wfId = randomUUID();
                const runId = randomUUID();
                const part = partitionRerunVisits(srcKeys, step2Key.nodeExecutionId, mode);
                const mapped = mapRerunExecutions(runId, part.reused);
                const mappedV = mode === "supply" ? mapRerunSuppliedExecution(runId, step2Key, mapped) : null;
                const baseResume = mode === "supply"
                    ? buildRerunResume({
                        mode: "supply", chosen: step2Key, mappedPredecessorId: mappedV.newPredecessorId,
                        cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256, targetIrSha256: src.compiled.irSha256,
                        supplied: { mappedSuppliedId: mappedV.newId, outcome: "ok", outputSha256: sha256Hex("{}"), note: "ok", at: new Date().toISOString(), nextStateId: "done", nextOrdinal: 1 },
                    })
                    : buildRerunResume({
                        mode, chosen: step2Key, mappedPredecessorId: mapped.at(-1).newId,
                        cutKvRevision: 1, sourceRevision: 1, sourceIrSha256: src.compiled.irSha256,
                        targetIrSha256: opts.changedIr ? "different-ir" : src.compiled.irSha256,
                    });
                const resume = { ...baseResume, ...resumeOverrides };
                await client._catalog.createWorkflowSession(wfId, { parentSessionId: src.ownerId, title: `guard-${mode}` });
                await store.createDefinition({
                    workflowSessionId: wfId, parentSessionId: src.ownerId, notifyParent: true,
                    yaml: SIMPLE_YAML, compiled: src.compiled, actor: ACTOR,
                    operationId: `guard-${wfId}`, requestSha256: sha256Hex(`guard-${wfId}`),
                    publish: true,
                    start: { runId, mode: "live", inputsText: "{}", kvText: "{}", controllerInstanceId: `session-${wfId}`, controllerVersion: "1.3.0", testAgentMode: null },
                    title: `guard-${mode}`,
                    rerun: {
                        sourceWorkflowSessionId: src.wfId, sourceRunId: src.runId,
                        fromExecutionId: step2Key.nodeExecutionId, mode, resume, actor: ACTOR,
                        mapped, unwalkedCount: 0,
                        supplied: mappedV ? { newExecutionId: mappedV.newId, newPredecessorId: mappedV.newPredecessorId, sourceExecutionId: step2Key.nodeExecutionId, outcome: "ok", outputText: "{}", note: "ok", at: new Date() } : null,
                        cutKvRevision: 1, inboxCutAt: new Date(), reusedSpawnChildIds: [], approvalOwnerCheck: null,
                    },
                });
                await store.beginRun(runId);
                return { wfId, runId, mapped, mappedV, resume };
            };

            // 1. run_again: same-IR inputSha256 mismatch -> rerun_diverged with 0 rows inserted!
            const r1 = await makeRerun("run_again");
            const badEnter = await store.enterNode({
                runId: r1.runId,
                nodeExecutionId: nodeExecutionIdFor(r1.runId, "root", "step2", 1),
                scopeId: "root", nodeId: "step2", ordinal: 1, nodeType: "script",
                predecessorId: r1.mapped[0].newId, arrivalRoute: "ok",
                inputText: canonicalJson({ v: 999 }), kvRevision: 1, waitSeconds: null, immediate: null,
            });
            expect(badEnter.admitted).toBe(false);
            expect(badEnter.reason).toBe("inactive");
            expect(badEnter.run.status).toBe("failed");
            expect(badEnter.run.terminalError?.code).toBe("rerun_diverged");
            expect(await store.readNodeExecution(nodeExecutionIdFor(r1.runId, "root", "step2", 1))).toBeNull();

            // 2. run_again: matching same-IR input -> admits and stamps rerun_resumed_at!
            const r2 = await makeRerun("run_again");
            const okEnter = await store.enterNode({
                runId: r2.runId,
                nodeExecutionId: nodeExecutionIdFor(r2.runId, "root", "step2", 1),
                scopeId: "root", nodeId: "step2", ordinal: 1, nodeType: "script",
                predecessorId: r2.mapped[0].newId, arrivalRoute: "ok",
                inputText: canonicalJson({ v: 1 }), kvRevision: 1, waitSeconds: null, immediate: null,
            });
            expect(okEnter.admitted).toBe(true);
            expect((await store.readRun(r2.runId)).rerunResumedAt).not.toBeNull();

            // 3. Precedence: kv_changed returns reason "kv_changed" WITHOUT failing rerun_diverged!
            const rPrec = await makeRerun("run_again");
            const kvRefused = await store.enterNode({
                runId: rPrec.runId,
                nodeExecutionId: nodeExecutionIdFor(rPrec.runId, "root", "wrong_node", 1),
                scopeId: "root", nodeId: "wrong_node", ordinal: 1, nodeType: "script",
                predecessorId: rPrec.mapped[0].newId, arrivalRoute: "wrong",
                inputText: "{}", kvRevision: 99, waitSeconds: null, immediate: null,
            });
            expect(kvRefused.admitted).toBe(false);
            expect(kvRefused.reason).toBe("kv_changed");
            expect((await store.readRun(rPrec.runId)).status).toBe("running");

            // 4. supply -> terminal: matching successor stamps rerun_resumed_at; mismatched route fails rerun_diverged with 0 rows
            const rSupOk = await makeRerun("supply");
            const supEnterOk = await store.enterNode({
                runId: rSupOk.runId,
                nodeExecutionId: nodeExecutionIdFor(rSupOk.runId, "root", "done", 1),
                scopeId: "root", nodeId: "done", ordinal: 1, nodeType: "terminal",
                predecessorId: rSupOk.mappedV.newId, arrivalRoute: "ok",
                inputText: "{}", kvRevision: 1, waitSeconds: null, immediate: null,
            });
            expect(supEnterOk.admitted).toBe(true);
            expect((await store.readRun(rSupOk.runId)).rerunResumedAt).not.toBeNull();

            const rSupBad = await makeRerun("supply");
            const supEnterBad = await store.enterNode({
                runId: rSupBad.runId,
                nodeExecutionId: nodeExecutionIdFor(rSupBad.runId, "root", "failed", 1),
                scopeId: "root", nodeId: "failed", ordinal: 1, nodeType: "terminal",
                predecessorId: rSupBad.mappedV.newId, arrivalRoute: "failure",
                inputText: "{}", kvRevision: 1, waitSeconds: null, immediate: null,
            });
            expect(supEnterBad.admitted).toBe(false);
            expect(supEnterBad.run.terminalError?.code).toBe("rerun_diverged");
            expect(await store.readNodeExecution(nodeExecutionIdFor(rSupBad.runId, "root", "failed", 1))).toBeNull();

            // 5. continue: mismatched predecessor fails rerun_diverged; matching predecessor stamps rerun_resumed_at
            const rContBad = await makeRerun("continue");
            const contBad = await store.enterNode({
                runId: rContBad.runId,
                nodeExecutionId: nodeExecutionIdFor(rContBad.runId, "root", "failed", 1),
                scopeId: "root", nodeId: "failed", ordinal: 1, nodeType: "terminal",
                predecessorId: rContBad.mapped[0].newId, arrivalRoute: "ok",
                inputText: "{}", kvRevision: 1, waitSeconds: null, immediate: null,
            });
            expect(contBad.admitted).toBe(false);
            expect(contBad.run.terminalError?.code).toBe("rerun_diverged");

            // 6. failRerunDiverged ends active pre-cut rerun immediately
            const rDiv = await makeRerun("run_again");
            const ended = await store.failRerunDiverged(rDiv.runId, { reason: "pre_cut_coord_mismatch", stateId: step1Key.nodeId });
            expect(ended.status).toBe("failed");
            expect(ended.terminalError?.code).toBe("rerun_diverged");
        });
    });

    it("bounds readReusedAgentVisits (last 20, <=500 preview + truncated/outputChars, runtime_error code, <=24 KiB cap, M-1 agent-only filter, M-2 countReusedAgentVisits, I8 parallel ordinal ordering)", { timeout: testTime.ms(120_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const store = client._catalog.workflowStore();
            const src = await seedEndedSourceWorkflow(client, { visits: [] });
            const rerunId = src.runId;
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            try {
                // Insert 1 non-agent reused row sharing the same node_id (M-1 defense-in-depth: node_type='script' must be ignored!)
                const base = Date.now() - 100_000;
                const fakeSrcRunId = randomUUID();
                const fakeSrcWfId = randomUUID();
                const actorJson = JSON.stringify(ACTOR);
                await pool.query(
                    `INSERT INTO ${s}.workflow_node_executions (
                        node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                        input, input_sha256, state, outcome, result_kind, output, error, winner,
                        effect_attempts, entered_at, completed_at, kv_revision, deadline_at,
                        reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at
                     ) VALUES ($1,$2,'root',NULL,'agent_loop',999,'script',NULL,'{}',$3,'completed','ok','business','{"not":"agent"}',NULL,'effect',1,$4::timestamptz,$4::timestamptz,1,NULL,$5,$6,$7,$4::timestamptz)`,
                    [randomUUID(), rerunId, sha256Hex("{}"), new Date(base).toISOString(), randomUUID(), fakeSrcRunId, fakeSrcWfId],
                );

                // Insert 25 pre-cut agent visits:
                // - Visits 1..23: reused business (small JSON)
                // - Visit 24: reused runtime_error with error code "timed_out" (M-6)
                // - Visit 25: supplied with 50 KB output + suppliedNote (I-4)
                let lastId = null;
                for (let i = 1; i <= 25; i += 1) {
                    const nid = randomUUID();
                    lastId = nid;
                    const srcId = randomUUID();
                    const isErr = i === 24;
                    const isSup = i === 25;
                    const ts = new Date(base + i * 1000).toISOString();
                    const outputText = isErr ? null : isSup ? JSON.stringify({ big: "x".repeat(50_000) }) : JSON.stringify({ n: i });
                    const errText = isErr ? JSON.stringify({ code: "timed_out", message: "step timed out" }) : null;
                    await pool.query(
                        `INSERT INTO ${s}.workflow_node_executions (
                            node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                            input, input_sha256, state, outcome, result_kind, output, error, winner,
                            effect_attempts, entered_at, completed_at, kv_revision, deadline_at,
                            reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at,
                            supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at
                         ) VALUES ($1,$2,'root',NULL,'agent_loop',$3,'agent',NULL,'{}',$4,'completed',$5,$6,$7,$8,$9,$10,$11::timestamptz,$11::timestamptz,1,NULL,$12,$13,$14,$15::timestamptz,$16,$17,$18,$19,$20,$21::timestamptz)`,
                        [
                            nid, rerunId, i, sha256Hex("{}"),
                            isErr ? "timed_out" : "more",
                            isErr ? "runtime_error" : "business",
                            outputText, errText,
                            isSup ? "supplied" : "agent",
                            isSup ? 0 : 1,
                            ts,
                            isSup ? null : srcId,
                            isSup ? null : fakeSrcRunId,
                            isSup ? null : fakeSrcWfId,
                            isSup ? null : ts,
                            isSup ? srcId : null,
                            isSup ? fakeSrcRunId : null,
                            isSup ? fakeSrcWfId : null,
                            isSup ? actorJson : null,
                            isSup ? "Operator supplied huge payload" : null,
                            isSup ? ts : null,
                        ],
                    );
                }

                // M-1 & M-2: countReusedAgentVisits excludes the non-agent row and returns 25 cleanly.
                expect(await store.countReusedAgentVisits(rerunId, "agent_loop")).toBe(25);

                // I-4 & M-6: readReusedAgentVisits keeps last 20, reports omitted=5, marks 50KB truncated + outputChars, includes error.code on runtime_error.
                const summary = await store.readReusedAgentVisits(rerunId, "agent_loop");
                expect(summary.count).toBe(25);
                expect(summary.reusedCount).toBe(24);
                expect(summary.suppliedCount).toBe(1);
                expect(summary.omitted).toBe(5);
                expect(summary.visits.length).toBe(20);
                expect(summary.visits[0].visit).toBe(6);
                expect(summary.visits[19].visit).toBe(25);
                expect(summary.lastNodeExecutionId).toBe(lastId);
                // Visit 24 (index 18): runtime_error with error: { code: "timed_out" }
                expect(summary.visits[18].resultKind).toBe("runtime_error");
                expect(summary.visits[18].error).toEqual({ code: "timed_out" });
                // Visit 25 (index 19): truncated 50KB output preview
                expect(summary.visits[19].source).toBe("supplied");
                expect(summary.visits[19].suppliedNote).toBe("Operator supplied huge payload");
                expect(summary.visits[19].truncated).toBe(true);
                expect(summary.visits[19].outputChars).toBeGreaterThan(50_000);
                expect(summary.visits[19].outputPreview.length).toBe(500);
                expect(summary.visits[19].output).toBeUndefined();
                expect(Buffer.byteLength(JSON.stringify({ omitted: summary.omitted, visits: summary.visits }), "utf8")).toBeLessThanOrEqual(24 * 1024);

                // Hard 24 KiB serialized budget trim test: 20 visits each with 500 '[' chars (promptSafeJson expands '[' -> '\u005b' = ~3 KB/visit -> trims oldest into omitted!)
                for (let i = 1; i <= 20; i += 1) {
                    const nid = randomUUID();
                    const srcId = randomUUID();
                    const ts = new Date(base + i * 1000).toISOString();
                    await pool.query(
                        `INSERT INTO ${s}.workflow_node_executions (
                            node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                            input, input_sha256, state, outcome, result_kind, output, error, winner,
                            effect_attempts, entered_at, completed_at, kv_revision, deadline_at,
                            reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at
                         ) VALUES ($1,$2,'root',NULL,'heavy_agent',$3,'agent',NULL,'{}',$4,'completed','more','business',$5,NULL,'agent',1,$6::timestamptz,$6::timestamptz,1,NULL,$7,$8,$9,$6::timestamptz)`,
                        [nid, rerunId, i, sha256Hex("{}"), JSON.stringify("[".repeat(600)), ts, srcId, fakeSrcRunId, fakeSrcWfId],
                    );
                }
                const heavy = await store.readReusedAgentVisits(rerunId, "heavy_agent");
                expect(heavy.count).toBe(20);
                expect(heavy.omitted).toBeGreaterThan(0);
                expect(heavy.visits.length + heavy.omitted).toBe(20);
                expect(heavy.visits[heavy.visits.length - 1].visit).toBe(20);

                // I8 named-branch ordering: two parallel visits (p.ordinal=1 and p.ordinal=2), each containing a_agent ordinal=1.
                // Deliberately insert p.ordinal=2 with an EARLIER entered_at so only (COALESCE(p.ordinal, 0), n.ordinal) puts p.ordinal=1 first!
                const p1 = randomUUID();
                const p2 = randomUUID();
                const b1 = `${p1}#alpha`;
                const b2 = `${p2}#alpha`;
                await pool.query(
                    `INSERT INTO ${s}.workflow_node_executions (
                        node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                        input, input_sha256, state, outcome, result_kind, output, error, winner,
                        effect_attempts, entered_at, completed_at, kv_revision, deadline_at,
                        reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at
                     ) VALUES
                     ($1,$2,'root',NULL,'fan',1,'parallel',NULL,'{}',$3,'completed','joined','business','{}',NULL,'controller',1,$4::timestamptz,$4::timestamptz,1,NULL,$5,$9,$10,$4::timestamptz),
                     ($6,$2,'root',NULL,'fan',2,'parallel',NULL,'{}',$3,'completed','joined','business','{}',NULL,'controller',1,$7::timestamptz,$7::timestamptz,1,NULL,$8,$9,$10,$7::timestamptz)`,
                    [p1, rerunId, sha256Hex("{}"), new Date(base + 50_000).toISOString(), randomUUID(), p2, new Date(base + 10_000).toISOString(), randomUUID(), fakeSrcRunId, fakeSrcWfId],
                );
                await pool.query(
                    `INSERT INTO ${s}.workflow_node_executions (
                        node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                        input, input_sha256, state, outcome, result_kind, output, error, winner,
                        effect_attempts, entered_at, completed_at, kv_revision, deadline_at,
                        reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at
                     ) VALUES
                     ($1,$2,$3,NULL,'a_agent',1,'agent',NULL,'{}',$4,'completed','done','business','{"round":1}',NULL,'agent',1,$5::timestamptz,$5::timestamptz,1,NULL,$6,$11,$12,$5::timestamptz),
                     ($7,$2,$8,NULL,'a_agent',1,'agent',NULL,'{}',$4,'completed','done','business','{"round":2}',NULL,'agent',1,$9::timestamptz,$9::timestamptz,1,NULL,$10,$11,$12,$9::timestamptz)`,
                    [randomUUID(), rerunId, b1, sha256Hex("{}"), new Date(base + 60_000).toISOString(), randomUUID(),
                        randomUUID(), b2, new Date(base + 20_000).toISOString(), randomUUID(), fakeSrcRunId, fakeSrcWfId],
                );
                const i8 = await store.readReusedAgentVisits(rerunId, "a_agent");
                expect(i8.count).toBe(2);
                expect(i8.visits.map(v => v.output)).toEqual([{ round: 1 }, { round: 2 }]);
            } finally {
                await pool.end();
            }
        });
    });
});
