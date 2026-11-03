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
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId, workflowTestControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import { formattedWorkflowYaml, readWorkflowFromTool, readWorkflowV2, readWorkflowV2DefinitionRevision, readWorkflowV2StepInput, readWorkflowV2View } from "../../src/workflow/v2/tools.ts";

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

/** A published workflow child of a new parent with its admitted live run (nothing runs it): its ids. */
async function liveWorkflow(catalog, label) {
    const store = catalog.workflowStore();
    const owner = { provider: "test", subject: `${label}-${randomUUID()}` };
    const parent = randomUUID();
    await catalog.createSession(parent, { owner });
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const compiled = compileWorkflowV2(YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
        creationConfig: { workflowV2: { requestSha256: label } } })).created).toBe(true);
    await store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: YAML, compiled, actor: { kind: "system", name: `${label}-test` },
        operationId: "create", requestSha256: label, publish: true, title: `Workflow: ${label}`,
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
            testAgentMode: null },
    });
    return { parent, workflowSessionId, runId, definitionHash: compiled.yamlSha256 };
}

/** Every row of one section, newest first, by following the read's cursors from the view (`first`) with pages of `limit`. */
async function followPages(store, workflowSessionId, runId, first, section, limit, key) {
    const page = section === "interceptions" ? first.run.test.interceptions
        : section === "executions" ? first.run.nodeExecutions : first.run[section];
    const seen = [...page].reverse().map(row => row[key]);
    let next = first.run.pages[section].nextCursor;
    let pages = 1;
    while (next !== null) {
        const read = await readWorkflowV2View(store, workflowSessionId, { runId, cursor: next, limit });
        expect(read).toMatchObject({ workflowId: workflowSessionId, runId, section, order: "newest_first", limit });
        expect(read.items.length).toBeLessThanOrEqual(limit);
        seen.push(...[...read.items].reverse().map(row => row[key]));
        next = read.nextCursor;
        pages += 1;
    }
    return { seen, pages };
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
            // The graph is the stored IR, kept as canonical JSON (its pinned hash covers that text), so its states come in the IR's
            // key order, not the YAML's: what matters is which states there are and how they connect.
            expect(view.graph?.states?.map(state => state.id).sort()).toEqual(["done", "step"]);
            expect(view.graph).toMatchObject({ revision: 1, initial: "step" });
            expect(view.graph.states.find(state => state.id === "step")).toMatchObject({ type: "script", next: { ok: "done" } });
            expect(view.graph.states.find(state => state.id === "done")).toMatchObject({ type: "terminal", outcome: "succeeded" });
            expect(await mgmt.readWorkflow(workflowSessionId, { runId })).toEqual(view);
            // Reading changes nothing.
            expect(await store.readRun(runId)).toMatchObject({ status: "admitted" });
            expect(await mgmt.readWorkflow(workflowSessionId)).toEqual(view);

            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: randomUUID() }), "RUN_NOT_FOUND", 404);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: "" }), "INVALID_REQUEST", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: "  " }), "INVALID_REQUEST", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: 5 }), "INVALID_REQUEST", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { runId: "r".repeat(257) }), "INVALID_REQUEST", 400);
            // A page or an execution's value is read under the same adapter, with the read's own codes and statuses.
            await refused(() => mgmt.readWorkflow(workflowSessionId, { executionId: randomUUID() }), "EXECUTION_NOT_FOUND", 404);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { executionId: "" }), "WORKFLOW_READ_INVALID", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { limit: 0 }), "WORKFLOW_READ_INVALID", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { limit: "5" }), "WORKFLOW_READ_INVALID", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { cursor: { v: 1 } }), "WORKFLOW_CURSOR_INVALID", 400);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { cursor: "next" }), "WORKFLOW_CURSOR_INVALID", 400);
            expect(view.run.pages.executions).toEqual({ order: "newest_first", limit: 200, nextCursor: null, openComplete: true });
            // One revision of the run's variables, under the same adapter: its only revision, and one it does not have.
            expect((await mgmt.readWorkflow(workflowSessionId, { kvRevision: 1 })).kv).toEqual({ revision: 1, acceptedRevision: 1, keys: 0, bytes: 2, whole: true, entries: [] });
            await refused(() => mgmt.readWorkflow(workflowSessionId, { kvRevision: 2 }), "KV_REVISION_NOT_FOUND", 404);
            await refused(() => mgmt.readWorkflow(workflowSessionId, { kvKey: "a" }), "WORKFLOW_READ_INVALID", 400);
            await refused(() => mgmt.readWorkflow(parent), "WORKFLOW_NOT_FOUND", 404);
            await refused(() => mgmt.readWorkflow(randomUUID()), "NOT_FOUND", 404);
            await catalog.softDeleteSession(workflowSessionId);
            await refused(() => mgmt.readWorkflow(workflowSessionId), "NOT_FOUND", 404);
        } finally {
            await mgmt.stop();
            await catalog.close();
        }
    });

    // Paging's guarantee (read-pages.ts): no row on two pages of a pass, every row committed before the pass began listed
    // once, and a row committed later with an older key (its transaction read the clock before an earlier row's
    // committed) listed by a new pass, not by the pass that already passed its key; while it is open, every view lists it.
    it("pages newest first without repeats over duplicate times; a row committed later with an older key is read by a new pass and, while open, by every view", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const db = new pg.Client({ connectionString: env.store });
        await db.connect();
        try {
            const store = catalog.workflowStore();
            const owner = { provider: "test", subject: `pages-${randomUUID()}` };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner });
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            const compiled = compileWorkflowV2(YAML);
            expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
                creationConfig: { workflowV2: { requestSha256: "read-pages" } } })).created).toBe(true);
            await store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: YAML, compiled, actor: { kind: "system", name: "read-pages-test" },
                operationId: "create", requestSha256: "read-pages", publish: true, title: "Workflow: read-pages",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}",
                    testAgentMode: null },
            });
            // Nine completed executions; 2-3, 4-5, 6-7 and 8-9 share their entry times, so the id orders each pair.
            const nodes = `"${env.cmsSchema}".workflow_node_executions`;
            await db.query(`INSERT INTO ${nodes} (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome,
                    result_kind, output, winner, entered_at, completed_at)
                SELECT $1::text || '-' || g, $1::text, 'root', 'step', g, 'script', '{}', 'x', 'completed', 'ok', 'business', format('{"n":%s}', g), 'effect',
                       t, t
                  FROM generate_series(1, 9) g, LATERAL (SELECT timestamptz '2026-01-01T00:00:00Z' + (g / 2) * interval '1 second' AS t) ts`, [runId]);
            const newestFirst = [9, 8, 7, 6, 5, 4, 3, 2, 1].map(g => `${runId}-${g}`);
            const pass = async (until = null) => {
                const first = await readWorkflowV2View(store, workflowSessionId, { limit: 2 });
                const seen = [...first.run.nodeExecutions].reverse().map(row => row.nodeExecutionId);
                let next = first.run.pages.executions.nextCursor;
                for (let page = 2; next !== null; page += 1) {
                    if (until) await until(page);
                    const read = await readWorkflowV2View(store, workflowSessionId, { runId, cursor: next, limit: 2 });
                    expect(read).toMatchObject({ workflowId: workflowSessionId, runId, section: "executions", order: "newest_first", limit: 2 });
                    seen.push(...[...read.items].reverse().map(row => row.nodeExecutionId));
                    next = read.nextCursor;
                }
                return { first, seen };
            };
            const before = await pass();
            expect(before.seen).toEqual(newestFirst);
            expect(new Set(before.seen).size).toBe(9);

            // A row committed after the pass read its second page, with a key the pass already passed (between pages 1 and 2).
            const late = `${runId}-late`;
            const during = await pass(async page => {
                if (page !== 3) return;
                await db.query(`INSERT INTO ${nodes} (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, entered_at)
                    VALUES ($1, $2, 'root', 'step', 100, 'script', '{}', 'x', 'pending', timestamptz '2026-01-01T00:00:03.5Z')`, [late, runId]);
            });
            expect(during.seen).toEqual(newestFirst);
            // A new pass lists it once, in its place; while it is open every view lists it, beside a page that does not hold it.
            const after = await pass();
            expect(after.seen).toEqual([newestFirst[0], newestFirst[1], late, ...newestFirst.slice(2)]);
            expect(after.first.run.nodeExecutions.map(row => row.nodeExecutionId)).toEqual([newestFirst[1], newestFirst[0]]);
            expect(after.first.run.openExecutions.map(row => row.nodeExecutionId)).toEqual([late]);
            expect(after.first.run.pages.executions).toMatchObject({ order: "newest_first", limit: 2, openComplete: true });

            // One execution's whole output, of exactly the run read; another run's or an unknown execution is not found.
            expect(await readWorkflowV2View(store, workflowSessionId, { executionId: `${runId}-1` })).toEqual({
                workflowId: workflowSessionId, runId,
                execution: expect.objectContaining({ nodeExecutionId: `${runId}-1`, state: "completed", outcome: "ok",
                    result: { kind: "output", bytes: 7, whole: true, value: { n: 1 } } }),
            });
            expect((await readWorkflowV2View(store, workflowSessionId, { executionId: late })).execution.result).toBeNull();
            for (const executionId of [randomUUID(), `${runId}-10`]) {
                await expect(readWorkflowV2View(store, workflowSessionId, { executionId })).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
            }
            // A cursor of this pass refused for another run named, and once its fields are changed.
            const cursor = before.first.run.pages.executions.nextCursor;
            await expect(readWorkflowV2View(store, workflowSessionId, { runId: randomUUID(), cursor })).rejects.toMatchObject({ code: "WORKFLOW_CURSOR_INVALID" });
            await expect(readWorkflowV2View(store, workflowSessionId, { cursor: { ...cursor, v: 2 } })).rejects.toMatchObject({ code: "WORKFLOW_CURSOR_INVALID" });
            await expect(readWorkflowV2View(store, workflowSessionId, { cursor: { ...cursor, after: { ...cursor.after, enteredAt: "2026-01-01" } } }))
                .rejects.toMatchObject({ code: "WORKFLOW_CURSOR_INVALID" });
            await expect(readWorkflowV2View(store, workflowSessionId, { cursor, executionId: `${runId}-1` })).rejects.toMatchObject({ code: "WORKFLOW_READ_INVALID" });
        } finally {
            await db.end();
            await catalog.close();
        }
    });

    // A long run (design 04 read_workflow "Bounded history pagination"; R01; mock M10): more rows than a page in every
    // section, an old branch still running under 260 later executions, whole values within and over the 256 KiB cap,
    // and another workflow's rows, which no read of this one shows.
    it("reads a long run's newest pages with its open rows apart, pages every section to its end, reads whole values, and shows nothing of another workflow", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const db = new pg.Client({ connectionString: env.store });
        await db.connect();
        const range = (from, to, of) => Array.from({ length: to - from + 1 }, (_, i) => of(from + i));
        const ids = (rows, key) => rows.map(row => row[key]);
        try {
            const store = catalog.workflowStore();
            const a = await liveWorkflow(catalog, "read-long");
            const b = await liveWorkflow(catalog, "read-private");
            const s = `"${env.cmsSchema}"`;
            const exec = g => `${a.runId}-${g}`;
            // 260 completed executions, one a second, and a parallel branch's state entered an hour before them, still pending.
            await db.query(`INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input,
                    input_sha256, state, outcome, result_kind, output, winner, entered_at, completed_at)
                SELECT $1::text || '-' || g, $1::text, 'root', 'step', g, 'script', '{}', 'x', 'completed', 'ok', 'business', format('{"n":%s}', g),
                       'effect', timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second', timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second'
                  FROM generate_series(1, 260) g`, [a.runId]);
            await db.query(`INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input,
                    input_sha256, state, entered_at)
                VALUES ($1::text || '-branch', $1::text, 'nx-0a1b#0', 'step', 1, 'script', '{}', 'x', 'pending', timestamptz '2025-12-31T23:00:00Z')`, [a.runId]);
            // Whole values: 200,002 bytes (within the cap), 270,002 bytes (over it: the runtime writes none, a raw row stands for one)
            // and a runtime error.
            await db.query(`UPDATE ${s}.workflow_node_executions SET output = '"' || repeat('x', 200000) || '"' WHERE node_execution_id = $1`, [exec(1)]);
            await db.query(`UPDATE ${s}.workflow_node_executions SET output = '"' || repeat('x', 270000) || '"' WHERE node_execution_id = $1`, [exec(2)]);
            await db.query(`UPDATE ${s}.workflow_node_executions SET outcome = 'timed_out', result_kind = 'runtime_error', output = NULL,
                    error = '{"code":"timed_out","message":"late"}' WHERE node_execution_id = $1`, [exec(3)]);
            // The cap's edge (tester r2 R4): exactly 262,144 bytes is whole; one byte more is not (multi-byte text counts in bytes).
            await db.query(`UPDATE ${s}.workflow_node_executions SET output = '"' || repeat('x', 262142) || '"' WHERE node_execution_id = $1`, [exec(4)]);
            await db.query(`UPDATE ${s}.workflow_node_executions SET output = '"' || repeat('é', 131071) || '"' WHERE node_execution_id = $1`, [exec(5)]);
            // 60 typed inputs: the three oldest unclaimed and unexpired, the others taken by a receive.
            await db.query(`INSERT INTO ${s}.workflow_inbox (message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256,
                    contract, correlation, payload, accepted_at, expires_at, consumed_by, consumed_at)
                SELECT $1::text || '-m' || g, $2::text, $1::text, $3::text, 'in-' || g, 'x', 'Build@1', '{}', format('{"g":%s}', g),
                       CASE WHEN g <= 3 THEN now() - interval '1 hour' ELSE timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second' END,
                       CASE WHEN g <= 3 THEN now() + interval '1 day' ELSE timestamptz '2026-01-02T00:00:00Z' + g * interval '1 second' END,
                       CASE WHEN g <= 3 THEN NULL ELSE $1::text || '-' || g END,
                       CASE WHEN g <= 3 THEN NULL ELSE timestamptz '2026-01-01T00:00:01Z' + g * interval '1 second' END
                  FROM generate_series(1, 60) g ORDER BY g`, [a.runId, a.workflowSessionId, a.parent]);
            // 60 sent messages: the two oldest still pending, the others failed.
            await db.query(`INSERT INTO ${s}.workflow_outbox (exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id,
                    recipient_kind, contract, payload, payload_sha256, correlation, state, created_at, decided_at, error)
                SELECT $1::text || '-' || g, $1::text || '-' || g, $2::text, $1::text, 'send', $3::text, 'agent', 'Note@1', '{}', 'x', '{}',
                       CASE WHEN g <= 2 THEN 'pending' ELSE 'failed' END, timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second',
                       CASE WHEN g <= 2 THEN NULL ELSE timestamptz '2026-01-01T00:00:01Z' + g * interval '1 second' END,
                       CASE WHEN g <= 2 THEN NULL ELSE '{"code":"delivery_failed","message":"gone"}' END
                  FROM generate_series(1, 60) g`, [a.runId, a.workflowSessionId, a.parent]);
            // The other workflow has two executions of its own.
            await db.query(`INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input,
                    input_sha256, state, outcome, result_kind, output, winner, entered_at, completed_at)
                SELECT $1::text || '-' || g, $1::text, 'root', 'step', g, 'script', '{}', 'x', 'completed', 'ok', 'business', '{"secret":true}', 'effect',
                       timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second', timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second'
                  FROM generate_series(1, 2) g`, [b.runId]);

            // The view: each section's newest page, oldest first, and the open rows the page does not hold, however old.
            const view = await readWorkflowV2View(store, a.workflowSessionId);
            expect(ids(view.run.nodeExecutions, "nodeExecutionId")).toEqual(range(61, 260, exec));
            expect(view.run.openExecutions).toEqual([expect.objectContaining({ nodeExecutionId: `${a.runId}-branch`, state: "pending",
                scopeId: "nx-0a1b#0", branch: { parallelNodeExecutionId: "nx-0a1b", index: 0 } })]);
            expect(ids(view.run.inbox, "messageId")).toEqual(range(11, 60, g => `${a.runId}-m${g}`));
            expect(ids(view.run.openInbox, "messageId")).toEqual(range(1, 3, g => `${a.runId}-m${g}`));
            expect(ids(view.run.outbox, "exchangeId")).toEqual(range(11, 60, exec));
            expect(ids(view.run.openOutbox, "exchangeId")).toEqual(range(1, 2, exec));
            for (const [section, limit] of [["executions", 200], ["inbox", 50], ["outbox", 50]]) {
                expect(view.run.pages[section]).toEqual({ order: "newest_first", limit, nextCursor: expect.objectContaining({ v: 1, section }), openComplete: true });
            }
            expect(view.run.pages).not.toHaveProperty("interceptions");
            expect(view.run).not.toHaveProperty("test");
            // Following each section's cursors lists every row once, newest first.
            const executions = await followPages(store, a.workflowSessionId, a.runId, view, "executions", 200, "nodeExecutionId");
            expect(executions).toEqual({ seen: [...range(1, 260, exec).reverse(), `${a.runId}-branch`], pages: 2 });
            const inbox = await followPages(store, a.workflowSessionId, a.runId, view, "inbox", 50, "messageId");
            expect(inbox).toEqual({ seen: range(1, 60, g => `${a.runId}-m${g}`).reverse(), pages: 2 });
            const outbox = await followPages(store, a.workflowSessionId, a.runId, view, "outbox", 50, "exchangeId");
            expect(outbox).toEqual({ seen: range(1, 60, exec).reverse(), pages: 2 });
            // A smaller limit applies to every section of the view.
            const small = await readWorkflowV2View(store, a.workflowSessionId, { limit: 7 });
            expect([small.run.nodeExecutions.length, small.run.inbox.length, small.run.outbox.length]).toEqual([7, 7, 7]);
            expect(small.run.pages.executions.limit).toBe(7);

            // A page shows its rows as they are when it is read: the branch's state ended since the view, so the page says so,
            // and a new view no longer lists it as open.
            await db.query(`UPDATE ${s}.workflow_node_executions SET state = 'completed', outcome = 'ok', result_kind = 'business', output = 'null',
                    winner = 'effect', completed_at = now() WHERE node_execution_id = $1`, [`${a.runId}-branch`]);
            const tail = await readWorkflowV2View(store, a.workflowSessionId, { cursor: view.run.pages.executions.nextCursor });
            expect(tail.items[0]).toMatchObject({ nodeExecutionId: `${a.runId}-branch`, state: "completed", outcome: "ok" });
            expect((await readWorkflowV2View(store, a.workflowSessionId)).run.openExecutions).toEqual([]);

            // Whole values of the exact execution read, within the cap; one over it (none is written) is its bounded preview.
            const value = async executionId => (await readWorkflowV2View(store, a.workflowSessionId, { executionId })).execution.result;
            expect(await value(exec(1))).toEqual({ kind: "output", bytes: 200_002, whole: true, value: "x".repeat(200_000) });
            expect(await value(exec(2))).toEqual({ kind: "output", bytes: 270_002, whole: false, limitBytes: 262_144, preview: `"${"x".repeat(3_999)}…` });
            const error = { code: "timed_out", message: "late" };
            expect(await value(exec(3))).toEqual({ kind: "error", bytes: Buffer.byteLength(JSON.stringify(error)), whole: true, value: error });
            expect(await value(exec(4))).toEqual({ kind: "output", bytes: 262_144, whole: true, value: "x".repeat(262_142) });
            expect(await value(exec(5))).toMatchObject({ kind: "output", bytes: 262_144, whole: true });
            await db.query(`UPDATE ${s}.workflow_node_executions SET output = '"' || repeat('é', 131071) || 'x"' WHERE node_execution_id = $1`, [exec(5)]);
            expect(await value(exec(5))).toMatchObject({ kind: "output", bytes: 262_145, whole: false, limitBytes: 262_144 });
            // Page edges (tester r2 R2): sixty inputs in pages of 30 are exactly two pages, the second without a next cursor.
            const thirty = await readWorkflowV2View(store, a.workflowSessionId, { limit: 30 });
            expect(await followPages(store, a.workflowSessionId, a.runId, thirty, "inbox", 30, "messageId"))
                .toEqual({ seen: range(1, 60, g => `${a.runId}-m${g}`).reverse(), pages: 2 });
            // The view's rows keep their previews.
            expect(tail.items.find(row => row.nodeExecutionId === exec(1)).outputPreview).toHaveLength(501);

            // Nothing of the other workflow: its executions, its run and its cursors are refused by this workflow's reads.
            await expect(readWorkflowV2View(store, a.workflowSessionId, { executionId: `${b.runId}-1` })).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
            await expect(readWorkflowV2View(store, a.workflowSessionId, { runId: b.runId, executionId: `${b.runId}-1` })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
            const other = await readWorkflowV2View(store, b.workflowSessionId, { limit: 1 });
            const otherCursor = other.run.pages.executions.nextCursor;
            expect(otherCursor).toMatchObject({ workflowId: b.workflowSessionId, runId: b.runId });
            await expect(readWorkflowV2View(store, a.workflowSessionId, { cursor: otherCursor })).rejects.toMatchObject({ code: "WORKFLOW_CURSOR_INVALID" });
            await expect(readWorkflowV2View(store, a.workflowSessionId, { cursor: { ...otherCursor, workflowId: a.workflowSessionId } }))
                .rejects.toMatchObject({ code: "WORKFLOW_CURSOR_INVALID" });
            // The agent tool: only the workflow's parent reads it; the parent reads its own executions only.
            const host = { catalog, store };
            const tool = async (callerSessionId, args) => JSON.parse(await readWorkflowFromTool({ workflow_id: a.workflowSessionId, ...args }, { callerSessionId, host }));
            expect(await tool(b.parent, { execution_id: exec(3) })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
            expect(await tool(a.parent, { execution_id: `${b.runId}-1` })).toMatchObject({ ok: false, error: { code: "EXECUTION_NOT_FOUND" } });
            expect(await tool(a.parent, { cursor: otherCursor })).toMatchObject({ ok: false, error: { code: "WORKFLOW_CURSOR_INVALID" } });
            expect(await tool(a.parent, { execution_id: exec(3) })).toEqual({ ok: true, workflowId: a.workflowSessionId, runId: a.runId,
                execution: expect.objectContaining({ nodeExecutionId: exec(3), outcome: "timed_out", result: expect.objectContaining({ kind: "error", value: error }) }) });
            expect(await tool(a.parent, { cursor: view.run.pages.inbox.nextCursor, limit: 5 })).toMatchObject({ ok: true, section: "inbox", limit: 5,
                items: range(6, 10, g => expect.objectContaining({ messageId: `${a.runId}-m${g}` })) });

            // A test run beside the live run, with 210 intercepted effects: the five oldest still wait for an answer.
            const testRun = randomUUID();
            await store.startTest({
                workflowSessionId: a.workflowSessionId, expectedRevision: 1, definitionHash: a.definitionHash, operationId: "test-1", requestSha256: "read-long",
                start: { runId: testRun, mode: "test", controllerInstanceId: workflowTestControllerInstanceId(testRun), inputsText: "{}", kvText: "{}",
                    testAgentMode: "mocked", controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
            });
            await db.query(`INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input,
                    input_sha256, state, entered_at)
                VALUES ($1::text || '-1', $1::text, 'root', 'step', 1, 'script', '{}', 'x', 'pending', timestamptz '2026-01-01T00:00:00Z')`, [testRun]);
            await db.query(`INSERT INTO ${s}.workflow_test_interceptions (interception_id, run_id, node_execution_id, operation, tool, arguments,
                    arguments_sha256, state, response_kind, response, response_sha256, disposition, virtual_at, created_at, responded_at)
                SELECT $1::text || '-i' || g, $1::text, $1::text || '-1', 'tool.call', 'read_build', format('{"call":%s}', g), 'x',
                       CASE WHEN g <= 5 THEN 'awaiting_parent' ELSE 'responded' END,
                       CASE WHEN g <= 5 THEN NULL ELSE 'success' END, CASE WHEN g <= 5 THEN NULL ELSE 'null' END,
                       CASE WHEN g <= 5 THEN NULL ELSE 'x' END, CASE WHEN g <= 5 THEN NULL ELSE 'fixture' END,
                       timestamptz '9000-01-01T00:00:00Z', timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second',
                       CASE WHEN g <= 5 THEN NULL ELSE timestamptz '2026-01-01T00:00:01Z' + g * interval '1 second' END
                  FROM generate_series(1, 210) g ORDER BY g`, [testRun]);
            const intercepted = g => `${testRun}-i${g}`;
            const testView = await readWorkflowV2View(store, a.workflowSessionId, { runId: testRun });
            expect(ids(testView.run.test.interceptions, "interceptionId")).toEqual(range(11, 210, intercepted));
            expect(ids(testView.run.test.openInterceptions, "interceptionId")).toEqual(range(1, 5, intercepted));
            expect(testView.run.test.openInterceptions.every(item => item.stateId === "step" && item.state === "awaiting_parent")).toBe(true);
            expect(testView.run.test.coverage).toMatchObject({ complete: true, entered: ["step"], unanswered: range(1, 5, intercepted) });
            expect(testView.run.pages.interceptions).toEqual({ order: "newest_first", limit: 200,
                nextCursor: expect.objectContaining({ section: "interceptions", runId: testRun }), openComplete: true });
            const effects = await followPages(store, a.workflowSessionId, testRun, testView, "interceptions", 200, "interceptionId");
            expect(effects).toEqual({ seen: range(1, 210, intercepted).reverse(), pages: 2 });
            // An interceptions cursor is a test run's, of the run named; an execution of the live run is not one of the test run's.
            const effectsCursor = testView.run.pages.interceptions.nextCursor;
            await expect(readWorkflowV2View(store, a.workflowSessionId, { runId: a.runId, cursor: effectsCursor })).rejects.toMatchObject({ code: "WORKFLOW_CURSOR_INVALID" });
            await expect(readWorkflowV2View(store, a.workflowSessionId, { cursor: { ...effectsCursor, runId: a.runId } })).rejects.toMatchObject({ code: "WORKFLOW_CURSOR_INVALID" });
            await expect(readWorkflowV2View(store, a.workflowSessionId, { runId: testRun, executionId: exec(1) })).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
        } finally {
            await db.end();
            await catalog.close();
        }
    });

    // Mock M15 "Inspect update" and "Compare snapshots" (R04, R05): every revision of a run's variables is kept and read as it
    // was, each value with its size and sha256 (two snapshots compare exactly), whole up to 256 KiB in all, and one variable
    // whole; a revision the run does not have is refused.
    it("reads each kept revision of a run's variables, whole or as previews over 256 KiB, one variable whole, and refuses a revision it does not have", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const db = new pg.Client({ connectionString: env.store });
        await db.connect();
        const sha = text => createHash("sha256").update(text, "utf8").digest("hex");
        try {
            const store = catalog.workflowStore();
            const a = await liveWorkflow(catalog, "read-kv");
            const other = await liveWorkflow(catalog, "read-kv-other");
            const s = `"${env.cmsSchema}"`;
            const big = `"${"x".repeat(150_000)}"`;
            await db.query(`INSERT INTO ${s}.workflow_kv_revisions (run_id, revision, kv) VALUES ($1, 2, '{"a":1,"b":"x"}'), ($1, 3, '{"a":2,"c":true}'),
                ($1, 4, '{"p":' || $2 || ',"q":' || $2 || '}')`, [a.runId, big]);
            await db.query(`UPDATE ${s}.workflow_runs SET kv_revision = 4, kv = '{"p":' || $2 || ',"q":' || $2 || '}' WHERE run_id = $1`, [a.runId, big]);
            const read = options => readWorkflowV2View(store, a.workflowSessionId, options);

            expect(await read({ kvRevision: 2 })).toEqual({ workflowId: a.workflowSessionId, runId: a.runId, kv: { revision: 2, acceptedRevision: 4, keys: 2,
                bytes: Buffer.byteLength('{"a":1,"b":"x"}'), whole: true, entries: [
                    { key: "a", bytes: 1, sha256: sha("1"), value: 1 }, { key: "b", bytes: 3, sha256: sha('"x"'), value: "x" }] } });
            // Revision 3 changed a, removed b and added c: the sha256 of each value tells what changed.
            const three = (await read({ kvRevision: 3 })).kv;
            expect(three.entries).toEqual([{ key: "a", bytes: 1, sha256: sha("2"), value: 2 }, { key: "c", bytes: 4, sha256: sha("true"), value: true }]);
            expect((await read({ kvRevision: 3, kvKey: "a" })).kv).toEqual({ revision: 3, acceptedRevision: 4, key: "a", present: true, bytes: 1, value: 2 });
            expect((await read({ kvRevision: 3, kvKey: "b" })).kv).toEqual({ revision: 3, acceptedRevision: 4, key: "b", present: false });
            // Over 256 KiB in all: previews of 200 characters, each value's size and sha256 still exact; one variable read whole.
            const four = (await read({ kvRevision: 4 })).kv;
            expect(four).toMatchObject({ revision: 4, acceptedRevision: 4, keys: 2, whole: false });
            for (const entry of four.entries) {
                expect(entry).toEqual({ key: entry.key, bytes: 150_002, sha256: sha(big), preview: `${big.slice(0, 200)}…` });
            }
            expect((await read({ kvRevision: 4, kvKey: "p" })).kv).toMatchObject({ present: true, bytes: 150_002, value: "x".repeat(150_000) });
            // Refusals: a revision the run does not have, an invalid revision or key, a key without a revision, mixed reads,
            // and another workflow's run.
            await expect(read({ kvRevision: 5 })).rejects.toMatchObject({ code: "KV_REVISION_NOT_FOUND" });
            for (const options of [{ kvRevision: 0 }, { kvRevision: "2" }, { kvRevision: 1.5 }, { kvRevision: 2, kvKey: "" }, { kvKey: "a" },
                { kvRevision: 2, cursor: { v: 1 } }, { kvRevision: 2, executionId: "nx" }, { kvRevision: 2, limit: 5 }, { kvRevision: 2, includeYaml: true }]) {
                await expect(read(options)).rejects.toMatchObject({ code: "WORKFLOW_READ_INVALID" });
            }
            await expect(read({ runId: other.runId, kvRevision: 1 })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
            // The agent tool reads the same, for the workflow's parent only.
            const host = { catalog, store };
            const tool = async (callerSessionId, args) => JSON.parse(await readWorkflowFromTool({ workflow_id: a.workflowSessionId, ...args }, { callerSessionId, host }));
            expect(await tool(a.parent, { kv_revision: 3, kv_key: "c" })).toEqual({ ok: true, workflowId: a.workflowSessionId, runId: a.runId,
                kv: { revision: 3, acceptedRevision: 4, key: "c", present: true, bytes: 4, value: true } });
            expect(await tool(other.parent, { kv_revision: 3 })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        } finally {
            await db.end();
            await catalog.close();
        }
    });

    // Owner decision q4: comparing two versions of a draft reads each revision's YAML, as saved and properly formatted (a
    // draft written as JSON reads as block YAML, comments kept), with its hash and validity; a revision it does not have is
    // DEFINITION_REVISION_NOT_FOUND, and it is a read of its own.
    it("reads one definition revision's YAML as saved and formatted, for comparing versions; refuses a revision it does not have", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const store = catalog.workflowStore();
            const owner = { provider: "test", subject: `revisions-${randomUUID()}` };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner });
            const workflowSessionId = randomUUID();
            const asJson = JSON.stringify({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name: "read-api", version: "1.0.0" },
                initial: "pause", states: { pause: { type: "wait", seconds: 1, transition: { next: { elapsed: "done" } } },
                    done: { type: "terminal", outcome: "succeeded" } } });
            const first = compileWorkflowV2(asJson);
            expect(first.valid, JSON.stringify(first.diagnostics)).toBe(true);
            expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
                creationConfig: { workflowV2: { requestSha256: "revisions" } } })).created).toBe(true);
            const actor = { kind: "system", name: "revisions-test" };
            await store.createDefinition({ workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: asJson, compiled: first, actor,
                operationId: "create", requestSha256: "revisions", publish: false, start: null, title: "Workflow: read-api" });
            const second = compileWorkflowV2(YAML);
            await store.replaceDraft({ workflowSessionId, expectedRevision: 1, yaml: YAML, compiled: second, declaredSemver: "1.0.0", actor,
                operationId: "replace", requestSha256: "replace", title: "Workflow: read-api" });
            // Read through the one dispatcher both adapters use (readWorkflowV2), with the API's option names.
            const read = (value, others = {}) => readWorkflowV2({ store }, workflowSessionId, { ...others, definitionRevision: value }, "api");

            const one = (await read(1)).definitionRevision;
            expect(one).toMatchObject({ revision: 1, definitionHash: first.yamlSha256, valid: true, current: false, published: false, yaml: asJson });
            expect(one.formatted).toBe([
                "apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", "metadata:", "  name: read-api", "  version: 1.0.0", "initial: pause", "states:",
                "  pause:", "    type: wait", "    seconds: 1", "    transition:", "      next:", "        elapsed: done",
                "  done:", "    type: terminal", "    outcome: succeeded", "",
            ].join("\n"));
            const two = (await read(2)).definitionRevision;
            expect(two).toMatchObject({ revision: 2, definitionHash: second.yamlSha256, current: true, published: false, yaml: YAML });
            expect(two.formatted).toContain("metadata:\n  name: read-api\n");
            expect(two.formatted).toContain("source: |\n");
            const list = formattedWorkflowYaml("a: [1, \"two\", \"3\"] # the list\n");
            expect(list).toMatch(/^a:\n  - 1\n  - two\n  - "3"/);
            expect(list).toContain("# the list");
            expect(formattedWorkflowYaml("a: [1, 2\n")).toBeNull();
            // Refusals: a revision the workflow does not have, an invalid one, and other read arguments with it.
            await expect(read(3)).rejects.toMatchObject({ code: "DEFINITION_REVISION_NOT_FOUND" });
            await expect(readWorkflowV2DefinitionRevision(store, randomUUID(), 1)).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
            for (const value of [0, -1, 1.5, "1"]) await expect(read(value)).rejects.toMatchObject({ code: "WORKFLOW_READ_INVALID" });
            await expect(read(1, { limit: 5 })).rejects.toMatchObject({ code: "WORKFLOW_READ_INVALID", message: expect.stringMatching(/leave out limit\.$/) });
            // Only an absent or null option is absent: a limit of false is given, and refused like any other.
            await expect(read(1, { limit: false, kvKey: null })).rejects.toMatchObject({ code: "WORKFLOW_READ_INVALID", message: expect.stringMatching(/leave out limit\.$/) });
            // The agent tool reads it for the workflow's parent; its refusals name its own arguments, and include_yaml false is its default.
            const tool = async args => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowSessionId, ...args }, { callerSessionId: parent, host: { catalog, store } }));
            expect(await tool({ definition_revision: 1 })).toMatchObject({ ok: true, workflowId: workflowSessionId, definitionRevision: { revision: 1, yaml: asJson } });
            expect(await tool({ definition_revision: 1, include_yaml: false })).toMatchObject({ ok: true, definitionRevision: { revision: 1 } });
            expect(await tool({ definition_revision: 1, kv_key: "x", execution_id: "e" })).toMatchObject({ ok: false,
                error: { code: "WORKFLOW_READ_INVALID", message: expect.stringMatching(/leave out execution_id, kv_key\.$/) } });
            expect(await tool({ definition_revision: 9 })).toMatchObject({ ok: false, error: { code: "DEFINITION_REVISION_NOT_FOUND" } });
        } finally {
            await catalog.close();
        }
    });

    // Owner decision q6: an agent step's input editor reads its fields (the inputSchema's, then any others its mapping
    // writes), where each takes its value from, and the run inputs; with a new mapping it proposes the draft's YAML with
    // only that step's input lines changed, and what compiling it says. Reading changes nothing.
    it("reads an agent step's inputs and proposes the draft's YAML with only that step's input mapping changed", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const store = catalog.workflowStore();
            const owner = { provider: "test", subject: `step-input-${randomUUID()}` };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner });
            const workflowSessionId = randomUUID();
            const AGENTS = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true };
            const yaml = [
                "apiVersion: pilotswarm.dev/v2-draft",
                "kind: Workflow",
                "metadata: { name: step-input, version: \"1.0.0\" }",
                "inputs:",
                "  schema:",
                "    type: object",
                "    properties:",
                "      pr: { type: string }",
                "      repo: { type: string }",
                "initial: review",
                "states:",
                "  review:",
                "    type: agent",
                "    invoke:",
                "      prompt: Review the change.",
                "    # what the reviewer gets",
                "    input:",
                "      pr: ${inputs.pr}",
                "      notes: ${input.notes ?? \"none\"}",
                "    inputSchema:",
                "      type: object",
                "      required: [pr, depth]",
                "      properties:",
                "        pr: { type: string, description: The pull request }",
                "        depth: { type: integer }",
                "    outcomes: [done]",
                "    transition:",
                "      next: { done: end }",
                "  summarize:",
                "    type: agent",
                "    invoke:",
                "      prompt: Summarize.",
                "    outcomes: [done]",
                "    transition:",
                "      next: { done: end }",
                "  quick: { type: agent, invoke: { prompt: Check it. }, outcomes: [done], transition: { next: { done: end } } }",
                "  end: { type: terminal, outcome: succeeded }",
                "",
            ].join("\n");
            const compiled = compileWorkflowV2(yaml, AGENTS);
            expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner,
                creationConfig: { workflowV2: { requestSha256: "step-input" } } })).created).toBe(true);
            const actor = { kind: "system", name: "step-input-test" };
            await store.createDefinition({ workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor,
                operationId: "create", requestSha256: "step-input", publish: false, start: null, title: "Workflow: step-input" });
            const host = { store, requests: true };
            const read = (value, others = {}) => readWorkflowV2(host, workflowSessionId, { ...others, stepInput: value }, "api");

            const { stepInput } = await read({ state: "review" });
            expect(stepInput).toMatchObject({ state: "review", revision: 1, definitionHash: compiled.yamlSha256, schemaDeclared: true,
                runInputs: ["pr", "repo"], inputShape: "fields", inputText: null });
            expect(stepInput.proposed).toBeUndefined();
            expect(stepInput.fields).toEqual([
                { name: "pr", declared: true, required: true, type: "string", description: "The pull request", current: { source: "run_input", name: "pr" } },
                { name: "depth", declared: true, required: true, type: "integer", description: null, current: null },
                { name: "notes", declared: false, required: false, type: null, description: null, current: { source: "keep", text: "${input.notes ?? \"none\"}" } },
            ]);

            // A new mapping: only the input lines of 'review' change; its comment, the other steps and every other line stay.
            const proposal = (await read({ state: "review", input: {
                pr: { source: "run_input", name: "repo" }, depth: { source: "fixed", value: 2 }, notes: { source: "keep" },
                summary: { source: "previous_step", path: "review.summary" }, label: { source: "variable", name: "release label" },
            } })).stepInput.proposed;
            const expected = yaml.replace("    input:\n      pr: ${inputs.pr}\n      notes: ${input.notes ?? \"none\"}\n", [
                "    input:", "      pr: ${inputs.repo}", "      depth: 2", "      notes: \"${input.notes ?? \\\"none\\\"}\"",
                "      summary: ${input.review.summary}", "      label: \"${kv[\\\"release label\\\"]}\"", "",
            ].join("\n"));
            expect(proposal.yaml).toBe(expected);
            expect(proposal.changed).toBe(true);
            const again = compileWorkflowV2(expected, AGENTS);
            expect(proposal.valid).toBe(again.valid);
            // A step with no input mapping gains one after its last field; an empty mapping is written as {}.
            const added = (await read({ state: "summarize", input: { text: { source: "previous_step", path: "" } } })).stepInput.proposed.yaml;
            expect(added).toBe(yaml.replace("      next: { done: end }\n  quick:", "      next: { done: end }\n    input:\n      text: ${input}\n  quick:"));
            const emptied = (await read({ state: "review", input: {} })).stepInput.proposed.yaml;
            expect(emptied).toContain("    # what the reviewer gets\n    input: {}\n    inputSchema:\n");
            // Nothing was written: the draft is still revision 1 with its own text.
            expect((await store.readDefinition(workflowSessionId)).currentRevision).toBe(1);
            expect((await store.readRevision(workflowSessionId, 1)).yaml).toBe(yaml);

            // Refusals: a step that is not an agent step, a flow-style step, an unknown step, a fixed value with an expression,
            // keep for a field that has no value, an unknown source, and other read arguments with it.
            for (const [value, pattern] of [
                [{ state: "end" }, /terminal step; only an agent step/],
                [{ state: "quick", input: {} }, /not written as a block mapping/],
                [{ state: "missing" }, /no step 'missing'/],
                [{ state: "review", input: { pr: { source: "fixed", value: "${inputs.pr}" } } }, /cannot contain/],
                [{ state: "review", input: { depth: { source: "keep" } } }, /no value written for 'depth' to keep/],
                [{ state: "review", input: { pr: { source: "guess" } } }, /source: run_input \| previous_step/],
                [{ state: "review", input: { pr: { source: "run_input" } } }, /must name a run input/],
                ["review", /must be \{ state, input\? \}/],
            ]) {
                await expect(read(value)).rejects.toMatchObject({ code: "WORKFLOW_READ_INVALID", message: expect.stringMatching(pattern) });
            }
            await expect(read({ state: "review" }, { limit: 5 })).rejects.toMatchObject({ code: "WORKFLOW_READ_INVALID", message: expect.stringMatching(/leave out limit\.$/) });
            await expect(readWorkflowV2StepInput(host, randomUUID(), { state: "review" })).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
            // The agent tool reads it for the workflow's parent.
            const tool = async args => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowSessionId, ...args }, { callerSessionId: parent, host: { catalog, store } }));
            expect(await tool({ step_input: { state: "review" } })).toMatchObject({ ok: true, workflowId: workflowSessionId, stepInput: { state: "review", runInputs: ["pr", "repo"] } });
            expect(await tool({ step_input: { state: "end" } })).toMatchObject({ ok: false, error: { code: "WORKFLOW_READ_INVALID" } });
        } finally {
            await catalog.close();
        }
    });
});
