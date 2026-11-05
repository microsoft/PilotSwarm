/**
 * J3 JK-21 and JK-23: a worker of the build before the join of the first k (8d568890) and this build on one database
 * (test design join-k-of-n; oracle O9: actual old histories, not IR edited by hand). Each needs that build: set
 * PS_WFV2_BASELINE_DIST to the absolute path of a built 8d568890 packages/sdk/dist (with its node_modules beside it).
 * Without it both cases are skipped (VOID), never passed.
 *
 * - JK-21: the old worker starts IR 8 runs (a join of every branch, and one under failFast), one branch ends, one waits,
 *   one is queued, and the old controller continues as new; it stops. This build migrates the schema, takes the same
 *   orchestration over (replaying the old history, decoding the old controller state) and finishes the runs: the IR is
 *   unchanged, no time limit is asked, every branch state once, the joined output in item order, and the blocked report
 *   with every old field.
 * - JK-23: the old build's service refuses a join of the first k and a parallel time limit before writing anything; an IR
 *   9 run this build starts while only the old worker runs fails with the old reader's refusal (never read as a join of
 *   every branch), and this build's worker runs IR 9.
 *
 * Each test starts on empty schemas (the suite env drops them after each test), so the old build creates them.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import {
    elapsedResult, endOf, forkJoinWorker, joinBaseOf, joinDoc, joinRuntimeOn, persisted, scheduledInputs, startJoin, until, yamlOf,
} from "../helpers/workflow-v2-join-harness.js";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { branchScopeId, WORKFLOW_V2_REQUEST_ACTIVITIES } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";

const { Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const R = WORKFLOW_V2_REQUEST_ACTIVITIES;
const BASELINE = process.env.PS_WFV2_BASELINE_DIST ?? "";
const compat = BASELINE ? it : it.skip;

/** The old build is the one asked for: its compiler reads IR 8 at most. A wrong path fails here, never passes. */
async function requireBaseline() {
    expect(existsSync(`${BASELINE}/workflow/v2/runtime.js`), `PS_WFV2_BASELINE_DIST (${BASELINE}) is not a built packages/sdk/dist`).toBe(true);
    const compiler = await import(pathToFileURL(`${BASELINE}/workflow/v2/compiler.js`).href);
    expect(compiler.WORKFLOW_V2_MILESTONE_IR_VERSION, "PS_WFV2_BASELINE_DIST is not the build before IR 9 (8d568890)").toBe(8);
}

/** Raw reads of the shared database while the old build owns its schema (this build's catalog is not opened yet). */
async function rawOf(env) {
    const pool = new pg.Pool({ connectionString: env.store, max: 2 });
    const q = async (text, params = []) => (await pool.query(text.replaceAll("SCHEMA.", `"${env.cmsSchema}".`), params)).rows;
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    return { q, client: new Client(provider), close: () => pool.end() };
}

/** A parallel state over `items` whose body is a wait of the item's seconds, then a succeeded end (IR 8 unless `join`). */
const waitsDoc = ({ items, concurrency = 1, failFast = false, join, timeoutSeconds } = {}) => ({
    apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "join-compat", version: "1.0.0" },
    initialInput: { items }, initial: "fan",
    states: {
        fan: {
            type: "parallel", forEach: "${input.items}", concurrency, ...(failFast ? { failFast: true } : {}), ...(join ? { join } : {}),
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
            body: { initial: "hold", states: {
                hold: { type: "wait", seconds: "${input.seconds}", transition: { next: { elapsed: "done" } } },
                done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            } },
            transition: { next: { joined: "finished", blocked: "stuck", failure: "failed", ...(timeoutSeconds !== undefined ? { timed_out: "late" } : {}) } },
        },
        finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
        stuck: { type: "terminal", outcome: "blocked", output: "${input}" },
        failed: { type: "terminal", outcome: "failed" },
        ...(timeoutSeconds !== undefined ? { late: { type: "terminal", outcome: "blocked", output: "${input}" } } : {}),
    },
});

