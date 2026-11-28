import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { readWorkflowRerunPlan, saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { readWorkflowFromTool } from "../../src/workflow/tools.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";

/**
 * Phase 3 I7 Task 7: read_workflow's rerun_plan, reused and supplied provenance, run.rerunOf and view.reruns, and
 * workflow_definition start with rerun_from, against PG16 (design §6.4).
 */
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "entra", subject: "owner-sub-7", displayName: "Owner" };
const OWNER_ACTOR = { kind: "user", provider: OWNER.provider, subject: OWNER.subject, name: "Owner" };
const ADMIN_ACTOR = { kind: "user", provider: "entra", subject: "admin-sub-7", name: "Admin" };

function pgPoolConfig(connectionString) {
    const parsed = new URL(connectionString);
    const sslMode = (parsed.searchParams.get("sslmode") ?? "").toLowerCase();
    const relaxSsl = sslMode === "require" || sslMode === "prefer";
    if (relaxSsl) parsed.searchParams.delete("sslmode");
    return { connectionString: parsed.toString(), max: 4, ...(relaxSsl ? { ssl: { rejectUnauthorized: false } } : {}) };
}

const REV1_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-read-wf, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
schemas:
  Out:
    type: object
    additionalProperties: false
    required: [fqdn]
    properties:
      fqdn: { type: string, minLength: 1 }
initial: step1
states:
  step1:
    type: script
    source: 'await setResult("ok", { v: 1 });'
    transition: { next: { ok: step2 } }
  step2:
    type: script
    outputSchema: { $ref: "#/schemas/Out" }
    outcomes: [ok]
    source: 'await setResult("ok", { fqdn: "a.db" });'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const REV2_YAML = REV1_YAML.replace('version: "1.0.0"', 'version: "1.0.1"').replace('fqdn: "a.db"', 'fqdn: "b.db"');

const APPROVAL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-read-approval-wf, version: "1.0.0" }
limits: { maxNodeExecutions: 20 }
initial: gate
states:
  gate:
    type: approval
    question: "Deploy to prod?"
    timeoutSeconds: 60
    transition: { next: { approved: step2, rejected: failed, timed_out: failed } }
  step2:
    type: script
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** A host whose Starts admit their Workflow without running it, so each re-run's copied rows can be read as admitted. */
function deferHost(client) {
    return {
        catalog: client._catalog,
        store: client._catalog.workflowStore(),
        duroxideClient: Object.assign(Object.create(client.duroxideClient), { startOrchestrationVersioned: async () => {} }),
        scripts: true,
    };
}

/** A session definition's Workflow whose run ended failed at step2 (visits written as the runtime writes them). */
async function seedEnded(host, opts = {}) {
    const pool = new pg.Pool(pgPoolConfig(getEnv().store));
    const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
    const ownerSessionId = opts.ownerSessionId ?? randomUUID();
    try {
        if (!(await host.catalog.getSession(ownerSessionId))) await host.catalog.createSession(ownerSessionId, { owner: OWNER });
        const yaml = opts.yaml ?? REV1_YAML;
        const name = yaml.match(/name:\s*([A-Za-z0-9._-]+)/)[1];
        const saved = await saveSessionWorkflowDefinition(host, { ownerSessionId, name, yaml, expected: null, actor: OWNER_ACTOR,
            operationId: `save-1-${randomUUID()}` });
        const definitionId = saved.receipt.definitionId;
        if (opts.rev2Yaml) {
            await saveSessionWorkflowDefinition(host, { ownerSessionId, name, yaml: opts.rev2Yaml, expected: { definitionId, revision: 1 },
                actor: OWNER_ACTOR, operationId: `save-2-${randomUUID()}` });
        }
        const started = await startSessionWorkflowDefinition(host, { ownerSessionId, definition: { definitionId }, revision: 1, inputs: {},
            actor: OWNER_ACTOR, owner: OWNER, operationId: `src-${definitionId}`, binding: null });
        const visits = opts.visits ?? [
            { nodeId: "step1", nodeType: "script", outcome: "ok", resultKind: "business", output: { v: 1 } },
            { nodeId: "step2", nodeType: "script", arrivalRoute: "ok", outcome: "timed_out", resultKind: "runtime_error" },
        ];
        const ids = {};
        let prev = null;
        const baseMs = Date.now() - 30_000;
        for (let i = 0; i < visits.length; i += 1) {
            const v = visits[i];
            const id = nodeExecutionIdFor(started.runId, "root", v.nodeId, 1);
            const inputText = canonicalJson({});
            const enteredMs = baseMs + i * 1000;
            await pool.query(
                `INSERT INTO ${s}.workflow_node_executions (
                    node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                    input, input_sha256, state, outcome, result_kind, output, error, winner,
                    effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                 ) VALUES ($1,$2,'root',$3,$4,1,$5,$6,$7,$8,'completed',$9,$10,$11,$12,'effect',1,$13::timestamptz,$14::timestamptz,1,NULL)`,
                [id, started.runId, prev, v.nodeId, v.nodeType, v.arrivalRoute ?? null, inputText, sha256Hex(inputText), v.outcome, v.resultKind,
                    v.resultKind === "business" ? canonicalJson(v.output ?? null) : null,
                    v.resultKind === "runtime_error" ? canonicalJson({ code: v.outcome, message: "slow" }) : null,
                    new Date(enteredMs).toISOString(), new Date(enteredMs + 400).toISOString()],
            );
            if (v.nodeType === "approval") {
                const snapshot = canonicalJson({ question: "Deploy to prod?" });
                await pool.query(
                    `INSERT INTO ${s}.workflow_approvals (node_execution_id, workflow_session_id, run_id, owner_provider, owner_subject, snapshot,
                        context_sha256, decision, reason, decided_by, decided_at, operation_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,now(),$10)`,
                    [id, started.workflowId, started.runId, OWNER.provider, OWNER.subject, snapshot, sha256Hex(snapshot), v.outcome,
                        JSON.stringify(OWNER), `op-app-${id}`],
                );
            }
            ids[v.nodeId] = id;
            prev = id;
        }
        await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [started.runId]);
        return { ownerSessionId, definitionId, workflowId: started.workflowId, runId: started.runId, ids, baseMs };
    } finally {
        await pool.end();
    }
}