describe("J3 JK-21 and JK-23: the build before the join of the first k (8d568890) beside this one (VOID without PS_WFV2_BASELINE_DIST)", () => {
    compat("JK-21: IR 8 runs started and continued as new by the old worker finish on this build: IR unchanged, no time limit, each branch once, old fields kept", { timeout: TIMEOUT }, async () => {
        await requireBaseline();
        const env = getEnv();
        const old = await forkJoinWorker(env, { dist: BASELINE, wakeBackstopMs: 100 });
        const raw = await rawOf(env);
        let base = null;
        const workers = [];
        try {
            await old.ready;
            // A join of every branch, one at a time: branch 1 waits 1 s and ends, branch 2 waits, branch 3 is queued.
            const all = await old.create(yamlOf(waitsDoc({ items: [{ seconds: 1 }, { seconds: 600 }, { seconds: 600 }] })));
            // The same under failFast; branch 3's 0 seconds is refused when it starts (a branch error).
            const fast = await old.create(yamlOf(waitsDoc({ items: [{ seconds: 1 }, { seconds: 600 }, { seconds: 0 }], failFast: true })));
            for (const created of [all, fast]) expect(created, JSON.stringify(created)).toMatchObject({ valid: true });
            const ids = created => {
                const fan = nodeExecutionIdFor(created.runId, "root", "fan", 1);
                return { ...created, fan, at: (index, nodeId) => nodeExecutionIdFor(created.runId, branchScopeId(fan, index), nodeId, 1) };
            };
            const runs = [ids(all), ids(fast)];
            const rowsOf = async run => raw.q(`SELECT node_execution_id AS id, node_id, scope_id, state, outcome FROM SCHEMA.workflow_node_executions WHERE run_id = $1`, [run.runId]);
            const runRow = async run => (await raw.q(`SELECT ir_sha256, controller_instance_id, revision FROM SCHEMA.workflow_runs WHERE run_id = $1`, [run.runId]))[0];
            // The old worker brings each run to: branch 1 ended, branch 2 waiting, branch 3 not started; and continues as new.
            for (const run of runs) {
                await until(async () => {
                    const rows = await rowsOf(run);
                    const of = id => rows.find(row => row.id === id);
                    return of(run.at(0, "done"))?.state === "completed" && of(run.at(1, "hold"))?.state === "pending" ? rows : null;
                }, "the old worker to end branch 1 and start branch 2", 60_000);
                expect((await rowsOf(run)).filter(row => row.scope_id === branchScopeId(run.fan, 2)), "precondition: branch 3 queued").toEqual([]);
                run.before = await runRow(run);
                await until(async () => (await raw.client.listExecutions(run.before.controller_instance_id)).length >= 2 || null,
                    "the old controller to continue as new", 60_000);
            }
            const revisionsBefore = await raw.q(`SELECT workflow_session_id, revision, ir_sha256, ir::text AS ir FROM SCHEMA.workflow_revisions ORDER BY workflow_session_id, revision`);
            await old.stop();
            expect(await old.exited, "the old worker stopped").toMatchObject({ code: 0 });

            // This build: its migrations, then its worker takes the same orchestrations over.
            base = await joinBaseOf(env);
            workers.push(await joinRuntimeOn(base));
            for (const run of runs) expect(await base.store.completeNode(run.at(1, "hold"), elapsedResult({ seconds: 600, index: 1 }))).toMatchObject({ won: true });
            // The join of every branch: branch 3 starts after branch 2, waits, ends; the join gives the outputs in item order.
            await persisted(base, [runs[0].at(2, "hold")], "branch 3 to start on this build");
            expect(await base.store.completeNode(runs[0].at(2, "hold"), elapsedResult({ seconds: 600, index: 2 }))).toMatchObject({ won: true });
            const joined = await endOf(base, runs[0].runId);
            const first = await base.store.readNodeExecution(runs[0].at(0, "done"));
            expect(joined).toMatchObject({ status: "completed", terminalNodeId: "finished",
                terminalOutput: [first.output, { seconds: 600, index: 1 }, { seconds: 600, index: 2 }] });
            // Under failFast: branch 3's refused start is a branch error; the join blocks with every old field of its report.
            const blocked = await endOf(base, runs[1].runId);
            expect(blocked).toMatchObject({ status: "completed", terminalNodeId: "stuck" });
            const report = blocked.terminalOutput;
            expect(report).toMatchObject({ joined: false, total: 3, succeeded: 2, failFast: true });
            expect(report.branches.map(branch => [branch.index, branch.ended, branch.outcome, branch.resultKind])).toEqual([
                [0, "terminal", "succeeded", "business"], [1, "terminal", "succeeded", "business"], [2, "error", "invalid_input", "runtime_error"]]);
            // This build's report has the old fields and two more (timedOut false, needed: the parent's decision on JK-21).
            expect(Object.keys(report).sort()).toEqual(["branches", "failFast", "joined", "needed", "succeeded", "timedOut", "total"]);
            for (const run of runs) {
                // The stored IR is the old one, unchanged; the controller's same instance replayed and finished.
                expect(await runRow(run)).toEqual(run.before);
                expect((await base.client.getStatus(run.before.controller_instance_id)).status).toBe("Completed");
                // An IR 8 parallel state has no time limit: no elapse of it was ever asked.
                const elapsed = await scheduledInputs(base, run.before.controller_instance_id, R.elapse);
                expect(elapsed.flatMap(input => input.nodeExecutionIds ?? []), "no time limit asked").not.toContain(run.fan);
                // Every branch state once.
                const rows = await rowsOf(run);
                const ids = rows.map(row => row.id);
                expect(new Set(ids).size, "no state twice").toBe(ids.length);
                for (const index of [0, 1, 2]) {
                    expect(rows.filter(row => row.scope_id === branchScopeId(run.fan, index)).map(row => row.node_id).sort(), `branch ${index + 1}`)
                        .toEqual(run === runs[1] && index === 2 ? ["hold"] : ["done", "hold"]);
                }
            }
            expect(await raw.q(`SELECT workflow_session_id, revision, ir_sha256, ir::text AS ir FROM SCHEMA.workflow_revisions ORDER BY workflow_session_id, revision`))
                .toEqual(revisionsBefore);
        } finally {
            await old.stop();
            for (const worker of workers) await worker.stop();
            await raw.close();
            if (base) await base.close();
        }
    });

    compat("JK-23: the old service refuses IR 9 before writing anything; the old worker refuses an IR 9 run (never runs it as IR 8); this build runs it", { timeout: TIMEOUT }, async () => {
        await requireBaseline();
        const env = getEnv();
        const old = await forkJoinWorker(env, { dist: BASELINE });
        const raw = await rawOf(env);
        let base = null;
        const workers = [];
        try {
            await old.ready;
            // The old service: a join of the first k, and a parallel time limit, are refused before any write.
            for (const doc of [waitsDoc({ items: [{ seconds: 600 }, { seconds: 600 }], concurrency: 2, join: { first: 1 } }),
                waitsDoc({ items: [{ seconds: 600 }], timeoutSeconds: 30 })]) {
                const refused = await old.create(yamlOf(doc));
                expect(refused.refused, JSON.stringify(refused)).toBeDefined();
                expect(refused.runId ?? null).toBeNull();
                expect(await raw.q(`SELECT 1 FROM SCHEMA.sessions WHERE session_id = $1`, [refused.workflowSessionId]), "no workflow session").toEqual([]);
                expect(await raw.q(`SELECT 1 FROM SCHEMA.workflow_definitions WHERE workflow_session_id = $1`, [refused.workflowSessionId]), "no definition").toEqual([]);
            }
            // This build starts an IR 9 run while only the old worker runs: the old controller's reader refuses its IR.
            base = await joinBaseOf(env);
            const ir9 = await startJoin(base, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], join: { first: 1 }, concurrency: 2 }));
            const refused = await endOf(base, ir9.runId, 120_000);
            expect(refused.status).toBe("failed");
            expect(JSON.stringify(refused.terminalError)).toMatch(/stored IR version 9 is not supported/);
            expect((await base.store.listNodeExecutions(ir9.runId)).filter(node => node.scopeId !== "root"), "no branch ran").toEqual([]);
            await old.stop();
            // This build's worker runs IR 9.
            workers.push(await joinRuntimeOn(base));
            const control = await startJoin(base, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], join: { first: 1 }, concurrency: 2 }));
            await persisted(base, [control.at(0, "hold"), control.at(1, "hold")], "both waits on this build");
            expect(await base.store.completeNode(control.at(1, "hold"), elapsedResult({ seconds: 1 }))).toMatchObject({ won: true });
            expect(await endOf(base, control.runId)).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: [{ index: 1, output: { seconds: 1 } }] });
        } finally {
            await old.stop();
            for (const worker of workers) await worker.stop();
            await raw.close();
            if (base) await base.close();
        }
    });
});