async function endRun(runId) {
    const pool = new pg.Pool(pgPoolConfig(getEnv().store));
    try {
        await pool.query(`UPDATE "${getEnv().cmsSchema.replace(/"/g, '""')}".workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [runId]);
    } finally {
        await pool.end();
    }
}

const readTool = async (host, caller, args) => JSON.parse(await readWorkflowFromTool(args, { callerSessionId: caller, host }));
const plan = async (host, caller, workflowId, rerunPlan) => {
    const answer = await readTool(host, caller, { workflow_id: workflowId, rerun_plan: rerunPlan });
    expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
    return answer.rerunPlan;
};
const toolContext = (host, caller) => ({ callerSessionId: caller, host, toolCallId: `call-${randomUUID()}`, owner: OWNER, binding: async () => null });

describe("I7 Task 7: rerun_plan, reused/supplied provenance and workflow_definition rerun_from", () => {
    it("reads run_again, continue and supply plans on the source revision, previews an outcome as 200, and refuses output and other selectors",
        { timeout: testTime.ms(120_000) }, async () => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = deferHost(client);
                const src = await seedEnded(h, { rev2Yaml: REV2_YAML });
                const runsBefore = await h.store.listRuns(src.workflowId);

                // Auto-pick (no terminal error kept): the last visit, continued from its stored failure.
                expect(await plan(h, src.ownerSessionId, src.workflowId, {})).toMatchObject({
                    from: { executionId: src.ids.step2, stateId: "step2", visit: 1, picked: "last_visit" }, mode: "continue",
                    runs: { first: { stateId: "failed", visit: 1 } },
                });
                const again = await plan(h, src.ownerSessionId, src.workflowId, { execution_id: src.ids.step2, mode: "run_again" });
                expect(again).toMatchObject({
                    of: { workflowId: src.workflowId, runId: src.runId, revision: 1, status: "failed" },
                    from: { executionId: src.ids.step2, stateId: "step2", visit: 1, picked: "requested" },
                    mode: "run_again",
                    revision: { target: 1, source: 1, newestValid: 2, newestValidFits: true, fits: true, problems: [] },
                    reused: { visits: 1, steps: [{ stateId: "step1", visits: 1 }], approvals: [] },
                    carried: { count: 0, contracts: [] },
                    runs: { first: { stateId: "step2", visit: 1 } },
                    allowed: true, blockedReason: null, grantSource: "session",
                });
                expect(again.modesAvailable).toEqual(expect.arrayContaining(["run_again", "supply"]));
                expect(again.supplyContract).toMatchObject({ outcomes: ["ok"], nextByOutcome: { ok: { stateId: "done", visit: 1 } } });
                expect(again.warnings.map(item => item.code)).toEqual(expect.arrayContaining(["step_runs_again", "reused_setup"]));

                expect((await plan(h, src.ownerSessionId, src.workflowId, { execution_id: src.ids.step2, revision: 2 })).revision)
                    .toMatchObject({ target: 2, source: 1, fits: true });

                const cont = await plan(h, src.ownerSessionId, src.workflowId, { execution_id: src.ids.step1, mode: "continue" });
                expect(cont).toMatchObject({ mode: "continue", from: { stateId: "step1", picked: "requested" }, runs: { first: { stateId: "step2", visit: 1 } } });
                expect(cont.dropped.map(item => item.executionId)).toEqual([src.ids.step2]);

                const supplied = await plan(h, src.ownerSessionId, src.workflowId, { execution_id: src.ids.step2, mode: "supply", outcome: "ok" });
                expect(supplied.supply).toEqual({ outcome: "ok", valid: true, next: { stateId: "done", visit: 1 }, problems: [] });
                expect(supplied.warnings.map(item => item.code)).toContain("result_supplied");
                // M6 / S11: an outcome the step does not declare is a 200 preview, never a 422.
                const wrong = await plan(h, src.ownerSessionId, src.workflowId, { execution_id: src.ids.step2, mode: "supply", outcome: "nope" });
                expect(wrong.supply).toMatchObject({ outcome: "nope", valid: false, next: null });
                expect(wrong.supply.problems[0].code).toBe("undeclared_outcome");

                for (const [args, code] of [
                    [{ rerun_plan: { execution_id: src.ids.step2, mode: "supply", result: { outcome: "ok", output: { fqdn: "x" } } } }, "WORKFLOW_READ_INVALID"],
                    [{ rerun_plan: {}, execution_id: src.ids.step2 }, "WORKFLOW_READ_INVALID"],
                    [{ rerun_plan: {}, run_id: src.runId }, "WORKFLOW_READ_INVALID"],
                    [{ rerun_plan: { execution_id: randomUUID() } }, "RERUN_VISIT_NOT_FOUND"],
                    [{ rerun_plan: { mode: "supply" } }, "RERUN_VISIT_REQUIRED"],
                    [{ rerun_plan: { revision: 9 } }, "DEFINITION_REVISION_NOT_FOUND"],
                ]) {
                    const answer = await readTool(h, src.ownerSessionId, { workflow_id: src.workflowId, ...args });
                    expect(answer.ok, JSON.stringify(args)).toBe(false);
                    expect(answer.error.code, JSON.stringify(args)).toBe(code);
                }
                // Reading changes nothing.
                expect(await h.store.listRuns(src.workflowId)).toEqual(runsBefore);
            });
        });

    it("counts only unread carried messages, and reuses an answered approval only for its owner directly (never viaMcp, proxied or an agent)",
        { timeout: testTime.ms(120_000) }, async () => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = deferHost(client);
                const pool = new pg.Pool(pgPoolConfig(getEnv().store));
                const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
                try {
                    const src = await seedEnded(h);
                    for (const [n, consumedBy] of [[1, null], [2, src.ids.step1]]) {
                        const opId = `note-${n}-${randomUUID()}`;
                        await pool.query(
                            `INSERT INTO ${s}.workflow_inbox (message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256,
                                contract, correlation, payload, accepted_at, expires_at, consumed_by, consumed_at)
                             VALUES ($1,$2,$3,$4,$5,$6,'Note@1','null',$7,$8::timestamptz,$9::timestamptz,$10::text,
                                     CASE WHEN $10::text IS NULL THEN NULL ELSE $8::timestamptz END)`,
                            [`msg-${randomUUID()}`, src.workflowId, src.runId, src.ownerSessionId, opId, sha256Hex(opId), canonicalJson({ n }),
                                new Date(src.baseMs + 200).toISOString(), new Date(src.baseMs + 3_600_000).toISOString(), consumedBy],
                        );
                    }
                    expect((await plan(h, src.ownerSessionId, src.workflowId, {})).carried).toEqual({ count: 1, contracts: ["Note@1"] });

                    const app = await seedEnded(h, { yaml: APPROVAL_YAML, visits: [
                        { nodeId: "gate", nodeType: "approval", outcome: "approved", resultKind: "business", output: { decidedBy: OWNER } },
                        { nodeId: "step2", nodeType: "script", arrivalRoute: "approved", outcome: "timed_out", resultKind: "runtime_error" },
                    ] });
                    const fromStep2 = { executionId: app.ids.step2 };
                    const owner = (await readWorkflowRerunPlan(h, app.workflowId, fromStep2, { actor: OWNER_ACTOR })).rerunPlan;
                    expect(owner).toMatchObject({ allowed: true, blockedReason: null, reused: { approvals: [{ executionId: app.ids.gate, outcome: "approved" }] } });
                    expect(owner.warnings.map(item => item.code)).toContain("approval_reused");
                    const refusedTo = [
                        ["viaMcp", readWorkflowRerunPlan(h, app.workflowId, { ...fromStep2, viaMcp: true }, { actor: OWNER_ACTOR })],
                        ["proxied", readWorkflowRerunPlan(h, app.workflowId, fromStep2, { actor: OWNER_ACTOR, originatingSessionId: app.ownerSessionId })],
                        ["admin", readWorkflowRerunPlan(h, app.workflowId, fromStep2, { actor: ADMIN_ACTOR })],
                        ["agent", readTool(h, app.ownerSessionId, { workflow_id: app.workflowId, rerun_plan: { execution_id: app.ids.step2 } })],
                    ];
                    for (const [who, answer] of refusedTo) {
                        const read = (await answer).rerunPlan;
                        expect(read.allowed, who).toBe(false);
                        expect(read.blockedReason, who).toBe("Choose gate · visit 1 or an earlier step. Only the owner in the portal can reuse an approval.");
                    }
                } finally {
                    await pool.end();
                }
            });
        });

    it("shows reused and supplied visits, run.rerunOf and view.reruns, both on a #3 -> #4 copy, and originGone once the source is swept",
        { timeout: testTime.ms(120_000) }, async () => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = deferHost(client);
                const src = await seedEnded(h);
                const r3 = await startSessionWorkflowDefinition(h, { ownerSessionId: src.ownerSessionId, definition: { definitionId: src.definitionId },
                    inputs: {}, actor: OWNER_ACTOR, owner: OWNER, operationId: `r3-${randomUUID()}`,
                    rerunFrom: { workflowId: src.workflowId, executionId: src.ids.step2, mode: "supply",
                        result: { outcome: "ok", output: { fqdn: "verified.db" } }, note: "checked with az postgres show" } });
                const view3 = await readTool(h, src.ownerSessionId, { workflow_id: r3.workflowId });
                expect(view3.ok).toBe(true);
                const byState3 = Object.fromEntries(view3.run.nodeExecutions.map(item => [item.stateId, item]));
                expect(byState3.step1.reused).toMatchObject({ workflowId: src.workflowId, runId: src.runId, executionId: src.ids.step1 });
                expect(byState3.step1.supplied).toBeUndefined();
                expect(byState3.step2.reused).toBeUndefined();
                expect(byState3.step2.supplied).toMatchObject({ from: { workflowId: src.workflowId, runId: src.runId, executionId: src.ids.step2 },
                    by: { kind: "user" }, note: "checked with az postgres show" });
                expect(typeof byState3.step2.supplied.at).toBe("string");
                expect(JSON.stringify(byState3.step2.supplied.by)).not.toContain(OWNER.subject);
                expect(view3.run.rerunOf).toMatchObject({ workflowId: src.workflowId, runId: src.runId, executionId: src.ids.step2, mode: "supply",
                    stateId: "step2", visit: 1, revision: 1, supplied: { outcome: "ok", note: "checked with az postgres show" } });
                expect(view3.run.rerunOf.originGone).toBeUndefined();
                const one = await readTool(h, src.ownerSessionId, { workflow_id: r3.workflowId, execution_id: byState3.step2.nodeExecutionId });
                expect(one.execution.supplied.from.executionId).toBe(src.ids.step2);
                const srcView = await readTool(h, src.ownerSessionId, { workflow_id: src.workflowId });
                expect(srcView.reruns).toEqual([expect.objectContaining({ workflowId: r3.workflowId, runId: r3.runId, mode: "supply",
                    fromExecutionId: src.ids.step2 })]);
                expect(srcView.run.rerunOf).toBeUndefined();

                await endRun(r3.runId);
                const r4 = await startSessionWorkflowDefinition(h, { ownerSessionId: src.ownerSessionId, definition: { definitionId: src.definitionId },
                    inputs: {}, actor: OWNER_ACTOR, owner: OWNER, operationId: `r4-${randomUUID()}`,
                    rerunFrom: { workflowId: r3.workflowId, executionId: byState3.step2.nodeExecutionId, mode: "continue" } });
                const step2Of4 = (await readTool(h, src.ownerSessionId, { workflow_id: r4.workflowId })).run.nodeExecutions.find(item => item.stateId === "step2");
                expect(step2Of4.reused).toMatchObject({ workflowId: r3.workflowId, executionId: byState3.step2.nodeExecutionId });
                expect(step2Of4.supplied.from).toMatchObject({ workflowId: src.workflowId, executionId: src.ids.step2 });

                // The source is swept: its origin reads gone, and it can no longer be re-run (409 with its kept outcome).
                await h.catalog.softDeleteSession(src.workflowId);
                const swept3 = await readTool(h, src.ownerSessionId, { workflow_id: r3.workflowId });
                const after = Object.fromEntries(swept3.run.nodeExecutions.map(item => [item.stateId, item]));
                expect(after.step1.reused.originGone).toBe(true);
                expect(after.step2.supplied.from.originGone).toBe(true);
                expect(swept3.run.rerunOf.originGone).toBe(true);
                const swept4 = (await readTool(h, src.ownerSessionId, { workflow_id: r4.workflowId })).run.nodeExecutions.find(item => item.stateId === "step2");
                expect(swept4.reused.originGone).toBeUndefined();
                expect(swept4.supplied.from.originGone).toBe(true);
                const gone = await readTool(h, src.ownerSessionId, { workflow_id: src.workflowId, rerun_plan: {} });
                expect(gone).toMatchObject({ ok: false, error: { code: "RERUN_SOURCE_GONE", details: { workflowId: src.workflowId } } });
            });
        });

    it("I2: an ancestor reads the plan but its Start is 404; the owner starts with rerun_from alone and is refused inherited arguments",
        { timeout: testTime.ms(120_000) }, async () => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = deferHost(client);
                const ancestor = randomUUID();
                const ownerSessionId = randomUUID();
                await h.catalog.createSession(ancestor, { owner: OWNER });
                await h.catalog.createSession(ownerSessionId, { owner: OWNER, parentSessionId: ancestor });
                const src = await seedEnded(h, { ownerSessionId });

                const seen = await plan(h, ancestor, src.workflowId, {});
                expect(seen).toMatchObject({ allowed: false, blockedReason: "Only the session that owns rerun-read-wf can re-run its Workflows." });
                const start = async (caller, args) => JSON.parse(await workflowDefinitionFromTool({ operation: "start", ...args }, toolContext(h, caller)));
                expect(await start(ancestor, { rerun_from: { workflow_id: src.workflowId } }))
                    .toMatchObject({ ok: false, error: { code: "WORKFLOW_NOT_FOUND" } });
                for (const extra of [{ inputs: { a: 1 } }, { workspace: null }, { run_again_of: src.workflowId }]) {
                    expect(await start(ownerSessionId, { rerun_from: { workflow_id: src.workflowId }, ...extra }))
                        .toMatchObject({ ok: false, error: { code: "RERUN_ARGUMENT_REFUSED" } });
                }
                expect(await start(ownerSessionId, { rerun_from: { workflow_id: src.workflowId, child: "c" } }))
                    .toMatchObject({ ok: false, error: { code: "RERUN_ARGUMENT_REFUSED" } });

                const started = await start(ownerSessionId, { rerun_from: { workflow_id: src.workflowId, execution_id: src.ids.step2 } });
                expect(started).toMatchObject({ ok: true, operation: "start", definitionId: src.definitionId, revision: 1,
                    rerun: { ofWorkflowId: src.workflowId, ofRunId: src.runId, fromExecutionId: src.ids.step2, mode: "run_again", reused: 1 } });
                expect((await h.store.readRun(started.runId))?.rerunOfWorkflowSessionId).toBe(src.workflowId);
            });
        });
});
